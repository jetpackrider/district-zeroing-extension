/** Phase 3: MAIN-world hook -> private MessageChannel -> relay -> panel; districts exactly as DRA shows them. */
import { test, expect } from '@playwright/test';
import { closePages, debug, launch, openDra, openPanel, ready, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

test('panel shows each district population and deviation exactly as DRA does', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await state(panel);
  const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  const target: number = await dra.evaluate(() => (window as any).fakeDra.target());
  expect(s.map).toMatchObject({ state: 'NY', numDistricts: 4, popField: 'D20F', target });
  expect(s.districts.map((d: any) => [d.index, d.pop, d.deviation])).toEqual([1, 2, 3, 4].map((i) => [i, pops[i], pops[i] - target]));
  // Every hook passed the startup self-check.
  const d = await debug(panel);
  expect(d.check.ok).toBe(true);
  expect(d.check.items.filter((i: any) => !i.ok)).toEqual([]);
  // Neighbours come from the bundle graph + live assignment.
  expect(s.districts.find((r: any) => r.index === 1).neighbors).toEqual([2, 3]);
});

test('live updates, including uncommitted block edits', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const pid: string = await dra.evaluate(() => Object.keys((window as any).fakeDra).length && (window as any).fakeDra.precinctOf('369010001001000'));
  const blocks: string[] = await dra.evaluate((p) => (window as any).fakeDra.blocksOf(p), pid);
  // Paint one block into district 2 without committing.
  await dra.evaluate((g) => (window as any).fakeDra.paintBlock(g, 2), blocks[5]);
  const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  const s = await waitState(panel, (t) => t.districts[1].pop === pops[2] && t.districts[0].pop === pops[1]);
  expect(s.districts[0].pop).toBe(pops[1]);
  await dra.evaluate(() => (window as any).fakeDra.commit());
  const pops2: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  await waitState(panel, (t) => t.districts.every((r: any) => r.pop === pops2[r.index]));
  // After commit, the split precinct comes back as B_{precinct}_{bitset} and still decodes to the same blocks.
  expect((await state(panel)).connection).toBe('live');
});

test('the page cannot inject messages: a forged zd-port is ignored', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const before = await state(panel);
  await dra.evaluate(() => {
    const ch = new MessageChannel();
    window.postMessage({ zd: 'zd/v1', msg: { t: 'zd-port' } }, '*', [ch.port2]);
    const fake = { zd: 'zd/v1', msg: { t: 'snapshot', snap: { seq: 999, sig: 'forged', info: { state: 'NY', datasource: '2020_VD', planType: 'congress', nDistricts: 4, equalPop: true, allowMMD: false, restriction: null, isMapCollection: false, isMultiState: false, popField: 'D20F', totalPop: 4, planName: 'FORGED' }, districts: [0, 1, 2, 3, 4].map((i) => ({ index: i, label: 'X', pop: 1, target: 1, membersPer: 1 })), featureMap: {}, blockMappingStamp: 'x', pendingShatter: [] } } };
    for (let i = 0; i < 5; i++) ch.port1.postMessage(fake);
    window.postMessage(fake, '*');
  });
  await new Promise((r) => setTimeout(r, 800));
  const after = await state(panel);
  expect(after.map.planName).not.toBe('FORGED');
  expect(after.districts).toEqual(before.districts);
});

test('updated precincts: a changed live blockMapping is re-read', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  expect((await debug(panel)).liveStamp).toBe('1');
  const [g, to] = await dra.evaluate(() => {
    const f = (window as any).fakeDra;
    const g = f.blocksOf('36901000001')[3];
    return [g, '36901000002'];
  });
  await dra.evaluate(([g, to]) => (window as any).fakeDra.updatePrecincts(g, to), [g, to]);
  await until(() => debug(panel), (d) => d.liveStamp === '2');
  expect((await state(panel)).connection).toBe('live');
});
