/**
 * Cluster list -- same 4-state pattern as ConfigPatchesList.tsx/
 * MachineClassesList.tsx (loading / connection-error / empty / populated),
 * plus a "Create Cluster" action since, unlike ConfigPatch/MachineClass,
 * clusters are meant to be created from inside this plugin (see cluster.ts).
 *
 * Status/Machines columns come from ClusterStatuses.omni.sidero.dev, a
 * separate derived resource keyed by the same id as the Cluster it
 * describes (VERIFIED 2026-08-13) -- fetched as its own list and merged by
 * id, rather than one Get per cluster, to avoid an N+1 fetch pattern.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { Alert, Box, Button, Chip, Skeleton, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { loadServiceAccount } from './auth';
import { formatUpdated, listResources, OmniConnectionError, OmniResource } from './client';
import { ClusterSpec, ClusterStatusSpec } from './cluster';
import { ConnectPrompt } from './ConnectPrompt';
import { OmniPluginConfig } from './settings';

/** 0 UNKNOWN, 1 SCALING_UP, 2 SCALING_DOWN, 3 RUNNING, 4 DESTROYING -- see cluster.ts's ClusterStatusSpec doc. */
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
  | { kind: 'empty' }
  | { kind: 'loaded'; items: OmniResource<ClusterSpec>[]; statuses: Map<string, ClusterStatusSpec> };

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

export function ClustersList() {
  const history = useHistory();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    loadServiceAccount().then(account => setConnected(account !== null));
  }, []);

  async function load() {
    setState({ kind: 'loading' });

    const config = configStore.get();
    if (!config?.endpoint) {
      setState({ kind: 'connection-error', message: 'Omni endpoint is not configured (see plugin settings).' });
      return;
    }

    try {
      const [{ items }, { items: statusItems }] = await Promise.all([
        listResources<ClusterSpec>({ endpoint: config.endpoint }, 'Clusters.omni.sidero.dev', { limit: 100 }),
        listResources<ClusterStatusSpec>({ endpoint: config.endpoint }, 'ClusterStatuses.omni.sidero.dev', { limit: 100 }),
      ]);

      const statuses = new Map(statusItems.map(s => [s.metadata.id, s.spec]));
      setState(items.length === 0 ? { kind: 'empty' } : { kind: 'loaded', items, statuses });
    } catch (err) {
      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setState({ kind: 'connection-error', message });
    }
  }

  useEffect(() => {
    if (connected) {
      load();
    }
  }, [connected]);

  if (connected === null) {
    return <Skeleton variant="rectangular" height={120} />;
  }

  if (!connected) {
    return <ConnectPrompt onConnected={() => setConnected(true)} />;
  }

  const createButton = (
    <Button variant="contained" onClick={() => history.push('/omni/clusters/new')}>
      Create Cluster
    </Button>
  );

  if (state.kind === 'loading') {
    return (
      <Box>
        <Skeleton variant="text" width={240} height={32} sx={{ mb: 2 }} />
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} variant="rectangular" height={40} sx={{ mb: 1 }} />
        ))}
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

  if (state.kind === 'empty') {
    return (
      <Box>
        <Box sx={{ mb: 2 }}>{createButton}</Box>
        <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
          <Typography variant="body2">No clusters yet. Create one to get started.</Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ mb: 2 }}>{createButton}</Box>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Talos Version</TableCell>
            <TableCell>Kubernetes Version</TableCell>
            <TableCell>Machines</TableCell>
            <TableCell>Updated</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {state.items.map(item => {
            const status = state.statuses.get(item.metadata.id);
            return (
              <TableRow
                key={item.metadata.id}
                hover
                onClick={() => history.push(`/omni/clusters/${encodeURIComponent(item.metadata.id)}`)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell>{item.metadata.id}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={status?.phase !== undefined ? PHASE_LABELS[status.phase] ?? 'Unknown' : item.metadata.phase}
                    color={status?.ready ? 'success' : 'default'}
                  />
                </TableCell>
                <TableCell>{item.spec.talos_version || '—'}</TableCell>
                <TableCell>{item.spec.kubernetes_version || '—'}</TableCell>
                <TableCell>{status?.machines?.requested ?? 0}</TableCell>
                <TableCell>{formatUpdated(item.metadata.updated)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}
