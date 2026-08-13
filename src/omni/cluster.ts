/**
 * Cluster lifecycle: resource-graph construction for creation, and the
 * teardown/poll flow for destruction. Unlike ConfigPatch/MachineClass (a
 * single resource, edited via ResourceDetail<TSpec>), a Cluster is a *root*
 * of a small graph of resources (Cluster, MachineSet(s), MachineSetNode(s),
 * optionally ConfigPatches) that all have to be created in the right order,
 * and torn down as a unit.
 *
 * Field shapes and creation order below are drawn from two sources:
 *  - client/pkg/template/order.go and frontend/src/{methods/cluster.ts,
 *    states/cluster-management.ts} in a full clone of siderolabs/omni
 *    (commit dc6fa2246, 2026-08-10) -- the authoritative reference for
 *    *which* resources exist and how they relate (labels, machine set roles,
 *    machine_allocation vs explicit MachineSetNodes).
 *  - Direct, VERIFIED (2026-08-13) signed ResourceService.Create/Get calls
 *    against the disposable instance, replicating this plugin's own
 *    auth.ts/client.ts signing scheme -- because the omni repo's own
 *    reference sources turned out to disagree with each other on wire
 *    encoding: `omnictl get -o json` and the Go test fixtures under
 *    client/pkg/template/testdata/ (e.g. "kubernetesversion",
 *    "compatiblekubernetesversions", all-lowercase-no-underscore) use COSI's
 *    *generic* reflection-based JSON/YAML codec, which is NOT what
 *    grpc-gateway's protojson translation actually puts on the wire for the
 *    HTTP API this plugin talks to (see client.ts's module doc). A direct
 *    signed call was the only reliable way to confirm the real field names;
 *    every field name below reflects that direct call's response, not the Go
 *    fixtures. Confirmed: snake_case proto field names are preserved
 *    verbatim (protojson's "original names" mode) -- talos_version,
 *    kubernetes_version, compatible_kubernetes_versions, match_labels,
 *    machine_allocation, machine_count, allocation_type, update_strategy --
 *    matching MachineClass's already-verified match_labels (see
 *    MachineClassesList.tsx) and contradicting nothing observed there.
 */
import { createResource, getResource, OmniConnectionError, OmniResourceType, teardownResource } from './client';

export const LABEL_CLUSTER = 'omni.sidero.dev/cluster';
export const LABEL_ROLE_CONTROLPLANE = 'omni.sidero.dev/role-controlplane';
export const LABEL_ROLE_WORKER = 'omni.sidero.dev/role-worker';
export const LABEL_MACHINE_SET = 'omni.sidero.dev/machine-set';

/** VERIFIED (2026-08-13): Cluster spec keeps both fields as plain strings, snake_case, required. */
export interface ClusterSpec {
  talos_version?: string;
  kubernetes_version?: string;
}

/**
 * VERIFIED (2026-08-13): booleans/zero-valued numbers are omitted entirely
 * rather than sent as `false`/`0` (standard protojson behavior for proto3
 * scalars) -- e.g. a freshly created cluster's ClusterStatus spec is just
 * `{talos_version, kubernetes_version, initial_talos_version}` until a real
 * machine connects, with no `ready`/`available`/`machines` key at all.
 * `kubernetesAPIReady` / `controlplaneReady` keep the exact (unusual)
 * camelCase spelling used in the .proto source itself (specs/omni.proto's
 * ClusterStatusSpec) -- NOT converted to snake_case or further camelCased --
 * consistent with every other field here being the verbatim proto name.
 * Not independently confirmed against a real nonzero value (the disposable
 * instance has no real Talos machines to bring a cluster fully up), but the
 * verbatim-proto-name pattern held for every other field checked this
 * session, so it's trusted rather than re-guessed.
 */
export interface ClusterStatusSpec {
  available?: boolean;
  machines?: {
    total?: number;
    healthy?: number;
    connected?: number;
    requested?: number;
  };
  /** 0 UNKNOWN, 1 SCALING_UP, 2 SCALING_DOWN, 3 RUNNING, 4 DESTROYING. */
  phase?: number;
  ready?: boolean;
  kubernetesAPIReady?: boolean;
  controlplaneReady?: boolean;
  talos_version?: string;
  kubernetes_version?: string;
}

