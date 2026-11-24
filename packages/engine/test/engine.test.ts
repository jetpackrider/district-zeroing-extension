import { describe, expect, it } from 'vitest';
import {
  computeTargets, type BorderSolveRequest, type DistrictSolveRequest, type EngineGraph,
  type PopTargets, type Solution, type SolutionStats, type Transfer,
} from '@zd/contracts';
import { borderReachability, borderSolver, measureTransferShape, solveDistrict } from '../src';
import { defaults } from '../src/model';
import { verifySolution } from '../src/verify';
import { perturb, readAssignment } from '../scripts/cli-input';

type Edge = [number, number, number?];

function fixture(
  values: number[], districts: number[], edges: Edge[],
  precincts = values.map((_, i) => i), counties = values.map(() => 0),
) {
  const n = values.length;
  const adjOffsets = new Uint32Array(n + 1);
  const neighbors: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [a, b, length = 10] of edges) {
    neighbors[a].push([b, length]);
    neighbors[b].push([a, length]);
  }
  const adjTargets: number[] = [], adjLen: number[] = [];
  for (const [block, list] of neighbors.entries()) {
    for (const [next, length] of list.sort(([a], [b]) => a - b)) {
      adjTargets.push(next);
      adjLen.push(length);
    }
    adjOffsets[block + 1] = adjTargets.length;
  }
  const graph: EngineGraph = {
    n, pop: Int32Array.from(values), countyOf: Uint16Array.from(counties), precinctOf: Uint32Array.from(precincts),
    adjOffsets, adjTargets: Uint32Array.from(adjTargets), adjLen: Uint16Array.from(adjLen),
    outerLen: new Uint32Array(n).fill(200), areaM2: new Float32Array(n).fill(400),
  };
  return {
    graph, assignment: Uint16Array.from(districts), targets: computeTargets(
      values.reduce((sum, p) => sum + p, 0), Math.max(...districts),
    ),
  };
}

function borderSolution(req: BorderSolveRequest, targets: PopTargets, transfer: Transfer, stats?: SolutionStats): Solution {
  const { from, to, people, blocks } = transfer;
  const before = (d: number) => req.assignment.reduce((sum, value, b) =>
    sum + (d === value ? req.graph.pop[b] : 0), 0) - targets.draTarget;
  return {
    id: blocks.join(','), kind: 'single', transfers: [transfer], borderFlows: [{ from, to, people }],
    stats: stats ?? {
      people, blocks: blocks.length, populatedBlocks: blocks.filter(b => req.graph.pop[b] > 0).length,
      newPrecinctSplits: 0, healedPrecinctSplits: 0, newCountySplits: 0,
      perimeterDeltaM: 0, districtsTouched: 2, cost: 0,
    },
    deviations: [{ district: from, before: before(from), after: before(from) - people },
      { district: to, before: before(to), after: before(to) + people }],
  };
}

function checkedBorder(req: BorderSolveRequest, targets: PopTargets) {
  const snapshot = req.assignment.slice();
  const scored = borderSolver.solveScored(req);
  for (const { transfer, stats } of scored) {
    expect(req.accept).toContain(transfer.people);
    expect(stats.steps).toBe(new Set(transfer.blocks.map(b => req.graph.precinctOf[b])).size);
    expect(stats.longReach).toBeUndefined();
    expect(verifySolution(req.graph, req.assignment, targets, borderSolution(req, targets, transfer, stats), {
      districts: [], locked: req.locked,
    })).toEqual({ ok: true });
  }
  expect(req.assignment).toEqual(snapshot);
  expect(new Set(scored.map(({ transfer }) => transfer.blocks.join(','))).size).toBe(scored.length);
  return scored;
}

function checkedDistrict(req: DistrictSolveRequest) {
  const snapshot = req.assignment.slice();
  const result = solveDistrict(req);
  for (const solution of result.solutions) expect(
    verifySolution(req.graph, req.assignment, req.targets, solution,
      { districts: [req.district], neighborTolerance: req.neighborTolerance ?? 0 }),
  ).toEqual({ ok: true });
  for (const { transfers, stats } of result.solutions) {
    expect(stats.steps).toBe(transfers.reduce((sum, t) =>
      sum + new Set(t.blocks.map(b => req.graph.precinctOf[b])).size, 0));
    expect(stats.longReach).toBeUndefined();
  }
  expect(req.assignment).toEqual(snapshot);
  expect(new Set(result.solutions.map(solution => solution.id)).size).toBe(result.solutions.length);
  return result;
}

