import { describe, expect, it } from 'vitest';
import type { Solution, Transfer } from '@zd/contracts';
import { analyzeGroup, buildInteractionGraph, checkGroupFeasibility, planMetrics, populationExcess, resolveWeights, verifyPlan } from '../src/index';
import { DistrictTracker } from '../src/districts';
import { absorbTiers } from '../src/flowModel';
import { makeSolver } from './support/solvers';
import { generateMap, setDeviations } from './support/synth';
import { expectGoodPlan } from './support/check';

/** 5 vertical strips of 15 x 45 blocks (precincts 3 x 3). */
const map = setDeviations(generateMap({ seed: 3, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), [9, -9, 0, 1, 0]);
const W = 75;
const at = (x: number, y: number) => y * W + x;

function transfer(from: number, to: number, blocks: number[]): Transfer {
  const sorted = [...blocks].sort((a, b) => a - b);
  return { from, to, blocks: Uint32Array.from(sorted), people: sorted.reduce((s, b) => s + map.graph.pop[b], 0) };
}

/** Blocks of District 1 on its border with 2 (column 14) whose populations sum to exactly `people`. */
function borderBlocksSumming(people: number): number[] {
  const col: number[] = [];
  for (let y = 0; y < 45; y++) col.push(at(14, y));
  // contiguous run from the top with the right sum (search all runs)
  for (let s = 0; s < col.length; s++) {
    let sum = 0;
    for (let e = s; e < col.length; e++) {
      sum += map.graph.pop[col[e]];
      if (sum === people) return col.slice(s, e + 1);
      if (sum > people) break;
    }
  }
  throw new Error('no run');
}

const check = (transfers: Transfer[], extra: Partial<Parameters<typeof verifyPlan>[0]> = {}) =>
  verifyPlan({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 2], transfers, ...extra });

