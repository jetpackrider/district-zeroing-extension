import type {
  Assignment,
  BorderSolveRequest,
  BorderSolver,
  CapacityCurve,
  CostWeights,
  EngineGraph,
  SolutionStats,
  Transfer,
} from '@zd/contracts';

/**
 * A simple, honest reference BorderSolver for tests (SPEC "Balancing engine", simplified):
 * candidate ring of the giving district near the border, per-precinct options (the whole
 * precinct part, and BFS-grown chunks from seeds touching the receiver, every prefix an
 * option), an exact-sum knapsack with at most one option per precinct, a contiguity check
 * ("no new pieces" for both districts) that bans offending options, and penalties on used
 * precincts for alternatives. Only meant for small graphs.
 */

const DEFAULTS: CostWeights = {
  newPrecinctSplit: 100,
  healedPrecinctSplit: -100,
  newCountySplit: 300,
  newTownSplit: 420,
  perStep: 0,
  perBlock: 0.02,
  perPopulatedBlock: 0.08,
  perimeterPerMeter: 0.0001,
  neighborDeviation: 0.01,
};

interface Option {
  precinct: number;
  blocks: number[];
  pop: number;
  cost: number;
  whole: boolean;
  id: number;
}

interface Index {
  offsets: Uint32Array;
  blocks: Uint32Array;
}

const indexCache = new WeakMap<object, Index>();
function precinctIndex(g: EngineGraph): Index {
  let idx = indexCache.get(g.precinctOf);
  if (idx) return idx;
  let max = 0;
  for (let i = 0; i < g.n; i++) max = Math.max(max, g.precinctOf[i]);
  const offsets = new Uint32Array(max + 2);
  for (let i = 0; i < g.n; i++) offsets[g.precinctOf[i] + 1]++;
  for (let p = 1; p < offsets.length; p++) offsets[p] += offsets[p - 1];
  const fill = offsets.slice();
  const blocks = new Uint32Array(g.n);
  for (let i = 0; i < g.n; i++) blocks[fill[g.precinctOf[i]]++] = i;
  idx = { offsets, blocks };
  indexCache.set(g.precinctOf, idx);
  return idx;
}

function pieces(g: EngineGraph, a: Assignment, d: number): number {
  const seen = new Uint8Array(g.n);
  let c = 0;
  const stack: number[] = [];
  for (let s = 0; s < g.n; s++) {
    if (a[s] !== d || seen[s]) continue;
    c++;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const u = stack.pop()!;
      for (let e = g.adjOffsets[u]; e < g.adjOffsets[u + 1]; e++) {
        const v = g.adjTargets[e];
        if (a[v] === d && !seen[v]) { seen[v] = 1; stack.push(v); }
      }
    }
  }
  return c;
}

export interface RefSolverOptions {
  seedsPerPrecinct?: number;
  maxChunk?: number;
  hops?: number[];
  /** Enumerate every connected subset of a precinct's candidates up to this many blocks. */
  exhaustiveUpTo?: number;
}

export class ReferenceSolver implements BorderSolver {
  calls = { solve: 0, capacity: 0 };
  constructor(private readonly opts: RefSolverOptions = {}) {}

  private options(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>, hops: number, w: CostWeights): Option[] {
    const g = req.graph;
    const a = req.assignment;
    const { from, to } = req;
    const locked = req.locked;
    const dist = new Int32Array(g.n).fill(-1);
    const queue: number[] = [];
    const touchesTo = (b: number) => {
      for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) if (a[g.adjTargets[e]] === to) return true;
      return false;
    };
    for (let b = 0; b < g.n; b++) {
      if (a[b] === from && !(locked && locked[b]) && touchesTo(b)) { dist[b] = 0; queue.push(b); }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      if (dist[u] >= hops) continue;
      for (let e = g.adjOffsets[u]; e < g.adjOffsets[u + 1]; e++) {
        const v = g.adjTargets[e];
        if (dist[v] < 0 && a[v] === from && !(locked && locked[v])) { dist[v] = dist[u] + 1; queue.push(v); }
      }
    }
    const seedPrecincts = new Set<number>();
    for (const b of queue) if (dist[b] === 0) seedPrecincts.add(g.precinctOf[b]);
    // County presence of `to` before the move.
    const countyHasTo = new Set<number>();
    for (let b = 0; b < g.n; b++) if (a[b] === to) countyHasTo.add(g.countyOf[b]);

