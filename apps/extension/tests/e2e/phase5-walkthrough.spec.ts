/** Phase 5: walkthrough, per-block ticking from the live plan (incl. uncommitted), commit reminder, strays, re-plan, final check. */
import { test, expect } from '@playwright/test';
import { closePages, dispatch, isZeroedPop, launch, openDra, openPanel, paintStep, playWalkthrough, probe, ready, solveOne, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

/** Starts the first option whose walkthrough has a block-level (shatter) step. */
async function startWithBlockStep(panel: any, district: number) {
  const s = await solveOne(panel, district);
  expect(s.solutions.length).toBeGreaterThan(0);
  for (const card of s.solutions) {
    await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
    const t = await waitState(panel, (x) => x.walkthrough?.solutionId === card.id);
    if (t.walkthrough.steps.some((x: any) => !x.wholePrecinct)) return t;
  }
  throw new Error('no option with a block-level step');
}

test('zero a district by following the steps; ticking, commit reminder, final check', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await startWithBlockStep(panel, 3);
  const w = s.walkthrough;
  expect(w.liveTicking).toBe(true);
  expect(w.mapMode).toBe('dra');
  // Steps grouped by border then precinct; blocks numbered 1..n within each step.
  for (const step of w.steps) expect(step.blocks.map((b: any) => b.number)).toEqual(step.blocks.map((_: any, i: number) => i + 1));
  expect(w.steps[0].status).toBe('active');

  // The map zoomed to the step and shows numbered labels (HTML labels: the fixture style has no glyphs).
  const first = w.steps[0];
  let p = await until(() => probe(panel), (x) => x.htmlLabels === first.blocks.length);
  expect(p.labelMode).toBe('html');

  for (let i = 0; i < w.steps.length; i++) {
    const cur = (await state(panel)).walkthrough;
    const step = cur.steps[cur.current];
    if (step.wholePrecinct) {
      await paintStep(dra, step);
    } else {
      // Paint the first block only: it ticks before any commit (fullBlockMap includes uncommitted edits).
      await dra.evaluate(([g, d]) => (window as any).fakeDra.paintBlock(g, d), [step.blocks[0].geoid, step.to]);
      await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === step.id).blocks[0].done === true);
      await paintStep(dra, step, { commit: false });
      // All blocks painted but the precinct is still shattered: remind to commit.
      await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === step.id).status === 'awaiting-commit');
      await dra.evaluate(() => (window as any).fakeDra.commit());
    }
    await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === step.id).status === 'done');
  }
  const done = await waitState(panel, (t) => !!t.walkthrough.finalCheck);
  expect(done.walkthrough.finalCheck.ok).toBe(true);
  // DRA's own numbers.
  const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  expect(isZeroedPop(pops[3], done.map.totalPop, 4)).toBe(true);
  expect(done.districts.find((d: any) => d.index === 3).pop).toBe(pops[3]);

  // Esc / end clears the highlight.
  await dispatch(panel, { type: 'walkthrough-end' });
  await until(() => probe(panel), (x) => x.featureCount === 0);
});

test('stray edits are reported, painting out of order ticks, and re-plan from here', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await startWithBlockStep(panel, 3);
  const steps = s.walkthrough.steps;
  // Out of order: paint the LAST step first.
  const last = steps[steps.length - 1];
  await paintStep(dra, last);
  await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === last.id).status === 'done');

  // A stray edit far from the plan: move a district-1 precinct corner block into district 3.
  const stray = '369010001001000';
  await dra.evaluate((g) => (window as any).fakeDra.paintBlock(g, 3), stray);
  const t = await waitState(panel, (x) => x.walkthrough.strayEdits.length > 0);
  expect(t.walkthrough.strayEdits[0]).toMatchObject({ geoid: stray, fromDistrict: 1, toDistrict: 3 });
  await dra.evaluate(() => (window as any).fakeDra.commit());

  // Re-plan from the current map (stray edit included); finished steps are kept and locked.
  await dispatch(panel, { type: 'walkthrough-replan' });
  const r = await waitState(panel, (x) => x.walkthrough && x.walkthrough.solutionId !== s.walkthrough.solutionId && x.solve.status === 'done', 30_000);
  expect(r.walkthrough.steps.find((x: any) => x.id === last.id)?.status).toBe('done');
  const lockedGeoids = new Set(last.blocks.map((b: any) => b.geoid));
  for (const st of r.walkthrough.steps) if (st.id !== last.id) for (const b of st.blocks) expect(lockedGeoids.has(b.geoid)).toBe(false);
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
});

test('next / back / zoom controls', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await startWithBlockStep(panel, 3);
  if (s.walkthrough.steps.length < 2) test.skip(true, 'single-step plan');
  await dispatch(panel, { type: 'walkthrough-next' });
  await waitState(panel, (t) => t.walkthrough.current === 1);
  await panel.waitForTimeout(1200); // fitBounds animation
  const c0 = await dra.evaluate(() => (window as any).fakeDra.map.getCenter().toArray());
  await dra.evaluate(() => (window as any).fakeDra.map.jumpTo({ center: [-70, 40], zoom: 5 }));
  await dispatch(panel, { type: 'walkthrough-zoom' });
  await until(() => dra.evaluate(() => (window as any).fakeDra.map.getCenter().toArray()), (c: number[]) => Math.abs(c[0] - c0[0]) < 0.05, 5000);
  await dispatch(panel, { type: 'walkthrough-back' });
  await waitState(panel, (t) => t.walkthrough.current === 0);
});

test('step numbers do not flicker: unchanged highlights are not rewritten on every poll, and the labels stay the same elements', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await solveOne(panel, 1);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: s.solutions[0].id });
  await waitState(panel, (x) => !!x.walkthrough);
  const first = await until(() => probe(panel), (x) => x.featureCount > 0 && x.onTop && x.htmlLabels > 0);
  // Tag the label elements; if they are rebuilt, the tags go with them.
  await dra.evaluate(() => document.querySelectorAll('.zd-label').forEach((el) => ((el as HTMLElement).dataset.kept = '1')));
  await dra.waitForTimeout(2000); // more than six poll ticks
  const later = await probe(panel);
  expect(later.dataWrites).toBe(first.dataWrites);
  const kept = await dra.evaluate(() => [document.querySelectorAll('.zd-label').length, document.querySelectorAll('.zd-label[data-kept]').length]);
  expect(kept[0]).toBeGreaterThan(0);
  expect(kept[1]).toBe(kept[0]);
});

