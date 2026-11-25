import { describe, expect, it } from 'vitest';
import type { ClusterRequest, Clustering, EngineGraph } from '@zd/contracts';
import { countyGraph, findCountyClusters, verifyClustering } from '../src/index';
import { rng } from './support/synth';

/**
 * A block graph with `blocksPer` blocks per county (a path of blocks inside each county; the
 * first block of each county carries the links to other counties) and the given county links.
 */
function graphOf(pops: number[], edges: Array<[number, number]>, blocksPer = 1): EngineGraph {
  const C = pops.length;
  const n = C * blocksPer;
  const adj = Array.from({ length: n }, () => new Set<number>());
  const link = (a: number, b: number) => { adj[a].add(b); adj[b].add(a); };
  const pop = new Int32Array(n);
  const countyOf = new Uint16Array(n);
  for (let c = 0; c < C; c++) {
    for (let j = 0; j < blocksPer; j++) {
      const b = c * blocksPer + j;
      countyOf[b] = c;
      pop[b] = j === 0 ? pops[c] - Math.floor(pops[c] / blocksPer) * (blocksPer - 1) : Math.floor(pops[c] / blocksPer);
      if (j > 0) link(b, b - 1);
    }
  }
  for (const [a, b] of edges) link(a * blocksPer + (blocksPer - 1), b * blocksPer);
  const adjOffsets = new Uint32Array(n + 1);
  const targets: number[] = [];
  for (let i = 0; i < n; i++) { targets.push(...[...adj[i]].sort((x, y) => x - y)); adjOffsets[i + 1] = targets.length; }
  return {
    n, pop, countyOf, precinctOf: new Uint32Array(n), adjOffsets, adjTargets: Uint32Array.from(targets),
    adjLen: new Uint16Array(targets.length).fill(100), outerLen: new Uint32Array(n), areaM2: new Float32Array(n).fill(1e4),
  };
}

const path = (C: number): Array<[number, number]> => Array.from({ length: C - 1 }, (_, i) => [i, i + 1] as [number, number]);

function grid(w: number, h: number): Array<[number, number]> {
  const e: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x + 1 < w) e.push([y * w + x, y * w + x + 1]);
    if (y + 1 < h) e.push([y * w + x, (y + 1) * w + x]);
  }
  return e;
}

function expectValid(req: ClusterRequest, list: Clustering[]): void {
  for (const c of list) {
    const check = verifyClustering(req.graph, req, c);
    expect(check.issues).toEqual([]);
  }
}

/** Every partition of the counties into connected valid clusters with a valid Σk: (count, best worst deviation, largest). */
function bruteForce(pops: number[], edges: Array<[number, number]>, N: number, t: number, singletons: number[] = []) {
  const C = pops.length;
  const total = pops.reduce((a, b) => a + b, 0);
  const s = total / N;
  const nb = Array.from({ length: C }, () => [] as number[]);
  for (const [a, b] of edges) { nb[a].push(b); nb[b].push(a); }
  const ok = (P: number, k: number) => k >= 1 && Math.abs(P / k - s) <= t * s * (1 + 1e-12) + 1e-7;
  const keys: Array<{ count: number; d: number; l: number; canon: string }> = [];
  const label = new Array<number>(C).fill(0);
  const rec = (i: number, m: number) => {
    if (i === C) {
      const groups = Array.from({ length: m }, () => [] as number[]);
      for (let c = 0; c < C; c++) groups[label[c]].push(c);
      for (const g of groups) {
        if (g.length > 1 && g.some((c) => singletons.includes(c))) return;
        const inG = new Set(g);
        const seen = new Set([g[0]]);
        const q = [g[0]];
        while (q.length) { const c = q.pop()!; for (const w of nb[c]) if (inG.has(w) && !seen.has(w)) { seen.add(w); q.push(w); } }
        if (seen.size !== g.length) return;
      }
      // Best k per group with Σk = N, minimizing the worst deviation (small: brute force over k).
      const P = groups.map((g) => g.reduce((a, c) => a + pops[c], 0));
      const choices = P.map((p) => { const ks: number[] = []; for (let k = 1; k <= N; k++) if (ok(p, k)) ks.push(k); return ks; });
      if (choices.some((ks) => !ks.length)) return;
      let best = Infinity;
      const pick = (j: number, sum: number, d: number) => {
        if (sum > N || d >= best) return;
        if (j === m) { if (sum === N) best = d; return; }
        for (const k of choices[j]) pick(j + 1, sum + k, Math.max(d, Math.abs(P[j] / k - s) / s));
      };
      pick(0, 0, 0);
      if (!Number.isFinite(best)) return;
      keys.push({ count: m, d: best, l: Math.max(...groups.map((g) => g.length)), canon: groups.map((g) => g.join(',')).sort().join('|') });
      return;
    }
    for (let g = 0; g <= m; g++) { label[i] = g; rec(i + 1, Math.max(m, g + 1)); }
  };
  rec(0, 0);
  keys.sort((a, b) => b.count - a.count || (Math.abs(a.d - b.d) > 1e-12 ? a.d - b.d : 0) || a.l - b.l);
  return keys;
}

