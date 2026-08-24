/**
 * GitHub Contents API client for loading ConfigPatch files from a repo --
 * see docs/designs/github-configpatch-loading.md for the full design.
 *
 * Deliberately separate from client.ts/omniProxy.ts: GitHub's API supports
 * real browser CORS (Access-Control-Allow-Origin: *), unlike Omni's
 * self-signed/proxied endpoint, so this calls fetch() directly rather than
 * routing through Headlamp's ApiProxy -- see the design doc's Engineering
 * Decisions for why. The PAT is stored the same way as the Omni service
 * account key (auth.ts): sessionStorage only, per-tab, never persisted.
 */

const SESSION_STORAGE_KEY = 'omni-manager.githubToken';
const API_BASE = 'https://api.github.com';

export type GitHubErrorKind =
  | 'access-denied'
  | 'not-found'
  | 'rate-limited'
  | 'file-too-large'
  | 'malformed-content'
  | 'network';

export class GitHubError extends Error {
  kind: GitHubErrorKind;

  constructor(kind: GitHubErrorKind, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
  }
}

/** Stores the raw pasted PAT for the session (sessionStorage, not localStorage) -- mirrors auth.ts. */
export function storeGithubToken(rawValue: string): void {
  sessionStorage.setItem(SESSION_STORAGE_KEY, rawValue.trim());
}

export function clearGithubToken(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

export function loadGithubToken(): string | null {
  return sessionStorage.getItem(SESSION_STORAGE_KEY);
}

export interface GithubPatchesLocation {
  owner: string;
  repo: string;
  /** Empty string means repo root. */
  path: string;
}

/**
 * Parses the `githubPatchesPath` setting: "owner/repo" or
 * "owner/repo/path/to/patches". GitHub owner/repo names can't contain "/",
 * so splitting on the first two segments is unambiguous regardless of how
 * many slashes the path itself has.
 */
export function parsePatchesPath(raw: string): GithubPatchesLocation | { error: string } {
  const segments = raw.trim().split('/').filter(Boolean);
  if (segments.length < 2) {
    return { error: 'Expected "owner/repo" or "owner/repo/path/to/patches".' };
  }
  const [owner, repo, ...pathParts] = segments;
  return { owner, repo, path: pathParts.join('/') };
}

/** Builds the pre-filled GitHub template URL for creating a scoped fine-grained PAT -- see design doc's User Journey section. */
export function buildTokenCreationUrl(owner: string): string {
  const params = new URLSearchParams({
    name: 'omni-headlamp-plugin',
    description: 'Read-only access for ConfigPatch loading',
    target_name: owner,
    contents: 'read',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

export interface GithubFile {
  name: string;
  path: string;
  size: number;
}

interface GithubContentsEntry {
  name: string;
  path: string;
  type: string;
  size: number;
}

async function githubFetch(path: string, token: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
  } catch (err) {
    throw new GitHubError('network', `Couldn't reach GitHub: ${String(err)}`);
  }

  if (response.status === 404) {
    throw new GitHubError('not-found', "Couldn't find that repository or path on GitHub.");
  }
  if (response.status === 403) {
    // GitHub's rate-limit response carries this header set to 0; a plain
    // access-denied 403 doesn't -- see design doc's Error Handling section.
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError('rate-limited', 'Rate limited by GitHub — try again in a moment.');
    }
    throw new GitHubError(
      'access-denied',
      "Access denied — check your token's repo access and permissions."
    );
  }
  if (response.status === 401) {
    throw new GitHubError('access-denied', 'Invalid or expired token.');
  }
  return response;
}

/** Lists .yaml/.yml files in one directory (non-recursive) -- see design doc's "flat picker" decision. */
export async function listPatchFiles(
  token: string,
  location: GithubPatchesLocation
): Promise<GithubFile[]> {
  const response = await githubFetch(
    `/repos/${location.owner}/${location.repo}/contents/${location.path}`,
    token
  );
  const entries = (await response.json()) as GithubContentsEntry[] | GithubContentsEntry;
  const list = Array.isArray(entries) ? entries : [entries];
  return list
    .filter(entry => entry.type === 'file' && /\.ya?ml$/.test(entry.name))
    .map(entry => ({ name: entry.name, path: entry.path, size: entry.size }));
}

/** Fetches and decodes one file's content. Throws 'file-too-large' for anything over the Contents API's 1MB ceiling. */
export async function fetchFileContent(
  token: string,
  location: GithubPatchesLocation,
  filePath: string
): Promise<string> {
  const response = await githubFetch(
    `/repos/${location.owner}/${location.repo}/contents/${filePath}`,
    token
  );
  const body = (await response.json()) as { content?: string; encoding?: string; size?: number };
  if (body.content === undefined || body.content === null) {
    throw new GitHubError(
      'file-too-large',
      "This file is too large to load (over GitHub's 1MB limit for this API)."
    );
  }
  try {
    return atob(body.content.replace(/\n/g, ''));
  } catch {
    throw new GitHubError('malformed-content', "Couldn't read this file's content from GitHub.");
  }
}
