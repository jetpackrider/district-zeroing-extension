import { describe, expect, it } from 'vitest';
import type { Clustering } from '@zd/contracts';
import { cleanSavedAreas } from '../../src/panel/area';
import {
  areaCluster,
  CLUSTER_MAX_RESULTS,
  CLUSTER_PALETTE,
  CLUSTER_TIME_LIMIT_MS,
  cleanAreaCluster,
  clusterAreaName,
  clusterColors,
  clusterFeatures,
  clusterMask,
  clusterRequest,
  clusterUnavailable,
  countiesConnected,
  countyAdjacency,
  countyNames,
  districtsLabel,
  withCountyNames,
} from '../../src/panel/clusters';
import { cloneSavedArea } from '../../src/panel/undo';

/** Counties 0..3 in a row (0-1-2-3), two blocks each: blocks 2c and 2c+1, chained left to right. */
function rowGraph() {
  const n = 8;
  const countyOf = Uint16Array.from({ length: n }, (_, b) => b >> 1);
  const nbrs = Array.from({ length: n }, (_, b) => [b - 1, b + 1].filter((x) => x >= 0 && x < n));
  const adjOffsets = new Uint32Array(n + 1);
  nbrs.forEach((l, b) => (adjOffsets[b + 1] = adjOffsets[b] + l.length));
  const adjTargets = Uint32Array.from(nbrs.flat());
  return { n, countyOf, adjOffsets, adjTargets };
}

const cluster = (counties: number[], districts: number) => ({ counties, districts, pop: 0, deviation: 0, deviationPct: 0 });

describe('clusterRequest', () => {
  it('builds the worker request for a valid district count and tolerance', () => {
    expect(clusterRequest({ numDistricts: 26, tolerance: 0.05, counties: 62, totalPop: 20_201_249 })).toEqual({
      body: { type: 'clusters', numDistricts: 26, tolerance: 0.05, maxResults: CLUSTER_MAX_RESULTS, timeLimitMs: CLUSTER_TIME_LIMIT_MS },
    });
    // A number typed into a field arrives as a string; it is read as a number.
    expect(clusterRequest({ numDistricts: '150', tolerance: '0.01', counties: 62, totalPop: 20_201_249 }).body).toMatchObject({ numDistricts: 150, tolerance: 0.01 });
    expect(clusterRequest({ numDistricts: 4, tolerance: 0.05, counties: 2, totalPop: 9000, testDelayMs: 500 }).body?.testDelayMs).toBe(500);
  });

  it('refuses what cannot be searched, with a reason', () => {
    for (const k of [0, -3, 2.5, Number.NaN, 'x', undefined]) {
      expect(clusterRequest({ numDistricts: k, tolerance: 0.05, counties: 62, totalPop: 1e6 }).message).toMatch(/whole number/);
    }
    expect(clusterRequest({ numDistricts: 11, tolerance: 0.05, counties: 2, totalPop: 10 }).message).toMatch(/too few for 11 districts/);
    for (const t of [0, -0.01, 0.6, Number.POSITIVE_INFINITY, 'abc']) {
      expect(clusterRequest({ numDistricts: 10, tolerance: t, counties: 62, totalPop: 1e6 }).message).toMatch(/tolerance/);
    }
    expect(clusterRequest({ numDistricts: 10, tolerance: 0.05, counties: 0, totalPop: 1e6 }).message).toMatch(/no counties/);
  });
});

describe('county names and results', () => {
  it('names counties from the bundle, falling back to the FIPS', () => {
    expect(countyNames({ countyFips: ['36001', '36003'], names: { counties: ['Albany County', ''], towns: [] } })).toEqual(['Albany County', 'County 36003']);
    expect(countyNames({ countyFips: ['36001'] })).toEqual(['County 36001']);
  });

  it('adds every cluster’s county names to the results', () => {
    const c: Clustering = { id: 'a', clusters: [cluster([0, 2], 2), cluster([1], 1)], stats: { clusterCount: 2, singleCounty: 1, maxAbsDeviationPct: 0.01, largestClusterCounties: 2 } };
    const [named] = withCountyNames({ clusterings: [c] }, ['A County', 'B County', 'C County']);
    expect(named.countyNames).toEqual([['A County', 'C County'], ['B County']]);
    expect(named.id).toBe('a');
    expect(named.clusters).toBe(c.clusters);
  });

  it('names a cluster for the area', () => {
    expect(districtsLabel(1)).toBe('1 district');
    expect(districtsLabel(3)).toBe('3 districts');
    expect(clusterAreaName(['A County', 'B County'], { districts: 2 })).toBe('A County, B County (2 districts)');
    expect(clusterAreaName(['A', 'B', 'C', 'D', 'E'], { districts: 1 })).toBe('A, B and 3 more counties (1 district)');
    expect(areaCluster(['A', 'B', 'C'], cluster([2, 0, 2], 1))).toEqual({ name: 'C, A, C (1 district)', counties: [0, 2] });
  });
});

