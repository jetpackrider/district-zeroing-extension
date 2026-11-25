/**
 * County clusters in the panel (PanelState.clusters, contracts/clusters.ts): the request the panel
 * sends to the engine worker, county names on the results, the swap-area mask of a cluster, and
 * the outlines drawn on the map when a clustering is hovered. Pure functions, unit-tested in
 * tests/unit/clusters.test.ts.
 */
import type { AreaState, ClusterResult, Clustering, CountyCluster, EngineGraph, PanelState, StateBundle } from '@zd/contracts';
import type { CountyOutlines } from '../adapters/bundle';
import type { ClusterFC } from '../shared/protocol';
import type { WorkerRequestBody } from './engine-client';
import { labelPoint } from './walkthrough';

/** The tolerances the panel offers (fractions); any other in (0, MAX_TOLERANCE] is accepted too. */
export const CLUSTER_TOLERANCES = [0.005, 0.01, 0.02, 0.05, 0.1] as const;
export const DEFAULT_CLUSTER_TOLERANCE = 0.05;
export const MAX_CLUSTER_TOLERANCE = 0.5;
/** Clusterings asked for, best first. */
export const CLUSTER_MAX_RESULTS = 5;
/** The search gives up after this long and returns what it found (exhaustive = false). */
export const CLUSTER_TIME_LIMIT_MS = 10_000;

export type AreaCluster = NonNullable<AreaState['cluster']>;
export type NamedClustering = NonNullable<PanelState['clusters']>['results'][number];
type ClusterRequestBody = Extract<WorkerRequestBody, { type: 'clusters' }>;

/**
 * The worker request for "find clusters for `numDistricts` districts at ±`tolerance`", or why there
 * is none. `counties` and `totalPop` are the loaded state's.
 */
export function clusterRequest(o: { numDistricts: unknown; tolerance: unknown; counties: number; totalPop: number; testDelayMs?: number }): { body: ClusterRequestBody; message?: never } | { body?: never; message: string } {
  const k = Number(o.numDistricts);
  const tol = Number(o.tolerance);
  if (!Number.isSafeInteger(k) || k < 1) return { message: 'Enter the number of districts as a whole number, 1 or more.' };
  if (o.totalPop > 0 && k > o.totalPop) return { message: `The state has ${o.totalPop.toLocaleString('en-US')} people, too few for ${k.toLocaleString('en-US')} districts.` };
  if (!Number.isFinite(tol) || tol <= 0 || tol > MAX_CLUSTER_TOLERANCE) return { message: `Choose a tolerance above 0% and at most ±${MAX_CLUSTER_TOLERANCE * 100}%.` };
  if (o.counties < 1) return { message: "The state's data lists no counties." };
  return {
    body: {
      type: 'clusters',
      numDistricts: k,
      tolerance: tol,
      maxResults: CLUSTER_MAX_RESULTS,
      timeLimitMs: CLUSTER_TIME_LIMIT_MS,
      ...(o.testDelayMs ? { testDelayMs: o.testDelayMs } : {}),
    },
  };
}

/** Name of each county of the bundle (names sidecar), or "County <fips>" without one. */
export function countyNames(bundle: Pick<StateBundle, 'countyFips' | 'names'>): string[] {
  return bundle.countyFips.map((fips, i) => bundle.names?.counties[i]?.trim() || `County ${fips}`);
}

/** The worker's result with every cluster's county names (PanelState.clusters.results). */
export function withCountyNames(result: Pick<ClusterResult, 'clusterings'>, names: string[]): NamedClustering[] {
  return result.clusterings.map((c) => ({
    ...c,
    countyNames: c.clusters.map((cl) => cl.counties.map((i) => names[i] ?? `County #${i}`)),
  }));
}

/** "1 district", "2 districts". */
export function districtsLabel(k: number): string {
  return `${k} district${k === 1 ? '' : 's'}`;
}

