#!/usr/bin/env node
/**
 * Drives a running Headlamp+omni-manager instance (see deploy/Dockerfile)
 * with a real headless browser and captures screenshots + a video of the
 * navigation -- both as regression evidence for the build process, and as a
 * functional gate: it fails loudly if the plugin doesn't actually render
 * where it's supposed to.
 *
 * Specifically guards against the two real bugs found and fixed in this
 * plugin's history: the "Omni" sidebar entry silently defaulting to the
 * wrong sidebar bucket (invisible on Home) and routes swapping the sidebar
 * away entirely when navigating between Omni pages. Both were only caught
 * by actually looking at a running instance -- ponytail: this is the
 * runnable check for that class of bug, not a docstring promising it won't
 * happen again.
 *
 * The first four screenshots need no real Omni instance or kubeconfig --
 * every page they visit is reachable before the "Connect to Omni" gate. If
 * OMNI_ENDPOINT and OMNI_SERVICE_ACCOUNT_KEY are set (see Makefile's
 * `screenshots` target, which points these at a disposable throwaway Omni
 * instance -- deploy/test/), a second pass connects for real and captures
 * authenticated screens backed by real Omni API data (a real cluster list,
 * real Talos versions in the create form). Skipped, not failed, when unset,
 * so this still runs secret-free by default.
 *
 * Usage: node scripts/visual-smoke-test.mjs [baseUrl]
 *   baseUrl defaults to http://localhost:4466 (see Makefile's
 *   `screenshots` target for how the container gets there).
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const baseUrl = process.argv[2] ?? 'http://localhost:4466';
const outDir = 'screenshots';

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

/** Fails fast with a clear message instead of a raw Playwright timeout stack. */
async function requireVisible(locator, description) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(`Expected ${description} to be visible, but it wasn't.`);
  }
}

/**
 * Connects to a real Omni instance and captures authenticated screens. Only called when
 * OMNI_ENDPOINT + OMNI_SERVICE_ACCOUNT_KEY are set -- see this file's module doc.
 *
 * The plugin's Omni-endpoint setting is written directly to the same localStorage key its own
 * Settings > Plugins > omni-manager panel persists to (Headlamp's generic plugin ConfigStore),
 * rather than driven through that panel's Save button -- confirmed live (2026-08-23) that the
 * Save button doesn't reliably persist a change in the Headlamp version this was built against;
 * this sidesteps that rather than making the smoke test flaky on an unrelated bug. Worth
 * revisiting if a future Headlamp bump fixes it.
 */
async function runAuthenticatedChecks(page, baseUrl, outDir, omniEndpoint, serviceAccountKey) {
  await page.evaluate(
    ({ endpoint }) => {
      localStorage.setItem('pluginConfigs', JSON.stringify({ 'omni-manager': { endpoint } }));
      sessionStorage.clear();
    },
    { endpoint: omniEndpoint }
  );
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Omni' }).click();

  const keyField = page.getByRole('textbox', { name: 'Service account key' });
  await requireVisible(keyField, 'the "Connect to Omni" service-account-key field');
  await keyField.fill(serviceAccountKey);
  await page.getByRole('button', { name: 'Connect' }).click();

  await requireVisible(
    page.getByRole('button', { name: 'Create Cluster' }),
    'the authenticated Clusters page (real signed API call succeeding)'
  );
  await page.screenshot({ path: `${outDir}/05-authenticated-clusters.png`, fullPage: true });

  await page.getByRole('button', { name: 'Create Cluster' }).click();
  const talosVersionField = page.getByLabel('Talos version');
  await requireVisible(talosVersionField, 'the New Cluster form’s Talos version field');
  await talosVersionField.click();
  await requireVisible(
    page.getByRole('option').first(),
    'at least one real Talos version option (from Omni’s own upstream feed)'
  );
  await page.screenshot({ path: `${outDir}/06-authenticated-cluster-create.png`, fullPage: true });
  await page.keyboard.press('Escape');
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  const omniHomeEntry = page.getByRole('button', { name: 'Omni' });
  await requireVisible(omniHomeEntry, '"Omni" on the pre-cluster Home sidebar');
  await page.screenshot({ path: `${outDir}/01-home-sidebar.png`, fullPage: true });

  await omniHomeEntry.click();
  await requireVisible(page.getByRole('heading', { name: 'Clusters' }), 'the Omni Clusters page');
  await requireVisible(
    page.getByRole('button', { name: 'Config Patches' }),
    'the "Config Patches" sidebar entry (proves the sidebar didn\'t swap away)'
  );
  await page.screenshot({ path: `${outDir}/02-omni-clusters.png`, fullPage: true });

  await page.getByRole('button', { name: 'Config Patches' }).click();
  await requireVisible(
    page.getByRole('heading', { name: 'Config Patches' }),
    'the Omni Config Patches page'
  );
  await requireVisible(
    page.getByRole('button', { name: 'Machine Classes' }),
    'the "Machine Classes" sidebar entry (still on the Omni sidebar, not swapped to cluster nav)'
  );
  await page.screenshot({ path: `${outDir}/03-omni-config-patches.png`, fullPage: true });

  // A hard page.goto with a #/... hash doesn't reliably land on that route --
  // Headlamp's SPA router needs a real in-app navigation (click), same as
  // every other step here.
  await page.getByRole('button', { name: 'Settings' }).click();
  await requireVisible(
    page.getByRole('button', { name: 'Plugins' }),
    'the Settings > Plugins sidebar entry'
  );
  await page.getByRole('button', { name: 'Plugins' }).click();
  await requireVisible(
    page.getByRole('link', { name: /omni-manager/ }),
    'omni-manager in the plugins list'
  );
  await page.screenshot({ path: `${outDir}/04-settings-plugins.png`, fullPage: true });

  const omniEndpoint = process.env.OMNI_ENDPOINT;
  const serviceAccountKey = process.env.OMNI_SERVICE_ACCOUNT_KEY;
  if (omniEndpoint && serviceAccountKey) {
    await runAuthenticatedChecks(page, baseUrl, outDir, omniEndpoint, serviceAccountKey);
  } else {
    console.log(
      'OMNI_ENDPOINT / OMNI_SERVICE_ACCOUNT_KEY not set -- skipping authenticated checks.'
    );
  }

  console.log(`✓ Visual smoke test passed -- screenshots + video written to ${outDir}/`);
} catch (err) {
  await page.screenshot({ path: `${outDir}/FAILURE.png`, fullPage: true }).catch(() => {});
  console.error(`✗ Visual smoke test failed: ${err.message}`);
  console.error(`See ${outDir}/FAILURE.png for the page state at the point of failure.`);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
