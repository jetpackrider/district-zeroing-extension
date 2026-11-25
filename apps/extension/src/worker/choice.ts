/**
 * The user's choice of which neighbors trade with one district (Scope `with`), as the worker and
 * the controller apply it. Pure functions; unit-tested in tests/unit/choice.test.ts.
 *
 * Unassigned (district 0, UNASSIGNED in @zd/contracts) is a valid neighbor on a map still being
 * drawn: it may be chosen, it is never locked, and it never has a deviation.
 */
import { UNASSIGNED, type Scope, type Solution, type SolveStatus } from '@zd/contracts';

/** Format an exact deviation goal for user-facing messages ("−1", "0", "+1"). */
export function formatGoal(goal: -1 | 0 | 1): string {
  return goal > 0 ? `+${goal}` : goal < 0 ? `\u2212${-goal}` : '0';
}

/** "Unassigned" for district 0, else `name(d)`. */
export function nameWithUnassigned(name: (d: number) => string): (d: number) => string {
  return (d) => (d === UNASSIGNED ? 'Unassigned' : name(d));
}

/** Locked districts as a set, never holding 0 (Unassigned cannot be locked). */
function lockedSetOf(lockedDistricts: readonly number[]): Set<number> {
  return new Set(lockedDistricts.filter((d) => d !== UNASSIGNED));
}

/** Every district a solution moves people out of or into. */
export function districtsTouched(sol: Pick<Solution, 'transfers' | 'borderFlows'>): Set<number> {
  const out = new Set<number>();
  for (const t of sol.transfers) {
    out.add(t.from);
    out.add(t.to);
  }
  for (const f of sol.borderFlows) {
    out.add(f.from);
    out.add(f.to);
  }
  return out;
}

/**
 * Keeps the solutions that trade only between `district` and the chosen `absorbers`. Returns the
 * kept ones, how many were dropped, and which unchosen districts the dropped ones touched.
 * No absorbers (absent or empty) = any neighbor: everything is kept. 0 (Unassigned) in `absorbers`
 * is allowed like any chosen neighbor.
 */
export function restrictToChoice<S extends Pick<Solution, 'transfers' | 'borderFlows'>>(
  solutions: S[],
  district: number,
  absorbers: readonly number[] | undefined,
): { kept: S[]; dropped: number; outside: number[] } {
  if (!absorbers || absorbers.length === 0) return { kept: solutions, dropped: 0, outside: [] };
  const allowed = new Set([district, ...absorbers]);
  const kept: S[] = [];
  const outside = new Set<number>();
  let dropped = 0;
  for (const s of solutions) {
    const bad = [...districtsTouched(s)].filter((d) => !allowed.has(d));
    if (bad.length === 0) kept.push(s);
    else {
      dropped++;
      bad.forEach((d) => outside.add(d));
    }
  }
  return { kept, dropped, outside: [...outside].sort((a, b) => a - b) };
}

/**
 * Without permission to trade with Unassigned (DistrictSolveRequest / GroupSolveRequest
 * `includeUnassigned`, or 0 in `absorbers`), district 0 is never touched. The solvers promise
 * that; this only guards against a solution doing so anyway.
 */
export function dropUnassigned<S extends Pick<Solution, 'transfers' | 'borderFlows'>>(solutions: S[]): { kept: S[]; dropped: number } {
  const kept = solutions.filter((s) => !districtsTouched(s).has(UNASSIGNED));
  return { kept, dropped: solutions.length - kept.length };
}

/** The solutions that leave every locked district alone: nothing moves into or out of one. 0 is never locked. */
export function dropLocked<S extends Pick<Solution, 'transfers' | 'borderFlows'>>(solutions: S[], lockedDistricts: readonly number[]): S[] {
  const locked = lockedSetOf(lockedDistricts);
  if (!locked.size) return solutions;
  return solutions.filter((s) => ![...districtsTouched(s)].some((d) => locked.has(d)));
}

/**
 * Takes locked districts out of a scope: off the group selection and off the neighbor choice.
 * A locked district may stay selected in one-district mode (the solve then says it is locked).
 */
