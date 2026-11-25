/**
 * Unassigned (district 0) as a trading partner, for maps still being drawn
 * (see UNASSIGNED in @zd/contracts).
 */
import { describe, expect, it } from 'vitest';
import {
  computeTargets, type BorderSolveRequest, type DistrictSolveRequest, type EngineGraph,
  type PopTargets, type Solution, type SolutionStats, type Transfer,
} from '@zd/contracts';
import { borderSolver, solveDistrict } from '../src';
import { verifySolution } from '../src/verify';

/**
 * A w × h grid of blocks, row by row, each joined to its four neighbors by a 10 m edge.
 * Each block is its own precinct unless `precincts` says otherwise.
 */
function grid(
  w: number, rows: Array<{ pop: number[]; district: number[] }>, precincts?: number[],
) {
  const pops = rows.flatMap(row => row.pop);
  const districts = rows.flatMap(row => row.district);
  const n = pops.length;
  const h = rows.length;
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const b = y * w + x;
    if (x + 1 < w) neighbors[b].push(b + 1), neighbors[b + 1].push(b);
    if (y + 1 < h) neighbors[b].push(b + w), neighbors[b + w].push(b);
  }
  const adjOffsets = new Uint32Array(n + 1);
  const adjTargets: number[] = [];
  for (let b = 0; b < n; b++) {
    adjTargets.push(...neighbors[b].sort((a, c) => a - c));
    adjOffsets[b + 1] = adjTargets.length;
  }
  const graph: EngineGraph = {
    n, pop: Int32Array.from(pops), countyOf: new Uint16Array(n),
    precinctOf: Uint32Array.from(precincts ?? pops.map((_, b) => b)),
    adjOffsets, adjTargets: Uint32Array.from(adjTargets), adjLen: new Uint16Array(adjTargets.length).fill(10),
    outerLen: new Uint32Array(n).fill(200), areaM2: new Float32Array(n).fill(400),
  };
  const targets = computeTargets(pops.reduce((sum, p) => sum + p, 0), Math.max(...districts));
  return { graph, assignment: Uint16Array.from(districts), targets };
}

/** A one-border solution as the planner would report it: Unassigned has no deviation. */
function borderSolution(req: BorderSolveRequest, targets: PopTargets, transfer: Transfer, stats?: SolutionStats): Solution {
  const { from, to, people, blocks } = transfer;
  const before = (d: number) => req.assignment.reduce((sum, value, b) =>
    sum + (d === value ? req.graph.pop[b] : 0), 0) - targets.draTarget;
  return {
    id: blocks.join(','), kind: 'single', transfers: [transfer], borderFlows: [{ from, to, people }],
    stats: stats ?? {
      people, blocks: blocks.length, populatedBlocks: blocks.filter(b => req.graph.pop[b] > 0).length,
      newPrecinctSplits: 0, healedPrecinctSplits: 0, newCountySplits: 0,
      perimeterDeltaM: 0, districtsTouched: Number(from !== 0) + Number(to !== 0), cost: 0,
    },
    deviations: [
      ...(from ? [{ district: from, before: before(from), after: before(from) - people }] : []),
      ...(to ? [{ district: to, before: before(to), after: before(to) + people }] : []),
    ],
  };
}

function checkedBorder(req: BorderSolveRequest, targets: PopTargets) {
  const snapshot = req.assignment.slice();
  const scored = borderSolver.solveScored(req);
  for (const { transfer, stats } of scored) {
    expect(req.accept).toContain(transfer.people);
    expect([transfer.from, transfer.to]).toEqual([req.from, req.to]);
    expect(verifySolution(req.graph, req.assignment, targets, borderSolution(req, targets, transfer, stats), {
      districts: [], locked: req.locked,
    })).toEqual({ ok: true });
  }
  expect(req.assignment).toEqual(snapshot);
  return scored;
}

