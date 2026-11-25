/**
 * County clusters (see packages/contracts/src/clusters.ts): split a state into groups of whole,
 * contiguous counties, each holding close to a whole number of districts' worth of people.
 *
 * The problem is the county-clustering problem of Carter, Hunter, Teague, Herschlag & Mattingly,
 * "Optimal Legislative County Clustering in North Carolina" (2020): a partition of the county
 * graph into connected clusters, each of k ≥ 1 districts with |P / k − size| ≤ tolerance · size,
 * the k summing to the number of districts, with as many clusters as possible.
 *
 * County adjacency. Two counties touch when any of their blocks are adjacent in the bundle's
 * block graph, which includes water-only blocks, DRA's hand-made links and nearest-block bridges.
 * Census counties extend into rivers, sounds and lakes, so counties across a river or a sound
 * (Davidson and Davie across the Yadkin, Hyde and Pamlico across Pamlico Sound) share a real
 * county boundary drawn through water: they count as adjacent, as under North Carolina's rule
 * (shared county boundary) and as in DRA (water is contiguous). Dropping water would drop river
 * boundaries too (18 of North Carolina's 244 county pairs), which is wrong. The zero-length links
 * only add county pairs where a county would otherwise be cut off (Hawaii's islands), and DRA
 * treats them as contiguous, so they count as well. Corner-only contacts are not links.
 *
 * District counts. A cluster has a range of valid k (several when it is large: at ±5% every
 * population above ~9.5 districts is valid). The sum of k is NOT automatic: 20 counties of 1.05
 * districts each are 20 valid one-district clusters but hold 21 districts. So the search carries
 * the number of districts K a set of counties must hold, and every k is chosen inside it.
 *
 * Search.
 *  1. Weights: each county v gets y(v) ≥ 0 with Σ_{v∈C} y(v) ≥ 1 for every valid cluster C (a
 *     feasible solution of the dual of the cluster-packing LP): first from lower bounds on the
 *     size and population of any valid cluster containing v, then lowered by coordinate descent
 *     (each county drops by the slack of its lightest valid cluster, found by exact pruned
 *     enumeration). floor(Σ_{v∈U} y(v)) bounds the clusters of any county set U, and only drops as
 *     counties leave U.
 *  2. Exact search solve(U, K, need): the best clusterings (most clusters, then smallest worst
 *     deviation, then smallest largest cluster) of a connected county set U holding K districts,
 *     or the proof that none has `need` clusters. It picks the county of U with the fewest
 *     neighbours in U, enumerates each connected valid set S containing it exactly once (pruning
 *     a branch as soon as 1 + floor(y(U \ S)) < need, which then holds for every superset), needs
 *     each connected piece of U \ S to have a valid population (a piece is a union of clusters, and
 *     a union of adjacent valid clusters is valid), tries each k of S and each split of the
 *     remaining districts over the pieces, and solves the pieces independently. Results are
 *     memoized by (county set, K). Each keeps every clustering that fewer than maxResults others
 *     match or beat on both worst deviation and largest cluster (not just its own top maxResults:
 *     once another piece sets the worst deviation, a lower-ranked one with a smaller largest
 *     cluster can win).
 *  3. When that does not finish in time: randomized greedy peeling (a small valid cluster at the
 *     edge of what is left, keeping every leftover piece valid), then large-neighbourhood search
 *     (re-solve a cluster with its neighbours exactly, or rebuild it greedily, keeping any
 *     improvement), then the exact search again with the incumbent as the bar. `exhaustive` is
 *     true only when an exact search over the whole state finished.
 *
 * Alternatives: up to maxResults clusterings with the most clusters, ranked by worst deviation
 * then largest cluster, one per county grouping (its best district counts). Clusterings with fewer
 * clusters are not listed: merging two adjacent clusters of any clustering gives another valid one,
 * so they are many and dominated.
 *
 * 'none': no clustering with two or more clusters exists (the whole state as one cluster always
 * works and is not worth showing), or a singleton county is invalid on its own, or a separate
 * part of the state (an island group) has an invalid population. The message then names the
 * tightest tolerance among 0.5, 1, 2, 5, 10% that allows a split, when a short search finds one.
 */
import type { ClusterRequest, ClusterResult, Clustering, CountyCluster, EngineGraph } from '@zd/contracts';
import { fnv } from './hash';
import { now } from './weights';

/** Contiguity and populations of the counties of a block graph. */
export interface CountyGraph {
  /** Number of county indexes (max countyOf + 1). */
  count: number;
  pop: number[];
  /** Sorted neighbouring counties. */
  neighbors: number[][];
  /** Number of blocks per county (0 = index unused). */
  blocks: number[];
}

/** County populations and adjacency from the block graph (see the module note on water). */
export function countyGraph(graph: EngineGraph): CountyGraph {
  let count = 0;
  for (let i = 0; i < graph.n; i++) if (graph.countyOf[i] + 1 > count) count = graph.countyOf[i] + 1;
  const pop = new Array<number>(count).fill(0);
  const blocks = new Array<number>(count).fill(0);
  const sets = Array.from({ length: count }, () => new Set<number>());
  for (let i = 0; i < graph.n; i++) {
    const a = graph.countyOf[i];
    pop[a] += graph.pop[i];
    blocks[a]++;
    for (let e = graph.adjOffsets[i]; e < graph.adjOffsets[i + 1]; e++) {
      const b = graph.countyOf[graph.adjTargets[e]];
      if (b !== a) { sets[a].add(b); sets[b].add(a); }
    }
  }
  return { count, pop, blocks, neighbors: sets.map((s) => [...s].sort((x, y) => x - y)) };
}

export interface ClusterSearchOptions {
  /** Polled during the search; return true to stop early (cancel). */
  shouldStop?: () => boolean;
  /** Seed of the greedy phase's random tie-breaks. Default 1. */
  seed?: number;
  /** Progress notes (phase results, search nodes), for scripts. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Internals

interface Cand {
  counties: number[];
  pop: number;
  kmin: number;
  kmax: number;
  /** Best |deviation| / size over the valid k. */
  d: number;
  /** Hash of the county set (for telling groupings apart). */
  h: number;
}

/** A cluster with its district count. */
interface Pick {
  c: Cand;
  k: number;
  d: number;
}

interface Sol {
  count: number;
  d: number;
  l: number;
  /** Order-free hash of the grouping (county sets only). */
  h: number;
  picks: Pick[];
}

/** Exact result, or the proof that every clustering has fewer than `below` clusters (below 1 = none at all). */
type Entry = { count: number; list: Sol[] } | { below: number };

class Stop extends Error {
  constructor(readonly reason: 'time' | 'budget' | 'cancel') { super(reason); }
}

const EPS = 1e-9;
/** Memo entries kept before the memo is dropped (bounds memory in long searches). */
const MEMO_MAX = 100_000;

interface Key { count: number; d: number; l: number }

function better(a: Key, b: Key): boolean {
  if (a.count !== b.count) return a.count > b.count;
  if (Math.abs(a.d - b.d) > 1e-12) return a.d < b.d;
  return a.l < b.l;
}

function cmpKey(a: Key, b: Key): number {
  if (a.count !== b.count) return b.count - a.count;
  if (Math.abs(a.d - b.d) > 1e-12) return a.d - b.d;
  return a.l - b.l;
}

