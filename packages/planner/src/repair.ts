import type { Assignment, BorderSolver, CostWeights, EngineGraph, Transfer } from '@zd/contracts';
import { DistrictTracker, pairKey } from './districts';
import { hashSolution } from './hash';

/**
 * Residual repair (the second stage of realizing a plan).
 *
 * The flow step plans one net amount per border and the first stage realizes those amounts
 * largest first. On real maps some small exact amounts cannot be delivered at all (a city
 * block holds dozens of people, so no connected set adds up to 1 or 2), so the first stage
 * leaves such borders out, or lands near the target when an exact large amount fails. What
 * is left is a small residual per district. This stage places those residuals.
 *
 * It is a search over transfers the solver has actually delivered. For each directed
 * border it touches, it asks the solver once for a "menu": up to 8 checked options for any
 * amount in 1..M (`accept` takes a list; the engine returns its cheapest options across
 * that list, which come in a spread of amounts). It also asks targeted questions: "any one
 * of exactly these amounts" when only certain amounts would finish a district. Then it
 * looks for the fewest transfers (iterative deepening, at most MAX_DEPTH) whose amounts put
 * every selected district at q or q + 1:
 *
 *   - one-way:   A → B: r
 *   - two-way:   A → B: x, then B → A: x − r       (a swap; both are ordinary transfers)
 *   - chains:    A → B → C, each with its own amount
 *   - cycles:    A → B, B → C, C → A
 *
 * Unassigned (district 0, listed in `adjacency` only when the request allows it) has no
 * target, so a district can give it or take from it any amount: a two-way trade with it is
 * pointless (the net amount should cross one way). The search first looks for a combination
 * with no such trade, neither a swap with 0 nor a transfer back over a border with 0 that the
 * plan already crossed the other way (`crossed`); only if none exists does it allow them.
 *
 * Which districts end at q + 1 is left free: every selected district only has to land in
 * [q, q + 1] (or exactly q when the state divides evenly); conservation fixes the count.
 *
 * The search is greedy over districts and exact within one: it takes the district furthest
 * from zero, finds the shortest combination that zeroes it without pushing any other
 * selected district further from zero, commits it, and repeats. Each committed combination
 * strictly reduces the total residual, so the loop ends.
 *
 * All solver questions in one local search are asked on the same state (the state when the
 * search starts), so every option is built from blocks the giving district holds at that
 * moment. A block that crosses one way is therefore never part of the return trade: it was
 * not in the receiving district when the question was asked, and committed blocks are
 * locked for every later question. Combining options can still go wrong (two options of one
 * district overlapping, or together cutting it), so a chosen combination is applied in
 * order and re-checked; a failing option is banned and the search runs again.
 */

/** Most transfers in the combination that zeroes one district (a swap counts as two). */
export const REPAIR_MAX_DEPTH = 6;
/** Children kept per search node (best first). */
export const REPAIR_BEAM = 10;
/** Amounts above the residual a menu covers, so a swap has room (x − (x − r)). */
export const REPAIR_SWAP_ROOM = 40;
/** Solver calls per local search (menus and targeted questions; memo hits are free). */
export const REPAIR_CALL_BUDGET = 60;
/** Combinations re-checked per local search before giving up on that district. */
export const REPAIR_VALIDATIONS = 8;
/** Search nodes per local search (CPU guard; the search itself does no solver work). */
export const REPAIR_NODE_BUDGET = 40_000;

/** Solver answers, keyed by the question and the state of the two districts. */
export type RepairMemo = Map<string, Item[]>;

export interface RepairInput {
  graph: EngineGraph;
  solver: BorderSolver;
  allowLongReach?: boolean;
  isCompactTransfer?: (graph: EngineGraph, assignment: Assignment, transfer: Transfer) => boolean;
  weights: CostWeights;
  /** Current state; on success it holds the repaired assignment. */
  tracker: DistrictTracker;
  /** Blocks that may not move (caller's lock plus every block already moved); updated. */
  lock: Uint8Array;
  /** pop − targetBase for every district index 0..k; updated in place. */
  rho: number[];
  hi: 0 | 1;
  /** Per-district upper slack (0 = exact goal, 1 = may keep +1). Defaults to `hi`. */
  memberHi?: ArrayLike<number>;
  /** selected[d] = 1 for districts that must end at q or q + 1. */
  selected: Uint8Array;
  /** absorber[d] = 1 for outside districts allowed to give or take (allowOutsideAbsorb). */
  absorber: Uint8Array;
  /** Neighbors per district; may list 0 (Unassigned) when it is allowed (absorber[0] = 1). */
  adjacency: number[][];
  memo: RepairMemo;
  /** Weights and caller lock; part of every memo key. */
  memoPrefix: string;
  /** State identity of a district (hash of every transfer touching it so far). */
  version: (d: number) => string;
  /** Called after each committed transfer (the caller updates versions). */
  onCommit: (t: Transfer) => void;
  onDebug?: (message: string) => void;
  avoidBorder?: number;
  /**
   * Directed borders (pairKey) the plan already crossed before repair. Used only to avoid a
   * two-way trade with Unassigned; updated with every committed transfer.
   */
  crossed?: Set<number>;
}

