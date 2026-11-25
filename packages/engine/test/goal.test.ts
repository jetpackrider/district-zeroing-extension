import { describe, expect, it } from 'vitest';
import { computeTargets, type DistrictSolveRequest, type EngineGraph } from '@zd/contracts';
import { solveDistrict } from '../src';
import { verifySolution } from '../src/verify';

type Edge = [number, number, number?];

function makeGraph(
  values: number[],
  districts: number[],
  edges: Edge[],
  extra: { water?: number[]; precincts?: number[] } = {},
) {
  const n = values.length;
  const adjOffsets = new Uint32Array(n + 1);
  const neighbors: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [a, b, length = 10] of edges) {
    neighbors[a].push([b, length]);
    neighbors[b].push([a, length]);
  }
  const adjTargets: number[] = [];
  const adjLen: number[] = [];
  for (const [block, list] of neighbors.entries()) {
    for (const [next, length] of list.sort(([a], [b]) => a - b)) {
      adjTargets.push(next);
      adjLen.push(length);
    }
    adjOffsets[block + 1] = adjTargets.length;
  }
  const graph: EngineGraph = {
    n,
    pop: Int32Array.from(values),
    countyOf: new Uint16Array(n),
    precinctOf: Uint32Array.from(extra.precincts ?? values.map((_, i) => i)),
    adjOffsets,
    adjTargets: Uint32Array.from(adjTargets),
    adjLen: Uint16Array.from(adjLen),
    outerLen: new Uint32Array(n).fill(200),
    areaM2: new Float32Array(n).fill(400),
    ...(extra.water ? { water: Uint8Array.from(extra.water) } : {}),
  };
  const numDistricts = Math.max(...districts);
  const totalPop = values.reduce((sum, p) => sum + p, 0);
  return {
    graph,
    assignment: Uint16Array.from(districts),
    targets: computeTargets(totalPop, numDistricts),
  };
}

function checked(req: DistrictSolveRequest) {
  const before = req.assignment.slice();
  const res = solveDistrict(req);
  for (const sol of res.solutions) {
    expect(
      verifySolution(req.graph, req.assignment, req.targets, sol, {
        districts: [req.district],
        neighborTolerance: req.neighborTolerance ?? 0,
        goal: req.goal,
      }),
    ).toEqual({ ok: true });
  }
  expect(req.assignment).toEqual(before);
  return res;
}

