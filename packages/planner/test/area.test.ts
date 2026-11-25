/**
 * An area of the map where the user would like the swap to happen (AreaPreference in
 * @zd/contracts), for groups and the whole map: 'only' never moves a block outside it, 'prefer'
 * puts the plans that stay inside first and appends plans that go outside, fewest outside blocks
 * first. The maps are 5-district vertical strips, 15 block columns each (District d holds
 * columns 15(d - 1) .. 15d - 1), so an area is a band of columns.
 *
 * Runs with the reference solver (npm test) and the real engine (npm run test:engine).
 */
import { describe, expect, it } from 'vitest';
import type { AreaPreference, GroupSolveRequest, Solution } from '@zd/contracts';
import { planGroup, verifyPlan, type PlannerResult } from '../src/index';
import { expectGoodPlan, range, snapshot } from './support/check';
import { makeSolver, SOLVER_NAME } from './support/solvers';
import { applyTransfers, generateMap, setDeviations, type SynthMap } from './support/synth';

function strips(devs: number[], seed = 3): SynthMap {
  return setDeviations(generateMap({ seed, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), devs);
}

function request(map: SynthMap, districts: number[], extra: Partial<GroupSolveRequest> = {}): GroupSolveRequest {
  return { graph: map.graph, assignment: map.assignment, targets: map.targets, districts, solver: makeSolver(), ...extra };
}

/** The blocks in columns x0 .. x1 - 1 (and rows y0 .. y1 - 1). */
function band(map: SynthMap, x0: number, x1: number, mode: AreaPreference['mode'], y0 = 0, y1 = map.height): AreaPreference {
  const inside = new Uint8Array(map.graph.n);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inside[y * map.width + x] = 1;
  return { inside, mode };
}

/** Test-side count of moved blocks outside the area. */
const outsideCount = (sol: Solution, inside: Uint8Array) =>
  sol.transfers.reduce((sum, t) => sum + Array.from(t.blocks).filter((b) => !inside[b]).length, 0);

/**
 * Every plan good by the test-side check and by verifyPlan (with the outside blocks locked in
 * 'only' mode), outsideArea right, and plans ordered fewest outside blocks first.
 */
function expectAreaPlans(map: SynthMap, req: GroupSolveRequest, res: PlannerResult, opts: { allowOutside?: boolean; locked?: Uint8Array } = {}) {
  const area = req.area!;
  const outside = area.inside.map((v) => (v ? 0 : 1));
  for (const sol of res.solutions) {
    expectGoodPlan(map, sol, req.districts, { allowOutside: opts.allowOutside, locked: opts.locked });
    expect(sol.stats.outsideArea).toBe(outsideCount(sol, area.inside));
    const base = { ...req, transfers: sol.transfers };
    expect(verifyPlan(base).ok, JSON.stringify(verifyPlan(base).issues)).toBe(true);
    if (area.mode === 'only') {
      expect(sol.stats.outsideArea).toBe(0);
      const locked = outside.map((v, b) => v | (opts.locked?.[b] ?? 0));
      const check = verifyPlan({ ...base, locked });
      expect(check.ok, JSON.stringify(check.issues)).toBe(true);
    }
  }
  const counts = res.solutions.map((s) => s.stats.outsideArea!);
  expect(counts).toEqual([...counts].sort((a, b) => a - b));
}

/** A result without timings and the outsideArea field, to compare with a result made without an area. */
function plain(res: PlannerResult) {
  return snapshot({
    status: res.status, message: res.message, feasibility: res.feasibility, interaction: res.interaction,
    solutions: res.solutions.map((s) => {
      const { outsideArea: _, ...stats } = s.stats;
      return { ...s, stats };
    }),
  });
}

describe(`[${SOLVER_NAME} solver] groups with an area`, () => {
  // 1 is 300 over and 3 is 300 under: the people go 1 → 2 → 3.
  const map = strips([300, 0, -300, 0, 0]);

  it('an area covering the whole map gives exactly the plans of no area', () => {
    const none = planGroup(request(map, [1, 2, 3]));
    expect(none.status, none.message).toBe('ok');
    for (const sol of none.solutions) expect(sol.stats.outsideArea).toBeUndefined();
    for (const mode of ['prefer', 'only'] as const) {
      const req = request(map, [1, 2, 3], { area: band(map, 0, map.width, mode) });
      const res = planGroup(req);
      expectAreaPlans(map, req, res);
      expect(res.solutions.every((s) => s.stats.outsideArea === 0)).toBe(true);
      expect(plain(res)).toBe(plain(none));
    }
  });

  it('only: plans inside an area over both borders move nothing outside it', () => {
    const req = request(map, [1, 2, 3], { area: band(map, 10, 35, 'only') });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expect(res.solutions.length).toBeGreaterThan(0);
    expectAreaPlans(map, req, res);
    // Prefer finds those same plans, all inside, and no more is needed.
    const prefer = planGroup({ ...req, area: band(map, 10, 35, 'prefer') });
    expect(prefer.solutions.map((s) => s.id)).toEqual(res.solutions.map((s) => s.id));
  });

  it('an area far from the borders: only gives nothing and says the area is why; prefer goes outside', () => {
    const far = band(map, 65, 75, 'only');
    const only = planGroup(request(map, [1, 2, 3], { area: far }));
    expect(only.status).toBe('needs-precinct-rework');
    expect(only.solutions).toEqual([]);
    expect(only.message).toMatch(/No plan moves only blocks inside the area/);
    const req = request(map, [1, 2, 3], { area: { ...far, mode: 'prefer' } });
    const prefer = planGroup(req);
    expect(prefer.status, prefer.message).toBe('ok');
    expect(prefer.message).toMatch(/^No plan moves only blocks inside the area; th/);
    expect(prefer.solutions.length).toBeGreaterThan(0);
    expectAreaPlans(map, req, prefer);
    for (const sol of prefer.solutions) expect(sol.stats.outsideArea).toBe(sol.stats.blocks);
    // The plans are those of no area.
    const none = planGroup(request(map, [1, 2, 3]));
    expect(new Set(prefer.solutions.map((s) => s.id))).toEqual(new Set(none.solutions.map((s) => s.id)));
  });

  it('an area over one border only: only cannot finish; prefer plans go outside it as little as the plans allow', () => {
    // Columns 10-19 hold the 1 | 2 border but none of 2 | 3.
    const only = planGroup(request(map, [1, 2, 3], { area: band(map, 10, 20, 'only') }));
    expect(only.status).toBe('needs-precinct-rework');
    expect(only.message).toMatch(/inside the area/);
    const req = request(map, [1, 2, 3], { area: band(map, 10, 20, 'prefer') });
    const prefer = planGroup(req);
    expect(prefer.status, prefer.message).toBe('ok');
    expectAreaPlans(map, req, prefer);
    for (const sol of prefer.solutions) {
      expect(sol.stats.outsideArea).toBeGreaterThan(0);
      expect(sol.stats.outsideArea).toBeLessThan(sol.stats.blocks);
    }
  });

  it('prefer: when a plan kind fails inside the area, plans made without it are appended after the inside ones', () => {
    // A solver that cannot realize the fewest-blocks kind (its large perBlock weight) while the
    // blocks outside the area are locked, the way a kind can fail on a real map.
    // The top two thirds of both borders: the plans inside are not the plans made without the area.
    const area = band(map, 10, 35, 'prefer', 0, 30);
    const probe = area.inside.indexOf(0);
    const base = makeSolver();
    const failing: GroupSolveRequest['solver'] = {
      solve: (r) => base.solve(r),
      capacity: (r) => base.capacity(r),
      solveScored: (r) => ((r.weights?.perBlock ?? 0) >= 0.5 && r.locked?.[probe] ? [] : base.solveScored(r)),
    };
    const req = { ...request(map, [1, 2, 3], { area }), solver: failing };
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expect(res.failures.some((f) => f.kind === 'fewest-blocks')).toBe(true);
    expectAreaPlans(map, req, res);
    expect(res.solutions[0].stats.outsideArea).toBe(0);
    expect(res.solutions.length).toBeLessThanOrEqual(3);
    // Every distinct plan of both passes is offered (there are at most three).
    const effect = (sol: Solution) => snapshot(sol.transfers);
    const inside = planGroup({ ...req, area: { ...area, mode: 'only' } });
    const anywhere = planGroup({ ...req, area: undefined });
    const all = new Set([...inside.solutions, ...anywhere.solutions].map(effect));
    expect(new Set(res.solutions.map(effect))).toEqual(all);
    expect(all.size).toBeGreaterThan(inside.solutions.length);
  });

  it('prefer: fewer plans inside than requested with no kind failing (the kinds agree on one plan): plans made without the area fill the places', () => {
    // While the blocks outside the area are locked, every kind gets the default weights, so the
    // kinds find the same plan: one plan inside, and no failure to say places are empty.
    const area = band(map, 10, 35, 'prefer', 0, 30);
    const probe = area.inside.indexOf(0);
    const base = makeSolver();
    const same = <R extends { weights?: unknown; locked?: Uint8Array }>(r: R): R => (r.locked?.[probe] ? { ...r, weights: undefined } : r);
    const solver: GroupSolveRequest['solver'] = {
      solve: (r) => base.solve(same(r)),
      capacity: (r) => base.capacity(same(r)),
      solveScored: (r) => base.solveScored(same(r)),
    };
    const req = { ...request(map, [1, 2, 3], { area }), solver };
    const inside = planGroup({ ...req, area: { ...area, mode: 'only' } });
    expect(inside.status, inside.message).toBe('ok');
    expect(inside.solutions.length).toBe(1);
    expect(inside.failures).toEqual([]);
    const anywhere = planGroup({ ...req, area: undefined });
    const effect = (sol: Solution) => snapshot(sol.transfers);
    const all = new Set([...inside.solutions, ...anywhere.solutions].map(effect));
    expect(all.size).toBeGreaterThan(1);
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectAreaPlans(map, req, res);
    expect(res.solutions[0].stats.outsideArea).toBe(0);
    expect(effect(res.solutions[0])).toBe(effect(inside.solutions[0]));
    // Every distinct plan of both passes, up to the requested three.
    expect(res.solutions.length).toBe(Math.min(3, all.size));
    for (const sol of res.solutions) expect(all.has(effect(sol))).toBe(true);
  });

  it('feasibility is about populations: an unbalanced group is unbalanced with or without an area', () => {
    const none = planGroup(request(map, [1, 2]));
    const res = planGroup(request(map, [1, 2], { area: band(map, 10, 35, 'only') }));
    expect(none.status).toBe('group-unbalanced');
    expect(res.status).toBe('group-unbalanced');
    expect(res.message).toBe(none.message);
    expect(res.feasibility).toEqual(none.feasibility);
  });

  it('a group of one with absorbing neighbors (the one-district fallback) honors the area', () => {
    const one = strips([0, 350, -200, -150, 0]);
    const req = request(one, [2], { allowOutsideAbsorb: true, area: band(one, 25, 35, 'only') });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectAreaPlans(one, req, res, { allowOutside: true });
    // Only the 2 | 3 border is in the area: every plan gives to District 3, none to District 1.
    for (const sol of res.solutions) expect(sol.transfers.every((t) => t.from === 2 && t.to === 3)).toBe(true);
    // Prefer with the area over the 1 | 2 border: inside plans exist there too (1 can take from 2).
    const left = request(one, [2], { allowOutsideAbsorb: true, area: band(one, 10, 20, 'prefer') });
    const leftRes = planGroup(left);
    expect(leftRes.status, leftRes.message).toBe('ok');
    expectAreaPlans(one, left, leftRes, { allowOutside: true });
  });

  it('re-plan from here: painted blocks and blocks outside the area both stay put', () => {
    const whole = setDeviations(generateMap({ seed: 11, width: 60, height: 60, numDistricts: 6 }), [120, -80, 60, -100, 0, 0]);
    const first = planGroup(request(whole, range(6)));
    expect(first.status, first.message).toBe('ok');
    const plan = first.solutions[0];
    const painted = plan.transfers.slice(0, Math.ceil(plan.transfers.length / 2));
    const assignment = applyTransfers(whole.assignment, painted);
    const locked = new Uint8Array(whole.graph.n);
    for (const t of painted) for (const b of t.blocks) locked[b] = 1;
    const midway = { ...whole, assignment };
    for (const mode of ['only', 'prefer'] as const) {
      // The left two thirds of the map.
      const req = request(midway, range(6), { locked, area: band(midway, 0, 40, mode) });
      const res = planGroup(req);
      expect(res.status, res.message).toBe('ok');
      expectAreaPlans(midway, req, res, { locked });
    }
  });

  it('reports progress monotonically across both passes and finishes at done === total', () => {
    const calls: Array<[number, number]> = [];
    const res = planGroup(request(map, [1, 2, 3], { area: band(map, 65, 75, 'prefer'), onProgress: (d, t) => calls.push([d, t]) }));
    expect(res.status).toBe('ok');
    expect(calls.length).toBeGreaterThan(2);
    for (let i = 0; i < calls.length; i++) {
      expect(calls[i][0]).toBeLessThanOrEqual(calls[i][1]);
      if (i) expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]);
      if (i < calls.length - 1) expect(calls[i][0]).toBeLessThan(calls[i][1]);
    }
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(last[1]);
  });

  it('is deterministic, and rejects an area that does not match the graph', () => {
    const req = request(map, [1, 2, 3], { area: band(map, 10, 20, 'prefer') });
    expect(snapshot(planGroup(req))).toBe(snapshot(planGroup({ ...req, solver: makeSolver() })));
    const bad = planGroup(request(map, [1, 2, 3], { area: { inside: new Uint8Array(3), mode: 'only' } }));
    expect(bad.status).toBe('error');
  });
});