/** VERIFIED (2026-08-13) via a live TalosVersions.omni.sidero.dev Get. */
export interface TalosVersionSpec {
  version?: string;
  compatible_kubernetes_versions?: string[];
  deprecated?: boolean;
  unsupported?: boolean;
}

/**
 * VERIFIED (2026-08-13): `update_strategy` round-trips as a number
 * (1 = Rolling) regardless of whether it's written as the string "Rolling"
 * or the number 1 -- written as 1 here to keep write/read symmetric, per the
 * same asymmetric-encoding caution already documented on client.ts's
 * OmniMetadata.version. `machine_allocation.allocation_type` is the same
 * enum pattern: 1 = Unlimited, confirmed by writing "Unlimited" and reading
 * back 1.
 */
export interface MachineSetSpec {
  update_strategy?: number;
  machine_allocation?: {
    name: string;
    machine_count?: number;
    allocation_type?: number;
  };
}

/** VERIFIED (2026-08-13): always `{}` on the wire -- MachineSetNode carries no spec fields, only labels. */
export type MachineSetNodeSpec = Record<string, never>;

export function controlPlaneMachineSetId(clusterName: string): string {
  return `${clusterName}-control-planes`;
}

export function workersMachineSetId(clusterName: string): string {
  return `${clusterName}-workers`;
}

/**
 * Canonical resource-type creation order, from client/pkg/template/order.go
 * (canonicalResourceOrder) in the reference omni checkout -- only the subset
 * of types this plugin's create flow actually builds. Resources are created
 * strictly in this order (all MachineSets before any MachineSetNode, etc.),
 * matching frontend/src/methods/cluster.ts's clusterSync -- which builds its
 * resource list in a more convenient interleaved order and then sorts by
 * this same table before creating anything.
 */
const CANONICAL_RESOURCE_ORDER: Partial<Record<OmniResourceType, number>> = {
  'Clusters.omni.sidero.dev': 1,
  'ConfigPatches.omni.sidero.dev': 3,
  'MachineSets.omni.sidero.dev': 6,
  'MachineSetNodes.omni.sidero.dev': 7,
};

export interface PlannedResource {
  type: OmniResourceType;
  id: string;
  labels?: Record<string, string>;
  spec: unknown;
}

/** Either an explicit list of machine UUIDs, or a reference to an existing MachineClass to allocate from. */
export type MachineSelection =
  | { kind: 'explicit'; machineIds: string[] }
  | { kind: 'machineClass'; name: string; count: number | 'unlimited' };

export interface ClusterCreateInput {
  name: string;
  talosVersion: string;
  kubernetesVersion: string;
  /**
   * Control plane machine selection is explicit-only (not machine-class
   * allocation) by design -- see cluster.ts doc / PR description: a
   * machine-class allocation's count can be "unlimited", which makes the
   * control-plane-count-must-be-odd rule (etcd requirement) impossible to
   * validate client-side. Real Omni's frontend does allow machine-class
   * allocation for control planes too; this plugin narrows that for the
   * sake of being able to actually enforce the parity check.
   */
  controlPlane: { machineIds: string[] };
  /** Omitted entirely => no worker MachineSet is created at all. */
  worker?: MachineSelection;
}

