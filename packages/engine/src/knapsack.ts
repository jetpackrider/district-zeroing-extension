import { type Border, type Chunk, type PrecinctOptions, compareBlocks } from './search';

type Row = { options: Chunk[]; choices: Int32Array };
type Snapshot = {
  rowIndex: number;
  costs: Float64Array;
  sizes: Uint32Array;
  perimeters: Float64Array;
  lowest: number;
  highest: number;
};
type Table = {
  costs: Float64Array;
  sizes: Uint32Array;
  perimeters: Float64Array;
  rows: Row[];
  offset: number;
  max: number;
  lastIndex: number;
  snapshots: Snapshot[];
  snapshotStride: number;
};
export type TableCache = Map<Border, {
  order: PrecinctOptions[];
  groups: Chunk[][];
  penalties: number[];
  table: Table;
}>;

function trace(rows: Row[], total: number, upTo = rows.length - 1): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = upTo; i >= 0; i--) {
    const { options, choices } = rows[i];
    const choice = choices[total];
    if (!choice) continue;
    const chunk = options[choice - 1];
    chunks.push(chunk);
    total -= chunk.people;
  }
  return chunks.reverse();
}

export function blockOrder(chunks: ArrayLike<{ blocks: ArrayLike<number> }>) {
  const blocks: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    for (let j = 0; j < chunk.blocks.length; j++) blocks.push(chunk.blocks[j]);
  }
  return blocks.sort((a, b) => a - b);
}

