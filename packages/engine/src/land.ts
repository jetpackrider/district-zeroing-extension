/**
 * Land contiguity.
 *
 * The block graph crosses open water on purpose: DRA counts two shores as adjacent through the
 * water-only blocks between them, and adds a few hand-made links (zero-length edges). A move that
 * is contiguous only that way is legal in DRA but reads badly on a map: a waterfront block handed
 * to the district across the river. When the graph says which blocks are water (`graph.water`),
 * the solver first works on a land-only view of the same blocks and uses the full graph only when
 * the land view cannot hit the number.
 *
 * A "land edge" joins two blocks that both have land and share a real border (length > 0).
 */
import type { Assignment, EngineGraph, Transfer } from '@zd/contracts';
import { Model } from './model';

const views = new WeakMap<EngineGraph, EngineGraph | null>();

/**
 * The same blocks with land edges only, or null when the graph has no water information or
 * nothing would be removed. Cached per graph object, so the engine's per-graph state is reused.
 * Border length lost with a removed edge is added to `outerLen`: on land, a shore is an edge of
 * the district like a coastline.
 */
export function landView(graph: EngineGraph): EngineGraph | null {
  const cached = views.get(graph);
  if (cached !== undefined) return cached;
  const { n, water, adjOffsets, adjTargets, adjLen } = graph;
  let view: EngineGraph | null = null;
  if (water && water.length === n) {
    let kept = 0;
    for (let b = 0; b < n; b++) {
      if (water[b]) continue;
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
        if (adjLen[e] > 0 && !water[adjTargets[e]]) kept++;
      }
    }
    if (kept !== adjTargets.length) {
      const offsets = new Uint32Array(n + 1);
      const targets = new Uint32Array(kept);
      const lengths = new Uint16Array(kept);
      const outer = Uint32Array.from(graph.outerLen);
      let at = 0;
      for (let b = 0; b < n; b++) {
        offsets[b] = at;
        for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
          if (!water[b] && adjLen[e] > 0 && !water[adjTargets[e]]) {
            targets[at] = adjTargets[e];
            lengths[at++] = adjLen[e];
          } else outer[b] += adjLen[e];
        }
      }
      offsets[n] = at;
      view = { ...graph, adjOffsets: offsets, adjTargets: targets, adjLen: lengths, outerLen: outer };
      views.set(view, null); // a view has nothing more to remove
    }
  }
  views.set(graph, view);
  return view;
}

/**
 * Connected components of one district. Returns the number of components and a label per block
 * (0 = not in the district, or skipped). With `skipWater`, water-only blocks are left out.
 */
function components(
  graph: EngineGraph, assignment: Assignment, district: number, skipWater: boolean,
): { count: number; label: Uint32Array } {
  const { n, adjOffsets, adjTargets, water } = graph;
  const label = new Uint32Array(n);
  const queue: number[] = [];
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (assignment[start] !== district || label[start] || (skipWater && water?.[start])) continue;
    label[start] = ++count;
    queue.length = 0;
    queue.push(start);
    for (let head = 0; head < queue.length; head++) {
      const b = queue[head];
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
        const next = adjTargets[e];
        if (assignment[next] !== district || label[next] || (skipWater && water?.[next])) continue;
        label[next] = count;
        queue.push(next);
      }
    }
  }
  return { count, label };
}

function applied(assignment: Assignment, transfers: readonly Transfer[]): Uint16Array {
  const after = Uint16Array.from(assignment);
  for (const t of transfers) for (const b of t.blocks) after[b] = t.to;
  return after;
}

/**
 * True when the transfers hold together over land alone: counting only blocks with land and only
 * land edges, neither the giving nor the receiving district ends up with more pieces than it
 * started with. `land` is the land view of the graph.
 */
export function isLandContiguous(land: EngineGraph, assignment: Assignment, transfers: readonly Transfer[]): boolean {
  const after = applied(assignment, transfers);
  const districts = new Set<number>();
  for (const t of transfers) districts.add(t.from).add(t.to);
  for (const d of districts) {
    if (components(land, after, d, true).count > components(land, assignment, d, true).count) return false;
  }
  return true;
}

/**
 * Settle empty pieces that a land-anchored transfer would strand on the full graph.
 * The caller has already connected every moved piece to the recipient on land.
 */
export function settleOnFullGraph(
  model: Model, transfer: Transfer, locked?: Uint8Array,
): Transfer | null {
  const { graph, assignment, scratchAfter: after } = model;
  const { from, to } = transfer;
  for (const b of transfer.blocks) after[b] = to;
  try {
    const cuts = model.separated(after, transfer.blocks);
    if (!cuts.length) return transfer;
    const extra: number[] = [];
    for (const pieces of cuts) {
      const ranked = pieces.map(blocks => ({
        blocks,
        population: blocks.reduce((sum, b) => sum + graph.pop[b], 0),
        first: blocks.reduce((first, b) => Math.min(first, b), graph.n),
      })).sort((a, b) => b.population - a.population || b.blocks.length - a.blocks.length || a.first - b.first);
      for (const { blocks } of ranked.slice(1)) {
        for (const b of blocks) {
          if (assignment[b] !== from || graph.pop[b] !== 0 || locked?.[b]) return null;
          extra.push(b);
        }
      }
    }
    const blocks = new Uint32Array(transfer.blocks.length + extra.length);
    blocks.set(transfer.blocks);
    blocks.set(extra, transfer.blocks.length);
    blocks.sort();
    return { ...transfer, blocks };
  } finally {
    for (const b of transfer.blocks) after[b] = from;
  }
}

/**
 * True when some block of `from` that may move shares a land edge with a block of `to`: the two
 * districts meet on land, so a transfer between them never needs to cross water.
 */
export function meetOnLand(land: EngineGraph, assignment: Assignment, from: number, to: number, locked?: Uint8Array): boolean {
  const { n, adjOffsets, adjTargets } = land;
  for (let b = 0; b < n; b++) {
    if (assignment[b] !== from || locked?.[b]) continue;
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) if (assignment[adjTargets[e]] === to) return true;
  }
  return false;
}
