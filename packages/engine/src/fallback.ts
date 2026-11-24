import type { Assignment, CostWeights, EngineGraph, SolutionStats, Transfer } from '@zd/contracts';
import { COMPACT_DEPTH, isCompactTransfer } from './compact';
import { choose, type TableCache } from './knapsack';
import { Model } from './model';
import { blockGrowthRank, measureTransferShape, shapePruneMeters } from './shape';
import {
  borderRing, compareBlocks, compareChunks, computeRing, generate, realize,
  type Border, type Chunk, type PrecinctOptions,
} from './search';

export type Scored = { transfers: Transfer[]; stats: SolutionStats };

interface BorderUnit {
  id: number;
  precinct: number;
  blocks: number[];
  people: number;
  populated: number;
  cost: number;
  hops: number;
}

function signatureOf(result: Pick<Scored, 'transfers'>): string {
  return result.transfers.map(t => `${t.from}>${t.to}:${t.blocks.join(',')}`).join(';');
}

function makeFallbackChunk(border: Border, blocks: number[], people: number, cost = 0): Chunk {
  return {
    border,
    precinct: -1,
    blocks,
    people,
    perimeter: 0,
    cost,
    tier: 1,
  };
}

/**
 * Collect single-populated-block border units reachable directly from `to` or via a
 * shortest bridge of zero-population blocks in `from` (crossing precinct lines if needed).
 */
function collectBorderUnits(
  model: Model, border: Border, maxGoal: number, locked?: Uint8Array,
): BorderUnit[] {
  const { graph: g, assignment: a, weights, precinctTracker } = model;
  const { from, to } = border;
  model.ensureDistrict(from);
  const fromBlocks = model.districtBlocks(from);

  const parent = new Map<number, number>();
  const dist = new Map<number, number>();
  const zeroQueue: number[] = [];
  const candidates: Array<{ block: number; hops: number }> = [];

  for (let i = 0; i < fromBlocks.length; i++) {
    const b = fromBlocks[i];
    if (locked?.[b]) continue;
    let touchesTo = false;
    for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
      if (a[g.adjTargets[e]] === to) { touchesTo = true; break; }
    }
    if (!touchesTo) continue;
    dist.set(b, 0);
    if (g.pop[b] === 0) {
      if (model.allowLongReach) zeroQueue.push(b);
    } else if (g.pop[b] > 0 && g.pop[b] <= maxGoal) {
      candidates.push({ block: b, hops: 0 });
    }
  }

  // BFS through zero-population blocks up to 24 hops / 4000 nodes.
  // Crosses precinct lines only from populated precincts (all-empty precincts are dropped per spec).
  const MAX_ZERO_HOPS = 24;
  const MAX_ZERO_NODES = 4000;
  for (let head = 0; head < zeroQueue.length; head++) {
    const u = zeroQueue[head];
    const d = dist.get(u)!;
    if (d >= MAX_ZERO_HOPS) continue;
    const pu = g.precinctOf[u];
    const canCross = model.state.precinctHasPop(pu);
    for (let e = g.adjOffsets[u]; e < g.adjOffsets[u + 1]; e++) {
      const v = g.adjTargets[e];
      if (a[v] !== from || locked?.[v] || dist.has(v)) continue;
      if (g.precinctOf[v] !== pu && !canCross) continue;
      dist.set(v, d + 1);
      parent.set(v, u);
      if (g.pop[v] === 0) {
        if (zeroQueue.length < MAX_ZERO_NODES) zeroQueue.push(v);
      } else if (g.pop[v] > 0 && g.pop[v] <= maxGoal) {
        candidates.push({ block: v, hops: d + 1 });
      }
    }
  }

  const units: BorderUnit[] = [];
  for (const { block, hops } of candidates) {
    const fringe = model.fringe(block, locked);
    if (!fringe) continue;
    const set = new Set<number>();
    set.add(block);
    for (let cur = parent.get(block); cur !== undefined; cur = parent.get(cur)) set.add(cur);
    for (const f of fringe) set.add(f);
    const blocks = [...set].sort((x, y) => x - y);
    if (!model.allowLongReach && !isCompactTransfer(g, a, { from, to, blocks: Uint32Array.from(blocks), people: 0 })) continue;
    let people = 0;
    let populated = 0;
    const precinctsTouched = new Set<number>();
    for (const b of blocks) {
      people += g.pop[b];
      if (g.pop[b] > 0) populated++;
      precinctsTouched.add(g.precinctOf[b]);
    }
    if (people <= 0 || people > maxGoal) continue;
    let splitCost = 0;
    for (const p of precinctsTouched) {
      if (precinctTracker.districtCount(p) === 1 && precinctTracker.countOf(p, from) > blocks.length) {
        splitCost += weights.newPrecinctSplit;
      }
    }
    const towns = model.newTownSplits([{ from, to, blocks }]) ?? 0;
    const { boundaryDeltaMPerPerson } = measureTransferShape(g, a, { from, to, people, blocks });
    const perimeter = boundaryDeltaMPerPerson * people * 2;
    const cost = splitCost + model.newCountySplits(blocks, from, to) * weights.newCountySplit +
      towns * weights.newTownSplit + precinctsTouched.size * weights.perStep +
      blocks.length * weights.perBlock + populated * weights.perPopulatedBlock + hops * 0.5 +
      (perimeter + shapePruneMeters(perimeter, people)) * weights.perimeterPerMeter;
    units.push({
      id: block,
      precinct: g.precinctOf[block],
      blocks,
      people,
      populated,
      cost,
      hops,
    });
  }

  units.sort((x, y) => x.cost - y.cost || x.hops - y.hops || x.blocks.length - y.blocks.length || x.id - y.id);
  return units;
}