describe('DistrictSolveRequest.goal (-1 | 0 | 1)', () => {
  it('over district aiming for +1 gives 1 fewer; aiming for -1 gives 1 more', () => {
    // 2 districts, total = 40 -> q = 20, draTarget = 20, remainder = 0.
    // D1: 15 + 3 + 4 + 2 + 1 = 25 (+5); D2: 15 (-5).
    const data = makeGraph(
      [15, 3, 4, 2, 1, 15],
      [1, 1, 1, 1, 1, 2],
      [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [2, 5], [3, 5], [4, 5]],
    );
    expect(data.targets).toMatchObject({ q: 20, draTarget: 20, remainder: 0 });

    const rZero = checked({ ...data, district: 1 });
    expect(rZero.status).toBe('ok');
    expect(rZero.solutions[0].stats.people).toBe(5);
    expect(rZero.solutions[0].deviations.find(d => d.district === 1)?.after).toBe(0);

    const rPlus = checked({ ...data, district: 1, goal: 1 });
    expect(rPlus.status).toBe('ok');
    expect(rPlus.solutions.length).toBeGreaterThan(0);
    for (const s of rPlus.solutions) {
      expect(s.stats.people).toBe(4);
      expect(s.deviations.find(d => d.district === 1)).toEqual({ district: 1, before: 5, after: 1 });
      expect(s.deviations.find(d => d.district === 2)).toEqual({ district: 2, before: -5, after: -1 });
    }

    // D2 is -5; giving 6 pushes D2 to +1 (|1| <= |-5|), within tolerance 0.
    const rMinus = checked({ ...data, district: 1, goal: -1 });
    expect(rMinus.status).toBe('ok');
    expect(rMinus.solutions.length).toBeGreaterThan(0);
    for (const s of rMinus.solutions) {
      expect(s.stats.people).toBe(6);
      expect(s.deviations.find(d => d.district === 1)).toEqual({ district: 1, before: 5, after: -1 });
      expect(s.deviations.find(d => d.district === 2)).toEqual({ district: 2, before: -5, after: 1 });
    }
  });

  it('direction flips for a district currently at 0: +1 takes 1, -1 gives 1, 0 and absent are already-zero', () => {
    // 3 districts, total = 60 -> q = 20, draTarget = 20.
    // D1: 19 + 1 = 20 (0); D2: 22 + 1 = 23 (+3); D3: 16 + 1 = 17 (-3).
    // D1 touches D2 (block 1 - block 3) and D3 (block 1 - block 4).
    const data = makeGraph(
      [19, 1, 22, 1, 16, 1],
      [1, 1, 2, 2, 3, 3],
      [[0, 1], [1, 3], [2, 3], [1, 4], [4, 5]],
    );
    expect(data.targets).toMatchObject({ q: 20, draTarget: 20, remainder: 0 });

    // Absent or explicit 0: already at target.
    expect(checked({ ...data, district: 1 }).status).toBe('already-zero');
    expect(checked({ ...data, district: 1, goal: 0 }).status).toBe('already-zero');

    // Aim for +1: D1 must TAKE 1 person from D2 (+3 -> +2).
    const rPlus = checked({ ...data, district: 1, goal: 1 });
    expect(rPlus.status).toBe('ok');
    expect(rPlus.solutions).toHaveLength(1);
    expect(rPlus.solutions[0].borderFlows).toEqual([{ from: 2, to: 1, people: 1 }]);
    expect(rPlus.solutions[0].deviations).toEqual([
      { district: 1, before: 0, after: 1 },
      { district: 2, before: 3, after: 2 },
    ]);

    // Aim for -1: D1 must GIVE 1 person to D3 (-3 -> -2).
    const rMinus = checked({ ...data, district: 1, goal: -1 });
    expect(rMinus.status).toBe('ok');
    expect(rMinus.solutions).toHaveLength(1);
    expect(rMinus.solutions[0].borderFlows).toEqual([{ from: 1, to: 3, people: 1 }]);
    expect(rMinus.solutions[0].deviations).toEqual([
      { district: 1, before: 0, after: -1 },
      { district: 3, before: -3, after: -2 },
    ]);
  });

  it('uses exact targets.draTarget + goal on an uneven state (remainder > 0)', () => {
    // 3 districts, total = 62 -> q = 20, remainder = 2, draTarget = round(62/3) = 21.
    // Under usual rule, 20 (dev -1) and 21 (dev 0) are both zeroed.
    // D1: 18 + 1 + 1 = 20 (dev -1); D2: 20 + 2 + 1 = 23 (dev +2); D3: 19 (dev -2).
    const data = makeGraph(
      [18, 1, 1, 20, 2, 1, 19],
      [1, 1, 1, 2, 2, 2, 3],
      [[0, 1], [0, 2], [1, 4], [2, 5], [3, 4], [3, 5], [1, 6]],
    );
    expect(data.targets).toEqual({ totalPop: 62, numDistricts: 3, q: 20, remainder: 2, draTarget: 21 });

    // Absent goal: D1 (pop 20 = q) is already-zero.
    expect(checked({ ...data, district: 1 }).status).toBe('already-zero');
    // goal: -1 -> draTarget - 1 = 20 -> already-zero!
    expect(checked({ ...data, district: 1, goal: -1 }).status).toBe('already-zero');
    // goal: 0 -> draTarget = 21 -> must take 1 person from D2!
    const r0 = checked({ ...data, district: 1, goal: 0 });
    expect(r0.status).toBe('ok');
    expect(r0.solutions[0].borderFlows).toEqual([{ from: 2, to: 1, people: 1 }]);
    expect(r0.solutions[0].deviations.find(d => d.district === 1)).toEqual({ district: 1, before: -1, after: 0 });
    // goal: +1 -> draTarget + 1 = 22 (strictly above q + 1 = 21!) -> must take 2 people from D2!
    const rPlus = checked({ ...data, district: 1, goal: 1 });
    expect(rPlus.status).toBe('ok');
    expect(rPlus.solutions[0].stats.people).toBe(2);
    expect(rPlus.solutions[0].deviations.find(d => d.district === 1)).toEqual({ district: 1, before: -1, after: 1 });
  });

  it('respects neighborTolerance and absorbers with goal', () => {
    // 2 districts, total = 40 -> draTarget = 20. D1 = 20 (0), D2 = 20 (0).
    const data = makeGraph(
      [19, 1, 19, 1],
      [1, 1, 2, 2],
      [[0, 1], [1, 3], [2, 3]],
    );
    // Default neighborTolerance 0 forbids pushing D2 from 0 to -1.
    expect(checked({ ...data, district: 1, goal: 1 }).status).toBe('needs-precinct-rework');
    // With neighborTolerance 1 (e.g. chosen neighbor), D2 may go 0 -> -1.
    const ok = checked({ ...data, district: 1, goal: 1, absorbers: [2], neighborTolerance: 1 });
    expect(ok.status).toBe('ok');
    expect(ok.solutions[0].deviations).toEqual([
      { district: 1, before: 0, after: 1 },
      { district: 2, before: 0, after: -1 },
    ]);
  });

  it('passes goal through the land-first wrapper (water blocks present)', () => {
    // 2 districts, total = 40 -> draTarget = 20.
    // D1: block 0 (19, land), block 1 (1, land); D2: block 2 (19, land), block 3 (1, land), block 4 (0, water).
    // Land bridge 1-3, plus water block 4 touching 0 and 2.
    const data = makeGraph(
      [19, 1, 19, 1, 0],
      [1, 1, 2, 2, 2],
      [[0, 1], [1, 3], [2, 3], [0, 4], [4, 2]],
      { water: [0, 0, 0, 0, 1] },
    );
    const res = checked({ ...data, district: 1, goal: -1, neighborTolerance: 1 });
    expect(res.status).toBe('ok');
    expect(res.solutions[0].stats.usesWater).toBeUndefined();
    expect(res.solutions[0].deviations.find(d => d.district === 1)).toEqual({ district: 1, before: 0, after: -1 });
  });

  it('supports Unassigned with goal', () => {
    // Total = 41 across 2 districts + 1 unassigned -> draTarget = 21 (wait: totalPop=40 -> 20).
    // 2 districts, block 4 is unassigned (pop 1).
    const data = makeGraph(
      [19, 1, 20, 1],
      [1, 1, 2, 0],
      [[0, 1], [1, 2], [1, 3]],
    );
    // Compute targets for totalPop = 40 (ignoring unassigned? Wait: targets are passed by caller).
    const targets = computeTargets(40, 2); // draTarget = 20
    // D1 is 20 (dev 0). Aim for +1 with absorbers: [0] -> takes block 3 (pop 1) from Unassigned.
    const res = checked({ ...data, targets, district: 1, goal: 1, absorbers: [0] });
    expect(res.status).toBe('ok');
    expect(res.solutions[0].borderFlows).toEqual([{ from: 0, to: 1, people: 1 }]);
    expect(res.solutions[0].deviations).toEqual([{ district: 1, before: 0, after: 1 }]);
  });

  it('rejects an out-of-range goal with status error', () => {
    const data = makeGraph([20, 20], [1, 2], [[0, 1]]);
    const res = solveDistrict({ ...data, district: 1, goal: 2 as unknown as 1 });
    expect(res.status).toBe('error');
  });
});