describe('clusterMask', () => {
  it('marks exactly the blocks of the cluster’s counties', () => {
    const countyOf = Uint16Array.from([0, 0, 1, 2, 2, 3, 1, 0]);
    expect([...clusterMask(countyOf, [1, 3])]).toEqual([0, 0, 1, 0, 0, 1, 1, 0]);
    expect([...clusterMask(countyOf, [0])]).toEqual([1, 1, 0, 0, 0, 0, 0, 1]);
    expect([...clusterMask(countyOf, [])]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // A county index the data does not have selects nothing.
    expect([...clusterMask(countyOf, [9])]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('says when a remembered cluster does not fit the data', () => {
    expect(clusterUnavailable(undefined, 4)).toBeUndefined();
    expect(clusterUnavailable({ name: 'x', counties: [0, 3] }, 4)).toBeUndefined();
    expect(clusterUnavailable({ name: 'x', counties: [0, 4] }, 4)).toMatch(/Find clusters again/);
    expect(clusterUnavailable({ name: 'x', counties: [] }, 4)).toMatch(/Find clusters again/);
  });

  it('remembers a cluster area per map, and reads it back', () => {
    const stored = {
      a: { cluster: { name: 'A, B (2 districts)', counties: [3, 1, 3] }, mode: 'only' },
      bad1: { cluster: { name: '', counties: [1] }, mode: 'only' },
      bad2: { cluster: { name: 'x', counties: [-1] }, mode: 'prefer' },
      bad3: { cluster: { name: 'x', counties: [] } },
    };
    expect(cleanSavedAreas(stored)).toEqual({ a: { cluster: { name: 'A, B (2 districts)', counties: [1, 3] }, mode: 'only' } });
    expect(cleanAreaCluster({ name: 'y', counties: [2.5] })).toBeUndefined();
    const saved = { cluster: { name: 'n', counties: [1, 2] }, mode: 'prefer' as const };
    const copy = cloneSavedArea(saved);
    expect(copy).toEqual(saved);
    expect(copy.cluster.counties).not.toBe(saved.cluster.counties);
  });
});

describe('county adjacency, contiguity and colors', () => {
  it('finds which counties touch through their blocks', () => {
    const adj = countyAdjacency(rowGraph(), 4);
    expect(adj).toEqual([[1], [0, 2], [1, 3], [2]]);
    expect(countiesConnected([1, 2, 3], adj)).toBe(true);
    expect(countiesConnected([0, 2], adj)).toBe(false);
    expect(countiesConnected([], adj)).toBe(false);
  });

  it('gives touching clusters different colors', () => {
    const adj = countyAdjacency(rowGraph(), 4);
    const clustering = { clusters: [cluster([0], 1), cluster([1], 1), cluster([2], 1), cluster([3], 1)] };
    const colors = clusterColors(clustering, adj);
    expect(colors).toHaveLength(4);
    for (let i = 0; i < 3; i++) expect(colors[i]).not.toBe(colors[i + 1]);
    for (const c of colors) expect(CLUSTER_PALETTE).toContain(c);
    // With two colors a path still alternates.
    const two = clusterColors(clustering, adj, ['#000', '#fff']);
    expect(two).toEqual([two[0], two[1], two[0], two[1]]);
    expect(two[0]).not.toBe(two[1]);
  });
});

describe('clusterFeatures', () => {
  const square = (x: number, s = 1) => ({ type: 'Polygon', coordinates: [[[x, 0], [x + s, 0], [x + s, s], [x, s], [x, 0]]] });
  const outlines = {
    type: 'FeatureCollection' as const,
    features: [
      { type: 'Feature' as const, id: 0, properties: { fips: '36001' }, geometry: square(0) },
      { type: 'Feature' as const, id: 1, properties: { fips: '36003' }, geometry: square(1, 2) },
      // No id: found by its FIPS.
      { type: 'Feature' as const, properties: { fips: '36005' }, geometry: square(3) },
    ],
  };
  const countyFips = ['36001', '36003', '36005', '36007'];
  const clustering = { clusters: [cluster([0, 1], 2), cluster([2, 3], 1)] };

  it('draws every county in its cluster’s color, with one label per cluster on its largest county', () => {
    const { fc, missing } = clusterFeatures({ clustering, outlines, countyFips, colors: ['#111', '#222'] });
    expect(missing).toBe(1); // county 3 has no outline
    const polys = fc.features.filter((f) => f.geometry.type === 'Polygon');
    expect(polys.map((f) => [f.id, f.properties.cluster, f.properties.color, f.properties.emph])).toEqual([
      [0, 0, '#111', 1],
      [1, 0, '#111', 1],
      [2, 1, '#222', 1],
    ]);
    const labels = fc.features.filter((f) => f.geometry.type === 'Point');
    expect(labels.map((f) => f.properties.label)).toEqual(['2 districts', '1 district']);
    // Cluster 0's label sits in county 1 (the larger square, x 1..3).
    const [x, y] = labels[0].geometry.coordinates as [number, number];
    expect(x).toBeCloseTo(2);
    expect(y).toBeCloseTo(1);
    // Labels come after every outline (drawn on top).
    expect(fc.features.slice(-2).every((f) => f.geometry.type === 'Point')).toBe(true);
  });

  it('emphasizes one cluster and dims the rest', () => {
    const { fc } = clusterFeatures({ clustering, outlines, countyFips, colors: ['#111', '#222'], emphasize: 1 });
    expect(fc.features.map((f) => [f.properties.cluster, f.properties.emph])).toEqual([
      [0, 0],
      [0, 0],
      [1, 2],
      [0, 0],
      [1, 2],
    ]);
  });
});
