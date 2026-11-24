/**
 * Painting a walkthrough step for the user (opt-in). The fake DRA page (fixture/www/fake-dra.js)
 * has DRA's own paint actions with the same signatures and behaviour as draclient.bundle.js
 * (RECON.md "Painting: what DRA does"), including the undo history, so these tests exercise the
 * real call shapes, the guards, the after-check and DRA-side undo.
 */
import { test, expect, type Page } from '@playwright/test';
import { closePages, debug, dispatch, isZeroedPop, launch, openDra, openPanel, paintStep, ready, solveOne, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => {
  await closePages(h);
  await h.sw.evaluate(() => chrome.storage.local.remove('autoPaint'));
});
test.afterAll(async () => h?.close());

const fake = <T>(dra: Page, fn: string, ...args: unknown[]) => dra.evaluate(([f, a]) => (window as any).fakeDra[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const calls = (dra: Page) => fake<any[]>(dra, 'paintCalls');
const stored = () => h.sw.evaluate(() => chrome.storage.local.get('autoPaint').then((v) => v.autoPaint));

async function enable(panel: Page) {
  await waitState(panel, (s) => s.autoPaint?.available === true);
  await dispatch(panel, { type: 'set-auto-paint', enabled: true });
  return waitState(panel, (s) => s.autoPaint?.enabled === true);
}

/** Dispatch walkthrough-paint-step and wait until the hook has answered. */
async function paintCurrent(panel: Page) {
  await dispatch(panel, { type: 'walkthrough-paint-step' });
  return waitState(panel, (s) => !s.autoPaint?.busy, 40_000);
}

/** Start an option whose walkthrough has a step matching `pred`; make that step current. */
async function startWithStep(panel: Page, pred: (step: any) => boolean, scopes: any[] = [1, 2, 3, 4].map((d) => ({ mode: 'one', district: d }))) {
  for (const scope of scopes) {
    await dispatch(panel, { type: 'set-scope', scope });
    await dispatch(panel, { type: 'solve' });
    const s = await waitState(panel, (x) => x.solve.status !== 'solving' && x.solve.status !== 'idle', 60_000);
    for (const card of s.solutions) {
      await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
      const t = await waitState(panel, (x) => x.walkthrough?.solutionId === card.id);
      const index = t.walkthrough.steps.findIndex(pred);
      if (index >= 0) {
        await dispatch(panel, { type: 'walkthrough-jump', index });
        const u = await waitState(panel, (x) => x.walkthrough.current === index);
        return { index, step: u.walkthrough.steps[index], w: u.walkthrough };
      }
    }
  }
  throw new Error('no option with a matching step');
}
const blockStep = (s: any) => !s.wholePrecinct && s.status !== 'done';
const wholeStep = (s: any) => s.wholePrecinct && s.status !== 'done';
const stepById = (s: any, id: string) => s.walkthrough.steps.find((x: any) => x.id === id);

test('off by default; nothing is painted while it is off', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await waitState(panel, (x) => x.autoPaint?.available === true);
  expect(s.autoPaint).toEqual({ available: true, enabled: false });
  expect(await stored()).toBeUndefined();
  const { step } = await startWithStep(panel, blockStep);
  await dispatch(panel, { type: 'walkthrough-paint-step' });
  await panel.waitForTimeout(800);
  expect(await calls(dra)).toEqual([]);
  expect(stepById(await state(panel), step.id).status).not.toBe('done');
  // The panel shows the setting, off, and no paint button.
  await expect(panel.getByTestId('auto-paint-toggle')).not.toBeChecked();
  await expect(panel.getByTestId('paint-step-btn')).toHaveCount(0);
});

test('a block step painted with the button: DRA paint-city call shape, ticks, one undo step, and DRA undo takes it back', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const { step } = await startWithStep(panel, blockStep);
  await enable(panel);
  const depth0 = await fake<number>(dra, 'undoDepth');
  const keysBefore = await fake<string[]>(dra, 'committedKeysOf', step.precinctId);
  await panel.getByTestId('paint-step-btn').click();
  await waitState(panel, (x) => x.autoPaint.busy === true || stepById(x, step.id).status === 'done', 5000);
  const done = await waitState(panel, (x) => !x.autoPaint.busy && stepById(x, step.id).status === 'done', 30_000);
  expect(done.autoPaint).toMatchObject({ available: true, enabled: true });
  expect(done.autoPaint.reason).toBeUndefined();
  expect(done.walkthrough.strayEdits).toEqual([]);
  expect(stepById(done, step.id).blocks.every((b: any) => b.done)).toBe(true);
  // Exactly what DRA's actionPaintCity does: block-level assignment + fixContiguity, in one composite.
  const c = await calls(dra);
  const own = c.filter((x) => !x.inUndo);
  expect(own.map((x) => x.fn)).toEqual(['actionSetBlockDistricts', 'actionSetFeatureDistricts', 'actionSetRedistrictProps', 'actionSetRedistrictProps']);
  const want = Object.fromEntries(step.blocks.map((b: any) => [b.geoid, step.to]));
  expect(own[0].arg).toEqual({ filterLocked: true, blockMap: want, filterNoChange: true, pushUndo: true, counter: own[0].arg.counter });
  expect(typeof own[0].arg.counter).toBe('number');
  // ...which DRA turns into precinct-level features: the precinct (and any old splits) zeroed, one feature per district.
  const inner = own[1].arg;
  expect(inner).toMatchObject({ filterLocked: false, coalesce: false, filterNoChange: true, pushUndo: true, counter: own[0].arg.counter });
  for (const k of keysBefore) expect(k in inner.blockMap).toBe(true);
  expect(Object.values(inner.blockMap)).toContain(step.to);
  expect(own[2].arg).toEqual({ fixContiguity: true, counter: own[0].arg.counter });
  expect(own[3].arg).toEqual({ fixContiguity: false, noundo: true }); // the fake's stand-in for DRA's later contiguity pass
  // Committed straight away as split features; nothing left shattered.
  const keys = await fake<string[]>(dra, 'committedKeysOf', step.precinctId);
  expect(keys.every((k) => k.startsWith(`B_${step.precinctId}_`))).toBe(true);
  expect((await debug(panel)).paint.last).toMatch(/painted/);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depth0 + 1);
  for (const b of step.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(step.to);
  // DRA's own Undo (the user's recovery path) restores the precinct exactly.
  await fake(dra, 'undo');
  await waitState(panel, (x) => stepById(x, step.id).blocks.every((b: any) => !b.done));
  for (const b of step.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(step.from);
  expect((await fake<string[]>(dra, 'committedKeysOf', step.precinctId)).sort()).toEqual(keysBefore.slice().sort());
  expect((await state(panel)).walkthrough.strayEdits).toEqual([]);
});

test('a whole-precinct step: DRA precinct-paint call shape, ticks, undo restores', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const { step } = await startWithStep(panel, wholeStep, [{ mode: 'all' }, ...[1, 2, 3, 4].map((d) => ({ mode: 'one', district: d }))]);
  await enable(panel);
  const before = await fake<string[]>(dra, 'committedKeysOf', step.precinctId);
  const depth0 = await fake<number>(dra, 'undoDepth');
  await paintCurrent(panel);
  const done = await waitState(panel, (x) => stepById(x, step.id).status === 'done');
  expect(done.autoPaint.available).toBe(true);
  const own = (await calls(dra)).filter((x) => !x.inUndo);
  expect(own.length).toBe(1);
  // Exactly what DRA's map does when the user paints a precinct (colorAt).
  expect(own[0]).toMatchObject({ fn: 'actionSetFeatureDistricts' });
  expect(own[0].arg).toEqual({ blockMap: Object.fromEntries(before.map((k) => [k, step.to])), filterLocked: true, coalesce: true, pushUndo: true });
  expect(await fake<string[]>(dra, 'committedKeysOf', step.precinctId)).toEqual([step.precinctId]);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depth0 + 1);
  await fake(dra, 'undo');
  await waitState(panel, (x) => stepById(x, step.id).status !== 'done');
  expect((await fake<string[]>(dra, 'committedKeysOf', step.precinctId)).sort()).toEqual(before.slice().sort());
  for (const b of step.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(step.from);
});