class Ctx {
  readonly C: number;
  readonly W: number;
  readonly pop: number[];
  readonly nbr: number[][];
  readonly used: Uint8Array;
  y: number[];
  /**
   * Weight of the district-count row: Σ_{v∈C} y(v) + lam · kmin(C) ≥ 1 for every valid cluster C,
   * so a set of counties holding K districts has at most Σ y + lam · K clusters.
   */
  lam = 0;
  readonly single: Uint8Array;
  readonly memo = new Map<string, Entry>();
  private readonly cands = new Map<string, Cand>();
  readonly blocked: Uint8Array;
  readonly mark: Uint8Array;
  private readonly seen: Uint8Array;
  nodes = 0;
  nodeLimit = Infinity;
  deadline = Infinity;
  /** Set when a heuristic phase was cut short by the clock or a cancel. */
  stopped: Stop['reason'] | null = null;

  constructor(
    cg: CountyGraph,
    readonly s: number,
    readonly t: number,
    readonly N: number,
    readonly M: number,
    singles: number[],
    private readonly shouldStop?: () => boolean,
  ) {
    this.C = cg.count;
    this.W = Math.max(1, Math.ceil(cg.count / 32));
    this.pop = cg.pop;
    this.nbr = cg.neighbors;
    this.used = new Uint8Array(cg.count);
    for (let c = 0; c < cg.count; c++) this.used[c] = cg.blocks[c] > 0 ? 1 : 0;
    this.single = new Uint8Array(cg.count);
    for (const c of singles) if (c >= 0 && c < cg.count) this.single[c] = 1;
    this.blocked = new Uint8Array(cg.count);
    this.mark = new Uint8Array(cg.count);
    this.seen = new Uint8Array(cg.count);
    this.y = this.weights();
  }

  tick(): void {
    this.nodes++;
    if (this.nodes > this.nodeLimit) throw new Stop('budget');
    if ((this.nodes & 63) === 0) {
      if (now() > this.deadline) throw new Stop('time');
      if (this.shouldStop?.()) throw new Stop('cancel');
    }
  }

  okK(P: number, k: number): boolean {
    return k >= 1 && Math.abs(P / k - this.s) <= this.t * this.s * (1 + 1e-12) + 1e-7;
  }

  /** Valid district counts for population P (also the possible district totals of any clustering of P people), or null. */
  kRange(P: number): [number, number] | null {
    if (P <= 0) return null;
    let kmin = Math.max(1, Math.floor(P / (this.s * (1 + this.t))));
    let kmax = Math.ceil(P / (this.s * (1 - this.t)));
    while (kmin <= kmax && !this.okK(P, kmin)) kmin++;
    while (kmax >= kmin && !this.okK(P, kmax)) kmax--;
    return kmin <= kmax ? [kmin, kmax] : null;
  }

  valid(P: number): boolean { return this.kRange(P) !== null; }

  /** Smallest valid population ≥ P. */
  nextValid(P: number): number {
    if (this.valid(P)) return P;
    const lo = this.s * (1 - this.t);
    let k = Math.max(1, Math.ceil(P / lo));
    while (!this.okK(k * lo + 1e-6, k)) k++;
    return Math.max(P, k * lo);
  }

  devOf(P: number, k: number): number { return Math.abs(P / k - this.s) / this.s; }

  cand(counties: number[], P?: number): Cand {
    const sorted = counties.slice().sort((a, b) => a - b);
    const key = sorted.join(',');
    const hit = this.cands.get(key);
    if (hit) return hit;
    const pop = P ?? sorted.reduce((a, c) => a + this.pop[c], 0);
    const r = this.kRange(pop);
    if (!r) throw new Error('internal: invalid cluster');
    let d = Infinity;
    for (let k = r[0]; k <= r[1]; k++) d = Math.min(d, this.devOf(pop, k));
    const c: Cand = { counties: sorted, pop, kmin: r[0], kmax: r[1], d, h: parseInt(fnv(key), 36) >>> 0 };
    this.cands.set(key, c);
    return c;
  }

  /** Initial weights from lower bounds on the size and population of a valid cluster containing each county. */
  private weights(): number[] {
    const y = new Array<number>(this.C).fill(0);
    const lo = this.s * (1 - this.t);
    const dist = new Int32Array(this.C);
    for (let v = 0; v < this.C; v++) {
      if (!this.used[v]) continue;
      const m0 = this.nextValid(this.pop[v]);
      const popW = this.pop[v] > 0 ? this.pop[v] / m0 : 0;
      let sizeLB = 1;
      if (!this.single[v] && !this.valid(this.pop[v])) {
        // j counties within distance j − 1 of v must be able to reach m0.
        dist.fill(-1);
        dist[v] = 0;
        const order = [v];
        for (let h = 0; h < order.length; h++) {
          const u = order[h];
          for (const w of this.nbr[u]) if (dist[w] < 0 && this.used[w] && !this.single[w]) { dist[w] = dist[u] + 1; order.push(w); }
        }
        const need = Math.max(m0, lo);
        sizeLB = order.length + 1;
        for (let j = 2; j <= order.length; j++) {
          const pops = order.filter((u) => u !== v && dist[u] <= j - 1).map((u) => this.pop[u]).sort((a, b) => b - a);
          let P = this.pop[v];
          for (let i = 0; i < Math.min(j - 1, pops.length); i++) P += pops[i];
          if (P >= need - 1e-6) { sizeLB = j; break; }
        }
      }
      y[v] = Math.max(popW, 1 / sizeLB);
    }
    return y;
  }

  /**
   * Lowers the weights while keeping Σ_{v∈C} y(v) ≥ 1 for every valid cluster C: in the given
   * order, each county drops by the slack of its lightest valid cluster, found by enumeration
   * pruned at the current lightest (weights are ≥ 0, so the prune is exact). A county whose
   * enumeration exceeds `perCounty` nodes keeps its weight.
   */
  tighten(y: number[], order: number[], perCounty: number, until: number, lam: number): void {
    const { nbr, pop, single, used, blocked } = this;
    for (let pass = 0; pass < 3; pass++) {
      let moved = 0;
      for (const v of order) {
        if (now() > until || this.shouldStop?.()) return;
        if (y[v] <= 0) continue;
        let best = Infinity;
        let nodes = 0;
        let over = false;
        let P = pop[v], Y = y[v];
        blocked[v] = 1;
        const X0: number[] = [];
        if (!single[v]) for (const w of nbr[v]) if (used[w] && !single[w] && !blocked[w]) { blocked[w] = 1; X0.push(w); }
        const rec = (X: number[]): void => {
          if (++nodes > perCounty) { over = true; return; }
          if (Y + lam * this.kappa(P) < best) {
            const r = this.kRange(P);
            if (r && Y + lam * r[0] < best) best = Y + lam * r[0];
          }
          for (let i = 0; i < X.length && !over; i++) {
            const u = X[i];
            if (Y + y[u] + lam * this.kappa(P + pop[u]) >= best) continue;
            const added: number[] = [];
            for (const w of nbr[u]) if (used[w] && !single[w] && !blocked[w]) { blocked[w] = 1; added.push(w); }
            P += pop[u]; Y += y[u];
            rec(added.length ? X.slice(i + 1).concat(added) : X.slice(i + 1));
            P -= pop[u]; Y -= y[u];
            for (const w of added) blocked[w] = 0;
          }
        };
        rec(X0);
        blocked[v] = 0;
        for (const w of X0) blocked[w] = 0;
        if (over || !Number.isFinite(best)) continue;
        const slack = best - 1;
        if (slack > 1e-7) { y[v] = Math.max(0, y[v] - slack + 1e-9); moved++; }
      }
      if (!moved) return;
    }
  }

