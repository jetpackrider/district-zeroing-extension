import type { Assignment, EngineGraph, PopTargets } from '@zd/contracts';
import { computeTargets } from '@zd/contracts';

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  seed: number;
  width: number;
  height: number;
  numDistricts: number;
  /** Precinct tile side in blocks. */
  precinctSize?: number;
  /** County tile side in blocks. */
  countySize?: number;
  /** Share of blocks with zero population (water, parks...). */
  zeroFrac?: number;
  /** Mean population of a populated block (exponential, so many small blocks). */
  meanPop?: number;
  /** 'bisect': recursive population bisection at precinct level. 'strips': vertical strips of precinct columns. */
  layout?: 'bisect' | 'strips';
  /** Random skew of each bisection ratio (0 = balanced at precinct level). Use ~0.25 for unfinished maps. */
  skew?: number;
}

export interface SynthMap {
  graph: EngineGraph;
  assignment: Assignment;
  targets: PopTargets;
  width: number;
  height: number;
}

/** Rook-adjacent grid; blocks are 100 m squares. */
export function generateMap(opts: SynthOptions): SynthMap {
  const { width: W, height: H, numDistricts: k } = opts;
  const ps = opts.precinctSize ?? 3;
  const cs = opts.countySize ?? 15;
  const zeroFrac = opts.zeroFrac ?? 0.3;
  const meanPop = opts.meanPop ?? 12;
  const rand = rng(opts.seed);
  const n = W * H;
  const pop = new Int32Array(n);
  for (let i = 0; i < n; i++) pop[i] = rand() < zeroFrac ? 0 : 1 + Math.floor(-Math.log(1 - rand()) * meanPop);
  const pw = Math.ceil(W / ps);
  const ph = Math.ceil(H / ps);
  const cw = Math.ceil(W / cs);
  const precinctOf = new Uint32Array(n);
  const countyOf = new Uint16Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      precinctOf[i] = Math.floor(y / ps) * pw + Math.floor(x / ps);
      countyOf[i] = Math.floor(y / cs) * cw + Math.floor(x / cs);
    }
  }
  const adjOffsets = new Uint32Array(n + 1);
  const targetsList: number[] = [];
  const outerLen = new Uint32Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const nb: number[] = [];
      if (y > 0) nb.push(i - W);
      if (x > 0) nb.push(i - 1);
      if (x < W - 1) nb.push(i + 1);
      if (y < H - 1) nb.push(i + W);
      targetsList.push(...nb);
      adjOffsets[i + 1] = targetsList.length;
      outerLen[i] = (4 - nb.length) * 100;
    }
  }
  const adjTargets = Uint32Array.from(targetsList);
  const adjLen = new Uint16Array(adjTargets.length).fill(100);
  const areaM2 = new Float32Array(n).fill(10000);
  const graph: EngineGraph = { n, pop, countyOf, precinctOf, adjOffsets, adjTargets, adjLen, outerLen, areaM2 };

  // District layout at precinct granularity.
  const precinctPop = new Float64Array(pw * ph);
  for (let i = 0; i < n; i++) precinctPop[precinctOf[i]] += pop[i];
  const precinctDistrict = new Uint16Array(pw * ph);
  const cells: Array<[number, number]> = [];
  for (let py = 0; py < ph; py++) for (let px = 0; px < pw; px++) cells.push([px, py]);
  if ((opts.layout ?? 'bisect') === 'strips') {
    for (const [px, py] of cells) precinctDistrict[py * pw + px] = Math.min(k, 1 + Math.floor((px * k) / pw));
  } else {
    const skew = opts.skew ?? 0;
    const split = (list: Array<[number, number]>, count: number, first: number) => {
      if (count === 1) {
        for (const [px, py] of list) precinctDistrict[py * pw + px] = first;
        return;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [px, py] of list) {
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      const byX = maxX - minX >= maxY - minY;
      const sorted = [...list].sort((a, b) => (byX ? a[0] - b[0] || a[1] - b[1] : a[1] - b[1] || a[0] - b[0]));
      const kA = Math.floor(count / 2);
      let ratio = kA / count;
      if (skew) ratio *= 1 + (rand() * 2 - 1) * skew;
      let total = 0;
      for (const [px, py] of sorted) total += precinctPop[py * pw + px];
      let acc = 0;
      let cut = 0;
      while (cut < sorted.length - 1 && acc + precinctPop[sorted[cut][1] * pw + sorted[cut][0]] / 2 < total * ratio) {
        acc += precinctPop[sorted[cut][1] * pw + sorted[cut][0]];
        cut++;
      }
      cut = Math.max(1, Math.min(sorted.length - 1, cut));
      split(sorted.slice(0, cut), kA, first);
      split(sorted.slice(cut), count - kA, first + kA);
    };
    split(cells, k, 1);
  }
  const assignment = new Uint16Array(n);
  for (let i = 0; i < n; i++) assignment[i] = precinctDistrict[precinctOf[i]];
  let totalPop = 0;
  for (let i = 0; i < n; i++) totalPop += pop[i];
  return { graph, assignment, targets: computeTargets(totalPop, k), width: W, height: H };
}

