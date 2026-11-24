import type {
  Assignment,
  BorderSolver,
  CostWeights,
  GroupSolveRequest,
  GroupSolveResult,
  InteractionGraph,
  Solution,
  SolutionKind,
  Transfer,
} from '@zd/contracts';
import { DistrictTracker, districtPopulations, pairKey } from './districts';
import { analyzeGroup, extraSlot } from './feasibility';
import { FLOW_PARAMS, planFlow, type BorderFlow, type FlowCostParams } from './flowModel';
import { collectCurves, interactionFromCurves, internalPairs, type CurveCache, type CurveMap } from './interaction';
import { fnv, hashSolution } from './hash';
import { repairResiduals, type RepairMemo, type RepairStuck } from './repair';
import { planMetrics } from './stats';
import { verifyPlan } from './verify';
import { DEFAULT_WEIGHTS, now, resolveWeights } from './weights';

/** Optional engine capabilities, kept outside the shared BorderSolver contract. */
interface CompactSolver extends BorderSolver {
  lastResort?: BorderSolver;
  isCompactTransfer?: (graph: GroupSolveRequest['graph'], assignment: Assignment, transfer: Transfer) => boolean;
}

export type PlanKind = Exclude<SolutionKind, 'single'>;
export const PLAN_KINDS: readonly PlanKind[] = ['fewest-splits', 'fewest-blocks', 'fewest-districts'];

/** Re-plans per round after a border fails or the whole-plan check rejects a plan. */
export const MAX_REPLANS = 12;

/**
 * Rounds per plan kind. A round moves what the borders can carry right now; when a map is
 * far from balanced (unfinished maps), the next round re-measures capacity on the updated
 * plan, with the blocks already moved locked, and continues.
 */
export const MAX_ROUNDS = 8;

/** Flow cost per person left unplaced in a round; dominates every real path cost. */
export const SLACK_COST = 100_000_000;

/** Solver weights used to realize each plan kind, derived from the caller's weights. */
export function kindWeights(kind: PlanKind, base: CostWeights): CostWeights {
  if (kind === 'fewest-blocks') {
    return {
      ...base,
      perBlock: Math.max(base.perBlock * 12, 0.5),
      perPopulatedBlock: Math.max(base.perPopulatedBlock * 20, 2),
      newPrecinctSplit: base.newPrecinctSplit * 0.7,
    };
  }
  return { ...base };
}

/** Scale the fixed per-border charge with the prices of splitting and painting. */
export function flowParams(kind: PlanKind, base: CostWeights): FlowCostParams {
  const p = { ...FLOW_PARAMS[kind] };
  // Split fees averaged over a large capacity witness can otherwise round away.
  p.splitTierCost = {
    low: Math.round(p.tierScale * Math.max(0, base.newPrecinctSplit) / 20_000),
    high: Math.round(p.tierScale * Math.max(0, base.newPrecinctSplit, base.newCountySplit) / 20_000),
  };
  if (p.fixedCharge) {
    const fees = Math.max(0, base.newPrecinctSplit) + Math.max(0, base.perStep);
    p.fixedCharge = Math.round(p.fixedCharge * fees / (DEFAULT_WEIGHTS.newPrecinctSplit + DEFAULT_WEIGHTS.perStep));
  }
  return p;
}

/** Why a plan attempt (or a whole plan kind) failed; reported in the result message. */
export interface PlanFailure {
  kind: PlanKind;
  reason: 'no-progress' | 'retries-exhausted' | 'rounds-exhausted';
  /** People the last flow could not place (0 when the failure was realizing blocks). */
  unmet: number;
  borders: BorderFlow[];
  /** Set when the last attempt failed in residual repair: the district whose residual could not be placed. */
  stuck?: RepairStuck;
}

interface Step {
  from: number;
  to: number;
  people: number;
  transfer: Transfer;
  longReach?: boolean;
  usesWater?: boolean;
}

