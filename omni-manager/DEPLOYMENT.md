# Deploying omni-manager

omni-manager needs **two separate, both-required settings** before it can reach your Omni instance. Missing either one produces the same symptom — the plugin's "Can't reach Omni" connection-error banner (with a Retry button), not a silent empty list — but the fix differs depending on which one is missing:

1. **The Omni endpoint URL**, set per-Headlamp-deployment in the plugin's own settings panel (Headlamp → Settings → Plugins → omni-manager). This is where operators tell the plugin *which* Omni instance to talk to.
2. **The `-proxy-urls` allowlist**, set on the Headlamp *server* itself (not in the plugin). This is a security gate: Headlamp's backend proxies arbitrary external requests through its `/externalproxy` route, and refuses to forward anywhere not explicitly allowlisted by whoever runs the Headlamp deployment. The plugin has no way to bypass this — it's enforced server-side.

The most common first-time-setup mistake is setting one of these and forgetting the other. If Omni's endpoint is configured in the plugin settings but not present in `-proxy-urls`, every request gets rejected by Headlamp's own backend before it ever reaches Omni — this is indistinguishable, from the plugin's perspective, from Omni actually being down, so it surfaces as the same connection-error state.

## Server / Docker deployment

Add your Omni instance's URL to the Headlamp server's `-proxy-urls` flag — a comma-separated glob-pattern allowlist. Match the specific instance URL rather than allowlisting broadly:

```bash
headlamp-server -proxy-urls "https://your-omni-instance.example.com/*"
```

If you're already passing other allowlisted URLs (e.g. `https://artifacthub.io/*` for the official app-catalog/plugin-catalog plugins), append rather than replace:

```bash
headlamp-server -proxy-urls "https://artifacthub.io/*,https://your-omni-instance.example.com/*"
```

Same idea via `docker run`:

```bash
docker run ... ghcr.io/headlamp-k8s/headlamp:latest \
  -proxy-urls "https://your-omni-instance.example.com/*"
```

### Helm chart

The official Headlamp Helm chart has no dedicated values key for `-proxy-urls` — use the generic `config.extraArgs` list to pass it as a raw flag:

```yaml
config:
  extraArgs:
    - "-proxy-urls=https://your-omni-instance.example.com/*"
```

## Electron desktop app

The mechanism is different here: there's no runtime settings UI for `-proxy-urls` in the desktop app — it's build/resource-file only, read from `app-build-manifest.json`'s `proxy-urls` array at launch.

**If you're building Headlamp from source** (the recommended path for a custom Omni URL — see below for why), edit `app/app-build-manifest.json` before building/launching:

```json
{
  "proxy-urls": ["https://artifacthub.io/*", "https://your-omni-instance.example.com/*"]
}
```

**If you're using the official pre-built, signed `.dmg`/installer**, that same file exists inside the installed app bundle (e.g. `Headlamp.app/Contents/Resources/app-build-manifest.json` on macOS) and is technically editable — but doing so invalidates the app's code signature, and macOS Gatekeeper may then refuse to launch it at all ("Headlamp is damaged and can't be opened"). **We don't recommend this.** If you need a custom Omni URL in the Electron app, build Headlamp from source instead (`npm run install:all && npm run app:start` from the [kubernetes-sigs/headlamp](https://github.com/kubernetes-sigs/headlamp) repo) — the dev-mode build never touches a signed binary, so this risk doesn't apply.

## Plugin settings

Once `-proxy-urls` is configured on whichever deployment you're running, set the matching endpoint in the plugin itself: Headlamp → Settings → Plugins → omni-manager → **Omni endpoint**. This is the only thing configured per-plugin; the service account key used to authenticate is intentionally **not** part of this settings panel — it's entered separately (and only ever held in that browser tab's session storage) via the "Connect to Omni" prompt shown on the Config Patches / Machine Classes pages. See `omnictl serviceaccount create <name>` for generating one.
