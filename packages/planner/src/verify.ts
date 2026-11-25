import type { Assignment, EngineGraph, PopTargets, Transfer } from '@zd/contracts';

/**
 * Whole-plan check. Deliberately an independent code path: it imports nothing from the
 * planner (only contract types), applies the transfers itself, recounts populations from
 * scratch, and counts district pieces with union-find rather than the planner's BFS.
 *
 * Unassigned (district 0, see UNASSIGNED in @zd/contracts) may be a transfer's endpoint only
 * when the input permits it: `allowOutsideAbsorb` and either 0 in `absorbers` or, with no
 * `absorbers`, `includeUnassigned`. It is held to no rule of its own: it need not reach a
 * target and may be left in any number of pieces. The district on the other side keeps
 * every rule (its target if selected, no new pieces).
 */

export type PlanIssueKind =
  | 'bad-transfer'
  | 'bad-block'
  | 'moved-twice'
  | 'wrong-source'
  | 'locked-moved'
  | 'people-mismatch'
  | 'outside-touched'
  | 'not-zeroed'
  | 'new-piece';

export interface PlanIssue {
  kind: PlanIssueKind;
  district?: number;
  block?: number;
  transfer?: number;
  detail: string;
}

export interface PlanCheckInput {
  graph: EngineGraph;
  /** The assignment the plan starts from (not mutated). */
  assignment: Assignment;
  targets: PopTargets;
  /** Selected districts; each must end at q or q + 1. */
  districts: number[];
  allowOutsideAbsorb?: boolean;
  absorbers?: number[];
  /** With `allowOutsideAbsorb` and no `absorbers`: Unassigned may take or give too. */
  includeUnassigned?: boolean;
  /** Exact deviation goals for some members, against targets.draTarget (GroupSolveRequest.goals). */
  goals?: Record<number, -1 | 0 | 1>;
  transfers: Transfer[];
  locked?: Uint8Array;
}

export interface PlanCheckResult {
  ok: boolean;
  issues: PlanIssue[];
  /** The assignment after applying every valid block move. */
  final: Assignment;
}

function pieces(graph: EngineGraph, a: Assignment, numDistricts: number): Int32Array {
  const parent = new Int32Array(graph.n);
  for (let i = 0; i < graph.n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let u = 0; u < graph.n; u++) {
    const du = a[u];
    if (du === 0) continue;
    for (let e = graph.adjOffsets[u]; e < graph.adjOffsets[u + 1]; e++) {
      const v = graph.adjTargets[e];
      if (v > u && a[v] === du) {
        const ru = find(u), rv = find(v);
        if (ru !== rv) parent[Math.max(ru, rv)] = Math.min(ru, rv);
      }
    }
  }
  const count = new Int32Array(numDistricts + 1);
  for (let u = 0; u < graph.n; u++) if (a[u] !== 0 && a[u] <= numDistricts && find(u) === u) count[a[u]]++;
  return count;
}

export function verifyPlan(input: PlanCheckInput): PlanCheckResult {
  const { graph, targets } = input;
  const k = targets.numDistricts;
  const issues: PlanIssue[] = [];
  const original = input.assignment;
  const final = original.slice();
  const selected = new Uint8Array(k + 1);
  for (const d of input.districts) if (d >= 1 && d <= k) selected[d] = 1;
  const absorbers = input.absorbers && new Set(input.absorbers);
  // Unassigned only with explicit permission; "any outside district" never includes it.
  const unassignedOk = !!input.allowOutsideAbsorb && (absorbers ? absorbers.has(0) : input.includeUnassigned === true);
  const mayTouch = (d: number) => d === 0 ? unassignedOk : !!selected[d] ||
    (!!input.allowOutsideAbsorb && (!absorbers || absorbers.has(d)));
  const touchedBlock = new Uint8Array(graph.n);

  input.transfers.forEach((t, ti) => {
    // 0 is a valid index (Unassigned); whether it may be touched is checked just below.
    const okDistrict = (d: number) => Number.isInteger(d) && d >= 0 && d <= k;
    if (!okDistrict(t.from) || !okDistrict(t.to) || t.from === t.to) {
      issues.push({ kind: 'bad-transfer', transfer: ti, detail: `transfer ${ti} has bad districts ${t.from} -> ${t.to}` });
      return;
    }
    for (const d of [t.from, t.to]) {
      if (!mayTouch(d)) issues.push({ kind: 'outside-touched', district: d, transfer: ti, detail: `District ${d} is outside the selection and allowed absorbers` });
    }
    if (!selected[t.from] && !selected[t.to]) {
      issues.push({ kind: 'outside-touched', transfer: ti, detail: `transfer ${ti} is between two outside districts` });
    }
    let sum = 0;
    let prev = -1;
    for (let i = 0; i < t.blocks.length; i++) {
      const b = t.blocks[i];
      if (!Number.isInteger(b) || b < 0 || b >= graph.n || b <= prev) {
        issues.push({ kind: 'bad-block', block: b, transfer: ti, detail: `transfer ${ti} block list is not sorted, unique and in range at ${b}` });
        prev = Math.max(prev, b);
        continue;
      }
      prev = b;
      if (touchedBlock[b]) {
        issues.push({ kind: 'moved-twice', block: b, transfer: ti, detail: `block ${b} moves more than once` });
        continue;
      }
      touchedBlock[b] = 1;
      if (input.locked && input.locked[b]) issues.push({ kind: 'locked-moved', block: b, transfer: ti, detail: `locked block ${b} moved` });
      if (final[b] !== t.from) {
        issues.push({ kind: 'wrong-source', block: b, transfer: ti, detail: `block ${b} is in District ${final[b]}, not ${t.from}` });
        continue;
      }
      final[b] = t.to;
      sum += graph.pop[b];
    }
    if (sum !== t.people) issues.push({ kind: 'people-mismatch', transfer: ti, detail: `transfer ${ti} says ${t.people} people but its blocks hold ${sum}` });
  });

  // Untouched districts really untouched, judged from the assignments alone.
  for (let b = 0; b < graph.n; b++) {
    if (final[b] === original[b]) continue;
    for (const d of [original[b], final[b]]) {
      if (!mayTouch(d)) {
        issues.push({ kind: 'outside-touched', district: d, block: b, detail: `block ${b} changed District ${d}, which must stay untouched` });
      }
    }
  }

  const popsAfter = new Array<number>(k + 1).fill(0);
  for (let b = 0; b < graph.n; b++) if (final[b] <= k) popsAfter[final[b]] += graph.pop[b];
  for (let d = 1; d <= k; d++) {
    if (!selected[d]) continue;
    const p = popsAfter[d];
    const goal = input.goals?.[d];
    if (goal !== undefined) {
      const want = targets.draTarget + goal;
      if (p !== want) {
        issues.push({ kind: 'not-zeroed', district: d, detail: `District ${d} ends at ${p}, not ${want}` });
      }
    } else {
      const zero = p === targets.q || (targets.remainder > 0 && p === targets.q + 1);
      if (!zero) issues.push({ kind: 'not-zeroed', district: d, detail: `District ${d} ends at ${p}, not ${targets.q}${targets.remainder > 0 ? ` or ${targets.q + 1}` : ''}` });
    }
  }

  // Pieces of districts 1..k only: Unassigned is never required to be contiguous.
  const before = pieces(graph, original, k);
  const after = pieces(graph, final, k);
  for (let d = 1; d <= k; d++) {
    if (after[d] > before[d]) issues.push({ kind: 'new-piece', district: d, detail: `District ${d} goes from ${before[d]} to ${after[d]} pieces` });
  }

  return { ok: issues.length === 0, issues, final };
}
