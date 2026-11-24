/**
 * Phase 14: locking finished districts, and taking highlights off DRA's map when the panel closes.
 * NY fixture: D1 +1146, D2 −554, D3 −439, D4 −154. VT: D1 +3, D2 −3, D3 0, D4 0.
 */
import { test, expect } from '@playwright/test';
import { closePages, dispatch, launch, openDra, openPanel, probe, ready, solveOne, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.beforeEach(async () => {
  await h.sw.evaluate(() => chrome.storage.local.remove('districtLocks'));
});
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const touched = (card: any) => new Set<number>([...card.borderFlows.flatMap((f: any) => [f.from, f.to]), ...card.deviations.filter((d: any) => d.after !== d.before).map((d: any) => d.district)]);
const solved = (panel: any) => waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 60_000);
const lock = (panel: any, districts: number[], locked = true) => dispatch(panel, { type: 'set-district-lock', districts, locked });

test('a locked neighbor never trades: one-district options leave it alone, and the choice drops it', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s0 = await state(panel);
  const nbrs: number[] = s0.districts.find((d: any) => d.index === 1).neighbors;
  expect(nbrs.length).toBeGreaterThan(1);

  // Unlocked, some option uses each neighbor it likes; note one that is used.
  const free = await solveOne(panel, 1);
  const used = [...new Set<number>(free.solutions.flatMap((c: any) => [...touched(c)]))].filter((d) => d !== 1);
  expect(used.length).toBeGreaterThan(0);
  const shut = used[0];

  // Choose it, then lock it with the row's own button: it comes off the choice.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1, with: [shut] } });
  await panel.getByTestId(`lock-${shut}`).click();
  const s1 = await state(panel);
  expect(s1.lockedDistricts).toEqual([shut]);
  expect(s1.scope).toEqual({ mode: 'one', district: 1 });
  expect(s1.solutions).toEqual([]);
  await expect(panel.getByTestId('chooser-locked-note')).toContainText(`District ${shut} is locked`);

  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  for (const card of r.solutions) expect(touched(card).has(shut)).toBe(false);

  // Zeroing the locked district itself is refused, with the reason.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: shut } });
  await dispatch(panel, { type: 'solve' });
  const refused = await solved(panel);
  expect(refused.solve.status).toBe('error');
  expect(refused.solve.message).toMatch(new RegExp(`District ${shut} is locked`));
  expect(refused.solutions).toEqual([]);

  // Every neighbor locked: nowhere for people to go.
  await lock(panel, nbrs);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  await dispatch(panel, { type: 'solve' });
  const stuck = await solved(panel);
  expect(stuck.solve.status).toBe('error');
  expect(stuck.solve.message).toMatch(/Every district next to District 1 is locked/);
});

test('whole map with locks plans only the unlocked districts, and says so when they cannot balance alone', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);
  expect((await state(panel)).districts.map((d: any) => d.deviation)).toEqual([3, -3, 0, 0]);

  // The two finished districts are locked in one click.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await panel.getByTestId('lock-zeroed').click();
  expect((await state(panel)).lockedDistricts).toEqual([3, 4]);
  await expect(panel.getByText('Whole map (2 of 4 districts)')).toBeVisible();

  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  console.log(`  whole map, 3 and 4 locked: ${r.solutions.length} plan(s), status ${r.solve.status}${r.solve.message ? `: ${r.solve.message}` : ''}`);
  for (const card of r.solutions) expect([...touched(card)].every((d) => d === 1 || d === 2)).toBe(true);
  if (r.solutions.length) expect(r.solve.message).toBe('District 3 and District 4 are locked and stay as they are; these plans change only the other 2 districts.');
  // Unlocked, the same map does get a plan (so an empty result above would be the lock's doing).
  await panel.getByTestId('unlock-all').click();
  expect((await state(panel)).lockedDistricts).toEqual([]);
  await dispatch(panel, { type: 'solve' });
  const open = await solved(panel);
  expect(open.solutions.length).toBeGreaterThan(0);
  if (r.solutions.length === 0) expect(r.solve.message).toBeTruthy();

  // Lock a district that is off: the rest no longer add up, and the message names the lock.
  await lock(panel, [2]);
  await dispatch(panel, { type: 'solve' });
  const off = await solved(panel);
  expect(off.solve.status).toBe('group-unbalanced');
  expect(off.solutions).toEqual([]);
  expect(off.solve.message).toMatch(/With District 2 locked/);
  expect(off.solve.message).toMatch(/3 people over/);
});

test('a group leaves locked districts out, also as outside neighbors that absorb', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await lock(panel, [4]);
  // Selecting a locked district has no effect.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'group', districts: [1, 2, 4], allowOutsideAbsorb: true } });
  expect((await state(panel)).scope).toEqual({ mode: 'group', districts: [1, 2], allowOutsideAbsorb: true });
  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  console.log(`  group 1+2, outside absorb, 4 locked: ${r.solutions.length} plan(s), status ${r.solve.status}`);
  expect(r.solutions.length).toBeGreaterThan(0);
  for (const card of r.solutions) expect(touched(card).has(4)).toBe(false);
  expect(r.feasibility?.suggestAdd ?? []).not.toContain(4);
});

test('locks are remembered for the map when the panel is reopened', async () => {
  const dra = await openDra(h);
  let panel = await openPanel(h, dra);
  await ready(panel);
  await lock(panel, [2, 3]);
  await until(() => h.sw.evaluate(() => chrome.storage.local.get('districtLocks').then((v) => Object.values(v.districtLocks ?? {}))), (v: any) => v.length === 1);
  await panel.close();
  panel = await openPanel(h, dra);
  await ready(panel);
  expect((await state(panel)).lockedDistricts).toEqual([2, 3]);
  await expect(panel.getByTestId('lock-2')).toHaveAttribute('aria-pressed', 'true');
});

test('closing the panel takes its highlights off DRA\'s map', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await solveOne(panel, 1);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: s.solutions[0].id });
  await until(() => probe(panel), (x: any) => x.featureCount > 0);
  const onMap = () => dra.evaluate(() => {
    const d = (window as any).dra?.env?.theMap?.getSource('zd-src')?._data;
    const fc = d?.features ? d : d?.geojson;
    return fc?.features?.length ?? 0;
  });
  expect(await onMap()).toBeGreaterThan(0);

  await panel.close();
  await until(onMap, (n) => n === 0);

  // Reopened, the panel starts clean and can draw again.
  const again = await openPanel(h, dra);
  await ready(again);
  expect(await onMap()).toBe(0);
  const s2 = await solveOne(again, 1);
  await dispatch(again, { type: 'hover-solution', id: s2.solutions[0].id });
  await until(onMap, (n) => n > 0);
});