  /** Several descent orders and λ; keeps the weights with the smallest whole-state bound. */
  tightenBest(until: number, rand: () => number): void {
    const counties = [...Array(this.C).keys()].filter((c) => this.used[c]);
    const base = this.y.slice();
    const orders = [
      counties.slice().sort((a, b) => base[b] - base[a] || a - b),
      counties.slice().sort((a, b) => this.pop[a] - this.pop[b] || a - b),
      counties.slice().sort((a, b) => this.pop[b] - this.pop[a] || a - b),
    ];
    for (let i = 0; i < 3; i++) orders.push(counties.map((c) => ({ c, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.c));
    let bestY = base;
    let bestLam = 0;
    let bestSum = counties.reduce((a, c) => a + base[c], 0);
    for (const lam of [0, 0.02, 0.05, 0.1]) {
      for (const order of orders) {
        if (now() > until) break;
        const y = base.slice();
        this.tighten(y, order, 20000, until, lam);
        const sum = counties.reduce((a, c) => a + y[c], 0) + lam * this.N;
        if (sum < bestSum - 1e-9) { bestSum = sum; bestY = y; bestLam = lam; }
      }
    }
    this.y = bestY;
    this.lam = bestLam;
  }

  /** A lower bound on k for any valid cluster of ≥ P people; non-decreasing in P. */
  kappa(P: number): number { return Math.max(1, Math.ceil(P / (this.s * (1 + this.t)) - 1e-9)); }

  bitsKey(members: number[]): string {
    const b = new Uint32Array(this.W);
    for (const c of members) b[c >>> 5] |= 1 << (c & 31);
    return b.join(',');
  }

  /** Connected pieces of `members`, using mark[] (set by the caller) as membership. */
  components(members: number[]): number[][] {
    const out: number[][] = [];
    const seen = this.seen;
    for (const c of members) {
      if (seen[c]) continue;
      const comp = [c];
      seen[c] = 1;
      for (let h = 0; h < comp.length; h++) {
        for (const w of this.nbr[comp[h]]) if (this.mark[w] && !seen[w]) { seen[w] = 1; comp.push(w); }
      }
      out.push(comp);
    }
    for (const c of members) seen[c] = 0;
    return out;
  }

  /** Pieces of members \ S (no validity check). */
  restOf(members: number[], S: number[]): number[][] {
    for (const c of members) this.mark[c] = 1;
    for (const c of S) this.mark[c] = 0;
    const rest = this.components(members.filter((c) => this.mark[c]));
    for (const c of members) this.mark[c] = 0;
    return rest;
  }

  popSum(m: number[]): number { let p = 0; for (const c of m) p += this.pop[c]; return p; }
  ySum(m: number[]): number { let p = 0; for (const c of m) p += this.y[c]; return p; }
  /** Most clusters `m` can be split into when it holds K districts. */
  ub(m: number[], K: number): number { return Math.min(K, Math.floor(this.ySum(m) + this.lam * K + EPS)); }
}

// --- exact search

/**
 * The Sols of `sorted` (best first by cmpKey, one count) that can still be in a top M once combined
 * with other parts: those matched or beaten on both worst deviation and largest cluster by fewer than
 * M others. A combination's key is the max of its parts' d and the max of their l, so a Sol with M
 * such others is never needed (each of them swapped in gives a combination at least as good), while
 * the top M by (d, l) alone is not enough: when another part fixes the worst deviation, the Sol with
 * the smallest l among those under it decides, and it can sit below M others with a smaller d.
 */
function frontier(sorted: Sol[], M: number): Sol[] {
  const out: Sol[] = [];
  for (const s of sorted) {
    // Everything kept so far has d ≤ s.d. Counting only the kept ones is enough: a dropped Sol that
    // beats s had M kept ones beating it, which beat s too.
    let beaten = 0;
    for (const o of out) if (o.l <= s.l && ++beaten >= M) break;
    if (beaten < M) out.push(s);
  }
  return out;
}

/**
 * The frontier (see frontier) of the combinations of `head` with one solution from each list (lists
 * sorted best first, each a frontier, one count per list).
 */
function combine(head: Pick | null, lists: Sol[][], M: number): Sol[] {
  const make = (idx: number[]): Sol => {
    let count = head ? 1 : 0, d = head ? head.d : 0, l = head ? head.c.counties.length : 0;
    let h = head ? head.c.h : 0;
    const picks: Pick[] = head ? [head] : [];
    for (let i = 0; i < lists.length; i++) {
      const s = lists[i][idx[i]];
      count += s.count;
      if (s.d > d) d = s.d;
      if (s.l > l) l = s.l;
      h = (h + s.h) >>> 0;
      for (const p of s.picks) picks.push(p);
    }
    return { count, d, l, h, picks };
  };
  if (lists.length === 0) return [make([])];
  if (lists.every((l) => l.length === 1)) return [make(lists.map(() => 0))];
  // The combined key is not monotone in a list index (a later entry has a larger d but can have a
  // smaller l), but its worst deviation is. So for each cap L on the largest cluster: best first by
  // worst deviation over the entries with l ≤ L, M of them. A combination on the frontier, with
  // L its largest cluster, has fewer than M others at least as good under cap L, so that pass finds it.
  const l0 = head ? head.c.counties.length : 0;
  let minCap = l0;
  const caps = new Set<number>([l0]);
  for (const list of lists) {
    let m = Infinity;
    for (const s of list) { caps.add(s.l); if (s.l < m) m = s.l; }
    if (m > minCap) minCap = m;
  }
  const found = new Map<string, Sol>();
  for (const L of [...caps].filter((x) => x >= minCap).sort((a, b) => a - b)) {
    // Positions (into lists[i]) of the entries under the cap, still best first.
    const sub = lists.map((list) => { const ix: number[] = []; list.forEach((s, j) => { if (s.l <= L) ix.push(j); }); return ix; });
    const at = (pos: number[]) => pos.map((p, i) => sub[i][p]);
    const start = sub.map(() => 0);
    const heap: Array<{ pos: number[]; sol: Sol }> = [{ pos: start, sol: make(at(start)) }];
    const seen = new Set<string>([start.join(',')]);
    for (let n = 0; heap.length && n < M; n++) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (cmpKey(heap[i].sol, heap[bi].sol) < 0) bi = i;
      const top = heap.splice(bi, 1)[0];
      const id = at(top.pos).join(',');
      if (!found.has(id)) found.set(id, top.sol);
      for (let i = 0; i < sub.length; i++) {
        if (top.pos[i] + 1 >= sub[i].length) continue;
        const pos = top.pos.slice();
        pos[i]++;
        const key = pos.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        heap.push({ pos, sol: make(at(pos)) });
      }
    }
  }
  return frontier([...found.values()].sort(cmpKey), M);
}

/** The frontier (see frontier) of two lists, one entry per grouping (the better district counts). Stable. */
function mergeTop(a: Sol[], b: Sol[], M: number): Sol[] {
  const all = a.concat(b).map((s, i) => ({ s, i })).sort((x, y) => cmpKey(x.s, y.s) || x.i - y.i);
  const out: Sol[] = [];
  const seen = new Set<number>();
  for (const { s } of all) {
    if (seen.has(s.h)) continue;
    seen.add(s.h);
    out.push(s);
  }
  return frontier(out, M);
}

/** Every vector x with lo[i] ≤ x[i] ≤ hi[i] and Σx = total, in lexicographic order. */
function splits(lo: number[], hi: number[], total: number, visit: (x: number[]) => void): void {
  const n = lo.length;
  const x = new Array<number>(n).fill(0);
  const minRest = new Array<number>(n + 1).fill(0);
  const maxRest = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) { minRest[i] = minRest[i + 1] + lo[i]; maxRest[i] = maxRest[i + 1] + hi[i]; }
  const rec = (i: number, left: number): void => {
    if (i === n) { if (left === 0) visit(x.slice()); return; }
    for (let v = Math.max(lo[i], left - maxRest[i + 1]); v <= Math.min(hi[i], left - minRest[i + 1]); v++) {
      x[i] = v;
      rec(i + 1, left - v);
    }
  };
  rec(0, total);
}