/** Builds the full resource graph for a new cluster, already sorted into the canonical creation order. */
export function buildClusterResourceGraph(input: ClusterCreateInput): PlannedResource[] {
  const resources: PlannedResource[] = [];

  resources.push({
    type: 'Clusters.omni.sidero.dev',
    id: input.name,
    spec: { talos_version: input.talosVersion, kubernetes_version: input.kubernetesVersion } satisfies ClusterSpec,
  });

  const cpId = controlPlaneMachineSetId(input.name);
  resources.push({
    type: 'MachineSets.omni.sidero.dev',
    id: cpId,
    labels: { [LABEL_CLUSTER]: input.name, [LABEL_ROLE_CONTROLPLANE]: '' },
    spec: { update_strategy: 1 } satisfies MachineSetSpec,
  });
  for (const machineId of input.controlPlane.machineIds) {
    resources.push({
      type: 'MachineSetNodes.omni.sidero.dev',
      id: machineId,
      labels: { [LABEL_CLUSTER]: input.name, [LABEL_MACHINE_SET]: cpId, [LABEL_ROLE_CONTROLPLANE]: '' },
      spec: {} satisfies MachineSetNodeSpec,
    });
  }

  if (input.worker) {
    const workerId = workersMachineSetId(input.name);
    const workerSpec: MachineSetSpec = { update_strategy: 1 };

    if (input.worker.kind === 'machineClass') {
      workerSpec.machine_allocation =
        input.worker.count === 'unlimited'
          ? { name: input.worker.name, allocation_type: 1 }
          : { name: input.worker.name, machine_count: input.worker.count };
    }

    resources.push({
      type: 'MachineSets.omni.sidero.dev',
      id: workerId,
      labels: { [LABEL_CLUSTER]: input.name, [LABEL_ROLE_WORKER]: '' },
      spec: workerSpec,
    });

    if (input.worker.kind === 'explicit') {
      for (const machineId of input.worker.machineIds) {
        resources.push({
          type: 'MachineSetNodes.omni.sidero.dev',
          id: machineId,
          labels: { [LABEL_CLUSTER]: input.name, [LABEL_MACHINE_SET]: workerId, [LABEL_ROLE_WORKER]: '' },
          spec: {} satisfies MachineSetNodeSpec,
        });
      }
    }
  }

  return [...resources].sort((a, b) => (CANONICAL_RESOURCE_ORDER[a.type] ?? 0) - (CANONICAL_RESOURCE_ORDER[b.type] ?? 0));
}

export interface ClusterFormErrors {
  name?: string;
  talosVersion?: string;
  kubernetesVersion?: string;
  controlPlane?: string;
  worker?: string;
}

/** Loose semver-ish check -- good enough to catch typos before they round-trip to the server; matches ClusterValidator's semver.ParseTolerant intent without pulling in a semver dependency. */
function looksLikeVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+/.test(v.replace(/^v/, ''));
}

/**
 * Client-side validation mirroring client/pkg/omni/resources/omni/cluster.go's
 * ClusterValidator, plus the control-plane-odd-count rule (etcd requirement,
 * confirmed live -- not a Create-time server validation, so it must be
 * caught here) and the Kubernetes/Talos compatibility check (confirmed live,
 * see the "invalid kubernetes version ... is not compatible with talos
 * version ..." error surfaced by a real Create call -- validated here too so
 * the user sees it before submitting, not just as a raw server error
 * afterward).
 */
export function validateClusterCreateInput(input: ClusterCreateInput, compatibleKubernetesVersions: string[]): ClusterFormErrors {
  const errors: ClusterFormErrors = {};

  if (!input.name) {
    errors.name = 'Name is required.';
  } else if (!/^[A-Za-z0-9_-]+$/.test(input.name)) {
    errors.name = 'Name should only contain letters, digits, dashes and underscores.';
  }

  if (!input.talosVersion) {
    errors.talosVersion = 'Talos version is required.';
  } else if (!looksLikeVersion(input.talosVersion)) {
    errors.talosVersion = 'Talos version should be in semver format.';
  }

  if (!input.kubernetesVersion) {
    errors.kubernetesVersion = 'Kubernetes version is required.';
  } else if (!looksLikeVersion(input.kubernetesVersion)) {
    errors.kubernetesVersion = 'Kubernetes version should be in semver format.';
  } else if (compatibleKubernetesVersions.length > 0 && !compatibleKubernetesVersions.includes(input.kubernetesVersion)) {
    errors.kubernetesVersion = `Kubernetes ${input.kubernetesVersion} is not compatible with Talos ${input.talosVersion || '(selected version)'}.`;
  }

  const cpCount = input.controlPlane.machineIds.length;
  if (cpCount === 0) {
    errors.controlPlane = 'At least one control plane machine is required.';
  } else if (cpCount % 2 === 0) {
    errors.controlPlane = `Control plane count must be odd (etcd requirement) -- got ${cpCount}.`;
  }

  if (input.worker?.kind === 'explicit' && input.worker.machineIds.length === 0) {
    errors.worker = 'Add at least one worker machine, or remove the worker machine set.';
  }
  if (input.worker?.kind === 'machineClass' && !input.worker.name) {
    errors.worker = 'Select a machine class to allocate workers from.';
  }

  return errors;
}

