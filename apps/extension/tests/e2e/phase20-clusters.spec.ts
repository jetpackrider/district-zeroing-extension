/**
 * Phase 20, county clusters (PanelState.clusters, contracts/clusters.ts): split a state into groups
 * of whole, contiguous counties holding close to a whole number of districts each.
 *
 * Fixture (two counties, four districts): the map layers. Hovering draws the outlines on DRA's map
 * under the area and highlight layers, they survive a re-render and a basemap switch, and they go
 * when the panel closes; data without county outlines says so and the list still works.
 *
 * Real New York (?plan=real over data/NY: 62 counties, 26 districts): clusters for the 26 seats
 * and for a 150-seat Assembly at ±5%, checked against the bundle (every clustering covers New York
 * once with contiguous clusters within tolerance), hover outlines, a cluster as the swap area with
 * Only, and cancel. Skipped without data/NY. When data/NY has no county outlines yet, the real-data
 * part serves a copy of it with stand-in outlines (each county's bounding box) so drawing is tested.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import type { StateBundle } from '@zd/contracts';
import { toEngineGraph } from '@zd/bundle';
import { NodeBundleSource } from '@zd/bundle/node';
import { countiesConnected, countyAdjacency } from '../../src/panel/clusters';
import { closePages, debug, dispatch, hasRealNY, launch, openDra, openPanel, probe, ready, REAL_DATA, state, until, waitState, type Harness } from './harness';

const clustersDone = (panel: Page, timeout = 60_000) => waitState(panel, (s) => !!s.clusters && s.clusters.status !== 'finding', timeout);
const clusterStatus = async (panel: Page) => (await probe(panel)).clusters;

test.describe('fixture', () => {
  let h: Harness;
  test.beforeAll(async () => (h = await launch()));
  test.beforeEach(async () => {
    await h.sw.evaluate(() => chrome.storage.local.remove(['areas', 'districtLocks']));
  });
  test.afterEach(async () => closePages(h));
  test.afterAll(async () => h?.close());

  test('hover outlines the clustering on DRA’s map under the other layers, and they go with the panel', async () => {
    const dra = await openDra(h);
    let panel = await openPanel(h, dra);
    await ready(panel);
    expect((await state(panel)).clusters).toBeUndefined();

    await dispatch(panel, { type: 'clusters-find', numDistricts: 4, tolerance: 0.05 });
    const s = await clustersDone(panel);
    expect(s.clusters.status).toBe('done');
    expect(s.clusters.numDistricts).toBe(4);
    expect(s.clusters.tolerance).toBe(0.05);
    // The whole state as one cluster always fits (its average is the district size exactly).
    expect(s.clusters.results.length).toBeGreaterThan(0);
    for (const c of s.clusters.results) {
      expect(c.clusters.flatMap((x: any) => x.counties).sort()).toEqual([0, 1]);
      expect(c.clusters.reduce((t: number, x: any) => t + x.districts, 0)).toBe(4);
      expect(c.countyNames.flat().sort()).toEqual(['East County', 'West County']);
    }
    const best = s.clusters.results[0];
    await dispatch(panel, { type: 'clusters-hover', id: best.id });
    const drawn = 2 + best.clusters.length; // a polygon per county, a label per cluster
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === drawn);
    expect((await state(panel)).clusters.hovered).toEqual({ id: best.id });

    // With a walkthrough highlight and the cluster outlines both up, ours stay under the highlights.
    await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
    await dispatch(panel, { type: 'solve' });
    const solved = await waitState(panel, (x) => x.solve.status === 'done' && x.solutions.length > 0, 40_000);
    await dispatch(panel, { type: 'hover-solution', id: solved.solutions[0].id });
    await until(() => probe(panel), (p: any) => p.featureCount > 0 && p.clusters?.featureCount === drawn);
    const order = async () => (await dra.evaluate(() => (window as any).fakeDra.layerIds())) as string[];
    const below = (ids: string[]) => ids.indexOf('zd-cluster-fill') >= 0 && ids.indexOf('zd-cluster-fill') < ids.indexOf('zd-fill') && ids.indexOf('zd-cluster-line') < ids.indexOf('zd-fill');
    await until(order, below);

    // DRA re-renders, and a basemap switch drops every layer: ours come back, still under the highlights.
    await dra.evaluate(() => (window as any).fakeDra.rerender());
    await dra.evaluate(() => (window as any).fakeDra.switchBasemap());
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === drawn && c.layers.includes('zd-cluster-fill'));
    await until(order, below);

    // One cluster emphasized: the same outlines, that cluster marked.
    await dispatch(panel, { type: 'clusters-hover', id: best.id, cluster: 0 });
    await waitState(panel, (x) => x.clusters.hovered?.cluster === 0);
    expect((await clusterStatus(panel)).featureCount).toBe(drawn);

    // Hover off: the layers come off the map.
    await dispatch(panel, { type: 'clusters-hover', id: null });
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === 0 && c.layers.length === 0);
    expect((await state(panel)).clusters.hovered).toBeUndefined();

    // Closing the panel takes them off too.
    await dispatch(panel, { type: 'clusters-hover', id: best.id });
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === drawn);
    await panel.close();
    await until(async () => (await dra.evaluate(() => (window as any).fakeDra.layerIds())) as string[], (ids) => !ids.some((id) => id.startsWith('zd-cluster')));
    panel = await openPanel(h, dra);
    await ready(panel);
    expect((await clusterStatus(panel)).featureCount).toBe(0);
  });

  test('data without county outlines: the list works and the message says why nothing is drawn', async () => {
    const manifestUrl = new URL('NY/manifest.json', h.dataUrl).href;
    await h.context.route(manifestUrl, async (route) => {
      const response = await route.fetch();
      const manifest = await response.json();
      delete manifest.outlines;
      await route.fulfill({ response, json: manifest });
    });
    try {
      const dra = await openDra(h);
      const panel = await openPanel(h, dra);
      await ready(panel);
      await dispatch(panel, { type: 'clusters-find', numDistricts: 4, tolerance: 0.05 });
      const s = await clustersDone(panel);
      expect(s.clusters.status).toBe('done');
      expect(s.clusters.results.length).toBeGreaterThan(0);
      await dispatch(panel, { type: 'clusters-hover', id: s.clusters.results[0].id });
      const after = await waitState(panel, (x) => /no county outlines/i.test(x.clusters.message ?? ''));
      expect(after.clusters.results).toEqual(s.clusters.results);
      expect((await clusterStatus(panel)).featureCount).toBe(0);
    } finally {
      await h.context.unroute(manifestUrl);
    }
  });

  test('county outlines that fail to load: the message says so again after a new search', async () => {
    const manifestUrl = new URL('NY/manifest.json', h.dataUrl).href;
    await h.context.route(manifestUrl, async (route) => {
      const response = await route.fetch();
      const manifest = await response.json();
      // Listed but not on the data host (as on a half-restaged host): the read fails.
      const sha = '0'.repeat(64);
      manifest.outlines = { ...manifest.outlines, file: `outlines.${sha}.json.gz`, sha256: sha };
      await route.fulfill({ response, json: manifest });
    });
    try {
      const dra = await openDra(h);
      const panel = await openPanel(h, dra);
      await ready(panel);
      const failed = (x: any) => /outlines could not be loaded/i.test(x.clusters?.message ?? '');
      await dispatch(panel, { type: 'clusters-find', numDistricts: 4, tolerance: 0.05 });
      const s = await clustersDone(panel);
      expect(s.clusters.status).toBe('done');
      await dispatch(panel, { type: 'clusters-hover', id: s.clusters.results[0].id });
      await waitState(panel, failed);
      // A new search clears the note; the next hover (the failed read is kept) says it again.
      await dispatch(panel, { type: 'clusters-find', numDistricts: 4, tolerance: 0.1 });
      const s2 = await waitState(panel, (x) => x.clusters?.status === 'done' && x.clusters.tolerance === 0.1);
      expect(failed(s2)).toBe(false);
      await dispatch(panel, { type: 'clusters-hover', id: s2.clusters.results[0].id });
      await waitState(panel, failed);
      expect((await clusterStatus(panel)).featureCount).toBe(0);
    } finally {
      await h.context.unroute(manifestUrl);
    }
  });

  test('refuses a district count or tolerance it cannot search', async () => {
    const dra = await openDra(h);
    const panel = await openPanel(h, dra);
    await ready(panel);
    await dispatch(panel, { type: 'clusters-find', numDistricts: 0, tolerance: 0.05 });
    expect((await waitState(panel, (x) => x.clusters?.status === 'error')).clusters.message).toMatch(/whole number/);
    await dispatch(panel, { type: 'clusters-find', numDistricts: 4, tolerance: 0 });
    expect((await waitState(panel, (x) => x.clusters?.status === 'error' && /tolerance/.test(x.clusters.message))).clusters.results).toEqual([]);
  });

  test('through the panel card: find, hover outlines on the map, use a cluster as the swap area', async () => {
    const dra = await openDra(h);
    const panel = await openPanel(h, dra);
    await ready(panel);
    const root = panel.locator('#root');
    await root.getByTestId('clusters-toggle').click();
    // Defaults: the open map's district count, ±5%.
    await expect(root.getByTestId('clusters-districts')).toHaveValue(String((await state(panel)).map.numDistricts));
    await root.getByTestId('clusters-find').click();
    const s = await clustersDone(panel);
    expect(s.clusters).toMatchObject({ status: 'done', numDistricts: 4, tolerance: 0.05 });
    await expect(root.getByTestId('clustering-row')).toHaveCount(s.clusters.results.length);

    // Hovering an option outlines it on DRA's map; leaving takes it off.
    const best = s.clusters.results[0];
    const row = root.getByTestId('clustering-row').first();
    await row.hover();
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === 2 + best.clusters.length);
    expect((await state(panel)).clusters.hovered).toEqual({ id: best.id });
    await root.getByTestId('clusters-toggle').hover();
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === 0);

    // Expand it: each cluster with its county names; "Use as area" makes it the area.
    await row.click();
    const cluster = root.getByTestId('cluster-row').first();
    await expect(cluster.getByTestId('cluster-names')).toHaveText(best.countyNames[0].join(', '));
    await cluster.getByTestId('cluster-use-as-area').click();
    const withArea = await waitState(panel, (x) => !!x.area?.cluster && x.area.blocks !== undefined);
    expect(withArea.area.cluster.counties).toEqual(best.clusters[0].counties);
    await expect(cluster.getByTestId('cluster-is-area')).toBeVisible();
    await expect(root.getByTestId('area-cluster-name')).toHaveText(withArea.area.cluster.name);
    await root.getByTestId('area-clear-btn').click();
    await waitState(panel, (x) => !x.area);
  });
});

test.describe('real New York', () => {
  test.skip(!hasRealNY(), 'data/NY or fixture/www/plan-real-ny.json missing (run npm run fixture:gen with data/NY present)');
  test.describe.configure({ mode: 'serial' });

  let h: Harness;
  let dra: Page;
  let panel: Page;
  let ny: StateBundle;
  let adjacency: number[][];
  let tmpData: string | null = null;
  const results: Record<number, any> = {};

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ny = await new NodeBundleSource(REAL_DATA).loadState('NY');
    adjacency = countyAdjacency(toEngineGraph(ny, 'D20F'), ny.countyFips.length);
    let data = REAL_DATA;
    if (!ny.manifest.outlines) {
      // Stand-in outlines: each county's bounding box (from its block points).
      tmpData = mkdtempSync(join(tmpdir(), 'zd-clusters-'));
      cpSync(join(REAL_DATA, 'NY'), join(tmpData, 'NY'), { recursive: true });
      const box = ny.countyFips.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
      for (let i = 0; i < ny.n; i++) {
        const b = box[ny.countyOf[i]];
        const x = ny.points![2 * i] / 1e6;
        const y = ny.points![2 * i + 1] / 1e6;
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x);
        b[3] = Math.max(b[3], y);
      }
      const fc = {
        type: 'FeatureCollection',
        features: box.map(([w, s, e, n], i) => ({ type: 'Feature', id: i, properties: { fips: ny.countyFips[i] }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } })),
      };
      const gz = gzipSync(Buffer.from(JSON.stringify(fc)));
      const sha = createHash('sha256').update(gz).digest('hex');
      writeFileSync(join(tmpData, 'NY', `outlines.${sha}.json.gz`), gz);
      const manifestPath = join(tmpData, 'NY', 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.outlines = { file: `outlines.${sha}.json.gz`, sha256: sha, bytes: gz.length };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      data = tmpData;
    }
    h = await launch({ data });
    await h.sw.evaluate(() => chrome.storage.local.remove(['areas', 'districtLocks']));
    dra = await openDra(h, 'plan=real', 120_000);
    panel = await openPanel(h, dra);
    await until(() => debug(panel), (d) => d.assignmentReady, 120_000);
    await waitState(panel, (s) => s.connection === 'live' && s.solve.status === 'idle', 120_000);
  });
  test.afterAll(async () => {
    await h?.close();
    if (tmpData) rmSync(tmpData, { recursive: true, force: true });
  });

  /** Every clustering covers New York's 62 counties once, with contiguous clusters within tolerance. */
  async function checkClusters(numDistricts: number, tolerance: number) {
    const s = await state(panel);
    const field = s.map.popField as 'D20F' | 'D20FA';
    const pop = ny.pop[field];
    const countyPop = new Array(ny.countyFips.length).fill(0);
    for (let i = 0; i < ny.n; i++) countyPop[ny.countyOf[i]] += pop[i];
    const total = countyPop.reduce((a, b) => a + b, 0);
    const size = total / numDistricts;
    const c = s.clusters;
    expect(c.status).toBe('done');
    expect(c.numDistricts).toBe(numDistricts);
    expect(c.districtSize).toBeCloseTo(size, 6);
    expect(c.results.length).toBeGreaterThan(0);
    for (const clustering of c.results) {
      const all = clustering.clusters.flatMap((x: any) => x.counties).sort((a: number, b: number) => a - b);
      expect(all).toEqual(ny.countyFips.map((_, i) => i));
      expect(clustering.clusters.reduce((t: number, x: any) => t + x.districts, 0)).toBe(numDistricts);
      expect(clustering.stats.clusterCount).toBe(clustering.clusters.length);
      clustering.clusters.forEach((x: any, k: number) => {
        expect(countiesConnected(x.counties, adjacency)).toBe(true);
        const p = x.counties.reduce((t: number, i: number) => t + countyPop[i], 0);
        expect(x.pop).toBe(p);
        expect(x.districts).toBeGreaterThanOrEqual(1);
        expect(Math.abs(p / x.districts - size)).toBeLessThanOrEqual(tolerance * size + 1e-6);
        expect(clustering.countyNames[k]).toEqual(x.counties.map((i: number) => ny.names?.counties[i] || `County ${ny.countyFips[i]}`));
      });
    }
    // Best first: most clusters first.
    for (let i = 1; i < c.results.length; i++) expect(c.results[i - 1].stats.clusterCount).toBeGreaterThanOrEqual(c.results[i].stats.clusterCount);
    console.log(`[clusters] NY ${numDistricts} @ ±${tolerance * 100}%: ${c.results.length} clusterings, best has ${c.results[0].clusters.length} clusters, exhaustive ${c.exhaustive}, ${c.elapsedMs} ms`);
    return c;
  }

  test('clusters for the 26 congressional districts at ±5%', async () => {
    test.setTimeout(120_000);
    await dispatch(panel, { type: 'clusters-find', numDistricts: 26, tolerance: 0.05 });
    expect((await state(panel)).clusters.status).toBe('finding');
    await clustersDone(panel, 90_000);
    results[26] = await checkClusters(26, 0.05);
  });

  test('clusters for a 150-seat Assembly at ±5%', async () => {
    test.setTimeout(120_000);
    await dispatch(panel, { type: 'clusters-find', numDistricts: 150, tolerance: 0.05 });
    await clustersDone(panel, 90_000);
    results[150] = await checkClusters(150, 0.05);
  });

  test('hover outlines every county of the clustering, one label per cluster', async () => {
    test.setTimeout(60_000);
    const best = results[150].results[0];
    await dispatch(panel, { type: 'clusters-hover', id: best.id });
    const drawn = ny.countyFips.length + best.clusters.length;
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === drawn, 30_000);
    expect((await clusterStatus(panel)).layers).toEqual(expect.arrayContaining(['zd-cluster-fill', 'zd-cluster-line']));
    await dispatch(panel, { type: 'clusters-hover', id: best.id, cluster: 1 });
    await waitState(panel, (s) => s.clusters.hovered?.cluster === 1);
    await dispatch(panel, { type: 'clusters-hover', id: null });
    await until(() => clusterStatus(panel), (c: any) => c?.featureCount === 0);
  });

  test('a cluster as the swap area: Only moves blocks in its counties alone, and it is remembered', async () => {
    test.setTimeout(300_000);
    // Find clusters for the open map again (the 150-seat results replaced them).
    await dispatch(panel, { type: 'clusters-find', numDistricts: 26, tolerance: 0.05 });
    const c = (await clustersDone(panel, 90_000)).clusters;
    const s = await state(panel);
    // A cluster of two or more districts with a small whole precinct on a border inside it.
    let pick: { clustering: string; index: number; fips: Set<string>; from: number; to: number; precinct: string } | null = null;
    for (const clustering of c.results) {
      for (const [index, cl] of clustering.clusters.entries()) {
        if (cl.districts < 2 || pick) continue;
        const fips = new Set<string>(cl.counties.map((i: number) => ny.countyFips[i]));
        for (const row of s.districts) {
          for (const to of row.neighbors ?? []) {
            if (pick || to === 0) continue;
            const precincts: Array<{ id: string }> = await panel.evaluate(([a, b]) => (window as any).__zd.borderPrecincts(a, b, 30), [row.index, to]);
            for (const p of precincts) {
              const blocks: string[] = await dra.evaluate((id) => (window as any).fakeDra.blocksOf(id), p.id);
              if (blocks.every((g) => fips.has(g.slice(0, 5)))) {
                pick = { clustering: clustering.id, index, fips, from: row.index, to, precinct: p.id };
                break;
              }
            }
          }
        }
      }
      if (pick) break;
    }
    expect(pick).toBeTruthy();
    const { clustering, index, fips, from, to, precinct } = pick!;
    const cluster = c.results.find((r: any) => r.id === clustering).clusters[index];

    await dispatch(panel, { type: 'clusters-use-as-area', id: clustering, cluster: index });
    const withArea = await waitState(panel, (x) => !!x.area?.cluster);
    expect(withArea.area.cluster.counties).toEqual(cluster.counties);
    expect(withArea.area.cluster.name).toMatch(/district/);
    expect(withArea.area.ring).toBeUndefined();
    expect(withArea.area.region).toBeUndefined();
    const inside = ny.countyOf.reduce((t, ci) => t + (cluster.counties.includes(ci) ? 1 : 0), 0);
    expect(withArea.area.blocks).toBe(inside);
    await dispatch(panel, { type: 'set-area-mode', mode: 'only' });
    await waitState(panel, (x) => x.area?.mode === 'only');

    // Put the map off by one border precinct inside the cluster, then zero the district it left.
    await dra.evaluate(([pid, d]) => (window as any).fakeDra.paintPrecinct(pid, d), [precinct, to] as const);
    const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
    await until(() => state(panel), (x) => x.districts.every((d: any) => d.pop === pops[d.index]), 20_000);
    await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: from } });
    await dispatch(panel, { type: 'solve' });
    const solved = await waitState(panel, (x) => x.solve.status !== 'solving' && x.solve.status !== 'idle' && x.solve.status !== 'loading-data', 180_000);
    expect(solved.solve.status).toBe('done');
    expect(solved.solutions.length).toBeGreaterThan(0);
    for (const card of solved.solutions) {
      const geoids: string[] = await panel.evaluate((id) => (window as any).__zd.solutionBlocks(id), card.id);
      expect(geoids.length).toBeGreaterThan(0);
      expect(geoids.filter((g) => !fips.has(g.slice(0, 5)))).toEqual([]);
      expect(card.stats.outsideArea ?? 0).toBe(0);
    }

    // Remembered per map: a reopened panel has the same area.
    const stored = await h.sw.evaluate(async () => Object.values((await chrome.storage.local.get('areas')).areas ?? {}));
    expect(stored).toEqual([{ cluster: withArea.area.cluster, mode: 'only' }]);
    await panel.close();
    panel = await openPanel(h, dra);
    await until(() => debug(panel), (d) => d.assignmentReady, 120_000);
    const reopened = await waitState(panel, (x) => x.connection === 'live' && !!x.area?.cluster && x.area.blocks !== undefined, 120_000);
    expect(reopened.area).toMatchObject({ cluster: withArea.area.cluster, mode: 'only', blocks: inside });
    // Results are not kept across a panel reopen (they live in the panel).
    expect(reopened.clusters).toBeUndefined();

    // Put the precinct back and clear the area for the next test.
    await dra.evaluate(([pid, d]) => (window as any).fakeDra.paintPrecinct(pid, d), [precinct, from] as const);
    await dispatch(panel, { type: 'area-clear' });
    await waitState(panel, (x) => !x.area);
  });

  test('cancel stops a search', async () => {
    test.setTimeout(120_000);
    await waitState(panel, (x) => x.connection === 'live' && x.solve.status !== 'loading-data', 60_000);
    const generation = (await debug(panel)).workerGeneration;
    // The worker is kept busy (test-only knob) so the cancel lands mid-search.
    await panel.evaluate(() => (window as any).__zd.setTestSolveDelay(8000));
    await dispatch(panel, { type: 'clusters-find', numDistricts: 26, tolerance: 0.05 });
    await waitState(panel, (x) => x.clusters?.status === 'finding');
    await panel.waitForTimeout(300);
    const t0 = Date.now();
    await dispatch(panel, { type: 'clusters-cancel' });
    const cancelled = await waitState(panel, (x) => x.clusters?.status === 'idle', 5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(cancelled.clusters.message).toMatch(/cancel/i);
    expect(cancelled.clusters.results).toEqual([]);
    await until(() => debug(panel), (d) => d.workerGeneration > generation);
    await panel.evaluate(() => (window as any).__zd.setTestSolveDelay(0));
    // The fresh worker searches again.
    await dispatch(panel, { type: 'clusters-find', numDistricts: 26, tolerance: 0.05 });
    expect((await clustersDone(panel, 90_000)).clusters.status).toBe('done');
  });
});
