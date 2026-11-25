/**
 * The user's area (AreaPreference in @zd/contracts) as the worker applies it to what the engine and
 * the planner return. They take the area themselves; this only makes sure the result keeps the
 * contract whatever they did: every solution says how many of its moved blocks lie outside the area
 * (SolutionStats.outsideArea), 'only' never lets an outside block move, and 'prefer' lists the
 * solutions that stay inside first, then the rest, fewest outside blocks first. Pure functions;
 * unit-tested in tests/unit/area.test.ts.
 */
import type { AreaPreference, Solution } from '@zd/contracts';

/** Distinct moved blocks of a solution that lie outside the area. */
export function outsideCount(sol: Pick<Solution, 'transfers'>, inside: Uint8Array): number {
  const seen = new Set<number>();
  let out = 0;
  for (const t of sol.transfers) {
    for (const b of t.blocks) {
      if (seen.has(b)) continue;
      seen.add(b);
      if (inside[b] !== 1) out++;
    }
  }
  return out;
}

/**
 * The solutions under the area rules: outsideArea filled in where the solver left it out (and
 * corrected where it disagrees with the mask), outside moves dropped with 'only', and with 'prefer'
 * a stable sort by outsideArea (inside-only first; the solver's own order is kept within each
 * count). `dropped`: how many 'only' took out.
 */
export function applyArea<S extends Solution>(solutions: S[], area: AreaPreference | undefined): { kept: S[]; dropped: number } {
  if (!area) return { kept: solutions, dropped: 0 };
  const stamped = solutions.map((s) => {
    const out = outsideCount(s, area.inside);
    return s.stats.outsideArea === out ? s : { ...s, stats: { ...s.stats, outsideArea: out } };
  });
  if (area.mode === 'only') {
    const kept = stamped.filter((s) => s.stats.outsideArea === 0);
    return { kept, dropped: stamped.length - kept.length };
  }
  const order = stamped.map((s, i) => ({ s, i }));
  order.sort((a, b) => (a.s.stats.outsideArea ?? 0) - (b.s.stats.outsideArea ?? 0) || a.i - b.i);
  return { kept: order.map((x) => x.s), dropped: 0 };
}

/** What a solution does (which blocks go where), whatever its id, kind or order of transfers. */
function effectKey(sol: Pick<Solution, 'transfers'>): string {
  return sol.transfers
    .map((t) => `${t.from}>${t.to}:${Array.from(t.blocks).sort((a, b) => a - b).join(',')}`)
    .sort()
    .join('|');
}

/**
 * One district with 'prefer': the one-way options (`oneWay`, already under applyArea: stamped and
 * inside-first) merged with the planner's two-way plans made with every outside block locked
 * (`twoWayInside`, all inside). Every option or plan that stays inside comes before any that goes
 * outside (AreaPreference), so the order is: one-way options inside, then the two-way plans inside
 * that are not one of those options, then the one-way options that go outside. At most `max`
 * entries, unless more than that stay inside (none of those is dropped). `added`: how many two-way
 * plans made it in.
 */
export function mergeInsideFirst<S extends Solution>(oneWay: S[], twoWayInside: S[], max: number): { solutions: S[]; added: number } {
  const isInside = (s: S) => (s.stats.outsideArea ?? 0) === 0;
  const inOneWay = oneWay.filter(isInside);
  const outOneWay = oneWay.filter((s) => !isInside(s));
  const seen = new Set(inOneWay.map(effectKey));
  const extra = twoWayInside.filter((s) => {
    if (!isInside(s)) return false;
    const key = effectKey(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const inside = [...inOneWay, ...extra];
  const solutions = [...inside, ...outOneWay].slice(0, Math.max(max, inside.length));
  return { solutions, added: solutions.filter((s) => extra.includes(s)).length };
}
