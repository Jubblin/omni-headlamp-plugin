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
 *    useCluster=false) so no cluster prefix is added.
 *  - Auth headers must carry the `Grpc-Metadata-` prefix (grpc-gateway's
 *    default header matcher drops unprefixed custom headers), and every
 *    ResourceService call needs `runtime: "Omni"` alongside the signing
 *    headers (see signResourceServiceRequest in auth.ts).
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { loadServiceAccount, signResourceServiceRequest } from './auth';

export const OMNI_NAMESPACE_DEFAULT = 'default';

export type OmniResourceType = 'ConfigPatches.omni.sidero.dev' | 'MachineClasses.omni.sidero.dev';

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
 * Standard grpc-gateway runtime.HTTPStatusFromCode mapping, replicated here
 * because Headlamp's /externalproxy handler can't be relied on to apply it
 * itself -- see the "embedded error" note on OmniConnectionError below.
 * Only the codes this plugin's error paths actually care about are listed;
 * anything else falls back to a generic connection error.
 */
const GRPC_CODE_TO_HTTP_STATUS: Record<number, number> = {
  3: 400, // InvalidArgument
  5: 404, // NotFound
  6: 409, // AlreadyExists (Omni's optimistic-concurrency conflict uses this code)
  7: 403, // PermissionDenied
  9: 400, // FailedPrecondition
  10: 409, // Aborted
  16: 401, // Unauthenticated
};

/** Shape of a grpc-gateway JSON error body: `{code, message}`, `code` a gRPC status code. */
interface GRPCGatewayErrorBody {
  code: number;
  message: string;
}

function asGRPCGatewayError(response: unknown): GRPCGatewayErrorBody | null {
  if (
    response &&
    typeof response === 'object' &&
    'code' in response &&
    'message' in response &&
    typeof (response as { code: unknown }).code === 'number' &&
    typeof (response as { message: unknown }).message === 'string'
  ) {
    return response as GRPCGatewayErrorBody;
  }
  return null;
}

/** Thrown to distinguish "Omni unreachable" from a genuinely empty result — see design doc Success Criteria. */
export class OmniConnectionError extends Error {
  /**
   * HTTP status code, when known. Two sources, both handled here because
   * neither can be trusted alone:
   *  1. The underlying ApiProxy.request rejection carried one (see
   *     clusterRequests.ts: `error.status = status`) -- the normal path.
   *  2. VERIFIED (2026-08-12): Headlamp's /externalproxy handler
   *     (backend/cmd/headlamp.go) forwards the proxied response body via
   *     `w.Write(respBody)` WITHOUT ever calling `w.WriteHeader(resp.StatusCode)`
   *     first -- Go's net/http implicitly sends 200 in that case. Every
   *     non-2xx response from Omni (409 conflicts, 404s, etc.) therefore
   *     arrives at this plugin wrapped in an HTTP 200, indistinguishable
   *     from success by status code alone. This is a real upstream
   *     Headlamp defect, not specific to this plugin's test setup, and
   *     will affect any real deployment. Confirmed by replaying the exact
   *     same signed Update call directly against Omni (bypassing
   *     /externalproxy): real status 409, real body
   *     `{"code":6,"message":"...update conflict..."}`; through
   *     /externalproxy, the identical call resolves as HTTP 200 with that
   *     same body. Since the status code can't be trusted, this plugin
   *     detects the grpc-gateway `{code, message}` error shape in the
   *     response BODY regardless of the wrapping HTTP status and
   *     synthesizes the equivalent status via GRPC_CODE_TO_HTTP_STATUS --
   *     see callResourceService.
   */
  status?: number;