/**
 * Exact: the best clusterings of the connected county set `members` holding K districts, if one
 * has ≥ need clusters; else { below } (proved: every clustering of it has fewer than `below`).
 */
function solve(ctx: Ctx, members: number[], K: number, need: number): Entry {
  const key = ctx.bitsKey(members) + '|' + K;
  const hit = ctx.memo.get(key);
  if (hit) {
    if ('list' in hit) return hit.count >= need ? hit : { below: need };
    if (hit.below <= need) return hit;
  }
  const res = solveFresh(ctx, members, K, need);
  if (ctx.memo.size > MEMO_MAX) ctx.memo.clear();
  if ('list' in res || !hit || ('below' in hit && res.below < hit.below)) ctx.memo.set(key, res);
  return res;
}

function solveFresh(ctx: Ctx, members: number[], K: number, need: number): Entry {
  const PU = ctx.popSum(members);
  const RU = ctx.kRange(PU);
  if (!RU || K < RU[0] || K > RU[1]) return { below: 1 };
  if (members.length === 1) {
    const c = ctx.cand(members, PU);
    const pick: Pick = { c, k: K, d: ctx.devOf(PU, K) };
    return need <= 1 ? { count: 1, list: [{ count: 1, d: pick.d, l: 1, h: c.h, picks: [pick] }] } : { below: need };
  }
  const Ytot = ctx.ySum(members);
  const lam = ctx.lam;
  if (Math.min(K, Math.floor(Ytot + lam * K + EPS)) < need) return { below: need };
  const { mark, blocked, nbr, pop, y, single } = ctx;
  for (const c of members) mark[c] = 1;
  // Pivot: a singleton county first, else fewest neighbours inside, then smallest index.
  let v = members[0], vdeg = Infinity;
  for (const c of members) {
    let deg = 0;
    for (const w of nbr[c]) if (mark[w]) deg++;
    if (single[c]) deg = -1;
    if (deg < vdeg || (deg === vdeg && c < v)) { v = c; vdeg = deg; }
  }
  let best = need;
  // Options keep only S (the leftover pieces are recomputed when used: storing them for every
  // option of a big region costs hundreds of MB).
  // All option county lists live in one flat array (millions of small arrays stall the GC).
  interface Option { off: number; len: number; P: number; bound: number }
  const options: Option[] = [];
  const flat: number[] = [];
  let P = pop[v], Y = y[v];
  const S: number[] = [v];
  blocked[v] = 1;
  const X0: number[] = [];
  if (!single[v]) for (const w of nbr[v]) if (mark[w] && !blocked[w]) { blocked[w] = 1; X0.push(w); }
  /** Leftover pieces of `members` \ S with their district ranges and bounds; null when one is invalid. */
  const piecesOf = (rest: number[][]) => {
    const lo: number[] = [], hi: number[] = [], ubs: number[] = [];
    for (const r of rest) {
      const rr = ctx.kRange(ctx.popSum(r));
      if (!rr) return null;
      lo.push(rr[0]); hi.push(rr[1]); ubs.push(ctx.ub(r, rr[1]));
    }
    return { rest, lo, hi, ubs };
  };
  /** S as an option, when every leftover piece is valid and the bound allows it. */
  const report = (): void => {
    const kminS = ctx.kRange(P)![0];
    const quick = 1 + Math.min(K - kminS, Math.floor(Ytot - Y + lam * (K - kminS) + EPS));
    if (quick < best) return;
    for (const c of S) mark[c] = 0;
    const pc = piecesOf(ctx.components(members.filter((c) => mark[c])));
    for (const c of S) mark[c] = 1;
    if (!pc) return;
    const bound = Math.min(quick, 1 + pc.ubs.reduce((a, b) => a + b, 0));
    if (bound >= best) {
      options.push({ off: flat.length, len: S.length, P, bound });
      for (const c of S) flat.push(c);
    }
  };
  const rec = (X: number[]): void => {
    ctx.tick();
    if (ctx.valid(P)) report();
    for (let i = 0; i < X.length; i++) {
      const u = X[i];
      if (single[u]) continue;
      const Y2 = Y + y[u];
      const kLeft = K - ctx.kappa(P + pop[u]);
      if (1 + Math.min(kLeft, Math.floor(Ytot - Y2 + lam * kLeft + EPS)) < best) continue;
      const added: number[] = [];
      for (const w of nbr[u]) if (mark[w] && !blocked[w]) { blocked[w] = 1; added.push(w); }
      S.push(u); P += pop[u]; Y = Y2;
      rec(added.length ? X.slice(i + 1).concat(added) : X.slice(i + 1));
      S.pop(); P -= pop[u]; Y -= y[u];
      for (const w of added) blocked[w] = 0;
    }
  };
  try {
    rec(X0);
  } finally {
    // Also after a Stop thrown deep in the recursion, whose frames did not undo their marks.
    for (const c of members) { blocked[c] = 0; mark[c] = 0; }
  }
  // Most promising first (sorting a huge list would hold up the clock checks; keep that one in order found).
  if (options.length <= 20000) options.sort((a, b) => b.bound - a.bound || a.len - b.len);
  let bestCount = -1;
  let list: Sol[] = [];
  for (const opt of options) {
    if (opt.bound < best) continue;
    ctx.tick();
    const Sarr = flat.slice(opt.off, opt.off + opt.len);
    const o = { S: Sarr, P: opt.P, bound: opt.bound, ...piecesOf(ctx.restOf(members, Sarr))! };
    const c = ctx.cand(o.S, o.P);
    const sumLo = o.lo.reduce((a, b) => a + b, 0), sumHi = o.hi.reduce((a, b) => a + b, 0);
    for (let k = c.kmin; k <= c.kmax; k++) {
      const left = K - k;
      if (left < sumLo || left > sumHi) continue;
      const head: Pick = { c, k, d: ctx.devOf(o.P, k) };
      splits(o.lo, o.hi, left, (Ks) => {
        ctx.tick();
        if (o.bound < best) return;
        let acc = 1;
        const ubK = o.rest.map((r, i) => ctx.ub(r, Ks[i]));
        let ubLeft = ubK.reduce((a, b) => a + b, 0);
        if (1 + ubLeft < best) return;
        const subs: Sol[][] = [];
        for (let i = 0; i < o.rest.length; i++) {
          ubLeft -= ubK[i];
          const r = solve(ctx, o.rest[i], Ks[i], Math.max(1, best - acc - ubLeft));
          if (!('list' in r)) return;
          acc += r.count;
          subs.push(r.list);
        }
        if (acc < best) return;
        const combos = combine(head, subs, ctx.M);
        if (acc > bestCount) { bestCount = acc; list = mergeTop([], combos, ctx.M); best = acc; }
        else list = mergeTop(list, combos, ctx.M);
      });
    }
  }
  if (bestCount < 0) return { below: need };
  return { count: bestCount, list };
}

/** Whole-state exact search over the connected pieces of the state; null when below `need`. */
function solveAll(ctx: Ctx, pieces: number[][], need: number): { count: number; list: Sol[] } | null {
  const ranges = pieces.map((p) => ctx.kRange(ctx.popSum(p))!);
  let bestCount = -1;
  let best = need;
  let list: Sol[] = [];
  splits(ranges.map((r) => r[0]), ranges.map((r) => r[1]), ctx.N, (Ks) => {
    let acc = 0;
    const ubs = pieces.map((p, i) => ctx.ub(p, Ks[i]));
    let ubLeft = ubs.reduce((a, b) => a + b, 0);
    const subs: Sol[][] = [];
    for (let i = 0; i < pieces.length; i++) {
      ubLeft -= ubs[i];
      const r = solve(ctx, pieces[i], Ks[i], Math.max(1, best - acc - ubLeft));
      if (!('list' in r)) return;
      acc += r.count;
      subs.push(r.list);
    }
    const combos = combine(null, subs, ctx.M);
    if (acc > bestCount) { bestCount = acc; best = acc; list = mergeTop([], combos, ctx.M); }
    else list = mergeTop(list, combos, ctx.M);
  });
  return bestCount < 0 ? null : { count: bestCount, list };
}

