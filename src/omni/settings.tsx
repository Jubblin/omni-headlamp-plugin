/**
 * Plugin settings panel.
 *
 * Only the Omni endpoint URL lives here -- it's non-secret and Headlamp's
 * generic plugin settings persist through its Redux store (ConfigStore),
 * which is NOT sessionStorage. The service account key must never go through
 * this path; it's entered separately (see ConnectPrompt) and written directly
 * to sessionStorage via auth.ts, per the design doc's accepted-risk decision.
 */
import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import { TextField, Typography } from '@mui/material';

export interface OmniPluginConfig {
  endpoint?: string;
  /** "owner/repo" or "owner/repo/path/to/patches" -- see github.ts's parsePatchesPath. */
  githubPatchesPath?: string;
}

export function OmniSettingsComponent(props: PluginSettingsDetailsProps) {
  const data = (props.data as OmniPluginConfig) || {};

  function setEndpoint(value: string) {
    props.onDataChange?.({ ...data, endpoint: value });
  }

  function setGithubPatchesPath(value: string) {
    props.onDataChange?.({ ...data, githubPatchesPath: value });
  }

  return (
    <div>
      <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
        Omni API endpoint. Your Headlamp deployment must also allowlist this URL via the{' '}
        <code>-proxy-urls</code> server flag before requests will succeed.
      </Typography>
      <TextField
        fullWidth
        label="Omni endpoint"
        placeholder="https://your-omni-instance.example.com"
        value={data.endpoint || ''}
        onChange={e => setEndpoint(e.target.value)}
      />
      <Typography variant="caption" color="textSecondary" sx={{ mt: 2, display: 'block' }}>
        The service account key is entered separately, per browser tab, and is never saved here —
        see the "Connect to Omni" prompt on the Config Patches page.
      </Typography>

      <Typography variant="body2" color="textSecondary" sx={{ mt: 3, mb: 1 }}>
        GitHub repo to load ConfigPatches from, for the "Load from GitHub" action on a patch's page.
        Format: <code>owner/repo</code> or <code>owner/repo/path/to/patches</code> (path optional —
        omitted means repo root).
      </Typography>
      <TextField
        fullWidth
        label="GitHub patches path"
        placeholder="owner/repo/path/to/patches"
        value={data.githubPatchesPath || ''}
        onChange={e => setGithubPatchesPath(e.target.value)}
      />
    </div>
  );
}
