/**
 * Thin client for Omni's AuthService -- a DIFFERENT gRPC service than
 * ResourceService (client.ts), reached through the same Headlamp
 * /externalproxy route via the same /api/<service>/<Method> grpc-gateway
 * convention (see omniProxy.ts / client.ts's module doc for how that
 * convention works). Backs the per-user Auth0 + ECDSA auth path
 * (userAuth.ts) -- mirrors how client.ts wraps ResourceService.
 *
 * Confirmed against the real client (siderolabs/omni's
 * frontend/src/api/omni/auth/auth.pb.ts) for RPC names and request/response
 * shapes, and against internal/pkg/auth/interceptor/{auth_config,signature}.go
 * plus internal/backend/grpc/auth.go for which calls need signing:
 *
 *  - RegisterPublicKey: UNSIGNED, no auth headers at all. The server's own
 *    handler marks its context as an internal actor
 *    (internal/backend/grpc/auth.go's RegisterPublicKey calls
 *    actor.MarkContextAsInternalActor), and separately -- at the
 *    interceptor level, before that handler even runs -- a request that
 *    carries no signature at all is treated as message.ErrNotFound by
 *    interceptor/signature.go and passed straight through rather than
 *    rejected. Ownership of the identity is proven afterward by
 *    ConfirmPublicKey, not by this call; confirmed directly in the real
 *    frontend (frontend/src/methods/key.ts's createKeys calls
 *    AuthService.RegisterPublicKey with zero request options).
 *  - ConfirmPublicKey / AwaitPublicKeyConfirmation: also exempt from the
 *    siderov1 signature scheme (interceptor/interceptor.ts's isSignedRequest
 *    excludes every "/api/auth." path but one -- see below), but
 *    ConfirmPublicKey requires the caller to prove the Auth0 (or OIDC/SAML)
 *    identity directly via a plain `Grpc-Metadata-authorization: Bearer
 *    <idToken>` header -- see frontend/src/pages/authenticate.vue's
 *    confirmPublicKey.
 *  - RevokePublicKey: the one exception, explicitly carved BACK IN to the
 *    signed-request set by frontend/src/methods/interceptor.ts's
 *    isSignedRequest (`path.startsWith('/api/auth.AuthService/RevokePublicKey')`),
 *    so revoking a key must itself be signed by that same key -- callers
 *    pass already-computed signed headers, same as client.ts's
 *    callResourceService.
 */
import { OmniEndpointConfig, postToOmniGRPCGateway } from './omniProxy';

const AUTH_SERVICE = 'auth.AuthService';

export interface PublicKeyPlain {
  /** PEM-wrapped SPKI public key -- see userAuth.ts's exportPublicKeyPem. */
  key_pem: string;
  /** RFC3339 timestamps (google.protobuf.Timestamp's JSON mapping is a plain string, not an object). */
  not_before: string;
  not_after: string;
}

export interface RegisterPublicKeyRequest {
  public_key: { plain_key: PublicKeyPlain };
  identity: { email: string };
}

export interface RegisterPublicKeyResponse {
  login_url?: string;
  public_key_id: string;
}

/** Registers a fresh, as-yet-unconfirmed public key for `request.identity.email`. Unsigned -- see module doc. */
export async function registerPublicKey(
  config: OmniEndpointConfig,
  request: RegisterPublicKeyRequest
): Promise<RegisterPublicKeyResponse> {
  return postToOmniGRPCGateway<RegisterPublicKeyResponse>(config, `/${AUTH_SERVICE}/RegisterPublicKey`, request, {});
}

/**
 * Proves ownership of the identity behind `publicKeyId` using a Bearer ID
 * token (Auth0/OIDC) -- see module doc. Throws (via OmniConnectionError) on
 * failure, e.g. an expired or already-used Auth0 token.
 */
export async function confirmPublicKey(config: OmniEndpointConfig, publicKeyId: string, bearerIdToken: string): Promise<void> {
  await postToOmniGRPCGateway<unknown>(
    config,
    `/${AUTH_SERVICE}/ConfirmPublicKey`,
    { public_key_id: publicKeyId },
    { 'Grpc-Metadata-authorization': `Bearer ${bearerIdToken}` }
  );
}

/**
 * Blocks (server-side, up to 5 minutes per internal/backend/grpc/auth.go's
 * awaitPublicKeyConfirmationTimeout) until `publicKeyId` is confirmed by
 * some other actor -- the CLI flow's mechanism, not currently used by this
 * plugin's own UI (which confirms synchronously via its own ID token
 * instead, see userAuth.ts), but included here for completeness/parity with
 * the full AuthService surface.
 */
export async function awaitPublicKeyConfirmation(config: OmniEndpointConfig, publicKeyId: string): Promise<void> {
  await postToOmniGRPCGateway<unknown>(config, `/${AUTH_SERVICE}/AwaitPublicKeyConfirmation`, { public_key_id: publicKeyId }, {});
}

/** Revokes a previously-registered public key. Must be signed BY THAT SAME KEY -- see module doc. */
export async function revokePublicKey(
  config: OmniEndpointConfig,
  publicKeyId: string,
  signedHeaders: Record<string, string>
): Promise<void> {
  await postToOmniGRPCGateway<unknown>(config, `/${AUTH_SERVICE}/RevokePublicKey`, { public_key_id: publicKeyId }, signedHeaders);
}
