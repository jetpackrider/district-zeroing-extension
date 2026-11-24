import type { Assignment, CostWeights, EngineGraph, SolutionStats, Transfer } from '@zd/contracts';

type Membership = Map<number, Map<number, number>>;

export const defaults: CostWeights = {
  newPrecinctSplit: 100,
  healedPrecinctSplit: -85,
  newCountySplit: 800,
  newTownSplit: 420,
  perStep: 240,
  perBlock: 0.06,
  perPopulatedBlock: 0.08,
  perimeterPerMeter: 0.006,
  neighborDeviation: 0.01,
};

function increment(counts: Map<number, number>, district: number, delta: number) {
  const count = (counts.get(district) ?? 0) + delta;
  if (count) counts.set(district, count);
  else counts.delete(district);
}

/**
 * Fast region-to-district block count tracker.
 * Uses flat typed arrays for single-district regions (99% of precincts/counties)
 * and spills only split regions to a Map. Falls back to a Map when region IDs are sparse.
 */
export class RegionTracker {
  private readonly dense: boolean;
  private readonly owner: Int32Array;
  private readonly ownerCount: Uint32Array;
  private readonly splits: Membership = new Map();
  private readonly sparse: Membership = new Map();

  constructor(maxId: number, n: number) {
    this.dense = maxId >= 0 && maxId < Math.max(65536, n * 2);
    this.owner = this.dense ? new Int32Array(maxId + 1) : new Int32Array(0);
    this.ownerCount = this.dense ? new Uint32Array(maxId + 1) : new Uint32Array(0);
  }

  clear() {
    if (this.dense) {
      this.owner.fill(0);
      this.ownerCount.fill(0);
      this.splits.clear();
    } else {
      this.sparse.clear();
    }
  }

  add(region: number, district: number) {
    if (!this.dense) {
      let counts = this.sparse.get(region);
      if (!counts) this.sparse.set(region, counts = new Map());
      increment(counts, district, 1);
      return;
    }
    const cur = this.owner[region];
    if (cur === district) {
      this.ownerCount[region]++;
    } else if (cur === 0) {
      this.owner[region] = district;
      this.ownerCount[region] = 1;
    } else if (cur > 0) {
      this.splits.set(region, new Map([[cur, this.ownerCount[region]], [district, 1]]));
      this.owner[region] = -1;
      this.ownerCount[region] = 0;
    } else {
      increment(this.splits.get(region)!, district, 1);
    }
  }

  remove(region: number, district: number) {
    if (!this.dense) {
      const counts = this.sparse.get(region);
      if (!counts) return;
      increment(counts, district, -1);
      if (!counts.size) this.sparse.delete(region);
      return;
    }
    const cur = this.owner[region];
    if (cur === district) {
      if (--this.ownerCount[region] === 0) this.owner[region] = 0;
    } else if (cur === -1) {
      const counts = this.splits.get(region)!;
      increment(counts, district, -1);
      if (counts.size === 1) {
        const [[onlyDistrict, onlyCount]] = counts;
        this.owner[region] = onlyDistrict;
        this.ownerCount[region] = onlyCount;
        this.splits.delete(region);
      } else if (counts.size === 0) {
        this.owner[region] = 0;
        this.splits.delete(region);
      }
    }
  }

  districtCount(region: number): number {
    if (!this.dense) return this.sparse.get(region)?.size ?? 0;
    const cur = this.owner[region];
    if (cur > 0) return 1;
    if (cur === 0) return 0;
    return this.splits.get(region)!.size;
  }

  countOf(region: number, district: number): number {
    if (!this.dense) return this.sparse.get(region)?.get(district) ?? 0;
    const cur = this.owner[region];
    if (cur === district) return this.ownerCount[region];
    if (cur >= 0) return 0;
    return this.splits.get(region)!.get(district) ?? 0;
  }

  hasDistrict(region: number, district: number): boolean {
    if (!this.dense) return this.sparse.get(region)?.has(district) ?? false;
    const cur = this.owner[region];
    if (cur === district) return true;
    if (cur >= 0) return false;
    return this.splits.get(region)!.has(district);
  }

