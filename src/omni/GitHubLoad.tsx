/**
 * "Load from GitHub" button + Dialog for ConfigPatchDetail -- see
 * docs/designs/github-configpatch-loading.md for the full design and its
 * GSTACK REVIEW REPORT for the review trail.
 *
 * One Dialog, two internal steps (PAT entry, then file picker), matching
 * the existing delete-confirm Dialog's visual language in ResourceDetail.tsx
 * rather than introducing a new modal pattern. A separate small Dialog
 * guards against discarding an unsaved hand-edit, reusing that same
 * delete-confirm shape.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import {
  buildTokenCreationUrl,
  fetchFileContent,
  GitHubError,
  GithubFile,
  GithubPatchesLocation,
  listPatchFiles,
  loadGithubToken,
  parsePatchesPath,
  storeGithubToken,
} from './github';
import { OmniPluginConfig } from './settings';

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

type DialogState =
  | { kind: 'closed' }
  | { kind: 'confirm-discard' }
  | { kind: 'pat'; value: string; location: GithubPatchesLocation }
  | {
      kind: 'picker';
      location: GithubPatchesLocation;
      files: GithubFile[] | null; // null = loading
      error: GitHubError | { message: string } | null;
      filter: string;
      fetchingFile: string | null;
    };

/** Maps a GitHubError (or the settings-parse error) to the message shown in the Dialog. */
function errorMessage(error: GitHubError | { message: string }): string {
  if (!(error instanceof GitHubError)) return error.message;
  return error.message;
}

export function GitHubLoad({
  dirty,
  onLoad,
}: {
  dirty: boolean;
  onLoad: (text: string, label: string) => void;
}) {
  const [state, setState] = useState<DialogState>({ kind: 'closed' });

  function startFlow() {
    const raw = configStore.get()?.githubPatchesPath;
    const location = raw ? parsePatchesPath(raw) : { error: 'No GitHub repo configured yet.' };
    if ('error' in location) {
      setState({
        kind: 'picker',
        location: { owner: '', repo: '', path: '' },
        files: null,
        error: { message: `${location.error} Set "GitHub patches path" in plugin settings.` },
        filter: '',
        fetchingFile: null,
      });
      return;
    }
    const token = loadGithubToken();
    if (!token) {
      setState({ kind: 'pat', value: '', location });
      return;
    }
    openPicker(location, token);
  }

  function handleButtonClick() {
    if (dirty) {
      setState({ kind: 'confirm-discard' });
    } else {
      startFlow();
    }
  }

  async function openPicker(location: GithubPatchesLocation, token: string) {
    setState({
      kind: 'picker',
      location,
      files: null,
      error: null,
      filter: '',
      fetchingFile: null,
    });
    try {
      const files = await listPatchFiles(token, location);
      setState(prev => (prev.kind === 'picker' ? { ...prev, files } : prev));
    } catch (err) {
      const error = err instanceof GitHubError ? err : { message: String(err) };
      setState(prev => (prev.kind === 'picker' ? { ...prev, files: [], error } : prev));
    }
  }

  async function handlePatSubmit() {
    if (state.kind !== 'pat' || !state.value.trim()) return;
    // Optimistic store, no live validation -- matches ConnectPrompt.tsx's
    // precedent for the Omni key exactly, see design doc's Engineering Decisions.
    storeGithubToken(state.value);
    openPicker(state.location, state.value.trim());
  }

  async function handleSelectFile(file: GithubFile) {
    if (state.kind !== 'picker') return;
    const token = loadGithubToken();
    if (!token) return;
    setState({ ...state, fetchingFile: file.name });
    try {
      const text = await fetchFileContent(token, state.location, file.path);
      onLoad(text, `${file.name} from ${state.location.owner}/${state.location.repo}`);
      setState({ kind: 'closed' });
    } catch (err) {
      const error = err instanceof GitHubError ? err : { message: String(err) };
      setState({ ...state, fetchingFile: null, error });
    }
  }

  const open = state.kind !== 'closed';

  return (
    <>
      <Button variant="outlined" onClick={handleButtonClick}>
        Load from GitHub
      </Button>

      <Dialog open={state.kind === 'confirm-discard'} onClose={() => setState({ kind: 'closed' })}>
        <DialogTitle>Discard unsaved changes?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You have unsaved changes. Loading a new file will discard them.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setState({ kind: 'closed' })}>Cancel</Button>
          <Button color="error" variant="contained" onClick={startFlow}>
            Discard and continue
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={open && state.kind !== 'confirm-discard'}
        onClose={() => setState({ kind: 'closed' })}
        fullWidth
      >
        {state.kind === 'pat' && (
          <>
            <DialogTitle>Connect to GitHub</DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Paste a fine-grained, read-only, single-repo Personal Access Token. Held in this
                browser tab's session storage only — cleared when the tab closes, never sent
                anywhere except GitHub's own API.{' '}
                <Link
                  href={buildTokenCreationUrl(state.location.owner)}
                  target="_blank"
                  rel="noopener"
                >
                  Create one scoped to {state.location.owner}/{state.location.repo}
                </Link>{' '}
                (confirm the repo is selected and Contents access is read-only before generating).
              </Typography>
              <TextField
                fullWidth
                label="Personal access token"
                type="password"
                value={state.value}
                onChange={e => setState({ ...state, value: e.target.value })}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setState({ kind: 'closed' })}>Cancel</Button>
              <Button variant="contained" disabled={!state.value.trim()} onClick={handlePatSubmit}>
                Connect
              </Button>
            </DialogActions>
          </>
        )}

        {state.kind === 'picker' && (
          <>
            <DialogTitle>Load a ConfigPatch from GitHub</DialogTitle>
            <DialogContent>
              {state.error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {errorMessage(state.error)}
                </Alert>
              )}
              {!state.error && (
                <>
                  <TextField
                    fullWidth
                    label="Filter files"
                    value={state.filter}
                    onChange={e => setState({ ...state, filter: e.target.value })}
                    sx={{ mb: 2 }}
                    disabled={state.files === null}
                  />
                  {state.files === null && (
                    <Typography variant="body2" color="text.secondary">
                      Loading files…
                    </Typography>
                  )}
                  {state.files !== null && state.files.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No .yaml/.yml files found in {state.location.owner}/{state.location.repo}
                      {state.location.path ? `/${state.location.path}` : ''}.
                    </Typography>
                  )}
                  {state.files !== null &&
                    state.files.length > 0 &&
                    (() => {
                      const filtered = state.files.filter(f =>
                        f.name.toLowerCase().includes(state.filter.toLowerCase())
                      );
                      if (filtered.length === 0) {
                        return (
                          <Typography variant="body2" color="text.secondary">
                            No files match "{state.filter}".{' '}
                            <Link
                              component="button"
                              onClick={() => setState({ ...state, filter: '' })}
                            >
                              Clear filter
                            </Link>
                          </Typography>
                        );
                      }
                      return (
                        <List dense>
                          {filtered.map(file => (
                            <ListItemButton
                              key={file.path}
                              onClick={() => handleSelectFile(file)}
                              disabled={state.fetchingFile !== null}
                            >
                              <ListItemText
                                primary={file.name}
                                secondary={
                                  state.fetchingFile === file.name
                                    ? 'Loading…'
                                    : `${file.size} bytes`
                                }
                              />
                            </ListItemButton>
                          ))}
                        </List>
                      );
                    })()}
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setState({ kind: 'closed' })}>Cancel</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </>
  );
}