export function withoutLocked(scope: Scope, lockedDistricts: readonly number[]): Scope {
  // Unassigned is never locked, so a choice of it always stays.
  const locked = lockedSetOf(lockedDistricts);
  if (!locked.size) return scope;
  if (scope.mode === 'group') {
    const districts = scope.districts.filter((d) => !locked.has(d));
    return districts.length === scope.districts.length ? scope : { ...scope, districts };
  }
  if (scope.mode === 'one' && scope.with?.some((d) => locked.has(d))) {
    const keep = scope.with.filter((d) => !locked.has(d));
    const goal = scope.goal !== undefined ? { goal: scope.goal } : {};
    return keep.length ? { mode: 'one', district: scope.district, with: keep, ...goal } : { mode: 'one', district: scope.district, ...goal };
  }
  return scope;
}

/**
 * The scope with its neighbor choice cleaned up: no duplicates, not the district itself, and (when
 * the district's neighbors are known) only districts that touch it. An empty choice is dropped.
 * 0 (Unassigned) stays when it touches the district (the neighbor lists include it then). A group
 * never holds 0: Unassigned is not a district. A valid `goal` (-1, 0 or +1) is kept.
 */
export function sanitizeScope(scope: Scope, neighborsOf: (d: number) => readonly number[] | undefined): Scope {
  if (scope.mode === 'group') {
    const districts = scope.districts.filter((d) => d !== UNASSIGNED);
    return districts.length === scope.districts.length ? scope : { ...scope, districts };
  }
  if (scope.mode !== 'one') return scope;
  const validGoal = scope.goal === -1 || scope.goal === 0 || scope.goal === 1 ? scope.goal : undefined;
  const goal = validGoal !== undefined ? { goal: validGoal } : {};
  if (scope.with === undefined) {
    return validGoal === scope.goal && (validGoal !== undefined || !('goal' in scope))
      ? scope
      : { mode: 'one', district: scope.district, ...goal };
  }
  const nbrs = neighborsOf(scope.district);
  const keep = [...new Set(scope.with)]
    .filter((d) => Number.isInteger(d) && d >= 0 && d !== scope.district && (!nbrs || nbrs.includes(d)))
    .sort((a, b) => a - b);
  return keep.length
    ? { mode: 'one', district: scope.district, with: keep, ...goal }
    : { mode: 'one', district: scope.district, ...goal };
}

/**
 * neighborTolerance for a one-district solve restricted to chosen neighbors: enough for any one of
 * them to take (or give) the whole difference, even when that leaves it further from zero than it
 * is now. The engine bounds a neighbor at max(|its deviation|, tolerance), and only the chosen
 * neighbors are absorbers, so no other district is affected. `chosenDeviations` are the real
 * districts' only: Unassigned has no deviation and no limit.
 */
export function choiceTolerance(districtDeviation: number, chosenDeviations: readonly number[], goal?: -1 | 0 | 1): number {
  const worst = chosenDeviations.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
  // Without a goal, zero means q or q + 1, which can be one person away from DRA's rounded target.
  const need = goal !== undefined ? Math.abs(districtDeviation - goal) : Math.abs(districtDeviation) + 1;
  return worst + need;
}

/** What a one-district solve asks the worker for, from the scope, the locks and Unassigned. */
export interface OneDistrictTrade {
  /** The user's choice (Scope `with`) as applied: not locked, touching the district. May hold 0. */
  chosen: number[];
  absorbers?: number[];
  /** "Any neighbor" on a map with people still unassigned (see Scope 'one'). */
  includeUnassigned?: boolean;
  neighborTolerance?: number;
  /** Set when there is no one to trade with: the solve does not run, and this is the message. */
  error?: string;
}

/**
 * The request fields of a one-district solve (PanelState / Scope contract):
 *  - a choice: exactly the chosen neighbors (0 allowed), each free to take or give the whole
 *    difference (choiceTolerance over the real ones);
 *  - "Any neighbor": every neighbor, plus Unassigned while it holds people (`unassignedPop` > 0);
 *  - with locks, "any" becomes the open neighbors, which include Unassigned when it touches the
 *    district and holds people. None open: `error`.
 * `neighbors` may include 0; undefined = not known yet (the worker then drops what touches a lock).
 * Without a choice and without unassigned people, the request is what it was before Unassigned
 * could trade (no `includeUnassigned`, no 0 in `absorbers`).
 */
