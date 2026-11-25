/**
 * Phase 18: Panel Undo (PanelState.undo / { type: 'undo' }).
 *
 * Covers:
 *  - Undoing a painted step via DRA's own Undo, verifying blocks return and the step un-ticks.
 *  - Undoing several painted steps in a row (latest first), including via Cmd/Ctrl+Z in the panel.
 *  - Withdrawing paint Undo as soon as DRA's undo history moves by hand (hand edit or hand undo),
 *    and never offering Undo for hand-painted edits.
 *  - Reporting an undo mismatch honestly when DRA's Undo does not restore the blocks.
 *  - Undoing destructive panel settings: Unlock all (persisted across reopening the panel),
 *    Lock the N at zero, clearing an area, and replacing an area with a new one.
 */
import { test, expect, type Page } from '@playwright/test';
import { closePages, dispatch, launch, openDra, openPanel, paintStep, ready, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => {
  await closePages(h);
  await h.sw.evaluate(() => chrome.storage.local.remove(['autoPaint', 'districtLocks', 'areas']));
});
test.afterAll(async () => h?.close());

const fake = <T>(dra: Page, fn: string, ...args: unknown[]) =>
  dra.evaluate(([f, a]) => (window as any).fakeDra[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

const stepById = (s: any, id: string) => s.walkthrough.steps.find((x: any) => x.id === id);

async function enableAutoPaint(panel: Page) {
  await waitState(panel, (s) => s.autoPaint?.available === true);
  await dispatch(panel, { type: 'set-auto-paint', enabled: true });
  return waitState(panel, (s) => s.autoPaint?.enabled === true);
}

async function paintCurrent(panel: Page) {
  await dispatch(panel, { type: 'walkthrough-paint-step' });
  await waitState(panel, (s) => s.autoPaint?.busy === true || s.undo?.kind === 'paint', 5000);
  return waitState(panel, (s) => !s.autoPaint?.busy, 40_000);
}

/** Start a walkthrough that has at least `minSteps` steps. */
async function startWalkthroughWithSteps(panel: Page, minSteps = 2) {
  for (const scope of [{ mode: 'all' }, ...[1, 2, 3, 4].map((d) => ({ mode: 'one', district: d }))]) {
    await dispatch(panel, { type: 'set-scope', scope });
    await dispatch(panel, { type: 'solve' });
    const s = await waitState(panel, (x) => x.solve.status !== 'solving' && x.solve.status !== 'idle', 60_000);
    for (const card of s.solutions) {
      await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
      const t = await waitState(panel, (x) => x.walkthrough?.solutionId === card.id);
      if (t.walkthrough.steps.length >= minSteps) return t.walkthrough;
    }
  }
  throw new Error(`no walkthrough with >= ${minSteps} steps found`);
}

test('paint a step for the user, then Undo: DRA restores the blocks and the step un-ticks', async () => {
  const dra = await openDra(h, 'paintwait=0.2');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const w = await startWalkthroughWithSteps(panel, 1);
  await enableAutoPaint(panel);

  const step = w.steps[0];
  const depth0 = await fake<number>(dra, 'undoDepth');
  const keysBefore = await fake<string[]>(dra, 'committedKeysOf', step.precinctId);
  expect((await state(panel)).undo).toBeUndefined();
  await expect(panel.getByTestId('undo-btn')).toHaveCount(0);

  await panel.getByTestId('paint-step-btn').click();
  const painted = await waitState(
    panel,
    (x) => !x.autoPaint.busy && stepById(x, step.id).status === 'done' && x.undo?.kind === 'paint',
    30_000,
  );
  expect(painted.undo).toEqual({ kind: 'paint', label: 'Undo painting step 1' });
  await expect(panel.getByTestId('undo-btn')).toHaveText(/Undo painting step 1/);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depth0 + 1);
  for (const b of step.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(step.to);

  // Click Undo in the panel: DRA's own Undo restores the blocks and the step un-ticks.
  await panel.getByTestId('undo-btn').click();
  const undone = await waitState(
    panel,
    (x) => !x.undo && stepById(x, step.id).status !== 'done' && stepById(x, step.id).blocks.every((b: any) => !b.done),
    30_000,
  );
  expect(undone.walkthrough.current).toBe(0);
  expect(undone.walkthrough.strayEdits).toEqual([]);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depth0);
  for (const b of step.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(step.from);
  expect((await fake<string[]>(dra, 'committedKeysOf', step.precinctId)).sort()).toEqual(keysBefore.slice().sort());
  await expect(panel.getByTestId('undo-btn')).toHaveCount(0);
});

test('paint two steps in a row, then undo both one at a time (button + keyboard shortcut)', async () => {
  const dra = await openDra(h, 'paintwait=0.2');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const w = await startWalkthroughWithSteps(panel, 2);
  await enableAutoPaint(panel);

  const s1 = w.steps[0];
  const s2 = w.steps[1];
  const depth0 = await fake<number>(dra, 'undoDepth');

  // Paint step 1.
  await paintCurrent(panel);
  await waitState(panel, (x) => stepById(x, s1.id).status === 'done' && x.undo?.label === 'Undo painting step 1', 30_000);
  expect((await state(panel)).walkthrough.current).toBe(1);

  // Paint step 2.
  await paintCurrent(panel);
  await waitState(panel, (x) => stepById(x, s2.id).status === 'done' && x.undo?.label === 'Undo painting step 2', 30_000);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depth0 + 2);

  // Undo step 2 via button -> step 2 un-ticks, step 1 stays done and becomes the next Undo.
  await panel.getByTestId('undo-btn').click();
  const after1 = await waitState(
    panel,
    (x) =>
      x.undo?.label === 'Undo painting step 1' &&
      stepById(x, s2.id).status !== 'done' &&
      stepById(x, s2.id).blocks.every((b: any) => !b.done),
    30_000,
  );
  expect(stepById(after1, s1.id).status).toBe('done');
  expect(after1.walkthrough.current).toBe(1);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depth0 + 1);
  for (const b of s2.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(s2.from);
  for (const b of s1.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(s1.to);

  // Undo step 1 via Ctrl/Cmd+Z inside the side panel -> step 1 un-ticks, Undo disappears.
  await panel.bringToFront();
  await panel.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }));
  });
  const after2 = await waitState(
    panel,
    (x) => !x.undo && stepById(x, s1.id).status !== 'done' && stepById(x, s1.id).blocks.every((b: any) => !b.done),
    30_000,
  );
  expect(after2.walkthrough.current).toBe(0);
  expect(after2.walkthrough.strayEdits).toEqual([]);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depth0);
  for (const b of s1.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(s1.from);
});

