/**
 * Phase 17: One-district "Aim for" goal (−1 · Zero · +1).
 *
 * Aiming for −1 or +1 targets that exact deviation against DRA's displayed target
 * (targets.draTarget + goal). Zero (default, `goal` absent on Scope) keeps the usual q / q + 1 rule.
 * Exercises:
 *  - UI Aim-for segmented control, chooser numbers, header badge, picking Zero, switching districts
 *  - Solving + walking through for +1 and −1 on the fake DRA page (both one-way and planner fallback)
 *  - Direction flip on a district starting at 0 (taking 1 for +1, giving 1 for −1)
 *  - Already-at-goal message ("District N is already at +1." / "−1.")
 *  - Re-plan from here keeping the goal, and Zero remaining unchanged
 */
import { test, expect, type Page } from '@playwright/test';
import {
  closePages,
  dispatch,
  isZeroedPop,
  launch,
  openDra,
  openPanel,
  paintStep,
  playWalkthrough,
  ready,
  state,
  waitState,
  type Harness,
} from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const draPops = (dra: Page) => dra.evaluate(() => (window as any).fakeDra.districtPops() as number[]);
const draTarget = (dra: Page) => dra.evaluate(() => (window as any).fakeDra.target() as number);

async function solveCurrent(panel: Page) {
  await dispatch(panel, { type: 'solve' });
  return waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 60_000);
}