const canonOf = (c: Clustering) => c.clusters.map((r) => r.counties.join(',')).sort().join('|');

describe('county graph', () => {
  it('sums block populations per county and links counties whose blocks touch', () => {
    const g = graphOf([10, 20, 30], [[0, 1], [1, 2]], 3);
    const cg = countyGraph(g);
    expect(cg.pop).toEqual([10, 20, 30]);
    expect(cg.neighbors).toEqual([[1], [0, 2], [1]]);
    expect(cg.blocks).toEqual([3, 3, 3]);
  });
});

describe('findCountyClusters: known answers', () => {
  it('a path that splits into one-district clusters', () => {
    // size 100: {0,1} {2} {3,4}
    const pops = [50, 52, 98, 40, 60];
    const req: ClusterRequest = { graph: graphOf(pops, path(5)), numDistricts: 3, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('ok');
    expect(res.exhaustive).toBe(true);
    expect(res.districtSize).toBeCloseTo(100);
    expect(canonOf(res.clusterings[0])).toBe('0,1|2|3,4');
    expect(res.clusterings[0].stats).toEqual({ clusterCount: 3, singleCounty: 1, maxAbsDeviationPct: 0.02, largestClusterCounties: 2 });
    expectValid(req, res.clusterings);
  });

  it('greedy trap: the smallest first clusters leave a remainder that cannot be closed', () => {
    // size 100, ±5% (95..105), path 0-1-2-3. Taking {0} and then {1} (both valid, smallest) leaves
    // {2,3} = 108, invalid, so a left-to-right greedy ends with 2 clusters ({0} and {1,2,3} = 204).
    // Best: {0} {1,2} = 100 {3} = 104.
    const pops = [96, 96, 4, 104];
    const edges = path(4);
    expect(naiveGreedy(pops, 3, 0.05)).toBe(2);
    const brute = bruteForce(pops, edges, 3, 0.05);
    expect(brute[0]).toMatchObject({ count: 3, canon: '0|1,2|3' });
    const req: ClusterRequest = { graph: graphOf(pops, edges), numDistricts: 3, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('ok');
    expect(res.exhaustive).toBe(true);
    expect(canonOf(res.clusterings[0])).toBe('0|1,2|3');
    expect(res.clusterings).toHaveLength(1);
    expectValid(req, res.clusterings);
  });

  it('a county too big for one district is a multi-district cluster on its own', () => {
    // size 100; county 0 holds 302 people = 3 districts (+0.67%).
    const pops = [302, 49, 49, 100];
    const req: ClusterRequest = { graph: graphOf(pops, path(4)), numDistricts: 5, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('ok');
    expect(res.exhaustive).toBe(true);
    const best = res.clusterings[0];
    expect(canonOf(best)).toBe('0|1,2|3');
    expect(best.clusters[0]).toMatchObject({ counties: [0], districts: 3, pop: 302 });
    expectValid(req, res.clusterings);
  });

  it('a county between whole numbers of districts joins its neighbours', () => {
    // size 100; county 0 = 150 (1.5 districts) must take 50 from a neighbour.
    const pops = [150, 50, 100, 100];
    const req: ClusterRequest = { graph: graphOf(pops, path(4)), numDistricts: 4, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('ok');
    expect(canonOf(res.clusterings[0])).toBe('0,1|2|3');
    expect(res.clusterings[0].clusters[0].districts).toBe(2);
    expectValid(req, res.clusterings);
  });

  it('the district counts must add up: 20 counties of 1.05 districts hold 21 districts', () => {
    // Each county alone is a valid one-district cluster (+5%), but 20 of them hold 21 districts, so
    // at least one cluster must hold an extra district: 10 counties as 11 districts (−4.5%).
    const C = 20;
    const pops = new Array(C).fill(1050);
    const req: ClusterRequest = { graph: graphOf(pops, path(C)), numDistricts: 21, tolerance: 0.051 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('ok');
    expect(res.exhaustive).toBe(true);
    const best = res.clusterings[0];
    expect(best.stats.clusterCount).toBe(11);
    expect(best.clusters.reduce((a, c) => a + c.districts, 0)).toBe(21);
    expect(best.clusters[0]).toMatchObject({ districts: 11 });
    expect(best.clusters[0].counties.length).toBe(10);
    expectValid(req, res.clusterings);
  });

  it('several alternatives with the same count, ranked by worst deviation', () => {
    // A 2x3 grid of equal counties, 3 districts: three ways to pair them up.
    const pops = [100, 100, 100, 100, 100, 100];
    const req: ClusterRequest = { graph: graphOf(pops, grid(3, 2)), numDistricts: 3, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('ok');
    expect(res.exhaustive).toBe(true);
    const brute = bruteForce(pops, grid(3, 2), 3, 0.05).filter((k) => k.count === 3);
    expect(res.clusterings.length).toBe(brute.length);
    expect(new Set(res.clusterings.map(canonOf))).toEqual(new Set(brute.map((b) => b.canon)));
    expect(new Set(res.clusterings.map((c) => c.id)).size).toBe(res.clusterings.length);
    expectValid(req, res.clusterings);
  });

  it('singletons stand alone', () => {
    // Without the rule the best is {0,1} {2,3}; with county 1 alone it is impossible.
    const pops = [50, 50, 50, 50];
    const base: ClusterRequest = { graph: graphOf(pops, path(4)), numDistricts: 2, tolerance: 0.05 };
    expect(findCountyClusters(base).clusterings[0].stats.clusterCount).toBe(2);
    const res = findCountyClusters({ ...base, singletons: [1] });
    expect(res.status).toBe('none');
    expect(res.message).toMatch(/must stand alone/);
    // A valid singleton: county 0 = 100 alone.
    const req2: ClusterRequest = { graph: graphOf([100, 50, 50], path(3)), numDistricts: 2, tolerance: 0.05, singletons: [0] };
    const r2 = findCountyClusters(req2);
    expect(canonOf(r2.clusterings[0])).toBe('0|1,2');
    expectValid(req2, r2.clusterings);
  });
});

describe('findCountyClusters: none, errors, edge cases', () => {
  it("'none' when no split exists, with the tolerance that would allow one", () => {
    // size 100: any split leaves one side at 70 or 130.
    const req: ClusterRequest = { graph: graphOf([70, 130], path(2)), numDistricts: 2, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('none');
    expect(res.exhaustive).toBe(true);
    expect(res.clusterings).toEqual([]);
    expect(res.message).toMatch(/No way to split/);
    // 103 / 97 splits at ±5% but not at ±2%: the message names ±5%.
    const req2: ClusterRequest = { graph: graphOf([103, 97], path(2)), numDistricts: 2, tolerance: 0.02 };
    const r2 = findCountyClusters(req2);
    expect(r2.status).toBe('none');
    expect(r2.message).toMatch(/±5%/);
  });

  it('one district, one county, bad input', () => {
    const g = graphOf([10, 20], path(2));
    expect(findCountyClusters({ graph: g, numDistricts: 1, tolerance: 0.05 }).status).toBe('none');
    expect(findCountyClusters({ graph: graphOf([500], []), numDistricts: 5, tolerance: 0.05 })).toMatchObject({ status: 'none', exhaustive: true });
    expect(findCountyClusters({ graph: g, numDistricts: 0, tolerance: 0.05 }).status).toBe('error');
    expect(findCountyClusters({ graph: g, numDistricts: 2, tolerance: 0 }).status).toBe('error');
  });

  it('separate groups of counties (islands) are clustered separately', () => {
    // Two islands of 200 and 100 people; size 100.
    const pops = [100, 100, 100];
    const req: ClusterRequest = { graph: graphOf(pops, [[0, 1]]), numDistricts: 3, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(res.status).toBe('ok');
    expect(canonOf(res.clusterings[0])).toBe('0|1|2');
    expectValid(req, res.clusterings);
    const bad = findCountyClusters({ graph: graphOf([150, 150], []), numDistricts: 3, tolerance: 0.05 });
    expect(bad.status).toBe('none');
    expect(bad.message).toMatch(/separate groups/);
  });

  it('counties made of several blocks', () => {
    const pops = [50, 52, 98, 40, 60];
    const req: ClusterRequest = { graph: graphOf(pops, path(5), 4), numDistricts: 3, tolerance: 0.05 };
    const res = findCountyClusters(req);
    expect(canonOf(res.clusterings[0])).toBe('0,1|2|3,4');
    expectValid(req, res.clusterings);
  });
});

describe('findCountyClusters: against brute force on random small maps', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const w = 3, h = 3;
      const edges = grid(w, h).filter(() => rand() < 0.8);
      // Keep the grid connected-ish: add a path back.
      for (const e of path(w * h)) if (!edges.some(([a, b]) => a === e[0] && b === e[1])) if (rand() < 0.3) edges.push(e);
      const N = 3 + Math.floor(rand() * 4);
      const pops = Array.from({ length: w * h }, () => 20 + Math.floor(rand() * 120));
      const t = [0.02, 0.05, 0.1][Math.floor(rand() * 3)];
      const brute = bruteForce(pops, edges, N, t);
      const req: ClusterRequest = { graph: graphOf(pops, edges), numDistricts: N, tolerance: t, maxResults: 4 };
      const res = findCountyClusters(req);
      expectValid(req, res.clusterings);
      expect(res.exhaustive).toBe(true);
      const top = brute[0];
      if (!top || top.count < 2) {
        expect(res.status).toBe('none');
        return;
      }
      expect(res.status).toBe('ok');
      const best = res.clusterings[0].stats;
      expect(best.clusterCount).toBe(top.count);
      expect(best.maxAbsDeviationPct).toBeCloseTo(top.d, 12);
      expect(best.largestClusterCounties).toBe(top.l);
      // The returned list is the top of the brute-force ranking (same keys, in order).
      const sameCount = brute.filter((k) => k.count === top.count);
      expect(res.clusterings.length).toBe(Math.min(4, sameCount.length));
      res.clusterings.forEach((c, i) => {
        expect(c.stats.maxAbsDeviationPct).toBeCloseTo(sameCount[i].d, 12);
        expect(sameCount.some((k) => k.canon === canonOf(c))).toBe(true);
      });
    });
  }
});

describe('findCountyClusters: the largest-cluster tie-break when another part sets the worst deviation', () => {
  // County 0 fixes the worst deviation; the rest has many groupings under it, and the one with the
  // smallest largest cluster ranks below others with a smaller deviation of their own. The exact
  // search used to keep only each part's top maxResults by its own (deviation, largest) and lost it.
  const keyOf = (c: Clustering) => `${c.stats.maxAbsDeviationPct.toFixed(12)}/${c.stats.largestClusterCounties}`;
  const bruteKeys = (pops: number[], edges: Array<[number, number]>, N: number, t: number, M: number) => {
    const all = bruteForce(pops, edges, N, t);
    return all.filter((k) => k.count === all[0].count).slice(0, M).map((k) => `${k.d.toFixed(12)}/${k.l}`);
  };

  it('a path of small counties beside an island (and linked to it)', () => {
    const pops = [952, 198, 198, 198, 198, 198, 10, 10, 5, 5, 4, 6, 1018];
    for (const linked of [false, true]) {
      const edges = path(13).slice(1);
      if (linked) edges.push([0, 1]);
      const req: ClusterRequest = { graph: graphOf(pops, edges), numDistricts: 3, tolerance: 0.05 };
      const res = findCountyClusters(req);
      expect(res.exhaustive).toBe(true);
      expectValid(req, res.clusterings);
      expect(canonOf(res.clusterings[0])).toBe('0|1,2,3,4,5,6|7,8,9,10,11,12');
      expect(res.clusterings[0].stats.largestClusterCounties).toBe(6);
    }
  });

  it('maxResults 1', () => {
    const pops = [955, 500, 510, 10, 1025];
    const edges: Array<[number, number]> = [[1, 2], [2, 3], [3, 4]];
    const req: ClusterRequest = { graph: graphOf(pops, edges), numDistricts: 3, tolerance: 0.05, maxResults: 1 };
    const res = findCountyClusters(req);
    expect(res.exhaustive).toBe(true);
    expect(res.clusterings.map(keyOf)).toEqual(bruteKeys(pops, edges, 3, 0.05, 1));
    expect(canonOf(res.clusterings[0])).toBe('0|1,2|3,4');
  });

  it('random paths with tiny counties, against brute force', () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed);
      const N = 3, s = 1000, t = 0.05;
      const C = 8 + Math.floor(rand() * 2);
      const pops = [s * (1 - 0.04 - rand() * 0.009)];
      for (let i = 1; i < C - 1; i++) pops.push(rand() < 0.6 ? 2 + Math.floor(rand() * 12) : 150 + Math.floor(rand() * 250));
      pops.push(0);
      pops[0] = Math.round(pops[0]);
      pops[C - 1] = N * s - pops.reduce((a, b) => a + b, 0);
      if (pops[C - 1] < 1) continue;
      const edges = path(C).slice(1);
      if (rand() < 0.5) edges.push([0, 1 + Math.floor(rand() * (C - 1))]);
      if (rand() < 0.5) { const a = 1 + Math.floor(rand() * (C - 3)); edges.push([a, a + 2]); }
      const M = rand() < 0.7 ? 1 : 2;
      const req: ClusterRequest = { graph: graphOf(pops, edges), numDistricts: N, tolerance: t, maxResults: M };
      const res = findCountyClusters(req);
      if (res.status !== 'ok') continue;
      expect(res.exhaustive).toBe(true);
      expect({ seed, keys: res.clusterings.map(keyOf) }).toEqual({ seed, keys: bruteKeys(pops, edges, N, t, M) });
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  }, 30000);
});

describe('findCountyClusters: time limit and determinism', () => {
  /** A 12x12 grid of small counties: far too many clusterings to search exhaustively at once. */
  function big(seed: number) {
    const rand = rng(seed);
    const pops = Array.from({ length: 144 }, () => 500 + Math.floor(rand() * 4000));
    return { graph: graphOf(pops, grid(12, 12)), pops };
  }

  it('respects the time limit and says when the result is not proven', () => {
    const { graph } = big(3);
    const req: ClusterRequest = { graph, numDistricts: 40, tolerance: 0.05, timeLimitMs: 400 };
    const t0 = performance.now();
    const res = findCountyClusters(req);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000); // 0.4 s limit; slack for a loaded machine
    expect(res.status).toBe('ok');
    expect(res.clusterings.length).toBeGreaterThan(0);
    // 144 counties, 40 districts: no proof in 0.4 s, and the result says so.
    expect(res.exhaustive).toBe(false);
    expect(res.message).toMatch(/not proven/);
    expect(res.clusterings[0].stats.clusterCount).toBeGreaterThanOrEqual(20);
    expectValid(req, res.clusterings);
  });

  it('cancels', () => {
    const { graph } = big(4);
    let calls = 0;
    const res = findCountyClusters({ graph, numDistricts: 40, tolerance: 0.05, timeLimitMs: 5000 }, { shouldStop: () => ++calls > 3 });
    expect(res.exhaustive).toBe(false);
    expect(res.elapsedMs).toBeLessThan(4000);
  });

  it('same input, same output', () => {
    const pops = [50, 52, 98, 40, 60, 77, 23, 100, 61, 39];
    const edges: Array<[number, number]> = [...path(10), [0, 4], [2, 7]];
    const req: ClusterRequest = { graph: graphOf(pops, edges), numDistricts: 6, tolerance: 0.1 };
    const a = findCountyClusters(req);
    const b = findCountyClusters(req);
    expect(a.clusterings).toEqual(b.clusterings);
    expect(a.status).toBe(b.status);
    // Also on an instance the exact search cannot finish (node-count based phases aside, the
    // time-limited result can differ only through the clock; the exhaustive result never does).
    const { graph } = big(5);
    const r1 = findCountyClusters({ graph, numDistricts: 12, tolerance: 0.05, timeLimitMs: 1500 });
    const r2 = findCountyClusters({ graph, numDistricts: 12, tolerance: 0.05, timeLimitMs: 1500 });
    if (r1.exhaustive && r2.exhaustive) expect(r1.clusterings).toEqual(r2.clusterings);
  }, 15000);
});

/** Smallest valid cluster at the lowest uncovered county of a path, left to right; 0 when stuck. */
function naiveGreedy(pops: number[], N: number, t: number): number {
  const s = pops.reduce((a, b) => a + b, 0) / N;
  const ok = (P: number) => { for (let k = 1; k <= N; k++) if (Math.abs(P / k - s) <= t * s) return true; return false; };
  let i = 0, count = 0;
  while (i < pops.length) {
    let P = 0, j = i;
    while (j < pops.length && !ok(P + pops[j])) P += pops[j++];
    if (j === pops.length) return count; // remainder cannot be closed: counts as merged into the last
    P += pops[j];
    i = j + 1;
    count++;
  }
  return count;
}
