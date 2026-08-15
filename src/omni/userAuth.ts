/**
 * Per-user Auth0 + ECDSA authentication -- the SECOND, parallel signing path
 * alongside auth.ts's PGP/service-account one. This is exactly how Omni's
 * own first-party web UI already authenticates human users (verified
 * against a real, full clone of siderolabs/omni): Auth0 login produces an ID
 * token proving identity, a per-user non-extractable ECDSA P-256 WebCrypto
 * keypair is generated locally, its public half is registered via
 * AuthService.RegisterPublicKey (authService.ts) and then confirmed as
 * belonging to that identity via AuthService.ConfirmPublicKey (using the
 * Auth0 ID token as proof), and every ResourceService call afterward is
 * signed with that keypair instead of a PGP key. Unlike the PGP path, this
 * gives Omni a real per-user identity/audit trail (see design/TODOS.md).
 *
 * Mirrors, file-for-file:
 *  - frontend/src/methods/key.ts (createKeys / signDetached / key lifetime)
 *  - frontend/src/pages/authenticate.vue (the login + confirm sequence)
 *  - frontend/src/methods/interceptor.ts (the ECDSA request-signing scheme)
 *
 * Deliberately its OWN module, not auth.ts: auth.ts imports openpgp at
 * module scope, which crashes under this project's jsdom test environment
 * (see the note atop client.test.ts, and errors.ts's module doc). Keeping
 * this file free of that import is what makes its crypto/signing/PKCE logic
 * directly unit-testable (userAuth.test.ts) without the same
 * vi.mock('./auth') workaround client.test.ts needs. The wire-envelope
 * pieces shared with auth.ts's PGP scheme (header helpers, the
 * included-headers list) live in omniProxy.ts, which is openpgp-free and
 * already a shared dependency of both.
 *
 * Session storage uses IndexedDB, not sessionStorage (auth.ts's PGP path):
 * a non-extractable CryptoKeyPair has no string form by design (that's the
 * whole point of generating it non-extractable), so it can't go in
 * sessionStorage the way a pasted PGP key string can. IndexedDB natively
 * supports storing CryptoKey objects via the structured clone algorithm --
 * exactly what the real Omni frontend does too
 * (frontend/src/methods/key.ts's useIDBKeyval('keyPair', ...)).
 */
import { confirmPublicKey as confirmPublicKeyRPC, registerPublicKey } from './authService';
import { grpcMetadataHeader, INCLUDED_HEADERS, OmniEndpointConfig, uint8ArrayToBase64 } from './omniProxy';

// ---------------------------------------------------------------------------
// Wire-envelope constants (siderov1 scheme) -- INCLUDED_HEADERS/
// grpcMetadataHeader/uint8ArrayToBase64 are shared with auth.ts via
// omniProxy.ts (see that module's doc).
// ---------------------------------------------------------------------------

const SIGNATURE_VERSION = 'siderov1';
const TIMESTAMP_HEADER = 'x-sidero-timestamp';
const PAYLOAD_HEADER = 'x-sidero-payload';
const SIGNATURE_HEADER = 'x-sidero-signature';

function base64UrlEncode(bytes: Uint8Array): string {
  let base64 = uint8ArrayToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_');
  while (base64.endsWith('=')) {
    base64 = base64.slice(0, -1);
  }
  return base64;
}

// ---------------------------------------------------------------------------
// ECDSA keypair
// ---------------------------------------------------------------------------

/**
 * Generates a non-extractable ECDSA P-256 keypair, exactly as Omni's own
 * frontend does (frontend/src/methods/key.ts's createKeys) -- the private
 * key can only ever be used via crypto.subtle.sign, never exported. That's
 * the whole security property of registering it as a per-user credential:
 * even this plugin's own code can't extract it once created.
 */
export async function generateUserKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
}

/**
 * Exports the public half as a PEM-wrapped SPKI block, matching exactly what
 * AuthService.RegisterPublicKey expects in PublicKeyPlain.key_pem -- verified
 * against frontend/src/methods/key.ts's createKeys: base64 SPKI, wrapped at
 * 64 columns, "-----BEGIN/END PUBLIC KEY-----" framing.
 */
export async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const buffer = await crypto.subtle.exportKey('spki', publicKey);
  const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
  const wrapped = base64.match(/.{1,64}/g)?.join('\n') ?? base64;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