test('two-way trade painted leg by leg reaches zero', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const r = await waitState(panel, (t) => t.solve.status === 'done' && t.solutions.length > 0, 60_000);
  const card = r.solutions[0];
  expect(card.borderFlows.some((f: any) => f.from === 1 && f.to === 2) && card.borderFlows.some((f: any) => f.from === 2 && f.to === 1)).toBe(true);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
  const w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  await enable(panel);
  const legs = [...new Set(w.steps.map((s: any) => `${s.from}>${s.to}`))];
  expect(legs.length).toBe(2);
  // In the panel, Leg 2's button waits for Leg 1.
  const leg2 = w.steps.findIndex((s: any) => `${s.from}>${s.to}` === legs[1]);
  await dispatch(panel, { type: 'walkthrough-jump', index: leg2 });
  await expect(panel.getByTestId('paint-step-btn')).toBeDisabled();
  await expect(panel.getByTestId('paint-step-blocked')).toContainText('Paint Leg 1 first');
  await dispatch(panel, { type: 'walkthrough-jump', index: 0 });
  for (let i = 0; i < w.steps.length; i++) {
    const s = await state(panel);
    const cur = s.walkthrough.steps[s.walkthrough.current];
    expect(cur.status).not.toBe('done');
    // Steps are painted in order: every step of the first leg comes before the return leg.
    expect(`${cur.from}>${cur.to}`).toBe(i < leg2 ? legs[0] : legs[1]);
    const after = await paintCurrent(panel);
    expect(after.autoPaint.available).toBe(true);
    await waitState(panel, (x) => stepById(x, cur.id).status === 'done');
    const mid = await state(panel);
    expect(mid.walkthrough.strayEdits).toEqual([]);
  }
  const fin = await waitState(panel, (t) => !!t.walkthrough.finalCheck);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  const pops: number[] = await fake(dra, 'districtPops');
  expect(isZeroedPop(pops[1], fin.map.totalPop, 4)).toBe(true);
  expect(isZeroedPop(pops[2], fin.map.totalPop, 4)).toBe(true);
});