/**
 * 0/1 exact-sum knapsack over border units up to `maxGoal`, returning the lowest-cost
 * subset of units hitting one of `accept` (or undefined).
 */
function solveUnitKnapsack(
  units: BorderUnit[],
  penalties: Float64Array,
  banned: Uint8Array,
  accept: number[],
  maxGoal: number,
  excludedBlocks?: Uint8Array,
): number[] | undefined {
  const dp = new Float64Array(maxGoal + 1).fill(Infinity);
  const prevSum = new Int32Array(maxGoal + 1).fill(-1);
  const pickedItem = new Int32Array(maxGoal + 1).fill(-1);
  // Keep per-item backtracking rows only when needed; a flat 2D table of size (units.length x (maxGoal+1))
  // can be large, so use compact row choices only for active items.
  const active: number[] = [];
  for (let i = 0; i < units.length; i++) {
    if (banned[i]) continue;
    if (excludedBlocks) {
      let clash = false;
      for (const b of units[i].blocks) if (excludedBlocks[b]) { clash = true; break; }
      if (clash) continue;
    }
    if (units[i].people <= maxGoal) active.push(i);
  }
  if (!active.length) return;

  dp[0] = 0;
  let hi = 0;
  const rows: Uint8Array[] = [];
  for (let idx = 0; idx < active.length; idx++) {
    const ui = active[idx];
    const w = units[ui].people;
    const price = units[ui].cost + penalties[ui];
    const row = new Uint8Array(maxGoal + 1);
    const upper = Math.min(hi, maxGoal - w);
    for (let s = upper; s >= 0; s--) {
      const base = dp[s];
      if (base === Infinity) continue;
      const target = s + w;
      const c = base + price;
      if (c < dp[target]) {
        dp[target] = c;
        row[target] = 1;
        prevSum[target] = s;
        pickedItem[target] = idx;
      }
    }
    hi = Math.min(maxGoal, hi + w);
    rows.push(row);
  }

  let bestGoal = -1;
  let bestCost = Infinity;
  for (const goal of accept) {
    if (goal <= maxGoal && dp[goal] < bestCost) {
      bestCost = dp[goal];
      bestGoal = goal;
    }
  }
  if (bestGoal < 0) return;

  const chosen: number[] = [];
  let rem = bestGoal;
  for (let idx = active.length - 1; idx >= 0 && rem > 0; idx--) {
    if (rows[idx][rem]) {
      const ui = active[idx];
      chosen.push(ui);
      rem -= units[ui].people;
    }
  }
  if (rem !== 0) return;
  return chosen.reverse();
}

function tryAcceptBlocks(
  model: Model,
  border: Border,
  blocks: number[],
  people: number,
  accept: number[],
  borders: Border[],
  solutions: Scored[],
  seen: Set<string>,
  locked?: Uint8Array,
): boolean {
  const chunk = makeFallbackChunk(border, blocks, people);
  const res = realize(model, [chunk], accept, locked, borders);
  if ('offender' in res) return false;
  const id = signatureOf(res);
  if (seen.has(id)) return false;
  seen.add(id);
  solutions.push(res);
  return true;
}

/**
 * Layer 1: Direct border blocks & cross-precinct zero-population bridge units.
 * Handles small amounts, zero-pop bridges, and multi-block moves within the same precinct.
 */
function runLayer1Units(
  model: Model,
  borders: Border[],
  accept: number[],
  wanted: number,
  solutions: Scored[],
  seen: Set<string>,
  locked?: Uint8Array,
  unitsByBorder?: Map<Border, BorderUnit[]>,
) {
  const acceptSet = new Set(accept);
  const maxAccept = accept[accept.length - 1];

  for (const border of borders) {
    if (solutions.length >= wanted) break;
    const borderMax = Math.min(border.limit, maxAccept);
    if (borderMax <= 0) continue;
    const allUnits = collectBorderUnits(model, border, borderMax, locked);
    unitsByBorder?.set(border, allUnits);
    if (!allUnits.length) continue;

    // 1A. Single-unit exact hits (direct block or zero-pop bridge to one populated block).
    for (const u of allUnits) {
      if (solutions.length >= wanted) break;
      if (!acceptSet.has(u.people)) continue;
      tryAcceptBlocks(model, border, u.blocks, u.people, accept, borders, solutions, seen, locked);
    }
    if (solutions.length >= wanted || borderMax > 3000) continue;

    // 1B. Multi-unit 0/1 knapsack over up to 220 diverse units (allows same-precinct multi-seed
    // and shared zero-pop bridge blocks!).
    const perPopCap = Math.min(10, wanted + 4);
    const countByPop = new Map<number, number>();
    const selected: BorderUnit[] = [];
    for (const u of allUnits) {
      const c = countByPop.get(u.people) ?? 0;
      if (c >= perPopCap) continue;
      countByPop.set(u.people, c + 1);
      selected.push(u);
      if (selected.length >= 220) break;
    }

    const penalties = new Float64Array(selected.length);
    const banned = new Uint8Array(selected.length);
    const maxAttempts = Math.min(24, wanted * 5);
    const g = model.graph;

    for (let attempt = 0; attempt < maxAttempts && solutions.length < wanted; attempt++) {
      const chosen = solveUnitKnapsack(selected, penalties, banned, accept, borderMax);
      if (!chosen?.length) break;
      const merged = new Set<number>();
      for (const ui of chosen) for (const b of selected[ui].blocks) merged.add(b);
      const blocks = [...merged].sort((x, y) => x - y);
      let actualPop = 0;
      for (const b of blocks) actualPop += g.pop[b];
      if (!acceptSet.has(actualPop)) {
        // Rare: two articulation fringes overlapped on a populated block. Ban the last chosen unit.
        banned[chosen[chosen.length - 1]] = 1;
        continue;
      }
      const added = tryAcceptBlocks(model, border, blocks, actualPop, accept, borders, solutions, seen, locked);
      if (added) {
        for (const ui of chosen) penalties[ui] += 150;
      } else {
        // Either cut or duplicate: ban the most expensive/last unit in the combination.
        banned[chosen[chosen.length - 1]] = 1;
      }
    }
  }
}