function fill(
  groups: Chunk[][],
  groupPenalties: number[],
  max: number,
  prevTable?: Table,
  startRow = 0,
): Table {
  let offset = 0;
  for (const options of groups) {
    let lowest = 0;
    for (const chunk of options) if (chunk.people < lowest) lowest = chunk.people;
    offset -= lowest;
  }
  const lastIndex = max + 2 * offset;
  const canReuse = !!prevTable && prevTable.offset === offset && prevTable.max === max && prevTable.lastIndex === lastIndex;

  let resumeRow = 0;
  let snap: Snapshot | undefined;
  if (canReuse && startRow > 0) {
    for (let s = prevTable.snapshots.length - 1; s >= 0; s--) {
      if (prevTable.snapshots[s].rowIndex <= startRow) {
        snap = prevTable.snapshots[s];
        resumeRow = snap.rowIndex;
        break;
      }
    }
  }

  let costs = new Float64Array(lastIndex + 1);
  let sizes = new Uint32Array(lastIndex + 1);
  let perimeters = new Float64Array(lastIndex + 1);
  let nextCosts = new Float64Array(lastIndex + 1);
  let nextSizes = new Uint32Array(lastIndex + 1);
  let nextPerimeters = new Float64Array(lastIndex + 1);
  let lowestReachable = offset;
  let highestReachable = offset;
  const rows: Row[] = [];
  const snapshots: Snapshot[] = [];
  const snapshotStride = Math.max(4, Math.ceil((groups.length * (lastIndex + 1)) / 750_000));

  if (snap && canReuse) {
    costs.set(snap.costs);
    sizes.set(snap.sizes);
    perimeters.set(snap.perimeters);
    lowestReachable = snap.lowest;
    highestReachable = snap.highest;
    for (let i = 0; i < resumeRow; i++) rows.push(prevTable.rows[i]);
    for (const existing of prevTable.snapshots) {
      if (existing.rowIndex <= resumeRow) snapshots.push(existing);
      else break;
    }
  } else {
    costs.fill(Infinity);
    costs[offset] = 0;
  }

  const reachList = new Int32Array(lastIndex + 1);

  for (let rowIndex = resumeRow; rowIndex < groups.length; rowIndex++) {
    if (rowIndex > 0 && rowIndex % snapshotStride === 0 &&
        (!snapshots.length || snapshots[snapshots.length - 1].rowIndex < rowIndex)) {
      snapshots.push({
        rowIndex,
        costs: costs.slice(),
        sizes: sizes.slice(),
        perimeters: perimeters.slice(),
        lowest: lowestReachable,
        highest: highestReachable,
      });
    }
    const options = groups[rowIndex];
    const choices = new Int32Array(lastIndex + 1);
    const current = { options, choices };
    if (!options.length) {
      rows.push(current);
      continue;
    }

    const penalty = groupPenalties[rowIndex];
    nextCosts.set(costs);
    nextSizes.set(sizes);
    nextPerimeters.set(perimeters);

    // Collect sparse reachable sums only in early rows where the table can still be sparse.
    const span = highestReachable - lowestReachable + 1;
    let useSparse = false;
    let reachLen = 0;
    if (rowIndex < 16 && options.length >= 2 && span > 32) {
      for (let sum = lowestReachable; sum <= highestReachable; sum++) {
        if (costs[sum] < Infinity) reachList[reachLen++] = sum;
      }
      useSparse = reachLen * 3 < span * 2;
    }

    let lower = lowestReachable, upper = highestReachable;
    for (let j = 0; j < options.length; j++) {
      const chunk = options[j];
      const price = chunk.cost + penalty;
      const size = chunk.blocks.length;
      const people = chunk.people;
      const perm = chunk.perimeter;
      const start = Math.max(lowestReachable, -people);
      const end = Math.min(highestReachable, lastIndex - people);
      if (start > end) continue;

      if (useSparse) {
        for (let r = 0; r < reachLen; r++) {
          const sum = reachList[r];
          if (sum < start) continue;
          if (sum > end) break;
          const cost = costs[sum] + price;
          const target = sum + people;
          const cur = nextCosts[target];
          if (cost < cur) {
            nextCosts[target] = cost;
            nextSizes[target] = sizes[sum] + size;
            nextPerimeters[target] = perimeters[sum] + perm;
            choices[target] = j + 1;
          } else if (cost === cur) {
            const count = sizes[sum] + size;
            const perimeter = perimeters[sum] + perm;
            const tie = count - nextSizes[target] || perimeter - nextPerimeters[target];
            if (tie < 0 || (tie === 0 && compareBlocks(
              blockOrder([...trace(rows, sum), chunk]),
              blockOrder(trace([...rows, current], target)),
            ) < 0)) {
              nextSizes[target] = count;
              nextPerimeters[target] = perimeter;
              choices[target] = j + 1;
            }
          }
        }
      } else {
        for (let sum = start; sum <= end; sum++) {
          const base = costs[sum];
          if (base === Infinity) continue;
          const cost = base + price;
          const target = sum + people;
          const cur = nextCosts[target];
          if (cost < cur) {
            nextCosts[target] = cost;
            nextSizes[target] = sizes[sum] + size;
            nextPerimeters[target] = perimeters[sum] + perm;
            choices[target] = j + 1;
          } else if (cost === cur) {
            const count = sizes[sum] + size;
            const perimeter = perimeters[sum] + perm;
            const tie = count - nextSizes[target] || perimeter - nextPerimeters[target];
            if (tie < 0 || (tie === 0 && compareBlocks(
              blockOrder([...trace(rows, sum), chunk]),
              blockOrder(trace([...rows, current], target)),
            ) < 0)) {
              nextSizes[target] = count;
              nextPerimeters[target] = perimeter;
              choices[target] = j + 1;
            }
          }
        }
      }
      if (start + people < lower) lower = start + people;
      if (end + people > upper) upper = end + people;
    }
    lowestReachable = lower;
    highestReachable = upper;
    rows.push(current);
    [costs, nextCosts] = [nextCosts, costs];
    [sizes, nextSizes] = [nextSizes, sizes];
    [perimeters, nextPerimeters] = [nextPerimeters, perimeters];
  }

  const limit = offset + max + 1;
  const outCosts = costs.slice(offset, limit);
  const outSizes = sizes.slice(offset, limit);
  const outPerimeters = perimeters.slice(offset, limit);
  outCosts[0] = 0;
  outSizes[0] = outPerimeters[0] = 0;
  return {
    costs: outCosts,
    sizes: outSizes,
    perimeters: outPerimeters,
    rows,
    offset,
    max,
    lastIndex,
    snapshots,
    snapshotStride,
  };
}

function borderChunks(table: Table, people: number): Chunk[] {
  return people ? trace(table.rows, people + table.offset) : [];
}

function compareTotals(table: Table, a: number, b: number) {
  if (a === b || (table.costs[a] === Infinity && table.costs[b] === Infinity)) return 0;
  return table.costs[a] - table.costs[b] || table.sizes[a] - table.sizes[b] ||
    table.perimeters[a] - table.perimeters[b] ||
    compareBlocks(blockOrder(borderChunks(table, a)), blockOrder(borderChunks(table, b)));
}