// --- district counts for a grouping

/** k per cluster with Σk = K minimizing the worst deviation; null when impossible. */
function assignKs(ctx: Ctx, clusters: Cand[], K = ctx.N): { ks: number[]; d: number } | null {
  let sumMin = 0, sumMax = 0;
  for (const c of clusters) { sumMin += c.kmin; sumMax += c.kmax; }
  if (sumMin > K || sumMax < K) return null;
  const range = (c: Cand, D: number): [number, number] => {
    let lo = -1, hi = -1;
    for (let k = c.kmin; k <= c.kmax; k++) if (ctx.devOf(c.pop, k) <= D + 1e-15) { if (lo < 0) lo = k; hi = k; }
    return [lo, hi];
  };
  const Ds = new Set<number>();
  for (const c of clusters) for (let k = c.kmin; k <= c.kmax; k++) Ds.add(ctx.devOf(c.pop, k));
  const sorted = [...Ds].sort((a, b) => a - b);
  const feasible = (D: number): boolean => {
    let lo = 0, hi = 0;
    for (const c of clusters) {
      const r = range(c, D);
      if (r[0] < 0) return false;
      lo += r[0]; hi += r[1];
    }
    return lo <= K && K <= hi;
  };
  let a = 0, b = sorted.length - 1;
  if (!feasible(sorted[b])) return null;
  while (a < b) {
    const m = (a + b) >> 1;
    if (feasible(sorted[m])) b = m; else a = m + 1;
  }
  const D = sorted[a];
  const ranges = clusters.map((c) => range(c, D));
  const ks = clusters.map((c, i) => {
    let bk = ranges[i][0];
    for (let k = ranges[i][0]; k <= ranges[i][1]; k++) if (ctx.devOf(c.pop, k) < ctx.devOf(c.pop, bk)) bk = k;
    return bk;
  });
  let diff = K - ks.reduce((x, k) => x + k, 0);
  while (diff !== 0) {
    const step = diff > 0 ? 1 : -1;
    let bi = -1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const k = ks[i] + step;
      if (k < ranges[i][0] || k > ranges[i][1]) continue;
      const d = ctx.devOf(clusters[i].pop, k);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) return null;
    ks[bi] += step;
    diff -= step;
  }
  let d = 0;
  clusters.forEach((c, i) => { d = Math.max(d, ctx.devOf(c.pop, ks[i])); });
  return { ks, d };
}

// --- heuristics

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces of members \ S, or null when one has an invalid population. */
function validRest(ctx: Ctx, members: number[], S: number[]): number[][] | null {
  const rest = ctx.restOf(members, S);
  for (const r of rest) if (!ctx.valid(ctx.popSum(r))) return null;
  return rest;
}

/** A small valid cluster at the edge of `members` whose removal leaves valid pieces, or null. */
function peel(ctx: Ctx, members: number[], rand: () => number): number[] | null {
  if (members.length < 2) return null;
  const { mark, blocked, nbr, pop, single } = ctx;
  for (const c of members) mark[c] = 1;
  let v = -1, vdeg = Infinity, vr = 0;
  for (const c of members) {
    let deg = 0;
    for (const w of nbr[c]) if (mark[w]) deg++;
    if (single[c]) deg = -1;
    const r = rand();
    if (deg < vdeg || (deg === vdeg && r < vr)) { v = c; vdeg = deg; vr = r; }
  }
  for (const c of members) mark[c] = 0;
  if (single[v]) return validRest(ctx, members, [v]) ? [v] : null;
  let bestS: number[] | null = null;
  let bestScore = Infinity;
  const consider = (S: number[], P: number): void => {
    if (S.length === members.length || !ctx.valid(P)) return;
    const rest = validRest(ctx, members, S);
    if (!rest) return;
    const score = -(1 + rest.reduce((a, r) => a + ctx.ub(r, Math.max(1, Math.round(ctx.popSum(r) / ctx.s))), 0)) * 1000 + S.length + ctx.cand(S, P).d * 10 + rand() * 0.5;
    if (score < bestScore) { bestScore = score; bestS = S.slice(); }
  };
  // Size-capped enumeration, deepening, small budget.
  let budget = 3000;
  for (let cap = 1; cap <= Math.min(14, members.length - 1) && budget > 0; cap++) {
    for (const c of members) mark[c] = 1;
    const S: number[] = [v];
    let P = pop[v];
    blocked[v] = 1;
    const X0: number[] = [];
    for (const w of nbr[v]) if (mark[w] && !blocked[w] && !single[w]) { blocked[w] = 1; X0.push(w); }
    const found: Array<{ S: number[]; P: number }> = [];
    const rec = (X: number[]): void => {
      if (--budget < 0) return;
      ctx.tick();
      if (S.length === cap && ctx.valid(P)) found.push({ S: S.slice(), P });
      if (S.length >= cap) return;
      for (let i = 0; i < X.length && budget > 0; i++) {
        const u = X[i];
        const added: number[] = [];
        for (const w of nbr[u]) if (mark[w] && !blocked[w] && !single[w]) { blocked[w] = 1; added.push(w); }
        S.push(u); P += pop[u];
        rec(X.slice(i + 1).concat(added));
        S.pop(); P -= pop[u];
        for (const w of added) blocked[w] = 0;
      }
    };
    try { rec(X0); } finally {
      for (const c of members) { blocked[c] = 0; mark[c] = 0; }
    }
    for (const f of found) consider(f.S, f.P);
    if (bestS && cap >= (bestS as number[]).length + 1) break;
  }
  return bestS ?? grow(ctx, members, v, rand);
}

/** Region growing from v until valid with valid leftovers; null when only the whole set works. */
function grow(ctx: Ctx, members: number[], v: number, rand: () => number): number[] | null {
  const { nbr, pop, single } = ctx;
  const inS = new Set<number>([v]);
  let P = pop[v];
  const inM = new Set(members);
  for (let guard = 0; guard < members.length * 2; guard++) {
    ctx.tick();
    if (inS.size === members.length) return null;
    if (ctx.valid(P)) {
      const S = [...inS];
      if (validRest(ctx, members, S)) return S;
      // Absorb small invalid pockets.
      let absorbed = false;
      for (const r of ctx.restOf(members, S)) {
        const rp = ctx.popSum(r);
        if (!ctx.valid(rp) && rp < ctx.s * (1 - ctx.t) && !r.some((c) => single[c])) {
          for (const c of r) { inS.add(c); P += pop[c]; }
          absorbed = true;
        }
      }
      if (absorbed) continue;
    }
    let bu = -1, bscore = -Infinity;
    for (const c of inS) for (const w of nbr[c]) {
      if (!inM.has(w) || inS.has(w) || single[w]) continue;
      let links = 0;
      for (const x of nbr[w]) if (inS.has(x)) links++;
      const score = links * 10 + rand();
      if (score > bscore) { bscore = score; bu = w; }
    }
    if (bu < 0) return null;
    inS.add(bu);
    P += pop[bu];
  }
  return null;
}

