/**
 * The area of the map where the user would like the swap to happen (PanelState.area, AreaPreference
 * in @zd/contracts). Pure functions: which blocks fall inside a ring the user drew, what is
 * remembered per map, and the status line when the area decides a solve. Unit-tested in
 * tests/unit/area.test.ts.
 *
 * Blocks are placed by one interior point each (StateBundle.points: the Census internal point,
 * longitude then latitude in millionths of a degree), so no block shapes are needed.
 */

import type { AreaState, PanelState, StateBundle } from '@zd/contracts';

import { ringArea, ringSelfCrosses } from '../shared/ring';
import { cleanAreaCluster, type AreaCluster } from './clusters';

/** One closed ring of [longitude, latitude], first point not repeated (AreaState.ring). */
export type Ring = Array<[number, number]>;

export type AreaMode = 'prefer' | 'only';

export type AreaRegion = NonNullable<AreaState['region']>;
export type AreaSelection =
  | { ring: Ring; region?: never; cluster?: never }
  | { ring?: never; region: AreaRegion; cluster?: never }
  /** A county cluster (clusters-use-as-area): every block of its counties. */
  | { ring?: never; region?: never; cluster: AreaCluster };

/** What is remembered per map (storage key 'areas', keyed like the district locks). */
export type SavedArea = AreaSelection & { mode: AreaMode };

/** At most this many corners are kept (a drawn outline has a handful; this only bounds bad input). */
const MAX_CORNERS = 2000;

/**
 * The ring as a clean outline, or null when it is not one: at least 3 corners of finite
 * coordinates with a plausible latitude, consecutive duplicates and a repeated closing point
 * dropped, some area (not all in a line), and no edges that cross (see src/shared/ring.ts: the
 * map would fill a crossing outline differently from how its blocks are counted).
 */
export function cleanRing(value: unknown): Ring | null {
  if (!Array.isArray(value) || value.length > MAX_CORNERS + 1) return null;
  const out: Ring = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || Math.abs(lon) > 540) return null;
    const last = out[out.length - 1];
    if (last && last[0] === lon && last[1] === lat) continue;
    out.push([lon, lat]);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  if (out.length < 3 || !(ringArea(out) > 0) || ringSelfCrosses(out)) return null;
  return out;
}

/** The remembered areas as read back from storage: anything malformed is left out. */
export function cleanSavedAreas(value: unknown): Record<string, SavedArea> {
  const out: Record<string, SavedArea> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const stored = v as { ring?: unknown; region?: unknown; cluster?: unknown; mode?: unknown };
    const mode = stored.mode === 'only' ? 'only' : 'prefer';
    const ring = cleanRing(stored.ring);
    const region = stored.region as Partial<AreaRegion> | undefined;
    if (ring) out[key] = { ring, mode };
    else if (region && (region.kind === 'county' || region.kind === 'town')
      && typeof region.index === 'number' && Number.isSafeInteger(region.index)
      && region.index >= (region.kind === 'town' ? 1 : 0)
      && typeof region.name === 'string' && region.name.trim()) {
      out[key] = { region: { kind: region.kind, index: region.index, name: region.name }, mode };
    } else {
      const cluster = cleanAreaCluster(stored.cluster);
      if (cluster) out[key] = { cluster, mode };
    }
  }
  return out;
}

export function listRegions(bundle: StateBundle): NonNullable<PanelState['regions']> {
  const indexed = (names: string[]) => names
    .map((name, index) => ({ index, name }))
    .filter(({ name }) => name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { counties: indexed(bundle.names?.counties ?? []), towns: indexed(bundle.names?.towns ?? []) };
}

export function regionName(bundle: StateBundle, kind: AreaRegion['kind'], index: number): string | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  if (kind === 'county') return bundle.names?.counties[index];
  if (bundle.townOf && index > 0) return bundle.names?.towns[index];
  return undefined;
}

/** Nearest Census internal point by great-circle distance. Handles wrapped map longitudes. */
export function nearestBlock(points: Int32Array, [lng, lat]: [number, number]): number {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90) return -1;
  const radians = Math.PI / 180;
  const phi = lat * radians;
  const cosLat = Math.cos(phi);
  let nearest = -1;
  let best = Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const blockLat = points[i + 1] * (radians / 1e6);
    const sinLat = Math.sin((blockLat - phi) / 2);
    const sinLng = Math.sin((points[i] / 1e6 - lng) * radians / 2);
    const distance = sinLat * sinLat + cosLat * Math.cos(blockLat) * sinLng * sinLng;
    if (distance < best) {
      best = distance;
      nearest = i / 2;
    }
  }
  return nearest;
}