function checkedDistrict(req: DistrictSolveRequest) {
  const snapshot = req.assignment.slice();
  const result = solveDistrict(req);
  for (const solution of result.solutions) {
    expect(verifySolution(req.graph, req.assignment, req.targets, solution,
      { districts: [req.district], neighborTolerance: req.neighborTolerance ?? 0 })).toEqual({ ok: true });
    expect(solution.deviations.some(change => change.district === 0)).toBe(false);
  }
  expect(req.assignment).toEqual(snapshot);
  return result;
}

/** A deterministic random number source in [0, 1). */
function seeded(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * A random 6..8 × 6..8 map of three grown districts, 2 × 2 precincts, 3 × 3 counties and 2 × 3
 * towns, with `patches` small patches erased (set to Unassigned, some of them empty).
 */
function randomMap(random: () => number, patches: number) {
  const below = (n: number) => Math.floor(random() * n);
  const w = 6 + below(3), h = 6 + below(3), k = 3, n = w * h;
  const district = new Array<number>(n).fill(0);
  const frontier: number[] = [];
  for (let d = 1; d <= k; d++) {
    let b;
    do b = below(n); while (district[b]);
    district[b] = d;
    frontier.push(b);
  }
  const neighbors = (b: number) => [b % w ? b - 1 : -1, (b + 1) % w ? b + 1 : -1, b - w, b + w].filter(x => x >= 0 && x < n);
  while (frontier.length) {
    const i = below(frontier.length);
    const free = neighbors(frontier[i]).filter(x => !district[x]);
    if (!free.length) { frontier.splice(i, 1); continue; }
    const next = free[below(free.length)];
    district[next] = district[frontier[i]];
    frontier.push(next);
  }
  for (let patch = 0; patch < patches; patch++) {
    let b = below(n);
    for (let step = 0; step < 4; step++) { district[b] = 0; b = neighbors(b)[below(neighbors(b).length)]; }
  }
  const rows = Array.from({ length: h }, (_, y) => ({
    pop: Array.from({ length: w }, () => (random() < 0.3 ? 0 : 1 + below(12))),
    district: district.slice(y * w, y * w + w),
  }));
  const precincts = Array.from({ length: n }, (_, b) => Math.floor(b / w / 2) * w + Math.floor((b % w) / 2));
  const data = grid(w, rows, precincts);
  data.graph.countyOf = Uint16Array.from({ length: n }, (_, b) => Math.floor(b / w / 3) * 3 + Math.floor((b % w) / 3));
  data.graph.townOf = Uint32Array.from({ length: n }, (_, b) => 1 + Math.floor(b / w / 3) * w + Math.floor((b % w) / 2));
  return { data, district, k, n };
}

const touchesUnassigned = (solution: Solution) => solution.transfers.some(t => t.from === 0 || t.to === 0);

/**
 *   1 1 2 2      District 1 is 3 over (43, target 40). Its only real neighbor, District 2, has no
 *   1 1 2 2      3-person block to take, so only Unassigned (bottom rows) can take the 3-person
 *   0 0 0 0      block 4.
 *   0 0 0 0
 */
const overNextToUnassigned = () => grid(4, [
  { pop: [10, 10, 5, 5], district: [1, 1, 2, 2] },
  { pop: [3, 20, 5, 5], district: [1, 1, 2, 2] },
  { pop: [2, 2, 2, 2], district: [0, 0, 0, 0] },
  { pop: [2, 2, 2, 3], district: [0, 0, 0, 0] },
]);

describe('trading with Unassigned', () => {
  it('gives to Unassigned when the only real neighbor is excluded, and only with permission', () => {
    const data = overNextToUnassigned();
    expect(data.targets).toMatchObject({ q: 40, remainder: 0, draTarget: 40 });
    const request = { ...data, district: 1 };

    // Without permission district 0 is never touched, exactly as before.
    for (const without of [request, { ...request, absorbers: [2] }, { ...request, absorbers: [2], includeUnassigned: true }]) {
      const result = checkedDistrict(without);
      expect(result.status).toBe('needs-precinct-rework');
      expect(result.solutions).toEqual([]);
    }

    for (const allowed of [{ ...request, absorbers: [0] }, { ...request, includeUnassigned: true }]) {
      const result = checkedDistrict(allowed);
      expect(result.status).toBe('ok');
      const [best] = result.solutions;
      expect(best.transfers.map(t => ({ ...t, blocks: [...t.blocks] }))).toEqual([
        { from: 1, to: 0, blocks: [4], people: 3 },
      ]);
      expect(best.borderFlows).toEqual([{ from: 1, to: 0, people: 3 }]);
      expect(best.deviations).toEqual([{ district: 1, before: 3, after: 0 }]);
      expect(best.stats.districtsTouched).toBe(1);
      // Block 4 loses its 10 m edge with Unassigned and gains two with District 1, each on
      // District 1's perimeter only.
      expect(best.stats.perimeterDeltaM).toBe(10);
    }
  });

  it('takes unassigned blocks into an under district, leaving Unassigned in two pieces', () => {
    //   1 1 1     District 1 is 7 under (30, target 37). The middle unassigned block holds 7;
    //   0 0 0     taking it cuts Unassigned in two, which is allowed.
    //   2 2 2
    const data = grid(3, [
      { pop: [10, 10, 10], district: [1, 1, 1] },
      { pop: [4, 7, 4], district: [0, 0, 0] },
      { pop: [10, 10, 9], district: [2, 2, 2] },
    ]);
    expect(data.targets.q).toBe(37);
    expect(checkedDistrict({ ...data, district: 1 }).status).toBe('needs-precinct-rework');
    const result = checkedDistrict({ ...data, district: 1, includeUnassigned: true });
    expect(result.status).toBe('ok');
    expect(result.solutions.map(s => s.transfers.map(t => [t.from, t.to, ...t.blocks]))).toEqual([[[0, 1, 4]]]);
    expect(result.solutions[0].deviations).toEqual([{ district: 1, before: -7, after: 0 }]);
  });

  it('still keeps the district in one piece when it gives to Unassigned', () => {
    //   1 1 1 0   District 1 is 3 over, and its only 3-person block is the middle one: giving it
    //   0 0 0 2   away would cut District 1 in two, so there is no answer.
    const data = grid(4, [
      { pop: [10, 3, 10, 1], district: [1, 1, 1, 0] },
      { pop: [1, 1, 1, 13], district: [0, 0, 0, 2] },
    ]);
    expect(data.targets.q).toBe(20);
    const result = checkedDistrict({ ...data, district: 1, includeUnassigned: true });
    expect(result.status).toBe('needs-precinct-rework');
    const request = { ...data, from: 1, to: 0, accept: [3] };
    expect(checkedBorder(request, data.targets)).toEqual([]);
    const split = borderSolution(request, data.targets, { from: 1, to: 0, blocks: Uint32Array.of(1), people: 3 });
    expect(verifySolution(data.graph, data.assignment, data.targets, split, { districts: [] })).toMatchObject({
      ok: false, error: expect.stringContaining('disconnected piece'),
    });
  });

  it('verifies Unassigned left in pieces, but not a taken block that does not attach to the district', () => {
    //   1 1 0 0   Taking blocks 2 and 6 into District 1 leaves Unassigned in two pieces
    //   0 0 0 0   ({4, 5} and {3, 7, 11}), which is allowed. Taking block 7 alone gives
    //   2 2 2 0   District 1 a second piece, which is not.
    const data = grid(4, [
      { pop: [10, 10, 3, 1], district: [1, 1, 0, 0] },
      { pop: [1, 1, 1, 3], district: [0, 0, 0, 0] },
      { pop: [10, 10, 10, 1], district: [2, 2, 2, 0] },
    ]);
    const request = { ...data, from: 0, to: 1, accept: [3] };
    const scored = checkedBorder(request, data.targets);
    expect(scored.map(({ transfer }) => [...transfer.blocks])).toContainEqual([2]);
    const detached = borderSolution(request, data.targets, { from: 0, to: 1, blocks: Uint32Array.of(7), people: 3 });
    expect(verifySolution(data.graph, data.assignment, data.targets, detached, { districts: [] })).toMatchObject({
      ok: false, error: expect.stringContaining('no original block'),
    });
    const pieces = borderSolution(request, data.targets,
      { from: 0, to: 1, blocks: Uint32Array.of(2, 6), people: 4 });
    expect(verifySolution(data.graph, data.assignment, data.targets, pieces, { districts: [] })).toEqual({ ok: true });
  });

  it('ranks a real neighbor that the move brings closer to zero ahead of Unassigned', () => {
    //   2 2 2     District 1 is 3 over; District 2 is 10 under. Either end block of District 1
    //   1 1 1     (3 people) can go to District 2 or to Unassigned; District 2 ranks first.
    //   0 0 0
    const data = grid(3, [
      { pop: [5, 4, 4], district: [2, 2, 2] },
      { pop: [3, 20, 3], district: [1, 1, 1] },
      { pop: [2, 3, 2], district: [0, 0, 0] },
    ]);
    expect(data.targets.q).toBe(23);
    const result = checkedDistrict({
      ...data, district: 1, includeUnassigned: true, maxOptions: 8, weights: { perimeterPerMeter: 0 },
    });
    const ends = result.solutions.map(s => s.transfers.map(t => `${t.from}>${t.to}:${t.blocks.join(',')}`).join(';'));
    expect(ends.slice(0, 2).sort()).toEqual(['1>2:3', '1>2:5']);
    expect(ends.slice(2).sort()).toEqual(['1>0:3', '1>0:5']);
    expect(result.solutions[0].deviations).toEqual([
      { district: 1, before: 3, after: 0 }, { district: 2, before: -10, after: -7 },
    ]);
  });

  it('ranks a real neighbor helped toward zero first even when an Unassigned option scores better', () => {
    //   2 2 2     As above, but block 3 shares a precinct with the unassigned block below it:
    //   1 1 1     giving it to Unassigned heals that split, so the search scores 1>0:3 best.
    //   0 0 0     District 2 is still helped toward zero by its options, so they come first.
    const data = grid(3, [
      { pop: [5, 4, 4], district: [2, 2, 2] },
      { pop: [3, 20, 3], district: [1, 1, 1] },
      { pop: [2, 3, 2], district: [0, 0, 0] },
    ], [0, 1, 2, 3, 4, 5, 3, 7, 8]);
    const request = { ...data, district: 1, includeUnassigned: true, maxOptions: 8, weights: { perimeterPerMeter: 0 } };
    const result = checkedDistrict(request);
    const ends = result.solutions.map(s => s.transfers.map(t => `${t.from}>${t.to}:${t.blocks.join(',')}`).join(';'));
    expect(ends.slice(0, 2).sort()).toEqual(['1>2:3', '1>2:5']);
    const heal = result.solutions.find(s => s.transfers[0].to === 0 && s.transfers[0].blocks[0] === 3);
    expect(heal?.stats.healedPrecinctSplits).toBe(1);
    // Without Unassigned in the request, the order is the search's own, exactly as before.
    const real = checkedDistrict({ ...request, includeUnassigned: false });
    for (const s of real.solutions) expect(s.transfers.every(t => t.to === 2)).toBe(true);
  });

  it('ranks the helped real neighbor first however few options are asked for', () => {
    // The fixture above, where the search scores 1>0:3 best: asking for one or two options must
    // not cut the list before District 2's options are ranked ahead of Unassigned's.
    const data = grid(3, [
      { pop: [5, 4, 4], district: [2, 2, 2] },
      { pop: [3, 20, 3], district: [1, 1, 1] },
      { pop: [2, 3, 2], district: [0, 0, 0] },
    ], [0, 1, 2, 3, 4, 5, 3, 7, 8]);
    const request = { ...data, district: 1, includeUnassigned: true, weights: { perimeterPerMeter: 0 } };
    const all = checkedDistrict({ ...request, maxOptions: 8 }).solutions.map(s => s.id);
    for (const maxOptions of [1, 2, 3, 5, 8]) {
      const result = checkedDistrict({ ...request, maxOptions });
      expect(result.solutions.map(s => s.id)).toEqual(all.slice(0, maxOptions));
      expect(result.solutions[0].transfers.every(t => t.to === 2)).toBe(true);
    }
  });

  it('on a complete map, permission changes nothing, however many options are asked for', () => {
    const random = seeded(11);
    let compared = 0;
    for (let run = 0; run < 10; run++) {
      const { data, k } = randomMap(random, 0);
      for (let district = 1; district <= k; district++) for (const maxOptions of [1, 3, 6]) {
        const { elapsedMs: _a, ...without } = checkedDistrict({ ...data, district, maxOptions });
        const { elapsedMs: _b, ...withIt } = checkedDistrict({ ...data, district, maxOptions, includeUnassigned: true });
        expect(withIt).toEqual(without);
        compared += without.solutions.length;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('still offers the helped real neighbor when every cheaper option goes to Unassigned', () => {
    //   0 0 0 0 0 0 0 0    District 1 (rows 1-2) is 1 over; District 2 (rows 3-4) is 41 under.
    //   1 1 1 1 1 1 1 1    Rows 0-2 are one county and rows 3-4 another, so giving one of the
    //   1 1 1 1 1 1 1 1    two 1-person corner blocks of row 2 to District 2 splits a county,
    //   2 2 2 2 2 2 2 2    while giving any 1-person block of row 1 to Unassigned does not (the
    //   2 2 2 2 2 2 2 2    county already holds unassigned blocks). The search's own cost fills
    //                      every slot with Unassigned options; District 2's must still come first.
    const data = grid(8, [
      { pop: [5, 5, 5, 5, 5, 5, 5, 5], district: [0, 0, 0, 0, 0, 0, 0, 0] },
      { pop: [1, 1, 1, 1, 1, 1, 1, 1], district: [1, 1, 1, 1, 1, 1, 1, 1] },
      { pop: [1, 10, 10, 10, 10, 10, 10, 1], district: [1, 1, 1, 1, 1, 1, 1, 1] },
      { pop: [2, 2, 2, 2, 2, 2, 1, 1], district: [2, 2, 2, 2, 2, 2, 2, 2] },
      { pop: [2, 2, 2, 2, 2, 2, 1, 1], district: [2, 2, 2, 2, 2, 2, 2, 2] },
    ]);
    data.graph.countyOf = Uint16Array.from({ length: 40 }, (_, b) => (b < 24 ? 1 : 2));
    expect(data.targets.q).toBe(69);
    const real = checkedDistrict({ ...data, district: 1 });
    expect(real.solutions.length).toBeGreaterThan(0);
    for (const s of real.solutions) {
      expect(s.transfers.map(t => t.to)).toEqual([2]);
      expect(s.stats.newCountySplits).toBe(1);
    }
    // Unassigned alone: every option is cheaper than any real one (no county split).
    const unassignedOnly = checkedDistrict({ ...data, district: 1, absorbers: [0] });
    expect(unassignedOnly.solutions.length).toBe(5);
    for (const s of unassignedOnly.solutions) expect(s.stats.cost).toBeLessThan(real.solutions[0].stats.cost);
    for (const maxOptions of [1, 5, 8]) {
      const allowed = checkedDistrict({ ...data, district: 1, includeUnassigned: true, maxOptions });
      const helped = allowed.solutions.filter(s => s.transfers.some(t => t.to === 2));
      expect(helped.map(s => s.id)).toEqual(real.solutions.map(s => s.id).slice(0, maxOptions));
      expect(allowed.solutions.slice(0, helped.length)).toEqual(helped);
      if (maxOptions === 8) expect(allowed.solutions.some(touchesUnassigned)).toBe(true);
    }
  });

  it('counts a new split between two real districts in a region that also holds unassigned blocks', () => {
    //   0 1 1 1    Block 0 is an empty unassigned block (say, water left unassigned on a finished
    //   2 2 2 2    map). It shares precinct 9 and town 1 with blocks 1 and 2 of District 1. The
    //              only move is block 1 (2 people) to District 2: it divides that precinct and
    //              town between Districts 1 and 2, a new split whether or not Unassigned may trade.
    const data = grid(4, [
      { pop: [0, 2, 10, 10], district: [0, 1, 1, 1] },
      { pop: [5, 5, 5, 4], district: [2, 2, 2, 2] },
    ], [9, 9, 9, 3, 4, 5, 6, 7]);
    data.graph.townOf = Uint32Array.from([1, 1, 1, 0, 0, 0, 0, 0]);
    for (const includeUnassigned of [false, true]) {
      const result = checkedDistrict({ ...data, district: 1, includeUnassigned });
      const option = result.solutions.find(s => s.transfers.length === 1 && s.transfers[0].to === 2);
      expect([...option!.transfers[0].blocks]).toEqual([1]);
      expect(option!.stats).toMatchObject({ newPrecinctSplits: 1, healedPrecinctSplits: 0, newTownSplits: 1 });
      // Giving the same block to Unassigned divides nothing new: precinct 9 and town 1 were
      // already shared by District 1 and Unassigned.
      const erase = result.solutions.find(s => s.transfers[0].to === 0);
      if (includeUnassigned) expect(erase?.stats).toMatchObject({ newPrecinctSplits: 0, newTownSplits: 0 });
      else expect(erase).toBeUndefined();
    }
  });

  it('without permission, gives the same answers whatever regions the unassigned blocks lie in', () => {
    // Without permission, unassigned blocks are invisible to split counting, exactly as before
    // Unassigned could trade: moving their county or town elsewhere changes nothing. Random
    // partly drawn maps, every district, with and without a list of real absorbers.
    const random = seeded(7);
    let compared = 0;
    for (let run = 0; run < 12; run++) {
      const { data, district, k } = randomMap(random, 3);
      if (new Set(district).size !== k + 1) continue;
      // The same map, with every unassigned block moved to a county and a town of its own.
      const moved = {
        ...data.graph,
        countyOf: data.graph.countyOf.map((c, b) => (district[b] ? c : 1000 + b)),
        townOf: data.graph.townOf!.map((t, b) => (district[b] ? t : 1000 + b)),
      };
      for (let d = 1; d <= k; d++) for (const absorbers of [undefined, [1, 2, 3].filter(x => x !== d)]) {
        const solve = (graph: EngineGraph) => {
          const { elapsedMs: _, ...rest } = checkedDistrict({ ...data, graph, district: d, absorbers });
          return rest;
        };
        const answer = solve(data.graph);
        expect(answer.solutions.some(touchesUnassigned)).toBe(false);
        expect(solve(moved)).toEqual(answer);
        compared += answer.solutions.length;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('counts a precinct divided between a district and Unassigned as split', () => {
    //   1 1 0 0   Blocks 2 and 3 are one unassigned precinct (7 and 4 people). Taking only
    //   2 2 2 2   block 2 divides it; taking both does not. Block 1 shares precinct 9 with
    //             unassigned block 3 in the second map: giving it away heals that precinct.
    const values = { pop: [10, 10, 7, 4], district: [1, 1, 0, 0] };
    const south = { pop: [10, 10, 10, 9], district: [2, 2, 2, 2] };
    const data = grid(4, [values, south], [0, 1, 5, 5, 6, 7, 8, 9]);
    const take = (accept: number) => checkedBorder({ ...data, from: 0, to: 1, accept: [accept] }, data.targets);
    const [partial] = take(7);
    expect([...partial.transfer.blocks]).toEqual([2]);
    expect(partial.stats).toMatchObject({ newPrecinctSplits: 1, healedPrecinctSplits: 0, districtsTouched: 1 });
    const [whole] = take(11);
    expect([...whole.transfer.blocks]).toEqual([2, 3]);
    expect(whole.stats).toMatchObject({ newPrecinctSplits: 0, healedPrecinctSplits: 0 });

    const shared = grid(4, [{ pop: [10, 5, 7, 4], district: [1, 1, 0, 0] }, south], [0, 9, 5, 9, 6, 7, 8, 10]);
    const [heal] = checkedBorder({ ...shared, from: 1, to: 0, accept: [5] }, shared.targets);
    expect([...heal.transfer.blocks]).toEqual([1]);
    expect(heal.stats).toMatchObject({ newPrecinctSplits: 0, healedPrecinctSplits: 1 });
  });

  it('reports capacity with Unassigned on either side, every endpoint backed by a solve', () => {
    //   1 0 0 0 0 0   District 1 (one block) next to a strip of one-block unassigned precincts:
    //   2 2 2 2 2 2   only the strip block touching District 1 can move into it, so the capacity
    //                 into District 1 is far below what Unassigned holds.
    const data = grid(6, [
      { pop: [20, 1, 2, 3, 4, 5], district: [1, 0, 0, 0, 0, 0] },
      { pop: [5, 5, 5, 5, 5, 5], district: [2, 2, 2, 2, 2, 2] },
    ]);
    for (const [from, to] of [[0, 1], [1, 0], [0, 2], [2, 0]]) {
      const request = { ...data, from, to };
      const { tiers } = borderSolver.capacity(request);
      let total = 0;
      for (const tier of tiers) {
        total += tier.people;
        expect(checkedBorder({ ...request, accept: [total] }, data.targets).length).toBeGreaterThan(0);
      }
      expect(total).toBeGreaterThan(0);
      expect(checkedBorder({ ...request, accept: [total + 1] }, data.targets)).toEqual([]);
      if (from === 0 && to === 1) expect(total).toBe(1);
    }
    // Locked blocks never move, Unassigned or not.
    const locked = Uint8Array.from({ length: 12 }, (_, b) => Number(b === 1));
    expect(borderSolver.capacity({ ...data, from: 0, to: 1, locked }).tiers).toEqual([]);
    expect(borderSolver.solve({ ...data, from: 0, to: 1, accept: [1], locked })).toEqual([]);
  });

  it('gives the same answers whatever the cached model saw before, as blocks move to and from Unassigned', () => {
    // The engine caches per-graph state and updates it from the previous assignment; erasing and
    // re-assigning blocks in place must give exactly what a fresh graph gives.
    const data = overNextToUnassigned();
    const fresh = () => ({ ...data.graph });
    const solve = (graph: EngineGraph, assignment: Uint16Array) => {
      const { elapsedMs: _, ...rest } = solveDistrict({ ...data, graph, assignment, district: 1, includeUnassigned: true });
      return rest;
    };
    const mutable = data.assignment.slice();
    const steps: Array<[number, number]> = [[8, 1], [4, 0], [12, 2], [8, 0], [4, 1], [12, 0], [6, 0], [6, 2]];
    for (const [block, district] of steps) {
      mutable[block] = district;
      expect(solve(data.graph, mutable)).toEqual(solve(fresh(), mutable.slice()));
    }
    expect(mutable).toEqual(data.assignment);
    expect(solve(data.graph, mutable).solutions[0].transfers[0]).toMatchObject({ from: 1, to: 0, people: 3 });
  });

  it('leaves Unassigned alone on a partly drawn map without permission', () => {
    //   1 1 1     District 1 is 2 over. Block 0 (2 people) can go to District 2, which is
    //   2 2 0     under; block 2 (2 people) touches only Unassigned, so without permission it
    //   0 0 0     stays put.
    const data = grid(3, [
      { pop: [2, 18, 2], district: [1, 1, 1] },
      { pop: [8, 2, 2], district: [2, 2, 0] },
      { pop: [2, 2, 2], district: [0, 0, 0] },
    ]);
    const result = checkedDistrict({ ...data, district: 1 });
    expect(result.status).toBe('ok');
    expect(result.solutions.some(touchesUnassigned)).toBe(false);
    const allowed = checkedDistrict({ ...data, district: 1, includeUnassigned: true });
    expect(allowed.solutions.some(touchesUnassigned)).toBe(true);
    // The real neighbor's option is unchanged and still first.
    expect(allowed.solutions[0]).toEqual(result.solutions[0]);
  });
});
