import { describe, expect, it } from 'vitest';
import { buildInteractionGraph, CurveCache, planGroup } from '../src/index';
import { makeSolver } from './support/solvers';
import { generateMap } from './support/synth';
import { range, snapshot } from './support/check';

describe('capacity curves shared between the interaction view and planGroup', () => {
  const map = generateMap({ seed: 7, width: 90, height: 90, numDistricts: 26 });
  const base = { graph: map.graph, assignment: map.assignment, targets: map.targets, districts: range(26) };

  it('planGroup after buildInteractionGraph measures no curve twice, with the same result', () => {
    const plain = planGroup({ ...base, solver: makeSolver() });
    const solver = makeSolver();
    const cache = new CurveCache();
    const view = buildInteractionGraph({ ...base, solver, curveCache: cache });
    const afterView = solver.calls.capacity;
    expect(afterView).toBeGreaterThan(0);
    const res = planGroup({ ...base, solver }, { curveCache: cache });
    const { elapsedMs: _a, ...x } = res;
    const { elapsedMs: _b, ...y } = plain;
    expect(snapshot(x)).toBe(snapshot(y));
    expect(res.interaction).toEqual(view);
    // Round 0 reuses every curve; only later rounds (if any) re-measure used borders.
    const extra = solver.calls.capacity - afterView;
    const plainSolver = makeSolver();
    planGroup({ ...base, solver: plainSolver });
    expect(extra).toBe(plainSolver.calls.capacity - afterView);
  });

  it('never serves a curve measured on a different map', () => {
    const solver = makeSolver();
    const cache = new CurveCache();
    buildInteractionGraph({ ...base, solver, curveCache: cache });
    const changed = map.assignment.slice();
    // Move one block of district 1 to a neighbor: a different state.
    let moved = -1;
    for (let b = 0; b < map.graph.n && moved < 0; b++) {
      if (changed[b] !== 1) continue;
      for (let e = map.graph.adjOffsets[b]; e < map.graph.adjOffsets[b + 1]; e++) {
        const nb = map.graph.adjTargets[e];
        if (changed[nb] !== 1 && changed[nb] !== 0) { changed[b] = changed[nb]; moved = b; break; }
      }
    }
    expect(moved).toBeGreaterThanOrEqual(0);
    const before = cache.hits;
    buildInteractionGraph({ ...base, assignment: changed, solver, curveCache: cache });
    expect(cache.hits).toBe(before);
  });

  it('measures curves again when the graph gains town membership', () => {
    const solver = makeSolver();
    const cache = new CurveCache();
    buildInteractionGraph({ ...base, solver, curveCache: cache });
    const calls = solver.calls.capacity;
    const graph = { ...map.graph, townOf: new Uint32Array(map.graph.n).fill(1) };
    buildInteractionGraph({ ...base, graph, solver, curveCache: cache });
    expect(solver.calls.capacity).toBe(2 * calls);
  });
});
