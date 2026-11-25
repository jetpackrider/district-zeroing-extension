import type {
  AreaPreference, BorderSolveRequest, BorderSolver, CapacityCurve, DistrictSolveRequest, Solution,
  SolutionStats, SolveResult, Transfer,
} from '@zd/contracts';
import { COMPACT_DEPTH, isCompactTransfer } from './compact';
import { blockOrder, choose, type TableCache } from './knapsack';
import { defaults, Model } from './model';
import { isLandContiguous, landView, meetOnLand, settleOnFullGraph } from './land';
import { compareBlocks, compareChunks, generate, realize, type Border, type Chunk } from './search';
import {
  computeBorderReachability, fallbackSearch,
  type BorderReachability, type BorderReachabilityRequest,
} from './fallback';

export type { BorderSolver } from '@zd/contracts';
export type { BorderReachability, BorderReachabilityRequest } from './fallback';
export { isLandContiguous, landView } from './land';
export { measureTransferShape, type TransferShape } from './shape';

type Scored = { transfers: Transfer[]; stats: SolutionStats };

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function compare(a: Scored, b: Scored) {
  const difference = Number(!!a.stats.longReach) - Number(!!b.stats.longReach) || a.stats.cost - b.stats.cost || a.stats.blocks - b.stats.blocks ||
    a.stats.perimeterDeltaM - b.stats.perimeterDeltaM;
  if (difference) return difference;
  const blocks = compareBlocks(blockOrder(a.transfers), blockOrder(b.transfers));
  if (blocks) return blocks;
  for (let i = 0; i < Math.min(a.transfers.length, b.transfers.length); i++) {
    const x = a.transfers[i], y = b.transfers[i];
    const difference = x.from - y.from || x.to - y.to || compareBlocks(x.blocks, y.blocks);
    if (difference) return difference;
  }
  return a.transfers.length - b.transfers.length;
}

function signature(result: Pick<Scored, 'transfers'>) {
  return result.transfers.map(t => `${t.from}>${t.to}:${t.blocks.join(',')}`).join(';');
}

function maxSolutions(value = 5) {
  return Number.isFinite(value) ? Math.min(8, Math.max(1, Math.trunc(value))) : 5;
}

