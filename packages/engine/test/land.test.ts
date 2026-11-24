/**
 * Land first: where the graph says which blocks are water, moves must hold together over land,
 * and the water crossings DRA allows are used only when nothing on land hits the number.
 */
import { describe, expect, it } from 'vitest';
import { computeTargets, type EngineGraph } from '@zd/contracts';
import { borderSolver, isLandContiguous, landView, solveDistrict } from '../src';
import { verifySolution } from '../src/verify';

type Edge = [number, number, number?];

function build(pops: number[], districts: number[], water: number[], edges: Edge[], precincts = pops.map((_, i) => i)) {
  const n = pops.length;
  const lists: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [a, b, length = 10] of edges) {
    lists[a].push([b, length]);
    lists[b].push([a, length]);
  }
  const adjOffsets = new Uint32Array(n + 1);
  const adjTargets: number[] = [], adjLen: number[] = [];
  lists.forEach((list, block) => {
    for (const [next, length] of list.sort(([a], [b]) => a - b)) {
      adjTargets.push(next);
      adjLen.push(length);
    }
    adjOffsets[block + 1] = adjTargets.length;
  });
  const flags = new Uint8Array(n);
  for (const b of water) flags[b] = 1;
  const graph: EngineGraph = {
    n, pop: Int32Array.from(pops), countyOf: new Uint16Array(n), precinctOf: Uint32Array.from(precincts),
    adjOffsets, adjTargets: Uint32Array.from(adjTargets), adjLen: Uint16Array.from(adjLen),
    outerLen: new Uint32Array(n).fill(100), areaM2: new Float32Array(n).fill(400), water: flags,
  };
  const assignment = Uint16Array.from(districts);
  return { graph, assignment, targets: computeTargets(pops.reduce((a, b) => a + b, 0), Math.max(...districts)) };
}

/**
 * Two banks of a river. West bank (district 1): blocks 0, 1, 2 north to south. East bank
 * (district 2): 5, 6, 7. The river is water blocks 3 and 4, held by district 1. The banks meet
 * on land only in the south, where 2 touches 7. Each stretch of river belongs to the precinct of
 * the west-bank block beside it, as water usually does in real precincts.
 *
 *     0 ~3~ 5
 *     |  ~  |
 *     1 ~4~ 6
 *     |     |
 *     2 --- 7
 */
function river(pops = [4, 4, 4, 0, 0, 2, 2, 0], southLink = true, administrativeLink = true, precincts = [0, 1, 2, 0, 1, 5, 6, 7]) {
  const edges: Edge[] = [[0, 1], [1, 2], [5, 6], [6, 7], [0, 3], [3, 5], [1, 4], [4, 6], [3, 4]];
  if (southLink) edges.push([2, 7]);
  if (administrativeLink) edges.push([0, 5, 0]);
  return build(pops, [1, 1, 1, 1, 1, 2, 2, 2], [3, 4], edges, precincts);
}

const without = (graph: EngineGraph): EngineGraph => ({ ...graph, water: undefined });

describe('land view', () => {
  it('drops edges through water-only blocks and zero-length links, and counts the lost border as shore', () => {
    const { graph } = build([1, 1, 0, 1], [1, 1, 1, 1], [2], [[0, 1, 30], [1, 2, 20], [2, 3, 20], [0, 3, 0]]);
    const land = landView(graph)!;
    const neighbours = (g: EngineGraph, b: number) => Array.from(g.adjTargets.subarray(g.adjOffsets[b], g.adjOffsets[b + 1]));
    expect(neighbours(land, 0)).toEqual([1]); // the zero-length link 0-3 is not land
    expect(neighbours(land, 1)).toEqual([0]); // 1-2 runs into water
    expect(neighbours(land, 2)).toEqual([]);
    expect(neighbours(land, 3)).toEqual([]);
    expect(Array.from(land.outerLen)).toEqual([100, 120, 140, 120]);
    expect(landView(graph)).toBe(land); // cached per graph, so the engine's per-graph state is reused
    expect(landView(land)).toBeNull();
    expect(landView(without(graph))).toBeNull();
  });
});