export interface RepairStuck {
  district: number;
  /** pop − q when the search gave up. */
  residual: number;
  /** Signed people the district still had to shed (+) or gain (−) to reach q or q + 1. */
  violation: number;
  /** Neighbors whose borders were searched. */
  neighbors: number[];
  solverCalls: number;
}

export type RepairResult =
  | { ok: true; transfers: Transfer[]; longReach: Set<Transfer>; usesWater: Set<Transfer>; solverCalls: number }
  | { ok: false; transfers: Transfer[]; stuck: RepairStuck; solverCalls: number };

interface Item {
  t: Transfer;
  key: string;
  longReach: boolean;
  usesWater: boolean;
  steps: number;
}

/** Signed distance from the zero band [0, hi]: > 0 must shed, < 0 must gain. */
function violation(r: number, hi: number): number {
  return r > hi ? r - hi : r < 0 ? r : 0;
}

function overlaps(a: Uint32Array, b: Uint32Array): boolean {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) return true;
    if (a[i] < b[j]) i++;
    else j++;
  }
  return false;
}

const range = (lo: number, hi: number): number[] => {
  const out: number[] = [];
  for (let x = Math.max(1, lo); x <= hi; x++) out.push(x);
  return out;
};

const roundUp = (x: number, step: number) => Math.ceil(x / step) * step;

