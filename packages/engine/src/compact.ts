import type { Assignment, EngineGraph, Transfer } from '@zd/contracts';

export const COMPACT_DEPTH = 4;

const members = new WeakMap<EngineGraph, Map<number, number[]>>();

/** Blocks of each precinct, built once per graph (a graph's precinct membership never changes). */
function precinctMembers(graph: EngineGraph): Map<number, number[]> {
  let index = members.get(graph);
  if (!index) {
    index = new Map();
    for (let b = 0; b < graph.n; b++) {
      const list = index.get(graph.precinctOf[b]);
      if (list) list.push(b);
      else index.set(graph.precinctOf[b], [b]);
    }
    members.set(graph, index);
  }
  return index;
}

/**
 * Return a block that prevents this from being a compact bite. Distances start at the
 * recipient's prior territory and run through moved blocks only. Occupied blocks must
 * have a path that uses no moved empties. An empty pocket may follow when it is attached
 * to moved population and cut off from the remaining donor.
 *
 * A precinct taken whole is one unit. When the transfer takes every block of a populated
 * precinct that lay entirely in the donor, that is a single click for the user and splits
 * nothing, however many of its blocks are empty and however many blocks deep it is. (The donor's
 * fragment of a precinct that is already split is not such a unit; it is judged block by block
 * like anything else.) A whole precinct's blocks all count as occupied,
 * and stepping between two of them is free: depth is then counted in precincts, not blocks.
 * The precinct must still be reached like anything else, so a row of whole precincts cannot
 * run more than COMPACT_DEPTH deep either.
 */
export function compactnessIssue(
  graph: EngineGraph, assignment: Assignment,
  { blocks, from, to }: Transfer,
): number | undefined {
  const { adjOffsets, adjTargets, pop, precinctOf } = graph;
  const taken = new Map<number, number>();
  for (const b of blocks) taken.set(precinctOf[b], (taken.get(precinctOf[b]) ?? 0) + 1);
  const whole = new Set<number>();
  const index = precinctMembers(graph);
  for (const [precinct, count] of taken) {
    const all = index.get(precinct)!;
    if (all.length !== count) continue; // every block of the precinct moves, so all were the donor's
    let people = 0;
    for (const b of all) people += pop[b];
    if (people !== 0) whole.add(precinct);
  }
  const solid = (b: number) => pop[b] !== 0 || whole.has(precinctOf[b]);

  const depth = new Map<number, number>();
  const occupied: number[] = [];
  const empty: number[] = [];
  for (const b of blocks) {
    depth.set(b, 0);
    (solid(b) ? occupied : empty).push(b);
  }
  if (empty.length > occupied.length) return empty[occupied.length];

  const flood = (candidates: Iterable<number>, throughEmpty: boolean) => {
    let reached = 0;
    let level: number[] = [];
    for (const b of candidates) {
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
        if (assignment[adjTargets[e]] !== to) continue;
        depth.set(b, 1);
        level.push(b);
        reached++;
        break;
      }
    }
    for (let distance = 1; level.length; distance++) {
      const pending: number[] = [];
      // `level` grows while it is walked: a step inside a precinct taken whole costs nothing.
      for (let i = 0; i < level.length; i++) {
        const b = level[i];
        const unit = whole.has(precinctOf[b]) ? precinctOf[b] : -1;
        for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
          const next = adjTargets[e];
          if (depth.get(next) !== 0 || !(throughEmpty || solid(next))) continue;
          if (unit >= 0 && precinctOf[next] === unit) {
            depth.set(next, distance);
            level.push(next);
            reached++;
          } else if (distance < COMPACT_DEPTH) pending.push(next);
        }
      }
      const next: number[] = [];
      for (const b of pending) {
        if (depth.get(b) !== 0) continue;
        depth.set(b, distance + 1);
        next.push(b);
        reached++;
      }
      level = next;
    }
    return reached;
  };

  if (flood(occupied, false) !== occupied.length) return occupied.find(b => depth.get(b) === 0);
  if (!empty.length) return;

  for (const b of empty) {
    if (depth.get(b) !== 0) continue;
    const pocket = [b];
    depth.set(b, -1);
    let attached = false;
    for (let i = 0; i < pocket.length; i++) {
      const block = pocket[i];
      for (let e = adjOffsets[block]; e < adjOffsets[block + 1]; e++) {
        const next = adjTargets[e];
        const mark = depth.get(next);
        if (mark === undefined && assignment[next] === from) return block;
        if (mark === 0) {
          depth.set(next, -1);
          pocket.push(next);
        } else if (mark !== undefined && mark > 0) attached = true;
      }
    }
    if (!attached) return b;
  }

  for (const b of blocks) depth.set(b, 0);
  if (flood(blocks, true) !== blocks.length) {
    return empty.find(b => depth.get(b) === 0);
  }
}

export function isCompactTransfer(graph: EngineGraph, assignment: Assignment, transfer: Transfer): boolean {
  return compactnessIssue(graph, assignment, transfer) === undefined;
}
