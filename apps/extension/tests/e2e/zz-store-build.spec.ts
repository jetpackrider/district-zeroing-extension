/**
 * On demand (HOSTED=1): the store build (`npm run build` -> .output/chrome-mv3), exactly as it is
 * zipped for the Chrome Web Store, in Chromium against the fake DRA page in real-NY mode. The page
 * is served at https://davesredistricting.org by request interception, as in phase10; the only
 * other host allowed is the published data host, which the build must reach on its own default.
 */
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { hasRealNY, ROOT } from './harness';

// STORE_BUILD=opera-mv3 checks the Opera package instead.
const STORE = join(ROOT, '.output', process.env.STORE_BUILD ?? 'chrome-mv3');
const DATA_HOST = 'jetpackrider.github.io';
test.skip(!process.env.HOSTED, 'store-build check only on demand (it downloads from the data host)');
test.skip(!existsSync(join(STORE, 'manifest.json')) || !hasRealNY(), 'run `npm run build` (and fixture:gen with data/NY present) first');

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const WWW = join(ROOT, 'fixture/www');
const VENDOR = join(ROOT, 'node_modules/maplibre-gl/dist');

let context: BrowserContext;
let profile: string;
const outside: string[] = [];

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'zd-store-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${STORE}`, `--load-extension=${STORE}`, '--host-resolver-rules=MAP davesredistricting.org 127.0.0.1, MAP *.davesredistricting.org 127.0.0.1, MAP data.dra2020.net 127.0.0.1'],
  });
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'chrome-extension:' && u.protocol !== 'data:' && u.protocol !== 'blob:' && u.hostname !== 'davesredistricting.org') outside.push(r.url());
  });
  await context.route(/^(https?|wss?):\/\//, async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === DATA_HOST) return route.continue();
    if (u.hostname !== 'davesredistricting.org') return route.abort();
    const [dir, rel] = u.pathname.startsWith('/vendor/') ? [VENDOR, u.pathname.slice('/vendor/'.length)] : [WWW, u.pathname === '/maps' || u.pathname === '/' ? 'index.html' : u.pathname.slice(1)];
    const file = normalize(join(dir, decodeURIComponent(rel)));
    if (!file.startsWith(dir) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
});
test.afterAll(async () => {
  await context?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test('store build: goes live on NY with data from the published host, and contacts nothing else', async () => {
  test.setTimeout(240_000);
  const manifest = JSON.parse(readFileSync(join(STORE, 'manifest.json'), 'utf8'));
  expect(manifest.name).toBe('Zero Deviation');
  expect(manifest.permissions.sort()).toEqual(['sidePanel', 'storage', 'unlimitedStorage']);
  expect(manifest.host_permissions).toEqual(['https://davesredistricting.org/*']);

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  expect(await sw.evaluate(() => chrome.storage.local.get('dataBaseUrl'))).toEqual({});

  const dra = await context.newPage();
  await dra.goto('https://davesredistricting.org/maps?plan=real');
  await dra.waitForFunction(() => (window as any).fakeDra?.ready(), undefined, { timeout: 120_000 });
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('https://davesredistricting.org/maps'))!.id!);

  const panel = await context.newPage();
  const errors: string[] = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?host=popout&tabId=${tabId}`);
  await expect(panel.locator('.zd-panel[data-connection="live"]')).toBeVisible({ timeout: 180_000 });

  await panel.getByTestId('diagnostics').locator('summary').click();
  const diag = panel.getByTestId('diagnostics-text');
  await expect(diag).toContainText(`base URL: https://${DATA_HOST}/zero-deviation-data/v1`, { timeout: 60_000 });
  await expect(diag).toContainText('bundle: NY, DRA data version v08', { timeout: 60_000 });
  await expect(diag).toContainText('all 27 match (incl. Unassigned)', { timeout: 60_000 });
  await expect(diag).toContainText('all required hooks OK');

  // The real UI path: pick the whole map and solve.
  await panel.getByRole('button', { name: 'Whole map' }).click();
  await panel.getByRole('button', { name: /find|plan|solve/i }).first().click();
  await expect(panel.locator('.zd-panel')).toContainText(/Plan 1|already at zero|Every selected district/i, { timeout: 120_000 });

  expect(outside.length).toBeGreaterThan(0);
  expect(outside.filter((u) => new URL(u).hostname !== DATA_HOST)).toEqual([]);
  console.log(`  store build: ${outside.length} requests, all to ${DATA_HOST}`);
  expect(errors).toEqual([]);
});
