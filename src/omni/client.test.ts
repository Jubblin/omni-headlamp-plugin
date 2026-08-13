// client.ts pulls in auth.ts -> openpgp for its network-calling functions
// (unused by the pure functions tested here). openpgp's Node build crashes
// at import time under this project's jsdom test environment -- jsdom's
// realm has its own Uint8Array distinct from Node's, and openpgp's internal
// isUint8Array check fails a strict instanceof/prototype comparison against
// it (a real jsdom + binary-library interaction, not a bug in this plugin).
// Mocking auth.ts out entirely avoids ever executing that import, which is
// also just correct test hygiene -- these tests exercise none of its logic.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  loadServiceAccount: vi.fn(),
  signResourceServiceRequest: vi.fn(),
}));

import { formatUpdated, isNetworkLevelFailure, OmniConnectionError } from './client';

describe('OmniConnectionError', () => {
  it('prefixes the cause message', () => {
    const err = new OmniConnectionError(new Error('boom'));
    expect(err.message).toBe('Could not reach Omni: boom');
  });

  it('stringifies a non-Error cause', () => {
    const err = new OmniConnectionError('plain string cause');
    expect(err.message).toBe('Could not reach Omni: plain string cause');
  });

  it('extracts a numeric .status from the cause when present', () => {
    const err = new OmniConnectionError({ status: 409, message: 'conflict' });
    expect(err.status).toBe(409);
  });

  it('leaves .status undefined when the cause has none', () => {
    const err = new OmniConnectionError(new Error('no status here'));
    expect(err.status).toBeUndefined();
  });

  it('leaves .status undefined when the cause has a non-numeric status', () => {
    const err = new OmniConnectionError({ status: '409' });
    expect(err.status).toBeUndefined();
  });

  describe('fromGRPCGatewayError', () => {
    it('maps gRPC code 6 (AlreadyExists / conflict) to HTTP 409', () => {
      const err = OmniConnectionError.fromGRPCGatewayError({ code: 6, message: 'update conflict: expected version 1' });
      expect(err.status).toBe(409);
      expect(err.message).toBe('Could not reach Omni: update conflict: expected version 1');
    });

    it('maps gRPC code 5 (NotFound) to HTTP 404', () => {
      const err = OmniConnectionError.fromGRPCGatewayError({ code: 5, message: 'not found' });
      expect(err.status).toBe(404);
    });

    it('maps gRPC code 16 (Unauthenticated) to HTTP 401', () => {
      const err = OmniConnectionError.fromGRPCGatewayError({ code: 16, message: 'invalid signature' });
      expect(err.status).toBe(401);
    });

    it('leaves .status undefined for an unmapped gRPC code', () => {
      const err = OmniConnectionError.fromGRPCGatewayError({ code: 999, message: 'mystery code' });
      expect(err.status).toBeUndefined();
    });
  });
});

describe('isNetworkLevelFailure', () => {
  it('treats a non-OmniConnectionError as a network-level failure', () => {
    expect(isNetworkLevelFailure(new Error('some other error'))).toBe(true);
    expect(isNetworkLevelFailure('a plain string')).toBe(true);
    expect(isNetworkLevelFailure(undefined)).toBe(true);
  });

  it('treats an OmniConnectionError with no status as a network-level failure', () => {
    const err = new OmniConnectionError(new Error('dropped'));
    expect(err.status).toBeUndefined();
    expect(isNetworkLevelFailure(err)).toBe(true);
  });

  it('treats HTTP 502 (synthesized "Unreachable") as a network-level failure', () => {
    const err = new OmniConnectionError({ status: 502 });
    expect(isNetworkLevelFailure(err)).toBe(true);
  });

  it('treats HTTP 408 (synthesized timeout) as a network-level failure', () => {
    const err = new OmniConnectionError({ status: 408 });
    expect(isNetworkLevelFailure(err)).toBe(true);
  });

  it('does not treat a real 409 conflict as a network-level failure', () => {
    const err = new OmniConnectionError({ status: 409 });
    expect(isNetworkLevelFailure(err)).toBe(false);
  });

  it('does not treat a real 404 as a network-level failure', () => {
    const err = new OmniConnectionError({ status: 404 });
    expect(isNetworkLevelFailure(err)).toBe(false);
  });

  it('does not treat a real 401 as a network-level failure', () => {
    const err = new OmniConnectionError({ status: 401 });
    expect(isNetworkLevelFailure(err)).toBe(false);
  });
});

describe('formatUpdated', () => {
  it('returns a real timestamp unchanged', () => {
    expect(formatUpdated('2026-08-12T17:25:57Z')).toBe('2026-08-12T17:25:57Z');
  });

  it('centers a placeholder for undefined', () => {
    const result = formatUpdated(undefined) as any;
    expect(result.type).toBe('span');
    expect(result.props.style).toMatchObject({ display: 'block', textAlign: 'center' });
    expect(result.props.children).toBe('—');
  });

  it('centers a placeholder for an empty string', () => {
    const result = formatUpdated('') as any;
    expect(result.type).toBe('span');
    expect(result.props.children).toBe('—');
  });

  it('centers a placeholder for the Go zero-time sentinel', () => {
    const result = formatUpdated('0001-01-01T00:00:00Z') as any;
    expect(result.type).toBe('span');
    expect(result.props.children).toBe('—');
  });

  it('centers a placeholder for the Unix epoch-zero sentinel', () => {
    const result = formatUpdated('1970-01-01T00:00:00Z') as any;
    expect(result.type).toBe('span');
    expect(result.props.children).toBe('—');
  });
});