/** The area's name for a cluster: its counties (at most three by name) and how many districts it holds. */
export function clusterAreaName(names: string[], cluster: Pick<CountyCluster, 'districts'>): string {
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more counties`;
  return `${list} (${districtsLabel(cluster.districts)})`;
}

/** A cluster as remembered for the area: county indexes, ascending, unique. */
export function areaCluster(names: string[], cluster: CountyCluster): AreaCluster {
  return { name: clusterAreaName(cluster.counties.map((i) => names[i] ?? `County #${i}`), cluster), counties: [...new Set(cluster.counties)].sort((a, b) => a - b) };
}

/** Why a remembered cluster cannot be used on a bundle with `counties` counties; undefined when it can. */
export function clusterUnavailable(cluster: AreaCluster | undefined, counties: number): string | undefined {
  if (!cluster) return undefined;
  if (!cluster.counties.length || cluster.counties.some((c) => !Number.isSafeInteger(c) || c < 0 || c >= counties)) {
    return `The cluster "${cluster.name}" does not match this state's data. Find clusters again and choose one.`;
  }
  return undefined;
}

/** inside[b] = 1 for every block in one of `counties` (AreaPreference.inside for a cluster). */
export function clusterMask(countyOf: ArrayLike<number>, counties: readonly number[]): Uint8Array {
  let max = -1;
  for (const c of counties) if (c > max) max = c;
  const member = new Uint8Array(max + 1);
  for (const c of counties) if (c >= 0) member[c] = 1;
  const inside = new Uint8Array(countyOf.length);
  for (let i = 0; i < countyOf.length; i++) {
    const c = countyOf[i];
    if (c <= max && member[c]) inside[i] = 1;
  }
  return inside;
}

/** A remembered cluster as read back from storage, or undefined when it is malformed. */
export function cleanAreaCluster(value: unknown): AreaCluster | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { name?: unknown; counties?: unknown };
  if (typeof v.name !== 'string' || !v.name.trim() || !Array.isArray(v.counties) || !v.counties.length) return undefined;
  if (!v.counties.every((c) => typeof c === 'number' && Number.isSafeInteger(c) && c >= 0)) return undefined;
  return { name: v.name, counties: [...new Set(v.counties as number[])].sort((a, b) => a - b) };
}

/** Counties that touch (any of their blocks are adjacent), as sorted neighbor lists per county. */
export function countyAdjacency(graph: Pick<EngineGraph, 'n' | 'countyOf' | 'adjOffsets' | 'adjTargets'>, counties: number): number[][] {
  const sets = Array.from({ length: counties }, () => new Set<number>());
  for (let b = 0; b < graph.n; b++) {
    const cb = graph.countyOf[b];
    for (let e = graph.adjOffsets[b]; e < graph.adjOffsets[b + 1]; e++) {
      const co = graph.countyOf[graph.adjTargets[e]];
      if (co !== cb && cb < counties && co < counties) {
        sets[cb].add(co);
        sets[co].add(cb);
      }
    }
  }
  return sets.map((s) => [...s].sort((a, b) => a - b));
}

/** True when `counties` form one connected piece through `adjacency`. */
export function countiesConnected(counties: readonly number[], adjacency: number[][]): boolean {
  if (!counties.length) return false;
  const want = new Set(counties);
  const seen = new Set([counties[0]]);
  const stack = [counties[0]];
  while (stack.length) {
    const c = stack.pop()!;
    for (const o of adjacency[c] ?? []) {
      if (want.has(o) && !seen.has(o)) {
        seen.add(o);
        stack.push(o);
      }
    }
  }
  return seen.size === want.size;
}

/** Distinct, readable on a street map and on DRA's district colors; none of the walkthrough's roles. */
export const CLUSTER_PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000', '#808000', '#000075'];

/**
 * A color per cluster such that clusters that touch get different colors (greedy, most-connected
 * first). With more neighbors than colors, colors repeat as little as the greedy order allows.
 */
