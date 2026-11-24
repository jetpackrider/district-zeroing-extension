import type { Assignment, CostWeights, DeviationChange, EngineGraph, PopTargets, SolutionStats, Transfer } from '@zd/contracts';
import { districtPopulations, pairKey, regionIndex, type RegionIndex } from './districts';

function distinctDistricts(idx: RegionIndex, region: number, a: Assignment, scratch: Set<number>): number {
  scratch.clear();
  for (let i = idx.offsets[region], end = idx.offsets[region + 1]; i < end; i++) {
    const d = a[idx.blocks[i]];
    if (d !== 0) scratch.add(d);
  }
  return scratch.size;
}

export interface PlanMetrics {
  stats: SolutionStats;
  deviations: DeviationChange[];
}

/**
 * Exact stats of a whole plan, measured on the final assignment against the original:
 * - newPrecinctSplits / healedPrecinctSplits: precincts that went from one district to
 *   several / from several to one (unassigned blocks ignored).
 * - newTownSplits: towns that went from one district to several (index 0 ignored).
 * - newCountySplits: sum over counties of the increase in (districts in county − 1).
 * - perimeterDeltaM: change in the summed perimeter of all districts (shared edges count
 *   once per side; outer edges are unaffected because no block changes to/from unassigned).
 * - cost: weighted sum, with neighborDeviation applied to districts outside `selected`
 *   (positive when they end further from DRA's target). Using a shared border adds
 *   a fixed charge equal to one step, even if people cross it in both directions.
 */
export function planMetrics(
  graph: EngineGraph,
  original: Assignment,
  final: Assignment,
  transfers: Transfer[],
  targets: PopTargets,
  weights: CostWeights,
  selected: ReadonlySet<number>,
): PlanMetrics {
  const moved: number[] = [];
  let people = 0;
  let steps = 0;
  let populated = 0;
  const touched = new Set<number>();
  const borders = new Set<number>();
  for (const t of transfers) {
    touched.add(t.from).add(t.to);
    borders.add(pairKey(Math.min(t.from, t.to), Math.max(t.from, t.to)));
    const precincts = new Set<number>();
    for (const b of t.blocks) {
      precincts.add(graph.precinctOf[b]);
      moved.push(b);
      people += graph.pop[b];
      if (graph.pop[b] > 0) populated++;
    }
    steps += precincts.size;
  }
  const isMoved = new Uint8Array(graph.n);
  for (const b of moved) isMoved[b] = 1;

  const scratch = new Set<number>();
  const pIdx = regionIndex(graph.precinctOf, graph.n);
  const precincts = new Set<number>();
  const counties = new Set<number>();
  const towns = new Set<number>();
  for (const b of moved) {
    precincts.add(graph.precinctOf[b]);
    counties.add(graph.countyOf[b]);
    const town = graph.townOf?.[b];
    if (town) towns.add(town);
  }
  let newSplits = 0;
  let healed = 0;
  for (const p of precincts) {
    const before = distinctDistricts(pIdx, p, original, scratch);
    const after = distinctDistricts(pIdx, p, final, scratch);
    if (before <= 1 && after > 1) newSplits++;
    else if (before > 1 && after <= 1) healed++;
  }
  let newCounty = 0;
  if (counties.size) {
    const cIdx = regionIndex(graph.countyOf, graph.n);
    for (const c of counties) {
      const before = distinctDistricts(cIdx, c, original, scratch);
      const after = distinctDistricts(cIdx, c, final, scratch);
      if (after > before) newCounty += after - before;
    }
  }

  let newTown = 0;
  if (graph.townOf && towns.size) {
    const townIndex = regionIndex(graph.townOf, graph.n);
    for (const town of towns) {
      if (distinctDistricts(townIndex, town, original, scratch) === 1 &&
          distinctDistricts(townIndex, town, final, scratch) > 1) newTown++;
    }
  }

  // Perimeter: each directed edge (u -> v) contributes adjLen when u is assigned and differs from v.
  const { adjOffsets, adjTargets, adjLen } = graph;
  const side = (a: Assignment, u: number, v: number, len: number) => (a[u] !== 0 && a[u] !== a[v] ? len : 0);
  let perimeter = 0;
  for (const u of moved) {
    for (let e = adjOffsets[u], end = adjOffsets[u + 1]; e < end; e++) {
      const v = adjTargets[e];
      if (isMoved[v] && v < u) continue; // pair already counted from v
      const len = adjLen[e];
      perimeter += side(final, u, v, len) + side(final, v, u, len) - side(original, u, v, len) - side(original, v, u, len);
    }
  }

  const k = targets.numDistricts;
  const before = districtPopulations(graph, original, k);
  const after = districtPopulations(graph, final, k);
  const deviations: DeviationChange[] = [];
  let neighborEffect = 0;
  for (let d = 1; d <= k; d++) {
    if (before[d] === after[d]) continue;
    const dv = { district: d, before: before[d] - targets.draTarget, after: after[d] - targets.draTarget };
    deviations.push(dv);
    if (!selected.has(d)) neighborEffect += Math.abs(dv.after) - Math.abs(dv.before);
  }

  const cost =
    weights.newPrecinctSplit * newSplits +
    weights.healedPrecinctSplit * healed +
    weights.newCountySplit * newCounty +
    weights.newTownSplit * newTown +
    weights.perStep * (steps + borders.size) +
    weights.perBlock * moved.length +
    weights.perPopulatedBlock * populated +
    weights.perimeterPerMeter * perimeter +
    weights.neighborDeviation * neighborEffect;

  return {
    stats: {
      people,
      steps,
      blocks: moved.length,
      populatedBlocks: populated,
      newPrecinctSplits: newSplits,
      healedPrecinctSplits: healed,
      newCountySplits: newCounty,
      ...(graph.townOf ? { newTownSplits: newTown } : {}),
      perimeterDeltaM: perimeter,
      districtsTouched: touched.size,
      cost,
    },
    deviations,
  };
}