export function oneDistrictTrade(o: {
  district: number;
  with?: readonly number[];
  goal?: -1 | 0 | 1;
  neighbors: readonly number[] | undefined;
  lockedDistricts: readonly number[];
  unassignedPop: number;
  deviationOf: (d: number) => number;
  name: (d: number) => string;
}): OneDistrictTrade {
  const locked = lockedSetOf(o.lockedDistricts);
  const nbrs = o.neighbors;
  const name = nameWithUnassigned(o.name);
  const chosen = o.with?.length ? o.with.filter((d) => !locked.has(d) && (nbrs?.includes(d) ?? true)) : [];
  if (chosen.length) {
    const real = chosen.filter((d) => d !== UNASSIGNED);
    return { chosen, absorbers: chosen, neighborTolerance: choiceTolerance(o.deviationOf(o.district), real.map(o.deviationOf), o.goal) };
  }
  const unassignedOpen = o.unassignedPop > 0;
  if (locked.size && nbrs) {
    const open = nbrs.filter((d) => (d === UNASSIGNED ? unassignedOpen : !locked.has(d)));
    if (open.length) return { chosen, absorbers: open };
    const who = name(o.district);
    if (nbrs.includes(UNASSIGNED)) {
      // Every real neighbor is locked; the unassigned blocks it touches are left out of "any"
      // because no one is unassigned. They can still take blocks when picked.
      return {
        chosen,
        error:
          o.deviationOf(o.district) - (o.goal ?? 0) > 0
            ? `Every district next to ${who} is locked. ${who} also touches unassigned blocks, but no one is unassigned, so "Any neighbor" leaves them out. Pick Unassigned to give blocks to it, or unlock one of its neighbors.`
            : `Every district next to ${who} is locked, and the unassigned blocks it touches hold no people, so there is no one to take. Unlock one of its neighbors.`,
      };
    }
    return { chosen, error: `Every district next to ${who} is locked, so there is nowhere for people to go. Unlock one of its neighbors.` };
  }
  return unassignedOpen ? { chosen, includeUnassigned: true } : { chosen };
}

export function joinDistrictNames(ds: readonly number[], name: (d: number) => string): string {
  const names = ds.map(name);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The status line of a one-district solve: the fallback explanation, and with a neighbor choice,
 * what was left out because it traded with districts the user did not pick.
 */
export function solveDistrictMessage(o: {
  district: number;
  chosen: readonly number[];
  goal?: -1 | 0 | 1;
  /** Options or plans shown. */
  shown: number;
  status: SolveStatus;
  fallback: boolean;
  message?: string;
  dropped?: { plans: number; outside: number[]; fallback: boolean };
  name: (d: number) => string;
}): string | undefined {
  const { chosen, shown, dropped } = o;
  const name = nameWithUnassigned(o.name);
  let message = o.message;
  const chosenNames = joinDistrictNames(chosen, name);
  if (o.fallback && shown) {
    // Unassigned has no deviation: trading with it only moves the district itself away and back.
    const after = chosen.every((d) => d === UNASSIGNED) ? `${name(o.district)} sits` : 'both districts sit';
    message = chosen.length
      ? `No one-way move hits the number, so these plans trade with ${chosenNames} in both directions. Paint the steps in order: after the first leg ${after} further from zero until the return leg is painted.`
      : 'No one-way move hits the number, so these plans trade across a border in both directions or through other neighbors. Paint the steps in order: after the first leg both districts sit further from zero until the return leg is painted.';
  }
  if (!chosen.length || o.status === 'already-zero' || o.status === 'error') return message;
  const targetPhrase = o.goal !== undefined ? `bring ${name(o.district)} to ${formatGoal(o.goal)}` : `zero ${name(o.district)}`;
  const none = `No way to ${targetPhrase} trading only with ${chosenNames} was found.`;
  if (dropped && dropped.plans > 0) {
    const n = dropped.plans;
    const what = dropped.fallback ? (n === 1 ? 'plan' : 'plans') : n === 1 ? 'option' : 'options';
    const outside = joinDistrictNames(dropped.outside, name);
    if (shown) return `${message ? `${message} ` : ''}${n} other ${what} also traded with ${outside}, which you did not pick, so ${n === 1 ? 'it is' : 'they are'} not shown.`;
    const finder = dropped.fallback ? 'The multi-border planner found' : 'Found';
    return `${none} ${finder} ${n} ${what}, but ${n === 1 ? 'it trades' : 'they trade'} with ${outside} too, which you did not pick, so nothing is shown. Pick ${outside} as well, or choose "Any neighbor".`;
  }
  if (!shown) return `${none}${message ? ` ${message}` : ''} Pick more neighbors, or choose "Any neighbor".`;
  return message;
}