    const idx = precinctIndex(g);
    const out: Option[] = [];
    const seedsPer = this.opts.seedsPerPrecinct ?? 8;
    const maxChunk = this.opts.maxChunk ?? 60;
    let id = 0;
    for (const p of [...seedPrecincts].sort((x, y) => x - y)) {
      const all: number[] = [];
      for (let i = idx.offsets[p]; i < idx.offsets[p + 1]; i++) all.push(idx.blocks[i]);
      const fromIn = all.filter((b) => a[b] === from);
      const cand = new Set(fromIn.filter((b) => dist[b] >= 0));
      const districtsBefore = new Set(all.map((b) => a[b]).filter((d) => d !== 0));
      const splitBefore = districtsBefore.size > 1;
      const costOf = (blocks: number[]): { cost: number; pop: number } => {
        let pop = 0, populated = 0;
        const counties = new Set<number>();
        for (const b of blocks) {
          pop += g.pop[b];
          if (g.pop[b] > 0) populated++;
          counties.add(g.countyOf[b]);
        }
        const after = new Set(districtsBefore);
        if (blocks.length === fromIn.length) after.delete(from);
        after.add(to);
        const splitAfter = after.size > 1;
        let cost = w.perStep + w.perBlock * blocks.length + w.perPopulatedBlock * populated;
        if (splitAfter && !splitBefore) cost += w.newPrecinctSplit;
        if (!splitAfter && splitBefore) cost += w.healedPrecinctSplit;
        for (const c of counties) if (!countyHasTo.has(c)) cost += w.newCountySplit;
        return { cost, pop };
      };
      const byPop = new Map<number, Option>();
      const offer = (blocks: number[], whole: boolean) => {
        const { cost, pop } = costOf(blocks);
        if (pop <= 0) return; // chunks made only of empty blocks are dropped
        const prev = byPop.get(pop);
        if (!prev || cost < prev.cost || (cost === prev.cost && blocks.length < prev.blocks.length)) {
          byPop.set(pop, { precinct: p, blocks: [...blocks].sort((x, y) => x - y), pop, cost, whole, id: 0 });
        }
      };
      if (cand.size === fromIn.length && fromIn.length > 0) offer(fromIn, true);
      const seeds = fromIn.filter((b) => dist[b] === 0).sort((x, y) => x - y);
      const candList = [...cand].sort((x, y) => x - y);
      if (candList.length <= (this.opts.exhaustiveUpTo ?? 12)) {
        // Small precinct: every connected subset that touches the receiver.
        const m = candList.length;
        const bit = new Map(candList.map((b, i) => [b, i]));
        const nbMask = candList.map((b) => {
          let mask = 0;
          for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
            const j = bit.get(g.adjTargets[e]);
            if (j !== undefined) mask |= 1 << j;
          }
          return mask;
        });
        let seedMask = 0;
        candList.forEach((b, i) => { if (dist[b] === 0) seedMask |= 1 << i; });
        for (let s = 1; s < 1 << m; s++) {
          if (!(s & seedMask)) continue;
          if (cand.size === fromIn.length && s === (1 << m) - 1) continue; // whole, offered above
          let reach = s & -s;
          for (;;) {
            let next = reach;
            for (let i = 0; i < m; i++) if (reach & (1 << i)) next |= nbMask[i] & s;
            if (next === reach) break;
            reach = next;
          }
          if (reach !== s) continue;
          const blocks: number[] = [];
          for (let i = 0; i < m; i++) if (s & (1 << i)) blocks.push(candList[i]);
          offer(blocks, false);
        }
      }
      const step = Math.max(1, Math.floor(seeds.length / seedsPer));
      for (let si = 0; si < seeds.length && si / step < seedsPer; si += step) {
        const chunk: number[] = [];
        const inChunk = new Set<number>();
        const frontier = [seeds[si]];
        inChunk.add(seeds[si]);
        while (frontier.length && chunk.length < Math.min(maxChunk, fromIn.length - 1)) {
          const u = frontier.shift()!;
          chunk.push(u);
          offer(chunk, false);
          for (let e = g.adjOffsets[u]; e < g.adjOffsets[u + 1]; e++) {
            const v = g.adjTargets[e];
            if (cand.has(v) && !inChunk.has(v)) { inChunk.add(v); frontier.push(v); }
          }
        }
      }
      for (const o of [...byPop.values()].sort((x, y) => x.pop - y.pop)) {
        o.id = id++;
        out.push(o);
      }
    }
    return out;
  }

  /** Exact-sum knapsack, at most one option per precinct. */
  private knapsack(opts: Option[], accept: number[], banned: Set<number>, penalty: Map<number, number>): Option[] | null {
    const T = Math.max(...accept);
    const groups = new Map<number, Option[]>();
    for (const o of opts) if (!banned.has(o.id) && o.pop <= T) {
      if (!groups.has(o.precinct)) groups.set(o.precinct, []);
      groups.get(o.precinct)!.push(o);
    }
    const stages = [...groups.keys()].sort((x, y) => x - y);
    let dp = new Float64Array(T + 1).fill(Infinity);
    dp[0] = 0;
    const choice: Int32Array[] = [];
    for (const p of stages) {
      const nd = dp.slice();
      const ch = new Int32Array(T + 1).fill(-1);
      const pen = penalty.get(p) ?? 0;
      for (const o of groups.get(p)!) {
        const c0 = o.cost + pen;
        for (let s = T - o.pop; s >= 0; s--) {
          if (dp[s] === Infinity) continue;
          const c = dp[s] + c0;
          if (c < nd[s + o.pop]) { nd[s + o.pop] = c; ch[s + o.pop] = o.id; }
        }
      }
      choice.push(ch);
      dp = nd;
    }
    let best = -1;
    for (const t of accept) if (t >= 0 && t <= T && dp[t] !== Infinity && (best < 0 || dp[t] < dp[best])) best = t;
    if (best <= 0) return null;
    const byId = new Map(opts.map((o) => [o.id, o]));
    const picked: Option[] = [];
    let s = best;
    for (let i = stages.length - 1; i >= 0; i--) {
      const id = choice[i][s];
      if (id >= 0) { const o = byId.get(id)!; picked.push(o); s -= o.pop; }
    }
    return s === 0 ? picked : null;
  }

  solveScored(req: BorderSolveRequest): Array<{ transfer: Transfer; stats: SolutionStats }> {
    this.calls.solve++;
    const w = { ...DEFAULTS, ...req.weights };
    const accept = [...new Set(req.accept)].filter((x) => Number.isInteger(x) && x > 0);
    if (!accept.length) return [];
    const maxOptions = Math.max(1, Math.min(8, req.maxOptions ?? 5));
    const g = req.graph;
    const fromPiecesBefore = req.from === 0 ? 0 : pieces(g, req.assignment, req.from);
    const toPiecesBefore = req.to === 0 ? 0 : pieces(g, req.assignment, req.to);
    // Unassigned (0) may be left in any number of pieces (see UNASSIGNED in @zd/contracts).
    const works = (blocks: number[]) => {
      const a = req.assignment.slice();
      for (const b of blocks) a[b] = req.to;
      return (req.from === 0 || pieces(g, a, req.from) <= fromPiecesBefore) && (req.to === 0 || pieces(g, a, req.to) <= toPiecesBefore);
    };
    for (const hops of this.opts.hops ?? [3, 6, 10]) {
      const opts = this.options(req, hops, w);
      const banned = new Set<number>();
      const penalty = new Map<number, number>();
      const results: Array<{ transfer: Transfer; stats: SolutionStats }> = [];
      const seen = new Set<string>();
      for (let attempt = 0; results.length < maxOptions && attempt < maxOptions * 8; attempt++) {
        const pick = this.knapsack(opts, accept, banned, penalty);
        if (!pick) break;
        const blocks = pick.flatMap((o) => o.blocks).sort((x, y) => x - y);
        if (!works(blocks)) {
          const alone = pick.filter((o) => !works(o.blocks));
          if (alone.length) for (const o of alone) banned.add(o.id);
          else banned.add([...pick].sort((x, y) => y.blocks.length - x.blocks.length || x.id - y.id)[0].id);
          continue;
        }
        const key = blocks.join(',');
        for (const o of pick) penalty.set(o.precinct, (penalty.get(o.precinct) ?? 0) + 60);
        if (seen.has(key)) continue;
        seen.add(key);
        const people = pick.reduce((s, o) => s + o.pop, 0);
        const cost = pick.reduce((s, o) => s + o.cost, 0);
        const populated = blocks.filter((b) => g.pop[b] > 0).length;
        results.push({
          transfer: { from: req.from, to: req.to, blocks: Uint32Array.from(blocks), people },
          stats: {
            people,
            blocks: blocks.length,
            steps: pick.length,
            populatedBlocks: populated,
            newPrecinctSplits: 0,
            healedPrecinctSplits: 0,
            newCountySplits: 0,
            perimeterDeltaM: 0,
            districtsTouched: 2,
            cost,
          },
        });
      }
      if (results.length) return results.sort((x, y) => x.stats.cost - y.stats.cost || x.stats.blocks - y.stats.blocks);
    }
    return [];
  }

  solve(req: BorderSolveRequest): Transfer[] {
    return this.solveScored(req).map((r) => r.transfer);
  }

  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve {
    this.calls.capacity++;
    const w = { ...DEFAULTS, ...req.weights };
    const hops = this.opts.hops ?? [3, 6, 10];
    const near = this.options(req, hops[0], w);
    const far = this.options(req, hops[hops.length - 1], w);
    const maxPer = (opts: Option[]) => {
      const m = new Map<number, number>();
      for (const o of opts) m.set(o.precinct, Math.max(m.get(o.precinct) ?? 0, o.pop));
      return [...m.values()].reduce((s, x) => s + x, 0);
    };
    const whole = near.filter((o) => o.whole);
    const noSplit = whole.reduce((s, o) => s + o.pop, 0);
    const any3 = Math.max(noSplit, maxPer(near));
    const any10 = Math.max(any3, maxPer(far));
    let fromPop = 0;
    for (let b = 0; b < req.graph.n; b++) if (req.assignment[b] === req.from) fromPop += req.graph.pop[b];
    const cap = (x: number) => Math.max(0, Math.min(x, fromPop));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const noSplitCost = Math.max(0.001, avg(whole.map((o) => o.cost / o.pop)));
    const partial = near.filter((o) => !o.whole);
    const lowCost = Math.max(noSplitCost * 1.5, avg(partial.map((o) => Math.max(0, o.cost) / o.pop)));
    const highCost = lowCost * 2 + 0.5;
    return {
      from: req.from,
      to: req.to,
      tiers: [
        { kind: 'no-split', people: cap(noSplit), costPerPerson: noSplitCost },
        { kind: 'low', people: cap(any3) - cap(noSplit), costPerPerson: lowCost },
        { kind: 'high', people: cap(any10) - cap(any3), costPerPerson: highCost },
      ],
    };
  }
}

