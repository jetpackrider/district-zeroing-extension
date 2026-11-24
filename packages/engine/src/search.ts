import type { SolutionStats, Transfer } from '@zd/contracts';
import { compactnessIssue } from './compact';
import { isStrandable, Model } from './model';
import { growthRank, shapePruneMeters } from './shape';

export interface Border {
  from: number;
  to: number;
  limit: number;
  effect?: (people: number) => number;
}

export interface Chunk {
  border: Border;
  precinct: number;
  blocks: number[];
  people: number;
  perimeter: number;
  cost: number;
  tier: number;
}

export interface PrecinctOptions {
  border: Border;
  precinct: number;
  byPopulation: Map<number, Chunk[]>;
}

export function compareBlocks(a: ArrayLike<number>, b: ArrayLike<number>) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export const compareChunks = (a: Chunk, b: Chunk) =>
  a.cost - b.cost || a.blocks.length - b.blocks.length ||
  a.perimeter - b.perimeter || compareBlocks(a.blocks, b.blocks);

export function computeRing(
  model: Model, { from, to }: Border, depth: number, ring: Uint8Array, queue: Uint32Array, locked?: Uint8Array,
) {
  const { graph: g, assignment } = model;
  const fromBlocks = model.districtBlocks(from);
  const seeds = new Map<number, number[]>();
  /**
   * Empty blocks on the border, in precincts that lie entirely in the donor. They are not part of
   * the ring and never start a partial chunk; they only let such a precinct be taken whole when
   * the blocks it touches the recipient with happen to be empty (a road, a park, a shoreline).
   */
  const wholeSeeds = new Map<number, number[]>();
  let length = 0;
  for (let i = 0; i < fromBlocks.length; i++) {
    const b = fromBlocks[i];
    if (locked?.[b]) continue;
    const emptyOffRing = !model.allowLongReach && !g.pop[b];
    if (emptyOffRing && model.precinctTracker.districtCount(g.precinctOf[b]) !== 1) continue;
    for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
      if (assignment[g.adjTargets[e]] !== to) continue;
      const p = g.precinctOf[b];
      const target = emptyOffRing ? wholeSeeds : seeds;
      if (!emptyOffRing) {
        ring[b] = 1;
        queue[length++] = b;
      }
      let list = target.get(p);
      if (!list) target.set(p, list = []);
      list.push(b);
      break;
    }
  }
  for (let i = 0; i < length; i++) {
    const b = queue[i];
    if (ring[b] >= depth) continue;
    for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
      const next = g.adjTargets[e];
      if (assignment[next] !== from || locked?.[next] || ring[next] || (!model.allowLongReach && !g.pop[next])) continue;
      ring[next] = ring[b] + 1;
      queue[length++] = next;
    }
  }
  return { seeds, wholeSeeds, size: length };
}

export function borderRing(model: Model, border: Border, depth: number, locked?: Uint8Array) {
  const ring = new Uint8Array(model.graph.n);
  const queue = new Uint32Array(model.graph.n);
  const { seeds, size } = computeRing(model, border, depth, ring, queue, locked);
  return { ring, seeds, size };
}