function search(model: Model, borders: Border[], accept: number[], maxOptions?: number, locked?: Uint8Array) {
  const wanted = maxSolutions(maxOptions);
  const solutions: Scored[] = [];
  const seen = new Set<string>();
  const penalties = new Map<number, number>();
  const depths = model.allowLongReach ? [4, 7, 11] : [COMPACT_DEPTH];
  for (const depth of depths) {
    const groups = generate(model, borders, depth, locked);
    const banned = new Set<Chunk>();
    const directBans = new Set<Chunk>();
    const cutCounts = new Map<number, number>();
    const tables: TableCache = new Map();
    let prune = true;
    const maxAttempts = Math.max(15, wanted * 5);
    for (let attempt = 0; attempt < maxAttempts && solutions.length < wanted; attempt++) {
      const chunks = choose(groups, accept, penalties, banned, model.weights.neighborDeviation, tables);
      if (!chunks?.length) {
        if (!prune || banned.size === directBans.size) break;
        // Try the remaining alternatives if provisional cut or precinct pruning was too restrictive.
        prune = false;
        banned.clear();
        for (const chunk of directBans) banned.add(chunk);
        attempt--;
        continue;
      }
      const result = realize(model, chunks, accept, locked, borders);
      if ('offender' in result) {
        const { cut, offender, repaired } = result;
        banned.add(offender);
        directBans.add(offender);
        const group = groups.find(g => g.border === offender.border && g.precinct === offender.precinct)!;
        let repairedChunk: Chunk | undefined;
        if (repaired && repaired.people <= accept[accept.length - 1]) {
          const options = group.byPopulation.get(repaired.people) ?? [];
          repairedChunk = options.find(option => compareBlocks(option.blocks, repaired.blocks) === 0);
          if (!repairedChunk) {
            repairedChunk = repaired;
            options.push(repaired);
            options.sort(compareChunks);
            group.byPopulation.set(repaired.people, options);
          }
        }
        if (prune && (cut || solutions.length > 0)) {
          const cuts = (cutCounts.get(offender.precinct) ?? 0) + 1;
          cutCounts.set(offender.precinct, cuts);
          if (cut || cuts >= 2) {
            for (const options of group.byPopulation.values()) for (const option of options) {
              if (option === repairedChunk) continue;
              if (cuts >= 2 || (cut &&
                  option.blocks.filter(block => cut.boundary.has(block)).length === cut.boundary.size &&
                  !cut.piece.every(block => option.blocks.includes(block)))) {
                banned.add(option);
              }
            }
          }
        }
        continue;
      }
      const id = signature(result);
      if (!seen.has(id)) {
        seen.add(id);
        solutions.push(result);
        const precincts = new Set<number>();
        for (const transfer of result.transfers) for (const block of transfer.blocks) {
          precincts.add(model.graph.precinctOf[block]);
        }
        for (const precinct of precincts) penalties.set(precinct, (penalties.get(precinct) ?? 0) + 110);
      } else {
        const chunk = chunks[0];
        directBans.add(chunk);
        banned.add(chunk);
      }
    }

    if (depth === depths.at(-1) && !solutions.length) {
      // A combination may strand a small populated lobe even when none of its
      // chunks cut the district alone. Probe nearby subtotals for such repairs.
      const nearby = [...new Set(accept.flatMap(goal =>
        Array.from({ length: Math.min(goal - 1, 128) }, (_, i) => goal - 1 - i),
      ))].filter(people => !accept.includes(people)).sort((a, b) => a - b);
      const noBans = new Set<Chunk>();
      for (let probe = 0; probe < 6 && nearby.length && solutions.length < wanted; probe++) {
        const chunks = choose(groups, nearby, penalties, noBans, model.weights.neighborDeviation, tables, true);
        if (!chunks?.length) break;
        const subtotal = chunks.reduce((sum, chunk) => sum + chunk.people, 0);
        nearby.splice(nearby.indexOf(subtotal));
        const result = realize(model, chunks, accept, locked, borders);
        if ('offender' in result) continue;
        const id = signature(result);
        if (!seen.has(id)) {
          seen.add(id);
          solutions.push(result);
        }
      }
    }
    if (solutions.length >= wanted) break;
  }
  if (solutions.length < wanted) {
    fallbackSearch(model, borders, accept, wanted, solutions, seen, locked, capacityWitnesses);
  }
  return solutions.sort(compare).slice(0, wanted);
}

function compareBorderOptions(
  a: { transfer: Transfer; stats: SolutionStats }, b: { transfer: Transfer; stats: SolutionStats },
): number {
  return compare({ transfers: [a.transfer], stats: a.stats }, { transfers: [b.transfer], stats: b.stats });
}

