/**
 * Phase 13: choosing which neighbors trade with one district (Scope `with`), and the step count on
 * every card. NY fixture: D1 +1146, D2 −554, D3 −439, D4 −154. VT: D1 +3, D2 −3, D3 0, D4 0, and no
 * one-way move fixes 1/2 (see fixture/generate.mjs), so the planner fallback runs.
 */
import { test, expect } from '@playwright/test';
import { closePages, dispatch, launch, openDra, openPanel, paintStep, playWalkthrough, ready, state, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const touched = (card: any) => new Set<number>(card.borderFlows.flatMap((f: any) => [f.from, f.to]));
const changed = (card: any) => new Set<number>(card.deviations.filter((d: any) => d.after !== d.before).map((d: any) => d.district));

async function solveWith(panel: any, scope: any) {
  await dispatch(panel, { type: 'set-scope', scope });
  await dispatch(panel, { type: 'solve' });
  return waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 60_000);
}

test('over district: a chosen neighbor is the only district the options touch, and it may end further from zero', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s0 = await state(panel);
  const d1 = s0.districts.find((d: any) => d.index === 1);
  expect(d1.neighbors).toContain(3);
  const d3 = s0.districts.find((d: any) => d.index === 3);
  expect(d1.deviation).toBeGreaterThan(0);

  // The chooser in the real panel says which way people move.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  await expect(panel.getByTestId('chooser-summary')).toHaveText(`District 1 gives ${d1.deviation.toLocaleString('en-US')} people to any neighbor; the solver picks which.`);
  await panel.getByRole('checkbox', { name: 'Give to District 3' }).check();
  await expect(panel.getByTestId('chooser-summary')).toHaveText(`District 1 gives ${d1.deviation.toLocaleString('en-US')} people to District 3 only.`);
  expect((await state(panel)).scope).toEqual({ mode: 'one', district: 1, with: [3] });

  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 60_000);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  for (const card of r.solutions) {
    expect([...touched(card)].sort()).toEqual([1, 3]);
    expect([...changed(card)].sort()).toEqual([1, 3]);
    const after3 = card.deviations.find((d: any) => d.district === 3).after;
    // D3 (−439) takes all ~1146 and ends at about +707: further from zero than it started, allowed because it was picked.
    expect(Math.abs(after3)).toBeGreaterThan(Math.abs(d3.deviation));
  }
  // The choice survives re-solving.
  expect(r.scope).toEqual({ mode: 'one', district: 1, with: [3] });
  await dispatch(panel, { type: 'solve' });
  const again = await waitState(panel, (s) => s.solve.status === 'done' && s.solutions.length > 0, 60_000);
  expect(again.scope).toEqual({ mode: 'one', district: 1, with: [3] });
  for (const card of again.solutions) expect([...touched(card)].sort()).toEqual([1, 3]);
  await expect(panel.getByTestId('chooser-worse-note')).toContainText('District 3 may end further from zero');

  // Another district: the choice resets to "any neighbor".
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 4 } });
  expect((await state(panel)).scope).toEqual({ mode: 'one', district: 4 });
});

test('under district: it takes only from the chosen neighbor, which ends further from zero', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s0 = await state(panel);
  const d4 = s0.districts.find((d: any) => d.index === 4);
  expect(d4.deviation).toBeLessThan(0);
  const pick = d4.neighbors.find((n: number) => s0.districts.find((d: any) => d.index === n).deviation < 0);
  expect(pick).toBeDefined();
  const before = s0.districts.find((d: any) => d.index === pick).deviation;

  // Without a choice, no neighbor may end further from zero: no option takes from an under neighbor one way.
  const any = await solveWith(panel, { mode: 'one', district: 4 });
  for (const card of any.solutions.filter((c: any) => c.kind === 'single')) {
    for (const dev of card.deviations.filter((d: any) => d.district !== 4)) expect(Math.abs(dev.after)).toBeLessThanOrEqual(Math.abs(dev.before));
  }

  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 4 } });
  await expect(panel.getByTestId('chooser-summary')).toContainText(`District 4 takes ${Math.abs(d4.deviation)} people from any neighbor`);
  const r = await solveWith(panel, { mode: 'one', district: 4, with: [pick] });
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  for (const card of r.solutions) {
    expect([...touched(card)].sort()).toEqual([4, pick].sort());
    for (const f of card.borderFlows) expect(f).toMatchObject({ from: pick, to: 4 });
    const after = card.deviations.find((d: any) => d.district === pick).after;
    expect(Math.abs(after)).toBeGreaterThan(Math.abs(before));
  }
});

