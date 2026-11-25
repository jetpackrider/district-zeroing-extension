import type { Assignment, EngineGraph, GroupFeasibility, PopTargets } from '@zd/contracts';
import { districtAdjacency, districtPopulations, unassignedContact, unassignedPermitted, unassignedSupply } from './districts';

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
  /** Adjacent districts outside the selection (never 0; see `touchesUnassigned`). */
  outsideNeighbors: number[];
  /**
   * True when a member touches unassigned blocks and the request lets Unassigned take or give
   * (see UNASSIGNED in @zd/contracts). Unassigned has no target and unlimited room to take
   * people, so an over component that touches it can always shed its excess there.
   */
  touchesUnassigned: boolean;
  /**
   * People Unassigned could give this component: everyone in the unassigned areas (connected
   * unassigned blocks) that a member touches. An under component can make up its shortfall
   * from Unassigned only if this covers it. 0 unless `touchesUnassigned`.
   */
  unassignedPeople: number;
  /** How many members end at q + 1 when the component is zeroed on its own (when excess is 0). */
  extraCount: number;
}

export interface GroupAnalysis extends GroupFeasibility {
  components: GroupComponent[];
  pops: number[];
  adjacency: number[][];
  /** Human-readable summary for the panel's live line. */
  message: string;
  /** Whether the request lets Unassigned (district 0) take or give at all. */
  unassignedAllowed: boolean;
  /** touches[d] = 1 when district d borders unassigned blocks; all 0 unless `unassignedAllowed`. */
  unassignedContact: Uint8Array;
}

export interface FeasibilityRequest {
  graph: EngineGraph;
  assignment: Assignment;
  targets: PopTargets;
  districts: number[];
  allowOutsideAbsorb?: boolean;
  absorbers?: number[];
  /** With `allowOutsideAbsorb` and no `absorbers`: Unassigned may take or give too. */
  includeUnassigned?: boolean;
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
  // Unassigned is looked at only with permission, so a request without it does no extra work.
  const unassignedAllowed = unassignedPermitted(req);
  const contact = unassignedAllowed ? unassignedContact(req.graph, req.assignment, k) : new Uint8Array(k + 1);
  const supply = unassignedAllowed ? unassignedSupply(req.graph, req.assignment, k) : undefined;

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
    const touchesUnassigned = comp.some((d) => contact[d] === 1);
    components.push({
      members: comp,
      pop,
      excess,
      outsideNeighbors: [...outside].sort((a, b) => a - b),
      touchesUnassigned,
      unassignedPeople: touchesUnassigned && supply ? supply.peopleNear(comp) : 0,
      extraCount: excess === 0 ? pop - comp.length * targets.q : 0,
    });
  }

  const allowed = req.absorbers && new Set(req.absorbers);
  /** A real outside district this component may trade with. */
  const realAbsorber = (c: GroupComponent) => !!req.allowOutsideAbsorb && c.outsideNeighbors.some(d => !allowed || allowed.has(d));
  /**
   * Unassigned can settle this component's excess: it takes any number of people from an over
   * component, but gives an under one at most the people in the unassigned areas it touches.
   * Excess never counts Unassigned: it is not a member and has no target.
   */
  const unassignedCovers = (c: GroupComponent) => c.touchesUnassigned && (c.excess > 0 || c.unassignedPeople >= -c.excess);
  const blocked = components.filter((c) => c.excess !== 0 && !realAbsorber(c) && !unassignedCovers(c));
  const extra = { components, pops, adjacency, unassignedAllowed, unassignedContact: contact };
  if (blocked.length === 0) {
    const absorbed = components.filter((c) => c.excess !== 0);
    const who = absorbed.every((c) => !realAbsorber(c)) ? 'Unassigned will take up the difference'
      : absorbed.some((c) => unassignedCovers(c)) ? 'outside neighbors and Unassigned will absorb it'
        : 'outside neighbors will absorb it';
    const message = members.length === 0
      ? 'No districts selected.'
      : absorbed.length === 0
        ? 'This group can be zeroed on its own.'
        : `This group is ${describe(absorbed.reduce((s, c) => s + c.excess, 0))}; ${who}.`;
    return { feasible: members.length > 0, excess: 0, suggestAdd: [], message, ...extra };
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
  // An under group next to Unassigned that holds too few people: say why Unassigned is no help.
  const short = worst.touchesUnassigned && worst.excess < 0
    ? ` The unassigned blocks next to it hold ${worst.unassignedPeople === 0 ? 'nobody' : `only ${worst.unassignedPeople.toLocaleString('en-US')} ${worst.unassignedPeople === 1 ? 'person' : 'people'}`}.`
    : '';
  const message = `${scope} ${describe(worst.excess)}.` + short + (parts.length ? ` ${capitalize(parts.join(', or '))}.` : '');
  return { feasible: false, excess: worst.excess, suggestAdd, message, ...extra };
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