type RealizeOutcome =
  | { ok: true; steps: Step[]; final: Assignment; tracker: DistrictTracker; lock: Uint8Array; loose: BorderFlow[] }
  | { ok: false; steps: Step[]; final: Assignment; failed: BorderFlow; reason: 'no-option' | 'cut' | 'invalid'; reachable: number };

interface Ctx {
  req: GroupSolveRequest;
  k: number;
  allowLongReach?: boolean;
  /** Called after each realized border with how many remain in this run and the run's length. */
  progress: (remaining: number, runLength: number) => void;
}

/** Largest amounts below a failed target that the probe offers the solver. */
export const PROBE_WINDOW = 48;

/**
 * A border whose exact amount cannot be delivered and is at most this many people is left
 * out of the first stage; residual repair places those people (two-way trades, chains,
 * cycles). Larger borders are realized within a window instead.
 */
export const DEFER_MAX = 12;
/** Half-width of the acceptance window for a large border whose exact amount fails. */
export const WINDOW_MAX = 20;

/**
 * Re-plans per round after residual repair fails (the borders it blames get lower caps, so
 * the flow routes those people another way). Repair is the expensive step, so this is low.
 */
export const MAX_REPAIR_REPLANS = 3;

interface Attempt {
  transfer: Transfer | null;
  longReach?: boolean;
  usesWater?: boolean;
  sawCut: boolean;
  sawInvalid: boolean;
}

/**
 * Ask the solver for `accept` on one border and return the first option that is valid
 * (blocks in `from`, unlocked, unique, total in `accept`) and gives neither district a new
 * piece. The tracker is left unchanged; the caller applies the transfer.
 */
function tryBorder(
  req: GroupSolveRequest,
  tracker: DistrictTracker,
  lock: Uint8Array,
  from: number,
  to: number,
  accept: number[],
  weights: CostWeights,
  before: { from: number; to: number },
  allowLongReach = false,
): Attempt {
  const { graph } = req;
  const acceptSet = new Set(accept);
  const tried = new Set<string>();
  let sawCut = false;
  let sawInvalid = false;
  for (const maxOptions of [1, 5]) {
    const options = req.solver.solveScored({ graph, assignment: tracker.assignment, from, to, accept, maxOptions, locked: lock, weights });
    // No options at all: asking for more cannot help. Fewer than asked: there are no more.
    if (options.length === 0 || (maxOptions > 1 && options.length <= 1)) break;
    for (const { transfer: opt, stats } of options) {
      if (stats.longReach && !allowLongReach) continue;
      const blocks = Uint32Array.from(opt.blocks).sort();
      const key = blocks.join(',');
      if (tried.has(key)) continue;
      tried.add(key);
      let sum = 0;
      let valid = opt.from === from && opt.to === to && blocks.length > 0;
      for (let j = 0; valid && j < blocks.length; j++) {
        const b = blocks[j];
        if (b >= graph.n || (j > 0 && blocks[j - 1] === b) || tracker.assignment[b] !== from || lock[b]) valid = false;
        else sum += graph.pop[b];
      }
      if (!valid || !acceptSet.has(sum)) {
        sawInvalid = true;
        continue;
      }
      tracker.apply(blocks, to);
      const ok = tracker.components(from) <= before.from && tracker.components(to) <= before.to;
      tracker.revert(blocks, from, to);
      if (ok) return { transfer: { from, to, blocks, people: sum }, longReach: stats.longReach, usesWater: stats.usesWater, sawCut, sawInvalid };
      sawCut = true;
    }
  }
  return { transfer: null, sawCut, sawInvalid };
}

/** One border's realization outcome, memoized by the state of its two districts. */
interface MemoEntry {
  transfer: Transfer | null;
  longReach?: boolean;
  usesWater?: boolean;
  reason: 'no-option' | 'cut' | 'invalid';
  reachable: number;
}

