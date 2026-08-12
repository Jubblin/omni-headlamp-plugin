/**
 * Omni service-account authentication.
 *
 * Omni does NOT use bearer tokens. Every request is signed with the service
 * account's PGP private key (github.com/siderolabs/go-api-signature, the
 * "siderov1" scheme).
 *
 * VERIFIED END-TO-END (2026-08-11) against a real, disposable local Omni
 * instance — a signed ResourceService.List call returned HTTP 200. This is
 * NOT the naive scheme the header-format docs alone would suggest; three
 * non-obvious things had to be reverse-engineered from source, each of which
 * silently failed with the exact same generic "invalid signature" error
 * (the interceptor deliberately doesn't leak which check failed):
 *
 * 1. The real header names are `x-sidero-timestamp` / `x-sidero-payload` /
 *    `x-sidero-signature` (github.com/siderolabs/go-api-signature/pkg/message/common.go)
 *    — not the generic "Timestamp"/"Signature" names a first read of the
 *    codebase suggests.
 * 2. Every request signed for the JSON gateway is verified at the *gRPC*
 *    layer, not the HTTP layer (internal/pkg/auth/interceptor/signature.go
 *    pulls a `*message.GRPC` from context, never `*message.HTTP`, regardless
 *    of whether the request arrived via native gRPC or the grpc-gateway JSON
 *    translation). The signed payload is a JSON object
 *    `{ headers: {...}, method: "<plain gRPC method path>" }` — NOT the
 *    METHOD/URI/timestamp/bodyhash newline-joined string that message/http.go
 *    implies. `headers` must include exactly the keys in `includedHeaders`
 *    (payload.go), each set to `null` if the request doesn't carry that
 *    header, or the request's actual value if it does — verification does a
 *    Go `reflect.DeepEqual`, so a `[]` where the server sees absent (`nil`)
 *    fails just as hard as a wrong value.
 * 3. Headers must carry the `Grpc-Metadata-` prefix to survive grpc-gateway's
 *    default IncomingHeaderMatcher, which drops arbitrary custom headers
 *    that aren't on its small standard allowlist. Bare `x-sidero-timestamp`
 *    never reaches the gRPC layer at all.
 *
 * Also required: a `runtime: "Omni"` header/metadata entry (also
 * Grpc-Metadata-prefixed, also included in the signed payload's `headers`),
 * naming which of Omni's runtimes (Kubernetes/Talos/Omni) the ResourceService
 * call targets — internal/backend/grpc/resource.go rejects calls without it
 * ("missing runtime metadata"). ConfigPatch and MachineClass are both
 * Omni-native resources, so this is always "Omni" for this plugin.
 */
import * as openpgp from 'openpgp';

const SESSION_STORAGE_KEY = 'omni-manager.serviceAccountKey';
const SIGNATURE_VERSION = 'siderov1';

const TIMESTAMP_HEADER = 'x-sidero-timestamp';
const PAYLOAD_HEADER = 'x-sidero-payload';
const SIGNATURE_HEADER = 'x-sidero-signature';
const RUNTIME_HEADER = 'runtime';

/**
 * The full set of metadata keys the server's signature verification checks
 * for a payload/actual-request match (message/payload.go: includedHeaders).
 * Order doesn't matter for correctness (this is just used to build a map),
 * but every one of these keys must be present in the signed payload's
 * `headers` object, valued `null` when the request doesn't set it.
 */
const INCLUDED_HEADERS = [
  TIMESTAMP_HEADER,
  'nodes',
  'selectors',
  'fieldSelectors',
  'runtime',
  'context',
  'cluster',
  'namespace',
  'uid',
  'authorization',
] as const;

/** Shape of the base64-decoded OMNI_SERVICE_ACCOUNT_KEY JSON payload. */
interface ServiceAccountKeyJSON {
  name: string;
  pgp_key: string;
}

export interface OmniServiceAccount {
  /** Service account name, e.g. "automation". */
  name: string;
  /**
   * Identity sent in the Signature header — the raw short name, NOT
   * "<name>@serviceaccount.omni.sidero.dev". Confirmed both by testing (a
   * full-ID identity is rejected — the server can't find an account under a
   * name it doesn't recognize) and by reading the reference client
   * (go-api-signature/pkg/client/interceptor/interceptor.go:
   * `identity = i.serviceAccount.Name`). The `...@serviceaccount...` FullID()
   * form is constructed server-side only, after the signature already
   * verifies, for RBAC identity matching — it's never sent by the client.
   */
  identity: string;
  /** Parsed OpenPGP private key, ready to sign. */
  privateKey: openpgp.PrivateKey;
  /** Hex fingerprint of the key, sent in the Signature header. */
  fingerprint: string;
}