describe('border solver', () => {
  it('takes the block that touches the other bank on land, not one that reaches it across the river', () => {
    const { graph, assignment } = river();
    // Without water information the engine is free to use either; this is what it did before.
    const before = borderSolver.solveScored({ graph: without(graph), assignment, from: 1, to: 2, accept: [4], maxOptions: 8 });
    expect(before.some(o => o.transfer.blocks.includes(0) || o.transfer.blocks.includes(1))).toBe(true);

    const options = borderSolver.solveScored({ graph, assignment, from: 1, to: 2, accept: [4], maxOptions: 8 });
    expect(options.map(o => Array.from(o.transfer.blocks))).toEqual([[2]]);
    expect(options[0].stats.usesWater).toBeUndefined();
    expect(isLandContiguous(landView(graph)!, assignment, [options[0].transfer])).toBe(true);
  });

  it('gives no answer, not a water crossing, when the districts meet on land but no land move hits the number', () => {
    const { graph, assignment } = river();
    // 3 people cannot be made from blocks of 4; the engine blind to water has no answer either,
    // but it would for 8 by taking 0 and 1 across the river while 2, on land, stays behind.
    expect(borderSolver.solveScored({ graph, assignment, from: 1, to: 2, accept: [3] })).toEqual([]);
    const eight = borderSolver.solveScored({ graph, assignment, from: 1, to: 2, accept: [8], maxOptions: 8 });
    for (const option of eight) {
      expect(option.stats.usesWater).toBeUndefined();
      expect(isLandContiguous(landView(graph)!, assignment, [option.transfer])).toBe(true);
    }
  });

  it('crosses water, and says so, for two districts that do not meet on land at all', () => {
    const { graph, assignment } = river(undefined, false);
    const options = borderSolver.solveScored({ graph, assignment, from: 1, to: 2, accept: [4] });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.transfer.people).toBe(4);
      expect(option.stats.usesWater).toBe(true);
    }
  });

  it('reserves an empty water bridge for the flagged last resort', () => {
    // Blocks 0 and 1 share a precinct with the water beside 0, so taking 0 with that water as a
    // bridge takes part of a precinct: an empty bridge, not a whole precinct.
    const { graph, assignment } = river(undefined, false, false, [0, 0, 2, 0, 1, 5, 6, 7]);
    const request = { graph, assignment, from: 1, to: 2, accept: [4] };
    expect(borderSolver.solveScored(request)).toEqual([]);
    const options = borderSolver.lastResort.solveScored(request);
    expect(options.length).toBeGreaterThan(0);
    for (const { stats } of options) expect(stats).toMatchObject({ usesWater: true, longReach: true });
  });

  it('offers a whole waterfront precinct across the water, marked as crossing water and not as a long reach', () => {
    // Here the water beside block 0 is the rest of block 0's precinct, and the two districts do
    // not meet on land at all. Taking the precinct whole is one click and splits nothing, so it
    // is not a long reach; it does cross water, and says so.
    const { graph, assignment } = river(undefined, false, false);
    const options = borderSolver.solveScored({ graph, assignment, from: 1, to: 2, accept: [4] });
    expect(options.length).toBeGreaterThan(0);
    for (const { transfer, stats } of options) {
      expect(stats.usesWater).toBe(true);
      expect(stats.longReach).toBeUndefined();
      expect(new Set(Array.from(transfer.blocks, (b) => graph.precinctOf[b])).size).toBe(1);
    }
  });

  it('reports land capacity where the districts meet on land, and water capacity as one expensive tier where they do not', () => {
    const joined = river();
    const onLand = borderSolver.capacity({ graph: landView(joined.graph)!, assignment: joined.assignment, from: 1, to: 2 });
    const curve = borderSolver.capacity({ graph: joined.graph, assignment: joined.assignment, from: 1, to: 2 });
    expect(curve.tiers).toEqual(onLand.tiers);

    const apart = river(undefined, false); // the banks touch only across the river
    const waterOnly = borderSolver.capacity({ graph: apart.graph, assignment: apart.assignment, from: 1, to: 2 });
    expect(waterOnly.tiers).toHaveLength(1);
    expect(waterOnly.tiers[0].kind).toBe('high');
    expect(waterOnly.tiers[0].people).toBeGreaterThan(0);
    expect(waterOnly.tiers[0].costPerPerson).toBeGreaterThanOrEqual(200);
  });

  it('carries along a water block that would be left stranded, so the move is valid in DRA too', () => {
    // District 1: 0 - 1 - 2, with water block 3 hanging off 2. District 2: 4 - 5. Land contact 2 - 4.
    const { graph, assignment, targets } = build([5, 5, 5, 0, 5, 0], [1, 1, 1, 1, 2, 2], [3], [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]], [0, 1, 2, 3, 4, 5]);
    const [option] = borderSolver.solveScored({ graph, assignment, from: 1, to: 2, accept: [5] });
    expect(Array.from(option.transfer.blocks)).toEqual([2, 3]);
    expect(option.stats.blocks).toBe(2);
    expect(option.stats.steps).toBe(2);
    expect(option.stats.populatedBlocks).toBe(1);
    expect(option.stats.usesWater).toBeUndefined();
    const solution = {
      id: 'x', kind: 'single' as const, transfers: [option.transfer], stats: option.stats,
      borderFlows: [{ from: 1, to: 2, people: 5 }],
      deviations: [{ district: 1, before: 5, after: 0 }, { district: 2, before: -5, after: 0 }],
    };
    expect(verifySolution(graph, assignment, targets, solution)).toEqual({ ok: true });
  });
});

describe('one district', () => {
  it('offers only land moves when one exists, and water moves, marked, when none does', () => {
    const joined = river();
    const result = solveDistrict({ ...joined, district: 1, neighborTolerance: 10 });
    expect(result.status).toBe('ok');
    expect(result.solutions.map(s => s.transfers.map(t => Array.from(t.blocks)))).toEqual([[[2]]]);
    expect(result.solutions[0].stats.usesWater).toBeUndefined();
    expect(verifySolution(joined.graph, joined.assignment, joined.targets, result.solutions[0])).toEqual({ ok: true });

    const apart = river(undefined, false);
    const forced = solveDistrict({ ...apart, district: 1, neighborTolerance: 10 });
    expect(forced.status).toBe('ok');
    expect(forced.solutions.length).toBeGreaterThan(0);
    for (const solution of forced.solutions) {
      expect(solution.stats.usesWater).toBe(true);
      expect(verifySolution(apart.graph, apart.assignment, apart.targets, solution)).toEqual({ ok: true });
    }
  });
});