  delta(region: number, from: number, to: number, size: number): number {
    const before = this.districtCount(region);
    const after = before - Number(this.countOf(region, from) === size) + Number(!this.hasDistrict(region, to));
    return Number(after > 1) - Number(before > 1);
  }

  cloneCounts(region: number): Map<number, number> {
    if (!this.dense) return new Map(this.sparse.get(region));
    const cur = this.owner[region];
    if (cur > 0) return new Map([[cur, this.ownerCount[region]]]);
    if (cur === -1) return new Map(this.splits.get(region)!);
    return new Map();
  }
}

/**
 * Graph-scoped cache stored in a WeakMap<EngineGraph, GraphState>.
 * Holds graph-only metadata, reusable typed-array scratch buffers, and an incremental
 * mirror of the most recently synced assignment (verified by a fast Uint32Array diff on
 * every call so in-place caller mutations are always detected and outputs are 100% pure).
 */
export class GraphState {
  readonly hasNegativePop: boolean;
  readonly precinctTracker: RegionTracker;
  readonly countyTracker: RegionTracker;
  readonly townTracker?: RegionTracker;
  private readonly precinctHasPopDense: Uint8Array | null;
  private readonly precinctHasPopSparse: Set<number> | null;
  readonly districtPop = new Float64Array(65536);
  readonly negativePopulation = new Float64Array(65536);
  readonly blocksOfDistrict = new Map<number, Uint32Array>();
  readonly districtOrder = new Map<number, Uint32Array>();

  // Per-block Tarjan low-link arrays (valid for districts where tarjanValid[d] === 1)
  readonly component: Uint32Array;
  readonly articulation: Uint8Array;
  readonly entry: Uint32Array;
  readonly end: Uint32Array;
  readonly subtreePopulationMass: Float64Array;
  readonly cutChildren = new Map<number, number[]>();
  private readonly tarjanValid = new Uint8Array(65536);
  private readonly low: Uint32Array;
  private readonly parent: Int32Array;
  private readonly edge: Uint32Array;

  // Reusable scratch arrays (never hold state across calls)
  readonly queue: Uint32Array;
  readonly seen: Uint32Array;
  readonly scratchRing: Uint8Array;
  readonly scratchIncluded: Uint8Array;
  growthSupport?: Uint32Array;
  growthShared?: Uint32Array;
  readonly scratchAfter: Uint16Array;
  private visit = 0;

  // Incremental assignment mirror
  private initialized = false;
  private readonly lastAssignment: Uint16Array;
  private readonly lastAssignment32: Uint32Array;
  private readonly changedBuf: Int32Array;
  private readonly diffThreshold: number;
  private readonly countScratch = new Uint32Array(65536);

  constructor(readonly graph: EngineGraph) {
    const { n, pop, precinctOf, countyOf, townOf } = graph;
    let hasNeg = false;
    let maxPrecinct = -1;
    let maxCounty = -1;
    let maxTown = 0;
    for (let b = 0; b < n; b++) {
      if (pop[b] < 0) hasNeg = true;
      if (precinctOf[b] > maxPrecinct) maxPrecinct = precinctOf[b];
      if (countyOf[b] > maxCounty) maxCounty = countyOf[b];
      if (townOf && townOf[b] > maxTown) maxTown = townOf[b];
    }
    this.hasNegativePop = hasNeg;
    this.precinctTracker = new RegionTracker(maxPrecinct, n);
    this.countyTracker = new RegionTracker(maxCounty, n);
    if (townOf) this.townTracker = new RegionTracker(maxTown, n);
    if (maxPrecinct >= 0 && maxPrecinct < Math.max(65536, n * 2)) {
      const dense = new Uint8Array(maxPrecinct + 1);
      for (let b = 0; b < n; b++) if (pop[b] !== 0) dense[precinctOf[b]] = 1;
      this.precinctHasPopDense = dense;
      this.precinctHasPopSparse = null;
    } else {
      const sparse = new Set<number>();
      for (let b = 0; b < n; b++) if (pop[b] !== 0) sparse.add(precinctOf[b]);
      this.precinctHasPopDense = null;
      this.precinctHasPopSparse = sparse;
    }

    this.component = new Uint32Array(n);
    this.articulation = new Uint8Array(n);
    this.entry = new Uint32Array(n);
    this.end = new Uint32Array(n);
    this.subtreePopulationMass = new Float64Array(n);
    this.low = new Uint32Array(n);
    this.parent = new Int32Array(n);
    this.edge = new Uint32Array(n);

    this.queue = new Uint32Array(n);
    this.seen = new Uint32Array(n);
    this.scratchRing = new Uint8Array(n);
    this.scratchIncluded = new Uint8Array(n);
    this.scratchAfter = new Uint16Array(n);

    this.lastAssignment = new Uint16Array(n);
    this.lastAssignment32 = new Uint32Array(this.lastAssignment.buffer, 0, n >>> 1);
    this.diffThreshold = Math.max(64, Math.min(8192, n >>> 3));
    this.changedBuf = new Int32Array(this.diffThreshold + 2);
  }