/**
 * Check if all blocks in `memberSet` stay connected to at least one block touching `to`.
 * Runs only inside the small local block set `memberSet`.
 */
function staysConnectedToTarget(
  model: Model,
  memberSet: Set<number>,
  borderSeeds: number[],
  removedBlock: number,
): boolean {
  const { adjOffsets, adjTargets } = model.graph;
  const targetCount = memberSet.size - 1;
  if (targetCount <= 0) return false;
  const visited = new Set<number>();
  const q: number[] = [];
  for (const s of borderSeeds) {
    if (s !== removedBlock && memberSet.has(s) && !visited.has(s)) {
      visited.add(s);
      q.push(s);
    }
  }
  for (let i = 0; i < q.length; i++) {
    const u = q[i];
    for (let e = adjOffsets[u]; e < adjOffsets[u + 1]; e++) {
      const v = adjTargets[e];
      if (v !== removedBlock && memberSet.has(v) && !visited.has(v)) {
        visited.add(v);
        q.push(v);
      }
    }
  }
  return visited.size === targetCount;
}

/**
 * Peel blocks off the interior boundary (adjacent to `from \ current`) of a whole precinct
 * or witness set, recording smaller valid chunks right below the full total.
 */
function peelBlockSet(
  model: Model,
  border: Border,
  initialBlocks: number[],
  initialPop: number,
  targetGoals: number[],
  mode: 'target' | 'smallest' | 'largest',
  maxSteps: number,
  onPrefix: (blocks: number[], pop: number) => boolean,
) {
  const { graph: g, assignment: a } = model;
  const { from, to } = border;
  const current = new Set<number>(initialBlocks);
  const borderSeeds: number[] = [];
  for (const b of initialBlocks) {
    for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
      if (a[g.adjTargets[e]] === to) { borderSeeds.push(b); break; }
    }
  }
  if (!borderSeeds.length) return;

  // Interior boundary: blocks in `current` that touch a block in `from \ current`.
  const interior = new Set<number>();
  const isInterior = (b: number) => {
    for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
      const nxt = g.adjTargets[e];
      if (a[nxt] === from && !current.has(nxt)) return true;
    }
    return false;
  };
  for (const b of initialBlocks) if (isInterior(b)) interior.add(b);

  let pop = initialPop;
  const minGoal = targetGoals[0];
  const unpeelable = new Set<number>();

  for (let step = 0; step < maxSteps && current.size > 1 && interior.size > 0; step++) {
    const excess = pop - minGoal;
    if (mode === 'target' && excess <= 0) break;

    let bestBlock = -1;
    let bestScore = Infinity;
    for (const b of interior) {
      if (unpeelable.has(b)) continue;
      const p = g.pop[b];
      let sc: number;
      if (mode === 'target') {
        if (p === excess) sc = -1e9;
        else if (p > 0 && p < excess) sc = -(p * 1000) + b * 1e-6; // largest fitting pop first
        else if (p === 0) sc = 500 + b * 1e-6; // peel zero-pop to expose interior populated blocks
        else sc = 1e6 + p; // overshoot only if nothing else fits
      } else if (mode === 'smallest') {
        sc = (p === 0 ? 1e6 : p) * 1000 + b * 1e-6;
      } else {
        sc = (p === 0 ? 1e6 : -p) * 1000 + b * 1e-6;
      }
      if (sc < bestScore) {
        bestScore = sc;
        bestBlock = b;
      }
    }
    if (bestBlock < 0) break;

    if (!staysConnectedToTarget(model, current, borderSeeds, bestBlock)) {
      unpeelable.add(bestBlock);
      continue;
    }

    current.delete(bestBlock);
    interior.delete(bestBlock);
    unpeelable.clear();
    pop -= g.pop[bestBlock];
    for (let e = g.adjOffsets[bestBlock]; e < g.adjOffsets[bestBlock + 1]; e++) {
      const nxt = g.adjTargets[e];
      if (current.has(nxt)) interior.add(nxt);
    }

    if (onPrefix([...current].sort((x, y) => x - y), pop)) break;
  }
}

/**
 * Layer 2: Expanded intra-precinct chunk generation (up to 48 seeds, 4 growth variants
 * including target-guided and compact, plus whole-precinct back-peeling).
 */
