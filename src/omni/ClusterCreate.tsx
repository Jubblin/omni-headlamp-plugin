/**
 * Cluster create flow -- a single-page form, not a multi-step wizard: the
 * fields (name, Talos/Kubernetes version, control plane machines, optional
 * worker machines) are few enough and interdependent enough (Kubernetes
 * version choices depend on the selected Talos version) that a wizard would
 * add navigation overhead without reducing what the user has to think about
 * at once.
 *
 * Genuinely different shape from ResourceDetail<TSpec>: this creates a
 * *graph* of resources (see cluster.ts's buildClusterResourceGraph), not a
 * single resource's spec, so there's no diff editor here -- just a form and
 * a submit action.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  LinearProgress,
  Link,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import { listResources, OmniConnectionError, OmniResource } from './client';
import {
  ClusterCreateInput,
  createCluster,
  MachineSelection,
  PlannedResource,
  TalosVersionSpec,
  validateClusterCreateInput,
} from './cluster';
import { OmniPluginConfig } from './settings';

interface MachineClassSpec {
  match_labels?: string[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'connection-error'; message: string }
  | { kind: 'ready'; talosVersions: OmniResource<TalosVersionSpec>[]; machineClasses: OmniResource<MachineClassSpec>[] };

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting'; step: string }
  | { kind: 'error'; message: string; clusterResourceCreated: boolean };

type WorkerMode = 'none' | 'explicit' | 'machineClass';

/** Splits a textarea of one-machine-id-per-line into a clean, de-duplicated list. */
function parseMachineIds(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/[\n,]/)) {
    const id = line.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

export function ClusterCreate() {
  const history = useHistory();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });

  const [name, setName] = useState('');
  const [talosVersion, setTalosVersion] = useState('');
  const [kubernetesVersion, setKubernetesVersion] = useState('');
  const [controlPlaneMachinesText, setControlPlaneMachinesText] = useState('');
  const [workerMode, setWorkerMode] = useState<WorkerMode>('none');
  const [workerMachinesText, setWorkerMachinesText] = useState('');
  const [workerMachineClass, setWorkerMachineClass] = useState('');
  const [workerCountText, setWorkerCountText] = useState('1');
  const [workerUnlimited, setWorkerUnlimited] = useState(false);

  async function load() {
    setState({ kind: 'loading' });
    const config = configStore.get();
    if (!config?.endpoint) {
      setState({ kind: 'connection-error', message: 'Omni endpoint is not configured (see plugin settings).' });
      return;
    }
    try {
      const [{ items: talosVersions }, { items: machineClasses }] = await Promise.all([
        listResources<TalosVersionSpec>({ endpoint: config.endpoint }, 'TalosVersions.omni.sidero.dev', { limit: 200 }),
        listResources<MachineClassSpec>({ endpoint: config.endpoint }, 'MachineClasses.omni.sidero.dev', { limit: 200 }),
      ]);
      talosVersions.sort((a, b) => b.metadata.id.localeCompare(a.metadata.id, undefined, { numeric: true }));
      setState({ kind: 'ready', talosVersions, machineClasses });
    } catch (err) {
      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setState({ kind: 'connection-error', message });
    }
  }

  useEffect(() => {
    load();
  }, []);

  const selectedTalos = state.kind === 'ready' ? state.talosVersions.find(v => v.metadata.id === talosVersion) : undefined;
  const compatibleKubernetesVersions = selectedTalos?.spec.compatible_kubernetes_versions ?? [];

  const controlPlaneMachineIds = parseMachineIds(controlPlaneMachinesText);
  const workerMachineIds = parseMachineIds(workerMachinesText);
  const workerCount = workerCountText.trim() === '' ? NaN : Number(workerCountText);

  let worker: MachineSelection | undefined;
  if (workerMode === 'explicit') {
    worker = { kind: 'explicit', machineIds: workerMachineIds };
  } else if (workerMode === 'machineClass') {
    worker = { kind: 'machineClass', name: workerMachineClass, count: workerUnlimited ? 'unlimited' : workerCount };
  }

  const input: ClusterCreateInput = {
    name,
    talosVersion,
    kubernetesVersion,
    controlPlane: { machineIds: controlPlaneMachineIds },
    worker,
  };

  const errors = validateClusterCreateInput(input, compatibleKubernetesVersions);
  const hasErrors = Object.keys(errors).length > 0;

  async function handleSubmit() {
    const config = configStore.get();
    if (!config?.endpoint || hasErrors) return;

    setSubmitState({ kind: 'submitting', step: 'Starting…' });
    let clusterResourceCreated = false;

    try {
      await createCluster({ endpoint: config.endpoint }, input, (resource: PlannedResource, index, total) => {
        if (resource.type === 'Clusters.omni.sidero.dev') clusterResourceCreated = true;
        setSubmitState({ kind: 'submitting', step: `Creating ${resource.type.split('.')[0]} "${resource.id}" (${index + 1}/${total})…` });
      });
      history.push(`/omni/clusters/${encodeURIComponent(name)}`);
    } catch (err) {
      const message = err instanceof OmniConnectionError ? err.message : String(err);
      setSubmitState({ kind: 'error', message, clusterResourceCreated });
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

  const { talosVersions, machineClasses } = state;
  const submitting = submitState.kind === 'submitting';

  return (
    <Box sx={{ maxWidth: 640 }}>
      <Breadcrumbs sx={{ mb: 2 }}>
        <Link component={RouterLink} to="/omni/clusters">
          Clusters
        </Link>
        <Typography color="text.primary">New Cluster</Typography>
      </Breadcrumbs>

      <Stack spacing={3}>
        <TextField
          label="Cluster name"
          value={name}
          onChange={e => setName(e.target.value)}
          error={!!errors.name}
          helperText={errors.name}
          disabled={submitting}
          fullWidth
        />

        <FormControl fullWidth error={!!errors.talosVersion} disabled={submitting}>
          <InputLabel id="talos-version-label">Talos version</InputLabel>
          <Select
            labelId="talos-version-label"
            label="Talos version"
            value={talosVersion}
            onChange={e => {
              setTalosVersion(e.target.value as string);
              setKubernetesVersion('');
            }}
          >
            {talosVersions.map(v => (
              <MenuItem key={v.metadata.id} value={v.metadata.id}>
                {v.metadata.id}
                {v.spec.deprecated ? ' (deprecated)' : ''}
              </MenuItem>
            ))}
          </Select>
          {errors.talosVersion && <Typography variant="caption" color="error">{errors.talosVersion}</Typography>}
        </FormControl>

        <FormControl fullWidth error={!!errors.kubernetesVersion} disabled={submitting || !talosVersion}>
          <InputLabel id="k8s-version-label">Kubernetes version</InputLabel>
          <Select
            labelId="k8s-version-label"
            label="Kubernetes version"
            value={kubernetesVersion}
            onChange={e => setKubernetesVersion(e.target.value as string)}
          >
            {compatibleKubernetesVersions.map(v => (
              <MenuItem key={v} value={v}>
                {v}
              </MenuItem>
            ))}
          </Select>
          {errors.kubernetesVersion && <Typography variant="caption" color="error">{errors.kubernetesVersion}</Typography>}
          {!errors.kubernetesVersion && talosVersion && (
            <Typography variant="caption" color="text.secondary">
              Only versions compatible with Talos {talosVersion} are listed.
            </Typography>
          )}
        </FormControl>

        <TextField
          label="Control plane machine UUIDs (one per line)"
          value={controlPlaneMachinesText}
          onChange={e => setControlPlaneMachinesText(e.target.value)}
          multiline
          minRows={2}
          error={!!errors.controlPlane}
          helperText={errors.controlPlane || `${controlPlaneMachineIds.length} machine(s) — must be an odd count (etcd requirement).`}
          disabled={submitting}
          fullWidth
        />

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Workers (optional)
          </Typography>
          <RadioGroup row value={workerMode} onChange={e => setWorkerMode(e.target.value as WorkerMode)}>
            <FormControlLabel value="none" control={<Radio disabled={submitting} />} label="None" />
            <FormControlLabel value="explicit" control={<Radio disabled={submitting} />} label="Explicit machines" />
            <FormControlLabel value="machineClass" control={<Radio disabled={submitting} />} label="Machine class allocation" />
          </RadioGroup>

          {workerMode === 'explicit' && (
            <TextField
              label="Worker machine UUIDs (one per line)"
              value={workerMachinesText}
              onChange={e => setWorkerMachinesText(e.target.value)}
              multiline
              minRows={2}
              error={!!errors.worker}
              helperText={errors.worker}
              disabled={submitting}
              fullWidth
              sx={{ mt: 1 }}
            />
          )}

          {workerMode === 'machineClass' && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <FormControl fullWidth error={!!errors.worker} disabled={submitting}>
                <InputLabel id="worker-mc-label">Machine class</InputLabel>
                <Select
                  labelId="worker-mc-label"
                  label="Machine class"
                  value={workerMachineClass}
                  onChange={e => setWorkerMachineClass(e.target.value as string)}
                >
                  {machineClasses.map(mc => (
                    <MenuItem key={mc.metadata.id} value={mc.metadata.id}>
                      {mc.metadata.id}
                    </MenuItem>
                  ))}
                </Select>
                {machineClasses.length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    No machine classes exist yet — create one under Machine Classes first.
                  </Typography>
                )}
                {errors.worker && <Typography variant="caption" color="error">{errors.worker}</Typography>}
              </FormControl>
              <Stack direction="row" spacing={2} alignItems="center">
                <TextField
                  label="Count"
                  type="number"
                  value={workerCountText}
                  onChange={e => setWorkerCountText(e.target.value)}
                  disabled={submitting || workerUnlimited}
                  sx={{ width: 120 }}
                />
                <FormControlLabel
                  control={<Checkbox checked={workerUnlimited} onChange={e => setWorkerUnlimited(e.target.checked)} disabled={submitting} />}
                  label="Unlimited (allocate all matching machines)"
                />
              </Stack>
            </Stack>
          )}
        </Box>

        {submitState.kind === 'submitting' && (
          <Box>
            <LinearProgress sx={{ mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              {submitState.step}
            </Typography>
          </Box>
        )}

        {submitState.kind === 'error' && (
          <Alert severity="error" onClose={() => setSubmitState({ kind: 'idle' })}>
            {submitState.message}
            {submitState.clusterResourceCreated && (
              <>
                {' '}
                The cluster resource was created before this failed — some child resources may be missing.{' '}
                <Link component={RouterLink} to={`/omni/clusters/${encodeURIComponent(name)}`}>
                  View it
                </Link>{' '}
                to inspect or destroy it.
              </>
            )}
          </Alert>
        )}

        <Stack direction="row" spacing={2}>
          <Button variant="contained" disabled={hasErrors || submitting} onClick={handleSubmit}>
            {submitting ? 'Creating…' : 'Create Cluster'}
          </Button>
          <Button variant="outlined" disabled={submitting} onClick={() => history.push('/omni/clusters')}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