/**
 * Rewrites block populations so district d holds exactly Q + devs[d - 1], where Q is the
 * current mean district population (floored). sum(devs) must be in [0, k) so that
 * q = Q and remainder = sum(devs).
 */
export function setDeviations(map: SynthMap, devs: number[]): SynthMap {
  const k = map.targets.numDistricts;
  if (devs.length !== k) throw new Error('devs length');
  const R = devs.reduce((s, x) => s + x, 0);
  if (R < 0 || R >= k) throw new Error(`sum(devs) must be in [0, ${k}), got ${R}`);
  const pop = map.graph.pop.slice();
  const cur = new Array<number>(k + 1).fill(0);
  for (let i = 0; i < map.graph.n; i++) cur[map.assignment[i]] += pop[i];
  const Q = Math.floor(cur.slice(1).reduce((s, x) => s + x, 0) / k);
  for (let d = 1; d <= k; d++) {
    let delta = Q + devs[d - 1] - cur[d];
    const blocks: number[] = [];
    for (let i = 0; i < map.graph.n; i++) if (map.assignment[i] === d && pop[i] > 0) blocks.push(i);
    let guard = 0;
    while (delta !== 0) {
      let progressed = false;
      for (const b of blocks) {
        if (delta === 0) break;
        if (delta > 0) { pop[b]++; delta--; progressed = true; }
        else if (pop[b] > 1) { pop[b]--; delta++; progressed = true; }
      }
      if (!progressed || ++guard > 1e6) throw new Error(`cannot set district ${d}`);
    }
  }
  const graph = { ...map.graph, pop };
  let totalPop = 0;
  for (let i = 0; i < graph.n; i++) totalPop += pop[i];
  const targets = computeTargets(totalPop, k);
  if (targets.q !== Q || targets.remainder !== R) throw new Error('setDeviations: unexpected targets');
  return { ...map, graph, targets };
}

/** Pieces per district, by plain BFS (test-side, separate from both planner and verifier). */
export function piecesPerDistrict(graph: EngineGraph, a: Assignment, k: number): number[] {
  const seen = new Uint8Array(graph.n);
  const count = new Array<number>(k + 1).fill(0);
  for (let s = 0; s < graph.n; s++) {
    if (seen[s] || a[s] === 0) continue;
    count[a[s]]++;
    const q = [s];
    seen[s] = 1;
    while (q.length) {
      const u = q.pop()!;
      for (let e = graph.adjOffsets[u]; e < graph.adjOffsets[u + 1]; e++) {
        const v = graph.adjTargets[e];
        if (!seen[v] && a[v] === a[u]) { seen[v] = 1; q.push(v); }
      }
    }
  }
  return count;
}

export function popsOf(graph: EngineGraph, a: Assignment, k: number): number[] {
  const p = new Array<number>(k + 1).fill(0);
  for (let i = 0; i < graph.n; i++) p[a[i]] += graph.pop[i];
  return p;
}

export function applyTransfers(a: Assignment, transfers: Array<{ to: number; blocks: Uint32Array }>): Assignment {
  const out = a.slice();
  for (const t of transfers) for (const b of t.blocks) out[b] = t.to;
  return out;
}