test('a hand edit or hand undo in DRA withdraws paint Undo; hand edits never offer panel Undo', async () => {
  const dra = await openDra(h, 'paintwait=0.2');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const w = await startWalkthroughWithSteps(panel, 2);
  await enableAutoPaint(panel);

  const s1 = w.steps[0];
  const s2 = w.steps[1];

  // Paint step 1 for the user -> Undo is offered.
  await paintCurrent(panel);
  await waitState(panel, (x) => stepById(x, s1.id).status === 'done' && x.undo?.kind === 'paint', 30_000);

  // Make a hand edit in DRA (paint step 2 by hand) -> DRA's undo cursor moves -> panel Undo is withdrawn.
  const depthBeforeHand = await fake<number>(dra, 'undoDepth');
  await paintStep(dra, s2);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depthBeforeHand + 1);
  await waitState(panel, (x) => stepById(x, s2.id).status === 'done' && !x.undo, 15_000);
  await expect(panel.getByTestId('undo-btn')).toHaveCount(0);

  // Dispatching undo when absent does nothing and does NOT touch the hand edit in DRA.
  await dispatch(panel, { type: 'undo' });
  await panel.waitForTimeout(400);
  expect(await fake<number>(dra, 'undoDepth')).toBe(depthBeforeHand + 1);
  for (const b of s2.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(s2.to);

  // Undo the two steps by hand, then paint step 1 via extension and undo it by hand in DRA:
  // Undo is withdrawn when DRA moves backward by hand too.
  await fake(dra, 'undo');
  await fake(dra, 'undo');
  await waitState(panel, (x) => stepById(x, s1.id).status !== 'done' && stepById(x, s2.id).status !== 'done', 15_000);
  await dispatch(panel, { type: 'walkthrough-jump', index: 0 });
  await waitState(panel, (x) => x.walkthrough.current === 0);
  await paintCurrent(panel);
  await waitState(panel, (x) => stepById(x, s1.id).status === 'done' && x.undo?.kind === 'paint', 30_000);

  await fake(dra, 'undo');
  await waitState(panel, (x) => stepById(x, s1.id).status !== 'done' && !x.undo, 15_000);
  await expect(panel.getByTestId('undo-btn')).toHaveCount(0);
});

