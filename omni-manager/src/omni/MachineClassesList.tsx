/**
 * Read-only MachineClass list — completes PR1 scope per the design doc.
 *
 * Same 4-state pattern as ConfigPatchesList.tsx: loading (skeleton) /
 * connection-error (distinct from empty, red banner + Retry) / empty
 * (genuinely zero, no error styling) / populated.
 */
import { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Box, Button, Link, Skeleton, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { loadServiceAccount } from './auth';
import { listResources, OmniConnectionError, OmniResource } from './client';
import { OmniPluginConfig } from './settings';
import { ConnectPrompt } from './ConnectPrompt';

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

// Go's zero-value time.Time serializes to this literal string rather than
// being omitted -- see the identical note in ConfigPatchesList.tsx.
const ZERO_TIME = '0001-01-01T00:00:00Z';

function formatUpdated(updated: string | undefined): string {
  return updated && updated !== ZERO_TIME ? updated : '—';
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'connection-error'; message: string }
  | { kind: 'empty' }
  | { kind: 'loaded'; items: OmniResource<MachineClassSpec>[]; total: number };

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

export function MachineClassesList() {
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
      const { items, total } = await listResources<MachineClassSpec>(
        { endpoint: config.endpoint },
        'MachineClasses.omni.sidero.dev',
        { limit: 50 }
      );

      setState(items.length === 0 ? { kind: 'empty' } : { kind: 'loaded', items, total });
    } catch (err) {
      // Every failure here — Omni down, network partition, allowlist misconfig,
      // bad signature — surfaces as the same connection-error state. Distinguishing
      // "auth rejected" from "network down" is future work; both cases share the
      // same user-facing requirement (never silently look like "zero results").
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
      <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
        <Typography variant="body2">
          No machine classes yet. See{' '}
          <Link href="https://docs.siderolabs.com/omni" target="_blank" rel="noreferrer">
            Omni's own docs
          </Link>{' '}
          to create your first one via <code>omnictl</code>.
        </Typography>
      </Box>
    );
  }

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Name</TableCell>
          <TableCell>Match Labels</TableCell>
          <TableCell>Phase</TableCell>
          <TableCell>Updated</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {state.items.map(item => (
          <TableRow
            key={item.metadata.id}
            hover
            onClick={() => history.push(`/omni/machine-classes/${encodeURIComponent(item.metadata.id)}`)}
            sx={{ cursor: 'pointer' }}
          >
            <TableCell>{item.metadata.id}</TableCell>
            <TableCell>{item.spec.match_labels?.join(', ') || '—'}</TableCell>
            <TableCell>{item.metadata.phase}</TableCell>
            <TableCell>{formatUpdated(item.metadata.updated)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
