/**
 * The user's area: point-in-polygon, the inside mask (src/panel/area.ts) and the worker's area
 * rules (src/worker/area.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Solution } from '@zd/contracts';
import { areaSolveMessage, boxRing, cleanRing, cleanSavedAreas, countInside, insideMask, nearestBlock, pointInRing, splitAreaSentences, type Ring } from '../../src/panel/area';
import { applyArea, mergeInsideFirst, outsideCount } from '../../src/worker/area';
import { ringArea, ringSelfCrosses } from '../../src/shared/ring';

/** Seeded PRNG (the tests must not change from run to run). */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const toPoints = (pts: Array<[number, number]>) => {
  const a = new Int32Array(2 * pts.length);
  pts.forEach(([x, y], i) => {
    a[2 * i] = Math.round(x * 1e6);
    a[2 * i + 1] = Math.round(y * 1e6);
  });
  return a;
};

describe('region areas', () => {
  it('finds the nearest block with wrapped longitudes', () => {
    const points = toPoints([[-179.4, 52], [179.4, 52], [179.7, 51.2]]);
    expect(nearestBlock(points, [-180.4, 52])).toBe(1);
    expect(nearestBlock(points, [180.4, 52])).toBe(0);
    expect(nearestBlock(points, [0, Number.NaN])).toBe(-1);
  });

  it('reads saved regions and leaves out the no-town sentinel and malformed indexes', () => {
    const valid = { region: { kind: 'county', index: 0, name: 'West County' }, mode: 'only' };
    expect(cleanSavedAreas({
      valid,
      noTown: { region: { kind: 'town', index: 0, name: 'Westfield town' } },
      invalid: { region: { kind: 'county', index: 1.5, name: 'West County' } },
    })).toEqual({ valid });
  });
});

describe('pointInRing', () => {
  const square = boxRing(-75, 42, -74, 43);
  it('inside, outside, either side of a concave notch', () => {
    expect(pointInRing(-74.5, 42.5, square)).toBe(true);
    expect(pointInRing(-75.5, 42.5, square)).toBe(false);
    expect(pointInRing(-74.5, 43.5, square)).toBe(false);
    // A "C": the notch on the right is outside.
    const c: Ring = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 2],
      [3, 2],
      [3, 3],
      [0, 3],
    ];
    expect(pointInRing(0.5, 1.5, c)).toBe(true);
    expect(pointInRing(2, 1.5, c)).toBe(false);
    expect(pointInRing(2, 0.5, c)).toBe(true);
    expect(pointInRing(2, 2.5, c)).toBe(true);
  });
  it('does not care which way the ring runs', () => {
    const rev = [...square].reverse();
    expect(pointInRing(-74.5, 42.5, rev)).toBe(true);
    expect(pointInRing(-73.5, 42.5, rev)).toBe(false);
  });
});