function runLayer2Expanded(
  model: Model,
  borders: Border[],
  accept: number[],
  wanted: number,
  solutions: Scored[],
  seen: Set<string>,
  locked?: Uint8Array,
) {
  const { graph: g, assignment: a, weights, precinctTracker, countyTracker } = model;
  const maxAccept = accept[accept.length - 1];
  const primaryGoal = accept[0];
  const groups: PrecinctOptions[] = [];
  const included = model.scratchIncluded;
  const ring = model.scratchRing;
  const queue = model.scratchQueue;

  for (const border of borders) {
    const { from, to } = border;
    model.ensureDistrict(from);
    const limit = border.limit + model.negativePopulation[from];
    const { seeds, size: ringSize } = computeRing(model, border,
      model.allowLongReach ? 11 : COMPACT_DEPTH, ring, queue, locked);

    try {
      for (const [precinct, seedList] of [...seeds].sort(([x], [y]) => x - y)) {
        const precinctFromCount = precinctTracker.countOf(precinct, from);
        const best = new Map<number, Chunk[]>();
        const viable = seedList.flatMap(seed => {
          const fringe = model.fringe(seed, locked);
          return fringe ? [{ seed, fringe }] : [];
        });

        const addChunk = (blocks: number[], people: number, populated: number, precinctBlocks: number, countySplits: number, townSplits: number, perimeter: number) => {
          if (people > limit) return;
          const split = precinctTracker.delta(precinct, from, to, precinctBlocks);
          const cost = (split > 0 ? weights.newPrecinctSplit : -split * weights.healedPrecinctSplit) +
            countySplits * weights.newCountySplit + townSplits * weights.newTownSplit +
            weights.perStep * new Set(blocks.map(b => g.precinctOf[b])).size +
            blocks.length * weights.perBlock + populated * weights.perPopulatedBlock +
            (perimeter + shapePruneMeters(perimeter, people)) * weights.perimeterPerMeter;
          let options = best.get(people);
          if (!options) best.set(people, options = []);
          const last = options.length === 8 ? options[7] : undefined;
          if (last && (cost - last.cost || blocks.length - last.blocks.length || perimeter - last.perimeter) > 0) return;
          const sorted = blocks.slice().sort((x, y) => x - y);
          if (options.some(option => compareBlocks(option.blocks, sorted) === 0)) return;
          options.push({
            border, precinct, people, cost, perimeter, blocks: sorted,
            tier: countySplits || townSplits ? 2 : split > 0 ? 1 : 0,
          });
          options.sort(compareChunks);
          if (options.length > 8) options.pop();
        };

        const grow = (initial: number[], fringe: number[], whole: boolean, variant: number) => {
          const blocks: number[] = [];
          const frontier: number[] = [];
          const counties = new Map<number, number>();
          const townTracker = model.townTracker;
          const towns = townTracker ? new Map<number, number>() : undefined;
          let townSplits = 0;
          let people = 0, populated = 0, nonempty = 0, perimeter = 0, precinctBlocks = 0, countySplits = 0;

          function add(b: number) {
            included[b] = 2;
            blocks.push(b);
            people += g.pop[b];
            populated += Number(g.pop[b] > 0);
            nonempty += Number(g.pop[b] !== 0);
            precinctBlocks += Number(g.precinctOf[b] === precinct);
            const county = g.countyOf[b];
            if (!countyTracker.hasDistrict(county, to)) {
              const old = counties.get(county) ?? 0;
              counties.set(county, old + 1);
              if (!old) countySplits++;
              if (old + 1 === countyTracker.countOf(county, from)) countySplits--;
            }
            const town = g.townOf?.[b];
            if (town && townTracker!.districtCount(town) === 1) {
              const old = towns!.get(town) ?? 0;
              towns!.set(town, old + 1);
              if (!old) townSplits++;
              if (old + 1 === townTracker!.countOf(town, from)) townSplits--;
            }
            for (let edge = g.adjOffsets[b]; edge < g.adjOffsets[b + 1]; edge++) {
              const next = g.adjTargets[edge];
              if (a[next] === to) perimeter -= 2 * g.adjLen[edge];
              if (a[next] !== from) continue;
              perimeter += (included[next] === 2 ? -2 : 2) * g.adjLen[edge];
              if (included[next] || locked?.[next] || g.precinctOf[next] !== precinct ||
                ((!whole || !model.allowLongReach) && !ring[next])) continue;
              included[next] = 1;
              frontier.push(next);
            }
          }

          for (const b of initial) included[b] = 1;
          for (const b of fringe) included[b] = 1;
          for (const b of initial) add(b);
          for (const b of fringe) add(b);
          if (!whole && nonempty) addChunk(blocks, people, populated, precinctBlocks, countySplits, townSplits, perimeter);

          while (frontier.length && people <= limit) {
            let position = 0;
            if (!whole) {
              const rem = primaryGoal - people;
              for (let i = 1; i < frontier.length; i++) {
                const x = frontier[i], y = frontier[position];
                let rank = model.articulation[x] - model.articulation[y];
                if (!rank) {
                  if (variant === 2 && rem > 0) {
                    const px = g.pop[x], py = g.pop[y];
                    const fx = px > 0 && px <= rem ? 0 : px === 0 ? 1 : 2;
                    const fy = py > 0 && py <= rem ? 0 : py === 0 ? 1 : 2;
                    rank = fx - fy || (fx === 0 ? py - px : px - py) || x - y;
                  } else if (variant === 3) {
                    rank = (weights.perimeterPerMeter > 0
                      ? blockGrowthRank(g, a, included, y, from, to, ring[y]) -
                        blockGrowthRank(g, a, included, x, from, to, ring[x]) : 0) ||
                      ring[x] - ring[y] || g.pop[x] - g.pop[y] || x - y;
                  } else {
                    rank = Number(g.pop[x] !== 0) - Number(g.pop[y] !== 0) ||
                      (variant % 2 ? g.pop[y] - g.pop[x] || y - x : g.pop[x] - g.pop[y] || x - y);
                  }
                }
                if (rank < 0) position = i;
              }
            }
            const b = frontier[position];
            frontier[position] = frontier[frontier.length - 1];
            frontier.pop();
            add(b);
            if (!whole && nonempty) addChunk(blocks, people, populated, precinctBlocks, countySplits, townSplits, perimeter);
          }

          const wholeBlocks = whole && precinctBlocks === precinctFromCount && nonempty ? blocks.slice() : undefined;
          const wholePeople = people;
          if (wholeBlocks) addChunk(wholeBlocks, people, populated, precinctBlocks, countySplits, townSplits, perimeter);
          for (const b of blocks) included[b] = 0;
          for (const b of frontier) included[b] = 0;

          // Back-peel whole precinct if it is small enough to contribute near-endpoint amounts.
          if (wholeBlocks && wholeBlocks.length <= 200 && wholePeople > 0 && wholePeople <= limit + 400) {
            for (const mode of ['smallest', 'largest'] as const) {
              peelBlockSet(model, border, wholeBlocks, wholePeople, accept, mode, 48, (peeledBlocks, peeledPop) => {
                if (peeledPop > 0 && peeledPop <= limit) {
                  let popCnt = 0;
                  for (const b of peeledBlocks) if (g.pop[b] > 0) popCnt++;
                  const towns = model.newTownSplits([{ from, to, blocks: peeledBlocks }]) ?? 0;
                  const shape = measureTransferShape(g, a, { from, to, people: peeledPop, blocks: peeledBlocks });
                  addChunk(peeledBlocks, peeledPop, popCnt, peeledBlocks.length,
                    model.newCountySplits(peeledBlocks, from, to), towns,
                    shape.boundaryDeltaMPerPerson * peeledPop * 2);
                }
                return false;
              });
            }
          }
        };

        const seedCap = Math.min(48, viable.length);
        for (let i = 0; i < seedCap; i++) {
          const { seed, fringe } = viable[Math.floor(i * viable.length / seedCap)];
          grow([seed], fringe, false, i % 4);
        }
        // Also run target-guided growth from the top 4 smallest-population seeds.
        const bySmallest = viable.slice().sort((x, y) => g.pop[x.seed] - g.pop[y.seed] || x.seed - y.seed);
        for (let i = 0; i < Math.min(4, bySmallest.length); i++) {
          grow([bySmallest[i].seed], bySmallest[i].fringe, false, 2);
        }
        grow(seedList, [], true, 0);
        if (best.size) groups.push({ border, precinct, byPopulation: best });
      }
    } finally {
      for (let i = 0; i < ringSize; i++) ring[queue[i]] = 0;
    }
  }

  if (!groups.length) return;
  const banned = new Set<Chunk>();
  const directBans = new Set<Chunk>();
  const penalties = new Map<number, number>();
  for (const sol of solutions) {
    for (const t of sol.transfers) for (const b of t.blocks) {
      const p = g.precinctOf[b];
      penalties.set(p, (penalties.get(p) ?? 0) + 110);
    }
  }
  const tables: TableCache = new Map();
  const maxAttempts = Math.max(20, wanted * 5);

  for (let attempt = 0; attempt < maxAttempts && solutions.length < wanted; attempt++) {
    const chunks = choose(groups, accept, penalties, banned, model.weights.neighborDeviation, tables);
    if (!chunks?.length) break;
    const result = realize(model, chunks, accept, locked, borders);
    if ('offender' in result) {
      const { offender, repaired } = result;
      banned.add(offender);
      directBans.add(offender);
      if (repaired && repaired.people <= maxAccept) {
        const group = groups.find(gr => gr.border === offender.border && gr.precinct === offender.precinct);
        if (group) {
          const options = group.byPopulation.get(repaired.people) ?? [];
          if (!options.some(option => compareBlocks(option.blocks, repaired.blocks) === 0)) {
            options.push(repaired);
            options.sort(compareChunks);
            group.byPopulation.set(repaired.people, options);
          }
        }
      }
      continue;
    }
    const id = signatureOf(result);
    if (!seen.has(id)) {
      seen.add(id);
      solutions.push(result);
      const precincts = new Set<number>();
      for (const transfer of result.transfers) for (const block of transfer.blocks) {
        precincts.add(g.precinctOf[block]);
      }
      for (const precinct of precincts) penalties.set(precinct, (penalties.get(precinct) ?? 0) + 110);
    } else {
      banned.add(chunks[0]);
      directBans.add(chunks[0]);
    }
  }
}

