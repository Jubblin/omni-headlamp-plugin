/**
 * Non-modal, dismissible warning shown when the active per-user (Auth0/ECDSA)
 * session is close to its ~7h50m expiry -- the re-auth UX called for
 * alongside userAuth.ts. A no-op whenever the active credential is the
 * PGP/service-account one (auth.ts), since that path has no expiry.
 *
 * Deliberately NOT a hard redirect, unlike Omni's own frontend
 * (frontend/src/methods/key.ts's useWatchKeyExpiry: the instant the key
 * expires, it fires `window.location.replace(...)` straight to
 * /authenticate, with zero warning). That's a reasonable choice for Omni's
 * own single-purpose app, but this plugin sits inside Headlamp next to
 * whatever else the user has open -- a diff mid-edit in ResourceDetail.tsx,
 * for instance, whose own dirty-nav-guard (the <Prompt> there) exists for
 * exactly the same "don't silently discard work" reason this component
 * does. So instead: warn well before expiry, let the user pick their own
 * moment to reconnect (which still requires a full Auth0 redirect -- that
 * part can't be avoided, only *deferred* to a convenient time), and never
 * force a redirect out from under them. If the key actually expires before
 * they reconnect, the next signed request just fails with the same
 * OmniConnectionError/401 handling every other rejection already goes
 * through -- no special-cased silent failure.
 *
 * Mounted once per route in index.tsx (all four Omni routes), so it's
 * visible regardless of which Omni page is open.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { Alert, Button, Snackbar } from '@mui/material';
import { useEffect, useState } from 'react';
import { loadServiceAccount } from './auth';
import { getAuthConfig } from './client';
import { OmniPluginConfig } from './settings';
import { loadUserSession, startAuth0Login } from './userAuth';

/** Start warning this far ahead of expiry. */
const WARNING_WINDOW_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

const configStore = new ConfigStore<OmniPluginConfig>('omni-manager');

type WarningState = { kind: 'hidden' } | { kind: 'warning'; minutesLeft: number } | { kind: 'expired' };

export function SessionExpiryWarning() {
  const [state, setState] = useState<WarningState>({ kind: 'hidden' });
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // A service-account (PGP) credential, if present, always wins over an
      // Auth0/ECDSA session (see client.ts's module doc) -- that path has no
      // expiry, so this warning would otherwise false-alarm about a session
      // that isn't even the one being used to sign requests.
      const account = await loadServiceAccount();
      if (cancelled) {
        return;
      }
      if (account) {
        setState({ kind: 'hidden' });
        setDismissed(false); // re-arm for the next time a per-user session actually needs a warning
        return;
      }
      const session = await loadUserSession();
      if (cancelled) {
        return;
      }
      if (!session) {
        setState({ kind: 'hidden' });
        setDismissed(false);
        return;
      }
      const msLeft = session.keyExpirationTime - Date.now();
      if (msLeft <= 0) {
        // Always re-arm on 'expired' -- a dismissed "expires soon" toast
        // shouldn't also suppress the more urgent "has expired" one.
        setDismissed(false);
        setState({ kind: 'expired' });
      } else if (msLeft <= WARNING_WINDOW_MS) {
        setState({ kind: 'warning', minutesLeft: Math.max(1, Math.round(msLeft / 60000)) });
      } else {
        setState({ kind: 'hidden' });
        setDismissed(false);
      }
    }

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleReconnect() {
    setError(null);
    setReconnecting(true);
    try {
      const config = configStore.get();
      if (!config?.endpoint) {
        throw new Error('Omni endpoint is not configured.');
      }
      const authConfig = await getAuthConfig({ endpoint: config.endpoint });
      if (!authConfig.auth0?.enabled || !authConfig.auth0.domain || !authConfig.auth0.client_id) {
        throw new Error('This Omni instance is no longer configured for Auth0 login.');
      }
      // Redirects the browser away -- nothing after this line runs on success.
      await startAuth0Login({ domain: authConfig.auth0.domain, clientId: authConfig.auth0.client_id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReconnecting(false);
    }
  }

  if (state.kind === 'hidden' || dismissed) {
    return null;
  }

  return (
    <Snackbar open anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }} onClose={() => setDismissed(true)}>
      <Alert
        severity={state.kind === 'expired' ? 'error' : 'warning'}
        onClose={() => setDismissed(true)}
        action={
          <Button color="inherit" size="small" disabled={reconnecting} onClick={handleReconnect}>
            {reconnecting ? 'Redirecting…' : 'Reconnect'}
          </Button>
        }
      >
        {error
          ? error
          : state.kind === 'expired'
            ? 'Your Omni sign-in has expired. Finish or save any in-progress edits, then reconnect.'
            : `Your Omni sign-in expires in about ${state.minutesLeft} minute${
                state.minutesLeft === 1 ? '' : 's'
              }. Reconnect whenever it's convenient — this won't interrupt you automatically.`}
      </Alert>
    </Snackbar>
  );
}
