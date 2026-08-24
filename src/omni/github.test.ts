import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTokenCreationUrl,
  clearGithubToken,
  fetchFileContent,
  GitHubError,
  listPatchFiles,
  loadGithubToken,
  parsePatchesPath,
  storeGithubToken,
} from './github';

const LOCATION = { owner: 'octo', repo: 'patches-repo', path: 'clusters/prod' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('parsePatchesPath', () => {
  it('rejects an empty string', () => {
    const result = parsePatchesPath('');
    expect(result).toHaveProperty('error');
  });

  it('rejects a single segment (no repo)', () => {
    const result = parsePatchesPath('owner');
    expect(result).toHaveProperty('error');
  });

  it('parses "owner/repo" as repo root', () => {
    expect(parsePatchesPath('owner/repo')).toEqual({ owner: 'owner', repo: 'repo', path: '' });
  });

  it('parses "owner/repo/a/b/c" with the path rejoined regardless of slash count', () => {
    expect(parsePatchesPath('owner/repo/a/b/c')).toEqual({
      owner: 'owner',
      repo: 'repo',
      path: 'a/b/c',
    });
  });
});

describe('buildTokenCreationUrl', () => {
  it('pre-fills name, description, target_name, and read-only contents scope', () => {
    const url = buildTokenCreationUrl('octo');
    expect(url).toContain('https://github.com/settings/personal-access-tokens/new?');
    expect(url).toContain('target_name=octo');
    expect(url).toContain('contents=read');
  });
});

describe('token storage (sessionStorage)', () => {
  afterEach(() => clearGithubToken());

  it('round-trips a stored token', () => {
    expect(loadGithubToken()).toBeNull();
    storeGithubToken('  ghp_abc123  ');
    expect(loadGithubToken()).toBe('ghp_abc123');
  });

  it('clears the stored token', () => {
    storeGithubToken('ghp_abc123');
    clearGithubToken();
    expect(loadGithubToken()).toBeNull();
  });
});

describe('listPatchFiles', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('filters to .yaml/.yml files and excludes directories', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, [
        { name: 'a.yaml', path: 'clusters/prod/a.yaml', type: 'file', size: 10 },
        { name: 'b.yml', path: 'clusters/prod/b.yml', type: 'file', size: 20 },
        { name: 'readme.md', path: 'clusters/prod/readme.md', type: 'file', size: 5 },
        { name: 'subdir', path: 'clusters/prod/subdir', type: 'dir', size: 0 },
      ])
    );
    const files = await listPatchFiles('tok', LOCATION);
    expect(files).toEqual([
      { name: 'a.yaml', path: 'clusters/prod/a.yaml', size: 10 },
      { name: 'b.yml', path: 'clusters/prod/b.yml', size: 20 },
    ]);
  });

  it('throws not-found on a 404', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, {}));
    await expect(listPatchFiles('tok', LOCATION)).rejects.toMatchObject({
      kind: 'not-found',
    } as Partial<GitHubError>);
  });

  it('throws access-denied on a 401', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, {}));
    await expect(listPatchFiles('tok', LOCATION)).rejects.toMatchObject({
      kind: 'access-denied',
    } as Partial<GitHubError>);
  });

  it('throws access-denied on a plain 403 (no rate-limit header)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, {}));
    await expect(listPatchFiles('tok', LOCATION)).rejects.toMatchObject({
      kind: 'access-denied',
    } as Partial<GitHubError>);
  });

  it('distinguishes rate-limited from access-denied via x-ratelimit-remaining', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, {}, { 'x-ratelimit-remaining': '0' }));
    await expect(listPatchFiles('tok', LOCATION)).rejects.toMatchObject({
      kind: 'rate-limited',
    } as Partial<GitHubError>);
  });

  it('throws a network GitHubError when fetch itself rejects', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(listPatchFiles('tok', LOCATION)).rejects.toMatchObject({
      kind: 'network',
    } as Partial<GitHubError>);
  });
});

describe('fetchFileContent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('base64-decodes the file content', async () => {
    const content = btoa('replicas: 3\n');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { content, encoding: 'base64' }));
    const text = await fetchFileContent('tok', LOCATION, 'clusters/prod/a.yaml');
    expect(text).toBe('replicas: 3\n');
  });

  it('strips embedded newlines from the base64 payload (as GitHub sends it, line-wrapped)', async () => {
    const raw = btoa('replicas: 3\nname: prod\n');
    const wrapped = `${raw.slice(0, 20)}\n${raw.slice(20)}`;
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { content: wrapped, encoding: 'base64' }));
    const text = await fetchFileContent('tok', LOCATION, 'clusters/prod/a.yaml');
    expect(text).toBe('replicas: 3\nname: prod\n');
  });

  it('throws file-too-large when content is missing (over the 1MB Contents API ceiling)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { size: 5_000_000 }));
    await expect(fetchFileContent('tok', LOCATION, 'clusters/prod/big.yaml')).rejects.toMatchObject(
      { kind: 'file-too-large' } as Partial<GitHubError>
    );
  });

  it('throws malformed-content on invalid base64 rather than an unhandled exception', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { content: 'not-valid-base64!!!', encoding: 'base64' })
    );
    await expect(fetchFileContent('tok', LOCATION, 'clusters/prod/a.yaml')).rejects.toMatchObject({
      kind: 'malformed-content',
    } as Partial<GitHubError>);
  });
});