/** Conservative cumulative capacity backed by a valid transfer at each advertised endpoint. */
function capacityWitnesses(model: Model, border: Border, locked?: Uint8Array) {
  const groups = generate(model, [border], model.allowLongReach ? 11 : COMPACT_DEPTH, locked);
  const selected = new Map<number, Chunk>();
  const witnesses: Array<{ tier: number; transfer: Transfer; stats: SolutionStats }> = [];
  let prior = 0;
  for (let tier = 0; tier < 3; tier++) {
    const next = new Map(selected);
    for (const group of groups) {
      let best = next.get(group.precinct);
      for (const [people, options] of group.byPopulation) {
        if (people <= (best?.people ?? 0)) continue;
        const option = options.find(chunk => chunk.tier <= tier);
        if (option) best = option;
      }
      if (best) next.set(group.precinct, best);
    }
    const chunks = [...next.values()];
    while (chunks.length) {
      const people = chunks.reduce((sum, chunk) => sum + chunk.people, 0);
      if (people <= prior) break;
      const result = realize(model, chunks, undefined, locked);
      if ('offender' in result) {
        const previous = selected.get(result.offender.precinct);
        const index = chunks.indexOf(result.offender);
        if (previous && previous !== result.offender) chunks[index] = previous;
        else if (!previous) chunks.splice(index, 1);
        else break;
        continue;
      }
      const [transfer] = result.transfers;
      if (transfer.people <= prior) break;
      const { stats } = result;
      if (tier < 2 && (stats.newCountySplits || stats.newTownSplits)) break;
      if (tier === 0 && stats.newPrecinctSplits) break;
      witnesses.push({ tier, transfer, stats });
      prior = transfer.people;
      selected.clear();
      for (const chunk of chunks) selected.set(chunk.precinct, chunk);
      break;
    }
  }
  return witnesses;
}