test('guards refuse and say why, and nothing is called: locked district, block moved, uncommitted edits', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const { step } = await startWithStep(panel, (s) => blockStep(s) && s.blocks.length >= 1);
  await enable(panel);

  // Locked target district.
  await fake(dra, 'lockDistrict', step.to, true);
  let s = await paintCurrent(panel);
  expect(s.autoPaint.reason).toMatch(new RegExp(`District ${step.to} is locked in DRA`));
  expect(s.autoPaint.enabled).toBe(true);
  await expect(panel.getByTestId('paint-step-note')).toContainText('locked');
  await fake(dra, 'lockDistrict', step.to, false);
  // Locked giving district.
  await fake(dra, 'lockDistrict', step.from, true);
  s = await paintCurrent(panel);
  expect(s.autoPaint.reason).toMatch(new RegExp(`District ${step.from} is locked in DRA`));
  await fake(dra, 'lockDistrict', step.from, false);

  // Uncommitted edits: another precinct shattered in DRA.
  const other = await dra.evaluate((pid) => (window as any).fakeDra.precincts().find((p: string) => p !== pid), step.precinctId);
  expect(other).toBeTruthy();
  await fake(dra, 'shatter', other);
  s = await paintCurrent(panel);
  expect(s.autoPaint.reason).toMatch(/uncommitted block edits/);
  await fake(dra, 'commit');

  // A block of the step is no longer where the plan expects (painted elsewhere by hand).
  const third = [1, 2, 3, 4].find((d) => d !== step.from && d !== step.to)!;
  await paintStep(dra, { wholePrecinct: false, blocks: [step.blocks[0]], to: third });
  await waitState(panel, (x) => x.walkthrough.strayEdits.some((e: any) => e.geoid === step.blocks[0].geoid));
  s = await paintCurrent(panel);
  expect(s.autoPaint.reason).toMatch(new RegExp(`Block ${step.blocks[0].geoid} is now in District ${third}, not District ${step.from}`));

  // None of the refusals called DRA.
  expect(await calls(dra)).toEqual([]);
  expect((await state(panel)).autoPaint).toMatchObject({ available: true, enabled: true });
});

test('read-only map: unavailable with the reason, and the page hook refuses too', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const { step } = await startWithStep(panel, blockStep);
  await enable(panel);
  await fake(dra, 'setReadonly', true);
  const s = await waitState(panel, (x) => x.autoPaint.available === false);
  expect(s.autoPaint.enabled).toBe(false);
  expect(s.autoPaint.reason).toMatch(/read-only/);
  await expect(panel.getByTestId('auto-paint-unavailable')).toContainText('read-only');
  await expect(panel.getByTestId('auto-paint-toggle')).toBeDisabled();
  // The panel will not send a paint; force one past the panel's checks: the hook's own guard refuses.
  await dispatch(panel, { type: 'walkthrough-paint-step' });
  await panel.evaluate(() => (window as any).__zd.testPaintSkippingPanelChecks());
  await until(() => debug(panel), (d) => /refused/.test(d.paint.last ?? ''), 15_000);
  expect((await debug(panel)).paint.last).toMatch(/refused: This map is read-only/);
  expect(await calls(dra)).toEqual([]);
  expect(stepById(await state(panel), step.id).status).not.toBe('done');
  // Editable again: available again, and the remembered setting is still on.
  await fake(dra, 'setReadonly', false);
  await waitState(panel, (x) => x.autoPaint.available === true && x.autoPaint.enabled === true);
});