test('over district: aim for +1 and −1 on NY fixture, solve, walk through, and DRA ends at exact goal', async () => {
  // --- +1 ---
  {
    const dra = await openDra(h);
    const panel = await openPanel(h, dra);
    await ready(panel);
    const target = await draTarget(dra);
    const s0 = await state(panel);
    const d1 = s0.districts.find((d: any) => d.index === 1);
    expect(d1.deviation).toBeGreaterThan(0);

    await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
    await expect(panel.getByTestId('goal-control')).toBeVisible();
    await expect(panel.getByTestId('goal-zero')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByTestId('goal-plus-1')).toHaveAttribute('aria-pressed', 'false');
    await expect(panel.getByTestId('goal-minus-1')).toHaveAttribute('aria-pressed', 'false');
    await expect(panel.getByTestId('chooser-summary')).toHaveText(
      `District 1 gives ${d1.deviation.toLocaleString('en-US')} people to any neighbor; the solver picks which.`,
    );

    // Click +1 in the UI.
    await panel.getByTestId('goal-plus-1').click();
    await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === 1);
    await expect(panel.getByTestId('goal-plus-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByTestId('goal-zero')).toHaveAttribute('aria-pressed', 'false');
    await expect(panel.getByTestId('chooser-summary')).toHaveText(
      `District 1 gives ${(d1.deviation - 1).toLocaleString('en-US')} people to any neighbor; the solver picks which.`,
    );

    const solved = await solveCurrent(panel);
    expect(solved.solve.status).toBe('done');
    expect(solved.solutions.length).toBeGreaterThan(0);
    for (const card of solved.solutions) {
      expect(card.deviations.find((d: any) => d.district === 1).after).toBe(1);
    }

    await dispatch(panel, { type: 'start-walkthrough', solutionId: solved.solutions[0].id });
    await waitState(panel, (s) => !!s.walkthrough);
    const fin = await playWalkthrough(panel, dra);
    expect(fin.walkthrough.finalCheck.ok).toBe(true);
    expect(fin.walkthrough.finalCheck.deviations.find((d: any) => d.district === 1).after).toBe(1);
    expect((await draPops(dra))[1]).toBe(target + 1);

    // Solving again now that District 1 is at +1 reports already-at-goal.
    await dispatch(panel, { type: 'walkthrough-end' });
    await waitState(panel, (s) => !s.walkthrough);
    const again = await solveCurrent(panel);
    expect(again.solve.status).toBe('done');
    expect(again.solutions).toEqual([]);
    expect(again.solve.message).toBe('District 1 is already at +1.');
    await closePages(h);
  }

  // --- −1 ---
  {
    const dra = await openDra(h);
    const panel = await openPanel(h, dra);
    await ready(panel);
    const target = await draTarget(dra);
    const s0 = await state(panel);
    const d1 = s0.districts.find((d: any) => d.index === 1);

    await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
    await panel.getByTestId('goal-minus-1').click();
    await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === -1);
    await expect(panel.getByTestId('goal-minus-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByTestId('chooser-summary')).toHaveText(
      `District 1 gives ${(d1.deviation + 1).toLocaleString('en-US')} people to any neighbor; the solver picks which.`,
    );

    const solved = await solveCurrent(panel);
    expect(solved.solve.status).toBe('done');
    expect(solved.solutions.length).toBeGreaterThan(0);
    for (const card of solved.solutions) {
      expect(card.deviations.find((d: any) => d.district === 1).after).toBe(-1);
    }

    await dispatch(panel, { type: 'start-walkthrough', solutionId: solved.solutions[0].id });
    await waitState(panel, (s) => !!s.walkthrough);
    const fin = await playWalkthrough(panel, dra);
    expect(fin.walkthrough.finalCheck.ok).toBe(true);
    expect(fin.walkthrough.finalCheck.deviations.find((d: any) => d.district === 1).after).toBe(-1);
    expect((await draPops(dra))[1]).toBe(target - 1);

    // Solving again reports already at −1.
    await dispatch(panel, { type: 'walkthrough-end' });
    await waitState(panel, (s) => !s.walkthrough);
    const again = await solveCurrent(panel);
    expect(again.solve.status).toBe('done');
    expect(again.solutions).toEqual([]);
    expect(again.solve.message).toBe('District 1 is already at \u22121.');
  }
});

test('under district: aim for −1 and +1 on NY fixture, DRA ends at exact goal', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const target = await draTarget(dra);
  const s0 = await state(panel);
  const d4 = s0.districts.find((d: any) => d.index === 4);
  expect(d4.deviation).toBeLessThan(0);

  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 4 } });
  await panel.getByTestId('goal-minus-1').click();
  await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === -1);
  // Under by |dev| aiming for −1 -> takes |dev| - 1.
  await expect(panel.getByTestId('chooser-summary')).toHaveText(
    `District 4 takes ${(Math.abs(d4.deviation) - 1).toLocaleString('en-US')} people from any neighbor; the solver picks which.`,
  );

  const solved = await solveCurrent(panel);
  expect(solved.solve.status).toBe('done');
  expect(solved.solutions.length).toBeGreaterThan(0);
  for (const card of solved.solutions) {
    expect(card.deviations.find((d: any) => d.district === 4).after).toBe(-1);
  }

  await dispatch(panel, { type: 'start-walkthrough', solutionId: solved.solutions[0].id });
  await waitState(panel, (s) => !!s.walkthrough);
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  expect((await draPops(dra))[4]).toBe(target - 1);
});