/** Greedy clustering of the given pieces; null when it breaks the singleton rule. */
function greedy(ctx: Ctx, pieces: number[][], rand: () => number): Cand[] | null {
  const out: Cand[] = [];
  const queue = pieces.map((p) => p.slice());
  while (queue.length) {
    const U = queue.pop()!;
    const S = peel(ctx, U, rand);
    if (!S) {
      if (U.length > 1 && U.some((c) => ctx.single[c])) return null;
      out.push(ctx.cand(U));
      continue;
    }
    out.push(ctx.cand(S));
    for (const r of validRest(ctx, U, S)!) queue.push(r);
  }
  return out;
}

interface Incumbent { clusters: Cand[]; ks: number[]; key: Key }

function incumbentOf(ctx: Ctx, clusters: Cand[]): Incumbent | null {
  const a = assignKs(ctx, clusters);
  if (!a) return null;
  return { clusters, ks: a.ks, key: { count: clusters.length, d: a.d, l: Math.max(...clusters.map((c) => c.counties.length)) } };
}

/** Exact solve under a node budget; null when the budget ran out. */
function solveBudget(ctx: Ctx, members: number[], K: number, need: number, budget: number): Entry | null {
  const save = ctx.nodeLimit;
  ctx.nodeLimit = ctx.nodes + budget;
  try {
    return solve(ctx, members, K, need);
  } catch (e) {
    if (e instanceof Stop && e.reason === 'budget') return null;
    throw e;
  } finally {
    ctx.nodeLimit = save;
  }
}

/** Clusters adjacent to each cluster. */
function clusterAdjacency(ctx: Ctx, clusters: Cand[]): number[][] {
  const owner = new Int32Array(ctx.C).fill(-1);
  clusters.forEach((c, i) => { for (const x of c.counties) owner[x] = i; });
  return clusters.map((c, i) => {
    const js = new Set<number>();
    for (const x of c.counties) for (const w of ctx.nbr[x]) if (owner[w] >= 0 && owner[w] !== i) js.add(owner[w]);
    return [...js].sort((a, b) => a - b);
  });
}

/**
 * Large-neighbourhood search: regions of one, two or three adjacent clusters (then a cluster
 * with all its neighbours) are re-solved exactly under a node budget, asking for one more cluster
 * (or, where the worst cluster is, the same count with a smaller worst deviation); a region too
 * big for that is rebuilt greedily a few times. Any change that improves the whole clustering is
 * kept. Stops at `until` or when a sweep changes nothing.
 */
function localSearch(ctx: Ctx, start: Incumbent, until: number, rand: () => number, tried: Set<string>): Incumbent {
  let cur = start;
  const replace = (drop: number[], add: Cand[]): boolean => {
    const next = incumbentOf(ctx, cur.clusters.filter((_, i) => !drop.includes(i)).concat(add));
    if (next && better(next.key, cur.key)) { cur = next; return true; }
    return false;
  };
  for (let sweep = 0; sweep < 500 && now() < until; sweep++) {
    const adj = clusterAdjacency(ctx, cur.clusters);
    const devs = cur.clusters.map((c, i) => ctx.devOf(c.pop, cur.ks[i]));
    const order = cur.clusters.map((_, i) => ({ i, w: -devs[i] + rand() * 0.02 })).sort((a, b) => a.w - b.w).map((x) => x.i);
    const regions: number[][] = [];
    const seenR = new Set<string>();
    const add = (r: number[]) => { const k = r.slice().sort((a, b) => a - b).join(','); if (!seenR.has(k)) { seenR.add(k); regions.push(r); } };
    for (const i of order) if (cur.clusters[i].counties.length > 1) add([i]);
    for (const i of order) for (const j of adj[i]) add([i, j]);
    for (const i of order) for (const j of adj[i]) for (const k of new Set([...adj[i], ...adj[j]])) if (k !== i && k !== j) add([i, j, k]);
    for (const i of order) if (adj[i].length > 2) add([i, ...adj[i]]);
    let changed = false;
    for (const r of regions) {
      if (now() > until) break;
      const members = r.flatMap((i) => cur.clusters[i].counties).sort((a, b) => a - b);
      const K = r.reduce((a, i) => a + cur.ks[i], 0);
      const dOld = Math.max(...r.map((i) => devs[i]));
      const worst = dOld >= cur.key.d - 1e-12;
      const key = members.join(',') + '|' + K + (worst ? '|w' : '');
      if (tried.has(key)) continue;
      tried.add(key);
      const res = solveBudget(ctx, members, K, r.length + 1, r.length > 3 ? 30000 : 15000);
      if (res && 'list' in res) {
        if (res.list.some((sol) => replace(r, sol.picks.map((p) => p.c)))) { changed = true; break; }
      } else if (res === null) {
        let hit = false;
        for (let g = 0; g < 4 && !hit; g++) {
          const gr = greedy(ctx, [members], rand);
          if (gr && gr.length > r.length && replace(r, gr)) hit = true;
        }
        if (hit) { changed = true; break; }
      }
      if (worst && r.length <= 3) {
        const same = solveBudget(ctx, members, K, r.length, 15000);
        if (same && 'list' in same && same.list.some((sol) => sol.d < dOld - 1e-12 && replace(r, sol.picks.map((p) => p.c)))) { changed = true; break; }
      }
    }
    if (!changed) break;
  }
  return cur;
}

/**
 * Iterated local search: local search, then while time is left rebuild a random patch (a
 * cluster, its neighbours and theirs) greedily and search again, keeping the result when it is
 * at least as good (a walk across equally good clusterings).
 */
