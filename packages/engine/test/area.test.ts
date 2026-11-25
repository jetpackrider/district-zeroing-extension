/**
 * An area of the map where the user would like the swap to happen (AreaPreference in
 * @zd/contracts): 'only' never moves a block outside it, 'prefer' puts every option that stays
 * inside first and fills the remaining places with options that go outside, fewest outside
 * blocks first. Every option still passes the independent verifier.
 */
import { describe, expect, it } from 'vitest';
import {
  computeTargets, type AreaPreference, type DistrictSolveRequest, type EngineGraph, type Solution,
} from '@zd/contracts';
import { countOutsideArea, solveDistrict } from '../src';
import { synthetic } from '../scripts/synthetic';
import { verifySolution } from '../src/verify';

/** A w × h grid of blocks, row by row, 10 m edges; each block its own precinct unless `precincts` says otherwise. */
function grid(w: number, rows: Array<{ pop: number[]; district: number[] }>, precincts?: number[]) {
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

/** An area holding exactly the listed blocks. */
function area(n: number, blocks: number[], mode: AreaPreference['mode']): AreaPreference {
  const inside = new Uint8Array(n);
  for (const b of blocks) inside[b] = 1;
  return { inside, mode };
}

const outsideOf = (inside: Uint8Array) => inside.map(v => (v === 1 ? 0 : 1));

/** Test-side count of moved blocks outside the area (shares no code with the engine). */
function outsideCount(solution: Solution, inside: Uint8Array): number {
  return solution.transfers.reduce((sum, t) => sum + [...t.blocks].filter(b => !inside[b]).length, 0);
}

/**
 * solveDistrict, with every option verified independently: always as usual, and with every block
 * outside the area locked in 'only' mode. outsideArea must agree with a test-side count, and the
 * options must come fewest outside blocks first.
 */
function checked(req: DistrictSolveRequest) {
  const snapshot = req.assignment.slice();
  const result = solveDistrict(req);
  for (const solution of result.solutions) {
    expect(verifySolution(req.graph, req.assignment, req.targets, solution,
      { districts: [req.district], neighborTolerance: req.neighborTolerance ?? 0 })).toEqual({ ok: true });
    if (req.area) {
      expect(solution.stats.outsideArea).toBe(outsideCount(solution, req.area.inside));
      expect(solution.stats.outsideArea).toBe(countOutsideArea(solution.transfers, req.area.inside));
      if (req.area.mode === 'only') {
        expect(solution.stats.outsideArea).toBe(0);
        expect(verifySolution(req.graph, req.assignment, req.targets, solution,
          { districts: [req.district], locked: outsideOf(req.area.inside) })).toEqual({ ok: true });
      }
    } else {
      expect(solution.stats.outsideArea).toBeUndefined();
    }
  }
  const counts = result.solutions.map(s => s.stats.outsideArea ?? 0);
  expect(counts).toEqual([...counts].sort((a, b) => a - b));
  expect(new Set(result.solutions.map(s => s.id)).size).toBe(result.solutions.length);
  expect(req.assignment).toEqual(snapshot);
  return result;
}

const ends = (result: { solutions: Solution[] }) =>
  result.solutions.map(s => s.transfers.map(t => `${t.from}>${t.to}:${t.blocks.join(',')}`).join(';'));

/** Drop elapsedMs and outsideArea so a result can be compared with one made without an area. */
function plain(result: ReturnType<typeof solveDistrict>) {
  const { elapsedMs: _, ...rest } = result;
  return {
    ...rest,
    solutions: rest.solutions.map(s => {
      const { outsideArea: _o, ...stats } = s.stats;
      return { ...s, stats };
    }),
  };
}

/**
 *   1 1 1 2 2 2     District 1 (left) is 10 over; District 2 is 10 under. Any one of the four
 *   1 1 1 2 2 2     10-person blocks in column 2 can cross (blocks 2, 8, 14, 20): four options.
 *   1 1 1 2 2 2     Block 0 holds 20 so the totals come out right.
 *   1 1 1 2 2 2
 */
const twoHalves = () => grid(6, [0, 1, 2, 3].map(y => ({
  pop: [y === 0 ? 20 : 10, 10, 10, 10, 10, y === 0 ? 0 : 10],
  district: [1, 1, 1, 2, 2, 2],
})));

describe('one district with an area', () => {
  it('finds the same four options with no area, and with an area covering everything', () => {
    const data = twoHalves();
    expect(data.targets.q).toBe(120);
    const request = { ...data, district: 1, maxOptions: 8 };
    const none = checked(request);
    expect(ends(none).sort()).toEqual(['1>2:14', '1>2:2', '1>2:20', '1>2:8']);
    for (const mode of ['prefer', 'only'] as const) {
      const all = checked({ ...request, area: area(data.graph.n, [...Array(data.graph.n).keys()], mode) });
      expect(all.solutions.every(s => s.stats.outsideArea === 0)).toBe(true);
      expect(plain(all)).toEqual(plain(none));
    }
  });

  it('only: moves inside the area when some exist; prefer: those first, then the rest', () => {
    const data = twoHalves();
    // The top two rows of the border: blocks 2, 3, 8 and 9.
    const top = [2, 3, 8, 9];
    const request = { ...data, district: 1, maxOptions: 8 };
    const only = checked({ ...request, area: area(data.graph.n, top, 'only') });
    expect(only.status).toBe('ok');
    expect(ends(only).sort()).toEqual(['1>2:2', '1>2:8']);
    const prefer = checked({ ...request, area: area(data.graph.n, top, 'prefer') });
    expect(prefer.status).toBe('ok');
    expect(prefer.message).toBeUndefined();
    expect(ends(prefer).slice(0, 2).sort()).toEqual(['1>2:2', '1>2:8']);
    expect(ends(prefer).slice(2).sort()).toEqual(['1>2:14', '1>2:20']);
    expect(prefer.solutions.map(s => s.stats.outsideArea)).toEqual([0, 0, 1, 1]);
    // Enough inside for what was asked: no option goes outside.
    const two = checked({ ...request, maxOptions: 2, area: area(data.graph.n, top, 'prefer') });
    expect(two.solutions.map(s => s.stats.outsideArea)).toEqual([0, 0]);
    // Fewer asked than exist: the inside ones still come first.
    const three = checked({ ...request, maxOptions: 3, area: area(data.graph.n, top, 'prefer') });
    expect(three.solutions.map(s => s.stats.outsideArea)).toEqual([0, 0, 1]);
  });

  it('with no block of the border inside, only gives nothing and says the area is why; prefer goes outside', () => {
    const data = twoHalves();
    // Column 0 only: far from the border.
    const far = [0, 6, 12, 18];
    const request = { ...data, district: 1, maxOptions: 8 };
    const only = checked({ ...request, area: area(data.graph.n, far, 'only') });
    expect(only.status).toBe('needs-precinct-rework');
    expect(only.solutions).toEqual([]);
    expect(only.message).toMatch(/area does not reach District 1's border/);
    const prefer = checked({ ...request, area: area(data.graph.n, far, 'prefer') });
    expect(prefer.status).toBe('ok');
    expect(prefer.message).toMatch(/Nothing inside the area/);
    expect(ends(prefer).sort()).toEqual(['1>2:14', '1>2:2', '1>2:20', '1>2:8']);
    expect(prefer.solutions.every(s => s.stats.outsideArea === 1)).toBe(true);
  });

  it('says the area is why when it touches the border but no move inside it hits the number', () => {
    const data = twoHalves();
    // District 2's side of the border only: District 1 gives, so every block that moves is outside.
    const otherSide = [3, 9, 15, 21];
    const only = checked({ ...data, district: 1, area: area(data.graph.n, otherSide, 'only') });
    expect(only.status).toBe('needs-precinct-rework');
    expect(only.message).toMatch(/No move made only of blocks inside the area/);
    // When nothing hits the number anywhere, the area is not the reason and the message says what it always did.
    const stuck = grid(2, [{ pop: [7, 3], district: [1, 2] }]);
    const result = checked({ ...stuck, district: 1, area: area(2, [0, 1], 'only') });
    const without = checked({ ...stuck, district: 1 });
    expect(result.status).toBe(without.status);
    expect(result.message).toBe(without.message);
  });

  it('fills the remaining places fewest outside blocks first', () => {
    //   District 1 is 20 over: two column-2 blocks, or a column-2 block with the column-1 block
    //   beside it. Only block 2 is inside, so nothing inside hits 20; every option that takes
    //   block 2 has one block outside, the rest two.
    const data = grid(6, [0, 1, 2, 3].map(y => ({
      pop: [y === 0 ? 30 : 10, 10, 10, 10, 10, y <= 1 ? 0 : 10],
      district: [1, 1, 1, 2, 2, 2],
    })));
    expect(data.targets.q).toBe(120);
    const request = { ...data, district: 1, maxOptions: 8 };
    const none = checked(request);
    const prefer = checked({ ...request, area: area(data.graph.n, [2], 'prefer') });
    expect(prefer.solutions.length).toBe(none.solutions.length);
    expect(new Set(prefer.solutions.map(s => s.id))).toEqual(new Set(none.solutions.map(s => s.id)));
    const counts = prefer.solutions.map(s => s.stats.outsideArea);
    expect(counts).toContain(1);
    expect(counts).toContain(2);
    for (const s of prefer.solutions) {
      expect(s.stats.outsideArea).toBe([...s.transfers[0].blocks].includes(2) ? 1 : 2);
    }
    expect(checked({ ...request, area: area(data.graph.n, [2], 'only') }).solutions).toEqual([]);
  });

  it('orders by area first, then a real neighbor before Unassigned', () => {
    //   2 2 2     District 1 is 3 over; District 2 is 10 under. Either end block of District 1
    //   1 1 1     (3 or 5) can go to District 2 or to Unassigned. Only block 3 is in the area.
    //   0 0 0
    const data = grid(3, [
      { pop: [5, 4, 4], district: [2, 2, 2] },
      { pop: [3, 20, 3], district: [1, 1, 1] },
      { pop: [2, 3, 2], district: [0, 0, 0] },
    ]);
    const request = { ...data, district: 1, includeUnassigned: true, maxOptions: 8, weights: { perimeterPerMeter: 0 } };
    const prefer = checked({ ...request, area: area(data.graph.n, [3], 'prefer') });
    // Inside first (block 3), real neighbor first within it; then the outside ones, likewise.
    expect(ends(prefer)).toEqual(['1>2:3', '1>0:3', '1>2:5', '1>0:5']);
    expect(prefer.solutions.map(s => s.stats.outsideArea)).toEqual([0, 0, 1, 1]);
    const only = checked({ ...request, area: area(data.graph.n, [3], 'only') });
    expect(ends(only)).toEqual(['1>2:3', '1>0:3']);
    // Unassigned's side of the area: moving block 3 to Unassigned is still the inside move.
    const both = checked({ ...request, area: area(data.graph.n, [3, 5], 'prefer') });
    expect(ends(both).slice(0, 2).sort()).toEqual(['1>2:3', '1>2:5']);
    expect(ends(both).slice(2).sort()).toEqual(['1>0:3', '1>0:5']);
  });

  it('applies to blocks on either side: an under district taking blocks', () => {
    //   1 1 1     District 1 is 7 under. With permission it can take block 4 (7 people) from Unassigned.
    //   0 0 0
    //   2 2 2
    const data = grid(3, [
      { pop: [10, 10, 10], district: [1, 1, 1] },
      { pop: [4, 7, 4], district: [0, 0, 0] },
      { pop: [10, 10, 9], district: [2, 2, 2] },
    ]);
    const request = { ...data, district: 1, includeUnassigned: true };
    expect(ends(checked({ ...request, area: area(9, [4], 'only') }))).toEqual(['0>1:4']);
    expect(checked({ ...request, area: area(9, [0, 1, 2], 'only') }).solutions).toEqual([]);
    expect(ends(checked({ ...request, area: area(9, [0, 1, 2], 'prefer') }))).toEqual(['0>1:4']);
  });

  it('rejects an area whose mask does not match the graph', () => {
    const data = twoHalves();
    const result = solveDistrict({ ...data, district: 1, area: area(3, [0], 'prefer') });
    expect(result.status).toBe('error');
    expect(result.solutions).toEqual([]);
  });

  it('on random maps: no area or a full area gives the same answers; every area verifies', () => {
    const random = seeded(5);
    let checkedOptions = 0, inside = 0, filled = 0;
    for (let run = 0; run < 12; run++) {
      const { data, k } = randomMap(random, run % 3);
      const { n } = data.graph;
      const w = Math.round(Math.sqrt(n));
      for (let district = 1; district <= k; district++) for (const includeUnassigned of [false, true]) {
        const request = { ...data, district, maxOptions: 4, includeUnassigned };
        const none = checked(request);
        const full = checked({ ...request, area: area(n, [...Array(n).keys()], 'prefer') });
        expect(plain(full)).toEqual(plain(none));
        // A random rectangle.
        const x0 = Math.floor(random() * w), y0 = Math.floor(random() * w);
        const blocks = [...Array(n).keys()].filter(b => {
          const x = b % w, y = Math.floor(b / w);
          return x >= x0 && x < x0 + 3 && y >= y0 && y < y0 + 4;
        });
        const only = checked({ ...request, area: area(n, blocks, 'only') });
        const prefer = checked({ ...request, area: area(n, blocks, 'prefer') });
        // Prefer: every 'only' option among the inside ones, and never fewer options than with no area.
        const zero = new Set(prefer.solutions.filter(s => s.stats.outsideArea === 0).map(s => s.id));
        for (const s of only.solutions) expect(zero.has(s.id)).toBe(true);
        expect(prefer.solutions.length).toBeGreaterThanOrEqual(none.solutions.length);
        if (none.status === 'already-zero') expect(prefer.status).toBe('already-zero');
        checkedOptions += only.solutions.length + prefer.solutions.length;
        inside += only.solutions.length;
        filled += prefer.solutions.filter(s => s.stats.outsideArea).length;
      }
    }
    expect(checkedOptions).toBeGreaterThan(40);
    expect(inside).toBeGreaterThan(5);
    expect(filled).toBeGreaterThan(5);
  });

  it('on the benchmark map: a full area changes nothing, a partial one keeps every option valid', () => {
    const request = synthetic(487);
    const none = checked(request);
    const { n } = request.graph;
    const full = checked({ ...request, area: area(n, [...Array(n).keys()], 'only') });
    expect(plain(full)).toEqual(plain(none));
    // Half the map by block index (the grid is filled row by row): the top half.
    const top = [...Array(Math.floor(n / 2)).keys()];
    const only = checked({ ...request, area: area(n, top, 'only') });
    const prefer = checked({ ...request, area: area(n, top, 'prefer') });
    expect(only.solutions.length).toBeGreaterThan(0);
    expect(prefer.solutions.length).toBe(none.solutions.length);
  });
});

/** A deterministic random number source in [0, 1). */
function seeded(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * A random 6..8 × 6..8 map of three grown districts, 2 × 2 precincts, 3 × 3 counties and 2 × 3
 * towns, with `patches` small patches erased (set to Unassigned), as in unassigned.test.ts.
 */
function randomMap(random: () => number, patches: number) {
  const below = (n: number) => Math.floor(random() * n);
  const w = 6 + below(3), h = w, k = 3, n = w * h;
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