test('planner fallback and direction flip at deviation 0 on VT fixture', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const target = await draTarget(dra);
  const s0 = await state(panel);
  expect(s0.districts.map((d: any) => d.deviation)).toEqual([3, -3, 0, 0]);

  // District 3 starts at 0: with Zero, chooser is hidden and solve is already-zero.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 3 } });
  await expect(panel.getByTestId('neighbor-chooser')).toHaveCount(0);
  const zeroRes = await solveCurrent(panel);
  expect(zeroRes.solve.status).toBe('done');
  expect(zeroRes.solutions).toEqual([]);

  // Flip direction on District 3 by aiming for +1 (must TAKE 1 person); pick District 4.
  await panel.getByTestId('goal-plus-1').click();
  await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === 1);
  await expect(panel.getByTestId('neighbor-chooser')).toBeVisible();
  await expect(panel.getByTestId('chooser-summary')).toHaveText(
    'District 3 takes 1 person from any neighbor; the solver picks which.',
  );
  await panel.getByRole('checkbox', { name: 'Take from District 4' }).check();
  await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === 1 && s.scope.with?.includes(4));
  const flipSolve = await solveCurrent(panel);
  expect(flipSolve.solve.status).toBe('done');
  expect(flipSolve.solutions.length).toBeGreaterThan(0);
  expect(flipSolve.solutions[0].deviations.find((d: any) => d.district === 3).after).toBe(1);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: flipSolve.solutions[0].id });
  await waitState(panel, (s) => !!s.walkthrough);
  const flipFin = await playWalkthrough(panel, dra);
  expect(flipFin.walkthrough.finalCheck.ok).toBe(true);
  expect((await draPops(dra))[3]).toBe(target + 1);
  await dispatch(panel, { type: 'walkthrough-end' });
  await waitState(panel, (s) => !s.walkthrough);

  // District 1 (+3, all blocks >= 8 even) aiming for −1 needs delta 4: no one-way move exists,
  // so the multi-border planner fallback runs with goals: { 1: -1 }.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1, goal: -1 } });
  const fb = await solveCurrent(panel);
  expect(fb.solve.status).toBe('done');
  expect(fb.solutions.length).toBeGreaterThan(0);
  expect(fb.solutions[0].kind).not.toBe('single');
  expect(fb.solutions[0].deviations.find((d: any) => d.district === 1).after).toBe(-1);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: fb.solutions[0].id });
  await waitState(panel, (s) => !!s.walkthrough);
  const fbFin = await playWalkthrough(panel, dra);
  expect(fbFin.walkthrough.finalCheck.ok).toBe(true);
  expect((await draPops(dra))[1]).toBe(target - 1);
});

test('Zero unchanged, picking Zero clears goal, switching district resets goal, and re-plan keeps goal', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const target = await draTarget(dra);
  const s0 = await state(panel);

  // Aim for +1 on District 1, then click Zero -> clears goal.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  await panel.getByTestId('goal-plus-1').click();
  await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === 1);
  await panel.getByTestId('goal-zero').click();
  await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === undefined);
  expect((await state(panel)).scope).toEqual({ mode: 'one', district: 1 });
  expect('goal' in (await state(panel)).scope).toBe(false);

  // Aim for −1 on District 1, then switch to District 2 -> goal resets.
  await panel.getByTestId('goal-minus-1').click();
  await waitState(panel, (s) => s.scope.mode === 'one' && s.scope.goal === -1);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 2 } });
  const afterSwitch = await state(panel);
  expect(afterSwitch.scope).toEqual({ mode: 'one', district: 2 });
  await expect(panel.getByTestId('goal-zero')).toHaveAttribute('aria-pressed', 'true');

  // Group and whole-map modes hide the Aim-for control.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await expect(panel.getByTestId('goal-control')).toHaveCount(0);

  // Re-plan from here keeps goal: +1 on District 1 with chosen neighbor 3.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1, with: [3], goal: 1 } });
  const r = await solveCurrent(panel);
  expect(r.solutions.length).toBeGreaterThan(0);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  await paintStep(dra, w.steps[0]);
  await waitState(panel, (t) => t.walkthrough.steps[0].status === 'done');
  await dispatch(panel, { type: 'walkthrough-replan' });
  const replanned = await waitState(
    panel,
    (t) => t.walkthrough && t.walkthrough.solutionId !== w.solutionId && t.solve.status === 'done',
    60_000,
  );
  expect(replanned.scope).toEqual({ mode: 'one', district: 1, with: [3], goal: 1 });
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  expect((await draPops(dra))[1]).toBe(target + 1);
  await closePages(h);

  // Zero mode unchanged: District 1 ends at q or q + 1 (isZeroedPop).
  const dra2 = await openDra(h);
  const panel2 = await openPanel(h, dra2);
  await ready(panel2);
  await dispatch(panel2, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  const z = await solveCurrent(panel2);
  expect(z.solve.status).toBe('done');
  expect(z.solutions.length).toBeGreaterThan(0);
  await dispatch(panel2, { type: 'start-walkthrough', solutionId: z.solutions[0].id });
  await waitState(panel2, (s) => !!s.walkthrough);
  const zFin = await playWalkthrough(panel2, dra2);
  expect(zFin.walkthrough.finalCheck.ok).toBe(true);
  expect(isZeroedPop((await draPops(dra2))[1], s0.map.totalPop, s0.map.numDistricts)).toBe(true);
});