/**
 * Memo of border solves. A border's answer depends only on the blocks of its two
 * districts (and the round's starting lock), so the key holds the weights, the round,
 * the border and its number, and a version hash of every earlier transfer touching
 * either district. Re-plans that reshuffle other borders then reuse earlier answers.
 */
export type BorderMemo = Map<string, MemoEntry>;

/** Turn each border's number into blocks, largest first, on the plan as updated so far. */
function realize(
  ctx: Ctx,
  start: Assignment,
  startLock: Uint8Array,
  borders: BorderFlow[],
  weights: CostWeights,
  memo: BorderMemo,
  memoPrefix: string,
): RealizeOutcome {
  const { req, k, allowLongReach } = ctx;
  const { graph } = req;
  const tracker = new DistrictTracker(graph, start, k);
  const lock = startLock.slice();
  const steps: Step[] = [];
  const version = new Map<number, string>();
  const ver = (d: number) => version.get(d) ?? '';

  /** Borders realized off their planned amount (or left out), with the planned amount. */
  const loose: BorderFlow[] = [];
  for (let i = 0; i < borders.length; i++) {
    const border = borders[i];
    const { from, to, people } = border;
    const key = `${memoPrefix}|${from}>${to}:${people}|${ver(from)}|${ver(to)}`;
    const before = () => ({ from: tracker.components(from), to: tracker.components(to) });
    let entry = memo.get(key);
    if (!entry) {
      const attempt = tryBorder(req, tracker, lock, from, to, [people], weights, before(), allowLongReach);
      entry = { transfer: attempt.transfer, longReach: attempt.longReach, usesWater: attempt.usesWater, reason: attempt.sawCut ? 'cut' : attempt.sawInvalid ? 'invalid' : 'no-option', reachable: 0 };
      memo.set(key, entry);
    }
    let transfer = entry.transfer;
    let longReach = entry.longReach;
    let usesWater = entry.usesWater;
    if (!transfer && people <= DEFER_MAX) {
      // Small and not deliverable as one exact transfer: residual repair places it.
      loose.push(border);
      ctx.progress(borders.length - i - 1, borders.length);
      continue;
    }
    if (!transfer) {
      // Large: land within a window; residual repair takes the difference.
      const wKey = `${key}|window`;
      let wEntry = memo.get(wKey);
      if (!wEntry) {
        const w = Math.min(WINDOW_MAX, Math.ceil(people / 5));
        const accept: number[] = [];
        for (let x = people - w; x <= people + w; x++) if (x >= 1 && x !== people) accept.push(x);
        const b = before();
        const attempt = tryBorder(req, tracker, lock, from, to, accept, weights, b, allowLongReach);
        let reachable = 0;
        if (!attempt.transfer) {
          // Probe: the largest amount just below the target this border can carry right now.
          const probeAccept: number[] = [];
          for (let x = people - w - 1; x >= 1 && probeAccept.length < PROBE_WINDOW; x--) probeAccept.push(x);
          const probe = probeAccept.length ? tryBorder(req, tracker, lock, from, to, probeAccept, weights, b, allowLongReach) : null;
          reachable = probe?.transfer ? probe.transfer.people : 0;
        }
        wEntry = { transfer: attempt.transfer, longReach: attempt.longReach, usesWater: attempt.usesWater, reason: entry.reason, reachable };
        memo.set(wKey, wEntry);
      }
      transfer = wEntry.transfer;
      longReach = wEntry.longReach;
      usesWater = wEntry.usesWater;
      if (!transfer) {
        return { ok: false, steps, final: tracker.assignment, failed: border, reason: wEntry.reason, reachable: wEntry.reachable };
      }
      loose.push(border);
    }
    tracker.apply(transfer.blocks, to);
    for (const b of transfer.blocks) lock[b] = 1;
    const h = hashSolution([transfer]);
    version.set(from, fnv(ver(from) + h));
    version.set(to, fnv(ver(to) + h));
    steps.push({ from, to, people: transfer.people, transfer, longReach, usesWater });
    ctx.progress(borders.length - i - 1, borders.length);
  }
  return { ok: true, steps, final: tracker.assignment, tracker, lock, loose };
}

