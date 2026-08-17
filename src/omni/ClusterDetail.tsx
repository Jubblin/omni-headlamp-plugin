/**
 * Cluster detail/destroy view. Not a ResourceDetail<TSpec> wrapper -- unlike
 * ConfigPatch/MachineClass, there's nothing to edit here (Kubernetes/Talos
 * version upgrades are out of scope for this PR, see PR description), just
 * status display and a destroy action. The destroy confirmation dialog
 * deliberately matches ResourceDetail.tsx's type-to-confirm delete dialog
 * copy/behavior exactly (same placeholder-is-the-id pattern, same disabled
 * logic) -- see cluster.ts's destroyCluster for why the underlying operation
 * (Teardown + poll-until-404) differs from ResourceDetail's
 * deleteResourceFully (Teardown immediately followed by Delete): a Cluster
 * carries real finalizers that take time to clear, a ConfigPatch/MachineClass
 * doesn't.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
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
import { useEffect, useState } from 'react';
import { Link as RouterLink, useHistory, useParams } from 'react-router-dom';
import { formatUpdated, getResource, OmniConnectionError, OmniResource } from './client';
import { ClusterSpec, ClusterStatusSpec, destroyCluster } from './cluster';
import { OmniPluginConfig } from './settings';

const PHASE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Scaling up',
  2: 'Scaling down',
  3: 'Running',
  4: 'Destroying',
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'connection-error'; message: string }
  | { kind: 'ready'; cluster: OmniResource<ClusterSpec>; status: ClusterStatusSpec | null };

type DestroyState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'destroying'; step: string }
  | { kind: 'error'; message: string };

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

export function ClusterDetail() {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [destroyState, setDestroyState] = useState<DestroyState>({ kind: 'idle' });
  const [destroyConfirmText, setDestroyConfirmText] = useState('');

  async function load() {
    setState({ kind: 'loading' });
    const config = configStore.get();
    if (!config?.endpoint) {
      setState({
        kind: 'connection-error',
        message: 'Omni endpoint is not configured (see plugin settings).',
      });
      return;
    }
    try {
      const cluster = await getResource<ClusterSpec>(
        { endpoint: config.endpoint },
        'Clusters.omni.sidero.dev',
        id
      );
      // Best-effort: the ClusterStatus controller may not have produced a
      // status yet for a just-created cluster. A failed fetch here shouldn't
      // block showing the cluster itself.
      let status: ClusterStatusSpec | null = null;
      try {
        const statusResource = await getResource<ClusterStatusSpec>(
          { endpoint: config.endpoint },
          'ClusterStatuses.omni.sidero.dev',
          id
        );
        status = statusResource.spec;
      } catch {
        status = null;
      }
      setState({ kind: 'ready', cluster, status });
    } catch (err) {
      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setState({ kind: 'connection-error', message });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleDestroy() {
    const config = configStore.get();
    if (!config?.endpoint) return;

    setDestroyState({ kind: 'destroying', step: 'Tearing down…' });
    try {
      await destroyCluster({ endpoint: config.endpoint }, id, attempt => {
        setDestroyState({
          kind: 'destroying',
          step: `Waiting for finalizers to clear (attempt ${attempt})…`,
        });
      });
      history.push('/omni/clusters');
    } catch (err) {
      // OmniConnectionError extends Error, so a single `instanceof Error` check covers both.
      const message = err instanceof Error ? err.message : String(err);
      setDestroyState({ kind: 'error', message });
    }
  }

  if (state.kind === 'loading') {
    return (
      <Box>
        <Skeleton variant="text" width={300} height={32} sx={{ mb: 2 }} />
        <Skeleton variant="rectangular" height={200} />
      </Box>
    );
  }

  if (state.kind === 'connection-error') {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={load}>
            Retry
          </Button>
        }
      >
        Can't reach Omni — {state.message}
      </Alert>
    );
  }

  const { cluster, status } = state;
  const destroying = destroyState.kind === 'destroying';

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2 }}>
        <Link component={RouterLink} to="/omni/clusters">
          Clusters
        </Link>
        <Typography color="text.primary">{cluster.metadata.id}</Typography>
      </Breadcrumbs>

      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h6">{cluster.metadata.id}</Typography>
        <Chip
          size="small"
          label={
            status?.phase !== undefined
              ? PHASE_LABELS[status.phase] ?? 'Unknown'
              : cluster.metadata.phase
          }
          color={status?.ready ? 'success' : 'default'}
        />
        <Typography variant="body2" color="text.secondary">
          Updated {formatUpdated(cluster.metadata.updated)}
        </Typography>
      </Stack>

      <Stack spacing={0.5} sx={{ mb: 3 }}>
        <Typography variant="body2">Talos version: {cluster.spec.talos_version || '—'}</Typography>
        <Typography variant="body2">
          Kubernetes version: {cluster.spec.kubernetes_version || '—'}
        </Typography>
        <Typography variant="body2">
          Machines: {status?.machines?.connected ?? 0} connected /{' '}
          {status?.machines?.requested ?? 0} requested
        </Typography>
        <Typography variant="body2">
          Control plane ready: {status?.controlplaneReady ? 'yes' : 'no'}
        </Typography>
        <Typography variant="body2">Cluster ready: {status?.ready ? 'yes' : 'no'}</Typography>
        {!status && (
          <Typography variant="caption" color="text.secondary">
            No status reported yet — this is normal for a just-created cluster with no machines
            connected.
          </Typography>
        )}
      </Stack>

      <Button
        variant="outlined"
        color="error"
        onClick={() => setDestroyState({ kind: 'confirming' })}
        disabled={destroying}
      >
        Destroy Cluster
      </Button>

      {destroyState.kind === 'destroying' && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {destroyState.step}
        </Alert>
      )}
      {destroyState.kind === 'error' && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setDestroyState({ kind: 'idle' })}>
          {destroyState.message}
        </Alert>
      )}

      <Dialog
        open={destroyState.kind === 'confirming' || destroying}
        onClose={() => (destroying ? undefined : setDestroyState({ kind: 'idle' }))}
      >
        <DialogTitle>Destroy {cluster.metadata.id}?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This can't be undone -- every machine set, machine set node, and config patch belonging
            to this cluster will be destroyed too. Type the cluster's name to confirm.
          </DialogContentText>
          <TextField
            fullWidth
            placeholder={cluster.metadata.id}
            value={destroyConfirmText}
            onChange={e => setDestroyConfirmText(e.target.value)}
            disabled={destroying}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDestroyState({ kind: 'idle' })} disabled={destroying}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={destroyConfirmText !== cluster.metadata.id || destroying}
            onClick={handleDestroy}
          >
            {destroying ? 'Destroying…' : 'Destroy'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