  precinctHasPop(precinct: number): boolean {
    if (this.precinctHasPopDense) return this.precinctHasPopDense[precinct] === 1;
    return this.precinctHasPopSparse!.has(precinct);
  }

  nextVisit(): number {
    this.visit = (this.visit + 1) >>> 0;
    if (this.visit === 0) {
      this.seen.fill(0);
      this.visit = 1;
    }
    return this.visit;
  }

  sync(assignment: Assignment) {
    const { graph, lastAssignment: last, changedBuf, diffThreshold } = this;
    const { n, pop, precinctOf, countyOf, townOf } = graph;
    if (!this.initialized) {
      this.fullRebuild(assignment);
      return;
    }

    let changedCount = 0;
    if ((assignment.byteOffset & 3) === 0 && n >= 2) {
      const a32 = new Uint32Array(assignment.buffer, assignment.byteOffset, n >>> 1);
      const b32 = this.lastAssignment32;
      const len32 = a32.length;
      for (let i = 0; i < len32; i++) {
        if (a32[i] !== b32[i]) {
          const b0 = i << 1;
          if (assignment[b0] !== last[b0]) changedBuf[changedCount++] = b0;
          if (assignment[b0 + 1] !== last[b0 + 1]) changedBuf[changedCount++] = b0 + 1;
          if (changedCount > diffThreshold) break;
        }
      }
      if (changedCount <= diffThreshold && (n & 1) && assignment[n - 1] !== last[n - 1]) {
        changedBuf[changedCount++] = n - 1;
      }
    } else {
      for (let b = 0; b < n; b++) {
        if (assignment[b] !== last[b]) {
          changedBuf[changedCount++] = b;
          if (changedCount > diffThreshold) break;
        }
      }
    }

    if (changedCount === 0) return;
    if (changedCount > diffThreshold) {
      this.fullRebuild(assignment);
      return;
    }

    // Incremental update for small diffs (changedBuf[0..changedCount-1] is strictly ascending).
    const removed = new Map<number, number[]>();
    const added = new Map<number, number[]>();
    const touchedDistricts = new Set<number>();
    const { precinctTracker, countyTracker, townTracker, districtPop, negativePopulation, scratchAfter, hasNegativePop } = this;

    for (let i = 0; i < changedCount; i++) {
      const b = changedBuf[i];
      const oldD = last[b];
      const newD = assignment[b];
      last[b] = newD;
      scratchAfter[b] = newD;
      const p = pop[b];
      const town = townOf?.[b];
      districtPop[oldD] -= p;
      districtPop[newD] += p;
      if (hasNegativePop && p < 0) {
        negativePopulation[oldD] += p;
        negativePopulation[newD] -= p;
      }
      if (oldD) {
        precinctTracker.remove(precinctOf[b], oldD);
        countyTracker.remove(countyOf[b], oldD);
        if (town) townTracker!.remove(town, oldD);
        touchedDistricts.add(oldD);
        let list = removed.get(oldD);
        if (!list) removed.set(oldD, list = []);
        list.push(b);
      }
      if (newD) {
        precinctTracker.add(precinctOf[b], newD);
        countyTracker.add(countyOf[b], newD);
        if (town) townTracker!.add(town, newD);
        touchedDistricts.add(newD);
        let list = added.get(newD);
        if (!list) added.set(newD, list = []);
        list.push(b);
      } else if (this.cutChildren.has(b)) {
        this.cutChildren.delete(b);
      }
    }

    for (const d of touchedDistricts) {
      this.tarjanValid[d] = 0;
      const oldList = this.blocksOfDistrict.get(d);
      const rem = removed.get(d);
      const add = added.get(d);
      const oldLen = oldList?.length ?? 0;
      const remLen = rem?.length ?? 0;
      const addLen = add?.length ?? 0;
      const newLen = oldLen - remLen + addLen;
      if (newLen === 0) {
        this.blocksOfDistrict.delete(d);
        this.districtOrder.delete(d);
        continue;
      }
      const next = new Uint32Array(newLen);
      let oi = 0, ri = 0, ai = 0, wi = 0;
      while (oi < oldLen || ai < addLen) {
        if (oi < oldLen && ri < remLen && oldList![oi] === rem![ri]) {
          oi++;
          ri++;
          continue;
        }
        if (ai >= addLen || (oi < oldLen && oldList![oi] < add![ai])) {
          next[wi++] = oldList![oi++];
        } else {
          next[wi++] = add![ai++];
        }
      }
      this.blocksOfDistrict.set(d, next);
    }
  }

