/**
 * Round 2 contract changes against the fake DRA page:
 * no-plan, cancel-solve, walkthrough-jump, load-csv while live + retry, CSV final check (ok = null),
 * mini-map hover preview outside a walkthrough, the one-district fallback to the planner, and a
 * two-way trade walked end to end (ticking, commit reminder, strays, re-plan from here, final check).
 *
 * The "VT" fixture (?plan=vt, fixture/generate.mjs): district 1 holds only even-population blocks
 * and is 3 over with no remainder; its only neighbour, district 2, is 3 under. No one-way move works.
 */
import { test, expect, type Page } from '@playwright/test';
import { closePages, debug, dispatch, isZeroedPop, launch, openDra, openPanel, paintStep, playWalkthrough, probe, ready, solveOne, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const draPops = (dra: Page): Promise<number[]> => dra.evaluate(() => (window as any).fakeDra.districtPops());

/** All block GEOIDs in a walkthrough, in order. */
const allBlocks = (w: any): string[] => w.steps.flatMap((s: any) => s.blocks.map((b: any) => b.geoid));

test('no-plan: a DRA tab with no map open is reported as no-plan, not a hook failure, both ways', async () => {
  const dra = await openDra(h, 'noplan=1');
  const panel = await openPanel(h, dra);
  const s = await waitState(panel, (t) => t.connection === 'no-plan');
  expect(s.districts).toEqual([]);
  expect(s.map).toBeUndefined();
  await expect(panel.getByTestId('no-plan-view')).toBeVisible();
  // Open a map: live.
  await dra.evaluate(() => (window as any).fakeDra.openPlan());
  await ready(panel);
  expect((await state(panel)).districts.length).toBe(4);
  // Close it again (back to DRA's map list): no-plan again, everything derived dropped.
  await dra.evaluate(() => (window as any).fakeDra.closePlan());
  const c = await waitState(panel, (t) => t.connection === 'no-plan');
  expect(c.districts).toEqual([]);
  expect(c.solutions).toEqual([]);
  expect(c.notice?.level).toBe('info');
});

test('cancel-solve stops a busy worker, leaves the panel usable, and a new solve works', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const gen0 = (await debug(panel)).workerGeneration;
  // Keep the worker busy for 20 s (test-only knob), so the solve is genuinely running when cancelled.
  await panel.evaluate(() => (window as any).__zd.setTestSolveDelay(20_000));
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  await waitState(panel, (t) => t.solve.status === 'solving');
  await expect(panel.getByTestId('cancel-solve-btn')).toBeVisible();
  const t0 = Date.now();
  await panel.getByTestId('cancel-solve-btn').click();
  const c = await waitState(panel, (t) => t.solve.status === 'idle', 3000);
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(c.solutions).toEqual([]);
  const d = await until(() => debug(panel), (x) => x.workerGeneration === gen0 + 1);
  expect(d.workerGeneration).toBe(gen0 + 1);
  // cancel with nothing running is a no-op.
  await dispatch(panel, { type: 'cancel-solve' });
  expect((await debug(panel)).workerGeneration).toBe(gen0 + 1);
  // The fresh worker has the graph: interaction view comes back and a real solve finishes.
  await panel.evaluate(() => (window as any).__zd.setTestSolveDelay(0));
  await waitState(panel, (t) => !!t.interaction);
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status === 'done', 60_000);
  expect(r.solutions.length).toBeGreaterThan(0);
  expect(r.solve.elapsedMs).toBeGreaterThanOrEqual(0);
});

