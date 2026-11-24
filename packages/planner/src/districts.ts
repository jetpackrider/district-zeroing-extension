import type { Assignment, EngineGraph } from '@zd/contracts';

/** Population per district index (index 0 = unassigned). Length numDistricts + 1. */
export function districtPopulations(graph: EngineGraph, assignment: Assignment, numDistricts: number): number[] {
  const pops = new Array<number>(numDistricts + 1).fill(0);
  for (let b = 0; b < graph.n; b++) {
    const d = assignment[b];
    if (d <= numDistricts) pops[d] += graph.pop[b];
  }
  return pops;
}

/**
 * District adjacency from the block graph: for every district d, the sorted list of
 * other districts (never 0 = unassigned) that share at least one block edge with it.
 */
export function districtAdjacency(graph: EngineGraph, assignment: Assignment, numDistricts: number): number[][] {
  const sets: Array<Set<number>> = [];
  for (let d = 0; d <= numDistricts; d++) sets.push(new Set());
  const { adjOffsets, adjTargets } = graph;
  for (let u = 0; u < graph.n; u++) {
    const du = assignment[u];
    if (du === 0 || du > numDistricts) continue;
    for (let e = adjOffsets[u], end = adjOffsets[u + 1]; e < end; e++) {
      const dv = assignment[adjTargets[e]];
      if (dv !== du && dv !== 0 && dv <= numDistricts) sets[du].add(dv);
    }
  }
  return sets.map((s) => [...s].sort((a, b) => a - b));
}

/**
 * Tracks district membership while a plan is realized border by border, and counts a
 * district's connected pieces by BFS over only that district's blocks (planner side;
 * the independent check in verify.ts uses its own union-find instead).
 */
export class DistrictTracker {
  readonly assignment: Assignment;
  private readonly initialOffsets: Uint32Array;
  private readonly initialBlocks: Uint32Array;
  private readonly movedIn: number[][];
  private readonly stamp: Int32Array;
  private readonly stack: Uint32Array;
  private stampValue = 0;

  constructor(readonly graph: EngineGraph, initial: Assignment, readonly numDistricts: number) {
    this.assignment = initial.slice();
    const counts = new Uint32Array(numDistricts + 2);
    for (let b = 0; b < graph.n; b++) {
      const d = initial[b];
      if (d <= numDistricts) counts[d + 1]++;
    }
    for (let d = 1; d < counts.length; d++) counts[d] += counts[d - 1];
    this.initialOffsets = counts.slice();
    const fill = counts.slice();
    this.initialBlocks = new Uint32Array(graph.n);
    for (let b = 0; b < graph.n; b++) {
      const d = initial[b];
      if (d <= numDistricts) this.initialBlocks[fill[d]++] = b;
    }
    this.movedIn = [];
    for (let d = 0; d <= numDistricts; d++) this.movedIn.push([]);
    this.stamp = new Int32Array(graph.n);
    this.stack = new Uint32Array(graph.n);
  }

  /** Move blocks to district `to`. Caller guarantees validity. */
  apply(blocks: ArrayLike<number>, to: number): void {
    const list = this.movedIn[to];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      this.assignment[b] = to;
      list.push(b);
    }
  }

  /** Undo `apply` for the last `blocks.length` moves into `to`, restoring `from`. */
  revert(blocks: ArrayLike<number>, from: number, to: number): void {
    for (let i = 0; i < blocks.length; i++) this.assignment[blocks[i]] = from;
    this.movedIn[to].length -= blocks.length;
  }

  /** Number of connected pieces of district d in the current assignment. */
  components(d: number): number {
    if (d <= 0 || d > this.numDistricts) return 0;
    const a = this.assignment;
    const { adjOffsets, adjTargets } = this.graph;
    const mark = ++this.stampValue;
    const stamp = this.stamp;
    const stack = this.stack;
    let count = 0;
    const visit = (seed: number) => {
      if (a[seed] !== d || stamp[seed] === mark) return;
      count++;
      stamp[seed] = mark;
      let top = 0;
      stack[top++] = seed;
      while (top > 0) {
        const u = stack[--top];
        for (let e = adjOffsets[u], end = adjOffsets[u + 1]; e < end; e++) {
          const v = adjTargets[e];
          if (a[v] === d && stamp[v] !== mark) {
            stamp[v] = mark;
            stack[top++] = v;
          }
        }
      }
    };
    for (let i = this.initialOffsets[d], end = this.initialOffsets[d + 1]; i < end; i++) visit(this.initialBlocks[i]);
    for (const b of this.movedIn[d]) visit(b);
    return count;
  }
}

/** Blocks grouped by a region index (precinct or county), CSR form. Cached per graph and array. */
export interface RegionIndex {
  offsets: Uint32Array;
  blocks: Uint32Array;
}

const regionCache = new WeakMap<object, RegionIndex>();

export function regionIndex(regionOf: Uint32Array | Uint16Array, n: number): RegionIndex {
  const hit = regionCache.get(regionOf);
  if (hit && hit.blocks.length === n) return hit;
  let max = 0;
  for (let b = 0; b < n; b++) if (regionOf[b] > max) max = regionOf[b];
  const offsets = new Uint32Array(max + 2);
  for (let b = 0; b < n; b++) offsets[regionOf[b] + 1]++;
  for (let r = 1; r < offsets.length; r++) offsets[r] += offsets[r - 1];
  const fill = offsets.slice();
  const blocks = new Uint32Array(n);
  for (let b = 0; b < n; b++) blocks[fill[regionOf[b]]++] = b;
  const idx = { offsets, blocks };
  regionCache.set(regionOf, idx);
  return idx;
}

export function pairKey(from: number, to: number): number {
  return from * 65536 + to;
}
