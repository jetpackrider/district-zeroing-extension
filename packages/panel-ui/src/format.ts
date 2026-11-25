import { UNASSIGNED, computeTargets, isZeroed } from '@zd/contracts';
import type { DistrictRow, MapInfo, PanelState, PopField, Scope, SolutionCard, SolutionKind } from '@zd/contracts';

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

/** True when a district sits at its goal: exact deviation if `goal` is set, else the zero rule. */
export function isAtGoal(deviation: number, goal: -1 | 0 | 1 | undefined, map?: MapInfo): boolean {
  if (goal !== undefined) return deviation === goal;
  return isDeviationZeroed(deviation, map);
}

/** Signed people a district must give (+) or take (−) to reach its goal (default 0). */
export function deltaToGoal(deviation: number, goal?: -1 | 0 | 1): number {
  return deviation - (goal ?? 0);
}

export type DeviationTone = 'zero' | 'over' | 'under';

export function getDeviationTone(deviation: number, map?: MapInfo): DeviationTone {
  if (isDeviationZeroed(deviation, map)) return 'zero';
  return deviation > 0 ? 'over' : 'under';
}

/**
 * Unassigned (district 0) is not a district: a map still being drawn has blocks in no district.
 * Everywhere the panel turns a district index into words, 0 reads "Unassigned".
 */
export const UNASSIGNED_NAME = 'Unassigned';

/** Neutral grey for Unassigned's swatch (DRA draws unassigned blocks uncolored). */
export const UNASSIGNED_COLOR = '#9ca3af';

export function isUnassigned(index: number): boolean {
  return index === UNASSIGNED;
}

export function formatDistrictName(index: number, districts: DistrictRow[]): string {
  if (isUnassigned(index)) return UNASSIGNED_NAME;
  const row = districts.find((d) => d.index === index);
  const raw = row?.label?.trim();
  if (!raw) return `District ${index}`;
  if (/^\d+$/.test(raw)) return `District ${raw}`;
  return raw;
}

export function formatDistrictShort(index: number, districts: DistrictRow[]): string {
  if (isUnassigned(index)) return UNASSIGNED_NAME;
  const row = districts.find((d) => d.index === index);
  const raw = row?.label?.trim();
  return raw && raw.length > 0 ? raw : String(index);
}