describe('exact balancing', () => {
  it('accepts either population and has deterministic, distinct options', () => {
    const data = fixture([8, 3, 4, 3, 4, 11], [2, 1, 1, 1, 1, 1],
      [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [2, 5], [3, 5], [4, 5]]);
    const request = { ...data, from: 1, to: 2, accept: [4, 3, 4], maxOptions: 8 };
    const expected = checkedBorder(request, data.targets);
    expect(expected).toHaveLength(4);
    expect(expected.map(({ transfer }) => [transfer.people, transfer.blocks[0]])).toEqual([
      [3, 1], [4, 2], [3, 3], [4, 4],
    ]);
    for (let i = 0; i < 3; i++) expect(checkedBorder(request, data.targets)).toEqual(expected);
    expect(borderSolver.solve(request)).toEqual(expected.map(option => option.transfer));
  });

  it('accepts q and q + 1 when the state has a remainder, in either direction', () => {
    const data = fixture([8, 3, 4, 8], [2, 1, 1, 1], [[0, 1], [0, 2], [1, 3], [2, 3]]);
    expect(data.targets).toMatchObject({ q: 11, remainder: 1, draTarget: 12 });
    for (const district of [1, 2]) {
      const req = { ...data, district };
      const result = checkedDistrict(req);
      expect(result.status).toBe('ok');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.elapsedMs)).toBe(true);
      expect(result.solutions.map(s => s.stats.people).sort()).toEqual([3, 4]);
      const { elapsedMs: _a, ...expected } = result;
      const { elapsedMs: _b, ...again } = checkedDistrict(req);
      expect(again).toEqual(expected);
    }
  });

  it('reports already zero and an unreachable exact total', () => {
    const balanced = fixture([4, 5], [1, 2], [[0, 1]]);
    expect(checkedDistrict({ ...balanced, district: 1 }).status).toBe('already-zero');
    const impossible = fixture([6, 4, 8], [1, 1, 2], [[0, 1], [1, 2]]);
    expect(checkedDistrict({ ...impossible, district: 1 }).status).toBe('needs-precinct-rework');
  });

  it('enforces aggregate tolerance, absorber selection, and explicit tolerance', () => {
    const data = fixture([36, 32, 6, 6, 6, 34], [2, 3, 1, 1, 1, 1],
      [[0, 2], [0, 3], [1, 4], [2, 5], [3, 5], [4, 5]]);
    const request = { ...data, district: 1 };
    const result = checkedDistrict(request);
    expect(result.status).toBe('ok');
    expect(result.solutions).toHaveLength(2);
    expect(result.solutions.every(option => option.transfers.map(t => t.to).join(',') === '2,3')).toBe(true);
    expect(checkedDistrict({ ...request, absorbers: [2] }).status).toBe('needs-precinct-rework');
    const raised = checkedDistrict({ ...request, absorbers: [2], neighborTolerance: 8 });
    expect(raised.solutions[0].transfers[0].people).toBe(12);
  });

  it('allocates a shared precinct to the border that needs it for an exact sum', () => {
    const data = fixture([38, 32, 4, 6, 6, 34], [2, 3, 1, 1, 1, 1],
      [[0, 2], [1, 3, 110], [1, 4], [2, 5], [3, 5], [4, 5]], [0, 1, 2, 2, 4, 5]);
    const result = checkedDistrict({ ...data, district: 1 });
    expect(result.solutions.map(s => s.transfers.map(t => [...t.blocks]))).toEqual([[[2], [4]]]);
  });

  it('returns eight ranked options when enough precincts are available', () => {
    const spokes = Array.from({ length: 10 }, (_, i) => i + 2);
    const data = fixture([15, 10, ...spokes.map(() => 1)], [2, 1, ...spokes.map(() => 1)],
      spokes.flatMap((b): Edge[] => [[0, b], [1, b]]));
    const options = checkedBorder({ ...data, from: 1, to: 2, accept: [1], maxOptions: 10 }, data.targets);
    expect(options.map(s => s.transfer.blocks[0])).toEqual(spokes.slice(0, 8));
  });

  it('combines signed adjusted counts from different precincts', () => {
    const data = fixture([12, -2, 7, 9], [2, 1, 1, 1], [[0, 1], [0, 2], [1, 3], [2, 3]]);
    const request = { ...data, from: 1, to: 2, accept: [5] };
    const options = checkedBorder(request, data.targets);
    expect(options.map(s => [...s.transfer.blocks])).toEqual([[1, 2]]);
  });
});

