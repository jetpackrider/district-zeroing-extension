/**
 * Real scale: New York's enacted congressional plan (data/NY/fixtures/cd119.csv) over the real NY
 * bundle (288,819 blocks, 14,191 precincts, 62 counties), served by the fake DRA page's ?plan=real
 * mode through the same window.dra shape (precinct entries + B_{precinct}_{bitset} splits).
 * Skipped when data/NY or the generated plan (npm run fixture:gen) is absent.
 *
 * Measures and writes test-results/real-scale.json:
 *   open -> district table right; per-poll and per-update cost; memory; one-district solve;
 *   whole-map plan after perturbing a few districts (and cancelling one); hover preview incl. the
 *   county geometry it loads; a walkthrough step; and the whole walkthrough to zero.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug, dispatch, hasRealNY, isZeroedPop, launch, openDra, openPanel, paintStep, probe, REAL_DATA, ROOT, state, until, waitState, type Harness } from './harness';

test.skip(!hasRealNY(), 'data/NY or fixture/www/plan-real-ny.json missing (run npm run fixture:gen with data/NY present)');
test.describe.configure({ mode: 'serial' });

let h: Harness;
const results: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`[real-scale] ${k}: ${JSON.stringify(v)}`);
};
const ms = (t0: number) => Math.round(performance.now() - t0);

test.beforeAll(async () => {
  h = await launch({ data: REAL_DATA });
});
test.afterAll(async () => {
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(join(ROOT, 'test-results/real-scale.json'), JSON.stringify(results, null, 2));
  await h?.close();
});

const draPops = (dra: Page): Promise<number[]> => dra.evaluate(() => (window as any).fakeDra.districtPops());
const heap = (p: Page) => p.evaluate(() => Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6));

async function tableRight(panel: Page, dra: Page) {
  const pops = await draPops(dra);
  const s = await state(panel);
  return s.connection === 'live' && s.districts.length === 26 && s.districts.every((d: any) => d.pop === pops[d.index]);
}

let dra: Page;
let panel: Page;

test('open: district table right, bundle checks against DRA, memory', async () => {
  test.setTimeout(240_000);
  const tPage = performance.now();
  dra = await openDra(h, 'plan=real', 120_000);
  note('fakePageLoadMs', { total: ms(tPage), ...(await dra.evaluate(() => (window as any).fakeDra.stats())) });

  const t0 = performance.now();
  panel = await openPanel(h, dra);
  await until(() => tableRight(panel, dra), Boolean, 120_000);
  const tTable = ms(t0);
  // "Right" also means the bundle agrees with DRA district by district (the mismatch guard passed).
  await until(() => debug(panel), (d) => d.assignmentReady, 120_000);
  await waitState(panel, (s) => s.connection === 'live' && s.solve.status === 'idle', 120_000);
  const tChecked = ms(t0);
  const diag = await panel.evaluate(() => (window as any).__zd.diagnosticsInput());
  expect(diag.popCheck.rows.length).toBe(27);
  expect(diag.popCheck.rows.every((r: any) => r.dra === r.bundle)).toBe(true);
  expect(diag.popCheck.unresolvedCount).toBe(0);
  const d = await debug(panel);
  note('openColdMs', { tableShown: tTable, bundleCheckedAndReady: tChecked, bundleMs: Math.round(d.perf.bundleMs), mappingMs: Math.round(d.perf.mappingMs), graphMs: Math.round(d.perf.graphMs), engineInitMs: Math.round(d.perf.engineInitMs), firstSnapshotMs: Math.round(d.perf.maxSnapshotMs) });
  note('hookPerfAtOpen', d.hookPerf);

  // A second panel open (bundle now in IndexedDB): what a user sees every time after the first.
  await panel.close();
  const t1 = performance.now();
  panel = await openPanel(h, dra);
  await until(() => tableRight(panel, dra), Boolean, 120_000);
  const warmTable = ms(t1);
  await waitState(panel, (s) => s.connection === 'live' && s.solve.status === 'idle', 120_000);
  await until(() => debug(panel), (x) => x.assignmentReady, 120_000);
  note('openWarmMs', { tableShown: warmTable, ready: ms(t1), bundleMs: Math.round((await debug(panel)).perf.bundleMs) });
  // Let the initial whole-map interaction pass (default scope) finish before measuring memory.
  await waitState(panel, (s) => !!s.interaction, 180_000).catch(() => {});
  note('memoryMB', { panelHeap: await heap(panel), draPageHeap: await heap(dra) });
});

test('poll and state-update cost at this size', async () => {
  test.setTimeout(120_000);
  // Idle polling: the hook's 300 ms tick on DRA's page, over a 6 s window with nothing changing.
  // hookPerf travels with snapshots, so force one before and after the window.
  const sample = async () => {
    await panel.evaluate(() => (window as any).__zd.link.send({ t: 'request-snapshot' }));
    await panel.waitForTimeout(300);
    return (await debug(panel)).hookPerf;
  };
  const a = await sample();
  await panel.waitForTimeout(6000);
  const b = await sample();
  const ticks = b.ticks - a.ticks;
  note('hookIdlePoll', { windowTicks: ticks, idleTickAvgMs: +(((b.tickTotalMs ?? 0) - (a.tickTotalMs ?? 0)) / Math.max(1, ticks)).toFixed(2), lifetimeTickAvgMs: +b.tickAvgMs.toFixed(2), lifetimeTickMaxMs: +b.tickMaxMs.toFixed(1), selfCheckMs: +b.selfCheckMs.toFixed(2) });
  // Edits: paint 5 blocks one at a time (uncommitted), then commit; time paint -> panel shows the new pops.
  const s0 = await state(panel);
  const pid = (await panel.evaluate(() => (window as any).__zd.borderPrecincts(10, 12, 1)))[0]?.id;
  expect(pid).toBeTruthy();
  const blocks: string[] = await dra.evaluate((p) => (window as any).fakeDra.blocksOf(p), pid);
  const lat: number[] = [];
  const snapMs: number[] = [];
  for (const g of blocks.slice(0, 5)) {
    const before = (await debug(panel)).perf.snapshots;
    const t0 = performance.now();
    await dra.evaluate((x) => (window as any).fakeDra.paintBlock(x, 12), g);
    await until(() => debug(panel), (d) => d.perf.snapshots > before && d.assignmentReady, 10_000);
    const pops = await draPops(dra);
    await until(() => state(panel), (s) => s.districts.every((d: any) => d.pop === pops[d.index]), 10_000);
    lat.push(ms(t0));
    snapMs.push(Math.round((await debug(panel)).perf.lastSnapshotMs));
  }
  const tc = performance.now();
  await dra.evaluate(() => (window as any).fakeDra.commit());
  const popsC = await draPops(dra);
  await until(() => state(panel), (s) => s.districts.every((d: any) => d.pop === popsC[d.index]), 10_000);
  const after = await debug(panel);
  note('updateCost', {
    paintToPanelMs: lat,
    panelSnapshotHandlingMs: snapMs,
    commitToPanelMs: ms(tc),
    hookReadMs: +after.hookPerf.readMs.toFixed(1),
    hookSendMs: +(after.hookPerf.sendMs ?? 0).toFixed(1),
    hookMappingReadAndSendMs: Math.round(after.hookPerf.mappingMs),
    hookTickMaxMs: +after.hookPerf.tickMaxMs.toFixed(1),
  });
  // Put the blocks back (precinct back to 10).
  await dra.evaluate((p) => (window as any).fakeDra.paintPrecinct(p, 10), pid);
  const pops = await draPops(dra);
  await until(() => state(panel), (s) => s.districts.every((d: any) => d.pop === pops[d.index]), 10_000);
  expect((await state(panel)).districts.map((d: any) => d.pop)).toEqual(s0.districts.map((d: any) => d.pop));
});

test('one-district solve', async () => {
  test.setTimeout(120_000);
  const s = await state(panel);
  const off = s.districts.filter((d: any) => !isZeroedPop(d.pop, s.map.totalPop, 26));
  note('enactedOffDistricts', off.map((d: any) => [d.index, d.deviation]));
  const district = off[0]?.index ?? 14;
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district } });
  const t0 = performance.now();
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (x) => x.solve.status !== 'solving' && x.solve.status !== 'idle', 120_000);
  note('oneDistrictSolve', { district, wallMs: ms(t0), engineMs: r.solve.elapsedMs, status: r.solve.status, options: r.solutions.length, kinds: [...new Set(r.solutions.map((c: any) => c.kind))] });
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
});

let perturbed: Array<{ id: string; from: number; to: number; pop: number }> = [];

test('whole-map plan after perturbing a few districts; cancel works at this size', async () => {
  test.setTimeout(600_000);
  // Perturb: move one small whole border precinct across three borders.
  for (const [a, b] of [[3, 4], [10, 12], [21, 20]] as const) {
    const p = (await panel.evaluate(([x, y]) => (window as any).__zd.borderPrecincts(x, y, 1), [a, b]))[0];
    expect(p).toBeTruthy();
    perturbed.push({ id: p.id, from: a, to: b, pop: p.pop });
    await dra.evaluate(([pid, d]) => (window as any).fakeDra.paintPrecinct(pid, d), [p.id, b]);
  }
  const pops = await draPops(dra);
  await until(() => state(panel), (s) => s.districts.every((d: any) => d.pop === pops[d.index]), 20_000);
  note('perturbation', perturbed);

  // A one-district solve asked for while the (cold) whole-map capacity pass is running.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await panel.waitForTimeout(200);
  const tq = performance.now();
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 12 } });
  await dispatch(panel, { type: 'solve' });
  const q = await waitState(panel, (x) => x.solve.status !== 'solving' && x.solve.status !== 'idle', 120_000);
  note('oneDistrictSolveDuringCapacityPass', { wallMs: ms(tq), engineMs: q.solve.elapsedMs, status: q.solve.status, options: q.solutions.length });

  const t0 = performance.now();
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await waitState(panel, (s) => !!s.interaction && s.interaction.nodes.length === 26, 300_000);
  note('interactionViewMs', ms(t0));

  // Cancel a running whole-map solve, then solve for real. The real solve is quick once the
  // interaction pass has measured the borders, so the worker is kept busy (test-only knob) to be sure
  // the cancel lands mid-solve; what is measured is terminate + a fresh worker + re-sending the graph.
  await panel.evaluate(() => (window as any).__zd.setTestSolveDelay(5000));
  await dispatch(panel, { type: 'solve' });
  await waitState(panel, (s) => s.solve.status === 'solving');
  await panel.waitForTimeout(300);
  const tc = performance.now();
  await dispatch(panel, { type: 'cancel-solve' });
  await waitState(panel, (s) => s.solve.status === 'idle', 5000);
  const cancelToIdle = ms(tc);
  await until(() => debug(panel), (d) => d.perf.lastCancelMs > 0, 30_000);
  await panel.evaluate(() => (window as any).__zd.setTestSolveDelay(0));
  note('cancelAtScale', { cancelToIdleMs: cancelToIdle, restartAndReinitMs: Math.round((await debug(panel)).perf.lastCancelMs) });

  // After cancel the interaction pass is re-run on the fresh worker (curve cache lost); let it finish.
  await waitState(panel, (s) => !!s.interaction, 300_000);
  const t1 = performance.now();
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 300_000);
  note('wholeMapSolve', { wallMs: ms(t1), engineMs: r.solve.elapsedMs, status: r.solve.status, message: r.solve.message, plans: r.solutions.length, flows: r.solutions[0]?.borderFlows, blocks: r.solutions[0]?.stats.blocks });
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
});

test('hover preview (loads county geometry) and a walkthrough to zero', async () => {
  test.setTimeout(600_000);
  const s = await state(panel);
  const card = s.solutions[0];
  // Cold hover: county topojson files are fetched and decoded the first time.
  let t0 = performance.now();
  await dispatch(panel, { type: 'hover-solution', id: card.id });
  await until(() => probe(panel), (p) => p.featureCount === card.stats.blocks, 60_000);
  const cold = ms(t0);
  const coldPanel = Math.round((await debug(panel)).perf.lastHoverMs);
  await dispatch(panel, { type: 'hover-solution', id: null });
  await until(() => probe(panel), (p) => p.featureCount === 0);
  t0 = performance.now();
  await dispatch(panel, { type: 'hover-solution', id: card.id });
  await until(() => probe(panel), (p) => p.featureCount === card.stats.blocks, 60_000);
  note('hoverPreview', { blocks: card.stats.blocks, coldMs: cold, coldPanelBuildMs: coldPanel, warmMs: ms(t0), warmPanelBuildMs: Math.round((await debug(panel)).perf.lastHoverMs) });
  await dispatch(panel, { type: 'hover-solution', id: null });

  // Walkthrough.
  t0 = performance.now();
  await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
  const w = (await waitState(panel, (x) => !!x.walkthrough)).walkthrough;
  await until(() => probe(panel), (p) => p.htmlLabels === w.steps[0].blocks.length || p.featureCount >= w.steps[0].blocks.length, 30_000);
  const startMs = ms(t0);
  const all = w.steps.flatMap((x: any) => x.blocks.map((b: any) => b.geoid));
  expect(new Set(all).size).toBe(all.length);
  const stepLat: number[] = [];
  for (let guard = 0; guard < 400; guard++) {
    const cur = (await state(panel)).walkthrough;
    if (cur.steps.every((x: any) => x.status === 'done')) break;
    const step = cur.steps[cur.current];
    const t = performance.now();
    await paintStep(dra, step);
    await waitState(panel, (x) => x.walkthrough.steps.find((y: any) => y.id === step.id).status === 'done', 30_000);
    stepLat.push(ms(t));
  }
  const fin = await waitState(panel, (x) => !!x.walkthrough?.finalCheck, 30_000);
  const sorted = stepLat.slice().sort((a, b) => a - b);
  note('walkthrough', { steps: w.steps.length, startToFirstStepShownMs: startMs, stepPaintToTickMs: { median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), all: stepLat }, finalOk: fin.walkthrough.finalCheck.ok, strays: fin.walkthrough.strayEdits.length, panelTickMs: Math.round((await debug(panel)).perf.lastStepMs) });
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  const pops = await draPops(dra);
  for (let d = 1; d <= 26; d++) expect(isZeroedPop(pops[d], fin.map.totalPop, 26)).toBe(true);
  note('memoryMBAfter', { panelHeap: await heap(panel), draPageHeap: await heap(dra) });
});
