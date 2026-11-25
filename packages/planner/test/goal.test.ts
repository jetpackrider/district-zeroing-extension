import { describe, expect, it } from 'vitest';
import type { GroupSolveRequest } from '@zd/contracts';
import { checkGroupFeasibility, planGroup, verifyPlan } from '../src/index';
import { makeSolver, SOLVER_NAME } from './support/solvers';
import { applyTransfers, generateMap, popsOf, setDeviations, type SynthMap } from './support/synth';

function strips(devs: number[], seed = 3): SynthMap {
  return setDeviations(generateMap({ seed, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), devs);
}

function solve(map: SynthMap, districts: number[], extra: Partial<GroupSolveRequest> = {}) {
  return planGroup({
    graph: map.graph,
    assignment: map.assignment,
    targets: map.targets,
    districts,
    solver: makeSolver(),
    ...extra,
  });
}

describe(`[${SOLVER_NAME} solver] GroupSolveRequest.goals`, () => {
  it('one-district fallback honors exact +1, -1, and 0 goals against draTarget', () => {
    // 5 strips, remainder 0 (sum of devs = 0 -> q === draTarget).
    const map = strips([0, 200, -100, -100, 0]);
    expect(map.targets.remainder).toBe(0);
    expect(map.targets.q).toBe(map.targets.draTarget);

    for (const goal of [-1, 0, 1] as const) {
      const res = solve(map, [2], { allowOutsideAbsorb: true, goals: { 2: goal } });
      expect(res.status, res.message).toBe('ok');
      expect(res.solutions.length).toBeGreaterThan(0);
      for (const sol of res.solutions) {
        const final = applyTransfers(map.assignment, sol.transfers);
        const after = popsOf(map.graph, final, 5);
        expect(after[2]).toBe(map.targets.draTarget + goal);
        expect(sol.deviations.find((d) => d.district === 2)?.after).toBe(goal);
        expect(
          verifyPlan({
            graph: map.graph,
            assignment: map.assignment,
            targets: map.targets,
            districts: [2],
            allowOutsideAbsorb: true,
            goals: { 2: goal },
            transfers: sol.transfers,
          }).ok,
        ).toBe(true);
      }
    }
  });

  it('direction flips for a district currently at 0: +1 takes 1, -1 gives 1, 0 is already-zero', () => {
    const map = strips([100, 0, -100, 0, 0]);
    expect(map.targets.remainder).toBe(0);

    expect(solve(map, [2], { allowOutsideAbsorb: true, goals: { 2: 0 } }).status).toBe('already-zero');

    const plus = solve(map, [2], { allowOutsideAbsorb: true, goals: { 2: 1 } });
    expect(plus.status, plus.message).toBe('ok');
    expect(plus.solutions.length).toBeGreaterThan(0);
    for (const sol of plus.solutions) {
      const after = popsOf(map.graph, applyTransfers(map.assignment, sol.transfers), 5);
      expect(after[2]).toBe(map.targets.draTarget + 1);
      expect(
        verifyPlan({
          graph: map.graph,
          assignment: map.assignment,
          targets: map.targets,
          districts: [2],
          allowOutsideAbsorb: true,
          goals: { 2: 1 },
          transfers: sol.transfers,
        }).ok,
      ).toBe(true);
    }

    const minus = solve(map, [2], { allowOutsideAbsorb: true, goals: { 2: -1 } });
    expect(minus.status, minus.message).toBe('ok');
    expect(minus.solutions.length).toBeGreaterThan(0);
    for (const sol of minus.solutions) {
      const after = popsOf(map.graph, applyTransfers(map.assignment, sol.transfers), 5);
      expect(after[2]).toBe(map.targets.draTarget - 1);
      expect(
        verifyPlan({
          graph: map.graph,
          assignment: map.assignment,
          targets: map.targets,
          districts: [2],
          allowOutsideAbsorb: true,
          goals: { 2: -1 },
          transfers: sol.transfers,
        }).ok,
      ).toBe(true);
    }
  });

  it('uneven state (remainder > 0): goal is exact against draTarget, while members without a goal keep q / q + 1', () => {
    // Sum of devs = +4 across 5 strips -> remainder = 4 -> draTarget = q + 1.
    // D1 = q + 1 (draDev 0), D2 = q (draDev -1), D3 = q + 1 (draDev 0), D4 = q + 1, D5 = q + 1.
    const map = strips([1, 0, 1, 1, 1]);
    expect(map.targets.remainder).toBe(4);
    expect(map.targets.draTarget).toBe(map.targets.q + 1);

    // Without goal, D2 (at q) is already-zero.
    expect(solve(map, [2], { allowOutsideAbsorb: true }).status).toBe('already-zero');
    // With goal -1 (draTarget - 1 = q), D2 is already at its goal.
    expect(solve(map, [2], { allowOutsideAbsorb: true, goals: { 2: -1 } }).status).toBe('already-zero');
    // With goal +1 (draTarget + 1 = q + 2), D2 must gain 2 people!
    const res = solve(map, [2], { allowOutsideAbsorb: true, goals: { 2: 1 } });
    expect(res.status, res.message).toBe('ok');
    for (const sol of res.solutions) {
      const after = popsOf(map.graph, applyTransfers(map.assignment, sol.transfers), 5);
      expect(after[2]).toBe(map.targets.draTarget + 1);
      // Without goals, verifyPlan rejects q + 2.
      expect(
        verifyPlan({
          graph: map.graph,
          assignment: map.assignment,
          targets: map.targets,
          districts: [2],
          allowOutsideAbsorb: true,
          transfers: sol.transfers,
        }).ok,
      ).toBe(false);
      // With goals, verifyPlan accepts.
      expect(
        verifyPlan({
          graph: map.graph,
          assignment: map.assignment,
          targets: map.targets,
          districts: [2],
          allowOutsideAbsorb: true,
          goals: { 2: 1 },
          transfers: sol.transfers,
        }).ok,
      ).toBe(true);
    }
  });

  it('group with mixed goals: feasibility, flow, repair and verifyPlan honor exact goals and default rules together', () => {
    // remainder = 2 (sum = +2) -> draTarget = q.
    // Group [1, 2]: D1 has goal -1 (exact q - 1), D2 has no goal ([q, q + 1]).
    // Combined target band for [1, 2] is [2q - 1, 2q].
    // Give D1 = q + 50, D2 = q - 51 -> combined = 2q - 1 (fits!).
    // D3 = q + 3 (to keep total remainder = 2).
    const map = strips([50, -51, 3, 0, 0]);
    expect(map.targets.remainder).toBe(2);
    expect(map.targets.draTarget).toBe(map.targets.q);

    // Without goal, [1, 2] has pop 2q - 1 < 2q, so excess = -1 (infeasible on its own).
    expect(
      checkGroupFeasibility({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 2] }),
    ).toMatchObject({ feasible: false, excess: -1 });

    // With goals: { 1: -1 }, [1, 2] has band [2q - 1, 2q], so pop 2q - 1 is feasible on its own!
    expect(
      checkGroupFeasibility({
        graph: map.graph,
        assignment: map.assignment,
        targets: map.targets,
        districts: [1, 2],
        goals: { 1: -1 },
      }),
    ).toEqual({ feasible: true, excess: 0, suggestAdd: [] });

    const res = solve(map, [1, 2], { goals: { 1: -1 } });
    expect(res.status, res.message).toBe('ok');
    expect(res.solutions.length).toBeGreaterThan(0);
    for (const sol of res.solutions) {
      const after = popsOf(map.graph, applyTransfers(map.assignment, sol.transfers), 5);
      expect(after[1]).toBe(map.targets.draTarget - 1);
      expect(after[2]).toBe(map.targets.q);
    }
  });

  it('residual repair honors exact goal when two-way trade is required', () => {
    // Construct a 5-strip map where every block in District 1 has even population (>= 2),
    // D1 is at +1 and aims for 0 (or at 0 and aims for -1) -> must move 1 person out,
    // which requires a two-way swap in residual repair!
    const base = strips([0, 0, 0, 0, 0], 11);
    const { graph, assignment } = base;
    for (let b = 0; b < graph.n; b++) {
      if (assignment[b] === 1 && graph.pop[b] > 0 && graph.pop[b] % 2 === 1) graph.pop[b] += 1;
    }
    const pops = popsOf(graph, assignment, 5);
    const total = pops.reduce((s, p) => s + p, 0);
    const rem = total % 5;
    // Adjust D5 so total divides by 5 cleanly and adjust D1/D2 to 0 deviation.
    const target = Math.floor((total - rem) / 5);
    const map = setDeviations({ ...base, targets: { totalPop: 5 * target, numDistricts: 5, q: target, remainder: 0, draTarget: target } }, [0, 0, 0, 0, 0]);
    // Re-even D1 border blocks so no 1-person one-way block exists on 1->2.
    const adjTo2 = new Set<number>();
    for (let b = 0; b < map.graph.n; b++) {
      if (map.assignment[b] !== 1) continue;
      for (let e = map.graph.adjOffsets[b]; e < map.graph.adjOffsets[b + 1]; e++) {
        if (map.assignment[map.graph.adjTargets[e]] === 2) adjTo2.add(b);
      }
    }
    let shift = 0;
    for (const b of adjTo2) {
      if (map.graph.pop[b] > 0 && map.graph.pop[b] % 2 === 1) {
        map.graph.pop[b] += 1;
        shift++;
      }
    }
    // Compensate inside D1 away from border so D1 stays at exact q.
    for (let b = 0; b < map.graph.n && shift > 0; b++) {
      if (map.assignment[b] === 1 && !adjTo2.has(b) && map.graph.pop[b] > 1) {
        const take = Math.min(shift, map.graph.pop[b] - 1);
        map.graph.pop[b] -= take;
        shift -= take;
      }
    }
    expect(shift).toBe(0);
    expect(popsOf(map.graph, map.assignment, 5)[1]).toBe(map.targets.draTarget);

    // D1 at 0 aiming for -1 (with only D2 as neighbor, all border blocks of D1 are even):
    const res = solve(map, [1], { allowOutsideAbsorb: true, absorbers: [2], goals: { 1: -1 } });
    expect(res.status, res.message).toBe('ok');
    expect(res.solutions.length).toBeGreaterThan(0);
    for (const sol of res.solutions) {
      const after = popsOf(map.graph, applyTransfers(map.assignment, sol.transfers), 5);
      expect(after[1]).toBe(map.targets.draTarget - 1);
    }
  });

  it('rejects an invalid goal with status error', () => {
    const map = strips([10, -10, 0, 0, 0]);
    const res = solve(map, [1], { allowOutsideAbsorb: true, goals: { 1: 2 as unknown as 1 } });
    expect(res.status).toBe('error');
  });
});
