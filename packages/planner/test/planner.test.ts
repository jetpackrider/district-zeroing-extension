import { describe, expect, it } from 'vitest';
import type { BorderSolver, GroupSolveRequest } from '@zd/contracts';
import { checkGroupFeasibility, districtAdjacency, planGroup, verifyPlan } from '../src/index';
import { FlakySolver } from './support/refSolver';
import { makeSolver, SOLVER_NAME } from './support/solvers';
import { applyTransfers, generateMap, popsOf, setDeviations, type SynthMap } from './support/synth';
import { expectGoodPlan, range, snapshot } from './support/check';

const KINDS = ['fewest-splits', 'fewest-blocks', 'fewest-districts'];

function request(map: SynthMap, districts: number[], solver: BorderSolver = makeSolver(), extra: Partial<GroupSolveRequest> = {}): GroupSolveRequest {
  return { graph: map.graph, assignment: map.assignment, targets: map.targets, districts, solver, ...extra };
}

/** 5 vertical strips: 1 touches only 2, 2 touches 1 and 3, and so on. */
function strips(devs: number[], seed = 3): SynthMap {
  return setDeviations(generateMap({ seed, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), devs);
}

describe(`[${SOLVER_NAME} solver] whole map, 26 districts with small deviations`, () => {
  for (const seed of [7, 11, 29]) {
    it(`seed ${seed}: every district at q or q + 1, contiguous, exact stats`, () => {
      const map = generateMap({ seed, width: 90, height: 90, numDistricts: 26 });
      const devs = popsOf(map.graph, map.assignment, 26).slice(1).map((p) => p - map.targets.q);
      expect(Math.max(...devs.map(Math.abs))).toBeLessThan(400);
      const before = map.assignment.slice();
      const res = planGroup(request(map, range(26)));
      expect(res.status, res.message).toBe('ok');
      expect(res.feasibility).toEqual({ feasible: true, excess: 0, suggestAdd: [] });
      expect(res.solutions.length).toBeGreaterThanOrEqual(1);
      expect(res.solutions.length).toBeLessThanOrEqual(3);
      expect(map.assignment).toEqual(before); // input never mutated
      const ids = new Set<string>();
      for (const sol of res.solutions) {
        expect(KINDS).toContain(sol.kind);
        ids.add(sol.id);
        const final = expectGoodPlan(map, sol, range(26));
        // Remainder logic: exactly `remainder` districts hold q + 1.
        const pops = popsOf(map.graph, final, 26).slice(1);
        expect(pops.filter((p) => p === map.targets.q + 1).length).toBe(map.targets.remainder);
        expect(verifyPlan({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: range(26), transfers: sol.transfers }).ok).toBe(true);
      }
      expect(ids.size).toBe(res.solutions.length);
      // Interaction view covers every neighboring pair.
      const adj = districtAdjacency(map.graph, map.assignment, 26);
      const pairCount = adj.reduce((s, l, d) => s + l.filter((x) => x > d).length, 0);
      expect(res.interaction.edges.length).toBe(pairCount);
      expect(res.interaction.nodes.map((x) => x.district)).toEqual(range(26));
    });
  }
});

describe('hand-picked groups', () => {
  it('routes a surplus through a middle district it must cross (1 -> 2 -> 3)', () => {
    const map = strips([400, 0, -400, 1, 1]);
    const adj = districtAdjacency(map.graph, map.assignment, 5);
    expect(adj[1]).toEqual([2]);
    expect(adj[3]).not.toContain(1);
    const res = planGroup(request(map, [1, 2, 3]));
    expect(res.status, res.message).toBe('ok');
    expect(res.interaction.edges.map((e) => [e.a, e.b])).toEqual([[1, 2], [2, 3]]);
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, [1, 2, 3]);
      expect(sol.borderFlows).toEqual([
        { from: 1, to: 2, people: 400 },
        { from: 2, to: 3, people: 400 },
      ]);
      expect(sol.transfers.every((t) => [1, 2, 3].includes(t.from) && [1, 2, 3].includes(t.to))).toBe(true);
    }
  });

  it('balances a group of 4 neighbors on a bisected map, leaving the rest untouched', () => {
    const base = generateMap({ seed: 5, width: 90, height: 90, numDistricts: 26 });
    const adj = districtAdjacency(base.graph, base.assignment, 26);
    // District 10 and three of its neighbors.
    const group = [10, ...adj[10].slice(0, 3)].sort((a, b) => a - b);
    const devs = new Array(26).fill(0);
    devs[group[0] - 1] = 180;
    devs[group[1] - 1] = -70;
    devs[group[2] - 1] = 25;
    devs[group[3] - 1] = -135 + 2; // two districts keep q + 1
    devs[25] += 3; // remainder 5 overall
    const map = setDeviations(base, devs);
    const res = planGroup(request(map, group));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      const final = expectGoodPlan(map, sol, group);
      const pops = popsOf(map.graph, final, 26);
      expect(group.filter((d) => pops[d] === map.targets.q + 1).length).toBe(2);
    }
  });

  it('reports a group that cannot balance on its own, without a partial plan', () => {
    const map = strips([1240, 0, -800, 1, -440]);
    const solver = makeSolver();
    const res = planGroup(request(map, [1, 2], solver));
    expect(res.status).toBe('group-unbalanced');
    expect(res.solutions).toEqual([]);
    // q + 1 allowed (remainder 1): 2 districts can hold 2q + 2; the group holds 2q + 1240.
    expect(res.feasibility).toEqual({ feasible: false, excess: 1238, suggestAdd: [3] });
    expect(res.message).toContain('1,238 over');
    expect(res.message).toContain('District 3');
    expect(solver.calls.solve).toBe(0);
    expect(checkGroupFeasibility({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 2] })).toEqual(res.feasibility);
  });

  it('allowOutsideAbsorb lets an adjacent outside district take the difference', () => {
    const map = strips([1240, 0, -800, 1, -440]);
    const res = planGroup(request(map, [1, 2], makeSolver(), { allowOutsideAbsorb: true }));
    expect(res.status, res.message).toBe('ok');
    expect(res.feasibility.feasible).toBe(true);
    for (const sol of res.solutions) {
      const final = expectGoodPlan(map, sol, [1, 2], { allowOutside: true });
      const before = popsOf(map.graph, map.assignment, 5);
      const after = popsOf(map.graph, final, 5);
      expect(after[3] - before[3]).toBe(1238); // 3 is the only outside neighbor
      expect(after[4]).toBe(before[4]);
      expect(after[5]).toBe(before[5]);
      // The same plan is rejected when outside districts must stay untouched.
      const strict = verifyPlan({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 2], transfers: sol.transfers });
      expect(strict.issues.some((i) => i.kind === 'outside-touched')).toBe(true);
    }
  });

  it('a group of one with absorbing neighbors is single-district mode', () => {
    const map = strips([0, 350, -200, -150, 2]);
    const res = planGroup(request(map, [2], makeSolver(), { allowOutsideAbsorb: true }));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) expectGoodPlan(map, sol, [2], { allowOutside: true });
  });
});