function groupSortKey(group: PrecinctOptions): number {
  let min = Infinity;
  let maxPop = 0;
  for (const [pop, list] of group.byPopulation) {
    if (list.length && list[0].cost < min) min = list[0].cost;
    if (pop > maxPop) maxPop = pop;
  }
  // Expensive tiers (county split ~300, new split ~100) come first so cheap/already-split
  // precincts stay at the end (high cache hit rate); within a tier, smaller maxPop comes first
  // so highestReachable stays narrow through early DP rows.
  const tier = min >= 250 ? 2 : min >= 50 ? 1 : 0;
  return -tier * 1_000_000 + maxPop;
}

/**
 * A multiple-choice exact-sum knapsack on each border, then a flat-array convolution of
 * the border sums. The latter enforces tolerance on all chunks going to a neighbor in aggregate.
 */
function chooseWithBorderLimits(
  groups: PrecinctOptions[], accept: number[], penalties: Map<number, number>, banned: Set<Chunk>,
  neighborWeight: number, cache: TableCache, preferLargest = false,
): Chunk[] | undefined {
  const max = accept[accept.length - 1];
  const minAccept = accept[0];
  const byBorder = new Map<Border, PrecinctOptions[]>();
  for (const group of groups) {
    let list = byBorder.get(group.border);
    if (!list) byBorder.set(group.border, list = []);
    list.push(group);
  }

  const prepared: Array<{ border: Border; order: PrecinctOptions[]; options: Chunk[][]; penalties: number[]; reach: number }> = [];
  let totalReach = 0;
  for (const [border, borderGroups] of byBorder) {
    const previous = cache.get(border);
    // Keep a stable order per border with expensive precincts first and cheap precincts last,
    // so penalizing or banning cheap precincts preserves most cached DP prefix rows.
    const order = previous && previous.order.length === borderGroups.length &&
      previous.order.every((g, i) => g === borderGroups[i] || borderGroups.includes(g))
      ? previous.order
      : borderGroups.slice().sort((a, b) => groupSortKey(a) - groupSortKey(b) || a.precinct - b.precinct);

    const options: Chunk[][] = new Array(order.length);
    const currentPenalties: number[] = new Array(order.length);
    let reach = 0;
    let nonEmpty = 0;
    for (let i = 0; i < order.length; i++) {
      const group = order[i];
      const opts: Chunk[] = [];
      let largest = 0;
      for (const [people, choices] of group.byPopulation) {
        const chunk = choices.find(option => !banned.has(option));
        if (!chunk) continue;
        opts.push(chunk);
        if (people > largest) largest = people;
      }
      options[i] = opts;
      currentPenalties[i] = penalties.get(group.precinct) ?? 0;
      reach += largest;
      if (opts.length) nonEmpty++;
    }
    if (!nonEmpty) continue;
    totalReach += Math.min(reach, border.limit);
    prepared.push({ border, order, options, penalties: currentPenalties, reach });
  }

  if (totalReach < minAccept) return;

  const tables = prepared.map(({ border, order, options, penalties: currentPenalties, reach }) => {
    const limit = Math.min(max, border.limit, reach);
    const previous = cache.get(border);
    let firstChanged = 0;
    if (previous && previous.table.max === limit && previous.groups.length === options.length) {
      firstChanged = options.length;
      for (let i = 0; i < options.length; i++) {
        if (currentPenalties[i] !== previous.penalties[i] ||
            options[i].length !== previous.groups[i].length) {
          firstChanged = i;
          break;
        }
        const a = options[i], b = previous.groups[i];
        let diff = false;
        for (let j = 0; j < a.length; j++) {
          if (a[j] !== b[j]) { diff = true; break; }
        }
        if (diff) { firstChanged = i; break; }
      }
      if (firstChanged === options.length) return previous.table;
    }

    const table = fill(
      options, currentPenalties, limit,
      previous && previous.table.max === limit ? previous.table : undefined,
      firstChanged,
    );
    if (border.effect) {
      for (let people = 1; people < table.costs.length; people++) {
        if (table.costs[people] < Infinity) table.costs[people] += border.effect(people) * neighborWeight;
      }
    }
    cache.set(border, { order, groups: options, penalties: currentPenalties, table });
    return table;
  });

  if (tables.length === 1) {
    const table = tables[0];
    const targets = accept.filter(people => Number.isFinite(table.costs[people]));
    if (!targets.length) return;
    if (preferLargest) return borderChunks(table, targets[targets.length - 1]);
    let best = targets[0];
    for (const people of targets) if (compareTotals(table, people, best) < 0) best = people;
    return Number.isFinite(table.costs[best]) ? borderChunks(table, best) : undefined;
  }

  // Flat-array multi-border convolution with suffix-reach pruning and backtracking.
  const B = tables.length;
  const suffixMax = new Int32Array(B);
  for (let i = B - 2; i >= 0; i--) {
    suffixMax[i] = suffixMax[i + 1] + (tables[i + 1].costs.length - 1);
  }

  let curCost = new Float64Array(max + 1).fill(Infinity);
  let curSize = new Uint32Array(max + 1);
  let curPerm = new Float64Array(max + 1);
  let nextCost = new Float64Array(max + 1);
  let nextSize = new Uint32Array(max + 1);
  let nextPerm = new Float64Array(max + 1);
  curCost[0] = 0;

  let curReach = new Int32Array(max + 1);
  let nextReach = new Int32Array(max + 1);
  curReach[0] = 0;
  let curReachLen = 1;

  const choiceByBorder: Int32Array[] = [];
  const traceAmounts = (borderIdx: number, total: number): number[] => {
    const out = new Array<number>(borderIdx + 1);
    let t = total;
    for (let k = borderIdx; k >= 0; k--) {
      const amt = choiceByBorder[k][t];
      out[k] = amt;
      t -= amt;
    }
    return out;
  };
  const blocksOf = (amounts: number[]) =>
    blockOrder(amounts.flatMap((total, idx) => borderChunks(tables[idx], total)));

  for (let i = 0; i < B; i++) {
    const table = tables[i];
    const tCosts = table.costs;
    const tSizes = table.sizes;
    const tPerms = table.perimeters;
    const last = i === B - 1;
    const remMax = suffixMax[i];
    const choice = new Int32Array(max + 1);
    choiceByBorder.push(choice);

    nextCost.fill(Infinity);
    let nextReachLen = 0;

    if (last) {
      for (let r = 0; r < curReachLen; r++) {
        const subtotal = curReach[r];
        const prevC = curCost[subtotal];
        const prevS = curSize[subtotal];
        const prevP = curPerm[subtotal];
        for (let a = 0; a < accept.length; a++) {
          const total = accept[a];
          const amount = total - subtotal;
          if (amount < 0 || amount >= tCosts.length) continue;
          const tc = tCosts[amount];
          if (tc === Infinity) continue;
          const cost = prevC + tc;
          const cur = nextCost[total];
          if (cost < cur) {
            if (cur === Infinity) nextReach[nextReachLen++] = total;
            nextCost[total] = cost;
            nextSize[total] = prevS + tSizes[amount];
            nextPerm[total] = prevP + tPerms[amount];
            choice[total] = amount;
          } else if (cost === cur) {
            const size = prevS + tSizes[amount];
            const perm = prevP + tPerms[amount];
            const tie = size - nextSize[total] || perm - nextPerm[total];
            if (tie < 0 || (tie === 0 && compareBlocks(
              blocksOf([...(i > 0 ? traceAmounts(i - 1, subtotal) : []), amount]),
              blocksOf(traceAmounts(i, total)),
            ) < 0)) {
              nextSize[total] = size;
              nextPerm[total] = perm;
              choice[total] = amount;
            }
          }
        }
      }
    } else {
      const tabReach = new Int32Array(tCosts.length);
      let tabReachLen = 0;
      for (let amount = 0; amount < tCosts.length; amount++) {
        if (tCosts[amount] < Infinity) tabReach[tabReachLen++] = amount;
      }
      const minTotal = Math.max(0, minAccept - remMax);
      for (let r = 0; r < curReachLen; r++) {
        const subtotal = curReach[r];
        const prevC = curCost[subtotal];
        const prevS = curSize[subtotal];
        const prevP = curPerm[subtotal];
        const minAmt = minTotal - subtotal;
        for (let a = 0; a < tabReachLen; a++) {
          const amount = tabReach[a];
          if (amount < minAmt) continue;
          const total = subtotal + amount;
          if (total > max) break;
          const cost = prevC + tCosts[amount];
          const cur = nextCost[total];
          if (cost < cur) {
            if (cur === Infinity) nextReach[nextReachLen++] = total;
            nextCost[total] = cost;
            nextSize[total] = prevS + tSizes[amount];
            nextPerm[total] = prevP + tPerms[amount];
            choice[total] = amount;
          } else if (cost === cur) {
            const size = prevS + tSizes[amount];
            const perm = prevP + tPerms[amount];
            const tie = size - nextSize[total] || perm - nextPerm[total];
            if (tie < 0 || (tie === 0 && compareBlocks(
              blocksOf([...(i > 0 ? traceAmounts(i - 1, subtotal) : []), amount]),
              blocksOf(traceAmounts(i, total)),
            ) < 0)) {
              nextSize[total] = size;
              nextPerm[total] = perm;
              choice[total] = amount;
            }
          }
        }
      }
    }

    [curCost, nextCost] = [nextCost, curCost];
    [curSize, nextSize] = [nextSize, curSize];
    [curPerm, nextPerm] = [nextPerm, curPerm];
    [curReach, nextReach] = [nextReach, curReach];
    curReachLen = nextReachLen;
    if (!curReachLen) return;
  }

  if (preferLargest) {
    for (let a = accept.length - 1; a >= 0; a--) {
      const total = accept[a];
      if (Number.isFinite(curCost[total])) {
        return traceAmounts(B - 1, total).flatMap((amount, i) => borderChunks(tables[i], amount));
      }
    }
    return;
  }

  let bestTotal = -1;
  for (let a = 0; a < accept.length; a++) {
    const total = accept[a];
    if (!Number.isFinite(curCost[total])) continue;
    if (bestTotal < 0) {
      bestTotal = total;
      continue;
    }
    const diff = curCost[total] - curCost[bestTotal] || curSize[total] - curSize[bestTotal] ||
      curPerm[total] - curPerm[bestTotal];
    if (diff < 0 || (diff === 0 &&
      compareBlocks(blocksOf(traceAmounts(B - 1, total)), blocksOf(traceAmounts(B - 1, bestTotal))) < 0)) {
      bestTotal = total;
    }
  }
  if (bestTotal < 0) return;
  return traceAmounts(B - 1, bestTotal).flatMap((amount, i) => borderChunks(tables[i], amount));
}