  private fullRebuild(assignment: Assignment) {
    const { graph, lastAssignment, scratchAfter, districtPop, negativePopulation, precinctTracker, countyTracker, townTracker, countScratch, hasNegativePop } = this;
    const { n, pop, precinctOf, countyOf, townOf } = graph;
    lastAssignment.set(assignment);
    scratchAfter.set(assignment);
    districtPop.fill(0);
    if (hasNegativePop) negativePopulation.fill(0);
    precinctTracker.clear();
    countyTracker.clear();
    townTracker?.clear();
    this.tarjanValid.fill(0);
    this.cutChildren.clear();
    this.blocksOfDistrict.clear();

    const activeDistricts: number[] = [];
    for (let b = 0; b < n; b++) {
      const d = assignment[b];
      const p = pop[b];
      districtPop[d] += p;
      if (hasNegativePop && p < 0) negativePopulation[d] -= p;
      if (!d) continue;
      if (countScratch[d] === 0) activeDistricts.push(d);
      countScratch[d]++;
      precinctTracker.add(precinctOf[b], d);
      countyTracker.add(countyOf[b], d);
      const town = townOf?.[b];
      if (town) townTracker!.add(town, d);
    }
    const writePos = new Map<number, number>();
    for (const d of activeDistricts) {
      this.blocksOfDistrict.set(d, new Uint32Array(countScratch[d]));
      countScratch[d] = 0;
      writePos.set(d, 0);
    }
    for (let b = 0; b < n; b++) {
      const d = assignment[b];
      if (!d) continue;
      const pos = writePos.get(d)!;
      this.blocksOfDistrict.get(d)![pos] = b;
      writePos.set(d, pos + 1);
    }
    this.initialized = true;
  }

  ensureDistrict(d: number) {
    if (!d || this.tarjanValid[d]) return;
    const blocks = this.blocksOfDistrict.get(d);
    if (!blocks || !blocks.length) {
      this.tarjanValid[d] = 1;
      return;
    }
    const { pop, adjOffsets, adjTargets } = this.graph;
    const {
      lastAssignment: assignment, entry, end, low, parent, edge,
      subtreePopulationMass, component, articulation, cutChildren,
    } = this;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      entry[b] = 0;
      articulation[b] = 0;
      parent[b] = -1;
      edge[b] = adjOffsets[b];
      if (cutChildren.has(b)) cutChildren.delete(b);
    }

    let order = this.districtOrder.get(d);
    if (!order || order.length < blocks.length) {
      order = new Uint32Array(blocks.length);
      this.districtOrder.set(d, order);
    }