/**
 * Lower a failed border's capacity: to the amount the probe found reachable when there is
 * one, else to half. Always strictly below both the failed amount and any earlier cap, so
 * re-planning terminates.
 */
function lowerCap(caps: Map<number, number>, border: BorderFlow, reachable = 0): void {
  const key = pairKey(border.from, border.to);
  const current = caps.get(key) ?? Infinity;
  let next = reachable > 0 && reachable < border.people ? reachable : Math.floor(border.people / 2);
  if (border.people <= 1) next = 0;
  if (current !== Infinity) next = Math.min(next, current - 1);
  caps.set(key, Math.max(0, next));
}

/**
 * Find a very thin transfer that warrants trying a different flow route.
 * Check only large chunks carrying very few people, so ordinary small fixes
 * and substantial compact moves keep the normal one-pass path.
 */
function severeSpindle(graph: GroupSolveRequest['graph'], assignment: Assignment, steps: Step[]): Transfer | undefined {
  const isLargeForPopulation = ({ blocks, people }: Transfer) => blocks.length >= 40 && blocks.length >= 4 * people;
  if (!steps.some(step => isLargeForPopulation(step.transfer))) return;
  const working = assignment.slice();
  let worst: Transfer | undefined;
  let largest = 1000;
  for (const { transfer } of steps) {
    const { blocks, from, to, people } = transfer;
    if (isLargeForPopulation(transfer)) {
      const moved = new Set(blocks);
      let delta = 0;
      for (const block of blocks) for (let e = graph.adjOffsets[block]; e < graph.adjOffsets[block + 1]; e++) {
        const next = graph.adjTargets[e];
        if (working[next] === to) delta -= graph.adjLen[e];
        else if (working[next] === from && !moved.has(next)) delta += graph.adjLen[e];
      }
      if (delta / people > largest) {
        largest = delta / people;
        worst = transfer;
      }
    }
    for (const block of blocks) working[block] = to;
  }
  return worst;
}

/** Identity of a plan's effect: every moved block with its destination, sorted by block. */
function effectKey(transfers: Transfer[]): string {
  const pairs: Array<[number, number]> = [];
  for (const t of transfers) for (const b of t.blocks) pairs.push([b, t.to]);
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(([b, d]) => `${b}:${d}`).join(',');
}

/** GroupSolveResult plus planner diagnostics (extra fields; the contract type is a subset). */
export interface PlannerResult extends GroupSolveResult {
  /** Plan kinds that produced no plan, and why. */
  failures: PlanFailure[];
  /** Solver calls made by residual repair (diagnostics). */
  repairCalls: number;
}

export interface PlanOptions {
  /** Share capacity curves with buildInteractionGraph (see CurveCache). */
  curveCache?: CurveCache;
  /** Optional report of the cached menus when a residual search fails. */
  onRepairDebug?: (message: string) => void;
}