describe('remainder logic: which districts land on q + 1', () => {
  it('group: combined population sets the count of q + 1 districts', () => {
    const map = strips([401, 0, -399, 0, 1]); // remainder 3; group {1,2,3} is 3q + 2
    expect(map.targets.remainder).toBe(3);
    const res = planGroup(request(map, [1, 2, 3]));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      const pops = popsOf(map.graph, expectGoodPlan(map, sol, [1, 2, 3]), 5);
      expect([1, 2, 3].filter((d) => pops[d] === map.targets.q + 1).length).toBe(2);
      expect([1, 2, 3].filter((d) => pops[d] === map.targets.q).length).toBe(1);
    }
  });

  it('remainder 0: every district must hit q exactly', () => {
    const map = strips([300, 0, -300, 0, 0]);
    expect(map.targets.remainder).toBe(0);
    expect(checkGroupFeasibility({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 2] }).excess).toBe(300);
    const res = planGroup(request(map, range(5)));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      const pops = popsOf(map.graph, expectGoodPlan(map, sol, range(5)), 5);
      expect(pops.slice(1).every((p) => p === map.targets.q)).toBe(true);
    }
  });

  it('a district already at q + 1 keeps its extra person when that is cheapest', () => {
    const map = strips([1, 120, -120, 0, 0]); // remainder 1, already held by District 1
    const res = planGroup(request(map, range(5)));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      expect(sol.transfers.some((t) => t.from === 1 || t.to === 1)).toBe(false);
      expectGoodPlan(map, sol, range(5));
    }
  });
});

describe('re-planning when a border fails', () => {
  const map = generateMap({ seed: 7, width: 90, height: 90, numDistricts: 26 });
  const first = planGroup(request(map, range(26)));
  const target = first.solutions[0].borderFlows[0]; // the largest border of the first plan

  it('a border that never hits its number is capped and routed around', () => {
    const flaky = new FlakySolver(makeSolver(), (req) => (req.from === target.from && req.to === target.to ? 'fail' : 'normal'));
    const res = planGroup(request(map, range(26), flaky));
    expect(res.status, res.message).toBe('ok');
    expect(flaky.failures).toBeGreaterThan(0);
    for (const sol of res.solutions) {
      expect(sol.transfers.some((t) => t.from === target.from && t.to === target.to)).toBe(false);
      expectGoodPlan(map, sol, range(26));
    }
  });

  it('a border whose options would cut a district is rejected and re-planned', () => {
    const flaky = new FlakySolver(makeSolver(), (req) => (req.from === target.from && req.to === target.to ? 'cut' : 'normal'));
    const res = planGroup(request(map, range(26), flaky));
    expect(res.status, res.message).toBe('ok');
    expect(flaky.failures).toBeGreaterThan(0);
    for (const sol of res.solutions) expectGoodPlan(map, sol, range(26));
  });

  it('transient failures (first calls only) still end in a full plan', () => {
    const flaky = new FlakySolver(makeSolver(), (_req, call) => (call < 3 ? 'fail' : call < 6 ? 'cut' : 'normal'));
    const res = planGroup(request(map, range(26), flaky));
    expect(res.status, res.message).toBe('ok');
    expect(flaky.failures).toBe(6);
    for (const sol of res.solutions) expectGoodPlan(map, sol, range(26));
  });

  it('gives up with needs-precinct-rework, and no partial plan, when nothing works', () => {
    const flaky = new FlakySolver(makeSolver(), () => 'fail');
    const res = planGroup(request(map, range(26), flaky));
    expect(res.status).toBe('needs-precinct-rework');
    expect(res.solutions).toEqual([]);
  });
});

