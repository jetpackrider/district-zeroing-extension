/**
 * Two-way trades and multi-district residual repair, on synthetic maps with a solver that
 * can only deliver amounts from a restricted set per border and direction. The base is
 * always the reference solver, so these tests do not depend on the real engine's quirks.
 */
import { describe, expect, it } from 'vitest';
import type { BorderSolver, GroupSolveRequest, Solution } from '@zd/contracts';
import { districtAdjacency, planGroup, verifyPlan } from '../src/index';
import { ReferenceSolver } from './support/refSolver';
import { RestrictedSolver, ReturnTempter, dir, type Allowed } from './support/restricted';
import { generateMap, popsOf, setDeviations, type SynthMap } from './support/synth';
import { expectGoodPlan, snapshot } from './support/check';

function request(map: SynthMap, districts: number[], solver: BorderSolver, extra: Partial<GroupSolveRequest> = {}): GroupSolveRequest {
  return { graph: map.graph, assignment: map.assignment, targets: map.targets, districts, solver, ...extra };
}
const strips = (devs: number[], seed = 3) =>
  setDeviations(generateMap({ seed, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), devs);
const allow = (entries: Array<[number, number, number[]]>): Allowed => new Map(entries.map(([f, t, xs]) => [dir(f, t), xs]));

/** Gross people per direction and net per pair, from the plan's transfers. */
function flows(sol: Solution) {
  const gross = new Map<string, number>();
  for (const t of sol.transfers) gross.set(dir(t.from, t.to), (gross.get(dir(t.from, t.to)) ?? 0) + t.people);
  const net = (a: number, b: number) => (gross.get(dir(a, b)) ?? 0) - (gross.get(dir(b, a)) ?? 0);
  return { gross, net };
}

/** borderFlows lists each direction once with its gross amount, matching the transfers. */
function expectFlowsMatch(sol: Solution) {
  const { gross } = flows(sol);
  const listed = new Map(sol.borderFlows.map((f) => [dir(f.from, f.to), f.people]));
  expect(listed.size).toBe(sol.borderFlows.length);
  expect(listed).toEqual(gross);
}

describe('two-way trades with a solver that cannot deliver the net amount', () => {
  it('two districts: a net of 5 one way is realized as x one way and x − 5 back', () => {
    const map = strips([5, -5, 0, 0, 0]);
    expect(map.targets.remainder).toBe(0);
    const solver = new RestrictedSolver(new ReferenceSolver(), allow([[1, 2, [9, 13, 17]], [2, 1, [4, 8]]]));
    const res = planGroup(request(map, [1, 2], solver));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, [1, 2]);
      const { gross, net } = flows(sol);
      expect(net(1, 2)).toBe(5);
      expect(gross.get(dir(1, 2))).toBeGreaterThan(5);
      expect(gross.get(dir(2, 1))).toBeGreaterThan(0);
      expect(sol.transfers.length).toBe(2); // the swap only, nothing else
      expectFlowsMatch(sol);
      expect(verifyPlan({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 2], transfers: sol.transfers }).ok).toBe(true);
    }
  });

  it('uses a one-way transfer, not a swap, when the net amount is deliverable', () => {
    const map = strips([5, -5, 0, 0, 0]);
    const solver = new RestrictedSolver(new ReferenceSolver(), allow([[1, 2, [5, 9, 13]], [2, 1, [4, 8]]]));
    const res = planGroup(request(map, [1, 2], solver));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, [1, 2]);
      expect(sol.borderFlows).toEqual([{ from: 1, to: 2, people: 5 }]);
    }
  });

  it('three districts: a residual goes around a cycle A → B → C → A when no border can do it alone', () => {
    const base = generateMap({ seed: 5, width: 90, height: 90, numDistricts: 26 });
    const adj = districtAdjacency(base.graph, base.assignment, 26);
    const ref = new ReferenceSolver();
    const can = (f: number, t: number, x: number) =>
      ref.solve({ graph: base.graph, assignment: base.assignment, from: f, to: t, accept: [x], maxOptions: 1 }).length > 0;
    // A triangle a, b, c and z >= 2 with a → b: z + 1, b → c: z, c → a: z all deliverable.
    let pick: { a: number; b: number; c: number; z: number } | null = null;
    for (let a = 1; a <= 26 && !pick; a++) for (const b of adj[a]) for (const c of adj[b]) {
      if (pick || c === a || !adj[c].includes(a)) continue;
      for (let z = 2; z <= 12 && !pick; z++) if (can(a, b, z + 1) && can(b, c, z) && can(c, a, z)) pick = { a, b, c, z };
    }
    expect(pick).not.toBeNull();
    const { a, b, c, z } = pick!;
    const devs = new Array(26).fill(0);
    devs[a - 1] = 1;
    devs[b - 1] = -1;
    const map = setDeviations(base, devs);
    expect(map.targets.remainder).toBe(0);
    // Only a → b: z + 1, b → c: z, c → a: z exist. a's net −1 must be z + 1 out and z in.
    const solver = new RestrictedSolver(new ReferenceSolver(), allow([
      [a, b, [z + 1]], [b, a, []], [b, c, [z]], [c, b, []], [c, a, [z]], [a, c, []],
    ]));
    const res = planGroup(request(map, [a, b, c], solver));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, [a, b, c]);
      expectFlowsMatch(sol);
      const listed = new Map(sol.borderFlows.map((f) => [dir(f.from, f.to), f.people]));
      expect(listed).toEqual(new Map([[dir(a, b), z + 1], [dir(b, c), z], [dir(c, a), z]]));
      // Untouched outside the group.
      for (const t of sol.transfers) expect([a, b, c]).toContain(t.from);
    }
  });

  it('chain: a surplus passes through a middle district, with a swap on each link', () => {
    const map = strips([2, 0, -2, 0, 0]);
    const adj = districtAdjacency(map.graph, map.assignment, 5);
    expect(adj[1]).toEqual([2]);
    const solver = new RestrictedSolver(new ReferenceSolver(), allow([[1, 2, [5]], [2, 1, [3]], [2, 3, [6]], [3, 2, [4]]]));
    const res = planGroup(request(map, [1, 2, 3], solver));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      const final = expectGoodPlan(map, sol, [1, 2, 3]);
      expectFlowsMatch(sol);
      const { net } = flows(sol);
      expect(net(1, 2)).toBe(2);
      expect(net(2, 3)).toBe(2);
      expect(popsOf(map.graph, final, 5)[2]).toBe(popsOf(map.graph, map.assignment, 5)[2]);
      expect(sol.borderFlows.length).toBe(4);
    }
  });

  it('a return trade never sends back blocks that already crossed, even when the solver offers them', () => {
    // 1 → 2 can only land between 103 and 120 (not the 100 needed), so 2 must return the difference.
    const map = strips([100, -100, 0, 0, 0]);
    const tempter = new ReturnTempter(new ReferenceSolver(), map.assignment);
    const restricted = new RestrictedSolver(tempter, allow([[1, 2, Array.from({ length: 18 }, (_, i) => 103 + i)]]));
    const res = planGroup(request(map, [1, 2], restricted));
    expect(res.status, res.message).toBe('ok');
    expect(tempter.injected).toBeGreaterThan(0); // the tempting answer really was offered
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, [1, 2]); // checks no block moves twice
      const { gross, net } = flows(sol);
      expect(net(1, 2)).toBe(100);
      expect(gross.get(dir(2, 1))).toBeGreaterThan(0);
      const out = new Set(sol.transfers.filter((t) => t.from === 1).flatMap((t) => [...t.blocks]));
      for (const t of sol.transfers.filter((t) => t.from === 2)) for (const blk of t.blocks) expect(out.has(blk)).toBe(false);
    }
    // And the planner always tells the solver which blocks already moved.
    for (const req of restricted.requests) {
      for (let blk = 0; blk < map.graph.n; blk++) {
        if (req.assignment[blk] !== map.assignment[blk]) expect(req.locked?.[blk], `moved block ${blk} not locked`).toBe(1);
      }
    }
  });

  it('a group of one with absorbing neighbors trades two ways when one way cannot hit the number', () => {
    const map = strips([0, 3, -3, 0, 0]);
    const solver = new RestrictedSolver(new ReferenceSolver(), allow([[2, 1, []], [1, 2, []], [2, 3, [8]], [3, 2, [5]]]));
    const res = planGroup(request(map, [2], solver, { allowOutsideAbsorb: true }));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      const final = expectGoodPlan(map, sol, [2], { allowOutside: true });
      expect(new Map(sol.borderFlows.map((f) => [dir(f.from, f.to), f.people]))).toEqual(new Map([[dir(2, 3), 8], [dir(3, 2), 5]]));
      const before = popsOf(map.graph, map.assignment, 5);
      const after = popsOf(map.graph, final, 5);
      expect(after[3] - before[3]).toBe(3);
      expect(after[1]).toBe(before[1]);
    }
  });

  it('trades two ways with the chosen neighbor even when another can absorb in one move', () => {
    const map = strips([0, 3, -3, 0, 0]);
    const solver = new RestrictedSolver(new ReferenceSolver(), allow([
      [2, 1, [3]], [2, 3, [8]], [3, 2, [5]],
    ]));
    const res = planGroup(request(map, [2], solver, { allowOutsideAbsorb: true, absorbers: [3] }));
    expect(res.status, res.message).toBe('ok');
    expect(solver.requests.length).toBeGreaterThan(0);
    expect(solver.requests.every(({ from, to }) =>
      (from === 2 && to === 3) || (from === 3 && to === 2))).toBe(true);
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, [2], { allowOutside: true });
      expect(sol.borderFlows).toEqual([{ from: 2, to: 3, people: 8 }, { from: 3, to: 2, people: 5 }]);
    }
    for (const extra of [
      { allowOutsideAbsorb: true, absorbers: [] },
      { allowOutsideAbsorb: true, absorbers: [4] },
      { allowOutsideAbsorb: false, absorbers: [3] },
    ]) {
      expect(planGroup(request(map, [2], solver, extra)).status).toBe('group-unbalanced');
    }
  });

  it('reports a residual that no deliverable combination can place, without a partial plan', () => {
    // Every amount either way is even, so a net of 1 is impossible.
    const map = strips([1, -1, 0, 0, 0]);
    const solver = new RestrictedSolver(new ReferenceSolver(), allow([[1, 2, [4, 8, 12]], [2, 1, [2, 6, 10]]]));
    const res = planGroup(request(map, [1, 2], solver));
    expect(res.status).toBe('needs-precinct-rework');
    expect(res.solutions).toEqual([]);
    expect(res.feasibility.feasible).toBe(true);
    expect(res.message).toMatch(/District [12] is still 1 (over|under)/);
    expect(res.failures.length).toBe(3);
    for (const f of res.failures) expect(f.stuck?.district === 1 || f.stuck?.district === 2).toBe(true);
    expect(solver.calls.solve).toBeLessThan(400);
  });

  it('is deterministic and leaves the input untouched', () => {
    const map = strips([2, 0, -2, 0, 0]);
    const before = map.assignment.slice();
    const mk = () => new RestrictedSolver(new ReferenceSolver(), allow([[1, 2, [5]], [2, 1, [3]], [2, 3, [6]], [3, 2, [4]]]));
    const a = planGroup(request(map, [1, 2, 3], mk()));
    const b = planGroup(request(map, [1, 2, 3], mk()));
    expect(snapshot(a)).toBe(snapshot(b));
    expect(map.assignment).toEqual(before);
  });

  it('honors locked blocks in the repair stage', () => {
    const map = strips([5, -5, 0, 0, 0]);
    const mk = () => new RestrictedSolver(new ReferenceSolver(), allow([[1, 2, [9, 13, 17]], [2, 1, [4, 8]]]));
    const first = planGroup(request(map, [1, 2], mk()));
    expect(first.status).toBe('ok');
    const locked = new Uint8Array(map.graph.n);
    for (const t of first.solutions[0].transfers) for (const blk of t.blocks) locked[blk] = 1;
    const res = planGroup(request(map, [1, 2], mk(), { locked }));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) expectGoodPlan(map, sol, [1, 2], { locked });
  });
});