describe('insideMask', () => {
  it('matches the plain test on random rings and points, including self-crossing ones', () => {
    const r = rng(7);
    for (let trial = 0; trial < 40; trial++) {
      const k = 3 + Math.floor(r() * 30);
      const ring: Ring = Array.from({ length: k }, () => [-80 + r() * 10, 40 + r() * 5] as [number, number]);
      const pts = Array.from({ length: 3000 }, () => [-81 + r() * 12, 39 + r() * 7] as [number, number]);
      const mask = insideMask(toPoints(pts), pts.length, ring);
      // The mask works in whole millionths of a degree; compare at those coordinates.
      const want = pts.map(([x, y]) => (pointInRing(Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6, ring) ? 1 : 0));
      expect(Array.from(mask)).toEqual(want);
    }
  });

  it('a star-shaped ring with many corners', () => {
    const ring: Ring = Array.from({ length: 400 }, (_, i) => {
      const a = (i / 400) * 2 * Math.PI;
      const rad = i % 2 ? 1 : 0.4;
      return [-100 + rad * Math.cos(a), 40 + rad * Math.sin(a)] as [number, number];
    });
    const r = rng(11);
    const pts = Array.from({ length: 20000 }, () => [-101.2 + r() * 2.4, 38.8 + r() * 2.4] as [number, number]);
    const mask = insideMask(toPoints(pts), pts.length, ring);
    const want = pts.map(([x, y]) => (pointInRing(Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6, ring) ? 1 : 0));
    expect(Array.from(mask)).toEqual(want);
    expect(mask.reduce((s, v) => s + v, 0)).toBeGreaterThan(1000);
  });

  it('a ring drawn across the antimeridian (longitudes past -180) still finds the blocks there', () => {
    // Aleutian blocks west of 180° have positive longitudes; the map reports the ring as < -180.
    const ring = boxRing(-181, 51, -179, 53);
    const pts: Array<[number, number]> = [
      [179.5, 52], // = -180.5: inside
      [-179.5, 52], // inside
      [178, 52], // = -182: outside
      [-179.5, 54], // outside (north)
    ];
    expect(Array.from(insideMask(toPoints(pts), pts.length, ring))).toEqual([1, 1, 0, 0]);
  });

  it('degenerate rings hold nothing; points shorter than n are not read', () => {
    const pts = toPoints([[0, 0]]);
    expect(Array.from(insideMask(pts, 1, [[0, 0], [1, 1], [2, 2]]))).toEqual([0]);
    expect(Array.from(insideMask(pts, 1, [[0, 0], [1, 1]]))).toEqual([0]);
    expect(Array.from(insideMask(new Int32Array(0), 3, boxRing(-1, -1, 1, 1)))).toEqual([0, 0, 0]);
  });

  it('is fast enough for the biggest state (~670k blocks), once per ring', () => {
    const n = 670_000;
    const r = rng(3);
    const pts = new Int32Array(2 * n);
    for (let i = 0; i < n; i++) {
      pts[2 * i] = Math.round((-106 + r() * 13) * 1e6); // Texas-sized box
      pts[2 * i + 1] = Math.round((26 + r() * 10) * 1e6);
    }
    // A drawn outline over a good part of it, with a couple of dozen corners.
    const ring: Ring = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      return [-99.5 + 4 * Math.cos(a) * (i % 3 ? 1 : 0.7), 31 + 3 * Math.sin(a)] as [number, number];
    });
    const t0 = performance.now();
    const mask = insideMask(pts, n, ring);
    const ms = performance.now() - t0;
    const inside = mask.reduce((s, v) => s + v, 0);
    console.log(`  inside mask: ${n} blocks, ${inside} inside, ${ms.toFixed(0)} ms`);
    expect(inside).toBeGreaterThan(50_000);
    expect(ms).toBeLessThan(1500);
  });
});