describe('contiguity and locked blocks', () => {
  it('rejects moves creating a new component on either side and keeps original district islands', () => {
    const data = fixture([10, 3, 3, 3, 5, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 10],
      [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
      [[0, 1], [0, 2], [1, 4], [1, 5], [1, 10], [2, 5],
        [5, 6], [6, 7], [7, 8], [8, 9], [10, 11], [11, 12], [12, 13], [13, 14]]);
    const request = { ...data, from: 1, to: 2, accept: [3] };
    const options = checkedBorder(request, data.targets);
    expect(options.map(x => [...x.transfer.blocks])).toEqual([[2]]);
    for (const block of [1, 3]) {
      const bad = borderSolution(request, data.targets,
        { from: 1, to: 2, blocks: Uint32Array.of(block), people: 3 });
      expect(verifySolution(data.graph, data.assignment, data.targets, bad, { districts: [] })).toMatchObject({
        ok: false, error: expect.stringContaining(block === 1 ? 'disconnected piece' : 'no original block'),
      });
    }
    const duplicate = borderSolution(request, data.targets, options[0].transfer, options[0].stats);
    duplicate.transfers.push(options[0].transfer);
    expect(verifySolution(data.graph, data.assignment, data.targets, duplicate, { districts: [] })).toMatchObject({
      ok: false, error: expect.stringContaining('repeated'),
    });
  });

  it('takes a tiny populated lobe with its articulation seed and accounts for its population', () => {
    const data = fixture([1, 2, 3, 10, 10, 10, 10, 10], [2, 1, 1, 1, 1, 1, 1, 1],
      [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [5, 6], [6, 7]]);
    const request = { ...data, from: 1, to: 2, accept: [5] };
    expect(checkedBorder(request, data.targets).map(x => [...x.transfer.blocks])).toEqual([[1, 2]]);
    const locked = Uint8Array.of(0, 0, 1, 0, 0, 0, 0, 0);
    expect(checkedBorder({ ...request, locked }, data.targets)).toEqual([]);
  });

  it('bans and resolves two individually safe chunks that would jointly cut the giver', () => {
    const values = [46, 5, 5, 5, ...new Array<number>(10).fill(6)];
    const data = fixture(values, [2, ...values.slice(1).map(() => 1)],
      [[0, 1, 100], [0, 2, 100], [0, 3], [1, 4], [1, 9], [2, 4], [2, 9], [3, 4],
        [4, 5], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12], [12, 13]]);
    const request = { ...data, from: 1, to: 2, accept: [10] };
    const options = checkedBorder(request, data.targets);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(option => option.transfer.blocks.includes(3))).toBe(true);
  });

  it('includes a tiny populated lobe stranded only by a combination of chunks', () => {
    const data = fixture([33, 2, 2, 3, 40], [2, 1, 1, 1, 1],
      [[0, 1], [0, 2], [1, 3], [2, 3], [1, 4], [2, 4]]);
    const result = checkedDistrict({ ...data, district: 1 });
    expect(result.solutions.map(s => [...s.transfers[0].blocks])).toEqual([[1, 2, 3]]);
  });

  it('can keep a locked small lobe while taking a different lobe', () => {
    const data = fixture([10, 2, 7, 3], [2, 1, 1, 1], [[0, 1], [1, 2], [1, 3]]);
    const request = { ...data, from: 1, to: 2, accept: [9], locked: Uint8Array.of(0, 0, 0, 1) };
    expect(checkedBorder(request, data.targets).map(s => [...s.transfer.blocks])).toEqual([[1, 2]]);
  });

  it('includes an empty pocket enclosed by a populated bite', () => {
    const data = fixture([9, 5, 0, 20], [2, 1, 1, 1],
      [[0, 1], [0, 2], [1, 2], [1, 3]], [0, 1, 2, 3]);
    const request = { ...data, from: 1, to: 2, accept: [5] };
    expect(checkedBorder(request, data.targets).map(x => [...x.transfer.blocks])).toEqual([[1, 2]]);
    expect(checkedBorder({ ...request, locked: Uint8Array.of(0, 0, 1, 0) }, data.targets)).toEqual([]);
  });

  it('rejects a bite that would strand more empty blocks than it moves occupied blocks', () => {
    const data = fixture([9, 5, 0, 0, 20], [2, 1, 1, 1, 1],
      [[0, 1], [1, 2], [2, 3], [1, 4]]);
    const request = { ...data, from: 1, to: 2, accept: [5] };
    expect(checkedBorder(request, data.targets)).toEqual([]);
    const [fallback] = borderSolver.lastResort.solveScored(request);
    expect([...fallback.transfer.blocks]).toEqual([1, 2, 3]);
    expect(fallback.stats.longReach).toBe(true);
  });

  it.each([4, 5, 8, 12])('enforces the four-hop limit on a populated transfer of depth %i', depth => {
    const values = [10, ...Array.from({ length: depth }, () => 1), 20];
    const data = fixture(values, values.map((_, b) => b === 0 ? 2 : 1),
      values.slice(1).map((_, i) => [i, i + 1]), values.map((_, b) => b === values.length - 1 ? 2 : 1));
    const request = { ...data, from: 1, to: 2, accept: [depth], weights: { perimeterPerMeter: 0 } };
    const found = checkedBorder(request, data.targets);
    if (depth === 4) expect([...found[0].transfer.blocks]).toEqual([1, 2, 3, 4]);
    else expect(found).toEqual([]);
  });

  it('treats a precinct taken whole as one unit, however empty, and its fragment as blocks', () => {
    // Recipient block 0, then a donor precinct of four blocks in a row, three of them empty,
    // then the rest of the donor. Taking the whole precinct is one click and splits nothing.
    const values = [20, 0, 0, 0, 3, 30];
    const districts = values.map((_, b) => (b === 0 ? 2 : 1));
    const edges = values.slice(1).map((_, i) => [i, i + 1] as [number, number]);
    const whole = fixture(values, districts, edges, [9, 1, 1, 1, 1, 2]);
    const [option] = checkedBorder({ ...whole, from: 1, to: 2, accept: [3] }, whole.targets);
    expect([...option.transfer.blocks]).toEqual([1, 2, 3, 4]);
    expect(option.stats.longReach).toBeUndefined();
    expect(option.stats.newPrecinctSplits).toBe(0);
    // The same blocks as the donor's fragment of a precinct the recipient already shares: three
    // empty blocks reaching for population, refused on the normal path.
    const fragment = fixture(values, districts, edges, [1, 1, 1, 1, 1, 2]);
    expect(checkedBorder({ ...fragment, from: 1, to: 2, accept: [3] }, fragment.targets)).toEqual([]);
  });

  it('leaves a waterfront chain empty on the normal path', () => {
    const values = [20, ...new Array<number>(10).fill(0), 34, 54];
    const data = fixture(values, values.map((_, b) => b === 0 ? 2 : 1),
      values.slice(1).map((_, i) => [i, i + 1]), values.map((_, b) => b === values.length - 1 ? 2 : 1));
    const request = { ...data, from: 1, to: 2, accept: [34] };
    expect(checkedBorder(request, data.targets)).toEqual([]);
    expect(borderSolver.capacity(request).tiers).toEqual([]);
    expect(checkedDistrict({ ...data, district: 1 }).status).toBe('needs-precinct-rework');
    const [fallback] = borderSolver.lastResort.solveScored(request);
    expect(fallback.transfer.blocks).toHaveLength(11);
    expect(fallback.stats).toMatchObject({ longReach: true, steps: 1 });
    expect(verifySolution(data.graph, data.assignment, data.targets,
      borderSolution(request, data.targets, fallback.transfer, fallback.stats))).toEqual({ ok: true });
  });
});

