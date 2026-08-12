/**
 * MachineClass detail/edit view — mirrors ConfigPatchDetail.tsx's structure
 * and state machine (loading/connection-error/ready, apply w/ 409-conflict
 * handling, delete w/ type-to-confirm, dirty-nav guard) exactly.
 *
 * One real difference from ConfigPatch: the editable content here is the
 * whole spec as pretty-printed JSON (`{"match_labels": [...]}`), not a
 * single freeform YAML string field -- MachineClass's real spec is
 * structured data (verified 2026-08-12, see MachineClassesList.tsx), so
 * there's no single "data" string to diff. Editing/apply therefore needs a
 * JSON.parse round-trip with validation, which ConfigPatch's plain-string
 * spec.data never required.
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

interface MachineClassSpec {
  match_labels?: string[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'connection-error'; message: string }
  | { kind: 'ready'; resource: OmniResource<MachineClassSpec> };


function specToText(spec: MachineClassSpec): string {
  return JSON.stringify(spec, null, 2);
}

/** Apply-flow status, separate from the page-level LoadState. */
type ApplyState =
  | { kind: 'idle' }
  | { kind: 'applying' }
  | { kind: 'conflict'; message: string }
  | { kind: 'checking' } // network dropped mid-apply -- re-fetching to find out what actually happened
  | { kind: 'error'; message: string };

type DeleteState = { kind: 'idle' } | { kind: 'confirming' } | { kind: 'deleting' } | { kind: 'error'; message: string };

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

export function MachineClassDetail() {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [modifiedText, setModifiedText] = useState('');
  const [applyState, setApplyState] = useState<ApplyState>({ kind: 'idle' });
  const [deleteState, setDeleteState] = useState<DeleteState>({ kind: 'idle' });
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [summary, setSummary] = useState('No changes.');
  const diffEditorRef = useRef<MonacoEditorNS.IStandaloneDiffEditor | null>(null);

  // See ConfigPatchDetail.tsx's identical fetchResource()/load() split --
  // same reasoning: conflict-reload and post-apply-success must not
  // silently discard the user's edit the way a blind load() would.
  async function fetchResource(): Promise<OmniResource<MachineClassSpec> | null> {
    const config = configStore.get();
    if (!config?.endpoint) {
      setState({ kind: 'connection-error', message: 'Omni endpoint is not configured (see plugin settings).' });
      return null;
    }
    try {
      const resource = await getResource<MachineClassSpec>({ endpoint: config.endpoint }, 'MachineClasses.omni.sidero.dev', id);
      setState({ kind: 'ready', resource });
      return resource;
    } catch (err) {
      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setState({ kind: 'connection-error', message });
      return null;
    }
  }

  async function load() {
    setState({ kind: 'loading' });
    const resource = await fetchResource();
    if (resource) {
      setModifiedText(specToText(resource.spec));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const originalText = state.kind === 'ready' ? specToText(state.resource.spec) : '';
  const dirty = state.kind === 'ready' && modifiedText !== originalText;

  let parsedSpec: MachineClassSpec | null = null;
  let parseError: string | null = null;
  try {
    parsedSpec = JSON.parse(modifiedText);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  // See ConfigPatchDetail.tsx's identical recomputeSummary() -- reads
  // straight from the live Monaco models rather than closing over React
  // state, since this is registered once at mount via onDidUpdateDiff.
  function recomputeSummary() {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) return;
    const hunks = toDiffHunks(diffEditor.getLineChanges());
    const original = diffEditor.getOriginalEditor().getValue();
    const modified = diffEditor.getModifiedEditor().getValue();
    setSummary(summarizeDiff(hunks, original.split('\n'), modified.split('\n')));
  }

  async function handleApply() {
    if (state.kind !== 'ready' || !parsedSpec) return;
    const config = configStore.get();
    if (!config?.endpoint) return;

    setApplyState({ kind: 'applying' });
    const attempted = { ...state.resource, spec: parsedSpec };

    try {
      await updateResource({ endpoint: config.endpoint }, attempted);
      setApplyState({ kind: 'idle' });
      const resource = await fetchResource();
      if (resource) {
        setModifiedText(specToText(resource.spec));
      }
    } catch (err) {
      if (err instanceof OmniConnectionError && err.status === 409) {
        setApplyState({
          kind: 'conflict',
          message: 'Someone else changed this machine class since you loaded it. Reload to see the latest version — your edit below is kept.',
        });
        return;
      }

      if (isNetworkLevelFailure(err)) {
        setApplyState({ kind: 'checking' });
        try {
          const config2 = configStore.get();
          const refetched = await getResource<MachineClassSpec>({ endpoint: config2!.endpoint! }, 'MachineClasses.omni.sidero.dev', id);
          if (specToText(refetched.spec) === modifiedText) {
            setState({ kind: 'ready', resource: refetched });
            setApplyState({ kind: 'idle' });
          } else {
            setApplyState({ kind: 'error', message: "Couldn't confirm the change went through — the machine class still shows the old content. Try again." });
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
    await fetchResource();
    setApplyState({ kind: 'idle' });
  }

  async function handleDelete() {
    if (state.kind !== 'ready') return;
    const config = configStore.get();
    if (!config?.endpoint) return;

    setDeleteState({ kind: 'deleting' });
    try {
      await deleteResourceFully({ endpoint: config.endpoint }, 'MachineClasses.omni.sidero.dev', id);
      history.push('/omni/machine-classes');
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
        message="You have unsaved changes to this machine class. Leave without applying?"
      />

      <Breadcrumbs sx={{ mb: 2 }}>
        <Link component={RouterLink} to="/omni/machine-classes">
          Machine Classes
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
          disabled={!dirty || !!parseError || applyState.kind === 'applying' || applyState.kind === 'checking'}
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

      {parseError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Not valid JSON — {parseError}
        </Alert>
      )}
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
          language="json"
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
            // See ConfigPatchDetail.tsx's identical fix -- Monaco mounting
            // during this component's conditional-render transition leaves
            // it stuck at zero rendered lines despite correct model content
            // and container size. automaticLayout/.layout() alone don't
            // recover; needs a font remeasure plus a forced render(true) on
            // both inner editors.
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
            This can't be undone. Type the machine class's name to confirm.
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
