/**
 * The user's choice of which neighbors trade with one district (Scope `with`), as the worker and
 * the controller apply it. Pure functions; unit-tested in tests/unit/choice.test.ts.
 */
import type { Scope, Solution, SolveStatus } from '@zd/contracts';

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
 * No absorbers (absent or empty) = any neighbor: everything is kept.
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

/** The solutions that leave every locked district alone: nothing moves into or out of one. */
export function dropLocked<S extends Pick<Solution, 'transfers' | 'borderFlows'>>(solutions: S[], lockedDistricts: readonly number[]): S[] {
  if (!lockedDistricts.length) return solutions;
  const locked = new Set(lockedDistricts);
  return solutions.filter((s) => ![...districtsTouched(s)].some((d) => locked.has(d)));
}

/**
 * Takes locked districts out of a scope: off the group selection and off the neighbor choice.
 * A locked district may stay selected in one-district mode (the solve then says it is locked).
 */
export function withoutLocked(scope: Scope, lockedDistricts: readonly number[]): Scope {
  if (!lockedDistricts.length) return scope;
  const locked = new Set(lockedDistricts);
  if (scope.mode === 'group') {
    const districts = scope.districts.filter((d) => !locked.has(d));
    return districts.length === scope.districts.length ? scope : { ...scope, districts };
  }
  if (scope.mode === 'one' && scope.with?.some((d) => locked.has(d))) {
    const keep = scope.with.filter((d) => !locked.has(d));
    return keep.length ? { mode: 'one', district: scope.district, with: keep } : { mode: 'one', district: scope.district };
  }
  return scope;
}

/**
 * The scope with its neighbor choice cleaned up: no duplicates, not the district itself, and (when
 * the district's neighbors are known) only districts that touch it. An empty choice is dropped.
 */
export function sanitizeScope(scope: Scope, neighborsOf: (d: number) => readonly number[] | undefined): Scope {
  if (scope.mode !== 'one' || scope.with === undefined) return scope;
  const nbrs = neighborsOf(scope.district);
  const keep = [...new Set(scope.with)]
    .filter((d) => Number.isInteger(d) && d !== scope.district && (!nbrs || nbrs.includes(d)))
    .sort((a, b) => a - b);
  return keep.length ? { mode: 'one', district: scope.district, with: keep } : { mode: 'one', district: scope.district };
}

/**
 * neighborTolerance for a one-district solve restricted to chosen neighbors: enough for any one of
 * them to take (or give) the whole difference, even when that leaves it further from zero than it
 * is now. The engine bounds a neighbor at max(|its deviation|, tolerance), and only the chosen
 * neighbors are absorbers, so no other district is affected.
 */
export function choiceTolerance(districtDeviation: number, chosenDeviations: readonly number[]): number {
  const worst = chosenDeviations.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
  // +1: zero means q or q + 1, which can be one person away from DRA's rounded target.
  return worst + Math.abs(districtDeviation) + 1;
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
  /** Options or plans shown. */
  shown: number;
  status: SolveStatus;
  fallback: boolean;
  message?: string;
  dropped?: { plans: number; outside: number[]; fallback: boolean };
  name: (d: number) => string;
}): string | undefined {
  const { chosen, shown, dropped, name } = o;
  let message = o.message;
  const chosenNames = joinDistrictNames(chosen, name);
  if (o.fallback && shown) {
    message = chosen.length
      ? `No one-way move hits the number, so these plans trade with ${chosenNames} in both directions. Paint the steps in order: after the first leg both districts sit further from zero until the return leg is painted.`
      : 'No one-way move hits the number, so these plans trade across a border in both directions or through other neighbors. Paint the steps in order: after the first leg both districts sit further from zero until the return leg is painted.';
  }
  if (!chosen.length || o.status === 'already-zero' || o.status === 'error') return message;
  const none = `No way to zero ${name(o.district)} trading only with ${chosenNames} was found.`;
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