describe('verifyPlan (independent whole-plan check)', () => {
  const good = transfer(1, 2, borderBlocksSumming(9));

  it('accepts a correct plan', () => {
    const r = check([good]);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('catches a district not at q or q + 1', () => {
    expect(check([]).issues.map((i) => i.kind)).toContain('not-zeroed');
  });

  it('catches a block moved twice and a wrong source district', () => {
    const b = good.blocks[0];
    const kinds = check([good, transfer(2, 1, [b])]).issues.map((i) => i.kind);
    expect(kinds).toContain('moved-twice');
    const wrong = check([transfer(2, 1, [at(14, 0)])]).issues.map((i) => i.kind);
    expect(wrong).toContain('wrong-source');
  });

  it('catches a people count that does not match the blocks', () => {
    expect(check([{ ...good, people: good.people + 1 }]).issues.map((i) => i.kind)).toContain('people-mismatch');
  });

  it('catches an outside district being touched', () => {
    const r = check([good, transfer(3, 2, [at(30, 0)])]);
    expect(r.issues.map((i) => i.kind)).toContain('outside-touched');
    expect(check([good, transfer(3, 2, [at(30, 0)])], { allowOutsideAbsorb: true }).issues.map((i) => i.kind)).not.toContain('outside-touched');
  });

  it('also rejects an outside transfer when its district is excluded from the allowlist', () => {
    const transfers = [good, transfer(3, 2, [at(30, 0)])];
    const containsOutside = (absorbers: number[]) => check(transfers, { allowOutsideAbsorb: true, absorbers })
      .issues.some(i => i.kind === 'outside-touched' && i.district === 3);
    expect(containsOutside([3])).toBe(false);
    expect(containsOutside([4])).toBe(true);
    expect(containsOutside([])).toBe(true);
  });

  it('catches a locked block that moved', () => {
    const locked = new Uint8Array(map.graph.n);
    locked[good.blocks[0]] = 1;
    expect(check([good], { locked }).issues.map((i) => i.kind)).toContain('locked-moved');
  });

  it('catches a district cut in two (giving side) and a stranded piece (receiving side)', () => {
    // A full row of District 2 handed to District 1 cuts 2 into a top and a bottom part.
    const row: number[] = [];
    for (let x = 15; x < 30; x++) row.push(at(x, 20));
    const cut = check([transfer(2, 1, row)], { districts: [1, 2], allowOutsideAbsorb: true });
    expect(cut.issues.filter((i) => i.kind === 'new-piece').map((i) => i.district)).toEqual([2]);
    // An interior block of District 1 handed to District 3 strands a piece of 3.
    const stray = check([transfer(1, 3, [at(5, 20)])], { allowOutsideAbsorb: true });
    expect(stray.issues.filter((i) => i.kind === 'new-piece').map((i) => i.district)).toEqual([3]);
  });

  it('never mutates the input assignment', () => {
    const snap = map.assignment.slice();
    check([good]);
    expect(map.assignment).toEqual(snap);
  });

  it('the test-side checker rejects the same bad plans', () => {
    const sol = (transfers: Transfer[]): Solution => ({
      id: 'x', kind: 'fewest-splits', transfers, borderFlows: [], deviations: [],
      stats: { people: 0, blocks: 0, populatedBlocks: 0, newPrecinctSplits: 0, healedPrecinctSplits: 0, newCountySplits: 0, perimeterDeltaM: 0, districtsTouched: 0, cost: 0 },
    });
    expect(() => expectGoodPlan(map, sol([]), [1, 2])).toThrow();
    expect(() => expectGoodPlan(map, sol([good, transfer(2, 1, [good.blocks[0]])]), [1, 2])).toThrow();
  });
});

describe('DistrictTracker (planner-side piece counts)', () => {
  it('sees a giving district cut in two and undoes it on revert', () => {
    const t = new DistrictTracker(map.graph, map.assignment, 5);
    expect(t.components(2)).toBe(1);
    const row: number[] = [];
    for (let x = 15; x < 30; x++) row.push(at(x, 20));
    t.apply(row, 1);
    expect(t.components(2)).toBe(2);
    expect(t.components(1)).toBe(1);
    t.revert(row, 2, 1);
    expect(t.components(2)).toBe(1);
    expect(t.assignment).toEqual(map.assignment);
  });
});

describe('group feasibility', () => {
  const t = map.targets;
  it('populationExcess follows q / q + 1 bands', () => {
    expect(populationExcess(3 * t.q, 3, t)).toBe(0);
    expect(populationExcess(3 * t.q + 3, 3, t)).toBe(0); // remainder > 0: all three at q + 1
    expect(populationExcess(3 * t.q + 5, 3, t)).toBe(2);
    expect(populationExcess(3 * t.q - 4, 3, t)).toBe(-4);
    const even = { ...t, remainder: 0 };
    expect(populationExcess(3 * t.q + 1, 3, even)).toBe(1);
  });

  it('ranks the outside districts that help most first', () => {
    // Group {3} is 900 over; 2 is -500 and 4 is -800: adding 4 fixes more.
    const m = setDeviations(generateMap({ seed: 3, width: 75, height: 45, numDistricts: 5, layout: 'strips' }), [1302, -500, 900, -800, -900]);
    const f = checkGroupFeasibility({ graph: m.graph, assignment: m.assignment, targets: m.targets, districts: [3] });
    expect(f).toEqual({ feasible: false, excess: 899, suggestAdd: [4, 2] });
    // District 1 is over too and not adjacent: never suggested.
    const a = analyzeGroup({ graph: m.graph, assignment: m.assignment, targets: m.targets, districts: [3] });
    expect(a.message).toBe('This group is 899 over. Add District 4 or District 2, or let outside neighbors absorb it.');
    const allowed = checkGroupFeasibility({ graph: m.graph, assignment: m.assignment, targets: m.targets, districts: [3], allowOutsideAbsorb: true });
    expect(allowed).toEqual({ feasible: true, excess: 0, suggestAdd: [] });
  });

  it('the whole map is infeasible while blocks are unassigned', () => {
    const a = map.assignment.slice();
    a[at(0, 0)] = 0;
    a[at(1, 0)] = 0;
    const lost = map.graph.pop[at(0, 0)] + map.graph.pop[at(1, 0)];
    const f = checkGroupFeasibility({ graph: map.graph, assignment: a, targets: map.targets, districts: [1, 2, 3, 4, 5] });
    if (lost > map.targets.remainder) expect(f.feasible).toBe(false);
  });
});

describe('interaction graph', () => {
  it('matches the solver capacity curves for every neighboring pair', () => {
    const solver = makeSolver();
    const g = buildInteractionGraph({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: [1, 2, 3], solver });
    expect(g.nodes.map((n) => n.district)).toEqual([1, 2, 3]);
    expect(g.nodes[0].deviation).toBe(9 + map.targets.q - map.targets.draTarget);
    expect(g.edges.map((e) => [e.a, e.b])).toEqual([[1, 2], [2, 3]]);
    for (const e of g.edges) {
      const ab = solver.capacity({ graph: map.graph, assignment: map.assignment, from: e.a, to: e.b });
      expect(e.cheapAtoB).toBe(ab.tiers.filter((x) => x.kind === 'no-split').reduce((s, x) => s + x.people, 0));
      expect(e.maxAtoB).toBe(ab.tiers.reduce((s, x) => s + x.people, 0));
      expect(e.maxAtoB).toBeGreaterThanOrEqual(e.cheapAtoB);
      expect(e.maxBtoA).toBeGreaterThan(0); // cheap may be 0: the engine counts a new county split as not cheap
    }
  });
});

describe('absorber tiers', () => {
  it('are convex: toward zero first, then no worse than now, then penalized', () => {
    expect(absorbTiers(-100, 1, 10_000, 1, 1000)).toEqual([
      { cap: 101, cost: 1 },
      { cap: 100, cost: 501 },
      { cap: 10_000, cost: 1001 },
    ]);
    expect(absorbTiers(5, 1, 10_000, 1, 1000)).toEqual([{ cap: 10_000, cost: 1001 }]);
  });
});


describe('exact plan town splits', () => {
  it('charges each newly split town once and keeps town zero unassigned', () => {
    const moves = [transfer(1, 2, borderBlocksSumming(9))];
    const townOf = new Uint32Array(map.graph.n);
    townOf[moves[0].blocks[0]] = 1;
    townOf[0] = 1;
    const after = map.assignment.slice();
    for (const b of moves[0].blocks) after[b] = 2;
    const selected = new Set([1, 2]);
    const weights = resolveWeights({ newTownSplit: 275 });
    const score = (towns?: Uint32Array) => planMetrics({ ...map.graph, townOf: towns },
      map.assignment, after, moves, map.targets, weights, selected).stats;
    const untallied = score();
    expect(untallied).not.toHaveProperty('newTownSplits');
    expect(score(new Uint32Array(map.graph.n)).newTownSplits).toBe(0);
    expect(score(townOf).newTownSplits).toBe(1);
    expect(score(townOf).cost - untallied.cost).toBeCloseTo(275);
    const alreadySplit = townOf.slice();
    alreadySplit[at(15, 0)] = 1;
    expect(score(alreadySplit).newTownSplits).toBe(0);
  });
});

describe('exact plan walkthrough cost', () => {
  it('charges the same precinct on both legs and the shared border once', () => {
    const moves = [transfer(1, 2, [at(14, 0)]), transfer(2, 1, [at(15, 0)])];
    const precinctOf = map.graph.precinctOf.slice();
    precinctOf[at(15, 0)] = precinctOf[at(14, 0)];
    const graph = { ...map.graph, precinctOf };
    const after = map.assignment.slice();
    for (const t of moves) for (const b of t.blocks) after[b] = t.to;
    const score = (perStep: number) => planMetrics(graph, map.assignment, after, moves,
      map.targets, resolveWeights({ perStep }), new Set([1, 2])).stats;
    expect(score(17).steps).toBe(2);
    expect(score(17).cost - score(0).cost).toBeCloseTo(3 * 17);
  });
});