describe('locked blocks and re-plan from here', () => {
  const map = generateMap({ seed: 11, width: 90, height: 90, numDistricts: 26 });
  const first = planGroup(request(map, range(26)));

  it('never moves a locked block', () => {
    const locked = new Uint8Array(map.graph.n);
    for (const t of first.solutions[0].transfers) for (const b of t.blocks) locked[b] = 1;
    const res = planGroup(request(map, range(26), makeSolver(), { locked }));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) expectGoodPlan(map, sol, range(26), { locked });
  });

  it('re-plans only what is left after the user painted part of a plan', () => {
    const plan = first.solutions[0];
    const painted = plan.transfers.slice(0, Math.ceil(plan.transfers.length / 2));
    const assignment = applyTransfers(map.assignment, painted);
    const locked = new Uint8Array(map.graph.n);
    for (const t of painted) for (const b of t.blocks) locked[b] = 1;
    const midway = { ...map, assignment };
    const res = planGroup(request(midway, range(26), makeSolver(), { locked }));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      expectGoodPlan(midway, sol, range(26), { locked });
      expect(sol.stats.people).toBeLessThan(plan.stats.people + 1);
    }
  });
});

describe('unfinished maps (deviations in the thousands)', () => {
  it('finishes with compact moves when empty blocks interrupt whole precincts', () => {
    const map = generateMap({ seed: 7, width: 60, height: 60, numDistricts: 6, skew: 0.3 });
    const res = planGroup(request(map, range(6)));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, range(6));
      expect(sol.stats.people).toBeGreaterThan(5000);
      expect(sol.stats.longReach).toBeUndefined();
    }
  });

  it('produces a longer plan, mostly whole precincts when their blocks are occupied', () => {
    const map = generateMap({ seed: 7, width: 60, height: 60, numDistricts: 6, skew: 0.3, zeroFrac: 0 });
    const devs = popsOf(map.graph, map.assignment, 6).slice(1).map((p) => p - map.targets.q);
    expect(Math.max(...devs.map(Math.abs))).toBeGreaterThan(1500);
    const res = planGroup(request(map, range(6)));
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      expectGoodPlan(map, sol, range(6));
      expect(sol.stats.people).toBeGreaterThan(5000);
      // Whole-precinct moves first: far fewer new splits than precincts' worth of people moved.
      expect(sol.stats.newPrecinctSplits).toBeLessThan(sol.stats.people / 500);
    }
  });
});

describe('behavior', () => {
  it('is deterministic across runs', () => {
    const map = generateMap({ seed: 29, width: 90, height: 90, numDistricts: 26 });
    const a = planGroup(request(map, range(26)));
    const b = planGroup(request(map, range(26)));
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('reports progress monotonically and finishes at done === total', () => {
    const map = generateMap({ seed: 7, width: 90, height: 90, numDistricts: 26 });
    const calls: Array<[number, number]> = [];
    const res = planGroup(request(map, range(26), makeSolver(), { onProgress: (d, t) => calls.push([d, t]) }));
    expect(res.status).toBe('ok');
    expect(calls.length).toBeGreaterThan(10);
    for (let i = 0; i < calls.length; i++) {
      expect(calls[i][0]).toBeLessThanOrEqual(calls[i][1]);
      if (i) expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]);
    }
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(last[1]);
  });

  it('says already-zero when the group needs nothing', () => {
    const map = strips([0, 1, 0, 300, -299]);
    const res = planGroup(request(map, [1, 2, 3]));
    expect(res.status).toBe('already-zero');
    expect(res.solutions).toEqual([]);
  });

  it('treats a selection in two separate pieces piece by piece', () => {
    // {1, 3} do not touch: together they balance, but neither can on its own.
    const map = strips([300, 0, -300, 0, 0]);
    const f = checkGroupFeasibility({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 3] });
    expect(f.feasible).toBe(false);
    expect(Math.abs(f.excess)).toBe(300);
    expect(planGroup(request(map, [1, 3])).status).toBe('group-unbalanced');
  });

  it('returns error for malformed input instead of throwing', () => {
    const map = strips([0, 0, 0, 0, 0]);
    const res = planGroup({ ...request(map, [1]), assignment: new Uint16Array(3) });
    expect(res.status).toBe('error');
  });
});