/**
 * Layer 3: Witness back-peeling + cross-precinct target-guided growth + meet-in-the-middle
 * with disjoint border units. Handles near-capacity gaps and large single-precinct borders.
 */
function runLayer3CrossPrecinctAndPeel(
  model: Model,
  borders: Border[],
  accept: number[],
  wanted: number,
  solutions: Scored[],
  seen: Set<string>,
  locked?: Uint8Array,
  unitsByBorder?: Map<Border, BorderUnit[]>,
  getWitnesses?: (model: Model, border: Border, locked?: Uint8Array) => Array<{ tier: number; transfer: Transfer; stats: SolutionStats }>,
) {
  const { graph: g, assignment: a } = model;
  const acceptSet = new Set(accept);
  const maxAccept = accept[accept.length - 1];

  for (const border of borders) {
    if (solutions.length >= wanted) break;
    const { from, to } = border;
    const borderMax = Math.min(border.limit, maxAccept);
    if (borderMax <= 0) continue;
    model.ensureDistrict(from);

    const units = unitsByBorder?.get(border) ?? collectBorderUnits(model, border, Math.min(borderMax, 300), locked);
    const smallUnits = units.filter(u => u.people <= 250).slice(0, 120);
    const unitPen = new Float64Array(smallUnits.length);
    const unitBan = new Uint8Array(smallUnits.length);

    const tryMeetInMiddle = (baseBlocks: number[], basePop: number): boolean => {
      if (!smallUnits.length) return false;
      for (const goal of accept) {
        const delta = goal - basePop;
        if (delta <= 0 || delta > 250 || goal > border.limit) continue;
        // Mark baseBlocks as excluded so chosen units are disjoint on populated blocks
        const excl = model.scratchIncluded;
        for (const b of baseBlocks) excl[b] = 1;
        let chosen: number[] | undefined;
        try {
          chosen = solveUnitKnapsack(smallUnits, unitPen, unitBan, [delta], delta, excl);
        } finally {
          for (const b of baseBlocks) excl[b] = 0;
        }
        if (!chosen?.length) continue;
        const merged = new Set<number>(baseBlocks);
        for (const ui of chosen) for (const b of smallUnits[ui].blocks) merged.add(b);
        const blocks = [...merged].sort((x, y) => x - y);
        let actualPop = 0;
        for (const b of blocks) actualPop += g.pop[b];
        if (actualPop !== goal) continue;
        if (tryAcceptBlocks(model, border, blocks, actualPop, accept, borders, solutions, seen, locked)) {
          if (solutions.length >= wanted) return true;
        }
      }
      return false;
    };

    // 3A. Witness back-peeling when a capacity witness is >= target.
    if (getWitnesses && (maxAccept >= 80 || model.allowLongReach)) {
      const witnesses = getWitnesses(model, { ...border, limit: Infinity }, locked);
      for (const w of witnesses) {
        if (solutions.length >= wanted) break;
        if (w.transfer.people <= accept[0] || w.transfer.blocks.length > 2500 ||
          (!model.allowLongReach && w.transfer.people > maxAccept + 800)) continue;
        const wBlocks = Array.from(w.transfer.blocks);
        for (const mode of ['target', 'smallest', 'largest'] as const) {
          if (solutions.length >= wanted) break;
          let mitmTries = 0;
          peelBlockSet(model, border, wBlocks, w.transfer.people, accept, mode, 160, (peeledBlocks, peeledPop) => {
            if (acceptSet.has(peeledPop) && peeledPop <= border.limit) {
              tryAcceptBlocks(model, border, peeledBlocks, peeledPop, accept, borders, solutions, seen, locked);
              if (solutions.length >= wanted) return true;
            } else if (peeledPop < maxAccept && maxAccept - peeledPop <= 200 && mitmTries < 4) {
              mitmTries++;
              if (tryMeetInMiddle(peeledBlocks, peeledPop)) return true;
            }
            return peeledPop < accept[0] - 250;
          });
        }
      }
    }
    if (solutions.length >= wanted) break;

    // 3B. Cross-precinct target-guided growth within the search ring.
    const { ring, seeds } = borderRing(model, border, model.allowLongReach ? 11 : COMPACT_DEPTH, locked);
    const allSeeds: Array<{ seed: number; fringe: number[] }> = [];
    for (const [, list] of [...seeds].sort(([x], [y]) => x - y)) {
      for (const s of list) {
        const fringe = model.fringe(s, locked);
        if (fringe) allSeeds.push({ seed: s, fringe });
      }
    }
    if (!allSeeds.length) continue;

    // Choose up to 24 diverse seeds: smallest pops, largest pops, zero-pop, and spatially spaced.
    const chosenIndices = new Set<number>();
    const sortedByPop = allSeeds.map((item, idx) => ({ idx, pop: g.pop[item.seed] }))
      .sort((x, y) => x.pop - y.pop || x.idx - y.idx);
    for (let i = 0; i < Math.min(6, sortedByPop.length); i++) chosenIndices.add(sortedByPop[i].idx);
    for (let i = sortedByPop.length - 1; i >= Math.max(0, sortedByPop.length - 4); i--) chosenIndices.add(sortedByPop[i].idx);
    const strideCount = Math.min(16, allSeeds.length);
    for (let i = 0; i < strideCount; i++) chosenIndices.add(Math.floor(i * allSeeds.length / strideCount));

    const included = model.scratchIncluded;
    const primaryGoal = accept[0];

    for (const idx of [...chosenIndices].sort((x, y) => x - y)) {
      if (solutions.length >= wanted) break;
      const { seed, fringe } = allSeeds[idx];
      for (const variant of [0, 1] as const) {
        if (solutions.length >= wanted) break;
        const blocks: number[] = [];
        const frontier: number[] = [];
        let people = 0;
        let mitmTries = 0;

        const seedPrecinct = g.precinctOf[seed];
        const seedCanCross = model.state.precinctHasPop(seedPrecinct);
        const addBlock = (b: number) => {
          included[b] = 2;
          blocks.push(b);
          people += g.pop[b];
          for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
            const nxt = g.adjTargets[e];
            if (a[nxt] !== from || included[nxt] || locked?.[nxt] || !ring[nxt]) continue;
            // Do not tunnel out of an all-empty precinct before hitting a populated block
            if (people === 0 && g.precinctOf[nxt] !== seedPrecinct && !seedCanCross) continue;
            included[nxt] = 1;
            frontier.push(nxt);
          }
        };

        for (const b of [seed, ...fringe]) included[b] = 1;
        for (const b of [seed, ...fringe]) addBlock(b);

        try {
          let steps = 0;
          const MAX_STEPS = 400;
          while (steps < MAX_STEPS && people <= borderMax) {
            if (acceptSet.has(people)) {
              const sorted = blocks.slice().sort((x, y) => x - y);
              tryAcceptBlocks(model, border, sorted, people, accept, borders, solutions, seen, locked);
              if (solutions.length >= wanted) break;
            } else if (people > 0 && people < primaryGoal && primaryGoal - people <= 200 && mitmTries < 3) {
              mitmTries++;
              const sorted = blocks.slice().sort((x, y) => x - y);
              // Temporarily clear `included`? No, copy is safe if we restore after, or defer MITM!
              // Instead of mutating scratchIncluded inside tryMeetInMiddle, run MITM after clearing included!
              // Record candidate for post-loop MITM below:
              if (mitmCandidates.length < 12) mitmCandidates.push({ blocks: sorted, pop: people });
            }
            if (!frontier.length) break;
            const rem = primaryGoal - people;
            let bestPos = 0;
            for (let i = 1; i < frontier.length; i++) {
              const x = frontier[i], y = frontier[bestPos];
              let rank = model.articulation[x] - model.articulation[y];
              if (!rank) {
                const px = g.pop[x], py = g.pop[y];
                if (variant === 0) {
                  // Target-guided: exact hit first, then largest fitting positive block, then zero-pop, then smallest overshoot
                  const fx = px === rem ? 0 : px > 0 && px < rem ? 1 : px === 0 ? 2 : 3;
                  const fy = py === rem ? 0 : py > 0 && py < rem ? 1 : py === 0 ? 2 : 3;
                  rank = fx - fy || (model.weights.perimeterPerMeter > 0 && fx !== 0
                    ? blockGrowthRank(g, a, included, y, from, to, ring[y]) -
                      blockGrowthRank(g, a, included, x, from, to, ring[x]) : 0) ||
                    (fx === 1 ? py - px : px - py) || x - y;
                } else {
                  // Smallest positive fitting first
                  const fx = px === rem ? 0 : px > 0 && px < rem ? 1 : px === 0 ? 2 : 3;
                  const fy = py === rem ? 0 : py > 0 && py < rem ? 1 : py === 0 ? 2 : 3;
                  rank = fx - fy || px - py || x - y;
                }
              }
              if (rank < 0) bestPos = i;
            }
            const next = frontier[bestPos];
            frontier[bestPos] = frontier[frontier.length - 1];
            frontier.pop();
            addBlock(next);
            steps++;
          }
        } finally {
          for (const b of blocks) included[b] = 0;
          for (const b of frontier) included[b] = 0;
        }
      }
    }

    for (const cand of mitmCandidates) {
      if (solutions.length >= wanted) break;
      tryMeetInMiddle(cand.blocks, cand.pop);
    }
    mitmCandidates.length = 0;
  }
}