export function generate(model: Model, borders: Border[], depth: number, locked?: Uint8Array) {
  const { graph: g, assignment: a, weights, precinctTracker, countyTracker, townTracker } = model;
  const groups: PrecinctOptions[] = [];
  const included = model.scratchIncluded;
  const ring = model.scratchRing;
  const queue = model.scratchQueue;
  const compact = weights.perimeterPerMeter > 0 && borders.some(border => Number.isFinite(border.limit));
  const support = compact ? (model.state.growthSupport ??= new Uint32Array(g.n)) : undefined;
  const shared = compact ? (model.state.growthShared ??= new Uint32Array(g.n)) : undefined;

  for (const border of borders) {
    const { from, to } = border;
    model.ensureDistrict(from);
    // Adjusted Census counts can be signed. A later negative block or chunk can
    // compensate for a positive prefix above the requested border total.
    const limit = border.limit + model.negativePopulation[from];
    const { seeds, wholeSeeds, size: ringSize } = computeRing(model, border, depth, ring, queue, locked);
    for (const precinct of wholeSeeds.keys()) if (!seeds.has(precinct)) seeds.set(precinct, []);
    try {
      for (const [precinct, seedList] of [...seeds].sort(([a], [b]) => a - b)) {
        const precinctFromCount = precinctTracker.countOf(precinct, from);
        const best = new Map<number, Chunk[]>();
        const viable = seedList.flatMap(seed => {
          const fringe = model.fringe(seed, locked);
          return fringe ? [{ seed, fringe }] : [];
        });
        const seedCount = Math.min(16, viable.length);
        let picked: typeof viable;
        if (viable.length <= 16) {
          picked = viable;
        } else {
          // Include smallest-population positive seeds and zero-pop bridgeheads alongside
          // spatially spaced seeds so small exact totals aren't skipped by blind stride.
          const chosenIdx = new Set<number>();
          const posByPop = viable
            .map((v, i) => ({ i, pop: g.pop[v.seed] }))
            .filter(x => x.pop > 0)
            .sort((x, y) => x.pop - y.pop || x.i - y.i);
          const seenPops = new Set<number>();
          for (const x of posByPop) {
            if (chosenIdx.size >= 4) break;
            if (seenPops.has(x.pop)) continue;
            seenPops.add(x.pop);
            chosenIdx.add(x.i);
          }
          const zeroIdx = viable.map((v, i) => ({ i, pop: g.pop[v.seed] })).filter(x => x.pop === 0);
          const zeroCap = Math.min(3, zeroIdx.length);
          for (let j = 0; j < zeroCap; j++) {
            chosenIdx.add(zeroIdx[Math.floor(j * zeroIdx.length / zeroCap)].i);
          }
          for (let i = 0; i < seedCount && chosenIdx.size < 16; i++) {
            chosenIdx.add(Math.floor(i * viable.length / seedCount));
          }
          picked = [...chosenIdx].sort((x, y) => x - y).map(i => viable[i]);
        }

        const entirePrecinct = precinctTracker.districtCount(precinct) === 1;
        const grow = (initial: number[], fringe: number[], whole: boolean, variant: number) => {
          const blocks: number[] = [];
          const frontier: number[] = [];
          const counties = new Map<number, number>();
          const towns = townTracker ? new Map<number, number>() : undefined;
          const movedPrecincts = new Set<number>();
          const compactGrowth = compact && !whole && variant % 4 !== 3;
          let townSplits = 0;
          let people = 0, populated = 0, nonempty = 0, perimeter = 0, precinctBlocks = 0;
          let countySplits = 0;
          function add(b: number) {
            included[b] = 2;
            blocks.push(b);
            people += g.pop[b];
            populated += Number(g.pop[b] > 0);
            nonempty += Number(g.pop[b] !== 0);
            precinctBlocks += Number(g.precinctOf[b] === precinct);
            movedPrecincts.add(g.precinctOf[b]);
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
              // A precinct that lies entirely in the donor and is taken whole is one unit (see
              // compact.ts): its growth is not held to the block ring, which leaves out every
              // empty block. Everything else, including the donor's fragment of a split
              // precinct, stays inside the ring on the normal path.
              if (included[next] === 2 || locked?.[next] || g.precinctOf[next] !== precinct ||
                (!(whole && (model.allowLongReach || entirePrecinct)) && !ring[next])) continue;
              if (included[next] === 1) {
                if (compactGrowth) support![next] += g.adjLen[edge];
                continue;
              }
              included[next] = 1;
              frontier.push(next);
              if (compactGrowth) {
                let contact = 0, length = 0;
                for (let e = g.adjOffsets[next]; e < g.adjOffsets[next + 1]; e++) {
                  const neighbor = g.adjTargets[e];
                  if (a[neighbor] === from || a[neighbor] === to) length += g.adjLen[e];
                  if (a[neighbor] === to || included[neighbor] === 2) contact += g.adjLen[e];
                }
                support![next] = contact;
                shared![next] = length;
              }
            }
          }

          function save() {
            if (!nonempty || people > limit) return;
            const split = precinctTracker.delta(precinct, from, to, precinctBlocks);
            const cost = (split > 0 ? weights.newPrecinctSplit : -split * weights.healedPrecinctSplit) +
              countySplits * weights.newCountySplit + townSplits * weights.newTownSplit +
              movedPrecincts.size * weights.perStep + blocks.length * weights.perBlock +
              populated * weights.perPopulatedBlock +
              (perimeter + (compact ? shapePruneMeters(perimeter, people) : 0)) * weights.perimeterPerMeter;
            let options = best.get(people);
            if (!options) best.set(people, options = []);
            const last = options.length === 8 ? options[7] : undefined;
            if (last && (cost - last.cost || blocks.length - last.blocks.length || perimeter - last.perimeter) > 0) {
              return;
            }
            const sorted = blocks.slice().sort((a, b) => a - b);
            if (options.some(option => compareBlocks(option.blocks, sorted) === 0)) return;
            options.push({
              border, precinct, people, cost, perimeter, blocks: sorted,
              tier: countySplits || townSplits ? 2 : split > 0 ? 1 : 0,
            });
            options.sort(compareChunks);
            if (options.length > 8) options.pop();
          }

          for (const b of initial) included[b] = 1;
          for (const b of fringe) included[b] = 1;
          for (const b of initial) add(b);
          for (const b of fringe) add(b);
          if (!whole) save();

          while (frontier.length && people <= limit) {
            let position = 0;
            if (!whole) {
              for (let i = 1; i < frontier.length; i++) {
                const x = frontier[i], y = frontier[position];
                const rank = model.articulation[x] - model.articulation[y] ||
                  (compactGrowth ? Number(g.pop[x] + people > limit) - Number(g.pop[y] + people > limit) ||
                    growthRank(support![y], shared![y], ring[y]) - growthRank(support![x], shared![x], ring[x]) : 0) ||
                  Number(g.pop[x] !== 0) - Number(g.pop[y] !== 0) ||
                  (variant % 2 ? g.pop[y] - g.pop[x] || y - x : g.pop[x] - g.pop[y] || x - y);
                if (rank < 0) position = i;
              }
            }
            const b = frontier[position];
            frontier[position] = frontier[frontier.length - 1];
            frontier.pop();
            add(b);
            if (!whole) save();
          }
          if (whole && precinctBlocks === precinctFromCount) save();
          for (const b of blocks) included[b] = 0;
          for (const b of frontier) included[b] = 0;
        };

        for (let i = 0; i < picked.length; i++) {
          const { seed, fringe } = picked[i];
          grow([seed], fringe, false, i);
        }
        // Multi-source growth permits a whole precinct with several pieces touching the recipient.
        // The relaxed pass may also include blocks outside the ring.
        grow(wholeSeeds.has(precinct) ? [...seedList, ...wholeSeeds.get(precinct)!] : seedList, [], true, 0);
        if (best.size) groups.push({ border, precinct, byPopulation: best });
      }
    } finally {
      for (let i = 0; i < ringSize; i++) ring[queue[i]] = 0;
    }
  }
  return groups;
}

