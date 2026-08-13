/**
 * Read-only MachineClass list -- thin wrapper around the generic
 * ResourceList<TSpec> (see ResourceList.tsx), supplying MachineClass's
 * columns, row rendering, and empty-state copy.
 */
import { Box, Link, TableCell, TableRow, Typography } from '@mui/material';
import { useHistory } from 'react-router-dom';
import { formatUpdated, OmniResource } from './client';
import { ResourceList } from './ResourceList';

interface MachineClassSpec {
  // Verified against a real Omni instance's JSON output (2026-08-12): the
  // wire field is "match_labels" (snake_case retained, unlike ConfigPatch's
  // "compresseddata") -- confirms field-name mapping isn't a single
  // consistent rule across resource types and must be checked per type.
  match_labels?: string[];
  // NOT yet observed on the wire -- omitted entirely from the JSON response
  // when unset, so its real field name is unconfirmed. Do not guess it;
  // add it once a MachineClass with autoprovision actually set is available
  // to inspect.
}

export function MachineClassesList() {
  const history = useHistory();

  return (
    <ResourceList<MachineClassSpec>
      resourceType="MachineClasses.omni.sidero.dev"
      emptyState={
        <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
          <Typography variant="body2">
            No machine classes yet. See{' '}
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
          <TableCell>Match Labels</TableCell>
          <TableCell>Updated</TableCell>
        </>
      )}
      renderRow={(item: OmniResource<MachineClassSpec>) => (
        <TableRow
          key={item.metadata.id}
          hover
          onClick={() => history.push(`/omni/machine-classes/${encodeURIComponent(item.metadata.id)}`)}
          sx={{ cursor: 'pointer' }}
        >
          <TableCell>{item.metadata.phase}</TableCell>
          <TableCell>{item.metadata.id}</TableCell>
          <TableCell>{item.spec.match_labels?.join(', ') || '—'}</TableCell>
          <TableCell>{formatUpdated(item.metadata.updated)}</TableCell>
        </TableRow>
      )}
    />
  );
}