test('a chosen district that does not touch the district is dropped from the choice', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s0 = await state(panel);
  const d1 = s0.districts.find((d: any) => d.index === 1);
  const far = [2, 3, 4].find((d) => !d1.neighbors.includes(d));
  test.skip(far === undefined, 'District 1 touches every district in this fixture');
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1, with: [far, d1.neighbors[0]] } });
  expect((await state(panel)).scope).toEqual({ mode: 'one', district: 1, with: [d1.neighbors[0]] });
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1, with: [far] } });
  expect((await state(panel)).scope).toEqual({ mode: 'one', district: 1 });
});

test('the planner fallback respects the choice: only the chosen neighbor, or nothing and a message saying why', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s0 = await state(panel);
  expect(s0.districts.map((d: any) => d.deviation)).toEqual([3, -3, 0, 0]);
  expect(s0.districts.find((d: any) => d.index === 2).neighbors).toEqual(expect.arrayContaining([1, 3]));
  // D2 (−3) takes only from D1 (+3). D1's blocks all hold an even number of people, so no one-way
  // move of 3 exists: the single-district solver finds nothing and the planner runs, restricted to D1.
  const r = await solveWith(panel, { mode: 'one', district: 2, with: [1] });
  for (const card of r.solutions) {
    expect([...touched(card)].sort()).toEqual([1, 2]);
    expect([...changed(card)].every((d) => d === 1 || d === 2)).toBe(true);
  }
  console.log(`  fallback with a choice: ${r.solutions.length} plan(s), status ${r.solve.status}: ${r.solve.message}`);
  if (r.solutions.length === 0) {
    // The planner went through a district the user did not pick: dropped, and said so.
    expect(r.solve.message).toMatch(/did not pick/);
  } else {
    expect(r.solutions[0].kind).not.toBe('single');
    expect(r.solve.message).toMatch(/trade with District 1 in both directions/);
  }
  expect(r.scope).toEqual({ mode: 'one', district: 2, with: [1] });

  // Choosing D3 instead: one way, D3 → D2, and D3 ends at −3 (further from zero), the user's call.
  const r3 = await solveWith(panel, { mode: 'one', district: 2, with: [3] });
  expect(r3.solve.status).toBe('done');
  expect(r3.solutions.length).toBeGreaterThan(0);
  for (const card of r3.solutions) {
    expect([...touched(card)].sort()).toEqual([2, 3]);
    expect(card.deviations.find((d: any) => d.district === 3).after).toBe(-3);
  }
});

test('re-plan from here keeps the choice', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const r = await solveWith(panel, { mode: 'one', district: 1, with: [3] });
  expect(r.solutions.length).toBeGreaterThan(0);
  const card = r.solutions[0];
  await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  await paintStep(dra, w.steps[0]);
  await waitState(panel, (t) => t.walkthrough.steps[0].status === 'done');
  await dispatch(panel, { type: 'walkthrough-replan' });
  const n = await waitState(panel, (t) => t.walkthrough && t.walkthrough.solutionId !== w.solutionId && t.solve.status === 'done', 60_000);
  expect(n.scope).toEqual({ mode: 'one', district: 1, with: [3] });
  for (const st of n.walkthrough.steps) expect([st.from, st.to].sort()).toEqual([1, 3]);
  for (const c of n.solutions) expect([...touched(c)].sort()).toEqual([1, 3]);
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
});

test('the step count on every card equals the number of steps in the walkthrough it starts', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const check = async (cards: any[]) => {
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(typeof card.stats.steps).toBe('number');
      await expect(panel.getByTestId(`steps-${card.id}`)).toContainText(String(card.stats.steps));
      await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
      const w = (await waitState(panel, (t) => t.walkthrough?.solutionId === card.id)).walkthrough;
      expect(w.steps.length).toBe(card.stats.steps);
      await dispatch(panel, { type: 'walkthrough-end' });
      await waitState(panel, (t) => !t.walkthrough);
    }
  };
  const one = await solveWith(panel, { mode: 'one', district: 1 });
  await check(one.solutions);
  const chosen = await solveWith(panel, { mode: 'one', district: 1, with: [2] });
  await check(chosen.solutions);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const all = await waitState(panel, (t) => t.solve.status === 'done' && t.solutions.length > 0, 60_000);
  await check(all.solutions);
});