/** A ring for a longitude/latitude box (the part of a map in view). */
export function boxRing(west: number, south: number, east: number, north: number): Ring {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
}

/** Even-odd test of one point against a ring (degrees). Points exactly on an edge may fall either way. */
export function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * inside[b] = 1 for each block whose point lies in the ring (AreaPreference.inside). `points` is
 * StateBundle.points (2·n Int32, millionths of a degree).
 *
 * Built once per ring, so it only has to be fast enough not to be noticed on the biggest state
 * (~670k blocks): a bounding-box test throws out most blocks, and the ring's edges are bucketed by
 * latitude band so a block inside the box only crosses the few edges of its band. A ring drawn
 * across the antimeridian (longitudes past ±180, as the map reports them after panning) is tested
 * against the block's point shifted by 360° too.
 */
export function insideMask(points: Int32Array, n: number, ring: Ring): Uint8Array {
  const inside = new Uint8Array(n);
  const k = ring.length;
  if (k < 3 || points.length < 2 * n) return inside;
  const xs = new Float64Array(k);
  const ys = new Float64Array(k);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < k; i++) {
    xs[i] = ring[i][0] * 1e6;
    ys[i] = ring[i][1] * 1e6;
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  if (!(maxY > minY) || !(maxX > minX)) return inside;

  // Edges by latitude band: band b covers [minY + b·h, minY + (b+1)·h).
  const bands = Math.max(1, Math.min(1024, k));
  const h = (maxY - minY) / bands;
  const bandOf = (y: number) => Math.min(bands - 1, Math.max(0, Math.floor((y - minY) / h)));
  const counts = new Uint32Array(bands + 1);
  for (let i = 0, j = k - 1; i < k; j = i++) {
    if (ys[i] === ys[j]) continue; // horizontal edges never cross a horizontal ray
    const lo = bandOf(Math.min(ys[i], ys[j]));
    const hi = bandOf(Math.max(ys[i], ys[j]));
    for (let b = lo; b <= hi; b++) counts[b + 1]++;
  }
  for (let b = 0; b < bands; b++) counts[b + 1] += counts[b];
  const edges = new Uint32Array(counts[bands]);
  const fill = counts.slice(0, bands);
  for (let i = 0, j = k - 1; i < k; j = i++) {
    if (ys[i] === ys[j]) continue;
    const lo = bandOf(Math.min(ys[i], ys[j]));
    const hi = bandOf(Math.max(ys[i], ys[j]));
    for (let b = lo; b <= hi; b++) edges[fill[b]++] = i;
  }

  const shifts = [0];
  if (minX < -180e6) shifts.push(-360e6);
  if (maxX > 180e6) shifts.push(360e6);
  for (let p = 0; p < n; p++) {
    const y = points[2 * p + 1];
    if (y < minY || y > maxY) continue;
    const b = bandOf(y);
    const e0 = counts[b];
    const e1 = counts[b + 1];
    for (const shift of shifts) {
      const x = points[2 * p] + shift;
      if (x < minX || x > maxX) continue;
      let odd = false;
      for (let e = e0; e < e1; e++) {
        const i = edges[e];
        const j = i === 0 ? k - 1 : i - 1;
        const yi = ys[i];
        const yj = ys[j];
        if (yi > y !== yj > y && x < ((xs[j] - xs[i]) * (y - yi)) / (yj - yi) + xs[i]) odd = !odd;
      }
      if (odd) {
        inside[p] = 1;
        break;
      }
    }
  }
  return inside;
}

/** Blocks inside, and the people in them for one population column. */
export function countInside(inside: Uint8Array, pop: ArrayLike<number>): { blocks: number; people: number } {
  let blocks = 0;
  let people = 0;
  for (let i = 0; i < inside.length; i++) {
    if (inside[i]) {
      blocks++;
      people += pop[i] ?? 0;
    }
  }
  return { blocks, people };
}

