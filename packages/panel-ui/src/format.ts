import { computeTargets, isZeroed } from '@zd/contracts';
import type { DistrictRow, MapInfo, PopField, Scope, SolutionCard, SolutionKind } from '@zd/contracts';

/** Typographic minus sign (U+2212) for clean tabular deviation formatting. */
export const MINUS = '\u2212';

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatSigned(value: number): string {
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded.toLocaleString('en-US')}`;
  if (rounded < 0) return `${MINUS}${Math.abs(rounded).toLocaleString('en-US')}`;
  return '0';
}

export function formatDeviationPhrase(deviation: number): string {
  const rounded = Math.round(deviation);
  if (rounded > 0) return `+${rounded.toLocaleString('en-US')} over`;
  if (rounded < 0) return `${MINUS}${Math.abs(rounded).toLocaleString('en-US')} under`;
  return '0 exact';
}

export function isDistrictZeroed(pop: number, map?: MapInfo): boolean {
  if (!map || map.numDistricts <= 0) return false;
  const targets = computeTargets(map.totalPop, map.numDistricts);
  return isZeroed(pop, targets);
}

export function isDeviationZeroed(deviation: number, map?: MapInfo): boolean {
  if (map && map.numDistricts > 0) {
    return isDistrictZeroed(map.target + deviation, map);
  }
  return deviation === 0;
}

export type DeviationTone = 'zero' | 'over' | 'under';

export function getDeviationTone(deviation: number, map?: MapInfo): DeviationTone {
  if (isDeviationZeroed(deviation, map)) return 'zero';
  return deviation > 0 ? 'over' : 'under';
}

export function formatDistrictName(index: number, districts: DistrictRow[]): string {
  const row = districts.find((d) => d.index === index);
  const raw = row?.label?.trim();
  if (!raw) return `District ${index}`;
  if (/^\d+$/.test(raw)) return `District ${raw}`;
  return raw;
}

export function formatDistrictShort(index: number, districts: DistrictRow[]): string {
  const row = districts.find((d) => d.index === index);
  const raw = row?.label?.trim();
  return raw && raw.length > 0 ? raw : String(index);
}

export function getDistrictColor(index: number, districts: DistrictRow[]): string | undefined {
  return districts.find((d) => d.index === index)?.color;
}

export function sortDistrictsWorstFirst(districts: DistrictRow[]): DistrictRow[] {
  return [...districts].sort((a, b) => {
    const diff = Math.abs(b.deviation) - Math.abs(a.deviation);
    if (diff !== 0) return diff;
    return a.index - b.index;
  });
}

export function formatCompactness(perimeterDeltaM: number): {
  value: string;
  label: string;
  tone: 'better' | 'worse' | 'neutral';
} {
  const abs = Math.abs(perimeterDeltaM);
  if (abs < 0.5) {
    return { value: '0 m', label: 'unchanged', tone: 'neutral' };
  }
  const sign = perimeterDeltaM < 0 ? MINUS : '+';
  const magnitude =
    abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10000 ? 1 : 2)} km` : `${Math.round(abs)} m`;
  return {
    value: `${sign}${magnitude}`,
    label: perimeterDeltaM < 0 ? 'more compact' : 'less compact',
    tone: perimeterDeltaM < 0 ? 'better' : 'worse',
  };
}

