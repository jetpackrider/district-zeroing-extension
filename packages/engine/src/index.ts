import type {
  BorderSolveRequest, BorderSolver, CapacityCurve, DistrictSolveRequest, Solution,
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
  if (from === to || !from || !to) return [];
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
  if (from === to || !from || !to) return { from, to, tiers };
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
  const land = landView(req.graph);
  if (!land) return solveDistrictRaw(req);
  const start = now();
  const first = solveDistrictRaw({ ...req, graph: land });
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
        const transfer = settleOnFullGraph(new Model(req.graph, working, req.weights, true), original);
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
  const full = solveDistrictRaw(req);
  return {
    ...full,
    solutions: full.solutions.map(solution => isLandContiguous(land, req.assignment, solution.transfers)
      ? solution : { ...solution, stats: { ...solution.stats, usesWater: true } }),
    elapsedMs: now() - start,
  };
}

function solveDistrictRaw(req: DistrictSolveRequest): SolveResult {
  const start = now();
  const { graph, assignment, district, targets, absorbers, weights, maxOptions } = req;
  if (!Number.isInteger(district) || district < 1 || district > targets.numDistricts ||
    district > 65535 || assignment.length !== graph.n) {
    return { status: 'error', solutions: [], elapsedMs: now() - start, message: 'Invalid district or assignment length.' };
  }
  const model = new Model(graph, assignment, weights, true);
  const before = model.state.districtPop;
  const goals = targets.remainder ? [targets.q, targets.q + 1] : [targets.q];
  if (goals.includes(before[district])) return { status: 'already-zero', solutions: [], elapsedMs: now() - start };
  const accept = goals.map(goal => Math.abs(goal - before[district])).sort((a, b) => a - b);
  const over = before[district] > targets.q;
  const neighbors = new Set<number>();
  const districtBlocks = model.districtBlocks(district);
  for (let i = 0; i < districtBlocks.length; i++) {
    const b = districtBlocks[i];
    for (let e = graph.adjOffsets[b]; e < graph.adjOffsets[b + 1]; e++) {
      const d = assignment[graph.adjTargets[e]];
      if (d && d !== district && (!absorbers || absorbers.includes(d))) neighbors.add(d);
    }
  }
  const borders: Border[] = [];
  for (const neighbor of [...neighbors].sort((a, b) => a - b)) {
    const deviation = before[neighbor] - targets.draTarget;
    const tolerance = Math.max(Math.abs(deviation), req.neighborTolerance ?? 0);
    const limit = Math.min(accept[accept.length - 1], Math.floor(tolerance - (over ? deviation : -deviation)));
    if (limit > 0) borders.push({
      from: over ? district : neighbor, to: over ? neighbor : district, limit,
      effect: people => Math.abs(deviation + (over ? people : -people)) - Math.abs(deviation),
    });
  }
  const found = borders.length ? search(model, borders, accept, maxOptions) : [];
  const solutions: Solution[] = found.map(option => {
    const changes = new Map<number, number>();
    const borderFlows = option.transfers.map(({ from, to, people }) => {
      changes.set(from, (changes.get(from) ?? 0) - people);
      changes.set(to, (changes.get(to) ?? 0) + people);
      return { from, to, people };
    });
    const deviations = [...changes].sort(([a], [b]) => a - b).map(([d, change]) => ({
      district: d, before: before[d] - targets.draTarget, after: before[d] + change - targets.draTarget,
    }));
    return { id: signature(option), kind: 'single', transfers: option.transfers, stats: option.stats,
      borderFlows, deviations };
  });
  const elapsedMs = now() - start;
  return solutions.length ? { status: 'ok', solutions, elapsedMs } : {
    status: 'needs-precinct-rework', solutions, elapsedMs,
    message: 'The available border moves could not reach the target within neighbor tolerance.',
  };
}
