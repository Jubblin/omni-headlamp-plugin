/**
 * One-time-per-tab/session prompt for Omni credentials. Offers BOTH
 * authentication paths this plugin supports, side by side:
 *  - Paste a service-account key (writes to sessionStorage via auth.ts) --
 *    the original flow, unchanged.
 *  - Log in via Auth0 (userAuth.ts) -- the per-user path that mirrors
 *    Omni's own first-party web UI, offered only when the configured Omni
 *    instance's AuthConfig actually has Auth0 enabled (discovered via
 *    client.ts's unsigned getAuthConfig call -- see that function's doc
 *    comment).
 *
 * Also doubles as the Auth0 redirect CALLBACK handler: when this component
 * mounts and the current URL carries an Auth0 authorization code (see
 * userAuth.ts's isAuth0Callback), it resumes the login automatically instead
 * of showing either connect option -- this works because
 * userAuth.ts's startAuth0Login deliberately redirects back to the exact
 * route that started the flow (see that function's doc comment), which is
 * the same route that renders this component whenever no credential exists
 * yet.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { Alert, Box, Button, Divider, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { parseServiceAccountKey, storeServiceAccountKey } from './auth';
import { getAuthConfig, OmniAuthConfigSpec } from './client';
import { OmniPluginConfig } from './settings';
import {
  completeAuth0Login,
  confirmAndStoreUserSession,
  createUserKeyPair,
  isAuth0Callback,
  startAuth0Login,
} from './userAuth';

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

export function ConnectPrompt({ onConnected }: { onConnected: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [authConfig, setAuthConfig] = useState<OmniAuthConfigSpec | null>(null);
  const [auth0Starting, setAuth0Starting] = useState(false);
  const [auth0Error, setAuth0Error] = useState<string | null>(null);

  // Captured once at mount: isAuth0Callback() reads the URL, which
  // completeAuth0Login (below) strips the code/state params from -- reading
  // it again on a later render would always see the already-cleaned URL.
  const [resumingCallback, setResumingCallback] = useState(() => isAuth0Callback());
  const [resumeError, setResumeError] = useState<string | null>(null);

  const endpoint = configStore.get()?.endpoint;

  // Discover whether Auth0 is even available, purely to decide whether to
  // show the button. Failures here just leave the button hidden -- never
  // surfaced as an error, since the paste-key flow remains fully usable
  // regardless of whether this discovery call succeeds.
  useEffect(() => {
    if (!endpoint || resumingCallback) {
      return;
    }
    let cancelled = false;
    getAuthConfig({ endpoint }).then(
      config => {
        if (!cancelled) {
          setAuthConfig(config);
        }
      },
      () => {
        /* Auth0 option just stays hidden -- see comment above. */
      }
    );
    return () => {
      cancelled = true;
    };
  }, [endpoint, resumingCallback]);

  // Resume an in-progress Auth0 login. See this component's module doc for
  // why the callback reliably lands on this exact component.
  useEffect(() => {
    if (!resumingCallback || !endpoint) {
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const config = await getAuthConfig({ endpoint });
        if (!config.auth0?.enabled || !config.auth0.domain || !config.auth0.client_id) {
          throw new Error('This Omni instance is no longer configured for Auth0 login.');
        }
        const auth0Config = { domain: config.auth0.domain, clientId: config.auth0.client_id };
        const identity = await completeAuth0Login(auth0Config);
        const pending = await createUserKeyPair({ endpoint }, identity.email);
        await confirmAndStoreUserSession({ endpoint }, pending, identity);
        if (!cancelled) {
          onConnected();
        }
      } catch (err) {
        // completeAuth0Login cleans the code/state params from the URL as its
        // first step, but a failure here (e.g. getAuthConfig itself) can
        // throw before that ever runs -- clean up here too, so a page refresh
        // after a failed resume doesn't re-attempt redeeming the same
        // one-time-use code.
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
        if (!cancelled) {
          setResumeError(err instanceof Error ? err.message : String(err));
          setResumingCallback(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumingCallback, endpoint]);

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

  async function handleAuth0Login() {
    setAuth0Error(null);
    setAuth0Starting(true);
    try {
      if (!endpoint) {
        throw new Error('Omni endpoint is not configured (see plugin settings).');
      }
      if (!authConfig?.auth0?.domain || !authConfig.auth0.client_id) {
        throw new Error('This Omni instance is not configured for Auth0 login.');
      }
      // Redirects the browser away -- nothing after this line runs on success.
      await startAuth0Login({
        domain: authConfig.auth0.domain,
        clientId: authConfig.auth0.client_id,
      });
    } catch (err) {
      setAuth0Error(err instanceof Error ? err.message : String(err));
      setAuth0Starting(false);
    }
  }

  if (resumingCallback) {
    return (
      <Box sx={{ maxWidth: 480, mx: 'auto', mt: 6 }}>
        <Typography variant="body2" color="textSecondary">
          Completing Auth0 sign-in…
        </Typography>
      </Box>
    );
  }

  const redirectUri =
    typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';

  return (
    <Box sx={{ maxWidth: 480, mx: 'auto', mt: 6 }}>
      <Typography variant="h6" gutterBottom>
        Connect to Omni
      </Typography>

      {resumeError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {resumeError}
        </Alert>
      )}

      {authConfig?.auth0?.enabled && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            Log in with your own Omni account — per-user, with a real audit trail, the same way
            Omni's own web UI authenticates you. You'll be redirected to Auth0 and back.
          </Typography>
          {auth0Error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {auth0Error}
            </Alert>
          )}
          <Button variant="contained" disabled={auth0Starting} onClick={handleAuth0Login}>
            {auth0Starting ? 'Redirecting…' : 'Log in via Auth0'}
          </Button>
          <Typography variant="caption" color="textSecondary" sx={{ mt: 1, display: 'block' }}>
            First time from this Headlamp deployment? Your Omni admin needs to add{' '}
            <code>{redirectUri}</code> to this Auth0 application's Allowed Callback URLs (and
            Allowed Web Origins) — Auth0 rejects logins from URLs it doesn't recognize.
          </Typography>
          <Divider sx={{ mt: 3 }}>or use a service account key</Divider>
        </Box>
      )}

      <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
        Paste the value printed by <code>omnictl serviceaccount create &lt;name&gt;</code> (the{' '}
        <code>OMNI_SERVICE_ACCOUNT_KEY</code> line). Held in this browser tab's session storage only
        — cleared when the tab closes, never sent anywhere except signed Omni requests.
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
