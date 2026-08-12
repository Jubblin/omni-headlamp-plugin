/**
 * ConfigPatch detail/edit view — PR2 scope per the design doc.
 *
 * Layout: breadcrumb -> resource header (name, phase) -> toolbar (Delete,
 * Apply) -> trust-moment summary -> inline diff editor (Monaco DiffEditor,
 * renderSideBySide: false, reusing Headlamp's host-loaded Monaco instance —
 * no new dependency, see @monaco-editor/react externalization in
 * headlamp-plugin's vite config).
 */
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, Prompt, useHistory, useParams } from 'react-router-dom';
import { DiffEditor } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { deleteResourceFully, formatUpdated, getResource, isNetworkLevelFailure, OmniConnectionError, OmniResource, updateResource } from './client';
import { OmniPluginConfig } from './settings';
import { summarizeDiff, toDiffHunks } from './diffSummary';

interface ConfigPatchSpec {
  data?: string;
  compresseddata?: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'connection-error'; message: string }
  | { kind: 'ready'; resource: OmniResource<ConfigPatchSpec> };


/** Apply-flow status, separate from the page-level LoadState. */
type ApplyState =
  | { kind: 'idle' }
  | { kind: 'applying' }
  | { kind: 'conflict'; message: string }
  | { kind: 'checking' } // network dropped mid-apply -- re-fetching to find out what actually happened
  | { kind: 'error'; message: string };

type DeleteState = { kind: 'idle' } | { kind: 'confirming' } | { kind: 'deleting' } | { kind: 'error'; message: string };

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