describe(`[${SOLVER_NAME} solver] Unassigned with an area`, () => {
  /** Strips with District 5 erased: District 4 touches District 3 and Unassigned. */
  function partial(devs: number[]): SynthMap {
    const m = strips(devs);
    const assignment = m.assignment.slice();
    for (let b = 0; b < assignment.length; b++) if (assignment[b] === 5) assignment[b] = 0;
    return { ...m, assignment };
  }

  it('an area over the border with Unassigned only: every plan trades with Unassigned', () => {
    const map = partial([0, 0, 0, 40, -40]);
    // Columns 55-64: District 4's border with Unassigned (column 59 | 60).
    const req = request(map, [4], { allowOutsideAbsorb: true, includeUnassigned: true, area: band(map, 55, 65, 'only') });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectAreaPlans(map, req, res, { allowOutside: true });
    for (const sol of res.solutions) expect(sol.transfers.every((t) => t.to === 0)).toBe(true);
    // Over the border with District 3 only: every plan gives to District 3.
    const real = request(map, [4], { allowOutsideAbsorb: true, includeUnassigned: true, area: band(map, 40, 50, 'only') });
    const realRes = planGroup(real);
    expect(realRes.status, realRes.message).toBe('ok');
    expectAreaPlans(map, real, realRes, { allowOutside: true });
    for (const sol of realRes.solutions) expect(sol.transfers.every((t) => t.to === 3)).toBe(true);
  });
});
