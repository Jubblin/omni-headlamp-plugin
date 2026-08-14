/**
 * Thin client for Omni's ResourceService, routed through Headlamp's
 * /externalproxy backend route.
 *
 * VERIFIED END-TO-END (2026-08-11) against a real, disposable local Omni
 * instance — see auth.ts for the full signing-scheme writeup. Summary:
 *
 *  - Omni exposes ResourceService as plain JSON-over-HTTP via grpc-gateway,
 *    mounted under an /api/ HTTP prefix:
 *      POST /api/omni.resources.ResourceService/{Get,List,Update,Delete,Teardown}
 *    Generic across resource types via {namespace, type, id} -- ConfigPatch
 *    and MachineClass use the identical shape.
 *  - The /api/ prefix is an HTTP-routing detail only. The string that must be
 *    SIGNED (as the payload's "method" field) is the plain gRPC method path
 *    WITHOUT that prefix, e.g. "/omni.resources.ResourceService/List" --
 *    verification happens at the gRPC layer after grpc-gateway's internal
 *    translation, which always dispatches using the bare method name.
 *  - Headlamp's /externalproxy forwards the request verbatim to whatever URL
 *    is in the `proxy-to` header, gated by the server's -proxy-urls allowlist.
 *    Reached via ApiProxy.request(path, params, autoLogoutOnAuthError,
 *    useCluster=false) so no cluster prefix is added. See omniProxy.ts,
 *    which now owns this plumbing (shared with authService.ts).
 *  - Auth headers must carry the `Grpc-Metadata-` prefix (grpc-gateway's
 *    default header matcher drops unprefixed custom headers), and every
 *    ResourceService call needs `runtime: "Omni"` alongside the signing
 *    headers (see signResourceServiceRequest in auth.ts).
 *
 * TWO independent, parallel signing schemes can produce those auth headers,
 * and this client is agnostic to which one is active (see
 * signActiveResourceServiceRequest below):
 *  - auth.ts: a shared PGP service-account key, pasted by the user.
 *  - userAuth.ts: a per-user Auth0 login + ECDSA WebCrypto keypair, mirroring
 *    Omni's own first-party web UI. See userAuth.ts's module doc.
 * A pasted service account key, if present, always wins -- this keeps
 * existing service-account users' behavior completely unchanged regardless
 * of whether an Auth0 session also exists.
 */
import { createElement, ReactNode } from 'react';
import { loadServiceAccount, signResourceServiceRequest } from './auth';
import { OmniConnectionError, OmniNotConfiguredError } from './errors';
import { postToOmniGRPCGateway } from './omniProxy';
import { hasValidUserSession, loadUserSession, signResourceServiceRequestECDSA } from './userAuth';

// Re-exported unchanged so every existing `from './client'` import of these
// keeps working -- see errors.ts's module doc for why the implementation
// moved out (so authService.ts/userAuth.ts, the new per-user auth path, can
// share the exact same error type without pulling in auth.ts's openpgp
// import).
export { OmniConnectionError, OmniNotConfiguredError };
export { isNetworkLevelFailure } from './errors';

export const OMNI_NAMESPACE_DEFAULT = 'default';

export type OmniResourceType =
  | 'ConfigPatches.omni.sidero.dev'
  | 'MachineClasses.omni.sidero.dev'
  | 'Clusters.omni.sidero.dev'
  | 'MachineSets.omni.sidero.dev'
  | 'MachineSetNodes.omni.sidero.dev'
  | 'ClusterStatuses.omni.sidero.dev'
  | 'TalosVersions.omni.sidero.dev';