export function ConfigPatchDetail() {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [modifiedText, setModifiedText] = useState('');
  const [applyState, setApplyState] = useState<ApplyState>({ kind: 'idle' });
  const [deleteState, setDeleteState] = useState<DeleteState>({ kind: 'idle' });
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [summary, setSummary] = useState('No changes.');
  const diffEditorRef = useRef<MonacoEditorNS.IStandaloneDiffEditor | null>(null);

  // Fetches the resource and updates `state`, but never touches
  // `modifiedText`. Used by the conflict-reload path, where the whole point
  // is to refresh the version/original baseline while keeping the user's
  // edit intact -- and by handleApply's post-success refresh, where the
  // fresh data legitimately becomes the new baseline (dirty naturally goes
  // false once modifiedText, untouched, equals the new originalText).
  // Returns the fetched resource on success, or null on failure.
  async function fetchResource(): Promise<OmniResource<ConfigPatchSpec> | null> {
    const config = configStore.get();
    if (!config?.endpoint) {
      setState({ kind: 'connection-error', message: 'Omni endpoint is not configured (see plugin settings).' });
      return null;
    }
    try {
      const resource = await getResource<ConfigPatchSpec>({ endpoint: config.endpoint }, 'ConfigPatches.omni.sidero.dev', id);
      setState({ kind: 'ready', resource });
      return resource;
    } catch (err) {
      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setState({ kind: 'connection-error', message });
      return null;
    }
  }

  // Initial mount only: shows the loading skeleton and resets modifiedText
  // to match the freshly-fetched resource, since there's no user edit yet
  // to preserve.
  async function load() {
    setState({ kind: 'loading' });
    const resource = await fetchResource();
    if (resource) {
      setModifiedText(resource.spec.data ?? '');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const originalText = state.kind === 'ready' ? state.resource.spec.data ?? '' : '';
  const dirty = state.kind === 'ready' && modifiedText !== originalText;

  // Reads straight from the live Monaco models rather than closing over
  // originalText/modifiedText -- this is registered once via
  // diffEditor.onDidUpdateDiff() at mount (see onMount below), so a closure
  // over React state would go stale after the first render and never see
  // later edits. diffEditorRef.current is a ref, always current regardless
  // of which render's closure is actually running.
  function recomputeSummary() {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) return;
    const hunks = toDiffHunks(diffEditor.getLineChanges());
    const original = diffEditor.getOriginalEditor().getValue();
    const modified = diffEditor.getModifiedEditor().getValue();
    setSummary(summarizeDiff(hunks, original.split('\n'), modified.split('\n')));
  }

  async function handleApply() {
    if (state.kind !== 'ready') return;
    const config = configStore.get();
    if (!config?.endpoint) return;

    setApplyState({ kind: 'applying' });
    const attempted = { ...state.resource, spec: { ...state.resource.spec, data: modifiedText } };

    try {
      await updateResource({ endpoint: config.endpoint }, attempted);
      setApplyState({ kind: 'idle' });
      // fetchResource(), not load(): the applied content is now the real
      // baseline, so modifiedText should end up equal to the refreshed
      // originalText (making dirty false again) -- but via the fetched
      // value, not by blindly resetting to what we optimistically tried
      // to apply, in case the server transformed it in any way.
      const resource = await fetchResource();
      if (resource) {
        setModifiedText(resource.spec.data ?? '');
      }
    } catch (err) {
      if (err instanceof OmniConnectionError && err.status === 409) {
        setApplyState({
          kind: 'conflict',
          message: 'Someone else changed this patch since you loaded it. Reload to see the latest version — your edit below is kept.',
        });
        return;
      }

      if (isNetworkLevelFailure(err)) {
        // Request sent, response never confirmed (dropped connection, timeout,
        // etc.) -- distinct from a clean rejection, per the design doc's
        // Success Criteria. Re-fetch and compare rather than assuming failure.
        setApplyState({ kind: 'checking' });
        try {
          const config2 = configStore.get();
          const refetched = await getResource<ConfigPatchSpec>({ endpoint: config2!.endpoint! }, 'ConfigPatches.omni.sidero.dev', id);
          if (refetched.spec.data === modifiedText) {
            setState({ kind: 'ready', resource: refetched });
            setApplyState({ kind: 'idle' });
          } else {
            setApplyState({ kind: 'error', message: "Couldn't confirm the change went through — the patch still shows the old content. Try again." });
          }
        } catch {
          setApplyState({ kind: 'error', message: "Couldn't confirm the change went through, and the follow-up check also failed. Try again." });
        }
        return;
      }

      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setApplyState({ kind: 'error', message });
    }
  }

  async function handleReloadAfterConflict() {
    // fetchResource(), NOT load(): load() unconditionally resets
    // modifiedText to match the freshly-fetched resource, which would
    // silently discard the user's edit here -- exactly the bug this
    // function exists to avoid. Only `state` (and therefore
    // `originalText`/the resource's version) should refresh; the diff
    // against the kept edit recomputes naturally since DiffEditor's
    // `original` prop changes.
    await fetchResource();
    setApplyState({ kind: 'idle' });
  }

  async function handleDelete() {
    if (state.kind !== 'ready') return;
    const config = configStore.get();
    if (!config?.endpoint) return;

    setDeleteState({ kind: 'deleting' });
    try {
      await deleteResourceFully({ endpoint: config.endpoint }, 'ConfigPatches.omni.sidero.dev', id);
      history.push('/omni/config-patches');
    } catch (err) {
      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setDeleteState({ kind: 'error', message });
    }
  }

  if (state.kind === 'loading') {
    return (
      <Box>
        <Skeleton variant="text" width={300} height={32} sx={{ mb: 2 }} />
        <Skeleton variant="rectangular" height={300} />
      </Box>
    );
  }

  if (state.kind === 'connection-error') {
    return (
      <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>
        Can't reach Omni — {state.message}
      </Alert>
    );
  }

  const { resource } = state;

  return (
    <Box>
      <Prompt
        when={dirty}
        message="You have unsaved changes to this patch. Leave without applying?"
      />

      <Breadcrumbs sx={{ mb: 2 }}>
        <Link component={RouterLink} to="/omni/config-patches">
          Config Patches
        </Link>
        <Typography color="text.primary">{resource.metadata.id}</Typography>
      </Breadcrumbs>

      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h6">{resource.metadata.id}</Typography>
        <Chip size="small" label={resource.metadata.phase} />
        <Typography variant="body2" color="text.secondary">
          Updated {formatUpdated(resource.metadata.updated)}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Button
          variant="contained"
          disabled={!dirty || applyState.kind === 'applying' || applyState.kind === 'checking'}
          onClick={handleApply}
        >
          {applyState.kind === 'applying' ? 'Applying…' : applyState.kind === 'checking' ? 'Checking…' : 'Apply'}
        </Button>
        <Button
          variant="outlined"
          color="error"
          onClick={() => setDeleteState({ kind: 'confirming' })}
        >
          Delete
        </Button>
      </Stack>

      {applyState.kind === 'conflict' && (
        <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={handleReloadAfterConflict}>Reload</Button>}>
          {applyState.message}
        </Alert>
      )}
      {applyState.kind === 'checking' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Couldn't confirm the apply went through — checking the current state…
        </Alert>
      )}
      {applyState.kind === 'error' && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setApplyState({ kind: 'idle' })}>
          {applyState.message}
        </Alert>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {dirty ? summary : 'No changes.'}
      </Typography>

      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
        <DiffEditor
          height="400px"
          language="yaml"
          original={originalText}
          modified={modifiedText}
          options={{ renderSideBySide: false, readOnly: false, originalEditable: false, automaticLayout: true }}
          onMount={(diffEditor, monacoInstance) => {
            diffEditorRef.current = diffEditor;
            const modifiedModel = diffEditor.getModifiedEditor();
            modifiedModel.onDidChangeModelContent(() => {
              setModifiedText(modifiedModel.getValue());
            });
            diffEditor.onDidUpdateDiff(recomputeSummary);
            // Monaco mounting while our component's conditional-render
            // transition is still settling leaves it stuck: correct model
            // content and eventually correct container size, but zero
            // rendered .view-line elements forever. automaticLayout and
            // diffEditor.layout() alone don't recover from this --
            // .layout() only recomputes dimensions, not the actual paint.
            // Confirmed via direct inspection that the fix needs a forced
            // render (render(true)) on the two INNER standalone editors,
            // not just layout() on the diff editor wrapper.
            setTimeout(() => {
              monacoInstance.editor.remeasureFonts();
              diffEditor.layout();
              diffEditor.getOriginalEditor().render(true);
              diffEditor.getModifiedEditor().render(true);
            }, 100);
          }}
        />
      </Box>

      <Dialog open={deleteState.kind === 'confirming' || deleteState.kind === 'deleting'} onClose={() => setDeleteState({ kind: 'idle' })}>
        <DialogTitle>Delete {resource.metadata.id}?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This can't be undone. Type the patch's name to confirm.
          </DialogContentText>
          <TextField
            fullWidth
            autoFocus
            placeholder={resource.metadata.id}
            value={deleteConfirmText}
            onChange={e => setDeleteConfirmText(e.target.value)}
            disabled={deleteState.kind === 'deleting'}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteState({ kind: 'idle' })} disabled={deleteState.kind === 'deleting'}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteConfirmText !== resource.metadata.id || deleteState.kind === 'deleting'}
            onClick={handleDelete}
          >
            {deleteState.kind === 'deleting' ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
      {deleteState.kind === 'error' && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setDeleteState({ kind: 'idle' })}>
          {deleteState.message}
        </Alert>
      )}
    </Box>
  );
}
