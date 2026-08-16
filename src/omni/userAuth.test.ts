// userAuth.ts is deliberately free of auth.ts's openpgp import (see its
// module doc), so unlike client.test.ts this file needs no vi.mock('./auth')
// workaround -- these tests exercise the real crypto/PKCE/signing logic
// directly, including real crypto.subtle calls (Node's WebCrypto global,
// available under this project's jsdom test environment same as in a real
// browser).
import { describe, expect, it } from 'vitest';
import {
  decodeJwtPayload,
  exportPublicKeyPem,
  generateUserKeyPair,
  OmniUserSession,
  pkceCodeChallenge,
  signDetachedECDSA,
  signGRPCRequestECDSA,
  signResourceServiceRequestECDSA,
} from './userAuth';

describe('pkceCodeChallenge', () => {
  it('matches the RFC 7636 Appendix B test vector', async () => {
    // https://www.rfc-editor.org/rfc/rfc7636#appendix-B
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await pkceCodeChallenge(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is base64url, not base64 (no +, /, or = padding)', async () => {
    const challenge = await pkceCodeChallenge('some-other-verifier-value-1234567890');
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe('decodeJwtPayload', () => {
  function fakeJwt(payload: Record<string, unknown>): string {
    const base64url = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url(payload)}.fake-signature`;
  }

  it('decodes a well-formed JWT payload', () => {
    const jwt = fakeJwt({
      email: 'alice@example.com',
      name: 'Alice',
      picture: 'https://example.com/a.png',
    });
    const claims = decodeJwtPayload(jwt);
    expect(claims).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice',
      picture: 'https://example.com/a.png',
    });
  });

  it('handles base64url payloads needing padding restoration', () => {
    // A payload whose base64url form has no trailing '=' naturally exercises
    // the common case; this one is chosen to need one padding char back.
    const jwt = fakeJwt({ email: 'x@example.com' });
    expect(() => decodeJwtPayload(jwt)).not.toThrow();
  });

  it('throws on a string with the wrong number of segments', () => {
    expect(() => decodeJwtPayload('not.a.jwt.at.all')).toThrow('Not a valid JWT.');
    expect(() => decodeJwtPayload('onlyonepart')).toThrow('Not a valid JWT.');
  });
});

describe('ECDSA keypair + signing', () => {
  it('generates a non-extractable P-256 keypair', async () => {
    const keyPair = await generateUserKeyPair();
    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(keyPair.publicKey.usages).toContain('verify');
  });

  it('exports the public key as a 64-column-wrapped PEM block', async () => {
    const keyPair = await generateUserKeyPair();
    const pem = await exportPublicKeyPem(keyPair.publicKey);

    expect(pem.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
    expect(pem.endsWith('\n-----END PUBLIC KEY-----')).toBe(true);

    const body = pem
      .replace('-----BEGIN PUBLIC KEY-----\n', '')
      .replace('\n-----END PUBLIC KEY-----', '');
    for (const line of body.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(64);
    }
    // Round-trips back to valid base64 DER that WebCrypto itself accepts.
    const der = Uint8Array.from(atob(body.replace(/\n/g, '')), c => c.charCodeAt(0));
    await expect(
      crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    ).resolves.toBeTruthy();
  });

  it('produces a signature that verifies against the exported public key', async () => {
    const keyPair = await generateUserKeyPair();
    const data = 'the exact payload string that would be signed';
    const signature = await signDetachedECDSA(data, keyPair);

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      signature,
      new TextEncoder().encode(data)
    );
    expect(valid).toBe(true);
  });

  it('a signature does not verify against a different message', async () => {
    const keyPair = await generateUserKeyPair();
    const signature = await signDetachedECDSA('original message', keyPair);

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      signature,
      new TextEncoder().encode('tampered message')
    );
    expect(valid).toBe(false);
  });
});

describe('signGRPCRequestECDSA / signResourceServiceRequestECDSA', () => {
  async function fakeSession(): Promise<OmniUserSession> {
    const keyPair = await generateUserKeyPair();
    return {
      identity: 'alice@example.com',
      keyPair,
      publicKeyId: 'deadbeef-fingerprint',
      keyExpirationTime: Date.now() + 1000 * 60 * 60,
    };
  }

  it('produces the Grpc-Metadata-prefixed x-sidero-* headers', async () => {
    const session = await fakeSession();
    const headers = await signGRPCRequestECDSA(session, '/omni.resources.ResourceService/List');

    expect(Object.keys(headers).sort()).toEqual(
      [
        'Grpc-Metadata-x-sidero-payload',
        'Grpc-Metadata-x-sidero-signature',
        'Grpc-Metadata-x-sidero-timestamp',
      ].sort()
    );
    expect(headers['Grpc-Metadata-x-sidero-timestamp']).toMatch(/^\d+$/);
  });

  it('the signature header is "siderov1 <identity> <publicKeyId> <base64>"', async () => {
    const session = await fakeSession();
    const headers = await signGRPCRequestECDSA(session, '/omni.resources.ResourceService/List');

    const parts = headers['Grpc-Metadata-x-sidero-signature'].split(' ');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('siderov1');
    expect(parts[1]).toBe(session.identity);
    expect(parts[2]).toBe(session.publicKeyId);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it('the payload header is {headers, method} JSON, method matching the unprefixed gRPC path', async () => {
    const session = await fakeSession();
    const grpcMethod = '/omni.resources.ResourceService/Get';
    const headers = await signGRPCRequestECDSA(session, grpcMethod, { runtime: 'Omni' });

    const payload = JSON.parse(headers['Grpc-Metadata-x-sidero-payload']);
    expect(payload.method).toBe(grpcMethod);
    expect(payload.headers.runtime).toEqual(['Omni']);
    expect(payload.headers['x-sidero-timestamp']).toEqual([
      headers['Grpc-Metadata-x-sidero-timestamp'],
    ]);
    // Headers with no value are still present, null-filled -- matching
    // auth.ts's PGP scheme (see that module's doc for why the server's
    // reflect.DeepEqual-based verification requires every key present).
    expect(payload.headers.namespace).toBeNull();
  });

  it('the signature is a real, independently verifiable ECDSA signature over the exact payload bytes', async () => {
    const session = await fakeSession();
    const headers = await signGRPCRequestECDSA(session, '/omni.resources.ResourceService/List');

    const payloadJSON = headers['Grpc-Metadata-x-sidero-payload'];
    const signatureBase64 = headers['Grpc-Metadata-x-sidero-signature'].split(' ')[3];
    const signatureBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      session.keyPair.publicKey,
      signatureBytes,
      new TextEncoder().encode(payloadJSON)
    );
    expect(valid).toBe(true);
  });

  it('signResourceServiceRequestECDSA always sets runtime=Omni', async () => {
    const session = await fakeSession();
    const headers = await signResourceServiceRequestECDSA(
      session,
      '/omni.resources.ResourceService/List'
    );
    expect(headers['Grpc-Metadata-runtime']).toBe('Omni');

    const payload = JSON.parse(headers['Grpc-Metadata-x-sidero-payload']);
    expect(payload.headers.runtime).toEqual(['Omni']);
  });
});