/** Signs `data` with the session's private key -- the ECDSA equivalent of auth.ts's openpgp.sign. */
export async function signDetachedECDSA(data: string, keyPair: CryptoKeyPair): Promise<Uint8Array<ArrayBuffer>> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

// ---------------------------------------------------------------------------
// Session type + IndexedDB storage
// ---------------------------------------------------------------------------

export interface OmniUserSession {
  /** Lowercased email -- the identity sent in the signature header and to RegisterPublicKey/ConfirmPublicKey. */
  identity: string;
  keyPair: CryptoKeyPair;
  /** Returned by AuthService.RegisterPublicKey; used as the signature header's "fingerprint" slot. */
  publicKeyId: string;
  /** Epoch ms. ~7h50m from registration, matching Omni's own frontend -- see createUserKeyPair. */
  keyExpirationTime: number;
  name?: string;
  picture?: string;
}

const IDB_DB_NAME = 'omni-manager';
const IDB_STORE_NAME = 'auth0-session';
const IDB_RECORD_KEY = 'session';

function openSessionDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE_NAME)) {
        request.result.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open the browser session database.'));
  });
}

/**
 * Persists the session (including the non-extractable CryptoKeyPair) to
 * IndexedDB. Tab-scoped in spirit but not in mechanism: unlike the PGP
 * path's sessionStorage (cleared the instant the tab closes), IndexedDB
 * persists across reloads and tabs until this key's own ~7h50m expiry (or
 * clearUserSession) -- matching the real Omni UI, where a page refresh
 * doesn't force a fresh Auth0 round trip within the key's lifetime.
 */
export async function storeUserSession(session: OmniUserSession): Promise<void> {
  const db = await openSessionDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).put(session, IDB_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store the Omni session.'));
    });
  } finally {
    db.close();
  }
}

/** Loads the stored session, or null if none exists. Does NOT check expiry -- see hasValidUserSession. */
export async function loadUserSession(): Promise<OmniUserSession | null> {
  let db: IDBDatabase;
  try {
    db = await openSessionDB();
  } catch {
    return null;
  }
  try {
    const record = await new Promise<OmniUserSession | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_STORE_NAME).get(IDB_RECORD_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to load the Omni session.'));
    });
    return record ?? null;
  } finally {
    db.close();
  }
}

/** True when a stored session exists AND its key hasn't passed its ~7h50m expiry. */
export async function hasValidUserSession(): Promise<boolean> {
  const session = await loadUserSession();
  return !!session && session.keyExpirationTime > Date.now();
}

export async function clearUserSession(): Promise<void> {
  const db = await openSessionDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).delete(IDB_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to clear the Omni session.'));
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// ECDSA request signing (ResourceService calls, once a session exists)
// ---------------------------------------------------------------------------

/**
 * Computes the Grpc-Metadata-prefixed auth headers for one ResourceService
 * call, signed with the session's ECDSA keypair. Same wire envelope as
 * auth.ts's signGRPCRequest (siderov1, x-sidero-* headers, a `{headers,
 * method}` JSON payload), including the same explicit null-fill for every
 * INCLUDED_HEADERS entry the request doesn't carry -- see auth.ts's
 * signGRPCRequest doc comment for why the server's reflect.DeepEqual-based
 * verification requires every key present.
 */
export async function signGRPCRequestECDSA(
  session: OmniUserSession,
  grpcMethod: string,
  extraHeaders: Partial<Record<(typeof INCLUDED_HEADERS)[number], string>> = {}
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const allValues: Partial<Record<(typeof INCLUDED_HEADERS)[number], string>> = {
    [TIMESTAMP_HEADER]: timestamp,
    ...extraHeaders,
  };

  const headers: Record<string, string[] | null> = {};
  for (const key of INCLUDED_HEADERS) {
    const value = allValues[key];
    headers[key] = value ? [value] : null;
  }

  const payloadJSON = JSON.stringify({ headers, method: grpcMethod });
  const signatureBytes = await signDetachedECDSA(payloadJSON, session.keyPair);
  const signatureBase64 = uint8ArrayToBase64(signatureBytes);

  const result: Record<string, string> = {
    [grpcMetadataHeader(TIMESTAMP_HEADER)]: timestamp,
    [grpcMetadataHeader(PAYLOAD_HEADER)]: payloadJSON,
    [grpcMetadataHeader(SIGNATURE_HEADER)]: `${SIGNATURE_VERSION} ${session.identity} ${session.publicKeyId} ${signatureBase64}`,
  };
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value) {
      result[grpcMetadataHeader(key)] = value;
    }
  }
  return result;
}

