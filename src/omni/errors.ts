/**
 * Connection/gateway error handling shared by every Omni RPC client in this
 * plugin — client.ts (ResourceService) and authService.ts (AuthService).
 *
 * Split out of client.ts (which originally defined all of this inline) so
 * that authService.ts and userAuth.ts (the new per-user Auth0/ECDSA auth
 * path) can produce and inspect the exact same OmniConnectionError type
 * without importing client.ts itself -- client.ts pulls in auth.ts, which
 * imports openpgp at module scope, which crashes under this project's jsdom
 * test environment (see the note atop client.test.ts). Keeping this module
 * free of that import lets userAuth.ts/authService.ts stay unit-testable the
 * same way. client.ts re-exports everything here unchanged, so existing
 * imports of OmniConnectionError/isNetworkLevelFailure `from './client'`
 * keep working exactly as before.
 */

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
export interface GRPCGatewayErrorBody {
  code: number;
  message: string;
}

export function asGRPCGatewayError(response: unknown): GRPCGatewayErrorBody | null {
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
    let causeMessage: string;
    if (cause instanceof Error) {
      causeMessage = cause.message;
    } else {
      switch (typeof cause) {
        case 'string':
          causeMessage = cause;
          break;
        case 'number':
        case 'boolean':
        case 'bigint':
        case 'symbol':
          causeMessage = cause.toString();
          break;
        default:
          // object, function, undefined -- JSON.stringify covers all of
          // these usefully except a bare `undefined`, which it returns as
          // the JS value `undefined` rather than a string.
          causeMessage = JSON.stringify(cause) ?? 'undefined';
      }
    }
    super(`Could not reach Omni: ${causeMessage}`);
    this.name = 'OmniConnectionError';
    if (
      cause &&
      typeof cause === 'object' &&
      'status' in cause &&
      typeof (cause as { status: unknown }).status === 'number'
    ) {
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

/** Thrown when no credential (service account or Auth0/ECDSA session) is currently usable -- distinct from a network/connection failure, see isNetworkLevelFailure. */
export class OmniNotConfiguredError extends Error {
  constructor() {
    super(
      'Omni endpoint or credentials are not configured (paste a service account key, or log in via Auth0).'
    );
    this.name = 'OmniNotConfiguredError';
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
  if (err instanceof OmniNotConfiguredError) {
    return false;
  }
  if (!(err instanceof OmniConnectionError)) {
    return true;
  }
  return err.status === undefined || err.status === 502 || err.status === 408;
}
