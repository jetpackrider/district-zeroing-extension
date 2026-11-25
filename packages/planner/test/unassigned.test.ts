/**
 * Unassigned (district 0) as a trading partner, for maps still being drawn (UNASSIGNED in
 * @zd/contracts). The maps are 5-district strips with District 5 erased, so District 4's
 * only real neighbor is District 3 and the rest of its border is unassigned blocks. The
 * targets keep the whole state's population, as DRA's do.
 *
 * Runs with the reference solver (npm test) and the real engine (npm run test:engine).
 */
import { describe, expect, it } from 'vitest';
import type { BorderSolveRequest, BorderSolver, CapacityCurve, GroupSolveRequest, Solution, Transfer } from '@zd/contracts';
import {
  analyzeGroup, checkGroupFeasibility, districtAdjacency, planFlow, planGroup, planMetrics, resolveWeights,
  unassignedContact, unassignedPermitted, verifyPlan, FLOW_PARAMS,
} from '../src/index';
import { expectGoodPlan } from './support/check';
import { ReferenceSolver } from './support/refSolver';
import { RestrictedSolver, dir, type Allowed } from './support/restricted';
import { makeSolver } from './support/solvers';
import { generateMap, popsOf, setDeviations, type SynthMap } from './support/synth';

/** Strips map with deviations `devs`, then every block of District 5 erased (set to 0). */
function partial(devs: number[], seed = 3): SynthMap {
  const map = setDeviations(generateMap({ seed, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), devs);
  const assignment = map.assignment.slice();
  for (let b = 0; b < assignment.length; b++) if (assignment[b] === 5) assignment[b] = 0;
  return { ...map, assignment };
}

function request(map: SynthMap, districts: number[], solver: BorderSolver, extra: Partial<GroupSolveRequest> = {}): GroupSolveRequest {
  return { graph: map.graph, assignment: map.assignment, targets: map.targets, districts, solver, ...extra };
}

/** Records every border the planner asks about. */
class Recorder implements BorderSolver {
  pairs = new Set<string>();
  constructor(readonly base: BorderSolver) {}
  solve(req: BorderSolveRequest) { this.pairs.add(dir(req.from, req.to)); return this.base.solve(req); }
  solveScored(req: BorderSolveRequest) { this.pairs.add(dir(req.from, req.to)); return this.base.solveScored(req); }
  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve { this.pairs.add(dir(req.from, req.to)); return this.base.capacity(req); }
  touchedUnassigned() { return [...this.pairs].some((p) => p.startsWith('0>') || p.endsWith('>0')); }
}

const touchesZero = (sol: Solution) => sol.transfers.some((t) => t.from === 0 || t.to === 0);
const net = (sol: Solution, a: number, b: number) =>
  sol.transfers.reduce((s, t) => s + (t.from === a && t.to === b ? t.people : t.from === b && t.to === a ? -t.people : 0), 0);

/** Every plan: good by the test-side check and by verifyPlan with the same permission; never a deviation for 0. */
function expectPlans(map: SynthMap, req: GroupSolveRequest, sols: Solution[]) {
  expect(sols.length).toBeGreaterThan(0);
  for (const sol of sols) {
    expectGoodPlan(map, sol, req.districts, { allowOutside: true });
    const check = verifyPlan({ ...req, transfers: sol.transfers });
    expect(check.ok, JSON.stringify(check.issues)).toBe(true);
    expect(sol.deviations.some((d) => d.district === 0)).toBe(false);
    expect(sol.stats.districtsTouched).toBe(new Set(sol.transfers.flatMap((t) => [t.from, t.to]).filter((d) => d)).size);
  }
}

describe('adjacency and permission', () => {
  it('districtAdjacency still never lists 0; unassignedContact reports who touches it', () => {
    const map = partial([0, 0, 0, 5, -5]);
    const adj = districtAdjacency(map.graph, map.assignment, 5);
    expect(adj[4]).toEqual([3]);
    expect(adj.every((list) => !list.includes(0))).toBe(true);
    expect(Array.from(unassignedContact(map.graph, map.assignment, 5))).toEqual([0, 0, 0, 0, 1, 0]);
    // A complete map touches nothing.
    const full = setDeviations(generateMap({ seed: 3, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), [0, 0, 0, 0, 0]);
    expect(Array.from(unassignedContact(full.graph, full.assignment, 5)).every((x) => x === 0)).toBe(true);
  });

  it('permission needs allowOutsideAbsorb, and then 0 in absorbers or includeUnassigned without absorbers', () => {
    expect(unassignedPermitted({})).toBe(false);
    expect(unassignedPermitted({ includeUnassigned: true })).toBe(false);
    expect(unassignedPermitted({ absorbers: [0] })).toBe(false);
    expect(unassignedPermitted({ allowOutsideAbsorb: true })).toBe(false);
    expect(unassignedPermitted({ allowOutsideAbsorb: true, includeUnassigned: true })).toBe(true);
    expect(unassignedPermitted({ allowOutsideAbsorb: true, absorbers: [0] })).toBe(true);
    expect(unassignedPermitted({ allowOutsideAbsorb: true, absorbers: [3, 0] })).toBe(true);
    expect(unassignedPermitted({ allowOutsideAbsorb: true, absorbers: [3], includeUnassigned: true })).toBe(false);
    expect(unassignedPermitted({ allowOutsideAbsorb: true, absorbers: [], includeUnassigned: true })).toBe(false);
  });
});

describe('feasibility', () => {
  const map = partial([0, 0, 0, 5, -5]);
  const base = { graph: map.graph, assignment: map.assignment, targets: map.targets };

  it('a group of one touching Unassigned it may use is feasible; excess never counts Unassigned', () => {
    expect(checkGroupFeasibility({ ...base, districts: [4] }).feasible).toBe(false);
    expect(checkGroupFeasibility({ ...base, districts: [4] }).excess).toBe(5);
    expect(checkGroupFeasibility({ ...base, districts: [4], allowOutsideAbsorb: true, absorbers: [] })).toEqual({ feasible: false, excess: 5, suggestAdd: [] });
    expect(checkGroupFeasibility({ ...base, districts: [4], allowOutsideAbsorb: true, absorbers: [0] })).toEqual({ feasible: true, excess: 0, suggestAdd: [] });
    expect(checkGroupFeasibility({ ...base, districts: [4], allowOutsideAbsorb: true, includeUnassigned: true })).toEqual({ feasible: true, excess: 0, suggestAdd: [] });
    const a = analyzeGroup({ ...base, districts: [4], allowOutsideAbsorb: true, absorbers: [0] });
    expect(a.message).toBe('This group is 5 over; Unassigned will take up the difference.');
    expect(a.components[0].touchesUnassigned).toBe(true);
    expect(a.components[0].outsideNeighbors).toEqual([3]);
    // Without permission nothing about 0 is reported.
    expect(analyzeGroup({ ...base, districts: [4], allowOutsideAbsorb: true }).components[0].touchesUnassigned).toBe(false);
  });

  it('an under group gets from Unassigned only the people in the unassigned blocks it touches', () => {
    // District 4 is 5 under. Emptying the unassigned strip leaves Unassigned nobody to give, so
    // it no longer makes the group feasible; with at least 5 people there it does again.
    const map = partial([0, 0, 0, -5, 5]);
    const empty = { ...map.graph, pop: map.graph.pop.map((p, b) => (map.assignment[b] === 0 ? 0 : p)) };
    const req = { graph: empty, assignment: map.assignment, targets: map.targets, districts: [4], allowOutsideAbsorb: true, absorbers: [0] };
    const a = analyzeGroup(req);
    expect(a.feasible).toBe(false);
    expect(a.excess).toBe(-5);
    expect(a.components[0]).toMatchObject({ touchesUnassigned: true, unassignedPeople: 0 });
    expect(a.message).toBe('This group is 5 under. The unassigned blocks next to it hold nobody.');
    expect(planGroup({ ...req, solver: new ReferenceSolver() }).status).toBe('group-unbalanced');
    // Four people in one unassigned block next to District 4: still short.
    let next = -1;
    for (let b = 0; b < empty.n && next < 0; b++) {
      if (map.assignment[b] !== 0) continue;
      for (let e = empty.adjOffsets[b]; e < empty.adjOffsets[b + 1]; e++) if (map.assignment[empty.adjTargets[e]] === 4) next = b;
    }
    const four = { ...empty, pop: empty.pop.map((p, b) => (b === next ? 4 : p)) };
    const short = analyzeGroup({ ...req, graph: four });
    expect(short.feasible).toBe(false);
    expect(short.message).toBe('This group is 5 under. The unassigned blocks next to it hold only 4 people.');
    // With the people left in place, and for an over group even next to empty blocks, it is feasible.
    expect(analyzeGroup({ ...req, graph: map.graph }).feasible).toBe(true);
    const over = partial([0, 0, 0, 5, -5]);
    const overEmpty = { ...over.graph, pop: over.graph.pop.map((p, b) => (over.assignment[b] === 0 ? 0 : p)) };
    expect(analyzeGroup({ ...req, graph: overEmpty, assignment: over.assignment, targets: over.targets }).feasible).toBe(true);
  });

  it('Unassigned does not help a group that does not touch it, and needs allowOutsideAbsorb', () => {
    const far = partial([0, 0, 7, 0, -7]);
    const req = { graph: far.graph, assignment: far.assignment, targets: far.targets };
    expect(checkGroupFeasibility({ ...req, districts: [3], allowOutsideAbsorb: true, absorbers: [0] }).feasible).toBe(false);
    expect(checkGroupFeasibility({ ...req, districts: [3, 4], allowOutsideAbsorb: true, absorbers: [0] }).feasible).toBe(true);
    expect(checkGroupFeasibility({ ...req, districts: [3, 4], includeUnassigned: true }).feasible).toBe(false);
    expect(checkGroupFeasibility({ ...req, districts: [3, 4], allowOutsideAbsorb: true, absorbers: [2], includeUnassigned: true }).feasible).toBe(true);
    expect(checkGroupFeasibility({ ...req, districts: [3, 4], allowOutsideAbsorb: true, absorbers: [1], includeUnassigned: true }).feasible).toBe(false);
  });
});

describe('planGroup with Unassigned', () => {
  it('group of one, only Unassigned available (absorbers [0]): gives the excess to it', () => {
    const map = partial([0, 0, 0, 5, -5]);
    const solver = new Recorder(makeSolver());
    const req = request(map, [4], solver, { allowOutsideAbsorb: true, absorbers: [0] });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expect(res.feasibility).toEqual({ feasible: true, excess: 0, suggestAdd: [] });
    expectPlans(map, req, res.solutions);
    for (const sol of res.solutions) {
      expect(sol.transfers.every((t) => t.from === 4 && t.to === 0)).toBe(true);
      expect(sol.borderFlows).toEqual([{ from: 4, to: 0, people: 5 }]);
      expect(sol.deviations.map((d) => d.district)).toEqual([4]);
      // Without permission the same plan is rejected by the verifier.
      expect(verifyPlan({ ...req, absorbers: undefined, transfers: sol.transfers }).issues.some((i) => i.kind === 'outside-touched')).toBe(true);
      expect(verifyPlan({ ...req, absorbers: [3], transfers: sol.transfers }).ok).toBe(false);
    }
    // District 3 was not offered.
    expect([...solver.pairs].some((p) => p.includes('3'))).toBe(false);
  });

  it('group of one under target takes unassigned blocks', () => {
    const map = partial([0, 0, 0, -6, 6]);
    const req = request(map, [4], makeSolver(), { allowOutsideAbsorb: true, absorbers: [0] });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectPlans(map, req, res.solutions);
    for (const sol of res.solutions) {
      expect(sol.borderFlows).toEqual([{ from: 0, to: 4, people: 6 }]);
      expect(sol.transfers.every((t) => t.from === 0 && t.to === 4)).toBe(true);
    }
  });

  it('group touching Unassigned with includeUnassigned: the group sheds its excess there, not onto a zeroed neighbor', () => {
    // 3 and 4 together are 7 over; 2 is at zero; only 4 touches Unassigned, so 3's people go through 4.
    const map = partial([0, 0, 4, 3, -7]);
    expect(checkGroupFeasibility({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [3, 4] }).excess).toBe(7);
    const req = request(map, [3, 4], makeSolver(), { allowOutsideAbsorb: true, includeUnassigned: true });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectPlans(map, req, res.solutions);
    const before = popsOf(map.graph, map.assignment, 5);
    for (const sol of res.solutions) {
      expect(net(sol, 4, 0)).toBe(7);
      expect(net(sol, 3, 4)).toBe(4);
      const after = popsOf(map.graph, (() => { const a = map.assignment.slice(); for (const t of sol.transfers) for (const b of t.blocks) a[b] = t.to; return a; })(), 5);
      expect(after[2]).toBe(before[2]);
      expect(after[1]).toBe(before[1]);
    }
  });

  it('a real neighbor the move brings toward zero is used before Unassigned', () => {
    // 4 is 5 over and 3 is 5 under: trading with 3 fixes both; Unassigned is also allowed.
    const map = partial([0, 0, -5, 5, 0]);
    const req = request(map, [4], makeSolver(), { allowOutsideAbsorb: true, includeUnassigned: true });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectPlans(map, req, res.solutions);
    expect(res.solutions[0].borderFlows).toEqual([{ from: 4, to: 3, people: 5 }]);
  });

  it('flow: Unassigned takes or gives any amount; a real absorber helped toward zero comes first, one pushed from zero last', () => {
    const curve = (from: number, to: number): CapacityCurve => ({ from, to, tiers: [{ kind: 'no-split', people: 100, costPerPerson: 1 }] });
    const curves = new Map([[4 * 65536 + 3, curve(4, 3)], [3 * 65536 + 4, curve(3, 4)], [4 * 65536, curve(4, 0)], [4, curve(0, 4)]]);
    const borders: Array<[number, number]> = [[4, 3], [3, 4], [4, 0], [0, 4]];
    const run = (supply: number, three: number) => planFlow({
      members: [4], supply: new Map([[4, supply]]), hi: 0, borders, curves,
      absorbers: new Map([[3, three], [0, 0]]), free: new Set([0]), caps: new Map(), params: FLOW_PARAMS['fewest-splits'],
    });
    expect(run(5, -5).borders).toEqual([{ from: 4, to: 3, people: 5 }]);
    expect(run(5, 0).borders).toEqual([{ from: 4, to: 0, people: 5 }]);
    expect(run(-30, 0).borders).toEqual([{ from: 0, to: 4, people: 30 }]);
    expect(run(-30, 40).borders).toEqual([{ from: 3, to: 4, people: 30 }]);
    // 3 is 1 over: overshooting it (to 29 under) is worse than taking from Unassigned.
    expect(run(-30, 1).borders).toEqual([{ from: 0, to: 4, people: 30 }]);
    // 3 can take only 2 toward zero: for 2 people a second border's fixed charge is not worth
    // it, so all 5 go to Unassigned; without fixed charges 3 takes its 2 and Unassigned the rest.
    expect(run(5, -2).borders).toEqual([{ from: 4, to: 0, people: 5 }]);
    const linear = planFlow({
      members: [4], supply: new Map([[4, 5]]), hi: 0, borders, curves,
      absorbers: new Map([[3, -2], [0, 0]]), free: new Set([0]), caps: new Map(), params: { ...FLOW_PARAMS['fewest-splits'], fixedCharge: 0 },
    });
    expect(linear.borders).toEqual([{ from: 4, to: 0, people: 3 }, { from: 4, to: 3, people: 2 }]);
  });

  it('avoids a two-way trade with Unassigned when the net amount can cross one way', () => {
    const map = partial([0, 0, 0, 5, -5]);
    const allowed: Allowed = new Map([[dir(4, 0), [5, 9, 13]], [dir(0, 4), [4, 8]]]);
    const req = request(map, [4], new RestrictedSolver(new ReferenceSolver(), allowed), { allowOutsideAbsorb: true, absorbers: [0] });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) expect(sol.borderFlows).toEqual([{ from: 4, to: 0, people: 5 }]);
  });

  it('falls back to a swap with Unassigned only when nothing else hits the number', () => {
    const map = partial([0, 0, 0, 5, -5]);
    const allowed: Allowed = new Map([[dir(4, 0), [9, 13]], [dir(0, 4), [4, 8]]]);
    const req = request(map, [4], new RestrictedSolver(new ReferenceSolver(), allowed), { allowOutsideAbsorb: true, absorbers: [0] });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectPlans(map, req, res.solutions);
    for (const sol of res.solutions) expect(net(sol, 4, 0)).toBe(5);
  });

  it('the one-district fallback request shape works with 0 among chosen absorbers', () => {
    // What the extension sends when the single-district solver finds nothing.
    const map = partial([0, 0, -2, 9, -7]);
    const req = request(map, [4], makeSolver(), { allowOutsideAbsorb: true, absorbers: [3, 0] });
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectPlans(map, req, res.solutions);
    for (const sol of res.solutions) {
      expect(sol.transfers.every((t) => [t.from, t.to].every((d) => d === 0 || d === 3 || d === 4))).toBe(true);
      expect(net(sol, 4, 0) + net(sol, 4, 3)).toBe(9);
    }
  });

  it('names Unassigned in its failure message, never "District 0"', () => {
    // Every border District 4 could use delivers nothing, so the planner gives up; the message
    // reaches the panel (the extension appends it to the one-district result).
    const map = partial([0, 0, 0, 5, -5]);
    const none: Allowed = new Map([[dir(4, 0), []], [dir(0, 4), []], [dir(4, 3), []], [dir(3, 4), []], [dir(3, 0), []], [dir(0, 3), []]]);
    const cases: Array<[Partial<GroupSolveRequest>, string]> = [
      [{ absorbers: [0] }, 'with Unassigned ('],
      [{ includeUnassigned: true }, 'with District 3 and Unassigned ('],
    ];
    for (const [extra, partners] of cases) {
      const res = planGroup(request(map, [4], new RestrictedSolver(new ReferenceSolver(), none), { allowOutsideAbsorb: true, ...extra }));
      expect(res.status).toBe('needs-precinct-rework');
      expect(res.message).toMatch(/^District 4 is still 5 over: /);
      expect(res.message).toContain(partners);
      expect(res.message).not.toMatch(/District(s)? [^.]*\b0\b/);
    }
  });
});

describe('without permission, district 0 is never touched', () => {
  it('group of one with outside absorb but no permission uses only real neighbors and never asks about 0', () => {
    const map = partial([0, 0, 0, 5, -5]);
    for (const extra of [
      { allowOutsideAbsorb: true },
      { allowOutsideAbsorb: true, absorbers: [3] },
      { allowOutsideAbsorb: true, absorbers: [3], includeUnassigned: true },
    ] as Array<Partial<GroupSolveRequest>>) {
      const solver = new Recorder(makeSolver());
      const res = planGroup(request(map, [4], solver, extra));
      expect(res.status, res.message).toBe('ok');
      expect(res.solutions.some(touchesZero)).toBe(false);
      expect(solver.touchedUnassigned()).toBe(false);
      for (const sol of res.solutions) expect(sol.borderFlows).toEqual([{ from: 4, to: 3, people: 5 }]);
    }
  });

  it('includeUnassigned or absorbers [0] without allowOutsideAbsorb changes nothing', () => {
    const map = partial([0, 0, 0, 5, -5]);
    for (const extra of [{ includeUnassigned: true }, { absorbers: [0] }, { absorbers: [0], includeUnassigned: true }] as Array<Partial<GroupSolveRequest>>) {
      const solver = new Recorder(makeSolver());
      expect(planGroup(request(map, [4], solver, extra)).status).toBe('group-unbalanced');
      expect(solver.touchedUnassigned()).toBe(false);
    }
  });

  it('a group of districts on a partly drawn map is planned among its members only', () => {
    const map = partial([0, 0, 3, -3, 0]);
    const solver = new Recorder(makeSolver());
    const req = request(map, [3, 4], solver);
    const res = planGroup(req);
    expect(res.status, res.message).toBe('ok');
    expectPlans(map, req, res.solutions);
    expect(res.solutions.some(touchesZero)).toBe(false);
    expect(solver.touchedUnassigned()).toBe(false);
  });
});

describe('verifyPlan and planMetrics with Unassigned', () => {
  const map = partial([0, 0, 0, 0, 0]);
  const { graph } = map;
  const W = 75;
  // The first column of the erased strip and District 4's last column.
  let firstZeroCol = W;
  for (let b = 0; b < graph.n; b++) if (map.assignment[b] === 0) firstZeroCol = Math.min(firstZeroCol, b % W);
  const at = (x: number, y: number) => y * W + x;
  const transfer = (from: number, to: number, blocks: number[]): Transfer => {
    const sorted = [...blocks].sort((a, b) => a - b);
    return { from, to, blocks: Uint32Array.from(sorted), people: sorted.reduce((s, b) => s + graph.pop[b], 0) };
  };
  const base = { graph, assignment: map.assignment, targets: map.targets };

  it('accepts 0 as an endpoint only with permission, and never requires it to be contiguous or zeroed', () => {
    // A whole row of the erased strip, attached to District 4: cuts Unassigned in two.
    const row: number[] = [];
    for (let x = firstZeroCol; x < W; x++) row.push(at(x, 20));
    const t = transfer(0, 4, row);
    const kinds = (extra: object) => verifyPlan({ ...base, districts: [], transfers: [t], ...extra }).issues.map((i) => i.kind);
    // With permission and 4 an outside absorber, the only issue is that neither side is selected.
    expect(kinds({ allowOutsideAbsorb: true, absorbers: [0, 4] })).toEqual(['outside-touched']);
    // With 4 selected, only its target is missed: no rule for 0 (no target, no pieces).
    const sel = verifyPlan({ ...base, districts: [4], allowOutsideAbsorb: true, absorbers: [0], transfers: [t] });
    expect(sel.issues.map((i) => i.kind)).toEqual(['not-zeroed']);
    expect(verifyPlan({ ...base, districts: [4], allowOutsideAbsorb: true, includeUnassigned: true, transfers: [t] }).issues.map((i) => i.kind)).toEqual(['not-zeroed']);
    // Without permission: 0 must stay untouched.
    for (const extra of [{}, { allowOutsideAbsorb: true }, { allowOutsideAbsorb: true, absorbers: [3] }, { includeUnassigned: true }, { allowOutsideAbsorb: true, absorbers: [3], includeUnassigned: true }]) {
      const issues = verifyPlan({ ...base, districts: [4], transfers: [t], ...extra }).issues;
      expect(issues.some((i) => i.kind === 'outside-touched' && i.district === 0)).toBe(true);
    }
  });

  it('the real district still may not gain a piece from unassigned blocks', () => {
    const t = transfer(0, 4, [at(W - 1, 0)]); // far corner of the erased strip
    const issues = verifyPlan({ ...base, districts: [4], allowOutsideAbsorb: true, absorbers: [0], transfers: [t] }).issues;
    expect(issues.some((i) => i.kind === 'new-piece' && i.district === 4)).toBe(true);
  });

  it('planMetrics: a new split between real districts counts even where Unassigned already was', () => {
    //   0 1 1 2 2   One row. Blocks 0-2 are one precinct, one town and one county; block 0 is an
    //               empty unassigned block (say, water). Giving block 2 to District 2 divides
    //               them between Districts 1 and 2: new splits, as on a complete map.
    const n = 5;
    const adjOffsets = Uint32Array.from([0, 1, 3, 5, 7, 8]);
    const adjTargets = Uint32Array.from([1, 0, 2, 1, 3, 2, 4, 3]);
    const g = {
      n, pop: Int32Array.from([0, 5, 5, 5, 5]), countyOf: Uint16Array.from([1, 1, 1, 2, 2]),
      precinctOf: Uint32Array.from([9, 9, 9, 3, 4]), townOf: Uint32Array.from([1, 1, 1, 0, 0]),
      adjOffsets, adjTargets, adjLen: new Uint16Array(8).fill(10), outerLen: new Uint32Array(n), areaM2: new Float32Array(n).fill(1),
    };
    const metrics = (original: number[], transfers: Transfer[]) => {
      const final = Uint16Array.from(original);
      for (const t of transfers) for (const b of t.blocks) final[b] = t.to;
      return planMetrics(g, Uint16Array.from(original), final, transfers, map.targets, resolveWeights(), new Set([1])).stats;
    };
    const t = (from: number, to: number, blocks: number[]): Transfer => ({ from, to, blocks: Uint32Array.from(blocks), people: blocks.length * 5 });
    expect(metrics([0, 1, 1, 2, 2], [t(1, 2, [2])])).toMatchObject({ newPrecinctSplits: 1, newTownSplits: 1, newCountySplits: 1 });
    // Giving block 2 to Unassigned instead divides nothing new: the precinct was already shared.
    expect(metrics([0, 1, 1, 2, 2], [t(1, 0, [2])])).toMatchObject({ newPrecinctSplits: 0, healedPrecinctSplits: 0, newTownSplits: 0, newCountySplits: 0 });
    // Erasing District 2's part of a precinct split between Districts 1 and 2 leaves it divided
    // (with Unassigned): no heal. Erasing all but one holder's blocks does heal it.
    expect(metrics([1, 1, 2, 2, 2], [t(2, 0, [2])])).toMatchObject({ newPrecinctSplits: 0, healedPrecinctSplits: 0 });
    expect(metrics([0, 1, 2, 2, 2], [t(1, 0, [1]), t(2, 0, [2])])).toMatchObject({ newPrecinctSplits: 0, healedPrecinctSplits: 1 });
  });

  it('planMetrics: 0 is not a touched district and has no deviation; a precinct shared with 0 is split', () => {
    // District 4's whole last column (x = firstZeroCol - 1), rows 0..2: one precinct column
    // part, given to Unassigned.
    const blocks = [at(firstZeroCol - 1, 0), at(firstZeroCol - 1, 1), at(firstZeroCol - 1, 2)];
    const t = transfer(4, 0, blocks);
    const final = map.assignment.slice();
    for (const b of blocks) final[b] = 0;
    const m = planMetrics(graph, map.assignment, final, [t], map.targets, resolveWeights(), new Set([4]));
    expect(m.stats.districtsTouched).toBe(1);
    expect(m.deviations.map((d) => d.district)).toEqual([4]);
    // The precinct (3x3 tiles) held only District 4 and now holds 4 and 0 unless the whole precinct moved.
    const p = graph.precinctOf[blocks[0]];
    const inP = [];
    for (let b = 0; b < graph.n; b++) if (graph.precinctOf[b] === p) inP.push(b);
    const whole = inP.every((b) => final[b] === 0);
    expect(m.stats.newPrecinctSplits).toBe(whole ? 0 : 1);
  });
});
