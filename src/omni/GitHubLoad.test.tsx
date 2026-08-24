// Same ConfigStore-needs-Headlamp's-Redux-store issue as ClusterCreate.test.tsx --
// mocked out for the same reason.
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configGetMock = vi.fn();
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ConfigStore: class {
    get() {
      return configGetMock();
    }
  },
}));

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

import { clearGithubToken, GitHubError, storeGithubToken } from './github';
import { GitHubLoad } from './GitHubLoad';

function renderLoad(
  props: Partial<{ dirty: boolean; onLoad: (text: string, label: string) => void }> = {}
) {
  const onLoad = props.onLoad ?? vi.fn();
  render(<GitHubLoad dirty={props.dirty ?? false} onLoad={onLoad} />);
  return { onLoad };
}

describe('GitHubLoad', () => {
  beforeEach(() => {
    configGetMock.mockReturnValue({ githubPatchesPath: 'octo/patches-repo/clusters/prod' });
  });
  afterEach(() => {
    clearGithubToken();
    vi.clearAllMocks();
  });

  it('shows a settings error when no GitHub patches path is configured', async () => {
    configGetMock.mockReturnValue({});
    const user = userEvent.setup();
    renderLoad();
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    expect(await screen.findByText(/No GitHub repo configured yet/i)).toBeInTheDocument();
  });

  it('shows the PAT dialog when no token is stored yet', async () => {
    const user = userEvent.setup();
    renderLoad();
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    expect(await screen.findByText('Connect to GitHub')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /create one scoped to octo\/patches-repo/i })
    ).toHaveAttribute('href', expect.stringContaining('target_name=octo'));
  });

  it('skips the PAT dialog and lists files directly when a token is already stored', async () => {
    storeGithubToken('ghp_existing');
    listPatchFilesMock.mockResolvedValue([
      { name: 'a.yaml', path: 'clusters/prod/a.yaml', size: 10 },
    ]);
    const user = userEvent.setup();
    renderLoad();
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    expect(await screen.findByText('a.yaml')).toBeInTheDocument();
    expect(screen.queryByText('Connect to GitHub')).not.toBeInTheDocument();
  });

  it('stores the pasted token and proceeds to the file picker', async () => {
    listPatchFilesMock.mockResolvedValue([]);
    const user = userEvent.setup();
    renderLoad();
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    await user.type(screen.getByLabelText(/personal access token/i), 'ghp_newtoken');
    await user.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(await screen.findByText(/No \.yaml\/\.yml files found/i)).toBeInTheDocument();
    expect(listPatchFilesMock).toHaveBeenCalledWith('ghp_newtoken', {
      owner: 'octo',
      repo: 'patches-repo',
      path: 'clusters/prod',
    });
  });

  it('shows a distinct message when the filter matches nothing (vs. zero files in the repo)', async () => {
    storeGithubToken('ghp_existing');
    listPatchFilesMock.mockResolvedValue([
      { name: 'a.yaml', path: 'clusters/prod/a.yaml', size: 10 },
    ]);
    const user = userEvent.setup();
    renderLoad();
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    await screen.findByText('a.yaml');
    await user.type(screen.getByLabelText(/filter files/i), 'nomatch');
    expect(await screen.findByText(/No files match "nomatch"/i)).toBeInTheDocument();
  });

  it('surfaces a distinct message for each GitHubError kind', async () => {
    storeGithubToken('ghp_existing');
    listPatchFilesMock.mockRejectedValue(
      new GitHubError('rate-limited', 'Rate limited by GitHub — try again in a moment.')
    );
    const user = userEvent.setup();
    renderLoad();
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    expect(await screen.findByText(/Rate limited by GitHub/i)).toBeInTheDocument();
  });

  it('loads the selected file and calls onLoad with its content and a label', async () => {
    storeGithubToken('ghp_existing');
    listPatchFilesMock.mockResolvedValue([
      { name: 'a.yaml', path: 'clusters/prod/a.yaml', size: 10 },
    ]);
    fetchFileContentMock.mockResolvedValue('replicas: 3\n');
    const user = userEvent.setup();
    const { onLoad } = renderLoad();
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    await user.click(await screen.findByText('a.yaml'));
    expect(onLoad).toHaveBeenCalledWith('replicas: 3\n', 'a.yaml from octo/patches-repo');
  });

  it('shows a discard-confirm dialog first when there are unsaved edits', async () => {
    const user = userEvent.setup();
    renderLoad({ dirty: true });
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(screen.queryByText('Connect to GitHub')).not.toBeInTheDocument();
  });

  it('proceeds to the normal flow after confirming discard', async () => {
    listPatchFilesMock.mockResolvedValue([]);
    const user = userEvent.setup();
    renderLoad({ dirty: true });
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    await user.click(await screen.findByRole('button', { name: /discard and continue/i }));
    expect(await screen.findByText('Connect to GitHub')).toBeInTheDocument();
  });

  it('does not open anything when the discard confirmation is cancelled', async () => {
    const user = userEvent.setup();
    renderLoad({ dirty: true });
    await user.click(screen.getByRole('button', { name: /load from github/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByText('Connect to GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });
});