export type Realized = { transfers: Transfer[]; stats: SolutionStats };
export type Rejected = {
  offender: Chunk;
  cut?: { boundary: Set<number>; piece: number[] };
  repaired?: Chunk;
};

export function realize(
  model: Model, chunks: Chunk[], accept: number[] | undefined, locked?: Uint8Array,
  borders?: Border[],
): Realized | Rejected {
  const { graph: g, assignment } = model;
  const after = model.scratchAfter;
  const owners = new Map<number, Chunk>();
  const precincts = new Set<number>();
  const totals = new Map<Border, number>();
  try {
    for (const chunk of chunks) {
      if (precincts.has(chunk.precinct)) return { offender: chunk };
      precincts.add(chunk.precinct);
      totals.set(chunk.border, (totals.get(chunk.border) ?? 0) + chunk.people);
      for (const block of chunk.blocks) {
        if (owners.has(block)) return { offender: chunk };
        after[block] = chunk.border.to;
        owners.set(block, chunk);
      }
    }
    const additions = new Map<Chunk, number[]>();
    function add(block: number, chunk: Chunk) {
      after[block] = chunk.border.to;
      owners.set(block, chunk);
      let added = additions.get(chunk);
      if (!added) additions.set(chunk, added = []);
      added.push(block);
    }

    const cuts = model.separated(after, owners.keys());
    for (const pieces of cuts) {
      const ranked = pieces.map(blocks => {
        let people = 0, mass = 0;
        let first = g.n;
        for (const block of blocks) {
          people += g.pop[block];
          mass += Math.abs(g.pop[block]);
          first = Math.min(first, block);
        }
        return { blocks, people, mass, first, removable: isStrandable(blocks.length, mass) &&
          !blocks.some(block => locked?.[block]) };
      }).sort((a, b) =>
        Number(a.removable) - Number(b.removable) || b.mass - a.mass ||
        b.blocks.length - a.blocks.length || a.first - b.first);
      for (const piece of ranked.slice(1)) {
        let owner: Chunk | undefined;
        let fitting: Chunk | undefined;
        const contacts = new Map<Chunk, Set<number>>();
        for (const block of piece.blocks) for (let e = g.adjOffsets[block]; e < g.adjOffsets[block + 1]; e++) {
          const next = g.adjTargets[e];
          const adjacent = owners.get(next);
          if (adjacent?.border.from !== assignment[block]) continue;
          owner ??= adjacent;
          let blocks = contacts.get(adjacent);
          if (!blocks) contacts.set(adjacent, blocks = new Set());
          blocks.add(next);
          const combined = (totals.get(adjacent.border) ?? 0) + piece.people;
          if (combined > 0 && combined <= adjacent.border.limit) fitting ??= adjacent;
        }
        // Every remaining piece of a cut component has an edge to the moved set.
        if (!owner || !piece.removable) {
          for (const [chunk, blocks] of contacts) {
            if (!owner || blocks.size > contacts.get(owner)!.size) owner = chunk;
          }
          return owner ? { offender: owner, cut: { boundary: contacts.get(owner)!, piece: piece.blocks } } :
            { offender: chunks[0] };
        }
        const chunk = fitting ?? owner;
        for (const block of piece.blocks) add(block, chunk);
        totals.set(chunk.border, totals.get(chunk.border)! + piece.people);
      }
    }

    const total = [...totals.values()].reduce((sum, people) => sum + people, 0);
    const overflow = [...totals].find(([border, people]) => people <= 0 || people > border.limit)?.[0];
    if (overflow || (accept && !accept.includes(total))) {
      const changed = [...additions].find(([chunk, blocks]) =>
        (!overflow || chunk.border === overflow) && blocks.some(block => g.pop[block] !== 0));
      if (!changed) return { offender: chunks.find(chunk => chunk.border === overflow) ?? chunks[0] };
      // If one chunk owns the cut, its repaired population can take part in the next exact sum.
      const [offender, added] = changed;
      const repairedPeople = offender.people + added.reduce((sum, block) => sum + g.pop[block], 0);
      const repaired = repairedPeople <= offender.border.limit + model.negativePopulation[offender.border.from] ? {
        ...offender, people: repairedPeople, blocks: [...offender.blocks, ...added].sort((a, b) => a - b),
      } : undefined;
      return { offender, repaired };
    }

    // A zero-population pocket bounded entirely by the new recipient can follow the border.
    // The original boundary must include a move, since the flood is seeded from moved blocks.
    const { seen, visit } = model.nextSeen();
    for (const [block, chunk] of owners) {
      const { from, to } = chunk.border;
      for (let edge = g.adjOffsets[block]; edge < g.adjOffsets[block + 1]; edge++) {
        const start = g.adjTargets[edge];
        if (seen[start] === visit || after[start] !== from || g.pop[start]) continue;
        const pocket = [start];
        seen[start] = visit;
        let enclosed = true;
        for (let i = 0; i < pocket.length; i++) {
          const current = pocket[i];
          if (locked?.[current]) enclosed = false;
          for (let e = g.adjOffsets[current]; e < g.adjOffsets[current + 1]; e++) {
            const next = g.adjTargets[e];
            if (after[next] === to) continue;
            if (after[next] !== from || g.pop[next]) enclosed = false;
            else if (seen[next] !== visit) {
              seen[next] = visit;
              pocket.push(next);
            }
          }
        }
        if (enclosed) for (const b of pocket) add(b, chunk);
      }
    }

    const moved = new Map<Border, number[]>();
    for (const [block, chunk] of owners) {
      let list = moved.get(chunk.border);
      if (!list) moved.set(chunk.border, list = []);
      list.push(block);
    }
    const transfers: Transfer[] = [];
    for (const [border, blocks] of moved) {
      transfers.push({
        from: border.from, to: border.to, people: totals.get(border)!,
        blocks: Uint32Array.from(blocks.sort((a, b) => a - b)),
      });
    }
    transfers.sort((a, b) => a.from - b.from || a.to - b.to);
    const effect = borders ? transfers.reduce((sum, transfer) => sum +
      (borders.find(b => b.from === transfer.from && b.to === transfer.to)
        ?.effect?.(transfer.people) ?? 0), 0) : 0;
    let longReach = false;
    for (const transfer of transfers) {
      const block = compactnessIssue(g, assignment, transfer);
      if (block === undefined) continue;
      if (!model.allowLongReach) return { offender: owners.get(block)! };
      longReach = true;
    }
    const stats = model.score(transfers, after, effect);
    if (longReach) stats.longReach = true;
    return { transfers, stats };
  } finally {
    for (const block of owners.keys()) after[block] = assignment[block];
  }
}
