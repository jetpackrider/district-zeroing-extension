/** Phase 4: engine in a Worker, option cards, hover preview on DRA's map that survives re-renders and a basemap change. */
import { test, expect } from '@playwright/test';
import { closePages, dispatch, isZeroedPop, launch, openDra, openPanel, probe, ready, solveOne, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const layerTail = (dra: any) => dra.evaluate(() => (window as any).fakeDra.layerIds().slice(-2));

test('option cards come from solveDistrict in the Worker and reach zero', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await solveOne(panel, 1);
  expect(s.solve.status).toBe('done');
  expect(s.solutions.length).toBeGreaterThanOrEqual(1);
  const m = s.map;
  for (const card of s.solutions) {
    expect(card.stats.people).toBeGreaterThan(0);
    const d1 = card.deviations.find((d: any) => d.district === 1);
    expect(isZeroedPop(m.target + d1.after, m.totalPop, m.numDistricts)).toBe(true);
  }
  // The engine runs in a dedicated Worker created by the panel page.
  const workers = panel.workers().map((w) => w.url());
  expect(workers.some((u) => /engine\.worker/.test(u))).toBe(true);
});

test('hover preview: zd- layers on top, survive panning, DRA re-renders and a basemap switch', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await solveOne(panel, 1);
  const blocks = s.solutions[0].stats.blocks;
  await dispatch(panel, { type: 'hover-solution', id: s.solutions[0].id });
  let p = await until(() => probe(panel), (x) => x.featureCount === blocks && x.onTop);
  expect(p.layers).toEqual(['zd-fill', 'zd-line']);
  expect(p.layers.some((l: string) => l.startsWith('dra-'))).toBe(false);
  await until(() => probe(panel), (x) => x.rendered > 0);

  // Panning.
  await dra.evaluate(() => (window as any).fakeDra.map.panBy([300, 120], { duration: 0 }));
  p = await until(() => probe(panel), (x) => x.onTop && x.featureCount === blocks);

  // DRA re-render: it moves its own layers to the top; ours must come back on top.
  const raisesBefore = p.raises;
  await dra.evaluate(() => (window as any).fakeDra.rerender());
  p = await until(() => probe(panel), (x) => x.onTop && x.raises > raisesBefore);
  expect(await layerTail(dra)).toEqual(['zd-fill', 'zd-line']);
  for (let i = 0; i < 5; i++) await dra.evaluate(() => (window as any).fakeDra.rerender());
  p = await until(() => probe(panel), (x) => x.onTop);

  // Basemap switch: DRA deletes dra- layers and calls setStyle(diff:false); every layer is gone, ours re-added on style.load.
  await dra.evaluate(() => (window as any).fakeDra.switchBasemap());
  p = await until(() => probe(panel), (x) => x.styleLoads >= 1 && x.onTop && x.featureCount === blocks);
  expect(await dra.evaluate(() => (window as any).fakeDra.basemap())).toBe('b');
  expect(await layerTail(dra)).toEqual(['zd-fill', 'zd-line']);
  await until(() => probe(panel), (x) => x.rendered > 0);
  // And back again.
  await dra.evaluate(() => (window as any).fakeDra.switchBasemap());
  await until(() => probe(panel), (x) => x.styleLoads >= 2 && x.onTop && x.featureCount === blocks);

  // Un-hover clears.
  await dispatch(panel, { type: 'hover-solution', id: null });
  await until(() => probe(panel), (x) => x.featureCount === 0);
});

test('bundle vs DRA population mismatch disables suggestions (data-mismatch)', async () => {
  const dra = await openDra(h, 'drift=7');
  const panel = await openPanel(h, dra);
  const s = await waitState(panel, (t) => t.connection === 'data-mismatch');
  expect(s.notice.text).toMatch(/disagrees with DRA/);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  await dispatch(panel, { type: 'solve' });
  const t = await waitState(panel, (x) => x.solve.status === 'error');
  expect(t.solutions).toEqual([]);
});

test('an unrecognized DRA dataset id is matched to a bundle column by its district totals, not refused by name', async () => {
  // Seen on the first live run: primeDDS was "48eb784a-3b94-4005-b940-3cceeb5c92ba.ds".
  for (const [query, column] of [['ddskey=48eb784a-3b94-4005-b940-3cceeb5c92ba.ds', 'D20F'], ['pop=D20FA&ddskey=48eb784a-3b94-4005-b940-3cceeb5c92ba.ds', 'D20FA']] as const) {
    const dra = await openDra(h, query);
    const panel = await openPanel(h, dra);
    await ready(panel);
    const s = await state(panel);
    expect(s.connection).toBe('live');
    expect(s.map.popField).toBe(column);
    const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
    expect(s.districts.map((d: any) => d.pop)).toEqual(pops.slice(1));
    const text: string = await panel.evaluate(() => (window as any).__zd.diagnostics());
    expect(text).toContain(`matched by numbers to ${column}, using ${column}`);
    await solveOne(panel, 1);
    expect((await state(panel)).solutions.length).toBeGreaterThan(0);
    await closePages(h);
  }
});

test('an unrecognized DRA dataset id whose totals match neither bundle column disables suggestions', async () => {
  const dra = await openDra(h, 'ddskey=custom.ds&drift=7');
  const panel = await openPanel(h, dra);
  const s = await waitState(panel, (x) => x.connection === 'data-mismatch');
  expect(s.notice.text).toContain('neither population column in the data bundle matches');
});

test('prisoner-adjusted population (primeDDS = D20FA) uses the adjusted column', async () => {
  const dra = await openDra(h, 'pop=D20FA');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await state(panel);
  expect(s.map.popField).toBe('D20FA');
  expect(s.connection).toBe('live');
  const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  expect(s.districts.map((d: any) => d.pop)).toEqual(pops.slice(1));
});