export function clusterColors(clustering: Pick<Clustering, 'clusters'>, adjacency: number[][], palette: readonly string[] = CLUSTER_PALETTE): string[] {
  const clusterOf = new Map<number, number>();
  clustering.clusters.forEach((cl, i) => cl.counties.forEach((c) => clusterOf.set(c, i)));
  const touching = clustering.clusters.map(() => new Set<number>());
  clustering.clusters.forEach((cl, i) => {
    for (const c of cl.counties) {
      for (const o of adjacency[c] ?? []) {
        const j = clusterOf.get(o);
        if (j !== undefined && j !== i) touching[i].add(j);
      }
    }
  });
  const order = clustering.clusters.map((_, i) => i).sort((a, b) => touching[b].size - touching[a].size || a - b);
  const color = new Array<number>(clustering.clusters.length).fill(-1);
  for (const i of order) {
    const used = new Map<number, number>();
    for (const j of touching[i]) if (color[j] >= 0) used.set(color[j], (used.get(color[j]) ?? 0) + 1);
    let pick = -1;
    for (let k = 0; k < palette.length; k++) {
      const c = (i + k) % palette.length;
      if (!used.has(c)) {
        pick = c;
        break;
      }
    }
    if (pick < 0) {
      // Every color is taken by a neighbor: the least used one.
      pick = 0;
      for (let k = 1; k < palette.length; k++) if ((used.get(k) ?? 0) < (used.get(pick) ?? 0)) pick = k;
    }
    color[i] = pick;
  }
  return color.map((c) => palette[c]);
}

/** County index of an outline feature: its `id`, else its `properties.fips` looked up in `countyFips`. */
function outlineCounty(f: CountyOutlines['features'][number], fipsIndex: Map<string, number>): number {
  const id = typeof f.id === 'number' ? f.id : typeof f.id === 'string' && /^\d+$/.test(f.id) ? Number(f.id) : NaN;
  if (Number.isSafeInteger(id)) return id;
  const fips = f.properties?.fips;
  return typeof fips === 'string' ? (fipsIndex.get(fips) ?? -1) : -1;
}

const ringArea = (r: number[][]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
};
const outerArea = (g: { type: string; coordinates: unknown }) =>
  g.type === 'Polygon' ? ringArea((g.coordinates as number[][][])[0] ?? []) : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]).reduce((s, p) => s + ringArea(p[0] ?? []), 0) : 0;

/**
 * The map picture of a clustering: every county's outline in its cluster's color, and a label
 * ("2 districts") on the largest county of each cluster. With `emphasize`, that cluster stands out
 * and the others are dimmed. Counties missing from the outlines are left out (`missing` counts them).
 */
export function clusterFeatures(o: {
  clustering: Pick<Clustering, 'clusters'>;
  outlines: CountyOutlines;
  countyFips: string[];
  colors: string[];
  emphasize?: number;
}): { fc: ClusterFC; missing: number } {
  const fipsIndex = new Map(o.countyFips.map((f, i) => [f, i]));
  const byCounty = new Map<number, CountyOutlines['features'][number]>();
  for (const f of o.outlines.features) {
    const c = outlineCounty(f, fipsIndex);
    if (c >= 0 && f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) byCounty.set(c, f);
  }
  const features: ClusterFC['features'] = [];
  const labels: ClusterFC['features'] = [];
  let missing = 0;
  o.clustering.clusters.forEach((cl, i) => {
    const emph: 0 | 1 | 2 = o.emphasize === undefined ? 1 : o.emphasize === i ? 2 : 0;
    const color = o.colors[i] ?? CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
    let biggest: { type: string; coordinates: unknown } | null = null;
    let biggestArea = -1;
    for (const c of cl.counties) {
      const f = byCounty.get(c);
      if (!f) {
        missing++;
        continue;
      }
      features.push({ type: 'Feature', id: c, properties: { cluster: i, color, emph }, geometry: f.geometry });
      const a = outerArea(f.geometry);
      if (a > biggestArea) {
        biggestArea = a;
        biggest = f.geometry;
      }
    }
    if (biggest) labels.push({ type: 'Feature', properties: { cluster: i, color, emph, label: districtsLabel(cl.districts) }, geometry: { type: 'Point', coordinates: labelPoint(biggest) } });
  });
  // Labels last, so they draw over every outline.
  return { fc: { type: 'FeatureCollection', features: [...features, ...labels] }, missing };
}