/** Standard ResourceService call: always targets the "Omni" runtime -- the ECDSA equivalent of auth.ts's signResourceServiceRequest. */
export async function signResourceServiceRequestECDSA(session: OmniUserSession, grpcMethod: string): Promise<Record<string, string>> {
  return signGRPCRequestECDSA(session, grpcMethod, { runtime: 'Omni' });
}

// ---------------------------------------------------------------------------
// Auth0 Authorization Code + PKCE flow
// ---------------------------------------------------------------------------

const SESSION_STORAGE_PKCE_VERIFIER = 'omni-manager.auth0PkceVerifier';
const SESSION_STORAGE_PKCE_STATE = 'omni-manager.auth0PkceState';
const SESSION_STORAGE_REDIRECT_URI = 'omni-manager.auth0RedirectUri';

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64UrlEncode(bytes);
}

/** RFC 7636 S256 code_challenge for a given code_verifier. */
export async function pkceCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export interface Auth0Config {
  domain: string;
  clientId: string;
}

/**
 * Starts the standard Auth0 SPA Authorization Code + PKCE redirect flow --
 * the same mechanism Omni's own frontend uses via @auth0/auth0-vue
 * (frontend/src/main.ts's createAuth0), reimplemented directly against
 * Auth0's plain HTTP endpoints instead of pulling in the SDK. This is ~40
 * lines of standard OAuth2 PKCE (RFC 7636); not enough surface to justify a
 * new npm dependency in a project whose build already has real npm/rollup
 * friction (see CLAUDE.md's environment notes) -- the same "no new
 * dependency needed" reasoning the design brief calls out for the WebCrypto
 * keypair applies here too.
 *
 * `redirect_uri` is the CURRENT page (origin + pathname), not just
 * `window.location.origin` like the real Omni frontend uses. Omni's own app
 * owns its whole origin and can route '/' to its dedicated Authenticate page
 * for any post-login destination; a Headlamp plugin only owns specific
 * routes within Headlamp's larger SPA, so the callback has to land back on
 * the exact route that started the flow for ConnectPrompt to still be
 * mounted there to catch it.
 *
 * OPERATIONAL CONSEQUENCE (not something this code can route around): the
 * Omni Auth0 application's Allowed Callback URLs (and Allowed Web Origins)
 * must include this exact origin+path for every plugin route ConnectPrompt
 * can render from (today: the Config Patches and Machine Classes list
 * pages). See ConnectPrompt.tsx's UI copy and the PR description.
 */