/**
 * What the solver said about the area, taken out of its message. The engine and the planner word
 * their own area sentences (packages/engine solveDistrictInArea, packages/planner planInArea);
 * the panel says it once, in its own words (areaSolveMessage), so theirs are removed here:
 *  - 'border': with Only, the area does not reach the district's border at all;
 *  - 'reason': with Only, nothing inside works but there are moves outside (the area is why);
 *  - 'fill': with Prefer, nothing inside works and the options go outside;
 *  - null: the solver said nothing about the area.
 * `rest` is the message without those sentences (undefined when nothing is left).
 * Any sentence with the word "area" is the solver's area wording: no other solver or controller
 * message uses it (the Unassigned ones say "areas").
 */
export function splitAreaSentences(message: string | undefined): { rest?: string; said: 'border' | 'reason' | 'fill' | null } {
  if (!message) return { said: null };
  const kept: string[] = [];
  let said: 'border' | 'reason' | 'fill' | null = null;
  const rank = { border: 3, reason: 2, fill: 1 } as const;
  const note = (k: 'border' | 'reason' | 'fill') => {
    if (!said || rank[k] > rank[said]) said = k;
  };
  for (const sentence of message.split(/(?<=[.!?])\s+(?=[A-Z"])/)) {
    if (!/\barea\b/i.test(sentence)) {
      kept.push(sentence);
      continue;
    }
    if (/does not reach/i.test(sentence)) note('border');
    else if (/there are (moves|plans) that/i.test(sentence)) note('reason');
    else if (/(these|this) (options?|plans?) moves?/i.test(sentence)) note('fill');
    // Other area sentences ("Choose Prefer to see them, or mark a larger area.") go with these.
  }
  const rest = kept.join(' ').trim();
  return { ...(rest ? { rest } : {}), said };
}

/**
 * The status line of a solve made with an area, from the message the solve came back with (the
 * solver's area sentences are replaced by the panel's own, see splitAreaSentences):
 *  - 'only' and nothing found because of the area (the solver says so, or the worker had to drop
 *    options that went outside): the area is the reason; suggest Prefer or a bigger area. When the
 *    solver found nothing even without the area, its own message stands: the area is not why;
 *  - 'prefer' and every option goes outside: say so (the cards say how many blocks each);
 *  - otherwise the message is left as it is.
 * A map already at zero, a group that cannot balance, and errors are not about the area.
 */
export function areaSolveMessage(o: {
  mode: AreaMode;
  /** Status as the panel shows it (mapStatus). */
  status: string;
  /** The district (or map) was already at zero: nothing to do, the area played no part. */
  alreadyZero?: boolean;
  /** SolutionStats.outsideArea of each option shown (undefined = not reported). */
  outside: Array<number | undefined>;
  /** Blocks inside the area. */
  blocksInside: number;
  /** Who the solve was for: "District 1", "this group", "the map". */
  who: string;
  /** Options or plans the worker left out under 'only' because they moved blocks outside. */
  areaDropped?: number;
  message?: string;
}): string | undefined {
  const { mode, status, outside } = o;
  if (status === 'group-unbalanced' || status === 'error' || o.alreadyZero) return o.message;
  const { rest, said } = splitAreaSentences(o.message);
  const join = (lead: string) => (rest ? `${lead} ${rest}` : lead);
  if (outside.length === 0) {
    if (mode !== 'only') return o.message;
    if (o.blocksInside === 0) return join('The area you marked holds no blocks of this map, so with Only nothing can move. Mark a bigger area, or switch the area to Prefer.');
    if (said === 'border') return join(`Your area does not reach ${o.who === 'the map' || o.who === 'this group' ? 'a border between districts' : `${o.who}'s border`}, so with Only no move can stay inside it. Mark a bigger area that takes in the border, or switch the area to Prefer.`);
    if (said === 'reason' || (o.areaDropped ?? 0) > 0) return join(`Nothing inside your area zeroes ${o.who}, and Only lets nothing outside the area move. Switch the area to Prefer to allow moves outside it, or mark a bigger area.`);
    return o.message; // nothing works even without the area: it is not why
  }
  if (mode === 'prefer' && outside.every((x) => (x ?? 0) > 0)) {
    return join('Nothing inside your area works, so every option moves some blocks outside it; each card says how many.');
  }
  return said ? rest : o.message;
}