export function planGroup(req: GroupSolveRequest, options: PlanOptions = {}): PlannerResult {
  const t0 = now();
  const emptyInteraction: InteractionGraph = { nodes: [], edges: [] };
  const fail = (status: GroupSolveResult['status'], message: string, extra?: Partial<GroupSolveResult>): PlannerResult => ({
    status,
    solutions: [],
    message,
    elapsedMs: now() - t0,
    feasibility: { feasible: false, excess: 0, suggestAdd: [] },
    interaction: emptyInteraction,
    failures: [],
    repairCalls: 0,
    ...extra,
  });

  try {
    const { graph, targets } = req;
    const k = targets.numDistricts;
    if (!(k >= 1) || req.assignment.length !== graph.n) return fail('error', 'Assignment length does not match the block graph.');
    if (req.locked && req.locked.length !== graph.n) return fail('error', 'Locked mask length does not match the block graph.');
    const baseWeights = resolveWeights(req.weights);
    const solver: CompactSolver = req.solver;

    const analysis = analyzeGroup(req);
    const members = analysis.components.flatMap((c) => c.members).sort((a, b) => a - b);
    const feasibility = { feasible: analysis.feasible, excess: analysis.excess, suggestAdd: analysis.suggestAdd };
    if (members.length === 0) return fail('error', 'No valid districts selected.', { feasibility });

    const { pops, adjacency } = analysis;
    const curveReq = { graph, assignment: req.assignment, solver: req.solver, locked: req.locked, weights: baseWeights, curveCache: options.curveCache };
    const pairs = internalPairs(members, adjacency);
    const curves: CurveMap = collectCurves(curveReq, pairs);
    const interaction = interactionFromCurves(members, pops, targets, pairs, curves);
    const base = { feasibility, interaction };

    if (!analysis.feasible) return fail('group-unbalanced', analysis.message, base);

    const hi = extraSlot(targets);
    const supply = new Map<number, number>();
    for (const d of members) supply.set(d, pops[d] - targets.q);
    const allZero = members.every((d) => supply.get(d)! >= 0 && supply.get(d)! <= hi);
    if (allZero) return { status: 'already-zero', solutions: [], message: 'Every selected district is already at zero.', elapsedMs: now() - t0, failures: [], repairCalls: 0, ...base };

    const inGroup = new Set(members);
    const absorbers = new Map<number, number>();
    const borders: Array<[number, number]> = [];
    for (const [a, b] of pairs) borders.push([a, b], [b, a]);
    if (req.allowOutsideAbsorb) {
      const allowed = req.absorbers && new Set(req.absorbers);
      const outsidePairs: Array<[number, number]> = [];
      for (const d of members) {
        for (const o of adjacency[d]) {
          if (inGroup.has(o) || (allowed && !allowed.has(o))) continue;
          absorbers.set(o, pops[o] - targets.q);
          outsidePairs.push(d < o ? [d, o] : [o, d]);
          borders.push([d, o], [o, d]);
        }
      }
      collectCurves(curveReq, outsidePairs, curves);
    }

    const baseLock = req.locked ? req.locked.slice() : new Uint8Array(graph.n);
    const allPairs: Array<[number, number]> = [];
    for (const [a, b] of borders) if (a < b) allPairs.push([a, b]);
    let done = 0;
    let total = 0;
    let kindsLeft = PLAN_KINDS.length;
    const ctx: Ctx = {
      req,
      k,
      progress: (remaining, runLength) => {
        done += 1;
        // Estimate: the rest of this run plus one run of the same length per remaining kind.
        total = Math.max(total, done + remaining + Math.max(0, kindsLeft - 1) * runLength);
        req.onProgress?.(done, total);
      },
    };

    /**
     * Capacity for the next round: directions that carried people last round are measured
     * again on the updated plan (moving a border exposes new blocks and uses up old ones);
     * directions nobody used keep their curve. Re-measuring everything was ~2-3x slower on
     * unfinished maps; reusing used curves minus what crossed overstated capacity and cost
     * more in failed borders than it saved.
     */
    const refreshCurves = (activeSolver: BorderSolver, prev: CurveMap, used: Map<number, number>, assignment: Assignment, locked: Uint8Array): CurveMap => {
      const next: CurveMap = new Map();
      for (const [a, b] of allPairs) {
        for (const [from, to] of [[a, b], [b, a]] as const) {
          const key = pairKey(from, to);
          const curve = prev.get(key);
          if ((used.get(key) ?? 0) > 0) next.set(key, activeSolver.capacity({ graph, assignment, from, to, locked, weights: baseWeights }));
          else if (curve) next.set(key, curve);
        }
      }
      return next;
    };

    const memo: BorderMemo = new Map();
    const repairMemo: RepairMemo = new Map();
    let repairCalls = 0;
    const selected = new Uint8Array(k + 1);
    for (const d of members) selected[d] = 1;
    const absorber = new Uint8Array(k + 1);
    for (const o of absorbers.keys()) absorber[o] = 1;
    const planKind = (kind: PlanKind, firstCurves = curves, allowLongReach = false): { solution: Solution } | { failure: PlanFailure } => {
      const activeSolver = allowLongReach ? solver.lastResort! : solver;
      const runCtx: Ctx = allowLongReach ? { ...ctx, req: { ...req, solver: activeSolver }, allowLongReach } : ctx;
      const weights = kindWeights(kind, baseWeights);
      const params = flowParams(kind, baseWeights);
      let cur: Assignment = req.assignment;
      const curLock = baseLock.slice();
      const steps: Step[] = [];
      let lastUnmet = Infinity;
      let prevCurves: CurveMap | null = null;
      let prevUsed = new Map<number, number>();
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const roundPops = round === 0 ? pops : districtPopulations(graph, cur, k);
        const roundSupply = new Map<number, number>();
        for (const d of members) roundSupply.set(d, roundPops[d] - targets.q);
        const roundAbsorbers = new Map<number, number>();
        for (const o of absorbers.keys()) roundAbsorbers.set(o, roundPops[o] - targets.q);
        const roundCurves: CurveMap = round === 0 ? firstCurves : refreshCurves(activeSolver, prevCurves!, prevUsed, cur, curLock);
        prevCurves = roundCurves;
        const caps = new Map<number, number>();
        const memoPrefix = `${allowLongReach}|${JSON.stringify(weights)}|${fnv(steps.map((st) => hashSolution([st.transfer])).join(','))}`;
        // Each failure re-plans the whole round from the flow step (keeping the borders
        // realized so far was tried: it fragments plans into many tiny borders that then
        // fail). The memo makes repeated borders free.
        type Round = { steps: Step[]; final: Assignment; unmet: number };
        let success: Round | null = null;
        let incumbent: Round | null = null;
        let avoidBorder: number | undefined;
        let retryThrough = MAX_REPLANS;
        let lastBorders: BorderFlow[] = [];
        let lastUnmetFlow = 0;
        let lastStuck: RepairStuck | undefined;
        let repairFailures = 0;
        for (let attempt = 0; attempt <= retryThrough && !success; attempt++) {
          const flow = planFlow({ members, supply: roundSupply, hi, borders, curves: roundCurves, absorbers: roundAbsorbers, caps, params, slackCost: SLACK_COST });
          lastBorders = flow.borders;
          lastUnmetFlow = flow.unmet;
          // The curve can miss a small amount entirely. Repair may still place it
          // with real transfers, including a swap that has no net flow arc.
          const repairNow: boolean = flow.unmet === 0 || (flow.unmet <= 80 && !incumbent);
          if (!flow.feasible || (flow.borders.length === 0 && !repairNow)) break;
          if ((repairFailures > 0 || incumbent) && !repairNow) break;
          const out = realize(runCtx, cur, curLock, flow.borders, weights, memo, memoPrefix);
          if (!out.ok) {
            lowerCap(caps, out.failed, out.reachable);
            continue;
          }
          let roundSteps = out.steps;
          if (repairNow) {
            // Stage 2: place what the first stage left out or missed (two-way trades, chains, cycles).
            const rho = districtPopulations(graph, out.final, k).map((p) => p - targets.q);
            const needsRepair = members.some((d) => rho[d] < 0 || rho[d] > hi);
            if (needsRepair) {
              const ver = new Map<number, string>();
              const bump = (t: Transfer) => {
                const h = hashSolution([t]);
                ver.set(t.from, fnv((ver.get(t.from) ?? '') + h));
                ver.set(t.to, fnv((ver.get(t.to) ?? '') + h));
              };
              for (const st of steps) bump(st.transfer);
              for (const st of out.steps) bump(st.transfer);
              const rep = repairResiduals({
                graph,
                solver: activeSolver,
                isCompactTransfer: solver.isCompactTransfer,
                allowLongReach,
                weights,
                tracker: out.tracker,
                lock: out.lock,
                rho,
                hi,
                selected,
                absorber,
                adjacency,
                memo: repairMemo,
                memoPrefix: `${allowLongReach}|${JSON.stringify(weights)}`,
                version: (d) => ver.get(d) ?? '',
                onDebug: options.onRepairDebug,
                avoidBorder,
                onCommit: (t) => {
                  bump(t);
                  ctx.progress(0, 1);
                },
              });
              repairCalls += rep.solverCalls;
              if (!rep.ok) {
                lastStuck = rep.stuck;
                const d = rep.stuck.district;
                const blame = out.loose.filter((b) => b.from === d || b.to === d);
                if (out.loose.length === 0 || ++repairFailures > MAX_REPAIR_REPLANS) break;
                for (const b of blame.length ? blame : out.loose) lowerCap(caps, b);
                continue;
              }
              roundSteps = [...out.steps, ...rep.transfers.map((t) => ({ from: t.from, to: t.to, people: t.people, transfer: t, longReach: rep.longReach.has(t), usesWater: rep.usesWater.has(t) }))];
            }
            const check = verifyPlan({
              graph,
              assignment: req.assignment,
              targets,
              districts: members,
              allowOutsideAbsorb: req.allowOutsideAbsorb,
              absorbers: req.absorbers,
              transfers: [...steps, ...roundSteps].map((st) => st.transfer),
              locked: req.locked,
            });
            if (!check.ok) {
              // Rare: every step was already checked as it was made.
              const bad = new Set(check.issues.map((i) => i.district).filter((d): d is number => d !== undefined));
              let idx = roundSteps.length - 1;
              for (let i = roundSteps.length - 1; i >= 0; i--) {
                if (bad.has(roundSteps[i].from) || bad.has(roundSteps[i].to)) { idx = i; break; }
              }
              lowerCap(caps, roundSteps[idx]);
              continue;
            }
          }
          lastStuck = undefined;
          const candidate: Round = { steps: roundSteps, final: out.tracker.assignment, unmet: repairNow ? 0 : flow.unmet };
          if (candidate.unmet === 0) {
            const water = roundSteps.find(step => step.usesWater)?.transfer;
            const problem = water ?? (weights.perimeterPerMeter > 0 ? severeSpindle(graph, cur, roundSteps) : undefined);
            if (!incumbent && problem && attempt < MAX_REPLANS) {
              incumbent = candidate;
              avoidBorder = pairKey(problem.from, problem.to);
              caps.set(avoidBorder, 0);
              retryThrough = attempt + 1;
              continue;
            }
            if (incumbent) {
              const cost = (value: Round) => planMetrics(graph, cur, value.final,
                value.steps.map(st => st.transfer), targets, weights, inGroup).stats.cost;
              const compare = (a: Round, b: Round) =>
                a.steps.filter(step => step.longReach).length - b.steps.filter(step => step.longReach).length ||
                a.steps.filter(step => step.usesWater).length - b.steps.filter(step => step.usesWater).length ||
                cost(a) - cost(b);
              if (compare(incumbent, candidate) < 0) {
                success = incumbent;
                continue;
              }
            }
          }
          success = candidate;
        }
        success ??= incumbent;
        if (!success) {
          const reason = lastBorders.length === 0 && lastUnmetFlow > 0 ? 'no-progress' : 'retries-exhausted';
          return { failure: { kind, reason, borders: lastBorders, unmet: lastUnmetFlow, ...(lastStuck ? { stuck: lastStuck } : {}) } };
        }
        steps.push(...success.steps);
        prevUsed = new Map();
        for (const st of success.steps) prevUsed.set(pairKey(st.from, st.to), (prevUsed.get(pairKey(st.from, st.to)) ?? 0) + st.people);
        cur = success.final;
        for (const st of success.steps) for (const b of st.transfer.blocks) curLock[b] = 1;
        if (success.unmet === 0) {
          const transfers = steps.map((st) => st.transfer);
          const metrics = planMetrics(graph, req.assignment, cur, transfers, targets, baseWeights, inGroup);
          if (steps.some(step => step.longReach)) metrics.stats.longReach = true;
          if (steps.some(step => step.usesWater)) metrics.stats.usesWater = true;
          const flows = new Map<number, { from: number; to: number; people: number }>();
          for (const st of steps) {
            const key = pairKey(st.from, st.to);
            const f = flows.get(key);
            if (f) f.people += st.people;
            else flows.set(key, { from: st.from, to: st.to, people: st.people });
          }
          return {
            solution: {
              id: `${kind}-${hashSolution(transfers)}`,
              kind,
              transfers,
              borderFlows: [...flows.values()],
              stats: metrics.stats,
              deviations: metrics.deviations,
            },
          };
        }
        if (success.unmet >= lastUnmet) return { failure: { kind, reason: 'no-progress', borders: [], unmet: success.unmet } };
        lastUnmet = success.unmet;
      }
      return { failure: { kind, reason: 'rounds-exhausted', borders: [], unmet: lastUnmet } };
    };

    const solutions: Solution[] = [];
    const seenEffects = new Set<string>();
    const failures: PlanFailure[] = [];
    for (const kind of PLAN_KINDS) {
      const r = planKind(kind);
      kindsLeft--;
      if ('solution' in r) {
        const key = effectKey(r.solution.transfers);
        if (!seenEffects.has(key)) {
          seenEffects.add(key);
          solutions.push(r.solution);
        }
      } else {
        failures.push(r.failure);
      }
    }
    if (!solutions.length && solver.lastResort) {
      kindsLeft = 1;
      const relaxed = collectCurves({ ...curveReq, solver: solver.lastResort }, allPairs);
      // The first complete retry is enough. This pass exists to rescue the request.
      for (const kind of PLAN_KINDS) {
        const r = planKind(kind, relaxed, true);
        if ('solution' in r) {
          solutions.push(r.solution);
          break;
        }
      }
    }
    req.onProgress?.(done, done);

    if (solutions.length === 0) {
      const f = failures[0];
      const stuck = failures.find((x) => x.stuck)?.stuck;
      const detail = !f
        ? 'No plan found.'
        : stuck
          ? `District ${stuck.district} is still ${Math.abs(stuck.violation).toLocaleString('en-US')} ${stuck.violation > 0 ? 'over' : 'under'}: no combination of deliverable transfers with Districts ${stuck.neighbors.join(', ')} (one-way, two-way, chains or cycles) places it.`
          : f.reason === 'retries-exhausted' && f.borders.length
          ? `Could not realize ${f.borders.map((b) => `${b.from} → ${b.to}: ${b.people}`).join(', ')}.`
          : `The borders between these districts cannot carry enough people (${f.unmet.toLocaleString('en-US')} left over).`;
      return { status: 'needs-precinct-rework', solutions: [], message: `${detail} Needs precinct-level rework.`, elapsedMs: now() - t0, failures, repairCalls, ...base };
    }
    const landPlans = solutions.filter(plan => !plan.stats.usesWater);
    const ranked = landPlans.length ? landPlans : solutions;
    ranked.sort((a, b) => Number(!!a.stats.longReach) - Number(!!b.stats.longReach) || a.stats.cost - b.stats.cost);
    return { status: 'ok', solutions: ranked, message: analysis.message, elapsedMs: now() - t0, failures, repairCalls, ...base };
  } catch (err) {
    return fail('error', `Planner error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