export function getDistrictColor(index: number, districts: DistrictRow[]): string | undefined {
  if (isUnassigned(index)) return UNASSIGNED_COLOR;
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
export function neighborChoiceRows(
  district: DistrictRow,
  districts: DistrictRow[],
  map?: MapInfo,
  goal?: -1 | 0 | 1,
): NeighborChoiceRow[] {
  const delta = deltaToGoal(district.deviation, goal);
  const rows: NeighborChoiceRow[] = [];
  for (const idx of district.neighbors ?? []) {
    const n = districts.find((d) => d.index === idx);
    if (!n || idx === district.index) continue;
    // Over (delta > 0): the district gives `delta` people, the neighbor gains them. Under
    // (delta < 0): the neighbor gives |delta| people. Either way the neighbor ends at its deviation + delta.
    const after = n.deviation + delta;
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

/** Names for a list of district indexes, with Unassigned (if listed) last: "District 2 and Unassigned". */
export function formatNeighborNames(indexes: number[], districts: DistrictRow[]): string[] {
  const real = indexes.filter((d) => !isUnassigned(d));
  const names = real.map((d) => formatDistrictName(d, districts));
  if (real.length < indexes.length) names.push(UNASSIGNED_NAME);
  return names;
}

/** What trading with Unassigned would do, for the neighbor choice of one district. */
export interface UnassignedChoice {
  /** People in unassigned blocks now (DRA's Unassigned row; 0 when absent). */
  before: number;
  /**
   * People in unassigned blocks if Unassigned took (over district) or gave (under district) the
   * whole difference. Never below 0: Unassigned cannot give people it does not have.
   */
  after: number;
  /**
   * "Any neighbor" includes Unassigned: only while it holds people (a map still being drawn).
   * On a finished map it is used only when picked.
   */
  inDefault: boolean;
  /** Under district: Unassigned holds fewer people than the district needs. */
  short: boolean;
}

/**
 * The Unassigned choice for one district, when the district touches unassigned blocks. It has no
 * deviation and no target, so it is never "further from zero" and never locked.
 */
export function unassignedChoice(
  district: DistrictRow,
  state: Pick<PanelState, 'unassigned'>,
  goal?: -1 | 0 | 1,
): UnassignedChoice | undefined {
  if (!district.neighbors?.includes(UNASSIGNED)) return undefined;
  const before = Math.max(0, state.unassigned?.pop ?? 0);
  // Over (delta > 0): the district gives `delta` people to Unassigned. Under: Unassigned gives |delta|.
  const raw = before + deltaToGoal(district.deviation, goal);
  return { before, after: Math.max(0, raw), inDefault: before > 0, short: raw < 0 };
}

/**
 * People a card moves into Unassigned, net of people it takes out of it. Positive = the card
 * leaves more people unassigned; negative = it takes people from unassigned blocks. `traded` is
 * true when any flow touches Unassigned at all.
 */
export function unassignedNet(card: Pick<SolutionCard, 'borderFlows'>): { net: number; traded: boolean } {
  let net = 0;
  let traded = false;
  for (const f of card.borderFlows) {
    if (f.from === f.to || f.people <= 0) continue;
    if (isUnassigned(f.to)) { net += f.people; traded = true; }
    if (isUnassigned(f.from)) { net -= f.people; traded = true; }
  }
  return { net, traded };
}

/**
 * Which way people move, in words: "District 7 gives 34 people to" / "District 3 takes 12 people
 * from". The caller appends the neighbors (or "…").
 */
export function tradeDirectionPhrase(district: DistrictRow, districts: DistrictRow[], goal?: -1 | 0 | 1): string {
  const name = formatDistrictName(district.index, districts);
  const delta = deltaToGoal(district.deviation, goal);
  return delta > 0
    ? `${name} gives ${formatPeople(delta)} to`
    : `${name} takes ${formatPeople(delta)} from`;
}

export function formatBlocks(count: number): string {
  const n = Math.abs(Math.round(count));
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'block' : 'blocks'}`;
}

/**
 * The selected area, once drawn on the map or chosen as a region or a county cluster.
 */
export function hasSelectedArea(area: PanelState['area']): area is NonNullable<PanelState['area']> {
  return Boolean(area?.region || area?.cluster || (area?.ring && area.ring.length >= 3));
}

/**
 * The controller explains a solve that found nothing because of the area in its message. The
 * panel words the callout around that only when an area is set and the message is about it, so a
 * message about something else keeps its own heading.
 */
export function isAreaFailure(state: Pick<PanelState, 'area' | 'solve' | 'solutions'>): boolean {
  const { solve } = state;
  if (!hasSelectedArea(state.area) || state.solutions.length > 0 || !solve.message) return false;
  if (solve.status === 'idle' || solve.status === 'loading-data' || solve.status === 'solving') return false;
  return /\barea\b/i.test(solve.message);
}

/** Tolerance choices for county clusters (fractions), and the default (±5%). */
export const CLUSTER_TOLERANCES = [0.005, 0.01, 0.02, 0.05, 0.1] as const;
export const DEFAULT_CLUSTER_TOLERANCE = 0.05;

/** A tolerance fraction as "±5%" / "±0.5%". */
export function formatTolerance(fraction: number): string {
  return `±${Number((fraction * 100).toFixed(2))}%`;
}

/** A signed fraction as a percentage with one decimal: "+1.2%", "−0.4%", "0.0%". */
export function formatSignedPct(fraction: number, digits = 1): string {
  const text = Math.abs(fraction * 100).toFixed(digits);
  if (Number(text) === 0) return `${(0).toFixed(digits)}%`;
  return `${fraction > 0 ? '+' : MINUS}${text}%`;
}

/** Elapsed time in whole seconds once it is a second or more ("10 s"); milliseconds below that. */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return formatElapsed(ms);
  return ms < 10000 ? `${Number((ms / 1000).toFixed(1))} s` : `${Math.round(ms / 1000)} s`;
}

/** "Option 1: 34 clusters · worst ±4.2% · exhaustive" (or "· best found in 10 s"). */
export function formatClusteringTitle(
  stats: { clusterCount: number; maxAbsDeviationPct: number },
  index: number,
  exhaustive: boolean,
  elapsedMs?: number,
): string {
  const count = `${stats.clusterCount.toLocaleString('en-US')} ${stats.clusterCount === 1 ? 'cluster' : 'clusters'}`;
  const how = exhaustive ? 'exhaustive' : `best found${elapsedMs !== undefined ? ` in ${formatSeconds(elapsedMs)}` : ''}`;
  return `Option ${index + 1}: ${count} · worst ±${(stats.maxAbsDeviationPct * 100).toFixed(1)}% · ${how}`;
}

/** The first few county names and how many more there are ("+12 more"). */
export function truncateNames(names: string[], shown = 3): { text: string; more: number } {
  const head = names.length > shown + 1 ? names.slice(0, shown) : names;
  return { text: head.join(', '), more: names.length - head.length };
}