export function choose(
  groups: PrecinctOptions[], accept: number[], penalties: Map<number, number>, banned: Set<Chunk>,
  neighborWeight: number, cache: TableCache, preferLargest = false,
) {
  const initial = chooseWithBorderLimits(groups, accept, penalties, banned, neighborWeight, cache, preferLargest);
  if (!initial) return;

  function conflict(chunks: Chunk[]): [Chunk, Chunk] | undefined {
    const precincts = new Map<number, Chunk>();
    for (const chunk of chunks) {
      const previous = precincts.get(chunk.precinct);
      if (previous) return [previous, chunk];
      precincts.set(chunk.precinct, chunk);
    }
  }
  const shared = conflict(initial);
  if (!shared) return initial;

  type Branch = { banned: Set<Chunk>; chunks: Chunk[]; cost: number; people: number; size: number; perimeter: number };
  function branch(chunks: Chunk[], excluded: Set<Chunk>): Branch {
    const borders = new Map<Border, number>();
    let cost = 0, people = 0, size = 0, perimeter = 0;
    for (const chunk of chunks) {
      cost += chunk.cost + (penalties.get(chunk.precinct) ?? 0);
      people += chunk.people;
      size += chunk.blocks.length;
      perimeter += chunk.perimeter;
      borders.set(chunk.border, (borders.get(chunk.border) ?? 0) + chunk.people);
    }
    for (const [border, total] of borders) cost += (border.effect?.(total) ?? 0) * neighborWeight;
    return { banned: excluded, chunks, cost, people, size, perimeter };
  }

  // A shared precinct can go to only one border. Explore both restrictions
  // so a plan isn't discarded simply because its smaller transfer lost a tie.
  const pending = [branch(initial, banned)];
  for (let attempt = 0; attempt < 16 && pending.length; attempt++) {
    pending.sort((a, b) => (preferLargest ? b.people - a.people : 0) ||
      a.cost - b.cost || a.size - b.size || a.perimeter - b.perimeter ||
      compareBlocks(blockOrder(a.chunks), blockOrder(b.chunks)));
    const current = pending.shift()!;
    const pair = conflict(current.chunks);
    if (!pair) return current.chunks;
    for (const chunk of pair) {
      const group = groups.find(option => option.border === chunk.border && option.precinct === chunk.precinct)!;
      const excluded = new Set(current.banned);
      for (const options of group.byPopulation.values()) for (const option of options) excluded.add(option);
      const branchCache: TableCache = new Map(cache);
      const chunks = chooseWithBorderLimits(groups, accept, penalties, excluded, neighborWeight, branchCache, preferLargest);
      if (chunks) pending.push(branch(chunks, excluded));
    }
  }
}