function solveScoredRaw(req: BorderSolveRequest, allowLongReach = false) {
  const { graph, assignment, from, to, weights, locked } = req;
  // Either side may be Unassigned (0): the caller decided it may trade (see UNASSIGNED).
  if (from === to) return [];
  const accept = [...new Set(req.accept.filter(n => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
  if (!accept.length) return [];
  const border = { from, to, limit: accept[accept.length - 1] };
  const model = new Model(graph, assignment, weights, true, allowLongReach);
  const found = search(model, [border], accept, req.maxOptions, locked);
  if (found.length) return found.map(s => ({ transfer: s.transfers[0], stats: s.stats }));
  return capacityWitnesses(model, { ...border, limit: Infinity }, locked)
    .filter(s => accept.includes(s.transfer.people))
    .sort(compareBorderOptions)
    .slice(0, maxSolutions(req.maxOptions))
    .map(({ transfer, stats }) => ({ transfer, stats }));
}

/** Recount exact scores after settlement, including newly touched precincts. */
function settledStats(
  stats: SolutionStats, original: Transfer[], settled: Transfer[], graph: BorderSolveRequest['graph'],
  assignment: BorderSolveRequest['assignment'], overrides?: Partial<typeof defaults>,
): SolutionStats {
  const model = new Model(graph, assignment, overrides, true);
  const after = assignment.slice();
  for (const t of original) for (const b of t.blocks) after[b] = t.to;
  const originalCost = model.score(original, after).cost;
  for (const t of settled) for (const b of t.blocks) after[b] = t.to;
  const recount = model.score(settled, after);
  return { ...recount, cost: recount.cost + stats.cost - originalCost,
    ...(stats.longReach ? { longReach: true } : {}) };
}

/**
 * Land first (see land.ts): solve on the land-only view. The full graph, where shores count as
 * adjacent across water, is used only for two districts that do not meet on land at all; such
 * options are marked `usesWater`. Where the districts do meet on land and no land move hits the
 * number, the answer is "none": the planner then tries another amount, a two-way trade or another
 * border, all of which beat sending a waterfront block across a river.
 */
function solveScored(req: BorderSolveRequest, allowLongReach = false) {
  const land = landView(req.graph);
  if (!land) return solveScoredRaw(req, allowLongReach);
  const out: Array<{ transfer: Transfer; stats: SolutionStats }> = [];
  const landReq = { ...req, graph: land };
  const settle = (options: ReturnType<typeof solveScoredRaw>) => {
    if (!options.length) return;
    const fullModel = new Model(req.graph, req.assignment, req.weights, true);
    for (const option of options) {
      const transfer = settleOnFullGraph(fullModel, option.transfer, req.locked);
      if (!transfer) continue;
      const compact = isCompactTransfer(req.graph, req.assignment, transfer);
      if (!compact && !allowLongReach) continue;
      const stats = transfer === option.transfer ? option.stats :
        settledStats(option.stats, [option.transfer], [transfer], land, req.assignment, req.weights);
      if (!compact) stats.longReach = true;
      else if (stats.longReach) delete stats.longReach;
      out.push({ transfer, stats });
    }
  };
  const landOptions = solveScoredRaw(landReq, allowLongReach);
  settle(landOptions);
  if (!out.length && landOptions.length && maxSolutions(req.maxOptions) < 5) {
    settle(solveScoredRaw({ ...landReq, maxOptions: 5 }, allowLongReach));
  }
  if (out.length || meetOnLand(land, req.assignment, req.from, req.to, req.locked)) {
    return out.sort(compareBorderOptions).slice(0, maxSolutions(req.maxOptions));
  }
  return solveScoredRaw(req, allowLongReach).map(option => isLandContiguous(land, req.assignment, [option.transfer])
    ? option : { transfer: option.transfer, stats: { ...option.stats, usesWater: true } });
}

/** What a person costs to send across water, per person, so the planner does it last. */
const WATER_COST_PER_PERSON = 200;
const LONG_REACH_COST_PER_PERSON = 1000;

/**
 * Capacity over land. Two districts that do not meet on land at all report what could cross the
 * water between them as a single expensive tier, so a plan can still use that border when
 * nothing else reaches (an island district, say) but never prefers it.
 */
function capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>, allowLongReach = false): CapacityCurve {
  const land = landView(req.graph);
  if (!land) return capacityRaw(req, allowLongReach);
  if (meetOnLand(land, req.assignment, req.from, req.to, req.locked)) return capacityRaw({ ...req, graph: land }, allowLongReach);
  const people = capacityRaw(req, allowLongReach).tiers.reduce((sum, tier) => sum + tier.people, 0);
  return { from: req.from, to: req.to, tiers: people ? [{ kind: 'high', people, costPerPerson: WATER_COST_PER_PERSON }] : [] };
}

/** Search wider only in a planner retry after all compact plan kinds failed. */
function solveLastResort(req: BorderSolveRequest) {
  const compact = solveScored(req);
  if (compact.length) return compact;
  const relaxed = solveScored(req, true).sort((a, b) =>
    Number(!!a.stats.longReach) - Number(!!b.stats.longReach));
  return relaxed[0]?.stats.longReach ? relaxed : relaxed.filter(option => !option.stats.longReach);
}

const lastResort: BorderSolver = {
  solveScored: solveLastResort,
  solve(req) { return solveLastResort(req).map(s => s.transfer); },
  capacity(req) {
    const compact = capacity(req);
    const total = (curve: CapacityCurve) => curve.tiers.reduce((sum, tier) => sum + tier.people, 0);
    const extra = total(capacity(req, true)) - total(compact);
    if (extra > 0) compact.tiers.push({ kind: 'high', people: extra, costPerPerson: LONG_REACH_COST_PER_PERSON });
    return compact;
  },
};

export const borderSolver = {
  solveScored(req) { return solveScored(req); },
  solve(req) { return solveScored(req).map(s => s.transfer); },
  capacity(req) { return capacity(req); },
  lastResort,
  isCompactTransfer,
} satisfies BorderSolver & { lastResort: BorderSolver; isCompactTransfer: typeof isCompactTransfer };

function capacityRaw(
  { graph, assignment, from, to, weights, locked }: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>,
  allowLongReach = false,
): CapacityCurve {
  const tiers: CapacityCurve['tiers'] = [];
  // With Unassigned (0) on either side, only the district's rules limit what can cross:
  // Unassigned has room for anyone, but only blocks that can actually move are counted.
  if (from === to) return { from, to, tiers };
  const names = ['no-split', 'low', 'high'] as const;
  let lastPeople = 0, lastCost = 0, marginalCost = 0;
  for (const { tier, transfer, stats } of capacityWitnesses(new Model(graph, assignment, weights, true, allowLongReach),
    { from, to, limit: Infinity }, locked)) {
    const people = transfer.people - lastPeople;
    marginalCost = Math.max(marginalCost, (stats.cost - lastCost) / people);
    tiers.push({ kind: names[tier], people, costPerPerson: marginalCost });
    lastPeople = transfer.people;
    lastCost = stats.cost;
  }
  return { from, to, tiers };
}

export function borderReachability(req: BorderReachabilityRequest): BorderReachability {
  return computeBorderReachability(req, capacityWitnesses);
}

export function solveDistrict(req: DistrictSolveRequest): SolveResult {
  // No area: exactly the search as before (the area code below is never entered).
  return req.area ? solveDistrictInArea(req, req.area) : solveDistrictAnywhere(req);
}

/** Unassigned (0) trades only with permission: listed in `absorbers`, or `includeUnassigned`. */
function unassignedPermitted(req: DistrictSolveRequest): boolean {
  return req.absorbers ? req.absorbers.includes(0) : !!req.includeUnassigned;
}

/**
 * The one-district solve with no area. `locked` blocks never move (the area's 'only' mode
 * locks every block outside the area); absent = every block may move, as before areas existed.
 */
function solveDistrictAnywhere(req: DistrictSolveRequest, locked?: Uint8Array): SolveResult {
  const result = solveDistrictSettled(req, locked);
  if (unassignedPermitted(req)) rankRealNeighborsFirst(result.solutions, req.district);
  return result;
}

/** How many moved blocks lie outside the area (SolutionStats.outsideArea). */
export function countOutsideArea(transfers: readonly Transfer[], inside: Uint8Array): number {
  let outside = 0;
  for (const t of transfers) for (const b of t.blocks) if (inside[b] !== 1) outside++;
  return outside;
}

/** outside[b] = 1 for every block not in the area: what the 'only' mode locks. */
function outsideMask(inside: Uint8Array): Uint8Array {
  const outside = new Uint8Array(inside.length);
  for (let b = 0; b < inside.length; b++) if (inside[b] !== 1) outside[b] = 1;
  return outside;
}

/** The option with its outsideArea count filled in. */
function withOutsideCount(solution: Solution, inside: Uint8Array): Solution {
  return { ...solution, stats: { ...solution.stats, outsideArea: countOutsideArea(solution.transfers, inside) } };
}

/**
 * True when some block inside the area lies on the district's border with a neighbor it may
 * trade with (on either side of it). When none does, no move can stay inside the area.
 */
function areaTouchesBorder(req: DistrictSolveRequest, inside: Uint8Array): boolean {
  const { graph, assignment, district, absorbers } = req;
  const unassigned = unassignedPermitted(req);
  for (let b = 0; b < graph.n; b++) {
    if (assignment[b] !== district) continue;
    for (let e = graph.adjOffsets[b]; e < graph.adjOffsets[b + 1]; e++) {
      const next = graph.adjTargets[e];
      const d = assignment[next];
      if (d === district || !(d ? !absorbers || absorbers.includes(d) : unassigned)) continue;
      if (inside[b] === 1 || inside[next] === 1) return true;
    }
  }
  return false;
}

/**
 * The order AreaPreference asks for: fewest blocks outside the area first (all inside = 0
 * comes before everything else), then, among options with the same count, a real neighbor
 * brought closer to zero before Unassigned (rankRealNeighborsFirst), then the search's own
 * order (compare: cost, then the tie-breaks).
 */
function rankByArea(solutions: Solution[], district: number, unassigned: boolean): Solution[] {
  const counts = [...new Set(solutions.map(s => s.stats.outsideArea ?? 0))].sort((a, b) => a - b);
  const ranked: Solution[] = [];
  for (const count of counts) {
    const bucket = solutions.filter(s => (s.stats.outsideArea ?? 0) === count).sort(compare);
    if (unassigned) rankRealNeighborsFirst(bucket, district);
    ranked.push(...bucket);
  }
  return ranked;
}

/**
 * One district with an area the user marked (AreaPreference). The search runs first with every
 * block outside the area locked, so it finds the options that move only blocks inside, exactly
 * as it would with those blocks painted. 'only' stops there. 'prefer' fills any places left
 * (fewer than `maxOptions` inside) with the options the search finds with no area, fewest outside
 * blocks first. Every option carries stats.outsideArea.
 */
function solveDistrictInArea(req: DistrictSolveRequest, area: AreaPreference): SolveResult {
  const start = now();
  const { inside } = area;
  if (!(inside instanceof Uint8Array) || inside.length !== req.graph.n) {
    return { status: 'error', solutions: [], elapsedMs: now() - start, message: 'The area does not match the block graph.' };
  }
  const plain: DistrictSolveRequest = { ...req, area: undefined };
  const wanted = maxSolutions(req.maxOptions);
  const unassigned = unassignedPermitted(req);
  const within = solveDistrictAnywhere(plain, outsideMask(inside));
  // 'already-zero' and 'error' do not depend on where blocks may move.
  if (within.status === 'already-zero' || within.status === 'error') return { ...within, elapsedMs: now() - start };
  const found = within.solutions.map(s => withOutsideCount(s, inside));

  if (area.mode === 'only') {
    if (found.length) return { status: 'ok', solutions: found, elapsedMs: now() - start };
    let message: string;
    if (!areaTouchesBorder(req, inside)) {
      message = `The area does not reach District ${req.district}'s border, so no move can stay inside it. ` +
        'Mark an area over the border, or choose Prefer.';
    } else if (solveDistrictAnywhere(plain).solutions.length) {
      // The area is the reason: the same search with no area finds moves.
      message = 'No move made only of blocks inside the area hits the target; there are moves that go outside it. ' +
        'Choose Prefer to see them, or mark a larger area.';
    } else {
      message = within.message ?? 'No move hits the target.';
    }
    return { status: 'needs-precinct-rework', solutions: [], elapsedMs: now() - start, message };
  }

  // 'prefer': enough inside, or fill the remaining places with options that go outside.
  if (found.length >= wanted) {
    return { status: 'ok', solutions: rankByArea(found, req.district, unassigned).slice(0, wanted), elapsedMs: now() - start };
  }
  const anywhere = solveDistrictAnywhere(plain);
  const seen = new Set(found.map(s => s.id));
  const merged = [...found];
  for (const solution of anywhere.solutions) {
    if (seen.has(solution.id)) continue;
    seen.add(solution.id);
    merged.push(withOutsideCount(solution, inside));
  }
  const solutions = rankByArea(merged, req.district, unassigned).slice(0, wanted);
  const elapsedMs = now() - start;
  if (!solutions.length) return { ...anywhere, solutions: [], elapsedMs };
  return {
    status: 'ok', solutions, elapsedMs,
    ...(found.length ? {} : { message: 'Nothing inside the area hits the target; these options move blocks outside it.' }),
  };
}

function solveDistrictSettled(req: DistrictSolveRequest, locked?: Uint8Array): SolveResult {
  const land = landView(req.graph);
  if (!land) return solveDistrictRaw(req, locked);
  const start = now();
  const first = solveDistrictRaw({ ...req, graph: land }, locked);
  if (first.status !== 'ok') {
    // 'already-zero' and 'error' do not depend on adjacency.
    if (first.status !== 'needs-precinct-rework') return first;
  } else {
    const solutions: Solution[] = [];
    for (const solution of first.solutions) {
      const working = Uint16Array.from(req.assignment);
      const transfers: Transfer[] = [];
      let extra = 0;
      for (const original of solution.transfers) {
        const transfer = settleOnFullGraph(new Model(req.graph, working, req.weights, true), original, locked);
        if (!transfer || !isCompactTransfer(req.graph, working, transfer)) break;
        for (const b of transfer.blocks) working[b] = transfer.to;
        extra += transfer.blocks.length - original.blocks.length;
        transfers.push(transfer);
      }
      if (transfers.length !== solution.transfers.length) continue;
      solutions.push(extra ? { ...solution, id: signature({ transfers }), transfers, stats: settledStats(solution.stats, solution.transfers, transfers, land, req.assignment, req.weights) } : solution);
    }
    if (solutions.length) return { status: 'ok', solutions: solutions.sort(compare), elapsedMs: now() - start };
  }
  const full = solveDistrictRaw(req, locked);
  return {
    ...full,
    solutions: full.solutions.map(solution => isLandContiguous(land, req.assignment, solution.transfers)
      ? solution : { ...solution, stats: { ...solution.stats, usesWater: true } }),
    elapsedMs: now() - start,
  };
}

/**
 * UNASSIGNED's ranking rule: "a real neighbor that a move brings closer to zero still ranks
 * first". The search's own cost gives such a neighbor only a small per-person credit, so an
 * Unassigned option with fewer splits or a shorter border can still come out ahead of it. When
 * some option trades with Unassigned, this moves the options that bring at least one real
 * neighbor closer to zero ahead of the rest, keeping the search's order within each part. Without
 * an option touching 0 (every complete map, every request without permission) nothing moves.
 * solveDistrictRaw applies it before cutting the list to `maxOptions` (see districtSearch);
 * solveDistrict applies it again after the land-first pass re-sorts by cost.
 */
function rankRealNeighborsFirst(solutions: Solution[], district: number): void {
  if (!solutions.some(s => s.borderFlows.some(f => f.from === 0 || f.to === 0))) return;
  const helps = (s: Solution) => s.deviations.some(d => d.district !== district && Math.abs(d.after) < Math.abs(d.before));
  const first = solutions.filter(helps);
  if (!first.length || first.length === solutions.length) return;
  const rest = solutions.filter(s => !helps(s));
  solutions.splice(0, solutions.length, ...first, ...rest);
}

/**
 * The one-district search. Without Unassigned it is a single search over every border, exactly as
 * before. With Unassigned (`unassigned`), the search's own cost may fill every slot with
 * Unassigned options (fewer splits, a shorter border) and leave out a real neighbor that the move
 * would bring closer to zero, which UNASSIGNED says must rank first. So the real borders are also
 * searched on their own, which finds exactly the options a request without Unassigned would find,
 * and both searches run for the full 8 options so the answer does not depend on how many were
 * asked for. The caller ranks the merged list (rankRealNeighborsFirst) and then cuts it. When
 * the district has no border with Unassigned, permission changes nothing at all.
 */
function districtSearch(
  model: Model, borders: Border[], accept: number[], maxOptions: number | undefined, unassigned: boolean,
  locked?: Uint8Array,
): Scored[] {
  const real = borders.filter(border => border.from !== 0 && border.to !== 0);
  // No border with Unassigned (it is not permitted, or the district does not touch it, as on
  // every complete map): exactly the search a request without permission runs.
  if (!unassigned || real.length === borders.length) return search(model, borders, accept, maxOptions, locked);
  const all = search(model, borders, accept, 8, locked);
  if (!real.length) return all;
  const merged = new Map<string, Scored>();
  for (const option of [...search(model, real, accept, 8, locked), ...all]) {
    const id = signature(option);
    if (!merged.has(id)) merged.set(id, option);
  }
  return [...merged.values()].sort(compare);
}

/** `locked` blocks never move (see solveDistrictAnywhere). */
function solveDistrictRaw(req: DistrictSolveRequest, locked?: Uint8Array): SolveResult {
  const start = now();
  const { graph, assignment, district, targets, absorbers, weights, maxOptions, goal } = req;
  if (!Number.isInteger(district) || district < 1 || district > targets.numDistricts ||
    district > 65535 || assignment.length !== graph.n) {
    return { status: 'error', solutions: [], elapsedMs: now() - start, message: 'Invalid district or assignment length.' };
  }
  if (goal !== undefined && goal !== -1 && goal !== 0 && goal !== 1) {
    return { status: 'error', solutions: [], elapsedMs: now() - start, message: 'Invalid goal.' };
  }
  const model = new Model(graph, assignment, weights, true);
  const before = model.state.districtPop;
  const goals = goal !== undefined
    ? [targets.draTarget + goal]
    : targets.remainder ? [targets.q, targets.q + 1] : [targets.q];
  if (goals.includes(before[district])) return { status: 'already-zero', solutions: [], elapsedMs: now() - start };
  const accept = goals.map(g => Math.abs(g - before[district])).sort((a, b) => a - b);
  const over = before[district] > goals[goals.length - 1];
  // Unassigned (0) trades only with permission: listed in `absorbers`, or `includeUnassigned`
  // when no absorbers are given. Without it district 0 is never touched.
  const unassigned = absorbers ? absorbers.includes(0) : !!req.includeUnassigned;
  const neighbors = new Set<number>();
  const districtBlocks = model.districtBlocks(district);
  for (let i = 0; i < districtBlocks.length; i++) {
    const b = districtBlocks[i];
    for (let e = graph.adjOffsets[b]; e < graph.adjOffsets[b + 1]; e++) {
      const d = assignment[graph.adjTargets[e]];
      if (d === district) continue;
      if (d ? !absorbers || absorbers.includes(d) : unassigned) neighbors.add(d);
    }
  }
  const borders: Border[] = [];
  for (const neighbor of [...neighbors].sort((a, b) => a - b)) {
    if (!neighbor) {
      // Unassigned has no target: it can take or give the whole amount, and doing so neither
      // helps nor hurts it (no `effect`). A real neighbor that the move brings closer to zero
      // earns the usual neighborDeviation credit, so it ranks ahead of an otherwise equal
      // Unassigned option.
      borders.push({ from: over ? district : 0, to: over ? 0 : district, limit: accept[accept.length - 1] });
      continue;
    }
    const deviation = before[neighbor] - targets.draTarget;
    const tolerance = Math.max(Math.abs(deviation), req.neighborTolerance ?? 0);
    const limit = Math.min(accept[accept.length - 1], Math.floor(tolerance - (over ? deviation : -deviation)));
    if (limit > 0) borders.push({
      from: over ? district : neighbor, to: over ? neighbor : district, limit,
      effect: people => Math.abs(deviation + (over ? people : -people)) - Math.abs(deviation),
    });
  }
  const found = borders.length ? districtSearch(model, borders, accept, maxOptions, unassigned, locked) : [];
  const solutions: Solution[] = found.map(option => {
    const changes = new Map<number, number>();
    const borderFlows = option.transfers.map(({ from, to, people }) => {
      changes.set(from, (changes.get(from) ?? 0) - people);
      changes.set(to, (changes.get(to) ?? 0) + people);
      return { from, to, people };
    });
    // Unassigned is not a district: it appears in transfers and borderFlows, never here.
    changes.delete(0);
    const deviations = [...changes].sort(([a], [b]) => a - b).map(([d, change]) => ({
      district: d, before: before[d] - targets.draTarget, after: before[d] + change - targets.draTarget,
    }));
    return { id: signature(option), kind: 'single', transfers: option.transfers, stats: option.stats,
      borderFlows, deviations };
  });
  if (unassigned && neighbors.has(0)) {
    // The searches above ran for the full 8 options; rank, then keep what was asked for, so a
    // helped real neighbor comes first however few options are requested.
    rankRealNeighborsFirst(solutions, district);
    solutions.splice(maxSolutions(maxOptions));
  }
  const elapsedMs = now() - start;
  return solutions.length ? { status: 'ok', solutions, elapsedMs } : {
    status: 'needs-precinct-rework', solutions, elapsedMs,
    message: 'The available border moves could not reach the target within neighbor tolerance.',
  };
}
