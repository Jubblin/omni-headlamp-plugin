/**
 * One-time-per-tab prompt for the Omni service account key. Writes directly
 * to sessionStorage (auth.ts) -- never routed through Headlamp's generic
 * plugin settings persistence, which is not sessionStorage-scoped.
 */
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { parseServiceAccountKey, storeServiceAccountKey } from './auth';

export function ConnectPrompt({ onConnected }: { onConnected: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleConnect() {
    setError(null);
    setChecking(true);
    try {
      // Parse-only validation here -- confirms the pasted value decodes into
      // a usable PGP key before we commit it to sessionStorage. This does NOT
      // verify Omni accepts it; that only happens on the first real request
      // (see design doc Next Steps #3d — unverified against a live instance).
      await parseServiceAccountKey(value);
      storeServiceAccountKey(value);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Box sx={{ maxWidth: 480, mx: 'auto', mt: 6 }}>
      <Typography variant="h6" gutterBottom>
        Connect to Omni
      </Typography>
      <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
        Paste the value printed by <code>omnictl serviceaccount create &lt;name&gt;</code> (the{' '}
        <code>OMNI_SERVICE_ACCOUNT_KEY</code> line). Held in this browser tab's session storage
        only — cleared when the tab closes, never sent anywhere except signed Omni requests.
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <TextField
        fullWidth
        multiline
        minRows={3}
        label="Service account key"
        value={value}
        onChange={e => setValue(e.target.value)}
        sx={{ mb: 2 }}
      />
      <Button variant="contained" disabled={!value || checking} onClick={handleConnect}>
        {checking ? 'Checking…' : 'Connect'}
      </Button>
    </Box>
  );
}