    let time = 0;
    for (let i = 0; i < blocks.length; i++) {
      const root = blocks[i];
      if (entry[root]) continue;
      let block = root;
      order[time] = root;
      entry[root] = low[root] = ++time;
      subtreePopulationMass[root] = Math.abs(pop[root]);
      component[root] = root;
      while (block >= 0) {
        if (edge[block] < adjOffsets[block + 1]) {
          const next = adjTargets[edge[block]++];
          if (assignment[next] !== d || next === parent[block]) continue;
          if (entry[next]) {
            if (entry[next] < low[block]) low[block] = entry[next];
            continue;
          }
          parent[next] = block;
          order[time] = next;
          entry[next] = low[next] = ++time;
          subtreePopulationMass[next] = Math.abs(pop[next]);
          component[next] = root;
          block = next;
        } else {
          end[block] = time;
          const previous = parent[block];
          if (previous >= 0) {
            subtreePopulationMass[previous] += subtreePopulationMass[block];
            if (low[block] < low[previous]) low[previous] = low[block];
            if (low[block] >= entry[previous]) {
              let children = cutChildren.get(previous);
              if (!children) cutChildren.set(previous, children = []);
              children.push(block);
              if (previous !== root || children.length > 1) articulation[previous] = 1;
            }
          }
          block = previous;
        }
      }
    }
    this.tarjanValid[d] = 1;
  }

  ensureAllDistricts() {
    for (const d of this.blocksOfDistrict.keys()) this.ensureDistrict(d);
  }
}

const graphCache = new WeakMap<EngineGraph, GraphState>();

export function getGraphState(graph: EngineGraph): GraphState {
  let state = graphCache.get(graph);
  if (!state) {
    state = new GraphState(graph);
    graphCache.set(graph, state);
  }
  return state;
}

export function populations(graph: EngineGraph, assignment: Assignment) {
  const state = getGraphState(graph);
  state.sync(assignment);
  return state.districtPop.slice();
}

export class Model {
  readonly state: GraphState;
  readonly component: Uint32Array;
  readonly articulation: Uint8Array;
  readonly weights: CostWeights;
  readonly negativePopulation: Float64Array;

  constructor(
    readonly graph: EngineGraph,
    readonly assignment: Assignment,
    weights?: Partial<CostWeights>,
    lazy = false,
    readonly allowLongReach = false,
  ) {
    this.weights = { ...defaults, ...weights, newTownSplit: weights?.newTownSplit ?? defaults.newTownSplit,
      perStep: weights?.perStep ?? defaults.perStep };
    const state = getGraphState(graph);
    state.sync(assignment);
    if (!lazy) state.ensureAllDistricts();
    this.state = state;
    this.component = state.component;
    this.articulation = state.articulation;
    this.negativePopulation = state.negativePopulation;
  }

  ensureDistrict(d: number) {
    this.state.ensureDistrict(d);
  }

  districtBlocks(d: number): Uint32Array {
    return this.state.blocksOfDistrict.get(d) ?? emptyBlocks;
  }

  get precinctTracker(): RegionTracker {
    return this.state.precinctTracker;
  }

  get countyTracker(): RegionTracker {
    return this.state.countyTracker;
  }

  get townTracker(): RegionTracker | undefined {
    return this.state.townTracker;
  }

  /** Additional district memberships in counties, including counties that already have a split. */
  newCountySplits(blocks: Iterable<number>, from: number, to: number): number {
    const moved = new Map<number, number>();
    const tracker = this.countyTracker;
    for (const block of blocks) {
      const county = this.graph.countyOf[block];
      if (!tracker.hasDistrict(county, to)) moved.set(county, (moved.get(county) ?? 0) + 1);
    }
    let splits = 0;
    for (const [county, count] of moved) if (count < tracker.countOf(county, from)) splits++;
    return splits;
  }

  /** Count newly divided towns across the complete transfer, including any blocks added in repair. */
  newTownSplits(transfers: readonly (Pick<Transfer, 'from' | 'to'> & { blocks: Iterable<number> })[]): number | undefined {
    const { townOf } = this.graph;
    const tracker = this.townTracker;
    if (!townOf || !tracker) return undefined;
    const towns: Membership = new Map();
    for (const transfer of transfers) for (const block of transfer.blocks) {
      const town = townOf[block];
      if (town && tracker.districtCount(town) === 1) updateRegion(towns, tracker, town, transfer);
    }
    let splits = 0;
    for (const counts of towns.values()) if (counts.size > 1) splits++;
    return splits;
  }