export type SolveHook = (req: BorderSolveRequest, call: number) => 'normal' | 'fail' | 'cut';

/**
 * Wraps a solver and fails on demand: 'fail' returns no options, 'cut' corrupts every
 * option by adding a zero-population block of the giving district that does not touch the
 * receiver (moving it gives the receiver a new piece), keeping the people count exact.
 */
export class FlakySolver implements BorderSolver {
  solveCalls = 0;
  failures = 0;
  constructor(private readonly base: BorderSolver, private readonly hook: SolveHook) {}

  solve(req: BorderSolveRequest): Transfer[] {
    const call = this.solveCalls++;
    const mode = this.hook(req, call);
    if (mode === 'normal') return this.base.solve(req);
    this.failures++;
    if (mode === 'fail') return [];
    const g = req.graph;
    const a = req.assignment;
    let orphan = -1;
    for (let b = 0; b < g.n && orphan < 0; b++) {
      if (a[b] !== req.from || g.pop[b] !== 0 || (req.locked && req.locked[b])) continue;
      let ok = true;
      for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) if (a[g.adjTargets[e]] !== req.from) ok = false;
      if (ok) orphan = b;
    }
    return this.base.solve(req).map((t) => {
      if (orphan < 0 || t.blocks.includes(orphan)) return t;
      const blocks = Uint32Array.from([...t.blocks, orphan]).sort();
      return { ...t, blocks };
    });
  }

  solveScored(req: BorderSolveRequest) {
    return this.solve(req).map((transfer) => ({
      transfer,
      stats: { people: transfer.people, blocks: transfer.blocks.length, populatedBlocks: 0, newPrecinctSplits: 0, healedPrecinctSplits: 0, newCountySplits: 0, perimeterDeltaM: 0, districtsTouched: 2, cost: 0 },
    }));
  }

  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve {
    return this.base.capacity(req);
  }
}