describe('cleanRing / cleanSavedAreas / countInside', () => {
  it('cleans a drawn ring and refuses what is not one', () => {
    expect(cleanRing([[0, 0], [1, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(cleanRing([[0, 0], [1, 0]])).toBeNull();
    expect(cleanRing([[0, 0], [1, 0], [Number.NaN, 1]])).toBeNull();
    expect(cleanRing([[0, 0], [1, 0], [1, 95]])).toBeNull();
    expect(cleanRing('nope')).toBeNull();
    // Self-crossing outlines: the map's fill (earcut) and the even-odd count disagree on them.
    const star: Ring = [0, 1, 2, 3, 4].map((i) => [Math.cos(Math.PI / 2 + (i * 4 * Math.PI) / 5), Math.sin(Math.PI / 2 + (i * 4 * Math.PI) / 5)]);
    expect(ringSelfCrosses(star)).toBe(true);
    expect(cleanRing(star)).toBeNull();
    expect(cleanRing([[0, 0], [2, 0], [0, 1], [2, 1]])).toBeNull(); // bow tie
    expect(cleanRing([[0, 0], [1, 0], [2, 0]])).toBeNull(); // all in a line: no area
    // Simple outlines, concave ones included, are kept.
    expect(cleanRing([[0, 0], [2, 0], [2, 2], [1, 1], [0, 2]])).toEqual([[0, 0], [2, 0], [2, 2], [1, 1], [0, 2]]);
    expect(ringSelfCrosses([[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(false);
    // An edge that runs back along another, or a corner on an edge it is not next to.
    expect(ringSelfCrosses([[0, 0], [2, 0], [2, 1], [1, 0], [0, 1]])).toBe(true);
    expect(ringArea([[0, 0], [2, 0], [2, 2], [0, 2]])).toBeCloseTo(4);
  });
  it('keeps only well-formed saved areas; mode defaults to prefer', () => {
    const saved = cleanSavedAreas({
      a: { ring: [[0, 0], [1, 0], [1, 1]], mode: 'only' },
      b: { ring: [[0, 0], [1, 0], [1, 1]], mode: 'weird' },
      c: { ring: [[0, 0]] },
      d: null,
    });
    expect(Object.keys(saved)).toEqual(['a', 'b']);
    expect(saved.a.mode).toBe('only');
    expect(saved.b.mode).toBe('prefer');
    expect(cleanSavedAreas(null)).toEqual({});
  });
  it('counts blocks and people inside', () => {
    expect(countInside(Uint8Array.from([1, 0, 1, 1]), Int32Array.from([5, 7, 0, 3]))).toEqual({ blocks: 3, people: 8 });
  });
});

describe('areaSolveMessage', () => {
  const base = { blocksInside: 40, who: 'District 1' };
  // The solver's own area sentences (packages/engine solveDistrictInArea, packages/planner planInArea).
  const ENGINE_REASON = 'No move made only of blocks inside the area hits the target; there are moves that go outside it. Choose Prefer to see them, or mark a larger area.';
  const ENGINE_BORDER = "The area does not reach District 1's border, so no move can stay inside it. Mark an area over the border, or choose Prefer.";
  const ENGINE_FILL = 'Nothing inside the area hits the target; these options move blocks outside it.';
  const PLANNER_REASON = 'No plan moves only blocks inside the area; there are plans that move blocks outside it. Choose Prefer to see them, or mark a larger area.';
  const PLANNER_FILL = 'No plan moves only blocks inside the area; these plans move some blocks outside it.';

  it('only + nothing found because of the area: says so once, in the panel\'s words; Prefer or a bigger area', () => {
    const m = areaSolveMessage({ ...base, mode: 'only', status: 'needs-precinct-rework', outside: [], message: ENGINE_REASON })!;
    expect(m).toBe('Nothing inside your area zeroes District 1, and Only lets nothing outside the area move. Switch the area to Prefer to allow moves outside it, or mark a bigger area.');
    // The one-district fallback words both solvers' messages into one; still said once.
    const both = areaSolveMessage({ ...base, mode: 'only', status: 'needs-precinct-rework', outside: [], message: `${ENGINE_REASON} The multi-border planner found nothing either: ${PLANNER_REASON}` })!;
    expect(both).toBe(m);
    const group = areaSolveMessage({ ...base, who: 'the map', mode: 'only', status: 'needs-precinct-rework', outside: [], message: PLANNER_REASON })!;
    expect(group).toMatch(/^Nothing inside your area zeroes the map/);
    // The worker had to drop options that went outside: the area is the reason too.
    expect(areaSolveMessage({ ...base, mode: 'only', status: 'needs-precinct-rework', outside: [], areaDropped: 2, message: 'x.' })).toMatch(/^Nothing inside your area zeroes District 1.* x\.$/);
    expect(areaSolveMessage({ ...base, blocksInside: 0, mode: 'only', status: 'done', outside: [] })).toMatch(/holds no blocks/);
  });
  it('only + the area misses the border: says that, and keeps the rest of the message', () => {
    const m = areaSolveMessage({ ...base, mode: 'only', status: 'needs-precinct-rework', outside: [], message: `No way to zero District 1 trading only with District 2 was found. ${ENGINE_BORDER} Pick more neighbors, or choose "Any neighbor".` })!;
    expect(m).toBe('Your area does not reach District 1\'s border, so with Only no move can stay inside it. Mark a bigger area that takes in the border, or switch the area to Prefer. No way to zero District 1 trading only with District 2 was found. Pick more neighbors, or choose "Any neighbor".');
  });
  it('only + nothing found even without the area: the solver\'s message stands (the area is not why)', () => {
    expect(areaSolveMessage({ ...base, mode: 'only', status: 'needs-precinct-rework', outside: [], message: 'No one-way move found.' })).toBe('No one-way move found.');
  });
  it('leaves alone what the area did not cause', () => {
    expect(areaSolveMessage({ ...base, mode: 'only', status: 'done', alreadyZero: true, outside: [], message: 'This district is already at zero.' })).toBe('This district is already at zero.');
    expect(areaSolveMessage({ ...base, mode: 'only', status: 'group-unbalanced', outside: [], message: 'unbalanced' })).toBe('unbalanced');
    expect(areaSolveMessage({ ...base, mode: 'only', status: 'error', outside: [], message: 'The area does not match the block graph.' })).toBe('The area does not match the block graph.');
    expect(areaSolveMessage({ ...base, mode: 'prefer', status: 'needs-precinct-rework', outside: [], message: 'nothing' })).toBe('nothing');
    expect(areaSolveMessage({ ...base, mode: 'prefer', status: 'done', outside: [0, 3] })).toBeUndefined();
    expect(areaSolveMessage({ ...base, mode: 'only', status: 'done', outside: [0, 0], message: 'x' })).toBe('x');
  });
  it('prefer + every option goes outside: says so once (the solver\'s note is replaced)', () => {
    const note = 'Nothing inside your area works, so every option moves some blocks outside it; each card says how many.';
    expect(areaSolveMessage({ ...base, mode: 'prefer', status: 'done', outside: [2, 5] })).toBe(note);
    expect(areaSolveMessage({ ...base, mode: 'prefer', status: 'done', outside: [2, 5], message: ENGINE_FILL })).toBe(note);
    expect(areaSolveMessage({ ...base, who: 'the map', mode: 'prefer', status: 'done', outside: [6], message: `${PLANNER_FILL} Some borders are traded in both directions.` })).toBe(`${note} Some borders are traded in both directions.`);
  });
});

describe('splitAreaSentences', () => {
  it('takes the solver\'s area sentences out and says what they meant', () => {
    expect(splitAreaSentences(undefined)).toEqual({ said: null });
    expect(splitAreaSentences('This group can be zeroed on its own.')).toEqual({ rest: 'This group can be zeroed on its own.', said: null });
    expect(splitAreaSentences('No plan moves only blocks inside the area; these plans move some blocks outside it. This group can be zeroed on its own.')).toEqual({ rest: 'This group can be zeroed on its own.', said: 'fill' });
    expect(splitAreaSentences('No plan moves only blocks inside the area; this plan moves some blocks outside it.')).toEqual({ said: 'fill' });
    // "areas" (Unassigned's wording) is not the area.
    expect(splitAreaSentences('The unassigned areas it touches hold too few people.').said).toBeNull();
  });
});

describe('applyArea (worker)', () => {
  const sol = (id: string, blocks: number[], outsideArea?: number): Solution => ({
    id,
    kind: 'single',
    transfers: [{ from: 1, to: 2, blocks: Uint32Array.from(blocks), people: blocks.length }],
    borderFlows: [{ from: 1, to: 2, people: blocks.length }],
    stats: { people: blocks.length, blocks: blocks.length, populatedBlocks: blocks.length, newPrecinctSplits: 0, healedPrecinctSplits: 0, newCountySplits: 0, perimeterDeltaM: 0, districtsTouched: 2, cost: 1, ...(outsideArea !== undefined ? { outsideArea } : {}) },
    deviations: [],
  });
  const inside = Uint8Array.from([1, 1, 1, 0, 0, 0]);

  it('counts distinct moved blocks outside', () => {
    const s = sol('a', [0, 3, 4]);
    s.transfers.push({ from: 2, to: 1, blocks: Uint32Array.from([3, 5]), people: 2 });
    expect(outsideCount(s, inside)).toBe(3);
  });
  it('no area: nothing changes', () => {
    const list = [sol('a', [3])];
    expect(applyArea(list, undefined).kept).toBe(list);
  });
  it('only: drops anything that moves a block outside, and stamps outsideArea 0', () => {
    const r = applyArea([sol('a', [3]), sol('b', [0, 1]), sol('c', [2, 4])], { inside, mode: 'only' });
    expect(r.kept.map((s) => s.id)).toEqual(['b']);
    expect(r.kept[0].stats.outsideArea).toBe(0);
    expect(r.dropped).toBe(2);
  });
  it('prefer: inside first, then fewest outside blocks, the solver order kept within a count', () => {
    const r = applyArea([sol('a', [3, 4]), sol('b', [3]), sol('c', [0]), sol('d', [5]), sol('e', [1, 2])], { inside, mode: 'prefer' });
    expect(r.kept.map((s) => s.id)).toEqual(['c', 'e', 'b', 'd', 'a']);
    expect(r.kept.map((s) => s.stats.outsideArea)).toEqual([0, 0, 1, 1, 2]);
    expect(r.dropped).toBe(0);
  });
  it('corrects an outsideArea that disagrees with the mask', () => {
    const r = applyArea([sol('a', [3, 4], 0)], { inside, mode: 'prefer' });
    expect(r.kept[0].stats.outsideArea).toBe(2);
  });
  // One district with Prefer: one-way options merged with two-way plans made inside the area.
  const plan = (id: string, give: number[], take: number[]): Solution => {
    const s = sol(id, give, 0);
    s.kind = 'fewest-splits';
    s.transfers.push({ from: 2, to: 1, blocks: Uint32Array.from(take), people: take.length });
    return s;
  };
  it('mergeInsideFirst: some one-way options inside, the rest outside: two-way plans inside take places before the outside ones', () => {
    // The worker used to look for two-way plans only when every one-way option went outside.
    const oneWay = applyArea([sol('in1', [0]), sol('out1', [3]), sol('out2', [3, 4]), sol('out3', [5, 4])], { inside, mode: 'prefer' }).kept;
    const r = mergeInsideFirst(oneWay, [plan('tw1', [1], [2]), plan('tw2', [0, 1], [2])], 4);
    expect(r.solutions.map((s) => s.id)).toEqual(['in1', 'tw1', 'tw2', 'out1']);
    expect(r.added).toBe(2);
    const counts = r.solutions.map((s) => s.stats.outsideArea);
    expect(counts).toEqual([...counts].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
  it('mergeInsideFirst: every one-way option outside: the two-way plans inside come first', () => {
    const oneWay = applyArea([sol('out1', [3]), sol('out2', [4, 5])], { inside, mode: 'prefer' }).kept;
    const r = mergeInsideFirst(oneWay, [plan('tw1', [1], [2])], 5);
    expect(r.solutions.map((s) => s.id)).toEqual(['tw1', 'out1', 'out2']);
    expect(r.added).toBe(1);
  });
  it('mergeInsideFirst: a two-way plan that is one of the one-way options, or goes outside, is not added; nothing inside is cut', () => {
    const oneWay = applyArea([sol('in1', [0]), sol('in2', [1])], { inside, mode: 'prefer' }).kept;
    const same = sol('dup', [0], 0);
    same.kind = 'fewest-blocks';
    const leaky = plan('leaky', [1], [3]);
    leaky.stats = { ...leaky.stats, outsideArea: 1 };
    let r = mergeInsideFirst(oneWay, [same, leaky], 5);
    expect(r.solutions.map((s) => s.id)).toEqual(['in1', 'in2']);
    expect(r.added).toBe(0);
    r = mergeInsideFirst(oneWay, [plan('tw1', [1], [2])], 2);
    expect(r.solutions.map((s) => s.id)).toEqual(['in1', 'in2', 'tw1']);
  });
});
