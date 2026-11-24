import type { Assignment, EngineGraph, GroupFeasibility, PopTargets } from '@zd/contracts';
import { districtAdjacency, districtPopulations } from './districts';

/** 1 when a zeroed district may hold q + 1 people (the state does not divide evenly), else 0. */
export function extraSlot(targets: PopTargets): 0 | 1 {
  return targets.remainder > 0 ? 1 : 0;
}

/**
 * Signed people a set of districts must shed (+) or gain (−) so every member can sit at
 * q or q + 1. 0 when the combined population already fits.
 */
export function populationExcess(totalPop: number, count: number, targets: PopTargets): number {
  const lo = count * targets.q;
  const hi = count * (targets.q + extraSlot(targets));
  if (totalPop > hi) return totalPop - hi;
  if (totalPop < lo) return totalPop - lo;
  return 0;
}

export interface GroupComponent {
  /** Selected districts that are connected to each other through selected districts. */
  members: number[];
  pop: number;
  excess: number;
  /** Adjacent districts outside the selection. */
  outsideNeighbors: number[];
  /** How many members end at q + 1 when the component is zeroed on its own (when excess is 0). */
  extraCount: number;
}

export interface GroupAnalysis extends GroupFeasibility {
  components: GroupComponent[];
  pops: number[];
  adjacency: number[][];
  /** Human-readable summary for the panel's live line. */
  message: string;
}

export interface FeasibilityRequest {
  graph: EngineGraph;
  assignment: Assignment;
  targets: PopTargets;
  districts: number[];
  allowOutsideAbsorb?: boolean;
  absorbers?: number[];
}

function normalizeDistricts(districts: number[], numDistricts: number): number[] {
  const out = [...new Set(districts)].filter((d) => Number.isInteger(d) && d >= 1 && d <= numDistricts);
  return out.sort((a, b) => a - b);
}

/** Group feasibility with the extra detail the planner needs. */
export function analyzeGroup(
  req: FeasibilityRequest,
  pops?: number[],
  adjacency?: number[][],
): GroupAnalysis {
  const { targets } = req;
  const k = targets.numDistricts;
  pops ??= districtPopulations(req.graph, req.assignment, k);
  adjacency ??= districtAdjacency(req.graph, req.assignment, k);
  const members = normalizeDistricts(req.districts, k);
  const inGroup = new Uint8Array(k + 1);
  for (const d of members) inGroup[d] = 1;

  // Connected components of the selection in the district adjacency graph.
  const seen = new Uint8Array(k + 1);
  const components: GroupComponent[] = [];
  for (const start of members) {
    if (seen[start]) continue;
    const comp: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const d = stack.pop()!;
      comp.push(d);
      for (const nb of adjacency[d]) if (inGroup[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
    }
    comp.sort((a, b) => a - b);
    const outside = new Set<number>();
    for (const d of comp) for (const nb of adjacency[d]) if (!inGroup[nb]) outside.add(nb);
    let pop = 0;
    for (const d of comp) pop += pops[d];
    const excess = populationExcess(pop, comp.length, targets);
    components.push({
      members: comp,
      pop,
      excess,
      outsideNeighbors: [...outside].sort((a, b) => a - b),
      extraCount: excess === 0 ? pop - comp.length * targets.q : 0,
    });
  }

  const allowed = req.absorbers && new Set(req.absorbers);
  const blocked = components.filter((c) => c.excess !== 0 && !(req.allowOutsideAbsorb &&
    c.outsideNeighbors.some(d => !allowed || allowed.has(d))));
  if (blocked.length === 0) {
    const absorbed = components.filter((c) => c.excess !== 0);
    const message = members.length === 0
      ? 'No districts selected.'
      : absorbed.length === 0
        ? 'This group can be zeroed on its own.'
        : `This group is ${describe(absorbed.reduce((s, c) => s + c.excess, 0))}; outside neighbors will absorb it.`;
    return { feasible: members.length > 0, excess: 0, suggestAdd: [], components, pops, adjacency, message };
  }

  // Report the worst blocked component (largest |excess|, then lowest district).
  const worst = [...blocked].sort((a, b) => Math.abs(b.excess) - Math.abs(a.excess) || a.members[0] - b.members[0])[0];
  const hi = extraSlot(targets);
  const suggestions: Array<{ d: number; after: number }> = [];
  for (const o of worst.outsideNeighbors) {
    const helps = worst.excess > 0 ? pops[o] < targets.q : pops[o] > targets.q + hi;
    if (!helps) continue;
    const after = populationExcess(worst.pop + pops[o], worst.members.length + 1, targets);
    if (Math.abs(after) < Math.abs(worst.excess)) suggestions.push({ d: o, after });
  }
  suggestions.sort((a, b) => Math.abs(a.after) - Math.abs(b.after) || a.d - b.d);
  const suggestAdd = suggestions.map((s) => s.d);
  const parts: string[] = [];
  if (suggestAdd.length) parts.push(`Add ${joinOr(suggestAdd.slice(0, 3).map((d) => `District ${d}`))}`);
  if (worst.outsideNeighbors.length && !req.allowOutsideAbsorb) parts.push('let outside neighbors absorb it');
  const scope = components.length > 1 ? `Districts ${worst.members.join(', ')} are` : 'This group is';
  const message = `${scope} ${describe(worst.excess)}.` + (parts.length ? ` ${capitalize(parts.join(', or '))}.` : '');
  return { feasible: false, excess: worst.excess, suggestAdd, components, pops, adjacency, message };
}

/** GroupFeasibility exactly as the contracts define it (the panel's live line). */
export function checkGroupFeasibility(req: FeasibilityRequest): GroupFeasibility {
  const a = analyzeGroup(req);
  return { feasible: a.feasible, excess: a.excess, suggestAdd: a.suggestAdd };
}

function describe(excess: number): string {
  return excess > 0 ? `${excess.toLocaleString('en-US')} over` : `${(-excess).toLocaleString('en-US')} under`;
}
function joinOr(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
