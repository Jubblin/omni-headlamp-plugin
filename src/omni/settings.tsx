/**
 * Plugin settings panel.
 *
 * Only the Omni endpoint URL lives here -- it's non-secret and Headlamp's
 * generic plugin settings persist through its Redux store (ConfigStore),
 * which is NOT sessionStorage. The service account key must never go through
 * this path; it's entered separately (see ConnectPrompt) and written directly
 * to sessionStorage via auth.ts, per the design doc's accepted-risk decision.
 */
import { TextField, Typography } from '@mui/material';
import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';

export interface OmniPluginConfig {
  endpoint?: string;
}

export function OmniSettingsComponent(props: PluginSettingsDetailsProps) {
  const data = (props.data as OmniPluginConfig) || {};

  function setEndpoint(value: string) {
    props.onDataChange?.({ ...data, endpoint: value });
  }

  return (
    <div>
      <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
        Omni API endpoint. Your Headlamp deployment must also allowlist this URL via
        the <code>-proxy-urls</code> server flag before requests will succeed.
      </Typography>
      <TextField
        fullWidth
        label="Omni endpoint"
        placeholder="https://your-omni-instance.example.com"
        value={data.endpoint || ''}
        onChange={e => setEndpoint(e.target.value)}
      />
      <Typography variant="caption" color="textSecondary" sx={{ mt: 2, display: 'block' }}>
        The service account key is entered separately, per browser tab, and is never
        saved here — see the "Connect to Omni" prompt on the Config Patches page.
      </Typography>
    </div>
  );
}