  get scratchAfter(): Uint16Array {
    return this.state.scratchAfter;
  }

  get scratchRing(): Uint8Array {
    return this.state.scratchRing;
  }

  get scratchIncluded(): Uint8Array {
    return this.state.scratchIncluded;
  }

  get scratchQueue(): Uint32Array {
    return this.state.queue;
  }

  nextSeen(): { seen: Uint32Array; visit: number } {
    return { seen: this.state.seen, visit: this.state.nextVisit() };
  }

  /** Blocks to take with an articulation seed, or undefined if it would strand a substantial piece. */
  fringe(seed: number, locked?: Uint8Array): number[] | undefined {
    const d = this.assignment[seed];
    this.state.ensureDistrict(d);
    if (!this.articulation[seed]) return [];
    const { entry, end, subtreePopulationMass, cutChildren } = this.state;
    const order = this.state.districtOrder.get(d)!;
    const root = this.component[seed];
    const children = cutChildren.get(seed)!;
    let restSize = end[root] - entry[root];
    let restPop = subtreePopulationMass[root] - Math.abs(this.graph.pop[seed]);
    const pieces = children.map(child => {
      const size = end[child] - entry[child] + 1;
      restSize -= size;
      restPop -= subtreePopulationMass[child];
      return { child, size, pop: subtreePopulationMass[child] };
    });
    if (restSize) pieces.push({ child: -1, size: restSize, pop: restPop });
    function* blocks(child: number) {
      if (child >= 0) {
        for (let i = entry[child] - 1; i < end[child]; i++) yield order[i];
        return;
      }
      // Enumerate the complement without walking through the cut subtrees.
      const excluded = [...children, seed].sort((a, b) => entry[a] - entry[b]);
      let i = entry[root] - 1;
      for (const skip of excluded) {
        while (i < entry[skip] - 1) yield order[i++];
        i = skip === seed ? entry[seed] : end[skip];
      }
      while (i < end[root]) yield order[i++];
    }
    // A substantial or locked piece must stay. Otherwise prefer keeping people to empty land.
    pieces.sort((a, b) => a.pop - b.pop || a.size - b.size || b.child - a.child);
    const fringe: number[] = [];
    let kept = false;
    let last: number[] = [];
    for (const { child, size, pop } of pieces) {
      const possible = isStrandable(size, pop) ? [...blocks(child)] : undefined;
      if (!possible || possible.some(block => locked?.[block])) {
        if (kept) return;
        kept = true;
      } else {
        for (const block of last) fringe.push(block);
        last = possible;
      }
    }
    if (kept) for (const block of last) fringe.push(block);
    return fringe;
  }

