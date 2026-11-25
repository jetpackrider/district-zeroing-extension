/**
 * Phase 15: trading with Unassigned (district 0) on a map still being drawn. The fake DRA page erases
 * whole precincts the way DRA's eraser does (the feature leaves the plan's block map), which makes
 * unassigned blocks next to a district. NY fixture: D1 +1146, D2 −554, D3 −439, D4 −154.
 *
 * Covers the contract (UNASSIGNED in @zd/contracts, Scope 'one', PanelState.unassigned) end to end:
 * the chooser offers Unassigned, the solve gives to it or takes from it, the walkthrough's steps
 * into it are erase steps, "Paint this step" erases exactly those blocks through DRA's own actions,
 * and DRA's numbers end at zero. On a complete map nothing changes: no Unassigned anywhere, no
 * permission in any request, and the solvers give the same answers with or without it.
 */
import { test, expect, type Page } from '@playwright/test';
import { closePages, debug, dispatch, isZeroedPop, launch, openDra, openPanel, ready, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.beforeEach(async () => {
  await h.sw.evaluate(() => chrome.storage.local.remove(['districtLocks', 'autoPaint']));
});
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const fake = <T>(dra: Page, fn: string, ...args: unknown[]) => dra.evaluate(([f, a]) => (window as any).fakeDra[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const solved = (panel: Page) => waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 60_000);
const flowsOf = (card: any) => new Set<number>(card.borderFlows.flatMap((f: any) => [f.from, f.to]));
const stepById = (s: any, id: string) => s.walkthrough.steps.find((x: any) => x.id === id);
const fmt = (n: number) => n.toLocaleString('en-US');

/** District of every block in the fake DRA, by GEOID (0 = unassigned). */
const blockDistricts = (dra: Page) =>
  dra.evaluate(() => {
    const f = (window as any).fakeDra;
    const out: Record<string, number> = {};
    for (const p of f.precincts()) for (const g of f.blocksOf(p)) out[g] = f.districtOfBlock(g);
    return out;
  }) as Promise<Record<string, number>>;

/** DRA's own population for district `d` and whether it is zeroed (the fake's aggregates). */
async function draZeroed(dra: Page, panel: Page, d: number) {
  const pops = await fake<number[]>(dra, 'districtPops');
  const m = (await state(panel)).map;
  return { pop: pops[d], zeroed: isZeroedPop(pops[d], m.totalPop, m.numDistricts) };
}

/**
 * Records what the panel asks the engine worker (without the big arrays), so a test can check
 * whether a request carried permission to trade with Unassigned.
 */
async function recordRequests(panel: Page) {
  await panel.evaluate(() => {
    const e = (window as any).__zd.engine;
    if (e.__rec) return;
    const orig = e.request.bind(e);
    e.__rec = [];
    e.request = (req: any, onProgress?: unknown) => {
      const { assignment: _a, locked: _l, graph: _g, targets: _t, ...rest } = req;
      e.__rec.push(rest);
      return orig(req, onProgress);
    };
  });
}
const requests = (panel: Page, type: string) => panel.evaluate((t) => (window as any).__zd.engine.__rec.filter((r: any) => r.type === t), type) as Promise<any[]>;

/**
 * Sends one request straight to the engine worker on the panel's current assignment and returns
 * what the options move (from, to, blocks) and the deviations: enough to compare two answers.
 */
const workerAnswer = (panel: Page, req: Record<string, unknown>) =>
  panel.evaluate(async (r) => {
    const c = (window as any).__zd;
    const res = await c.engine.request({ ...r, assignment: c.assignment, targets: c.targets });
    const result = res.result;
    return {
      status: result.status,
      solutions: result.solutions.map((s: any) => ({
        transfers: s.transfers.map((t: any) => ({ from: t.from, to: t.to, blocks: [...t.blocks].sort((a: number, b: number) => a - b) })),
        deviations: s.deviations,
      })),
    };
  }, req);

/**
 * Erases (DRA's eraser on whole precincts) `count` precincts of district `of` that touch district
 * `next`, smallest first, or with `minPeople` as many as it takes to hold that many people. Waits
 * until the panel shows the unassigned blocks next to `next`.
 */
async function eraseBorder(panel: Page, dra: Page, of: number, next: number, count: number, minPeople = 0) {
  const all: Array<{ id: string; pop: number }> = await panel.evaluate(([a, b, n]) => (window as any).__zd.borderPrecincts(a, b, n), [of, next, minPeople ? 50 : count]);
  let ps = all.slice(0, count);
  if (minPeople) {
    ps = [];
    for (let i = 0, sum = 0; i < all.length && sum < minPeople; i++) {
      ps.push(all[i]);
      sum += all[i].pop;
    }
  }
  expect(ps.length).toBeGreaterThan(0);
  if (minPeople) expect(ps.reduce((s, p) => s + p.pop, 0)).toBeGreaterThanOrEqual(minPeople);
  for (const p of ps) await fake(dra, 'paintPrecinct', p.id, 0);
  const people = ps.reduce((s, p) => s + p.pop, 0);
  const s = await waitState(panel, (x) => x.unassigned?.pop === people && x.districts.find((d: any) => d.index === next)?.neighbors?.includes(0));
  return { precincts: ps, people, state: s };
}

/**
 * Paints every step of the running walkthrough with "Paint this step", checking after each one that
 * DRA got the step's blocks with the step's district (0 for an erase step, as DRA's eraser sends),
 * that the button says "Erase this step" for an erase step, and that the step ticked.
 */
async function paintAll(panel: Page, dra: Page) {
  await waitState(panel, (s) => s.autoPaint?.available === true);
  await dispatch(panel, { type: 'set-auto-paint', enabled: true });
  await waitState(panel, (s) => s.autoPaint?.enabled === true);
  const painted: any[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const s = await state(panel);
    const w = s.walkthrough;
    if (w.steps.every((x: any) => x.status === 'done')) return { fin: await waitState(panel, (t) => !!t.walkthrough?.finalCheck), painted };
    const step = w.steps[w.current];
    await expect(panel.getByTestId('paint-step-btn')).toHaveText(step.to === 0 ? 'Erase this step' : 'Paint this step');
    if (step.to === 0) await expect(panel.getByTestId('step-instruction')).toContainText('Eraser');
    const callsBefore = (await fake<any[]>(dra, 'paintCalls')).length;
    await dispatch(panel, { type: 'walkthrough-paint-step' });
    const after = await waitState(panel, (t) => !t.autoPaint?.busy && stepById(t, step.id).status === 'done', 40_000);
    expect(after.autoPaint.reason).toBeUndefined();
    for (const b of step.blocks) expect(await fake<number>(dra, 'districtOfBlock', b.geoid)).toBe(step.to);
    // DRA's first call for the step carries the step's district for every key: 0 is the eraser.
    const own = (await fake<any[]>(dra, 'paintCalls')).slice(callsBefore).filter((x) => !x.inUndo);
    expect(own[0].fn).toBe(step.wholePrecinct ? 'actionSetFeatureDistricts' : 'actionSetBlockDistricts');
    expect(new Set(Object.values(own[0].arg.blockMap))).toEqual(new Set([step.to]));
    painted.push(step);
  }
  throw new Error('walkthrough did not finish');
}

test('a complete map: nothing offers Unassigned, no request carries permission, and the answers are the same with it', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await recordRequests(panel);
  const s = await state(panel);
  expect(s.unassigned).toBeUndefined();
  for (const d of s.districts) expect(d.neighbors ?? []).not.toContain(0);
  await expect(panel.getByTestId('unassigned-row')).toHaveCount(0);

  // The chooser reads exactly as before: real neighbors only, no Unassigned row or note.
  const d1 = s.districts.find((d: any) => d.index === 1);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  await expect(panel.getByTestId('chooser-summary')).toHaveText(`District 1 gives ${fmt(d1.deviation)} people to any neighbor; the solver picks which.`);
  await expect(panel.getByTestId('chooser-row-0')).toHaveCount(0);
  await expect(panel.getByTestId('chooser-unassigned-note')).toHaveCount(0);

  // One district: no permission in the request, no option touches 0.
  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  for (const card of r.solutions) expect(flowsOf(card).has(0)).toBe(false);
  for (const q of await requests(panel, 'solve-district')) {
    expect(q.includeUnassigned).toBeUndefined();
    expect(q.absorbers ?? []).not.toContain(0);
  }

  // A group with outside absorb: no permission either.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'group', districts: [1, 2], allowOutsideAbsorb: true } });
  await dispatch(panel, { type: 'solve' });
  const g = await solved(panel);
  for (const card of g.solutions) expect(flowsOf(card).has(0)).toBe(false);
  for (const q of [...(await requests(panel, 'solve-group')), ...(await requests(panel, 'interaction'))]) {
    expect(q.includeUnassigned).toBeUndefined();
    expect(q.absorbers ?? []).not.toContain(0);
  }

  // With no unassigned block, permission changes nothing: the engine and the planner give the
  // same options with it as without it (the "before" answers).
  for (const district of [1, 2, 3, 4]) {
    const base = { type: 'solve-district', district, maxOptions: 6 };
    const without = await workerAnswer(panel, base);
    const withIt = await workerAnswer(panel, { ...base, includeUnassigned: true });
    expect(withIt).toEqual(without);
    for (const sol of without.solutions) for (const t of sol.transfers) expect([t.from, t.to]).not.toContain(0);
  }
  const groupBase = { type: 'solve-group', districts: [1, 2], allowOutsideAbsorb: true };
  expect(await workerAnswer(panel, { ...groupBase, includeUnassigned: true })).toEqual(await workerAnswer(panel, groupBase));
});

test("the user's case: the only open border is unassigned, so the over district gives blocks to Unassigned (erase steps painted for the user)", async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await recordRequests(panel);
  const nbrs: number[] = (await state(panel)).districts.find((d: any) => d.index === 1).neighbors;
  // Unassigned blocks next to District 1 (a neighbor's border precincts erased), then every real neighbor locked.
  const { people } = await eraseBorder(panel, dra, nbrs[0], 1, 3);
  const s0 = await state(panel);
  expect(s0.districts.find((d: any) => d.index === 1).neighbors).toContain(0);
  expect(s0.districts.map((d: any) => d.index)).not.toContain(0);
  expect(s0.unassigned).toEqual({ pop: people });
  await expect(panel.getByTestId('unassigned-row')).toContainText(fmt(people));
  await dispatch(panel, { type: 'set-district-lock', districts: [...nbrs, 0], locked: true });
  const locked = await state(panel);
  expect(locked.lockedDistricts).toEqual([...nbrs].sort((a, b) => a - b)); // 0 is never locked

  // The chooser offers Unassigned, the only neighbor not locked, and "Any neighbor" includes it.
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  const dev1 = (await state(panel)).districts.find((d: any) => d.index === 1).deviation;
  expect(dev1).toBeGreaterThan(0);
  await expect(panel.getByTestId('chooser-row-0')).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: 'Give to Unassigned' })).toBeVisible();
  await expect(panel.getByTestId('chooser-row-0')).toContainText(`${fmt(people)}→${fmt(people + dev1)}`);
  await expect(panel.getByTestId('chooser-summary')).toHaveText(`District 1 gives ${fmt(dev1)} people to Unassigned, the only neighbor that is not locked.`);

  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  console.log(`  D1 with every real neighbor locked: ${r.solutions.length} option(s), ${r.solve.status}${r.solve.message ? `: ${r.solve.message}` : ''}`);
  expect(r.solve.message ?? '').not.toMatch(/Every district next to District 1 is locked/);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  // The worker was asked for exactly the open neighbors: Unassigned.
  expect((await requests(panel, 'solve-district')).at(-1)).toMatchObject({ district: 1, absorbers: [0] });
  for (const card of r.solutions) {
    expect([...flowsOf(card)].sort()).toEqual([0, 1]);
    // Unassigned is never in the deviations; District 1 reaches zero.
    expect(card.deviations.map((d: any) => d.district)).not.toContain(0);
  }
  await expect(panel.getByText(/Leaves .* more people unassigned/).first()).toBeVisible();

  // Hovering an option shows the erased blocks in the neutral 'erase' colour.
  await dispatch(panel, { type: 'hover-solution', id: r.solutions[0].id });
  await until(() => panel.evaluate(() => (window as any).__zd.lastHighlight?.fc.features.length ?? 0), (n) => n > 0);
  const roles = await panel.evaluate(() => [...new Set<string>((window as any).__zd.lastHighlight.fc.features.map((f: any) => f.properties.role))]);
  expect(roles).toContain('erase');
  expect(roles).not.toContain('remove');
  await dispatch(panel, { type: 'hover-solution', id: null });

  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = await waitState(panel, (x) => x.walkthrough?.solutionId === r.solutions[0].id);
  // Every step erases: District 1's blocks go to Unassigned.
  expect(w.walkthrough.steps.length).toBeGreaterThan(0);
  for (const step of w.walkthrough.steps) expect([step.from, step.to]).toEqual([1, 0]);
  const before = await blockDistricts(dra);
  const { fin, painted } = await paintAll(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  expect(fin.walkthrough.strayEdits).toEqual([]);
  expect((await debug(panel)).paint.broken).toBeNull();

  // Exactly the steps' blocks were unassigned, and nothing else changed in DRA.
  const after = await blockDistricts(dra);
  const changed = Object.keys(after).filter((g) => after[g] !== before[g]).sort();
  const stepBlocks = painted.flatMap((st: any) => st.blocks.map((b: any) => b.geoid)).sort();
  expect(changed).toEqual(stepBlocks);
  for (const g of changed) expect([before[g], after[g]]).toEqual([1, 0]);
  // DRA's numbers: District 1 is zeroed, and Unassigned holds what it gave.
  const d1 = await draZeroed(dra, panel, 1);
  expect(d1.zeroed).toBe(true);
  const fin2 = await waitState(panel, (x) => x.unassigned?.pop === people + (s0.districts.find((d: any) => d.index === 1).pop - d1.pop));
  expect(fin2.unassigned.pop).toBeGreaterThan(people);
});

