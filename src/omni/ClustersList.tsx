/**
 * Cluster list -- thin wrapper around the generic ResourceList<TSpec>
 * (see ResourceList.tsx), supplying Cluster's columns, row rendering, a
 * "Create Cluster" header action (unlike ConfigPatch/MachineClass, clusters
 * are meant to be created from inside this plugin -- see cluster.ts), and
 * a `loadExtra` fetch merging in ClusterStatuses.
 *
 * Status/Machines columns come from ClusterStatuses.omni.sidero.dev, a
 * separate derived resource keyed by the same id as the Cluster it
 * describes (VERIFIED 2026-08-13) -- fetched as its own list and merged by
 * id via loadExtra, rather than one Get per cluster, to avoid an N+1 fetch
 * pattern.
 */
import { Box, Button, Chip, TableCell, TableRow, Typography } from '@mui/material';
import { useHistory } from 'react-router-dom';
import { formatUpdated, listResources, OmniResource } from './client';
import { ClusterSpec, ClusterStatusSpec } from './cluster';
import { ResourceList } from './ResourceList';

/** 0 UNKNOWN, 1 SCALING_UP, 2 SCALING_DOWN, 3 RUNNING, 4 DESTROYING -- see cluster.ts's ClusterStatusSpec doc. */
const PHASE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Scaling up',
  2: 'Scaling down',
  3: 'Running',
  4: 'Destroying',
};

export function ClustersList() {
  const history = useHistory();

  return (
    <ResourceList<ClusterSpec, Map<string, ClusterStatusSpec>>
      resourceType="Clusters.omni.sidero.dev"
      limit={100}
      loadExtra={async config => {
        const { items } = await listResources<ClusterStatusSpec>(config, 'ClusterStatuses.omni.sidero.dev', { limit: 100 });
        return new Map(items.map(s => [s.metadata.id, s.spec]));
      }}
      headerActions={
        <Button variant="contained" onClick={() => history.push('/omni/clusters/new')}>
          Create Cluster
        </Button>
      }
      emptyState={
        <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
          <Typography variant="body2">No clusters yet. Create one to get started.</Typography>
        </Box>
      }
      renderTableHead={() => (
        <>
          <TableCell>Name</TableCell>
          <TableCell>Status</TableCell>
          <TableCell>Talos Version</TableCell>
          <TableCell>Kubernetes Version</TableCell>
          <TableCell>Machines</TableCell>
          <TableCell>Updated</TableCell>
        </>
      )}
      renderRow={(item: OmniResource<ClusterSpec>, statuses: Map<string, ClusterStatusSpec>) => {
        const status = statuses.get(item.metadata.id);
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
      }}
    />
  );
}
