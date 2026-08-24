// Same auth.ts/openpgp and ConfigStore mocking as ClusterCreate.test.tsx.
// @monaco-editor/react's DiffEditor is mocked out entirely -- it needs a
// real browser Monaco worker environment jsdom can't provide, and none of
// these tests exercise in-editor typing (that's the pre-existing diff/apply
// machinery in ResourceDetail.tsx, untouched by this change; the only new
// surface here is the "Load from GitHub" wiring, which calls onLoad
// directly rather than through Monaco).
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  loadServiceAccount: vi.fn(),
  signResourceServiceRequest: vi.fn(),
}));

const configGetMock = vi.fn();
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn() },
  ConfigStore: class {
    get() {
      return configGetMock();
    }
  },
}));

const getResourceMock = vi.fn();
vi.mock('./client', async importOriginal => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, getResource: (...args: unknown[]) => getResourceMock(...args) };
});

const listPatchFilesMock = vi.fn();
const fetchFileContentMock = vi.fn();
vi.mock('./github', async importOriginal => {
  const actual = await importOriginal<typeof import('./github')>();
  return {
    ...actual,
    listPatchFiles: (...args: unknown[]) => listPatchFilesMock(...args),
    fetchFileContent: (...args: unknown[]) => fetchFileContentMock(...args),
  };
});

let lastModified = '';
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ modified }: { modified: string }) => {
    lastModified = modified;
    return <div data-testid="diff-editor-stub">{modified}</div>;
  },
}));

import { ConfigPatchDetail } from './ConfigPatchDetail';
import { clearGithubToken, storeGithubToken } from './github';

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/omni/config-patches/my-patch']}>
      <Route path="/omni/config-patches/:id">
        <ConfigPatchDetail />
      </Route>
    </MemoryRouter>
  );
}

describe('ConfigPatchDetail', () => {
  beforeEach(() => {
    configGetMock.mockReturnValue({
      endpoint: 'https://omni.example.com',
      githubPatchesPath: 'octo/patches-repo',
    });
    getResourceMock.mockResolvedValue({
      metadata: {
        namespace: 'default',
        type: 'ConfigPatches.omni.sidero.dev',
        id: 'my-patch',
        version: 1,
        owner: '',
        phase: 'ready',
      },
      spec: { data: 'replicas: 1\n' },
    });
  });
  afterEach(() => {
    clearGithubToken();
    vi.clearAllMocks();
    lastModified = '';
  });

  it('renders the existing Apply/Delete actions alongside the new Load from GitHub action (no regression)', async () => {
    renderDetail();
    expect(await screen.findByRole('button', { name: /^apply$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load from github/i })).toBeInTheDocument();
  });

  it('loads GitHub content into the diff editor and shows the not-a-live-sync confirmation', async () => {
    storeGithubToken('ghp_existing');
    listPatchFilesMock.mockResolvedValue([{ name: 'prod.yaml', path: 'prod.yaml', size: 12 }]);
    fetchFileContentMock.mockResolvedValue('replicas: 5\n');

    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('button', { name: /^apply$/i });

    await user.click(screen.getByRole('button', { name: /load from github/i }));
    await user.click(await screen.findByText('prod.yaml'));

    expect(
      await screen.findByText(/Loaded prod\.yaml from octo\/patches-repo/i)
    ).toBeInTheDocument();
    expect(lastModified).toBe('replicas: 5\n');
  });
});