test('"Any neighbor" while people are unassigned: the request includes Unassigned, and a real neighbor helped toward zero is still offered', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await recordRequests(panel);
  const nbrs: number[] = (await state(panel)).districts.find((d: any) => d.index === 1).neighbors;
  await eraseBorder(panel, dra, nbrs[0], 1, 3);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
  await expect(panel.getByTestId('chooser-summary')).toContainText('any neighbor, Unassigned included; the solver picks which.');
  await expect(panel.getByTestId('chooser-row-0')).toBeVisible();
  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  console.log(`  D1 any neighbor with Unassigned: ${r.solutions.length} option(s); partners ${r.solutions.map((c: any) => [...flowsOf(c)].filter((d) => d !== 1).join('+')).join(', ')}`);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  const q = (await requests(panel, 'solve-district')).at(-1);
  expect(q.includeUnassigned).toBe(true);
  expect(q.absorbers).toBeUndefined();
  // The real neighbors are all under, so a move to one of them is still among the options.
  expect(r.solutions.some((c: any) => [...flowsOf(c)].some((d) => d !== 0 && d !== 1))).toBe(true);
});

test('Unassigned picked explicitly: an under district takes unassigned blocks, painted from 0 (whole precincts included)', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  // District 2 (−554): a neighbor's precincts along its border are erased, holding more people
  // than District 2 is short, so it can take what it needs from Unassigned alone.
  const nbrs: number[] = (await state(panel)).districts.find((d: any) => d.index === 2).neighbors;
  const { people } = await eraseBorder(panel, dra, nbrs[0], 2, 0, 900);

  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 2 } });
  await panel.getByRole('checkbox', { name: 'Take from Unassigned' }).check();
  expect((await state(panel)).scope).toEqual({ mode: 'one', district: 2, with: [0] });
  const row2 = (await state(panel)).districts.find((d: any) => d.index === 2);
  const dev2 = row2.deviation;
  const pop2Before = row2.pop;
  expect(dev2).toBeLessThan(0);
  await expect(panel.getByTestId('chooser-summary')).toHaveText(`District 2 takes ${fmt(-dev2)} people from Unassigned only.`);
  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  console.log(`  D2 with Unassigned: ${r.solutions.length} option(s), ${r.solve.status}${r.solve.message ? `: ${r.solve.message}` : ''}`);
  expect(r.solve.status).toBe('done');
  expect(r.solutions.length).toBeGreaterThan(0);
  for (const card of r.solutions) expect([...flowsOf(card)].sort()).toEqual([0, 2]);
  await expect(panel.getByText(/Takes .* people from unassigned blocks/).first()).toBeVisible();

  // Prefer an option with a whole-precinct step from Unassigned (painted as the precinct's own feature).
  let picked = r.solutions[0].id;
  for (const card of r.solutions) {
    await dispatch(panel, { type: 'start-walkthrough', solutionId: card.id });
    const t = await waitState(panel, (x) => x.walkthrough?.solutionId === card.id);
    if (t.walkthrough.steps.some((st: any) => st.wholePrecinct && st.from === 0)) {
      picked = card.id;
      break;
    }
  }
  if ((await state(panel)).walkthrough.solutionId !== picked) {
    await dispatch(panel, { type: 'start-walkthrough', solutionId: picked });
    await waitState(panel, (x) => x.walkthrough?.solutionId === picked);
  }
  const steps = (await state(panel)).walkthrough.steps;
  for (const step of steps) expect([step.from, step.to]).toEqual([0, 2]);
  console.log(`  painting ${steps.length} step(s) from Unassigned: ${steps.filter((st: any) => st.wholePrecinct).length} whole precinct(s)`);
  const before = await blockDistricts(dra);
  const { fin, painted } = await paintAll(panel, dra);
  expect(fin.walkthrough.finalCheck.ok).toBe(true);
  expect(fin.walkthrough.strayEdits).toEqual([]);
  const after = await blockDistricts(dra);
  const changed = Object.keys(after).filter((g) => after[g] !== before[g]).sort();
  expect(changed).toEqual(painted.flatMap((st: any) => st.blocks.map((b: any) => b.geoid)).sort());
  for (const g of changed) expect([before[g], after[g]]).toEqual([0, 2]);
  // A whole unassigned precinct is painted as the precinct's own feature, as DRA's map does.
  const whole = steps.find((st: any) => st.wholePrecinct && st.from === 0);
  if (whole) expect(await fake<string[]>(dra, 'committedKeysOf', whole.precinctId)).toEqual([whole.precinctId]);
  // DRA's numbers: District 2 zeroed, Unassigned down by what it gave.
  const d2 = await draZeroed(dra, panel, 2);
  expect(d2.zeroed).toBe(true);
  const taken = d2.pop - pop2Before;
  expect(taken).toBeGreaterThan(0);
  await waitState(panel, (x) => x.unassigned?.pop === people - taken);
});