export function repairResiduals(input: RepairInput): RepairResult {
  const { graph, hi, selected, absorber, rho, tracker, lock, isCompactTransfer } = input;
  const hiOf = (d: number) => (input.memberHi ? input.memberHi[d] : hi);
  const committed: Transfer[] = [];
  const longReach = new Set<Transfer>();
  const usesWater = new Set<Transfer>();
  let solverCalls = 0;
  /** Solver calls left in the current local search (memo hits are free). */
  let callsLeft = 0;

  const ask = (from: number, to: number, accept: number[], maxOptions: number): Item[] => {
    if (input.avoidBorder === pairKey(from, to)) return [];
    const acceptKey = accept.length > 2 && accept[accept.length - 1] - accept[0] === accept.length - 1
      ? `${accept[0]}-${accept[accept.length - 1]}`
      : accept.join(',');
    const key = `${input.memoPrefix}|${from}>${to}|${acceptKey}|${maxOptions}|${input.version(from)}|${input.version(to)}`;
    let options = input.memo.get(key);
    if (!options) {
      if (callsLeft <= 0) return [];
      callsLeft--;
      solverCalls++;
      const raw = input.solver.solveScored({ graph, assignment: tracker.assignment, from, to, accept, maxOptions, locked: lock, weights: input.weights });
      const acceptSet = new Set(accept);
      options = [];
      const seen = new Set<string>();
      for (const { transfer: opt, stats } of raw) {
        if (stats.longReach && !input.allowLongReach) continue;
        if (opt.from !== from || opt.to !== to) continue;
        const blocks = Uint32Array.from(opt.blocks).sort();
        let sum = 0;
        let valid = blocks.length > 0;
        for (let j = 0; valid && j < blocks.length; j++) {
          const b = blocks[j];
          if (b >= graph.n || (j > 0 && blocks[j - 1] === b) || tracker.assignment[b] !== from || lock[b]) valid = false;
          else sum += graph.pop[b];
        }
        if (!valid || !acceptSet.has(sum)) continue;
        const t: Transfer = { from, to, blocks, people: sum };
        const h = hashSolution([t]);
        if (seen.has(h)) continue;
        seen.add(h);
        options.push({
          t, longReach: !!stats.longReach, usesWater: !!stats.usesWater, key: `${from}>${to}:${h}`,
          steps: stats.steps ?? new Set(t.blocks.map(b => graph.precinctOf[b])).size,
        });
      }
      input.memo.set(key, options);
    }
    return options;
  };

  const allowedNeighbors = (g: number): number[] =>
    input.adjacency[g].filter((n) => selected[n] || absorber[n]);
  const crossed = input.crossed ?? new Set<number>();
  /** Unassigned is in play: search without two-way trades with it first. */
  const unassignedInPlay = !!absorber[0] && input.adjacency.some((list) => list.includes(0));

  /** Find, check and commit the shortest combination that zeroes district f. */
  const localSearch = (f: number): boolean => {
    callsLeft = REPAIR_CALL_BUDGET;
    const root = rho.slice();
    const v0 = (d: number) => violation(root[d], hiOf(d));
    /** End condition for a district after a combination. */
    const okAt = (d: number, r: number): boolean => {
      if (!selected[d]) return true;
      const x = violation(r, hiOf(d));
      if (d === f) return x === 0;
      if (x === 0) return true;
      const x0 = v0(d);
      return Math.sign(x) === Math.sign(x0) && Math.abs(x) <= Math.abs(x0);
    };
    const banned = new Set<string>();
    const rootComps = new Map<number, number>();
    const comps0 = (d: number) => {
      let c = rootComps.get(d);
      if (c === undefined) { c = tracker.components(d); rootComps.set(d, c); }
      return c;
    };
    const menuCache = new Map<string, Item[]>();
    /** True on the first pass: no two-way trade with Unassigned (see the header). */
    let strictUnassigned = false;

    /** Menu of one directed border: cheapest options for any amount in 1..M (one call; three at level 2). */
    const menu = (from: number, to: number, need: number, level: number): Item[] => {
      const big = need <= 20 ? 60 : roundUp(need + REPAIR_SWAP_ROOM, 40);
      const cacheKey = `${from}>${to}|${big}|${level}`;
      const hit = menuCache.get(cacheKey);
      if (hit) return hit;
      const items = [...ask(from, to, range(1, big), 8)];
      if (level >= 2) {
        items.push(...ask(from, to, range(1, 16), 8));
        items.push(...ask(from, to, range(Math.max(1, need - hi), big * 2), 8));
      }
      const seen = new Set<string>();
      const out = items.filter((it) => !seen.has(it.key) && (seen.add(it.key), true));
      menuCache.set(cacheKey, out);
      return out;
    };
    const targetedAsk = (from: number, to: number, set: number[]): Item[] => (set.length ? ask(from, to, set, 2) : []);

    const cur = root.slice();
    const path: Item[] = [];
    const used = new Set<number>();
    const touched = new Map<number, number>();
    let nodes = 0;
    const touch = (d: number, delta: number) => touched.set(d, (touched.get(d) ?? 0) + delta);
    const badList = (): number[] => {
      const out: number[] = [];
      if (!okAt(f, cur[f])) out.push(f);
      for (const [d, c] of touched) if (c > 0 && d !== f && !okAt(d, cur[d])) out.push(d);
      return out;
    };
    const conflicts = (it: Item, extra?: Item): boolean => {
      for (const p of extra ? [...path, extra] : path) {
        if (p.key === it.key) return true;
        if (p.t.from === it.t.from && overlaps(p.t.blocks, it.t.blocks)) return true;
      }
      return false;
    };
    const move = (items: Item[], sign: 1 | -1) => {
      for (const { t } of items) {
        cur[t.from] -= sign * t.people;
        cur[t.to] += sign * t.people;
        touch(t.from, sign);
        touch(t.to, sign);
      }
    };

    /**
     * Depth-first search over moves, `left` = transfers still allowed. A move is one option
     * (one transfer) or a swap on one border (two transfers in opposite directions, scored
     * together, so a large first leg is not judged on its own).
     */
    const dfs = (left: number, level: number): Item[] | null => {
      const bad = badList();
      if (bad.length === 0) return path.slice();
      if (left <= 0 || Math.ceil(bad.length / 2) > left || ++nodes > REPAIR_NODE_BUDGET) return null;
      // Loose ends (districts this combination pushed out) first, then f.
      const others = bad.filter((d) => d !== f).sort((a, b) => Math.abs(violation(cur[b], hiOf(b))) - Math.abs(violation(cur[a], hiOf(a))) || a - b);
      const g = others.length ? others[0] : f;
      const hg = hiOf(g);
      const vg = violation(cur[g], hg);
      const give = vg > 0;
      const need = Math.abs(vg);
      // Amounts (net, into or out of g) that put g in its band.
      const close = give ? range(cur[g] - hg, cur[g]) : range(-cur[g], hg - cur[g]);
      const closeSet = new Set(close);
      type Child = { items: Item[]; badAfter: number; resid: number; outside: number; steps: number; longReach: number; water: number; blocks: number; key: string };
      const children: Child[] = [];
      const seen = new Set<string>();
      const consider = (items: Item[], cost: number) => {
        const key = items.map((it) => it.key).join('+');
        if (seen.has(key)) return;
        seen.add(key);
        move(items, 1);
        const after = badList();
        let resid = 0;
        for (const d of after) resid += Math.abs(violation(cur[d], hiOf(d)));
        move(items, -1);
        if (Math.ceil(after.length / 2) > left - cost) return;
        let blocks = 0;
        let outside = 0;
        let steps = 0;
        let longReach = 0;
        let water = 0;
        for (const it of items) {
          blocks += it.t.blocks.length;
          steps += it.steps;
          longReach += Number(it.longReach);
          water += Number(it.usesWater);
          if (!selected[it.t.from] || !selected[it.t.to]) outside++;
        }
        children.push({ items, badAfter: after.length, resid, outside, steps, longReach, water, blocks, key });
      };
      for (const n of allowedNeighbors(g)) {
        const from = give ? g : n;
        const to = give ? n : g;
        // With Unassigned, one direction per border: no swaps, and no single transfer back
        // over a border this combination already crossed the other way.
        const unassigned = n === 0;
        if (unassigned && strictUnassigned && (used.has(pairKey(to, from)) || crossed.has(pairKey(to, from)))) continue;
        const rightUsed = used.has(pairKey(from, to));
        const lastOnly = bad.some((d) => d !== g && d !== n);
        // Single transfers in the direction g needs.
        if (!rightUsed) {
          let items: Item[];
          if (left === 1) {
            if (lastOnly) continue;
            const set = close.filter((a) => okAt(n, cur[n] + (give ? a : -a)));
            if (!set.length) continue;
            const want = new Set(set);
            items = menu(from, to, need, level).filter((it) => want.has(it.t.people));
            if (!items.length) items = targetedAsk(from, to, set);
          } else {
            items = [...targetedAsk(from, to, close), ...menu(from, to, need, level)];
          }
          for (const it of items) if (!banned.has(it.key) && !conflicts(it)) consider([it], 1);
        }
        // Swaps: x in the needed direction, then y back, with x - y putting g in its band.
        if (left >= 2 && !(unassigned && strictUnassigned) && !rightUsed && !used.has(pairKey(to, from))) {
          const viable = (it: Item) => !banned.has(it.key) && !conflicts(it);
          const xs = menu(from, to, need, level).filter(viable);
          const ys = menu(to, from, need, level).filter(viable);
          const swap = (first: Item[], second: Item[]) => {
            let found = false;
            for (const x of first) for (const y of second) {
              if (!closeSet.has(x.t.people - y.t.people) || conflicts(y, x)) continue;
              consider([x, y], 2);
              found = true;
            }
            return found;
          };
          if (!swap(xs, ys) && (left === 2 || level >= 2)) {
            // Menus may favor the same few amounts. Ask for the exact complements
            // of known options, which can reach a trade omitted by both menus.
            const complements = (items: Item[], sign: number) => [...new Set(items.flatMap(
              it => close.map(net => it.t.people + sign * net).filter(p => p > 0),
            ))].sort((a, b) => a - b);
            if (!swap(xs, targetedAsk(to, from, complements(xs, -1)).filter(viable))) {
              swap(targetedAsk(from, to, complements(ys, 1)).filter(viable), ys);
            }
          }
        }
      }
      // Fewest transfers; then trades inside the group before pushing people onto outside absorbers.
      children.sort((a, b) => a.longReach - b.longReach || a.water - b.water || a.items.length - b.items.length || a.badAfter - b.badAfter || a.outside - b.outside || a.resid - b.resid ||
        (a.steps - b.steps) * input.weights.perStep || a.blocks - b.blocks || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      // Prefer whatever finishes now; then the best few of the rest.
      const finishing = children.filter((c) => c.badAfter === 0);
      const rest = children.filter((c) => c.badAfter > 0).sort((a, b) => a.badAfter - b.badAfter || a.resid - b.resid ||
        a.items.length - b.items.length || a.outside - b.outside || a.longReach - b.longReach || a.water - b.water ||
        (a.steps - b.steps) * input.weights.perStep || a.blocks - b.blocks || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const c of [...finishing.slice(0, 1), ...rest.slice(0, REPAIR_BEAM)]) {
        if (c.items.length > left) continue;
        move(c.items, 1);
        for (const it of c.items) used.add(pairKey(it.t.from, it.t.to));
        path.push(...c.items);
        const r = dfs(left - c.items.length, level);
        path.length -= c.items.length;
        for (const it of c.items) used.delete(pairKey(it.t.from, it.t.to));
        move(c.items, -1);
        if (r) return r;
      }
      return null;
    };

    /** Apply a combination in order, re-checking each option; on failure undo and return the bad index. */
    const applyChecked = (combo: Item[]): number => {
      const applied: Transfer[] = [];
      const reached: Transfer[] = [];
      let badIdx = -1;
      for (let i = 0; i < combo.length && badIdx < 0; i++) {
        const t = combo[i].t;
        let valid = true;
        for (const b of t.blocks) if (tracker.assignment[b] !== t.from || lock[b]) { valid = false; break; }
        if (!valid) { badIdx = i; break; }
        const long = isCompactTransfer ? !isCompactTransfer(graph, tracker.assignment, t) : combo[i].longReach;
        if (long && !input.allowLongReach) { badIdx = i; break; }
        if (long) reached.push(t);
        const cf = comps0(t.from), ct = comps0(t.to);
        tracker.apply(t.blocks, t.to);
        applied.push(t);
        if (tracker.components(t.from) > cf || tracker.components(t.to) > ct) badIdx = i;
      }
      if (badIdx >= 0) {
        for (let i = applied.length - 1; i >= 0; i--) tracker.revert(applied[i].blocks, applied[i].from, applied[i].to);
      } else {
        for (const t of reached) longReach.add(t);
      }
      return badIdx;
    };

    const debugDump = () => {
      if (!input.onDebug) return;
      const lines: string[] = [];
      for (const [key, options] of menuCache) {
        const people = options.map(it => it.t.people).sort((a, b) => a - b);
        lines.push(`  ${key}: ${people.join(' ')}`);
      }
      input.onDebug(`[repair] FAILED focus ${f} rho ${root[f]}\n${lines.join('\n')}`);
    };
    for (let check = 0; check < REPAIR_VALIDATIONS; check++) {
      let combo: Item[] | null = null;
      for (const strict of unassignedInPlay ? [true, false] : [false]) {
        strictUnassigned = strict;
        for (let depth = 1; depth <= REPAIR_MAX_DEPTH && !combo; depth++) {
          nodes = 0;
          combo = dfs(depth, 1);
          if (!combo && depth <= 3) {
            nodes = 0;
            combo = dfs(depth, 2);
          }
        }
        if (combo) break;
      }
      if (!combo) { debugDump(); return false; }
      const badIdx = applyChecked(combo);
      if (badIdx >= 0) {
        banned.add(combo[badIdx].key);
        continue;
      }
      for (const { t, usesWater: crossing } of combo) {
        if (crossing) usesWater.add(t);
        for (const b of t.blocks) lock[b] = 1;
        rho[t.from] -= t.people;
        rho[t.to] += t.people;
        crossed.add(pairKey(t.from, t.to));
        committed.push(t);
        input.onCommit(t);
      }
      return true;
    }
    debugDump();
    return false;
  };

  const k = rho.length - 1;
  for (;;) {
    let f = -1;
    let worst = 0;
    for (let d = 1; d <= k; d++) {
      if (!selected[d]) continue;
      const x = Math.abs(violation(rho[d], hiOf(d)));
      if (x > worst) { worst = x; f = d; }
    }
    if (f < 0) return { ok: true, transfers: committed, longReach, usesWater, solverCalls };
    if (!localSearch(f)) {
      return {
        ok: false,
        transfers: committed,
        solverCalls,
        stuck: { district: f, residual: rho[f], violation: violation(rho[f], hiOf(f)), neighbors: allowedNeighbors(f), solverCalls },
      };
    }
  }
}
