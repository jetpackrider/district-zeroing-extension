/**
 * Test harness: serves the fixture on a free port, launches Chromium with the TEST build of the
 * extension (.output-test/chrome-mv3), and opens the fake DRA page plus the panel page.
 */
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const EXT = join(ROOT, '.output-test/chrome-mv3');

export interface Harness {
  url: string;
  dataUrl: string;
  context: BrowserContext;
  sw: Worker;
  extId: string;
  close: () => Promise<void>;
}

export async function startServer(opts: { data?: string } = {}): Promise<{ url: string; data: string; proc: ChildProcess }> {
  const args = [join(ROOT, 'scripts/serve.mjs'), ...(opts.data ? ['--data', opts.data] : [])];
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise<string>((res, rej) => {
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) res(buf.slice(0, i));
    });
    proc.on('exit', (c) => rej(new Error(`server exited ${c}`)));
  });
  const { url, data } = JSON.parse(line);
  return { url, data, proc };
}

/** Repo-level data/ (the real pipeline output). Tests may only read data/NY. */
export const REAL_DATA = resolve(ROOT, '../../data');
export const hasRealNY = () => existsSync(join(REAL_DATA, 'NY/manifest.json')) && existsSync(join(ROOT, 'fixture/www/plan-real-ny.json'));

export async function launch(opts: { data?: string; scale?: number } = {}): Promise<Harness> {
  if (!existsSync(join(EXT, 'manifest.json'))) throw new Error('Build the test extension first: npm run build:test');
  const server = await startServer(opts);
  const profile = mkdtempSync(join(tmpdir(), 'zd-pw-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: opts.scale ?? 1,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await sw.evaluate((data) => chrome.storage.local.set({ dataBaseUrl: data, miniMapTiles: '' }), server.data);
  return {
    url: server.url,
    dataUrl: server.data,
    context,
    sw,
    extId,
    close: async () => {
      await context.close();
      server.proc.kill('SIGTERM');
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

let pageCounter = 0;

/** Opens the fake DRA page (with query options) and waits until its plan is "open". */
export async function openDra(h: Harness, query = '', timeout = 30_000): Promise<Page> {
  const page = await h.context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('[zd]')) console.log(`[dra page] ${m.text()}`);
  });
  const run = `run=${++pageCounter}`;
  await page.goto(`${h.url}/index.html?${query ? `${query}&` : ''}${run}`);
  await page.waitForFunction(() => (window as any).fakeDra?.ready(), undefined, { timeout });
  return page;
}

export async function tabIdOf(h: Harness, page: Page): Promise<number> {
  const url = page.url();
  return h.sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === u)!.id!;
  }, url);
}

/** Opens the panel page as the pop-out host bound to the DRA tab. */
export async function openPanel(h: Harness, dra: Page): Promise<Page> {
  const tabId = await tabIdOf(h, dra);
  const panel = await h.context.newPage();
  panel.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[panel] ${m.text()}`);
  });
  panel.on('pageerror', (e) => console.log(`[panel error] ${e.message}`));
  await panel.goto(`chrome-extension://${h.extId}/sidepanel.html?host=popout&tabId=${tabId}`);
  await panel.waitForFunction(() => !!(window as any).__zd);
  return panel;
}

export const state = (panel: Page) => panel.evaluate(() => (window as any).__zd.getState());
export const dispatch = (panel: Page, action: unknown) => panel.evaluate((a) => (window as any).__zd.dispatch(a), action);
export const probe = (panel: Page) => panel.evaluate(() => (window as any).__zd.probeHighlight());

/** Polls the panel controller's state from the test side (extension CSP forbids eval in the page). */
export async function waitState(panel: Page, pred: (s: any) => boolean, timeout = 20_000): Promise<any> {
  const t0 = Date.now();
  let last: any;
  for (;;) {
    last = await state(panel);
    if (pred(last)) return last;
    if (Date.now() - t0 > timeout) throw new Error(`waitState timed out; last state: ${JSON.stringify({ connection: last.connection, notice: last.notice, solve: last.solve, walkthrough: last.walkthrough && { current: last.walkthrough.current, statuses: last.walkthrough.steps.map((x: any) => x.status) } })}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeout = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - t0 > timeout) throw new Error(`until() timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Closes every page (between tests). */
export async function closePages(h: Harness) {
  for (const p of h.context.pages()) await p.close().catch(() => {});
}

export const debug = (panel: Page) => panel.evaluate(() => (window as any).__zd.debug());

/** Waits until the panel is live with data loaded and the assignment built. */
export async function ready(panel: Page) {
  await waitState(panel, (s) => s.connection === 'live' && s.solve.status === 'idle');
  await until(() => debug(panel), (d) => d.assignmentReady);
}

export async function solveOne(panel: Page, district: number) {
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district } });
  await dispatch(panel, { type: 'solve' });
  return waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 40_000);
}

/** Paints one walkthrough step by hand in the fake DRA (whole precinct, or block by block + commit). */
export async function paintStep(dra: Page, step: any, opts: { commit?: boolean } = {}) {
  if (step.wholePrecinct) {
    await dra.evaluate(([pid, d]) => (window as any).fakeDra.paintPrecinct(pid, d), [step.precinctId, step.to]);
    return;
  }
  for (const b of step.blocks) await dra.evaluate(([g, d]) => (window as any).fakeDra.paintBlock(g, d), [b.geoid, step.to]);
  if (opts.commit !== false) await dra.evaluate(() => (window as any).fakeDra.commit());
}

/** Plays a whole walkthrough by painting each current step until all are done. */
export async function playWalkthrough(panel: Page, dra: Page) {
  for (let guard = 0; guard < 200; guard++) {
    const s = await state(panel);
    const w = s.walkthrough;
    if (w.steps.every((x: any) => x.status === 'done')) return waitState(panel, (t) => !!t.walkthrough?.finalCheck);
    const step = w.steps[w.current];
    await paintStep(dra, step);
    await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === step.id).status === 'done');
  }
  throw new Error('walkthrough did not finish');
}

export const isZeroedPop = (pop: number, total: number, k: number) => {
  const q = Math.floor(total / k);
  return pop === q || (total % k > 0 && pop === q + 1);
};