describe('ranking and capacity', () => {
  it('scores exact precinct healing, county splitting, and perimeter change', () => {
    const data = fixture([20, 4, 4, 12], [2, 1, 1, 1],
      [[0, 1, 120], [0, 2, 80], [1, 3, 30], [2, 3, 200]],
      [0, 0, 1, 2], [0, 0, 1, 1]);
    const results = checkedBorder({ ...data, from: 1, to: 2, accept: [4] }, data.targets);
    expect(results.map(s => s.transfer.blocks[0])).toEqual([1, 2]);
    expect(results[0].stats).toMatchObject({ healedPrecinctSplits: 1, newPrecinctSplits: 0,
      newCountySplits: 0, perimeterDeltaM: -180 });
    expect(results[0].stats.cost).toBeCloseTo(defaults.perStep - 85.94);
    expect(results[1].stats).toMatchObject({ healedPrecinctSplits: 0, newPrecinctSplits: 0,
      newCountySplits: 1, perimeterDeltaM: 240 });
  });

  it('charges every precinct touched even when all were already split', () => {
    const data = fixture([20, 0, 0, 0, 4, 2, 2, 12], [2, 2, 2, 2, 1, 1, 1, 1],
      [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [4, 7], [5, 7], [6, 7]],
      [0, 1, 2, 3, 1, 2, 3, 4]);
    const request = { ...data, from: 1, to: 2, accept: [4] };
    const before = checkedBorder({ ...request, weights: { perStep: 0 } }, data.targets);
    const after = checkedBorder({ ...request, weights: { perStep: 300 } }, data.targets);
    expect(after[0].stats.steps).toBe(1);
    expect(after.map(({ stats }) => stats.steps).sort()).toEqual([1, 2]);
    for (const option of after) {
      const same = before.find(o => o.transfer.blocks.join() === option.transfer.blocks.join())!;
      expect(option.stats.newPrecinctSplits).toBe(0);
      expect(option.stats.cost - same.stats.cost).toBeCloseTo(300 * option.stats.steps!);
    }
  });

  it('charges a new town split and moves its capacity out of the cheap tier', () => {
    const data = fixture([10, 4, 4, 12], [2, 1, 1, 1],
      [[0, 1, 120], [0, 2, 80], [1, 3, 30], [2, 3, 200]]);
    const graph = { ...data.graph, townOf: Uint32Array.of(0, 1, 0, 1) };
    const request = { ...data, graph, from: 1, to: 2, locked: Uint8Array.of(0, 0, 0, 1) };
    const options = checkedBorder({ ...request, accept: [4] }, data.targets);
    expect(options.map(({ transfer, stats }) => [transfer.blocks[0], stats.newTownSplits])).toEqual([[2, 0], [1, 1]]);
    expect(options[1].stats.cost).toBeCloseTo(defaults.perStep + 419.06);
    expect(borderSolver.capacity(request).tiers.map(({ kind, people }) => [kind, people]))
      .toEqual([['no-split', 4], ['high', 4]]);
    const [withoutTowns] = checkedBorder({ ...request, graph: data.graph, accept: [4] }, data.targets);
    expect(withoutTowns.transfer.blocks[0]).toBe(1);
    expect(withoutTowns.stats).not.toHaveProperty('newTownSplits');
  });

  it('charges an additional district when its county was already split', () => {
    const data = fixture([10, 4, 12, 10], [2, 1, 1, 3], [[0, 1], [1, 2], [2, 3]],
      [0, 1, 2, 3], [0, 1, 1, 1]);
    const req = { ...data, from: 1, to: 2, locked: Uint8Array.of(0, 0, 1, 0) };
    expect(checkedBorder({ ...req, accept: [4] }, data.targets)[0].stats.newCountySplits).toBe(1);
    expect(borderSolver.capacity(req).tiers.map(tier => tier.kind)).toEqual(['high']);
  });

  it('prefers growth with strong attachment to the receiving district and selected blocks', () => {
    const data = fixture([10, 1, 1, 1, 12], [2, 1, 1, 1, 1],
      [[0, 1, 100], [1, 2, 10], [1, 3, 100], [2, 4, 240], [3, 4, 50]], [0, 1, 1, 1, 2]);
    const [solution] = checkedBorder({ ...data, from: 1, to: 2, accept: [2] }, data.targets);
    expect([...solution.transfer.blocks]).toEqual([1, 3]);
    expect(measureTransferShape(data.graph, data.assignment, solution.transfer)).toEqual({
      boundaryDeltaMPerPerson: -20,
      donorBoundaryShare: 0.375,
    });
  });

  it('backs all cumulative capacity endpoints with verified solves and excludes locked blocks', () => {
    const data = fixture([10, 4, 7, 11, 20, 20], [2, 1, 1, 1, 1, 1],
      [[0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 5], [4, 5]],
      [0, 1, 2, 3, 2, 4], [0, 0, 0, 1, 0, 1]);
    const request = { ...data, from: 1, to: 2, locked: Uint8Array.of(0, 0, 0, 0, 1, 1) };
    const { tiers } = borderSolver.capacity(request);
    expect(tiers.map(({ kind, people }) => [kind, people])).toEqual([
      ['no-split', 4], ['low', 7], ['high', 11],
    ]);
    let total = 0;
    let price = 0;
    for (const tier of tiers) {
      total += tier.people;
      expect(tier.costPerPerson).toBeGreaterThanOrEqual(price);
      price = tier.costPerPerson;
      const solved = checkedBorder({ ...request, accept: [total] }, data.targets);
      expect(solved.length).toBeGreaterThan(0);
      expect(solved[0].stats.newCountySplits).toBe(tier.kind === 'high' ? 1 : 0);
      expect(solved[0].stats.newPrecinctSplits).toBe(tier.kind === 'no-split' ? 0 : 1);
    }
    expect(checkedBorder({ ...request, accept: [total + 1] }, data.targets)).toEqual([]);
  });
});