export interface OmniMetadata {
  namespace: string;
  type: string;
  id: string;
  /**
   * VERIFIED against a real instance (2026-08-11): the wire JSON encodes
   * this as a number (e.g. `"version":1`), not a string, despite
   * UpdateRequest.currentVersion being declared `string` in resources.proto.
   * Submitting the raw number back as currentVersion is rejected
   * ("invalid value for string field currentVersion") -- see
   * updateResource(), which coerces via String(...).
   */
  version: number;
  owner: string;
  phase: string;
  created?: string;
  updated?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface OmniResource<TSpec = unknown> {
  metadata: OmniMetadata;
  /** Spec is JSON-encoded on the wire (ResourceService.Resource.spec: string); decoded here. */
  spec: TSpec;
}

/**
 * Known "not really set" sentinel values for a resource's `metadata.updated`
 * timestamp -- Omni returns one of these for a resource that's never
 * actually been updated, rather than omitting the field. Two different
 * conventions have been observed on real data, not just one:
 *   - Go's zero-value time.Time: "0001-01-01T00:00:00Z" (disposable
 *     test-instance resources, found 2026-08-12 via CDP inspection).
 *   - Unix epoch zero: "1970-01-01T00:00:00Z" (real production resources
 *     on omni.ad.bonkie.net, found 2026-08-12 during a real-instance
 *     dogfood pass -- only visible against real data; the disposable
 *     instance's test resources never happened to hit this code path).
 * Was originally a per-file duplicated ZERO_TIME constant checking only the
 * first case; centralized here after the second sentinel turned up, so a
 * third one (if it exists) only needs fixing in one place.
 */
const UNSET_TIMESTAMP_SENTINELS = new Set(['0001-01-01T00:00:00Z', '1970-01-01T00:00:00Z']);

/**
 * Formats a resource's metadata.updated for display, collapsing unset-sentinel
 * values to a centered "—" (real timestamps render as plain left-aligned
 * text, unchanged). Returns a ReactNode rather than a plain string so the
 * centering can travel with the value itself, rather than requiring every
 * call site to know which values need it -- used directly inside a
 * TableCell in the list views, and inline (as "Updated <value>") in the
 * detail views' header.
 */
export function formatUpdated(updated: string | undefined): ReactNode {
  if (updated && !UNSET_TIMESTAMP_SENTINELS.has(updated)) {
    return updated;
  }
  return createElement('span', { style: { display: 'block', textAlign: 'center' } }, '—');
}

export interface OmniClientConfig {
  /** Base URL of the Omni instance, e.g. https://omni.example.com */
  endpoint: string;
}

/**
 * True when SOME usable credential is currently available -- either auth
 * path counts. Used by the list pages (ConfigPatchesList/MachineClassesList)
 * to decide whether to render ConnectPrompt, in place of the old
 * PGP-only `loadServiceAccount() !== null` check.
 */
export async function hasActiveCredential(): Promise<boolean> {
  const account = await loadServiceAccount();
  if (account) {
    return true;
  }
  return hasValidUserSession();
}

/**
 * Resolves whichever auth path is currently active and signs one
 * ResourceService request with it -- see this module's doc comment for the
 * "service account always wins if present" precedence rule.
 */
async function signActiveResourceServiceRequest(grpcMethod: string): Promise<Record<string, string>> {
  const account = await loadServiceAccount();
  if (account) {
    return signResourceServiceRequest(account, grpcMethod);
  }

  const session = await loadUserSession();
  if (session && session.keyExpirationTime > Date.now()) {
    return signResourceServiceRequestECDSA(session, grpcMethod);
  }

  throw new OmniNotConfiguredError();
}

/**
 * Calls one ResourceService RPC through /externalproxy, signing the request
 * with whichever credential is currently active.
 *
 * @param config - Omni endpoint config (non-secret, from plugin settings).
 * @param rpcMethod - e.g. "Get", "List", "Update", "Delete", "Teardown".
 * @param requestBody - JSON-serializable request message.
 */
async function callResourceService<TResponse>(config: OmniClientConfig, rpcMethod: string, requestBody: unknown): Promise<TResponse> {
  // Two different strings, both required: the HTTP wire path (with /api/,
  // for grpc-gateway routing, added by postToOmniGRPCGateway) and the plain
  // gRPC method path (signed, per auth.ts's verified scheme -- no /api/
  // prefix).
  const grpcMethod = `/omni.resources.ResourceService/${rpcMethod}`;
  const authHeaders = await signActiveResourceServiceRequest(grpcMethod);
  return postToOmniGRPCGateway<TResponse>(config, grpcMethod, requestBody, authHeaders);
}

export const AUTH_CONFIG_TYPE = 'AuthConfigs.omni.sidero.dev';
export const AUTH_CONFIG_ID = 'auth-config';

/** Wire shape of AuthConfigs.omni.sidero.dev's spec -- only the fields this plugin actually reads. */
export interface OmniAuthConfigSpec {
  auth0?: {
    enabled?: boolean;
    domain?: string;
    client_id?: string;
    useFormData?: boolean;
  };
  saml?: { enabled?: boolean };
  oidc?: { enabled?: boolean };
  suspended?: boolean;
  has_initial_user?: boolean;
}

/**
 * Unsigned discovery call: fetches Omni's AuthConfig resource with ZERO
 * signing -- just the Grpc-Metadata-runtime header every ResourceService
 * call needs (see internal/backend/grpc/resource.go's "missing runtime
 * metadata" rejection, noted in auth.ts's module doc). This is how
 * ConnectPrompt/SessionExpiryWarning discover whether (and how) to offer
 * the Auth0 login option -- necessarily before any credential exists yet,
 * which is exactly what this call is designed for.
 *
 * VERIFIED: internal/pkg/auth/interceptor/auth_config.go's AuthConfig
 * interceptor computes `isPublicResourceRequest` for ResourceService.Get by
 * checking `omni.PublicResourceTypes[getReq.Type]`, and
 * internal/backend/runtime/omni/state_access.go lists AuthConfigType in
 * PublicResourceTypes -- so the signature-required check for this specific
 * Get short-circuits to false regardless of caller identity. Confirmed live
 * against a real instance (https://omni.ad.bonkie.net): an unsigned
 * ResourceService.Get for {namespace:"default",
 * type:"AuthConfigs.omni.sidero.dev", id:"auth-config"} with only the
 * runtime header returns 200 with the real Auth0 config, no signature
 * headers required.
 */
export async function getAuthConfig(config: OmniClientConfig): Promise<OmniAuthConfigSpec> {
  const grpcMethod = '/omni.resources.ResourceService/Get';
  const response = await postToOmniGRPCGateway<{ body: string }>(
    config,
    grpcMethod,
    { namespace: OMNI_NAMESPACE_DEFAULT, type: AUTH_CONFIG_TYPE, id: AUTH_CONFIG_ID },
    { 'Grpc-Metadata-runtime': 'Omni' }
  );
  const resource = JSON.parse(response.body) as OmniResource<OmniAuthConfigSpec>;
  return resource.spec;
}

export interface ListOptions {
  namespace?: string;
  offset?: number;
  limit?: number;
  sortByField?: string;
  sortDescending?: boolean;
  searchFor?: string[];
}

/** Lists resources of a given type. Pagination is native to Omni's API (offset/limit), not client-side. */
export async function listResources<TSpec>(
  config: OmniClientConfig,
  type: OmniResourceType,
  options: ListOptions = {}
): Promise<{ items: OmniResource<TSpec>[]; total: number }> {
  const response = await callResourceService<{ items: string[]; total: number }>(config, 'List', {
    namespace: options.namespace ?? OMNI_NAMESPACE_DEFAULT,
    type,
    offset: options.offset ?? 0,
    limit: options.limit ?? 50,
    sort_by_field: options.sortByField ?? '',
    sort_descending: options.sortDescending ?? false,
    search_for: options.searchFor ?? [],
  });

  return {
    items: (response.items ?? []).map(item => JSON.parse(item) as OmniResource<TSpec>),
    total: response.total ?? 0,
  };
}

export async function getResource<TSpec>(
  config: OmniClientConfig,
  type: OmniResourceType,
  id: string,
  namespace = OMNI_NAMESPACE_DEFAULT
): Promise<OmniResource<TSpec>> {
  const response = await callResourceService<{ body: string }>(config, 'Get', { namespace, type, id });
  return JSON.parse(response.body) as OmniResource<TSpec>;
}

export interface CreateResourceOptions {
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/**
 * Creates a new resource. Used by the Cluster create flow (see cluster.ts) to
 * build up a Cluster's resource graph one ResourceService.Create call at a
 * time -- there is no dedicated "create a cluster" RPC; Omni's own frontend
 * does the same thing (frontend/src/methods/cluster.ts's createResources).
 *
 * VERIFIED (2026-08-13) against the disposable instance, via the same signed
 * ResourceService.Create call this function makes (POST .../Create with
 * `{resource: {metadata, spec: JSON.stringify(spec)}}`, matching
 * updateResource's spec-encoding below): a Cluster, MachineSet (both plain
 * and with machine_allocation), and MachineSetNode created this way round-trip
 * correctly on a subsequent Get -- confirms Create takes the same
 * metadata/spec shape as Update, just without currentVersion.
 */
export async function createResource<TSpec>(
  config: OmniClientConfig,
  type: OmniResourceType,
  id: string,
  spec: TSpec,
  options: CreateResourceOptions = {}
): Promise<void> {
  await callResourceService<void>(config, 'Create', {
    resource: {
      metadata: {
        namespace: options.namespace ?? OMNI_NAMESPACE_DEFAULT,
        type,
        id,
        labels: options.labels,
        annotations: options.annotations,
      },
      spec: JSON.stringify(spec),
    },
  });
}

/**
 * Updates a resource, enforcing optimistic concurrency via currentVersion --
 * this is Omni's own built-in mechanism (verified: UpdateRequest.currentVersion),
 * not a custom check bolted on client-side.
 */
export async function updateResource<TSpec>(
  config: OmniClientConfig,
  resource: OmniResource<TSpec>
): Promise<void> {
  await callResourceService<void>(config, 'Update', {
    // currentVersion AND resource.metadata.version both need coercing to
    // string -- VERIFIED: Omni's Get/List responses encode metadata.version
    // as a bare JSON number, but both proto "string version" fields
    // (top-level currentVersion AND the nested resource.metadata.version)
    // reject an unquoted number on write ("invalid value for string field
    // version"). The read and write encodings are asymmetric; coerce both.
    currentVersion: String(resource.metadata.version),
    resource: {
      metadata: { ...resource.metadata, version: String(resource.metadata.version) as unknown as number },
      // Only spec changes are ever sent; metadata fields other than version
      // (id, owner, phase, finalizers, ...) are round-tripped unchanged --
      // see design doc's round-trip-safety finding.
      spec: JSON.stringify(resource.spec),
    },
  });
}

/**
 * Two-phase delete: Teardown marks the resource for destruction, Delete
 * removes it once no finalizers remain.
 *
 * VERIFIED (2026-08-11): for a resource with no finalizers (e.g. a plain
 * ConfigPatch), Teardown alone fully removes it -- a Delete call immediately
 * afterward reliably 404s ("doesn't exist"), not a bug or a race. This
 * function calls Teardown, then Delete, and treats a 404 on the Delete step
 * as success (the resource is already gone, which is the desired end state)
 * rather than surfacing it as an error.
 */
export async function teardownResource(
  config: OmniClientConfig,
  type: OmniResourceType,
  id: string,
  namespace = OMNI_NAMESPACE_DEFAULT
): Promise<void> {
  await callResourceService<void>(config, 'Teardown', { namespace, type, id });
}

export async function deleteResource(
  config: OmniClientConfig,
  type: OmniResourceType,
  id: string,
  namespace = OMNI_NAMESPACE_DEFAULT
): Promise<void> {
  await callResourceService<void>(config, 'Delete', { namespace, type, id });
}

/** Full delete flow: Teardown, then Delete, tolerating "already gone" — see doc comment above teardownResource. */
export async function deleteResourceFully(
  config: OmniClientConfig,
  type: OmniResourceType,
  id: string,
  namespace = OMNI_NAMESPACE_DEFAULT
): Promise<void> {
  await teardownResource(config, type, id, namespace);

  try {
    await deleteResource(config, type, id, namespace);
  } catch (err) {
    if (err instanceof OmniConnectionError && err.status === 404) {
      return; // already gone -- Teardown completed the removal, this is success
    }
    throw err;
  }
}