const mitmCandidates: Array<{ blocks: number[]; pop: number }> = [];

/**
 * Slower, more thorough fallback that runs ONLY when the fast path returns fewer than
 * `wanted` verified options (or none). Every returned option passes `realize()` and exact scoring.
 */
export function fallbackSearch(
  model: Model,
  borders: Border[],
  accept: number[],
  wanted: number,
  solutions: Scored[],
  seen: Set<string>,
  locked?: Uint8Array,
  getWitnesses?: (model: Model, border: Border, locked?: Uint8Array) => Array<{ tier: number; transfer: Transfer; stats: SolutionStats }>,
): void {
  if (solutions.length >= wanted) return;
  const unitsByBorder = new Map<Border, BorderUnit[]>();

  // Layer 1: Direct border & zero-population bridge units (fast, ~0.5-3ms)
  runLayer1Units(model, borders, accept, wanted, solutions, seen, locked, unitsByBorder);
  if (solutions.length >= wanted) return;

  // Layer 2: Expanded intra-precinct growth (48 seeds, target-guided, back-peeling)
  runLayer2Expanded(model, borders, accept, wanted, solutions, seen, locked);
  if (solutions.length >= wanted) return;

  // Layer 3: Witness back-peeling + cross-precinct target-guided growth + meet-in-the-middle
  runLayer3CrossPrecinctAndPeel(model, borders, accept, wanted, solutions, seen, locked, unitsByBorder, getWitnesses);
}

