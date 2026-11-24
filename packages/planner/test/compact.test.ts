import { describe, expect, it } from 'vitest';
import { computeTargets, type EngineGraph } from '@zd/contracts';
import { borderSolver } from '../../engine/src';
import { planGroup, verifyPlan } from '../src';

function graphOf(pop: Int32Array, links: number[][], precinctOf: Uint32Array, waterLink?: number[]): EngineGraph {
  const n = pop.length;
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of links) {
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  const adjOffsets = new Uint32Array(n + 1);
  const adjTargets = Uint32Array.from(neighbors.flatMap((ns, b) => {
    adjOffsets[b + 1] = adjOffsets[b] + ns.length;
    return ns.sort((a, b) => a - b);
  }));
  const adjLen = new Uint16Array(adjTargets.length).fill(10);
  if (waterLink) {
    const [a, b] = waterLink;
    for (let e = adjOffsets[a]; e < adjOffsets[a + 1]; e++) if (adjTargets[e] === b) adjLen[e] = 0;
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) if (adjTargets[e] === a) adjLen[e] = 0;
  }
  return {
    n, pop, adjOffsets, adjTargets, adjLen, countyOf: new Uint16Array(n), precinctOf,
    outerLen: new Uint32Array(n).fill(100), areaM2: new Float32Array(n).fill(100),
    ...(waterLink ? { water: new Uint8Array(n) } : {}),
  };
}

function waterfront(compactRoute: boolean) {
  const pop = Int32Array.of(20, 0, 0, 0, 0, 0, 34, 54);
  const links = Array.from({ length: pop.length - 1 }, (_, i) => [i, i + 1]);
  links.push([1, 7]); // The donor can hold the empty shore after the occupied block moves.
  if (compactRoute) links.push([0, 6]);
  // The shore is the donor's part of a precinct the recipient already shares. (A precinct lying
  // wholly in the donor and taken whole would be one unit, not a long reach.)
  const graph = graphOf(pop, links, Uint32Array.of(1, 1, 1, 1, 1, 1, 1, 2));
  const assignment = Uint16Array.of(2, 1, 1, 1, 1, 1, 1, 1);
  return { graph, assignment, targets: computeTargets(108, 2), districts: [1, 2] };
}

describe('long reach is a last resort for an entire plan', () => {
  it('offers one verified flagged plan when every compact plan kind fails', () => {
    const req = waterfront(false);
    const strict = { solve: borderSolver.solve, solveScored: borderSolver.solveScored, capacity: borderSolver.capacity };
    expect(planGroup({ ...req, solver: strict }).status).toBe('needs-precinct-rework');
    const result = planGroup({ ...req, solver: borderSolver });
    expect(result.status, result.message).toBe('ok');
    expect(result.solutions).toHaveLength(1);
    const [plan] = result.solutions;
    expect(plan.stats).toMatchObject({ longReach: true, steps: 1 });
    expect(plan.transfers).toEqual([{ from: 1, to: 2, people: 34, blocks: Uint32Array.of(1, 2, 3, 4, 5, 6) }]);
    expect(verifyPlan({ ...req, transfers: plan.transfers }).ok).toBe(true);
    expect(req.assignment).toEqual(Uint16Array.of(2, 1, 1, 1, 1, 1, 1, 1));
  });

  it('does not ask for relaxed capacity or moves after finding a compact plan', () => {
    const req = waterfront(true);
    let calls = 0;
    const solver = {
      ...borderSolver,
      get lastResort() {
        calls++;
        return borderSolver.lastResort;
      },
    };
    const result = planGroup({ ...req, solver });
    expect(result.status, result.message).toBe('ok');
    expect(calls).toBe(0);
    for (const plan of result.solutions) {
      expect(plan.stats.longReach).toBeUndefined();
      expect(plan.stats.steps).toBe(1);
      expect(plan.transfers).toEqual([{ from: 1, to: 2, people: 34, blocks: Uint32Array.of(6) }]);
      expect(verifyPlan({ ...req, transfers: plan.transfers }).ok).toBe(true);
    }
  });
});

describe('a group of one with the real engine', () => {
  const assignment = Uint16Array.of(1, 1, 1, 2, 2, 3, 3);
  const links = [[0, 1], [0, 2], [3, 4], [5, 6], [1, 3], [0, 4], [2, 5]];
  const precinctOf = Uint32Array.of(0, 1, 2, 3, 4, 5, 6);
  const targets = computeTargets(90, 3);
  const base = { assignment, targets, districts: [1], allowOutsideAbsorb: true, solver: borderSolver };

  it('uses one selected neighbor for both legs of the trade', () => {
    const graph = graphOf(Int32Array.of(22, 8, 5, 22, 3, 10, 20), links, precinctOf);
    expect(borderSolver.solve({ graph, assignment, from: 1, to: 3, accept: [5] })).toHaveLength(1);
    const req = { ...base, graph, absorbers: [2] };
    const result = planGroup(req);
    expect(result.status, result.message).toBe('ok');
    for (const plan of result.solutions) {
      expect(plan.borderFlows).toEqual([{ from: 1, to: 2, people: 8 }, { from: 2, to: 1, people: 3 }]);
      expect(plan.stats).toMatchObject({ steps: 2 });
      expect(plan.stats.longReach).toBeUndefined();
      expect(verifyPlan({ ...req, transfers: plan.transfers }).ok).toBe(true);
    }
  });

  it('tries a land trade before keeping a water-dependent move', () => {
    const graph = graphOf(Int32Array.of(22, 8, 5, 27, 3, 10, 15), links, precinctOf, [2, 5]);
    const [water] = borderSolver.solveScored({ graph, assignment, from: 1, to: 3, accept: [5] });
    expect(water.stats.usesWater).toBe(true);
    const req = { ...base, graph };
    const result = planGroup(req);
    expect(result.status, result.message).toBe('ok');
    for (const plan of result.solutions) {
      expect(plan.stats.usesWater).toBeUndefined();
      expect(plan.borderFlows).toEqual([{ from: 1, to: 2, people: 8 }, { from: 2, to: 1, people: 3 }]);
      expect(verifyPlan({ ...req, transfers: plan.transfers }).ok).toBe(true);
    }
  });
});