test('walkthrough-jump goes straight to a step; a jump to a finished step stays put', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status === 'done' && t.solutions.length > 0, 60_000);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  expect(w.steps.length).toBeGreaterThanOrEqual(3);
  const last = w.steps.length - 1;
  await dispatch(panel, { type: 'walkthrough-jump', index: last });
  let s = await waitState(panel, (t) => t.walkthrough.current === last);
  expect(s.walkthrough.steps[last].status).toBe('active');
  expect(s.walkthrough.steps[0].status).toBe('pending');
  // Out of range is ignored.
  await dispatch(panel, { type: 'walkthrough-jump', index: 999 });
  await dispatch(panel, { type: 'walkthrough-jump', index: -1 });
  expect((await state(panel)).walkthrough.current).toBe(last);
  // The outline in the panel offers the same jump (data-testid outline-step-N), when the UI renders it.
  const outline = panel.getByTestId('outline-step-1');
  if (await outline.count()) {
    await outline.click();
    await waitState(panel, (t) => t.walkthrough.current === 1);
  } else await dispatch(panel, { type: 'walkthrough-jump', index: 1 });
  // Paint step 1: it finishes and the walkthrough moves on by itself.
  s = await state(panel);
  await paintStep(dra, s.walkthrough.steps[1]);
  s = await waitState(panel, (t) => t.walkthrough.steps[1].status === 'done' && t.walkthrough.current !== 1);
  // Jump back to the finished step: it stays there even as the live plan keeps updating.
  await dispatch(panel, { type: 'walkthrough-jump', index: 1 });
  await waitState(panel, (t) => t.walkthrough.current === 1);
  await paintStep(dra, s.walkthrough.steps[0]);
  s = await waitState(panel, (t) => t.walkthrough.steps[0].status === 'done');
  expect(s.walkthrough.current).toBe(1);
  // Map shows the jumped-to step.
  await until(() => probe(panel), (x) => x.htmlLabels === s.walkthrough.steps[1].blocks.length);
});

test('load-csv while live switches to CSV mode (sourceName set); retry-connection returns to the live tab', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const live = await state(panel);
  const csv: string = await dra.evaluate(() => (window as any).fakeDra.exportCsv());
  await dispatch(panel, { type: 'load-csv', text: csv, fileName: 'my-plan.csv' });
  const c = await waitState(panel, (t) => t.connection === 'csv' && t.districts.length === 4);
  expect(c.map.sourceName).toBe('my-plan.csv');
  expect(c.districts.map((d: any) => d.pop)).toEqual(live.districts.map((d: any) => d.pop));
  await expect(panel.getByTestId('csv-source-name')).toContainText('my-plan.csv');
  // Live edits are not followed in CSV mode.
  const pid: string = await dra.evaluate(() => (window as any).fakeDra.precinctOf('369010001001000'));
  await dra.evaluate((p) => (window as any).fakeDra.paintPrecinct(p, 2), pid);
  await new Promise((r) => setTimeout(r, 800));
  expect((await state(panel)).districts.map((d: any) => d.pop)).toEqual(c.districts.map((d: any) => d.pop));
  // Back to the live tab: it picks up the edit made meanwhile.
  await dispatch(panel, { type: 'retry-connection' });
  const back = await waitState(panel, (t) => t.connection === 'live' && t.districts.length === 4 && !t.map?.sourceName);
  const pops = await draPops(dra);
  await waitState(panel, (t) => t.districts.every((d: any) => d.pop === pops[d.index]));
  expect(back.map.planName).toBe('Fixture plan');
  await until(() => debug(panel), (d) => d.source === 'live' && d.assignmentReady);
  const r = await solveOne(panel, 1);
  expect(r.solve.status).toBe('done');
});

test('CSV mode final check: ok is null and the deviations are the plan\'s expected result', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const csv: string = await dra.evaluate(() => (window as any).fakeDra.exportCsv());
  await dispatch(panel, { type: 'load-csv', text: csv, fileName: 'fixture.csv' });
  await waitState(panel, (t) => t.connection === 'csv' && t.districts.length === 4);
  await until(() => debug(panel), (x) => x.assignmentReady);
  const r = await solveOne(panel, 3);
  const card = r.solutions[0];
  await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
  const w = await waitState(panel, (t) => !!t.walkthrough);
  expect(w.walkthrough.liveTicking).toBe(false);
  for (let i = 0; i < w.walkthrough.steps.length; i++) {
    expect((await state(panel)).walkthrough.finalCheck).toBeUndefined();
    await dispatch(panel, { type: 'walkthrough-next' });
  }
  const f = await waitState(panel, (t) => !!t.walkthrough.finalCheck);
  expect(f.walkthrough.finalCheck.ok).toBeNull();
  const byD = new Map(f.walkthrough.finalCheck.deviations.map((d: any) => [d.district, d]));
  for (const dc of card.deviations) expect(byD.get(dc.district)).toEqual(dc);
  const d3 = byD.get(3) as any;
  expect(isZeroedPop(r.map.target + d3.after, r.map.totalPop, 4)).toBe(true);
  await expect(panel.getByTestId('final-check-card')).toBeVisible();
});