  constructor(cause: unknown) {
    super(`Could not reach Omni: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'OmniConnectionError';
    if (cause && typeof cause === 'object' && 'status' in cause && typeof (cause as { status: unknown }).status === 'number') {
      this.status = (cause as { status: number }).status;
    }
  }

  /** Builds an OmniConnectionError directly from a grpc-gateway error body, synthesizing .status from its gRPC code. */
  static fromGRPCGatewayError(body: GRPCGatewayErrorBody): OmniConnectionError {
    const err = new OmniConnectionError(new Error(body.message));
    err.status = GRPC_CODE_TO_HTTP_STATUS[body.code];
    return err;
  }
}

/**
 * True when an OmniConnectionError represents a request that was sent but
 * never got a confirmed response -- a dropped connection, a Headlamp-side
 * timeout, or (from the plugin's perspective, indistinguishable) Headlamp's
 * own backend being unreachable -- as opposed to a clean rejection Omni
 * itself sent back (409 conflict, 400 validation error, etc.).
 *
 * VERIFIED (2026-08-12) via `frontend/src/lib/k8s/api/v1/clusterRequests.ts`
 * (the real implementation behind `ApiProxy.request`, which this plugin
 * calls): when the browser's own `fetch()` call throws (network failure,
 * connection reset, Headlamp backend unreachable), that function does NOT
 * leave `.status` undefined -- it synthesizes `new Response(undefined,
 * {status: 502, statusText: 'Unreachable'})` as a deliberate fallback, and
 * `AbortError` (timeout) similarly synthesizes `status: 408`. An initial
 * implementation checked `err.status === undefined` for this case, which
 * NEVER matches a real network failure -- confirmed by deliberately failing
 * a live Update request at the network layer (Chrome DevTools Protocol's
 * Fetch.failRequest) and observing the real error carried `status: 502`,
 * falling through to a generic error state instead of the intended
 * mid-apply-unknown recovery flow. `undefined` is still checked too, as a
 * defensive fallback for any other path that might not carry a status.
 */
export function isNetworkLevelFailure(err: unknown): boolean {
  if (!(err instanceof OmniConnectionError)) {
    return true;
  }
  return err.status === undefined || err.status === 502 || err.status === 408;
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

/** Formats a resource's metadata.updated for display, collapsing unset-sentinel values to "—". */
export function formatUpdated(updated: string | undefined): string {
  return updated && !UNSET_TIMESTAMP_SENTINELS.has(updated) ? updated : '—';
}

export class OmniNotConfiguredError extends Error {
  constructor() {
    super('Omni endpoint or service account key is not configured.');
    this.name = 'OmniNotConfiguredError';
  }
}

interface OmniClientConfig {
  /** Base URL of the Omni instance, e.g. https://omni.example.com */
  endpoint: string;
}

/**
 * Calls one ResourceService RPC through /externalproxy, signing the request
 * with the stored service account key.
 *
 * @param config - Omni endpoint config (non-secret, from plugin settings).
 * @param rpcMethod - e.g. "Get", "List", "Update", "Delete", "Teardown".
 * @param requestBody - JSON-serializable request message.
 */
async function callResourceService<TResponse>(
  config: OmniClientConfig,
  rpcMethod: string,
  requestBody: unknown
): Promise<TResponse> {
  const account = await loadServiceAccount();
  if (!account) {
    throw new OmniNotConfiguredError();
  }

  // Two different strings, both required: the HTTP wire path (with /api/,
  // for grpc-gateway routing) and the plain gRPC method path (signed, per
  // auth.ts's verified scheme -- no /api/ prefix).
  const grpcMethod = `/omni.resources.ResourceService/${rpcMethod}`;
  const httpPath = `/api${grpcMethod}`;
  const targetUrl = `${config.endpoint.replace(/\/+$/, '')}${httpPath}`;
  const body = JSON.stringify(requestBody);

  const authHeaders = await signResourceServiceRequest(account, grpcMethod);

  let response: any;
  try {
    response = await ApiProxy.request(
      '/externalproxy',
      {
        method: 'POST',
        headers: {
          // VERIFIED (2026-08-12): "proxy-to" starts with the reserved "Proxy-"
          // prefix, which Fetch's forbidden-header-name rules strip from any
          // browser-issued request -- silently, no error, before the request
          // even leaves the tab. This broke every /externalproxy call from
          // this plugin in a real browser context (confirmed via direct fetch()
          // testing: curl delivers "proxy-to" fine, but no browser ever will).
          // Headlamp's backend accepts "Forward-To" as an equivalent alias
          // (backend/cmd/headlamp.go's /externalproxy handler checks both) --
          // use that instead since it isn't forbidden.
          'Forward-To': targetUrl,
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body,
      },
      true,
      /* useCluster */ false
    );
  } catch (err) {
    // ApiProxy.request throws on non-2xx and on network failure alike; we can't
    // always tell them apart here, so callers that need the connection-error
    // vs real-rejection distinction (see design doc) should inspect err.status
    // when available and otherwise treat it as a connection error.
    throw new OmniConnectionError(err);
  }

  // See the "embedded error" note on OmniConnectionError: /externalproxy
  // can hand back a real Omni error body wrapped in a 200, so a successful
  // ApiProxy.request() call is not sufficient evidence of success.
  const gatewayError = asGRPCGatewayError(response);
  if (gatewayError) {
    throw OmniConnectionError.fromGRPCGatewayError(gatewayError);
  }

  return response as TResponse;
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