interface ClusterConfig {
  endpoint: string;
}

/**
 * Creates every resource in the graph, in canonical order, sequentially --
 * matching frontend/src/methods/cluster.ts's createResources (no batching,
 * no transaction; Omni's own frontend doesn't attempt rollback on partial
 * failure either). If a later resource fails, earlier ones (starting with
 * the Cluster itself) are already live -- the caller should surface which
 * step failed and point the user at the cluster's detail page, where they
 * can inspect the partial state or destroy it and retry, rather than
 * silently leaving an orphaned partial cluster with no way to find it.
 */
export async function createCluster(
  config: ClusterConfig,
  input: ClusterCreateInput,
  onProgress?: (resource: PlannedResource, index: number, total: number) => void
): Promise<void> {
  const resources = buildClusterResourceGraph(input);
  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    onProgress?.(resource, i, resources.length);
    await createResource(config, resource.type, resource.id, resource.spec, { labels: resource.labels });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const DESTROY_POLL_INTERVAL_MS = 2000;
const DESTROY_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Destroys a cluster: a single Teardown call on the Cluster resource, then
 * polling Get until it 404s.
 *
 * VERIFIED live (2026-08-13): tearing down a Cluster with a control-plane
 * MachineSet, a worker MachineSet (one plain, one with machine_allocation),
 * and MachineSetNodes cascades automatically via COSI ownership -- a single
 * Teardown on the Cluster was suffient; every child resource (MachineSets,
 * MachineSetNodes) 404'd on the very next Get, with no need to enumerate or
 * individually tear down children. (The disposable instance's cluster had no
 * real connected machines, so this measured the *cascade wiring* rather than
 * genuine multi-minute finalizer drain time under load -- the poll loop
 * below is what actually paces this against a real cluster's ~12 finalizers,
 * per the design brief; the fast 404 seen in testing is a property of the
 * test cluster, not evidence the poll loop is unnecessary.)
 *
 * client.ts's deleteResourceFully (Teardown immediately followed by Delete)
 * is NOT used here: that pattern only works for resources with zero
 * finalizers, and a Cluster genuinely has ~12 (ClusterStatusController,
 * SecretsController, TalosUpgradeStatusController, ...) that need real time
 * to clear -- an immediate Delete would race them. Polling Get until 404
 * sidesteps the need to call Delete at all: once every finalizer has
 * cleared, COSI's own teardown-to-delete transition removes the resource,
 * so a 404 on Get is sufficient evidence of "fully gone" without this plugin
 * calling Delete itself (client.ts has no watch/streaming mechanism, so
 * polling is the pragmatic choice here, not a compromise).
 */
export async function destroyCluster(config: ClusterConfig, clusterName: string, onPoll?: (attempt: number) => void): Promise<void> {
  await teardownResource(config, 'Clusters.omni.sidero.dev', clusterName);

  const deadline = Date.now() + DESTROY_POLL_TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    onPoll?.(attempt);

    try {
      await getResource(config, 'Clusters.omni.sidero.dev', clusterName);
    } catch (err) {
      if (err instanceof OmniConnectionError && err.status === 404) {
        return; // gone -- cascade teardown + finalizer drain completed
      }
      throw err;
    }

    await sleep(DESTROY_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Cluster "${clusterName}" is still tearing down after ${Math.round(DESTROY_POLL_TIMEOUT_MS / 1000)}s -- its finalizers haven't cleared yet. It should finish eventually; check back, or inspect it directly (e.g. via omnictl).`
  );
}