test('mini-map: hover preview outside a walkthrough when DRA\'s map handle is missing', async () => {
  const dra = await openDra(h, 'nomap=1');
  const panel = await openPanel(h, dra);
  await ready(panel);
  expect((await state(panel)).mapMode).toBe('mini');
  const r = await solveOne(panel, 1);
  await dispatch(panel, { type: 'hover-solution', id: r.solutions[0].id });
  const s = await waitState(panel, (t) => t.hoveredSolutionId === r.solutions[0].id);
  expect(s.walkthrough).toBeUndefined();
  expect(s.mapMode).toBe('mini');
  await expect(panel.getByTestId('minimap-slot')).toBeVisible();
  const mini = await until(
    () =>
      panel.evaluate(() => {
        const el = document.querySelector('.zd-minimap') as any;
        const data = el?.__zdMap?.getSource('zd')?._data;
        const fc = data?.features ? data : data?.geojson;
        return fc?.features?.length ?? 0;
      }),
    (x) => x === r.solutions[0].stats.blocks,
  );
  expect(mini).toBe(r.solutions[0].stats.blocks);
  // Nothing was sent to DRA's (missing) map.
  expect((await debug(panel)).sink).toBe('mini');
});

test('one-district fallback: the solver finds nothing, the planner\'s two-way plan is shown and walked to zero', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s0 = await state(panel);
  expect(s0.map.state).toBe('VT');
  expect(s0.districts.map((d: any) => d.deviation)).toEqual([3, -3, 0, 0]);
  const r = await solveOne(panel, 1);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  const card = r.solutions[0];
  expect(card.kind).not.toBe('single'); // came from planGroup
  const dirs = new Set(card.borderFlows.map((f: any) => `${f.from}>${f.to}`));
  expect(dirs.has('1>2') && dirs.has('2>1')).toBe(true);
  expect(card.deviations.find((d: any) => d.district === 1).after).toBe(0);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  expect(new Set(allBlocks(w)).size).toBe(allBlocks(w).length);
  // Paint the first leg only, then re-plan from here in one-district mode: the painted leg is locked,
  // so the new plan never moves those blocks back (no block moves twice).
  const first = w.steps[0];
  await paintStep(dra, first);
  await waitState(panel, (t) => t.walkthrough.steps[0].status === 'done');
  const mid = await state(panel);
  expect(mid.walkthrough.strayEdits).toEqual([]);
  expect(mid.walkthrough.finalCheck).toBeUndefined();
  await dispatch(panel, { type: 'walkthrough-replan' });
  const n = await waitState(panel, (t) => t.walkthrough && t.walkthrough.solutionId !== w.solutionId && t.solve.status === 'done', 60_000);
  expect(n.walkthrough.steps[0].id).toBe(first.id);
  expect(n.walkthrough.steps[0].status).toBe('done');
  expect(new Set(allBlocks(n.walkthrough)).size).toBe(allBlocks(n.walkthrough).length);
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  expect(fin.walkthrough.strayEdits).toEqual([]);
  const pops = await draPops(dra);
  expect(isZeroedPop(pops[1], fin.map.totalPop, 4)).toBe(true);
  expect(isZeroedPop(pops[2], fin.map.totalPop, 4)).toBe(true);
});