// ---------------------------------------------------------------------------
// Exported Reachability Helper for the Multi-District Planner
// ---------------------------------------------------------------------------

export interface BorderReachabilityRequest {
  graph: EngineGraph;
  assignment: Assignment;
  from: number;
  to: number;
  /** Maximum population total to inspect (default: min(border capacity, 5000)). */
  maxPeople?: number;
  locked?: Uint8Array;
  weights?: Partial<CostWeights>;
}

export interface BorderReachability {
  from: number;
  to: number;
  maxChecked: number;
  /** reachable[k] === 1 when k people is reachable in [0, maxChecked]. */
  reachable: Uint8Array;
  /** Smallest positive reachable total (0 if none). */
  minReachable: number;
  /** Largest reachable total <= maxChecked (0 if none). */
  maxReachable: number;
  /** Largest contiguous interval [from, to] in [1, maxChecked] where every integer is reachable. */
  denseRange: { from: number; to: number } | null;
  /** Unreachable integers in [1, maxReachable]. */
  gaps: number[];
  /** Nearest reachable positive total <= maxChecked (0 if none). */
  nearest(target: number, direction?: 'either' | 'down' | 'up'): number;
}

/**
 * Computes which exact integer totals in [1, maxChecked] are reachable on a directed border
 * by combining fast-path intra-precinct chunks and direct border units.
 * Designed so the multi-district planner can inspect deliverability and avoid gap amounts
 * in a few milliseconds without repeated solve/re-plan cycles.
 */