export async function startAuth0Login(config: Auth0Config): Promise<void> {
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(16);
  const challenge = await pkceCodeChallenge(verifier);
  const redirectUri = window.location.origin + window.location.pathname;

  sessionStorage.setItem(SESSION_STORAGE_PKCE_VERIFIER, verifier);
  sessionStorage.setItem(SESSION_STORAGE_PKCE_STATE, state);
  sessionStorage.setItem(SESSION_STORAGE_REDIRECT_URI, redirectUri);

  const url = new URL(`https://${config.domain}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  window.location.assign(url.toString());
}

/** True when the current URL is an Auth0 redirect-back carrying an authorization code. */
export function isAuth0Callback(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('code') && params.has('state');
}

export interface Auth0Identity {
  idToken: string;
  email: string;
  name?: string;
  picture?: string;
}

/** Decodes (does NOT verify) a JWT's payload segment -- see completeAuth0Login's doc comment on why that's fine here. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Not a valid JWT.');
  }
  const base64 = parts[1].replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const json = atob(padded);
  return JSON.parse(json);
}

/**
 * Completes the PKCE flow after Auth0 redirects back: validates `state`,
 * exchanges the authorization `code` for tokens, and decodes the identity
 * out of the returned ID token (a standard OIDC id_token JWT). Decoded
 * client-side only for display and for RegisterPublicKey's identity.email --
 * Omni's own backend independently verifies that same token's signature
 * server-side when ConfirmPublicKey is called with it as a Bearer header
 * (see authService.ts), so nothing security-relevant depends on this
 * client-side decode being trustworthy.
 *
 * Clears code/state from the visible URL regardless of outcome, so a page
 * refresh never re-attempts redeeming the same one-time-use code.
 */
export async function completeAuth0Login(config: Auth0Config): Promise<Auth0Identity> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');

  const expectedState = sessionStorage.getItem(SESSION_STORAGE_PKCE_STATE);
  const verifier = sessionStorage.getItem(SESSION_STORAGE_PKCE_VERIFIER);
  const redirectUri = sessionStorage.getItem(SESSION_STORAGE_REDIRECT_URI);

  sessionStorage.removeItem(SESSION_STORAGE_PKCE_STATE);
  sessionStorage.removeItem(SESSION_STORAGE_PKCE_VERIFIER);
  sessionStorage.removeItem(SESSION_STORAGE_REDIRECT_URI);

  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);

  if (!code || !state || !verifier || !redirectUri) {
    throw new Error('Auth0 login is missing its callback parameters — start the login again.');
  }
  if (state !== expectedState) {
    throw new Error(
      'Auth0 login state did not match — start the login again (this can happen if a login was started in another tab).'
    );
  }

  const tokenResponse = await fetch(`https://${config.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const bodyText = await tokenResponse.text().catch(() => '');
    throw new Error(`Auth0 token exchange failed (${tokenResponse.status}): ${bodyText || tokenResponse.statusText}`);
  }

  const tokenBody = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenBody.id_token) {
    throw new Error('Auth0 token response did not include an id_token.');
  }

  const claims = decodeJwtPayload(tokenBody.id_token);
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  if (!email) {
    throw new Error('Auth0 identity token did not include an email claim.');
  }

  return {
    idToken: tokenBody.id_token,
    email,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    picture: typeof claims.picture === 'string' ? claims.picture : undefined,
  };
}

// ---------------------------------------------------------------------------
// Key registration + confirmation orchestration
// ---------------------------------------------------------------------------

/** ~7h50m per-key lifetime, matching Omni's own frontend exactly (frontend/src/methods/key.ts's createKeys). */
export const USER_KEY_LIFETIME_MS = (7 * 60 + 50) * 60 * 1000;

export interface PendingUserKey {
  keyPair: CryptoKeyPair;
  publicKeyId: string;
  keyExpirationTime: number;
}

/**
 * Generates a fresh ECDSA keypair and registers its public half for
 * `identity` -- mirrors frontend/src/methods/key.ts's createKeys. The
 * returned key is registered but UNCONFIRMED and not yet usable for signing;
 * callers must still call confirmAndStoreUserSession with the Auth0 ID token
 * (see that function's doc comment) before it's a valid session.
 */
export async function createUserKeyPair(config: OmniEndpointConfig, identity: string): Promise<PendingUserKey> {
  const email = identity.toLowerCase();
  const keyPair = await generateUserKeyPair();
  const keyPem = await exportPublicKeyPem(keyPair.publicKey);
  const now = new Date();
  const keyExpirationTime = now.getTime() + USER_KEY_LIFETIME_MS;

  const response = await registerPublicKey(config, {
    public_key: {
      plain_key: {
        key_pem: keyPem,
        not_before: now.toISOString(),
        not_after: new Date(keyExpirationTime).toISOString(),
      },
    },
    identity: { email },
  });

  return { keyPair, publicKeyId: response.public_key_id, keyExpirationTime };
}

/**
 * Proves ownership of the Auth0 identity for a pending, just-registered
 * public key (mirrors authenticate.vue's confirmPublicKey call), then
 * persists the resulting session to IndexedDB. Throws if confirmation fails
 * (e.g. the Auth0 token expired between RegisterPublicKey and this call) --
 * callers should surface that and let the user retry the whole login rather
 * than silently leaving an unconfirmed, unusable key registered server-side.
 */
export async function confirmAndStoreUserSession(
  config: OmniEndpointConfig,
  pending: PendingUserKey,
  identity: Auth0Identity
): Promise<OmniUserSession> {
  await confirmPublicKeyRPC(config, pending.publicKeyId, identity.idToken);

  const session: OmniUserSession = {
    identity: identity.email.toLowerCase(),
    keyPair: pending.keyPair,
    publicKeyId: pending.publicKeyId,
    keyExpirationTime: pending.keyExpirationTime,
    name: identity.name,
    picture: identity.picture,
  };
  await storeUserSession(session);
  return session;
}
