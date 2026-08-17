/**
 * Read-only ConfigPatch list -- thin wrapper around the generic
 * ResourceList<TSpec> (see ResourceList.tsx), supplying ConfigPatch's
 * columns, row rendering, and empty-state copy.
 */
import { Box, Link, TableCell, TableRow, Typography } from '@mui/material';
import { useHistory } from 'react-router-dom';
import { formatUpdated, OmniResource } from './client';
import { ResourceList } from './ResourceList';

interface ConfigPatchSpec {
  data?: string;
  // Verified against a real Omni instance's JSON output (2026-08-11): the
  // wire field is "compresseddata", not the proto-derived "compressed_data".
  compresseddata?: string;
}

export function ConfigPatchesList() {
  const history = useHistory();

  return (
    <ResourceList<ConfigPatchSpec>
      resourceType="ConfigPatches.omni.sidero.dev"
      emptyState={
        <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
          <Typography variant="body2">
            No config patches yet for this cluster. See{' '}
            <Link href="https://docs.siderolabs.com/omni" target="_blank" rel="noreferrer">
              Omni's own docs
            </Link>{' '}
            to create your first one via <code>omnictl</code>.
          </Typography>
        </Box>
      }
      renderTableHead={() => (
        <>
          <TableCell>Phase</TableCell>
          <TableCell>Name</TableCell>
          <TableCell>Owner</TableCell>
          <TableCell>Updated</TableCell>
        </>
      )}
      renderRow={(item: OmniResource<ConfigPatchSpec>) => (
        <TableRow
          key={item.metadata.id}
          hover
          onClick={() =>
            history.push(`/omni/config-patches/${encodeURIComponent(item.metadata.id)}`)
          }
          sx={{ cursor: 'pointer' }}
        >
          <TableCell>{item.metadata.phase}</TableCell>
          <TableCell>{item.metadata.id}</TableCell>
          <TableCell>{item.metadata.owner || '—'}</TableCell>
          <TableCell>{formatUpdated(item.metadata.updated)}</TableCell>
        </TableRow>
      )}
    />
  );
}
