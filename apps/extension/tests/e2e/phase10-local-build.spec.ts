/**
 * The local build (`npm run build:local` -> local/chrome-mv3) in Chromium against the fake DRA page
 * in real-NY mode, confirming the panel reads the bundle embedded in the extension itself.
 *
 * The local build is a normal (non-test) build: its content scripts only match
 * https://davesredistricting.org/*. So the fake page is served *at that URL* by Playwright's request
 * interception (route.fulfill from fixture files on disk). Nothing reaches the real site: every
 * request that is not fulfilled locally is aborted, and --host-resolver-rules maps DRA's hosts to
 * 127.0.0.1 as a backstop. Skipped when the local build or data/NY is missing.
 */
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { hasRealNY, ROOT } from './harness';

const LOCAL = join(ROOT, 'local/chrome-mv3');
test.skip(!existsSync(join(LOCAL, 'manifest.json')) || !hasRealNY(), 'run `npm run build:local` (and fixture:gen with data/NY present) first');

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const WWW = join(ROOT, 'fixture/www');
const VENDOR = join(ROOT, 'node_modules/maplibre-gl/dist');

let context: BrowserContext;
let profile: string;
const outside: string[] = [];

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'zd-local-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${LOCAL}`, `--load-extension=${LOCAL}`, '--host-resolver-rules=MAP davesredistricting.org 127.0.0.1, MAP *.davesredistricting.org 127.0.0.1, MAP data.dra2020.net 127.0.0.1'],
  });
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'chrome-extension:' && u.protocol !== 'data:' && u.protocol !== 'blob:' && u.hostname !== 'davesredistricting.org') outside.push(r.url());
  });
  // Only web requests are intercepted; the extension's own chrome-extension:// files load normally.
  await context.route(/^(https?|wss?):\/\//, async (route) => {
    const u = new URL(route.request().url());
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

test('local build: the panel reads the NY bundle embedded in the extension, with the store permissions', async () => {
  test.setTimeout(180_000);
  const manifest = JSON.parse(readFileSync(join(LOCAL, 'manifest.json'), 'utf8'));
  expect(manifest.permissions.sort()).toEqual(['sidePanel', 'storage', 'unlimitedStorage']);
  expect(manifest.host_permissions).toEqual(['https://davesredistricting.org/*']);

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  // No storage override: the build's own default (the embedded data) must be what the panel uses.
  expect(await sw.evaluate(() => chrome.storage.local.get('dataBaseUrl'))).toEqual({});

  const dra = await context.newPage();
  await dra.goto('https://davesredistricting.org/maps?plan=real');
  await dra.waitForFunction(() => (window as any).fakeDra?.ready(), undefined, { timeout: 120_000 });
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('https://davesredistricting.org/maps'))!.id!);

  const panel = await context.newPage();
  const errors: string[] = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?host=popout&tabId=${tabId}`);
  await expect(panel.locator('.zd-panel[data-connection="live"]')).toBeVisible({ timeout: 120_000 });

  await panel.getByTestId('diagnostics').locator('summary').click();
  const diag = panel.getByTestId('diagnostics-text');
  await expect(diag).toContainText('(local build)');
  await expect(diag).toContainText(`base URL: chrome-extension://${extId}/data/`, { timeout: 60_000 });
  await expect(diag).toContainText('bundle: NY, DRA data version v08', { timeout: 60_000 });
  await expect(diag).toContainText('288,819 blocks, 14,191 precincts, 62 counties');
  // The embedded bundle's populations match DRA's district by district (Unassigned + 26 districts).
  await expect(diag).toContainText('all 27 match (incl. Unassigned)', { timeout: 60_000 });
  await expect(diag).toContainText('all required hooks OK');

  // The embedded files really are served from the extension package.
  const fetched = await panel.evaluate(async () => {
    const r = await fetch(chrome.runtime.getURL('data/NY/manifest.json'));
    return { ok: r.ok, state: (await r.json()).state };
  });
  expect(fetched).toEqual({ ok: true, state: 'NY' });
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});