test('an undo mismatch in DRA is caught and reported honestly', async () => {
  const dra = await openDra(h, 'paintwait=0.2');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const w = await startWalkthroughWithSteps(panel, 1);
  await enableAutoPaint(panel);

  const s1 = w.steps[0];
  await paintCurrent(panel);
  await waitState(panel, (x) => stepById(x, s1.id).status === 'done' && x.undo?.kind === 'paint', 30_000);

  await fake(dra, 'sabotageNextUndo', 'wrong');
  await panel.getByTestId('undo-btn').click();
  const s = await waitState(panel, (x) => !x.undo && x.notice?.level === 'error', 30_000);
  expect(s.notice.text).toMatch(/Undoing step 1 did not put the blocks back as expected/);
});

test('Unlock all then Undo restores the locks and persists them across reopening the panel', async () => {
  const dra = await openDra(h);
  let panel = await openPanel(h, dra);
  await ready(panel);

  // Lock districts 2 and 3.
  await dispatch(panel, { type: 'set-district-lock', districts: [2, 3], locked: true });
  await waitState(panel, (s) => JSON.stringify(s.lockedDistricts) === JSON.stringify([2, 3]));

  // Click "Unlock all": locks clear and Undo is offered.
  await panel.getByTestId('unlock-all').click();
  const unlocked = await waitState(panel, (s) => s.lockedDistricts.length === 0 && s.undo?.kind === 'setting');
  expect(unlocked.undo).toEqual({ kind: 'setting', label: 'Undo unlock all' });
  await expect(panel.getByTestId('undo-btn')).toHaveText(/Undo unlock all/);

  // Click Undo: locks [2, 3] are restored, Undo clears, and storage is updated.
  await panel.getByTestId('undo-btn').click();
  const restored = await waitState(panel, (s) => JSON.stringify(s.lockedDistricts) === JSON.stringify([2, 3]) && !s.undo);
  expect(restored.lockedDistricts).toEqual([2, 3]);
  await until(
    () => h.sw.evaluate(() => chrome.storage.local.get('districtLocks').then((v) => Object.values(v.districtLocks ?? {}))),
    (vals: any) => vals.some((arr: number[]) => JSON.stringify(arr) === JSON.stringify([2, 3])),
  );

  // Reopen the panel: restored locks are still remembered.
  await panel.close();
  panel = await openPanel(h, dra);
  await ready(panel);
  expect((await state(panel)).lockedDistricts).toEqual([2, 3]);
  await expect(panel.getByTestId('lock-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('lock-3')).toHaveAttribute('aria-pressed', 'true');
});

test('Lock the N at zero, clearing an area, and replacing an area all support single-step Undo', async () => {
  const dra = await openDra(h, 'plan=vt');
  const panel = await openPanel(h, dra);
  await ready(panel);

  // VT has districts 3 and 4 at zero. Click "Lock the 2 at zero", then Undo.
  await panel.getByTestId('lock-zeroed').click();
  const locked = await waitState(panel, (s) => JSON.stringify(s.lockedDistricts) === JSON.stringify([3, 4]) && s.undo?.kind === 'setting');
  expect(locked.undo.label).toBe('Undo lock the 2 at zero');
  await panel.getByTestId('undo-btn').click();
  await waitState(panel, (s) => s.lockedDistricts.length === 0 && !s.undo);

  // Set an initial area via Use map view (no previous area -> no replace undo).
  await dispatch(panel, { type: 'area-use-view' });
  const a1 = await waitState(panel, (s) => Boolean(s.area?.ring?.length));
  const ring1 = a1.area.ring;
  expect(a1.undo).toBeUndefined();

  // Pan the map and replace the area via Use map view -> Undo restores the first area.
  await dra.evaluate(() => (window as any).fakeDra.map.panBy([80, 40], { animate: false }));
  await dispatch(panel, { type: 'area-use-view' });
  const a2 = await waitState(panel, (s) => Boolean(s.area?.ring?.length) && JSON.stringify(s.area.ring) !== JSON.stringify(ring1));
  const ring2 = a2.area.ring;
  expect(a2.undo).toEqual({ kind: 'setting', label: 'Undo replacing area' });

  await panel.getByTestId('undo-btn').click();
  const afterReplaceUndo = await waitState(panel, (s) => JSON.stringify(s.area?.ring) === JSON.stringify(ring1) && !s.undo);
  expect(afterReplaceUndo.area.ring).toEqual(ring1);

  // Clear the area -> Undo restores it (and persists it).
  await dispatch(panel, { type: 'area-clear' });
  const cleared = await waitState(panel, (s) => !s.area?.ring && s.undo?.label === 'Undo clearing area');
  expect(cleared.undo).toEqual({ kind: 'setting', label: 'Undo clearing area' });

  await panel.getByTestId('undo-btn').click();
  await waitState(panel, (s) => JSON.stringify(s.area?.ring) === JSON.stringify(ring1) && !s.undo);
  expect(ring2).not.toEqual(ring1);
});