export function formatElapsed(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s`;
}

export function formatPopField(field: PopField): string {
  return field === 'D20FA' ? 'Prisoner-adjusted (D20FA)' : '2020 Census (D20F)';
}

export function formatPopFieldShort(field: PopField): string {
  return field === 'D20FA' ? 'D20FA adj.' : 'D20F';
}

export function formatSolutionTitle(kind: SolutionKind, index: number): string {
  return kind === 'single' ? `Option ${index + 1}` : `Plan ${index + 1}`;
}

/**
 * What each card is actually best at, from its own numbers. A plan's `kind` is only what the
 * planner was aiming for, and the aim can miss (the plan weighted for few blocks sometimes moves
 * more blocks than its siblings), so the claim shown to the user is computed here instead.
 * A badge goes to every card that ties for the lowest value; a measure on which all cards tie
 * tells the user nothing and gets no badge.
 */
export function solutionBadges(cards: SolutionCard[]): Map<string, string[]> {
  const badges = new Map<string, string[]>(cards.map((c) => [c.id, []]));
  if (cards.length < 2) return badges;
  const measures: Array<[string, (c: SolutionCard) => number]> = [
    ['Fewest new splits', (c) => c.stats.newPrecinctSplits + c.stats.newCountySplits],
    ['Fewest blocks', (c) => c.stats.blocks],
    ['Fewest districts', (c) => c.stats.districtsTouched],
  ];
  // Steps are only compared when every card says how many it takes.
  if (cards.every((c) => typeof c.stats.steps === 'number')) measures.push(['Fewest steps', (c) => c.stats.steps!]);
  for (const [label, value] of measures) {
    const values = cards.map(value);
    const min = Math.min(...values);
    if (values.every((v) => v === min)) continue;
    cards.forEach((c, i) => { if (values[i] === min) badges.get(c.id)!.push(label); });
  }
  return badges;
}

/** The districts a solve would work on. Locked districts are never part of a group or the whole map. */
export function getSelectedDistrictIndexes(scope: Scope, districts: DistrictRow[], locked: readonly number[] = []): number[] {
  switch (scope.mode) {
    case 'one':
      return [scope.district];
    case 'group':
      return locked.length ? scope.districts.filter((d) => !locked.includes(d)) : scope.districts;
    case 'all':
      return districts.map((d) => d.index).filter((d) => !locked.includes(d));
  }
}

export function formatShortGeoid(geoid: string): string {
  if (geoid.length <= 8) return geoid;
  return `…${geoid.slice(-7)}`;
}

export function formatPeople(count: number): string {
  const n = Math.abs(Math.round(count));
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`;
}

export function formatSteps(count: number): string {
  return `${formatInt(count)} ${count === 1 ? 'step' : 'steps'}`;
}

/** Joins district names: "District 3", "District 3 and District 7", "District 3, District 7 and District 9". */
export function joinNames(names: string[], conj = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${conj} ${names[names.length - 1]}`;
}

/** The user's choice of trading neighbors, limited to districts that still touch the district. */
export function chosenNeighbors(scope: Scope, districts: DistrictRow[]): number[] {
  if (scope.mode !== 'one' || !scope.with || scope.with.length === 0) return [];
  const row = districts.find((d) => d.index === scope.district);
  const nbrs = row?.neighbors;
  const picked = [...new Set(scope.with)].filter((d) => d !== scope.district);
  return (nbrs ? picked.filter((d) => nbrs.includes(d)) : picked).sort((a, b) => a - b);
}

export interface NeighborChoiceRow {
  index: number;
  /** Current deviation. */
  before: number;
  /** Deviation if this neighbor alone took (or gave) the whole difference. */
  after: number;
  /** It would end further from zero than it is now. */
  worse: boolean;
  /** It would land on zero. */
  zeroes: boolean;
}

/**
 * The neighbors one district can trade with, with what each would become if it took (over
 * district) or gave (under district) the whole difference. Most helped first.
 */
export function neighborChoiceRows(district: DistrictRow, districts: DistrictRow[], map?: MapInfo): NeighborChoiceRow[] {
  const rows: NeighborChoiceRow[] = [];
  for (const idx of district.neighbors ?? []) {
    const n = districts.find((d) => d.index === idx);
    if (!n || idx === district.index) continue;
    // Over: the district gives `deviation` people, the neighbor gains them. Under: the neighbor
    // gives |deviation| people. Either way the neighbor ends at its deviation plus the district's.
    const after = n.deviation + district.deviation;
    rows.push({
      index: idx,
      before: n.deviation,
      after,
      worse: Math.abs(after) > Math.abs(n.deviation) && !isDeviationZeroed(after, map),
      zeroes: isDeviationZeroed(after, map),
    });
  }
  return rows.sort(
    (a, b) => Math.abs(a.after) - Math.abs(a.before) - (Math.abs(b.after) - Math.abs(b.before)) || a.index - b.index,
  );
}

/**
 * Which way people move, in words: "District 7 gives 34 people to" / "District 3 takes 12 people
 * from". The caller appends the neighbors (or "…").
 */
export function tradeDirectionPhrase(district: DistrictRow, districts: DistrictRow[]): string {
  const name = formatDistrictName(district.index, districts);
  return district.deviation > 0
    ? `${name} gives ${formatPeople(district.deviation)} to`
    : `${name} takes ${formatPeople(district.deviation)} from`;
}
