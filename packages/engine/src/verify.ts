import type { Assignment, EngineGraph, PopTargets, Solution } from '@zd/contracts';

export interface VerificationOptions {
  /** Districts required to reach an accepted target. Pass [] for an isolated border transfer. */
  districts?: readonly number[];
  locked?: Uint8Array;
  /** Apply one-district neighbor tolerance, including the default zero tolerance. */
  neighborTolerance?: number;
}

export type VerificationResult = { ok: true } | { ok: false; error: string };

const fail = (error: string): VerificationResult => ({ ok: false, error });

/**
 * Independent replay and full-map component labeling. No solver implementation is used.
 *
 * Transfers may give to or take from Unassigned (district 0, see UNASSIGNED in @zd/contracts).
 * Unassigned is held to nothing: it has no target, may be left in any number of pieces, is not
 * counted in `districtsTouched` and must not appear in `deviations`. Every real district is held
 * to the usual rules, including a district that takes unassigned blocks: they must attach to it.
 */
export function verifySolution(
  graph: EngineGraph, assignment: Assignment, targets: PopTargets, solution: Solution,
  options: VerificationOptions = {},
): VerificationResult {
  const { n, pop, adjOffsets, adjTargets } = graph;
  const { numDistricts, q, remainder, draTarget } = targets;
  if (assignment.length !== n) return fail('Assignment length does not match the graph.');
  const beforePop = new Float64Array(numDistricts + 1);
  for (let b = 0; b < n; b++) {
    if (assignment[b] > numDistricts) return fail(`Invalid district for block ${b}.`);
    beforePop[assignment[b]] += pop[b];
  }
  const after = assignment.slice();
  const moved = new Uint8Array(n);
  const borders = new Map<string, number>();
  const touched = new Set<number>();
  let total = 0, blockCount = 0, populatedCount = 0;
  for (const transfer of solution.transfers) {
    const { from, to, blocks, people } = transfer;
    if (!Number.isInteger(from) || !Number.isInteger(to) ||
      from < 0 || to < 0 || from > numDistricts || to > numDistricts || from === to || !blocks.length) {
      return fail('Invalid transfer endpoints or empty block list.');
    }
    let actual = 0, previous = -1;
    for (const b of blocks) {
      if (b >= n || moved[b] || options.locked?.[b] || after[b] !== from || b <= previous) {
        return fail(`Invalid, repeated, unsorted, or locked transfer block ${b}.`);
      }
      previous = b;
      moved[b] = 1;
      after[b] = to;
      actual += pop[b];
      blockCount++;
      if (pop[b] > 0) populatedCount++;
    }
    if (actual !== people || people <= 0) return fail(`Incorrect population for transfer ${from} to ${to}.`);
    const key = `${from}:${to}`;
    borders.set(key, (borders.get(key) ?? 0) + actual);
    total += actual;
    if (from) touched.add(from);
    if (to) touched.add(to);
  }
  if (solution.stats.people !== total || solution.stats.blocks !== blockCount ||
    solution.stats.populatedBlocks !== populatedCount || solution.stats.districtsTouched !== touched.size) {
    return fail('Transfer totals disagree with the solution statistics.');
  }
  for (const { from, to, people } of solution.borderFlows) {
    const key = `${from}:${to}`;
    if (borders.get(key) !== people) return fail('Incorrect reported border flow.');
    borders.delete(key);
  }
  if (borders.size) return fail('A border flow is missing.');

  const afterPop = new Float64Array(numDistricts + 1);
  for (let b = 0; b < n; b++) afterPop[after[b]] += pop[b];
  const atTarget = (d: number) => afterPop[d] === q || (remainder > 0 && afterPop[d] === q + 1);
  if (options.districts) {
    for (const district of options.districts) {
      if (!atTarget(district)) return fail(`District ${district} is off target.`);
    }
  } else if (solution.kind === 'single') {
    const common = [...touched].filter(d => solution.transfers.every(t => t.from === d || t.to === d));
    if (!common.some(atTarget)) return fail('No district common to all transfers reaches the target.');
  } else {
    for (const district of touched) if (!atTarget(district)) return fail(`District ${district} is off target.`);
  }
  if (options.neighborTolerance !== undefined && options.districts?.length === 1) {
    const [focus] = options.districts;
    for (const d of touched) {
      if (d === focus) continue;
      const tolerance = Math.max(Math.abs(beforePop[d] - draTarget), options.neighborTolerance);
      if (Math.abs(afterPop[d] - draTarget) > tolerance) return fail(`District ${d} exceeds neighbor tolerance.`);
    }
  }
  const deviations = new Map(solution.deviations.map(change => [change.district, change]));
  if (deviations.size !== solution.deviations.length) return fail('A district deviation is repeated.');
  for (let d = 1; d <= numDistricts; d++) {
    if (beforePop[d] === afterPop[d]) continue;
    const change = deviations.get(d);
    if (change?.before !== beforePop[d] - draTarget || change.after !== afterPop[d] - draTarget) {
      return fail(`Incorrect reported deviation for district ${d}.`);
    }
    deviations.delete(d);
  }
  if (deviations.size) return fail('An unchanged district has a reported deviation.');

  // Label every original component, then map its surviving blocks to their
  // final components. Merges are allowed, while any split or anchorless piece fails.
  const old = new Uint32Array(n);
  const visited = new Uint8Array(n);
  const stack = new Uint32Array(n);
  let oldCount = 0;
  for (let start = 0; start < n; start++) {
    const d = assignment[start];
    if (!d || old[start]) continue;
    old[start] = ++oldCount;
    stack[0] = start;
    let size = 1;
    while (size) {
      const b = stack[--size];
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
        const next = adjTargets[e];
        if (assignment[next] !== d || old[next]) continue;
        old[next] = oldCount;
        stack[size++] = next;
      }
    }
  }
  const successor = new Uint32Array(oldCount + 1);
  let finalCount = 0;
  for (let start = 0; start < n; start++) {
    const d = after[start];
    if (!d || visited[start]) continue;
    finalCount++;
    visited[start] = 1;
    stack[0] = start;
    let size = 1;
    let anchored = false;
    while (size) {
      const b = stack[--size];
      if (assignment[b] === d) {
        anchored = true;
        const original = old[b];
        if (successor[original] && successor[original] !== finalCount) {
          return fail(`District ${d} gains a disconnected piece of an original component.`);
        }
        successor[original] = finalCount;
      }
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
        const next = adjTargets[e];
        if (after[next] !== d || visited[next]) continue;
        visited[next] = 1;
        stack[size++] = next;
      }
    }
    if (!anchored) return fail(`District ${d} gains a component with no original block.`);
  }
  return { ok: true };
}