  score(transfers: Transfer[], after: Assignment, neighborEffect = 0): SolutionStats {
    const { graph, assignment, weights } = this;
    const { precinctTracker, countyTracker } = this.state;
    const precincts: Membership = new Map();
    const counties: Membership = new Map();
    const districts = new Set<number>();
    let people = 0;
    let blocks = 0;
    let steps = 0;
    let populatedBlocks = 0;
    let perimeterDeltaM = 0;
    for (const transfer of transfers) {
      people += transfer.people;
      districts.add(transfer.from);
      districts.add(transfer.to);
      const transferPrecincts = new Set<number>();
      for (const block of transfer.blocks) {
        blocks++;
        transferPrecincts.add(graph.precinctOf[block]);
        populatedBlocks += Number(graph.pop[block] > 0);
        updateRegion(precincts, precinctTracker, graph.precinctOf[block], transfer);
        updateRegion(counties, countyTracker, graph.countyOf[block], transfer);
        for (let edge = graph.adjOffsets[block]; edge < graph.adjOffsets[block + 1]; edge++) {
          const next = graph.adjTargets[edge];
          if (after[next] !== assignment[next] && next < block) continue;
          const beforeSides = assignment[next] === 0 ? 1 : 2;
          const afterSides = after[next] === 0 ? 1 : 2;
          perimeterDeltaM += graph.adjLen[edge] * (
            Number(after[next] !== after[block]) * afterSides -
            Number(assignment[next] !== assignment[block]) * beforeSides
          );
        }
      }
      steps += transferPrecincts.size;
    }
    let newPrecinctSplits = 0;
    let healedPrecinctSplits = 0;
    let newCountySplits = 0;
    for (const [key, counts] of precincts) {
      const before = precinctTracker.districtCount(key);
      newPrecinctSplits += Number(before === 1 && counts.size > 1);
      healedPrecinctSplits += Number(before > 1 && counts.size === 1);
    }
    for (const [key, counts] of counties) {
      newCountySplits += Math.max(0, counts.size - countyTracker.districtCount(key));
    }
    const newTownSplits = this.newTownSplits(transfers);
    const cost = newPrecinctSplits * weights.newPrecinctSplit +
      healedPrecinctSplits * weights.healedPrecinctSplit + newCountySplits * weights.newCountySplit +
      (newTownSplits ?? 0) * weights.newTownSplit + steps * weights.perStep + blocks * weights.perBlock + populatedBlocks * weights.perPopulatedBlock +
      perimeterDeltaM * weights.perimeterPerMeter + neighborEffect * weights.neighborDeviation;
    return {
      people, blocks, steps, populatedBlocks, newPrecinctSplits, healedPrecinctSplits,
      newCountySplits, ...(newTownSplits === undefined ? {} : { newTownSplits }),
      perimeterDeltaM, districtsTouched: districts.size, cost,
    };
  }

  /** For each split old component, find its remaining pieces by flooding from the cut boundary. */
  separated(after: Assignment, moved: Iterable<number>): number[][][] {
    const { graph: g, assignment, component } = this;
    const { queue, seen } = this.state;
    const boundaries = new Map<number, Set<number>>();
    for (const block of moved) {
      const from = assignment[block];
      this.state.ensureDistrict(from);
      for (let edge = g.adjOffsets[block]; edge < g.adjOffsets[block + 1]; edge++) {
        const next = g.adjTargets[edge];
        if (assignment[next] !== from || after[next] !== from) continue;
        const root = component[block];
        let boundary = boundaries.get(root);
        if (!boundary) boundaries.set(root, boundary = new Set());
        boundary.add(next);
      }
    }

    const cuts: number[][][] = [];
    const visit = this.state.nextVisit();
    for (const boundary of boundaries.values()) {
      if (boundary.size < 2) continue;
      const pieces: number[][] = [];
      let left = boundary.size;
      for (const start of boundary) {
        if (seen[start] === visit) continue;
        const district = assignment[start];
        let length = 1;
        queue[0] = start;
        seen[start] = visit;
        left--;
        for (let head = 0; head < length && (left > 0 || pieces.length > 0); head++) {
          const block = queue[head];
          for (let edge = g.adjOffsets[block]; edge < g.adjOffsets[block + 1]; edge++) {
            const next = g.adjTargets[edge];
            if (seen[next] === visit || after[next] !== district || assignment[next] !== district) continue;
            seen[next] = visit;
            queue[length++] = next;
            if (boundary.has(next)) left--;
          }
        }
        if (left === 0 && !pieces.length) break;
        pieces.push(Array.from(queue.subarray(0, length)));
      }
      if (pieces.length > 1) cuts.push(pieces);
    }
    return cuts;
  }
}

const emptyBlocks = new Uint32Array(0);

function updateRegion(changed: Membership, tracker: RegionTracker, key: number, transfer: Pick<Transfer, 'from' | 'to'>) {
  let counts = changed.get(key);
  if (!counts) changed.set(key, counts = tracker.cloneCounts(key));
  increment(counts, transfer.from, -1);
  increment(counts, transfer.to, 1);
}

// Population is checked separately against the exact target, including for tiny populated pieces.
export const isStrandable = (size: number, populationMass: number) => size <= 4 || populationMass === 0;