function improve(ctx: Ctx, start: Incumbent, until: number, rand: () => number): Incumbent {
  const tried = new Set<string>();
  let best = start;
  try {
    let cur = localSearch(ctx, start, until, rand, tried);
    best = cur;
    for (let round = 0; round < 10000 && now() < until; round++) {
      const adj = clusterAdjacency(ctx, cur.clusters);
      const seed = Math.floor(rand() * cur.clusters.length);
      const patch = new Set<number>([seed, ...adj[seed]]);
      if (rand() < 0.5) for (const j of adj[seed]) for (const k of adj[j]) patch.add(k);
      const drop = [...patch];
      const members = drop.flatMap((i) => cur.clusters[i].counties);
      const gr = greedy(ctx, [members.sort((a, b) => a - b)], rand);
      if (!gr) continue;
      const shaken = incumbentOf(ctx, cur.clusters.filter((_, i) => !patch.has(i)).concat(gr));
      if (!shaken) continue;
      const next = localSearch(ctx, shaken, until, rand, tried);
      if (!better(cur.key, next.key)) cur = next;
      if (better(cur.key, best.key)) best = cur;
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    ctx.stopped = e.reason;
  }
  return best;
}

/** Same-count variants of a clustering: exact alternatives for adjacent pairs and triples swapped in. */
function variants(ctx: Ctx, base: Incumbent, until: number): Cand[][] {
  const out: Cand[][] = [];
  const owner = new Int32Array(ctx.C).fill(-1);
  base.clusters.forEach((c, i) => { for (const x of c.counties) owner[x] = i; });
  const regions: number[][] = [];
  base.clusters.forEach((c, i) => {
    const js = new Set<number>();
    for (const x of c.counties) for (const w of ctx.nbr[x]) if (owner[w] > i) js.add(owner[w]);
    for (const j of [...js].sort((a, b) => a - b)) regions.push([i, j]);
  });
  for (const r of regions) {
    if (now() > until) break;
    const members = r.flatMap((i) => base.clusters[i].counties).sort((a, b) => a - b);
    const K = r.reduce((a, i) => a + base.ks[i], 0);
    const res = solveBudget(ctx, members, K, r.length, 10000);
    if (!res || !('list' in res) || res.count !== r.length) continue;
    const oldH = r.reduce((a, i) => (a + base.clusters[i].h) >>> 0, 0);
    for (const sol of res.list) {
      if (sol.h === oldH) continue;
      out.push(base.clusters.filter((_, i) => !r.includes(i)).concat(sol.picks.map((p) => p.c)));
    }
  }
  return out;
}

// --- output

function toClustering(ctx: Ctx, clusters: Cand[], ks: number[]): Clustering {
  const rows: CountyCluster[] = clusters.map((c, i) => {
    const deviation = c.pop / ks[i] - ctx.s;
    return { counties: c.counties.slice(), districts: ks[i], pop: c.pop, deviation, deviationPct: deviation / ctx.s };
  });
  rows.sort((a, b) => b.pop - a.pop || a.counties[0] - b.counties[0]);
  const id = fnv(rows.map((r) => `${r.counties.join(',')}:${r.districts}`).join('|'));
  return {
    id,
    clusters: rows,
    stats: {
      clusterCount: rows.length,
      singleCounty: rows.filter((r) => r.counties.length === 1).length,
      maxAbsDeviationPct: Math.max(...rows.map((r) => Math.abs(r.deviationPct))),
      largestClusterCounties: Math.max(...rows.map((r) => r.counties.length)),
    },
  };
}

function canon(c: Clustering): string {
  return c.clusters.map((r) => r.counties.join(',')).sort().join('|');
}

/** Ranked, one per grouping, deterministic order for ties. */
function rank(list: Clustering[]): Clustering[] {
  const sorted = list.map((c) => ({ c, k: canon(c) })).sort((a, b) =>
    b.c.stats.clusterCount - a.c.stats.clusterCount
    || (Math.abs(a.c.stats.maxAbsDeviationPct - b.c.stats.maxAbsDeviationPct) > 1e-12 ? a.c.stats.maxAbsDeviationPct - b.c.stats.maxAbsDeviationPct : 0)
    || a.c.stats.largestClusterCounties - b.c.stats.largestClusterCounties
    || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const seen = new Set<string>();
  const out: Clustering[] = [];
  for (const { c, k } of sorted) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

const pct = (x: number) => `${+(x * 100).toFixed(2)}%`;

/** County clusters for a state; see the module note. */
export function findCountyClusters(req: ClusterRequest, options: ClusterSearchOptions = {}): ClusterResult {
  const t0 = now();
  const timeLimit = Math.max(1, req.timeLimitMs ?? 10_000);
  const M = Math.max(1, Math.floor(req.maxResults ?? 5));
  const N = Math.floor(req.numDistricts);
  const t = req.tolerance;
  const cg = countyGraph(req.graph);
  const total = cg.pop.reduce((a, b) => a + b, 0);
  const s = N > 0 ? total / N : 0;
  const done = (r: Omit<ClusterResult, 'elapsedMs' | 'districtSize'>): ClusterResult =>
    ({ ...r, districtSize: s, elapsedMs: now() - t0 });
  if (!(N >= 1) || !Number.isFinite(N)) return done({ status: 'error', clusterings: [], exhaustive: false, message: 'The number of districts must be at least 1.' });
  if (!(t > 0 && t < 1)) return done({ status: 'error', clusterings: [], exhaustive: false, message: 'The tolerance must be between 0 and 1 (0.05 for ±5%).' });
  if (total <= 0 || cg.count === 0) return done({ status: 'error', clusterings: [], exhaustive: false, message: 'The map has no population.' });
  const used = cg.blocks.map((b, i) => (b > 0 ? i : -1)).filter((i) => i >= 0);
  if (N === 1) return done({ status: 'none', clusterings: [], exhaustive: true, message: 'With one district the whole state is one cluster.' });
  if (used.length === 1) return done({ status: 'none', clusterings: [], exhaustive: true, message: 'The state has a single county, so it is one cluster.' });

  const singles = (req.singletons ?? []).filter((c) => c >= 0 && c < cg.count && cg.blocks[c] > 0);
  const result = search(cg, used, s, t, N, M, singles, t0 + timeLimit, options);
  if (result.reason !== 'no-split') return done(result.out);

  // Tightest tolerance among the panel's choices that allows a split (short searches).
  const ladder = [0.005, 0.01, 0.02, 0.05, 0.1].filter((x) => x > t + 1e-12);
  let hint = '';
  const hintDeadline = Math.min(t0 + timeLimit, now() + Math.max(200, timeLimit * 0.2));
  for (const x of ladder) {
    const left = hintDeadline - now();
    if (left <= 0) break;
    const r = search(cg, used, s, x, N, 1, singles, now() + left / 2, options);
    if (r.out.status === 'ok' && r.out.clusterings.length) {
      hint = ` At ±${pct(x)} there is a split into ${r.out.clusterings[0].stats.clusterCount} clusters.`;
      break;
    }
  }
  return done({ ...result.out, message: (result.out.message ?? '') + hint });
}

interface SearchOut {
  reason?: 'no-split' | 'singleton' | 'disconnected';
  out: Omit<ClusterResult, 'elapsedMs' | 'districtSize'>;
}

function search(cg: CountyGraph, used: number[], s: number, t: number, N: number, M: number, singles: number[],
  deadline: number, options: ClusterSearchOptions): SearchOut {
  const start = now();
  const budget = deadline - start;
  const log = options.log;
  const ctx = new Ctx(cg, s, t, N, M, singles, options.shouldStop);
  const rand = rng(options.seed ?? 1);
  const tol = `±${pct(t)}`;
  for (const c of singles) {
    if (!ctx.valid(cg.pop[c])) {
      return { reason: 'singleton', out: { status: 'none', clusterings: [], exhaustive: true,
        message: `County ${c} must stand alone, but its ${cg.pop[c]} people are not within ${tol} of a whole number of districts.` } };
    }
  }
  for (const c of used) ctx.mark[c] = 1;
  const pieces = ctx.components(used);
  for (const c of used) ctx.mark[c] = 0;
  for (const p of pieces) {
    if (!ctx.valid(ctx.popSum(p))) {
      return { reason: 'disconnected', out: { status: 'none', clusterings: [], exhaustive: true,
        message: `The counties form ${pieces.length} separate groups, and one of them (${ctx.popSum(p)} people) is not within ${tol} of a whole number of districts.` } };
    }
  }
  const ub0 = used.reduce((a, c) => a + ctx.y[c], 0);
  ctx.tightenBest(start + budget * 0.08, rand);
  log?.(`weights: bound ${ub0.toFixed(2)} -> ${(used.reduce((a, c) => a + ctx.y[c], 0) + ctx.lam * N).toFixed(2)} (lambda ${ctx.lam}) at ${(now() - start).toFixed(0)} ms`);

  let exhaustive = false;
  let cancelled = false;
  let exact: { count: number; list: Sol[] } | null = null;
  let inc: Incumbent | null = null;
  const runExact = (until: number, need: number): void => {
    ctx.deadline = until;
    try {
      exact = solveAll(ctx, pieces, need);
      exhaustive = true;
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      if (e.reason === 'cancel') cancelled = true;
    } finally { ctx.deadline = deadline; }
  };
  try {
    ctx.deadline = deadline;
    const greedyUntil = start + budget * 0.12;
    for (let run = 0; run < 200 && (run === 0 || now() < greedyUntil); run++) {
      const g = greedy(ctx, pieces, rand);
      const next = g && incumbentOf(ctx, g);
      if (next && (!inc || better(next.key, inc.key))) inc = next;
    }
    log?.(`greedy ${inc ? (inc as Incumbent).key.count : '-'} at ${(now() - start).toFixed(0)} ms`);
    runExact(start + budget * 0.25, inc ? (inc as Incumbent).key.count : 1);
    if (!exhaustive && !cancelled) {
      if (inc) inc = improve(ctx, inc, start + budget * 0.75, rand);
      log?.(`improved ${inc ? (inc as Incumbent).key.count : '-'} at ${(now() - start).toFixed(0)} ms, nodes ${ctx.nodes}, memo ${ctx.memo.size}`);
      if (ctx.stopped === 'cancel') cancelled = true;
      else runExact(deadline - Math.min(800, budget * 0.08), inc ? (inc as Incumbent).key.count : 1);
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    if (e.reason === 'cancel') cancelled = true;
  }
  if (exhaustive && !exact) exhaustive = false; // cannot happen (a valid piece is one cluster); never claim a proof without a result
  log?.(`exact ${exhaustive ? 'finished' : 'stopped'} at ${(now() - start).toFixed(0)} ms, nodes ${ctx.nodes}, memo ${ctx.memo.size}`);

  const clusterings: Clustering[] = [];
  if (exhaustive && exact) {
    for (const sol of (exact as { list: Sol[] }).list) clusterings.push(toClustering(ctx, sol.picks.map((p) => p.c), sol.picks.map((p) => p.k)));
  } else if (inc) {
    const base = inc as Incumbent;
    clusterings.push(toClustering(ctx, base.clusters, base.ks));
    try {
      ctx.deadline = Infinity;
      for (const v of variants(ctx, base, now() + Math.min(300, Math.max(30, budget * 0.03)))) {
        const a = incumbentOf(ctx, v);
        if (a) clusterings.push(toClustering(ctx, a.clusters, a.ks));
      }
    } catch (e) { if (!(e instanceof Stop)) throw e; }
  }
  let ranked = rank(clusterings);
  if (ranked.length) ranked = ranked.filter((c) => c.stats.clusterCount === ranked[0].stats.clusterCount).slice(0, M);
  if (!ranked.length || ranked[0].stats.clusterCount < 2) {
    return { reason: 'no-split', out: { status: 'none', clusterings: [], exhaustive,
      message: exhaustive
        ? `No way to split the state into two or more county clusters within ${tol}.`
        : `No split into two or more county clusters within ${tol} was found${cancelled ? ' before the search was cancelled' : ' in time'}.` } };
  }
  // The bound alone can prove the count even when the search could not finish ranking.
  const ubAll = pieces.reduce((a, p) => a + ctx.ub(p, pieces.length === 1 ? N : ctx.kRange(ctx.popSum(p))![1]), 0);
  const countProven = !exhaustive && ranked[0].stats.clusterCount >= ubAll;
  const message = cancelled ? 'Search cancelled: the best clusterings found so far, not proven optimal.'
    : exhaustive ? undefined
    : countProven ? 'Time limit reached: no clustering has more clusters (proven), but the order by deviation is not proven.'
    : 'Time limit reached: the best clusterings found, not proven optimal.';
  return { out: { status: 'ok', clusterings: ranked, exhaustive, ...(message ? { message } : {}) } };
}

// ---------------------------------------------------------------------------------------------
// Verifier (independent of the search: recomputes everything from the block graph)

export interface ClusteringCheck {
  ok: boolean;
  issues: string[];
}

/** Checks a clustering against the request: exact cover, contiguity, population rule, Σk, stats. */
export function verifyClustering(graph: EngineGraph, req: ClusterRequest, clustering: Clustering): ClusteringCheck {
  const issues: string[] = [];
  const present = new Map<number, number>();
  for (let i = 0; i < graph.n; i++) present.set(graph.countyOf[i], (present.get(graph.countyOf[i]) ?? 0) + graph.pop[i]);
  let total = 0;
  for (const p of present.values()) total += p;
  const size = total / req.numDistricts;
  const tolPeople = req.tolerance * size;
  const touches = new Map<number, Set<number>>();
  for (let i = 0; i < graph.n; i++) {
    const a = graph.countyOf[i];
    for (let e = graph.adjOffsets[i]; e < graph.adjOffsets[i + 1]; e++) {
      const b = graph.countyOf[graph.adjTargets[e]];
      if (a === b) continue;
      if (!touches.has(a)) touches.set(a, new Set());
      touches.get(a)!.add(b);
    }
  }
  const owner = new Map<number, number>();
  let kSum = 0;
  clustering.clusters.forEach((cl, ci) => {
    const label = `cluster ${ci + 1}`;
    if (!cl.counties.length) { issues.push(`${label} is empty`); return; }
    for (let j = 1; j < cl.counties.length; j++) if (cl.counties[j] <= cl.counties[j - 1]) issues.push(`${label}: counties not ascending`);
    let pop = 0;
    for (const c of cl.counties) {
      if (!present.has(c)) issues.push(`${label}: county ${c} does not exist`);
      if (owner.has(c)) issues.push(`county ${c} is in clusters ${owner.get(c)! + 1} and ${ci + 1}`);
      owner.set(c, ci);
      pop += present.get(c) ?? 0;
    }
    if (pop !== cl.pop) issues.push(`${label}: pop ${cl.pop}, its counties hold ${pop}`);
    if (!Number.isInteger(cl.districts) || cl.districts < 1) { issues.push(`${label}: districts ${cl.districts}`); return; }
    kSum += cl.districts;
    const dev = pop / cl.districts - size;
    if (Math.abs(dev) > tolPeople * (1 + 1e-12) + 1e-6) issues.push(`${label}: ${pop} people in ${cl.districts} districts is ${dev.toFixed(1)} from ${size.toFixed(1)} per district (limit ±${tolPeople.toFixed(1)})`);
    if (Math.abs(dev - cl.deviation) > 1e-6) issues.push(`${label}: deviation ${cl.deviation}, expected ${dev}`);
    if (Math.abs(dev / size - cl.deviationPct) > 1e-9) issues.push(`${label}: deviationPct ${cl.deviationPct}, expected ${dev / size}`);
    const inC = new Set(cl.counties);
    const seen = new Set<number>([cl.counties[0]]);
    const queue = [cl.counties[0]];
    while (queue.length) {
      const c = queue.pop()!;
      for (const w of touches.get(c) ?? []) if (inC.has(w) && !seen.has(w)) { seen.add(w); queue.push(w); }
    }
    if (seen.size !== inC.size) issues.push(`${label} is not contiguous`);
    if (cl.counties.length > 1) for (const c of req.singletons ?? []) if (inC.has(c)) issues.push(`${label}: singleton county ${c} grouped with others`);
  });
  for (const c of present.keys()) if (!owner.has(c)) issues.push(`county ${c} is in no cluster`);
  if (kSum !== req.numDistricts) issues.push(`districts add up to ${kSum}, not ${req.numDistricts}`);
  for (let j = 1; j < clustering.clusters.length; j++) if (clustering.clusters[j].pop > clustering.clusters[j - 1].pop) issues.push('clusters not sorted by population');
  const st = clustering.stats;
  const rows = clustering.clusters;
  if (st.clusterCount !== rows.length) issues.push('stats.clusterCount');
  if (st.singleCounty !== rows.filter((r) => r.counties.length === 1).length) issues.push('stats.singleCounty');
  if (rows.length && Math.abs(st.maxAbsDeviationPct - Math.max(...rows.map((r) => Math.abs(r.deviationPct)))) > 1e-12) issues.push('stats.maxAbsDeviationPct');
  if (rows.length && st.largestClusterCounties !== Math.max(...rows.map((r) => r.counties.length))) issues.push('stats.largestClusterCounties');
  if (!clustering.id) issues.push('missing id');
  return { ok: issues.length === 0, issues };
}