/**
 * Parses a pasted OMNI_SERVICE_ACCOUNT_KEY value (the exact string `omnictl
 * serviceaccount create` prints) into a ready-to-use signer.
 *
 * Encoding, verified against github.com/siderolabs/go-api-signature/pkg/serviceaccount:
 *   base64( JSON.stringify({ name, pgp_key: <armored private key> }) )
 */
export async function parseServiceAccountKey(rawValue: string): Promise<OmniServiceAccount> {
  const trimmed = rawValue.trim();

  let decodedJSON: string;
  try {
    decodedJSON = atob(trimmed);
  } catch {
    throw new Error('Service account key is not valid base64 — paste the value exactly as printed by `omnictl serviceaccount create`.');
  }

  let parsed: ServiceAccountKeyJSON;
  try {
    parsed = JSON.parse(decodedJSON);
  } catch {
    throw new Error('Service account key decoded but is not valid JSON — it may be truncated.');
  }

  if (!parsed.name || !parsed.pgp_key) {
    throw new Error('Service account key JSON is missing "name" or "pgp_key".');
  }

  const privateKey = await openpgp.readPrivateKey({ armoredKey: parsed.pgp_key });

  return {
    name: parsed.name,
    identity: parsed.name,
    privateKey,
    fingerprint: privateKey.getFingerprint(),
  };
}

/** Stores the raw pasted key string for the session (sessionStorage, not localStorage). */
export function storeServiceAccountKey(rawValue: string): void {
  sessionStorage.setItem(SESSION_STORAGE_KEY, rawValue.trim());
}

export function clearServiceAccountKey(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

/** Loads and parses the stored key, or null if none is set. */
export async function loadServiceAccount(): Promise<OmniServiceAccount | null> {
  const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  return parseServiceAccountKey(raw);
}

/**
 * Computes the full set of Grpc-Metadata-prefixed auth headers for one
 * ResourceService call, signed per the siderov1 scheme (see module doc).
 *
 * @param account - Parsed service account (see loadServiceAccount).
 * @param grpcMethod - The PLAIN gRPC method path, e.g.
 *   "/omni.resources.ResourceService/List" — NOT the "/api/"-prefixed HTTP
 *   path used for gateway routing. These are different strings serving
 *   different purposes; using the HTTP path here will fail verification.
 * @param extraHeaders - Additional includedHeaders entries this call needs
 *   beyond the timestamp, e.g. `{ runtime: ['Omni'] }` (always required for
 *   ResourceService calls against Omni-native resources).
 */
export async function signGRPCRequest(
  account: OmniServiceAccount,
  grpcMethod: string,
  extraHeaders: Partial<Record<(typeof INCLUDED_HEADERS)[number], string[]>> = {}
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const allHeaderValues: Partial<Record<(typeof INCLUDED_HEADERS)[number], string[]>> = {
    [TIMESTAMP_HEADER]: [timestamp],
    ...extraHeaders,
  };

  const headers: Record<string, string[] | null> = {};
  for (const key of INCLUDED_HEADERS) {
    headers[key] = allHeaderValues[key] ?? null;
  }

  const payloadJSON = JSON.stringify({ headers, method: grpcMethod });
  const payloadBytes = new TextEncoder().encode(payloadJSON);

  const message = await openpgp.createMessage({ binary: payloadBytes });
  const detachedSignature = (await openpgp.sign({
    message,
    signingKeys: account.privateKey,
    detached: true,
    format: 'binary',
    // openpgp.js injects a random salt notation into EdDSA signatures by
    // default (non-determinism as a fault-attack mitigation). Harmless for
    // verification either way, but disabled here for a smaller, simpler
    // payload while debugging server interop.
    config: { nonDeterministicSignaturesViaNotation: false },
  })) as Uint8Array;

  const signatureBase64 = uint8ArrayToBase64(detachedSignature);

  const result: Record<string, string> = {
    [grpcMetadataHeader(TIMESTAMP_HEADER)]: timestamp,
    [grpcMetadataHeader(PAYLOAD_HEADER)]: payloadJSON,
    [grpcMetadataHeader(SIGNATURE_HEADER)]: `${SIGNATURE_VERSION} ${account.identity} ${account.fingerprint} ${signatureBase64}`,
  };
  for (const [key, values] of Object.entries(extraHeaders)) {
    if (values && values.length > 0) {
      result[grpcMetadataHeader(key)] = values[0];
    }
  }

  return result;
}

/** Standard ResourceService call: always targets the "Omni" runtime. */
export async function signResourceServiceRequest(
  account: OmniServiceAccount,
  grpcMethod: string
): Promise<Record<string, string>> {
  return signGRPCRequest(account, grpcMethod, { [RUNTIME_HEADER]: ['Omni'] });
}

function grpcMetadataHeader(name: string): string {
  return `Grpc-Metadata-${name}`;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