test('whole map while people are unassigned: the message says so', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const { people } = await eraseBorder(panel, dra, 2, 1, 2);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  expect(r.solve.status).toBe('group-unbalanced');
  expect(r.solve.message).toBe(`${people.toLocaleString('en-US')} ${people === 1 ? 'person is' : 'people are'} still unassigned; finish assigning them, or zero districts one at a time or as a group with Unassigned.`);
});

test('a group with outside absorb may trade with Unassigned while it holds people', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await recordRequests(panel);
  const nbrs: number[] = (await state(panel)).districts.find((d: any) => d.index === 1).neighbors;
  await eraseBorder(panel, dra, nbrs[0], 1, 3);
  const others = [1, 2, 3, 4].filter((d) => d !== 1);
  // Everyone else locked: only Unassigned is left outside the group of one.
  await dispatch(panel, { type: 'set-district-lock', districts: others, locked: true });
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'group', districts: [1], allowOutsideAbsorb: true } });
  await dispatch(panel, { type: 'solve' });
  const r = await solved(panel);
  console.log(`  group [1] + Unassigned: ${r.solutions.length} plan(s), ${r.solve.status}${r.solve.message ? `: ${r.solve.message}` : ''}`);
  expect(r.feasibility?.feasible).toBe(true);
  expect(r.solutions.length).toBeGreaterThan(0);
  expect((await requests(panel, 'solve-group')).at(-1)).toMatchObject({ districts: [1], allowOutsideAbsorb: true, absorbers: [0] });
  for (const card of r.solutions) expect([...flowsOf(card)].sort()).toEqual([0, 1]);
});