export function computeBorderReachability(
  req: BorderReachabilityRequest,
  getWitnesses: (model: Model, border: Border, locked?: Uint8Array) => Array<{ tier: number; transfer: Transfer; stats: SolutionStats }>,
): BorderReachability {
  const { graph, assignment, from, to, locked, weights } = req;
  const empty = (): BorderReachability => ({
    from, to, maxChecked: 0, reachable: new Uint8Array(1), minReachable: 0, maxReachable: 0,
    denseRange: null, gaps: [], nearest: () => 0,
  });
  if (from === to || !from || !to) return empty();

  const model = new Model(graph, assignment, weights, true);
  const border: Border = { from, to, limit: Infinity };
  const witnesses = getWitnesses(model, border, locked);
  const maxCap = witnesses.length ? witnesses[witnesses.length - 1].transfer.people : 0;
  const maxChecked = req.maxPeople !== undefined
    ? Math.max(0, Math.min(Math.trunc(req.maxPeople), Math.max(maxCap, 0)))
    : Math.min(maxCap, 5000);
  if (maxChecked <= 0) return empty();

  const reachable = new Uint8Array(maxChecked + 1);
  reachable[0] = 1;

  // 1) Combine intra-precinct chunks (multiple-choice subset-sum DP up to maxChecked)
  const groups = generate(model, [{ from, to, limit: maxChecked }], COMPACT_DEPTH, locked);
  const next = new Uint8Array(maxChecked + 1);
  let hi = 0;
  for (const group of groups) {
    next.set(reachable);
    let nextHi = hi;
    for (const people of group.byPopulation.keys()) {
      if (people <= 0 || people > maxChecked) continue;
      const upper = Math.min(hi, maxChecked - people);
      for (let s = 0; s <= upper; s++) {
        if (reachable[s]) {
          const t = s + people;
          next[t] = 1;
          if (t > nextHi) nextHi = t;
        }
      }
    }
    reachable.set(next);
    hi = nextHi;
  }

  // 2) Also fold in border units (direct populated units) via 0/1 subset-sum up to min(maxChecked, 3000)
  const unitCap = Math.min(maxChecked, 3000);
  const units = collectBorderUnits(model, { from, to, limit: unitCap }, unitCap, locked);
  if (units.length) {
    const unitReach = new Uint8Array(unitCap + 1);
    unitReach[0] = 1;
    let uHi = 0;
    const countByPop = new Map<number, number>();
    let used = 0;
    for (const u of units) {
      const c = countByPop.get(u.people) ?? 0;
      if (c >= 8) continue;
      countByPop.set(u.people, c + 1);
      const w = u.people;
      const upper = Math.min(uHi, unitCap - w);
      for (let s = upper; s >= 0; s--) {
        if (unitReach[s]) unitReach[s + w] = 1;
      }
      uHi = Math.min(unitCap, uHi + w);
      if (++used >= 200) break;
    }
    for (let k = 1; k <= unitCap; k++) if (unitReach[k]) reachable[k] = 1;
  }

  // 3) Include exact witness endpoints and witness back-peel amounts within maxChecked
  for (const w of witnesses) {
    if (w.transfer.people <= maxChecked) reachable[w.transfer.people] = 1;
    if (w.transfer.people > 0 && w.transfer.blocks.length <= 1500 && w.transfer.people <= maxChecked + 300) {
      peelBlockSet(model, border, Array.from(w.transfer.blocks), w.transfer.people, [1], 'smallest', 64, (_, peeledPop) => {
        if (peeledPop > 0 && peeledPop <= maxChecked) reachable[peeledPop] = 1;
        return false;
      });
    }
  }

  let minReachable = 0;
  let maxReachable = 0;
  for (let k = 1; k <= maxChecked; k++) {
    if (reachable[k]) {
      if (!minReachable) minReachable = k;
      maxReachable = k;
    }
  }

  const gaps: number[] = [];
  let bestFrom = 0, bestTo = -1;
  let runStart = 0;
  for (let k = 1; k <= maxReachable; k++) {
    if (reachable[k]) {
      if (!runStart) runStart = k;
      if (k - runStart > bestTo - bestFrom) { bestFrom = runStart; bestTo = k; }
    } else {
      gaps.push(k);
      runStart = 0;
    }
  }
  const denseRange = bestFrom > 0 ? { from: bestFrom, to: bestTo } : null;

  const nearest = (target: number, direction: 'either' | 'down' | 'up' = 'either'): number => {
    const t = Math.max(1, Math.min(maxChecked, Math.trunc(target)));
    if (reachable[t]) return t;
    let down = 0, up = 0;
    if (direction !== 'up') {
      for (let k = t - 1; k >= 1; k--) if (reachable[k]) { down = k; break; }
    }
    if (direction !== 'down') {
      for (let k = t + 1; k <= maxChecked; k++) if (reachable[k]) { up = k; break; }
    }
    if (direction === 'down') return down;
    if (direction === 'up') return up;
    if (!down) return up;
    if (!up) return down;
    return (t - down <= up - t) ? down : up;
  };

  return { from, to, maxChecked, reachable, minReachable, maxReachable, denseRange, gaps, nearest };
}