test('two-way trade walked end to end: order, ticking, commit reminder, no strays mid-trade, re-plan from here, final check', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status === 'done' && t.solutions.length > 0, 60_000);
  const card = r.solutions[0];
  const out = card.borderFlows.find((f: any) => f.from === 1 && f.to === 2);
  const back = card.borderFlows.find((f: any) => f.from === 2 && f.to === 1);
  expect(out && back).toBeTruthy();
  expect(out.people - back.people).toBe(3);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  // Order: the steps follow the transfers, so every step of the first leg comes before the return leg.
  const full = (await debug(panel)).solutionsFull.find((s: any) => s.id === card.id);
  const legOrder = full.transfers.map((t: any) => `${t.from}>${t.to}`);
  const stepBorders = [...new Set(w.steps.map((s: any) => `${s.from}>${s.to}`))];
  expect(stepBorders).toEqual([...new Set(legOrder)]);
  // No block is expected to move twice.
  expect(new Set(allBlocks(w)).size).toBe(allBlocks(w).length);
  const firstLeg = w.steps.filter((s: any) => `${s.from}>${s.to}` === legOrder[0]);
  expect(firstLeg.length).toBeGreaterThan(0);

  // Paint the first leg block by block: ticks before commit, commit reminder, then done.
  for (const st of firstLeg) {
    if (st.wholePrecinct) {
      await paintStep(dra, st);
    } else {
      await paintStep(dra, st, { commit: false });
      await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === st.id).status === 'awaiting-commit');
      await expect(panel.getByTestId('commit-reminder')).toBeVisible();
      await dra.evaluate(() => (window as any).fakeDra.commit());
    }
    await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === st.id).status === 'done');
  }
  // Mid-trade: both districts further from zero than at the start, but nothing is a stray or a failure.
  const mid = await state(panel);
  const dev = (d: number) => mid.districts.find((x: any) => x.index === d).deviation;
  expect(Math.abs(dev(1))).toBeGreaterThan(3);
  expect(Math.abs(dev(2))).toBeGreaterThan(3);
  expect(mid.walkthrough.strayEdits).toEqual([]);
  expect(mid.walkthrough.finalCheck).toBeUndefined();
  expect(mid.notice?.level === 'error').toBe(false);
  expect(`${mid.walkthrough.steps[mid.walkthrough.current].from}>${mid.walkthrough.steps[mid.walkthrough.current].to}`).toBe(legOrder[1]);

  // Re-plan from here, mid-trade: the first leg is kept and locked; no planned block moves twice.
  await dispatch(panel, { type: 'walkthrough-replan' });
  const n = await waitState(panel, (t) => t.walkthrough && t.walkthrough.solutionId !== w.solutionId && t.solve.status === 'done', 60_000);
  const kept = n.walkthrough.steps.filter((x: any) => x.status === 'done').map((x: any) => x.id);
  expect(kept).toEqual(firstLeg.map((x: any) => x.id));
  expect(new Set(allBlocks(n.walkthrough)).size).toBe(allBlocks(n.walkthrough).length);
  expect(n.walkthrough.strayEdits).toEqual([]);
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  expect(fin.walkthrough.strayEdits).toEqual([]);
  const pops = await draPops(dra);
  for (const d of [1, 2, 3, 4]) expect(isZeroedPop(pops[d], fin.map.totalPop, 4)).toBe(true);
});

test('two-way trade without re-plan; a stray edit mid-trade is reported, the first leg is not', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status === 'done' && t.solutions.length > 0, 60_000);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  const first = w.steps[0];
  await paintStep(dra, first);
  await waitState(panel, (t) => t.walkthrough.steps[0].status === 'done');
  // A stray: an unplanned block of district 4 painted into 3 (far from the 1/2 border).
  const planned = new Set(allBlocks(w));
  const stray: string = await dra.evaluate((p) => {
    const f = (window as any).fakeDra;
    return fetch('/plan-vt.json').then((x) => x.json()).then((plan) => plan.blocks.map((b: any) => b.geoid).find((g: string) => f.districtOfBlock(g) === 4 && !p.includes(g)));
  }, [...planned]);
  await dra.evaluate((g) => (window as any).fakeDra.paintBlock(g, 3), stray);
  const t = await waitState(panel, (x) => x.walkthrough.strayEdits.length > 0);
  expect(t.walkthrough.strayEdits).toEqual([{ geoid: stray, fromDistrict: 4, toDistrict: 3 }]);
  // Undo the stray (DRA's undo just repaints), commit, and finish.
  await dra.evaluate((g) => (window as any).fakeDra.paintBlock(g, 4), stray);
  await dra.evaluate(() => (window as any).fakeDra.commit());
  await waitState(panel, (x) => x.walkthrough.strayEdits.length === 0);
  const fin = await playWalkthrough(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
});

test('diagnostics footer shows the self-check, hook version, field, target, data version and population check', async () => {
  const dra = await openDra(h, 'drift=5');
  const panel = await openPanel(h, dra);
  await waitState(panel, (t) => t.connection === 'data-mismatch');
  await panel.getByTestId('diagnostics').locator('summary').click();
  const text = panel.getByTestId('diagnostics-text');
  await expect(text).toContainText('all required hooks OK');
  await expect(text).toContainText('hook protocol: 2');
  await expect(text).toContainText('dataset field (primeDDS): D20F via datasetContext.primeDDS');
  await expect(text).toContainText('population field read: D20F');
  await expect(text).toContainText(/target read: [\d,]+/);
  await expect(text).toContainText('DRA data version fixture');
  await expect(text).toContainText('1 of 5 differ');
  await expect(text).toContainText('District 1 (#1): DRA');
  await expect(text).toContainText('diff -5');
  const logged = await panel.evaluate(() => (window as any).__zd.diagnostics());
  expect(logged).toContain('nothing was sent anywhere');
});