for (const [mode, expectText] of [
  ['extra', /1 block\(s\) outside the step changed|outside the step changed/],
  ['wrong', /went to another district|did not move/],
  ['noop', /nothing changed/i],
  ['throw', /failed and nothing changed/],
] as const) {
  test(`a paint that does something other than asked (${mode}) is caught, reported, and switches painting off`, async () => {
    const dra = await openDra(h, 'paintwait=0.3');
    const panel = await openPanel(h, dra);
    await ready(panel);
    const { step } = await startWithStep(panel, blockStep);
    await enable(panel);
    expect(await stored()).toBe(true);
    await fake(dra, 'sabotageNextPaint', mode);
    const s = await paintCurrent(panel);
    expect(s.autoPaint).toMatchObject({ available: false, enabled: false });
    expect(s.autoPaint.reason).toMatch(/did not do what was asked, so painting for you is now off/);
    expect(s.autoPaint.reason).toMatch(expectText);
    if (mode === 'noop' || mode === 'throw') expect(s.autoPaint.reason).toMatch(/nothing to undo/);
    else expect(s.autoPaint.reason).toMatch(/DRA's own Undo .* takes this edit back in one step/);
    expect(s.notice.level).toBe('error');
    expect(s.notice.text).toMatch(/did not do what was asked/);
    await expect(panel.getByTestId('auto-paint-unavailable')).toContainText('did not do what was asked');
    // Switched off, also for the next session.
    expect(await stored()).toBe(false);
    // Nothing further is painted: neither turning it back on nor asking again does anything.
    const n = (await calls(dra)).length;
    await dispatch(panel, { type: 'set-auto-paint', enabled: true });
    await dispatch(panel, { type: 'walkthrough-paint-step' });
    await panel.waitForTimeout(600);
    expect((await calls(dra)).length).toBe(n);
    expect((await state(panel)).autoPaint.enabled).toBe(false);
    if (mode === 'extra' || mode === 'wrong') {
      // DRA's own Undo takes the bad edit back.
      await fake(dra, 'undo');
      for (const b of step.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(step.from);
    }
  });
}

test('unavailable when DRA lacks a paint function or one takes different arguments; the rest works', async () => {
  for (const [q, re] of [
    ['paintapi=missing', /model\.actionSetBlockDistricts: missing/],
    ['paintapi=arity', /model\.actionSetFeatureDistricts: takes 2 argument\(s\), expected 1/],
  ] as const) {
    const dra = await openDra(h, q);
    const panel = await openPanel(h, dra);
    await ready(panel);
    const s = await waitState(panel, (x) => x.autoPaint && x.autoPaint.available === false);
    expect(s.autoPaint.reason).toMatch(/DRA's paint functions are not what this extension expects/);
    expect(s.autoPaint.reason).toMatch(re);
    expect(s.connection).toBe('live');
    // Solving and the walkthrough are unaffected.
    const r = await solveOne(panel, 3);
    expect(r.solve.status).toBe('done');
    await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
    await waitState(panel, (x) => !!x.walkthrough);
    await expect(panel.getByTestId('auto-paint-unavailable')).toContainText('not what this extension expects');
    await dispatch(panel, { type: 'set-auto-paint', enabled: true });
    expect((await state(panel)).autoPaint.enabled).toBe(false);
    expect(await calls(dra)).toEqual([]);
    expect((await debug(panel)).paint.hook.checks.find((c: any) => !c.ok)).toBeTruthy();
    await closePages(h);
  }
});

test('the setting persists across panel sessions and is off in CSV mode', async () => {
  const dra = await openDra(h);
  let panel = await openPanel(h, dra);
  await ready(panel);
  await enable(panel);
  expect(await stored()).toBe(true);
  await panel.close();
  panel = await openPanel(h, dra);
  await ready(panel);
  await waitState(panel, (x) => x.autoPaint?.available === true && x.autoPaint.enabled === true);
  // CSV mode: unavailable, whatever the setting.
  const csv: string = await fake(dra, 'exportCsv');
  await dispatch(panel, { type: 'load-csv', text: csv, fileName: 'plan.csv' });
  const c = await waitState(panel, (x) => x.connection === 'csv');
  expect(c.autoPaint).toMatchObject({ available: false, enabled: false });
  expect(c.autoPaint.reason).toMatch(/CSV mode/);
  expect(await stored()).toBe(true); // the remembered choice is untouched
  // Back to the live tab: on again.
  await dispatch(panel, { type: 'retry-connection' });
  await waitState(panel, (x) => x.connection === 'live' && x.autoPaint?.available === true && x.autoPaint.enabled === true, 30_000);
  // Turning it off is remembered too.
  await dispatch(panel, { type: 'set-auto-paint', enabled: false });
  await until(() => stored(), (v) => v === false);
});
