/**
 * Generic resource list -- extracted from ConfigPatchesList.tsx/
 * MachineClassesList.tsx/ClustersList.tsx once a third near-identical
 * implementation made the shared 4-state pattern (loading/connection-error/
 * empty/populated) clearly earned, mirroring ResourceDetail<TSpec>'s own
 * "extract once a second [now third] concrete implementation proves what's
 * shared" precedent (see that file's doc comment).
 *
 * What's genuinely shared: the connected/ConnectPrompt gating, the
 * load()/useEffect mount logic, and the loading/connection-error/empty
 * state rendering. What's deliberately NOT forced into this abstraction:
 * table columns and row rendering are bespoke per resource type (render
 * props), and an optional parallel fetch (`loadExtra`) covers Clusters'
 * need to merge in ClusterStatuses data alongside the Cluster list itself
 * (VERIFIED 2026-08-13: ClusterStatuses.omni.sidero.dev is a separate
 * derived resource keyed by the same id, so it's its own list call, not
 * something ConfigPatch/MachineClass have an equivalent of).
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { Box, Skeleton, Table, TableBody, TableHead, TableRow } from '@mui/material';
import { ReactNode, useEffect, useState } from 'react';
import { hasActiveCredential, listResources, OmniConnectionError, OmniResource, OmniResourceType } from './client';
import { ConnectPrompt } from './ConnectPrompt';
import { ConnectionErrorAlert } from './LoadingAndErrorStates';
import { OmniPluginConfig } from './settings';

type LoadState<TSpec, TExtra> =
  | { kind: 'loading' }
  | { kind: 'connection-error'; message: string }
  | { kind: 'empty' }
  | { kind: 'loaded'; items: OmniResource<TSpec>[]; extra: TExtra };

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

/** Stable keys for the 4 loading-skeleton placeholder rows -- fixed, never reordered, so index-as-key would be safe too, but a real key avoids the lint rule entirely. */
const SKELETON_ROW_KEYS = ['skeleton-row-1', 'skeleton-row-2', 'skeleton-row-3', 'skeleton-row-4'];

export interface ResourceListProps<TSpec, TExtra = undefined> {
  resourceType: OmniResourceType;
  /** Defaults to 50, matching ConfigPatch/MachineClass's original limit. */
  limit?: number;
  /** Content shown in the empty state, below headerActions if present -- e.g. a "no items yet" message with docs link. */
  emptyState: ReactNode;
  /** Optional action row (e.g. "Create Cluster") shown above the table in both empty and populated states. */
  headerActions?: ReactNode;
  renderTableHead: () => ReactNode;
  renderRow: (item: OmniResource<TSpec>, extra: TExtra) => ReactNode;
  /** Optional parallel fetch merged alongside the primary list -- see Clusters' ClusterStatuses use above. */
  loadExtra?: (config: { endpoint: string }) => Promise<TExtra>;
}

export function ResourceList<TSpec, TExtra = undefined>({
  resourceType,
  limit = 50,
  emptyState,
  headerActions,
  renderTableHead,
  renderRow,
  loadExtra,
}: ResourceListProps<TSpec, TExtra>) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [state, setState] = useState<LoadState<TSpec, TExtra>>({ kind: 'loading' });

  useEffect(() => {
    // Either auth path counts -- a pasted service account key OR an active,
    // non-expired Auth0/ECDSA session (see client.ts's hasActiveCredential).
    hasActiveCredential().then(setConnected);
  }, []);

  async function load() {
    setState({ kind: 'loading' });

    const config = configStore.get();
    if (!config?.endpoint) {
      setState({ kind: 'connection-error', message: 'Omni endpoint is not configured (see plugin settings).' });
      return;
    }

    try {
      const [{ items }, extra] = await Promise.all([
        listResources<TSpec>({ endpoint: config.endpoint }, resourceType, { limit }),
        loadExtra ? loadExtra({ endpoint: config.endpoint }) : Promise.resolve(undefined as TExtra),
      ]);

      setState(items.length === 0 ? { kind: 'empty' } : { kind: 'loaded', items, extra });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        {SKELETON_ROW_KEYS.map(key => (
          <Skeleton key={key} variant="rectangular" height={40} sx={{ mb: 1 }} />
        ))}
      </Box>
    );
  }

  if (state.kind === 'connection-error') {
    return <ConnectionErrorAlert message={state.message} onRetry={load} />;
  }

  if (state.kind === 'empty') {
    return (
      <Box>
        {headerActions && <Box sx={{ mb: 2 }}>{headerActions}</Box>}
        {emptyState}
      </Box>
    );
  }

  return (
    <Box>
      {headerActions && <Box sx={{ mb: 2 }}>{headerActions}</Box>}
      <Table size="small">
        <TableHead>
          <TableRow>{renderTableHead()}</TableRow>
        </TableHead>
        <TableBody>{state.items.map(item => renderRow(item, state.extra))}</TableBody>
      </Table>
    </Box>
  );
}