describe('CLI inputs', () => {
  it.each([',', '|'])('reads %s-separated assignments and perturbs deterministically', separator => {
    const geoids = Array.from({ length: 4 }, (_, i) => String(360000000000000 + i));
    const csv = ['GEOID20' + separator + 'District', ...geoids.map((g, i) => g + separator + (i === 0 ? 1 : 2))]
      .join('\r\n');
    const parsed = readAssignment(csv, geoids);
    const { graph } = fixture([15, 4, 5, 6], [1, 2, 2, 2],
      [[0, 1], [0, 2], [1, 3], [2, 3]]);
    const first = perturb(graph, parsed.assignment, 1, 1, 1234);
    expect(perturb(graph, parsed.assignment, 1, 1, 1234)).toEqual(first);
    expect(first.moved).toHaveLength(1);
    expect(parsed.assignment).toEqual(Uint16Array.of(1, 2, 2, 2));
    expect(checkedDistrict({ graph, assignment: first.assignment, district: 1,
      targets: computeTargets(30, parsed.numDistricts) }).status).toBe('ok');
  });
});

describe('fallback search, reachability, caching, and timing', () => {
  it('combines disjoint border blocks within the same precinct to hit an exact total', () => {
    // District 1 has two non-adjacent pop-1 border blocks (1 and 3) in the SAME precinct 1,
    // separated by a pop-5 block (2). Moving {1, 3} hits exact target 2 without cutting district 1.
    const data = fixture([10, 1, 5, 1, 20, 20, 20], [2, 1, 1, 1, 1, 1, 1],
      [[0, 1], [0, 3], [1, 2], [2, 3], [1, 4], [2, 5], [3, 6], [4, 5], [5, 6]],
      [0, 1, 1, 1, 2, 2, 2]);
    const options = checkedBorder({ ...data, from: 1, to: 2, accept: [2], maxOptions: 3 }, data.targets);
    expect(options.length).toBeGreaterThan(0);
    expect([...options[0].transfer.blocks]).toEqual([1, 3]);
  });

  it('peels an interior block off a whole precinct to hit a near-capacity total', () => {
    // Precinct 1 has two border pieces (blocks 1 and 2, pop 10 each) and one interior block (3, pop 2).
    // Whole precinct is 22; hitting 20 requires taking both border pieces {1, 2} while leaving interior block 3.
    const data = fixture([30, 10, 10, 2, 30, 30], [2, 1, 1, 1, 1, 1],
      [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 5]],
      [0, 1, 1, 1, 2, 2]);
    const cap = borderSolver.capacity({ ...data, from: 1, to: 2 });
    expect(cap.tiers.reduce((s, t) => s + t.people, 0)).toBe(22);
    const options = checkedBorder({ ...data, from: 1, to: 2, accept: [20], maxOptions: 3 }, data.targets);
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].transfer.people).toBe(20);
  });

  it('reports border reachability, gaps, dense ranges, and nearest deliverable totals', () => {
    const data = fixture([10, 4, 7, 11, 20, 20], [2, 1, 1, 1, 1, 1],
      [[0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 5], [4, 5]],
      [0, 1, 2, 3, 2, 4], [0, 0, 0, 1, 0, 1]);
    const locked = Uint8Array.of(0, 0, 0, 0, 1, 1);
    const r = borderReachability({ ...data, from: 1, to: 2, locked });
    expect(r.maxChecked).toBe(22);
    expect(r.minReachable).toBe(4);
    expect(r.maxReachable).toBe(22);
    const reachableList: number[] = [];
    for (let k = 1; k <= r.maxChecked; k++) if (r.reachable[k]) reachableList.push(k);
    expect(reachableList).toEqual([4, 7, 11, 15, 18, 22]);
    expect(r.gaps).toContain(1);
    expect(r.gaps).toContain(5);
    expect(r.nearest(10, 'down')).toBe(7);
    expect(r.nearest(10, 'up')).toBe(11);
    expect(r.nearest(10, 'either')).toBe(11);
    for (const k of reachableList) {
      expect(checkedBorder({ ...data, from: 1, to: 2, accept: [k], locked, maxOptions: 1 }, data.targets).length)
        .toBeGreaterThan(0);
    }
  });

  it('is history-independent across in-place assignment mutations, swapped assignments, and locked masks', () => {
    const data = fixture([8, 3, 4, 3, 4, 11], [2, 1, 1, 1, 1, 1],
      [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [2, 5], [3, 5], [4, 5]]);
    const req = { ...data, from: 1, to: 2, accept: [3, 4], maxOptions: 5 };
    const baseline = checkedBorder(req, data.targets);

    // Mutate an assignment array IN PLACE (the same pattern packages/planner uses) and call solver
    const mutable = data.assignment.slice();
    mutable[1] = 2;
    const afterMutation = checkedBorder({ ...req, assignment: mutable }, data.targets);
    expect(afterMutation.every(o => !o.transfer.blocks.includes(1))).toBe(true);

    // Revert in place and verify bit-for-bit identical output to cold baseline
    mutable[1] = 1;
    expect(checkedBorder({ ...req, assignment: mutable }, data.targets)).toEqual(baseline);

    // Call with a locked mask, then without, and verify identical output
    const locked = Uint8Array.of(0, 1, 0, 0, 0, 0);
    expect(checkedBorder({ ...req, locked }, data.targets).every(o => !o.transfer.blocks.includes(1))).toBe(true);
    expect(checkedBorder(req, data.targets)).toEqual(baseline);
  });

  it('reports finite non-negative elapsedMs on all solveDistrict status paths', () => {
    const okData = fixture([8, 3, 4, 8], [2, 1, 1, 1], [[0, 1], [0, 2], [1, 3], [2, 3]]);
    const ok = solveDistrict({ ...okData, district: 1 });
    expect(ok.status).toBe('ok');
    expect(Number.isFinite(ok.elapsedMs) && ok.elapsedMs >= 0).toBe(true);

    const zero = solveDistrict({ ...fixture([4, 5], [1, 2], [[0, 1]]), district: 1 });
    expect(zero.status).toBe('already-zero');
    expect(Number.isFinite(zero.elapsedMs) && zero.elapsedMs >= 0).toBe(true);

    const rework = solveDistrict({ ...fixture([6, 4, 8], [1, 1, 2], [[0, 1], [1, 2]]), district: 1 });
    expect(rework.status).toBe('needs-precinct-rework');
    expect(Number.isFinite(rework.elapsedMs) && rework.elapsedMs >= 0).toBe(true);

    const err = solveDistrict({ ...okData, district: 99 });
    expect(err.status).toBe('error');
    expect(Number.isFinite(err.elapsedMs) && err.elapsedMs >= 0).toBe(true);
  });
});
