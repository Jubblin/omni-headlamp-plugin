/**
 * Shared "POST one grpc-gateway JSON RPC through Headlamp's /externalproxy"
 * plumbing, used by every RPC client in this plugin: client.ts
 * (omni.resources.ResourceService) and authService.ts (auth.AuthService).
 *
 * Split out so both can share it without either depending on the other, and
 * so neither has to duplicate the /externalproxy quirks documented below.
 * Deliberately free of auth.ts's openpgp import (see errors.ts's module doc)
 * so userAuth.ts/authService.ts stay independently unit-testable.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { asGRPCGatewayError, OmniConnectionError } from './errors';

export interface OmniEndpointConfig {
  /** Base URL of the Omni instance, e.g. https://omni.example.com */
  endpoint: string;
}

/**
 * POSTs a grpc-gateway JSON request through /externalproxy.
 *
 * @param config - Omni endpoint config (non-secret, from plugin settings).
 * @param grpcMethod - The PLAIN gRPC method path, e.g.
 *   "/omni.resources.ResourceService/Get" or "/auth.AuthService/RegisterPublicKey"
 *   -- NOT the "/api/"-prefixed HTTP path. This function adds the /api/
 *   prefix for the actual HTTP request; callers that also need to sign the
 *   request (see auth.ts / userAuth.ts) must sign this same unprefixed
 *   string, since verification happens at the gRPC layer after
 *   grpc-gateway's translation -- see auth.ts's module doc for the full
 *   verified writeup of why these are two different strings.
 * @param requestBody - JSON-serializable request message.
 * @param authHeaders - Already-computed auth headers to attach (signed
 *   siderov1 headers, a plain Bearer authorization header, or none at all
 *   for a genuinely unsigned/public call) -- this function does no signing
 *   itself, just attaches whatever the caller already computed.
 */
export async function postToOmniGRPCGateway<TResponse>(
  config: OmniEndpointConfig,
  grpcMethod: string,
  requestBody: unknown,
  authHeaders: Record<string, string>
): Promise<TResponse> {
  const httpPath = `/api${grpcMethod}`;
  const targetUrl = `${config.endpoint.replace(/\/+$/, '')}${httpPath}`;
  const body = JSON.stringify(requestBody);

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
          // even leaves the tab. Headlamp's backend accepts "Forward-To" as
          // an equivalent alias (backend/cmd/headlamp.go's /externalproxy
          // handler checks both) -- use that instead since it isn't forbidden.
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
    // vs real-rejection distinction should inspect err.status when available
    // and otherwise treat it as a connection error.
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
