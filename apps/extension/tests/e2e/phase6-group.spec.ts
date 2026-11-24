/** Phase 6 wiring: group / whole-map scope via planGroup, feasibility + interaction graph, border hover, progress, re-plan locking finished borders. */
import { test, expect } from '@playwright/test';
import { closePages, debug, dispatch, isZeroedPop, launch, openDra, openPanel, paintStep, playWalkthrough, probe, ready, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

test('whole map: interaction view, plans with chained trades, walkthrough to zero everywhere', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  const s = await waitState(panel, (t) => !!t.interaction);
  expect(s.interaction.nodes.map((n: any) => n.district).sort()).toEqual([1, 2, 3, 4]);
  expect(s.interaction.edges.length).toBeGreaterThanOrEqual(3);

  // Hovering a border highlights it on DRA's map.
  await dispatch(panel, { type: 'hover-border', a: 1, b: 2 });
  await until(() => probe(panel), (x) => x.featureCount > 0 && x.onTop);
  await dispatch(panel, { type: 'hover-border', a: null, b: null });
  await until(() => probe(panel), (x) => x.featureCount === 0);

  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status !== 'solving' && t.solve.status !== 'idle', 60_000);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThanOrEqual(1);
  expect((await debug(panel)).progressEvents).toBeGreaterThan(0);
  const plan = r.solutions[0];
  // District 4 can only be fed through 2 or 3: some district both receives and gives.
  const tos = new Set(plan.borderFlows.map((f: any) => f.to));
  expect(plan.borderFlows.some((f: any) => tos.has(f.from))).toBe(true);

  await dispatch(panel, { type: 'start-walkthrough', solutionId: plan.id });
  const w = await waitState(panel, (t) => !!t.walkthrough);
  // Steps grouped by border, in realization order.
  const borders = w.walkthrough.steps.map((x: any) => `${x.from}>${x.to}`);
  const firstSeen = [...new Set(borders)];
  expect(borders).toEqual(firstSeen.flatMap((b) => borders.filter((x: string) => x === b)));
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  for (const d of [1, 2, 3, 4]) expect(isZeroedPop(pops[d], fin.map.totalPop, 4)).toBe(true);
});

test('a group that cannot balance on its own is reported, not half-solved', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'group', districts: [1, 2], allowOutsideAbsorb: false } });
  const s = await waitState(panel, (t) => !!t.feasibility);
  expect(s.feasibility.feasible).toBe(false);
  expect(s.feasibility.excess).not.toBe(0);
  expect(s.feasibility.suggestAdd.length).toBeGreaterThan(0);
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status !== 'solving' && t.solve.status !== 'idle', 30_000);
  expect(r.solve.status).toBe('group-unbalanced');
  expect(r.solutions).toEqual([]);
});

test('re-plan from here locks finished borders', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status === 'done' && t.solutions.length > 0, 60_000);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  // Finish every step of the first border.
  const b0 = `${w.steps[0].from}>${w.steps[0].to}`;
  const firstBorder = w.steps.filter((x: any) => `${x.from}>${x.to}` === b0);
  for (const st of firstBorder) {
    await paintStep(dra, st);
    await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === st.id).status === 'done');
  }
  await dispatch(panel, { type: 'walkthrough-replan' });
  const n = await waitState(panel, (t) => t.walkthrough && t.walkthrough.solutionId !== w.solutionId && t.solve.status === 'done', 60_000);
  const kept = n.walkthrough.steps.filter((x: any) => x.status === 'done').map((x: any) => x.id);
  expect(kept).toEqual(firstBorder.map((x: any) => x.id));
  const locked = new Set(firstBorder.flatMap((x: any) => x.blocks.map((b: any) => b.geoid)));
  for (const st of n.walkthrough.steps.slice(kept.length)) for (const b of st.blocks) expect(locked.has(b.geoid)).toBe(false);
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  void state;
});
