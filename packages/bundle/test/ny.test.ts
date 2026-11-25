import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StateBundle } from '@zd/contracts';
import { BrowserBundleSource, decodeManifest, decodePoints, geoidIndex, toEngineGraph } from '../src/index';
import { NodeBundleSource } from '../src/node';

const root = fileURLToPath(new URL('../../../data/', import.meta.url));
const node = new NodeBundleSource(root);
const blocks = 288819;
const base = 'https://bundles.example.test/assets';
let ny: StateBundle;

function edgeIndex(graph: StateBundle, from: number, to: number): number {
  let lo = graph.adjOffsets[from];
  let hi = graph.adjOffsets[from + 1];
  const end = hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (graph.adjTargets[mid] < to) lo = mid + 1;
    else hi = mid;
  }
  return lo < end && graph.adjTargets[lo] === to ? lo : -1;
}

function sum(values: Int32Array): number {
  return values.reduce((total, value) => total + value, 0);
}

beforeAll(async () => {
  ny = await node.loadState('ny');
});

afterEach(() => vi.unstubAllGlobals());

describe('New York bundle written by the Python pipeline', () => {
  it('decodes every block, both population fields and the geographic lookup tables', () => {
    expect(ny.n).toBe(blocks);
    expect(ny.countyFips).toHaveLength(62);
    expect(ny.precinctIds).toHaveLength(14191);
    for (const column of [ny.geoids, ny.pop.D20F, ny.pop.D20FA, ny.countyOf,
      ny.precinctOf, ny.outerLen, ny.areaM2]) {
      expect(column).toHaveLength(blocks);
    }
    expect(ny.adjOffsets).toHaveLength(blocks + 1);
    expect(ny.geoids[0]).toBe('360010001001000');
    expect(ny.countyFips[ny.countyOf[0]]).toBe('36001');
    expect(ny.precinctIds[ny.precinctOf[0]]).toBe('36001000033');
    expect(geoidIndex(ny, ny.geoids[0])).toBe(0);
    expect(geoidIndex(ny, ny.geoids[blocks - 1])).toBe(blocks - 1);
    expect(geoidIndex(ny, '060010001001000')).toBe(-1);
    expect(sum(ny.pop.D20F)).toBe(20201249);
    expect(sum(ny.pop.D20FA)).toBe(20193858);
    const adjusted = geoidIndex(ny, '360110408002025');
    expect([ny.pop.D20F[adjusted], ny.pop.D20FA[adjusted]]).toEqual([692, -116]);
    expect(ny.areaM2[0]).toBeGreaterThan(1);
    expect(ny.outerLen.some((value) => value > 0)).toBe(true);
  });

  it('decodes every reverse CSR edge with the same length', () => {
    expect(ny.adjOffsets[blocks]).toBe(1424876);
    expect(ny.adjTargets).toHaveLength(1424876);
    expect(ny.adjLen).toHaveLength(1424876);
    let zero = 0;
    for (let from = 0; from < blocks; from++) {
      for (let i = ny.adjOffsets[from]; i < ny.adjOffsets[from + 1]; i++) {
        const to = ny.adjTargets[i];
        const reverse = edgeIndex(ny, to, from);
        if (reverse === -1 || ny.adjLen[i] !== ny.adjLen[reverse]) {
          throw new Error(`Mismatched reverse edge ${from} to ${to}`);
        }
        if (ny.adjLen[i] === 0) zero++;
      }
    }
    expect(zero).toBe(4);
    const liberty = geoidIndex(ny, '360610001001001');
    const governors = geoidIndex(ny, '360610005000003');
    expect(ny.adjLen[edgeIndex(ny, liberty, governors)]).toBe(0);
  });

  it('builds the engine view and accepts live precinct indexes', () => {
    expect(toEngineGraph(ny, 'D20F').pop).toBe(ny.pop.D20F);
    const live = new Uint32Array(ny.n);
    const graph = toEngineGraph(ny, 'D20FA', live);
    expect(graph.pop).toBe(ny.pop.D20FA);
    expect(graph.precinctOf).toBe(live);
    expect(graph.adjTargets).toBe(ny.adjTargets);
    expect(ny.manifest.towns).toMatchObject({ count: 998, kind: 'county-subdivision' });
    expect(ny.townOf).toHaveLength(blocks);
    expect(graph.townOf).toBe(ny.townOf);
    expect(toEngineGraph({ ...ny, townOf: undefined }, 'D20F')).not.toHaveProperty('townOf');
    expect(() => toEngineGraph(ny, 'D20F', new Uint32Array(1))).toThrow(/every block/);
  });

  it('decodes the Census internal point of every block, in microdegrees', async () => {
    const points = ny.points!;
    expect(points).toBeInstanceOf(Int32Array);
    expect(points).toHaveLength(2 * blocks);
    // TIGER INTPTLON20 / INTPTLAT20 for 360010001001000 are -073.7265036, +42.6692483.
    expect([points[0], points[1]]).toEqual([-73726504, 42669248]);
    // Liberty Island: -074.0452499, +40.6898513.
    const liberty = geoidIndex(ny, '360610001001001');
    expect([points[2 * liberty], points[2 * liberty + 1]]).toEqual([-74045250, 40689851]);
    // Every point is in New York's rough box (longitude -79.8..-71.8, latitude 40.4..45.1).
    for (let i = 0; i < blocks; i++) {
      const [lon, lat] = [points[2 * i] / 1e6, points[2 * i + 1] / 1e6];
      if (lon < -79.8 || lon > -71.8 || lat < 40.4 || lat > 45.1) throw new Error(`Point ${i} outside NY`);
    }
    // The point lies inside the block's own polygon in the county file (a ray-casting test on its rings).
    const albany = await node.loadCounty(ny, '36001');
    const first = albany.features.find((feature) => feature.id === ny.geoids[0])!;
    const rings = first.geometry.coordinates as number[][][];
    const [x, y] = [points[0] / 1e6, points[1] / 1e6];
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    expect(inside).toBe(true);
  });

  it('rejects a points file of the wrong length or with coordinates out of range', () => {
    expect(decodePoints(new Int32Array([-180e6, -90e6, 180e6, 90e6]).buffer, 2)).toHaveLength(4);
    expect(() => decodePoints(new ArrayBuffer(12), 2)).toThrow(/length/);
    expect(() => decodePoints(new ArrayBuffer(16), 1)).toThrow(/length/);
    expect(() => decodePoints(new Int32Array([0, 0, 180e6 + 1, 0]).buffer, 2)).toThrow(/block 1/);
    expect(() => decodePoints(new Int32Array([0, -90e6 - 1]).buffer, 1)).toThrow(/block 0/);
    // A manifest may omit points, but a points entry must name its own hash.
    expect(decodeManifest({ ...ny.manifest, points: undefined }, 'NY').points).toBeUndefined();
    const ref = ny.manifest.points!;
    expect(() => decodeManifest({ ...ny.manifest, points: { ...ref, file: `water.${ref.sha256}.bin.gz` } }, 'NY'))
      .toThrow(/manifest/);
    expect(() => decodeManifest({ ...ny.manifest, points: { ...ref, bytes: 0 } }, 'NY')).toThrow(/manifest/);
  });

  it('decodes real county TopoJSON to the same block set in WGS84', async () => {
    const albany = await node.loadCounty(ny, '36001');
    expect(albany.type).toBe('FeatureCollection');
    const expected = ny.geoids.filter((id) => id.startsWith('36001'));
    expect(albany.features.map((feature) => feature.id).sort()).toEqual(expected);
    const first = albany.features.find((feature) => feature.id === expected[0]);
    expect(first?.properties.GEOID20).toBe(expected[0]);
    expect(first?.geometry.type).toBe('Polygon');
    const [[position]] = first?.geometry.coordinates as number[][][];
    expect(position[0]).toBeCloseTo(-73.8, 0);
    expect(position[1]).toBeCloseTo(42.6, 0);
  });

  it('verifies the download hash, retries, then reuses IndexedDB across instances', async () => {
    const county = ny.manifest.counties[0];
    const attrs = ny.manifest.attrs;
    const corrupted = Uint8Array.from(await readFile(join(root, 'NY', attrs.file)));
    corrupted[corrupted.length - 1] ^= 1;
    let corrupt = true;
    const fetchMock = vi.fn(async (url: URL) => {
      const file = url.pathname.replace(/^\/assets\/NY\//, '');
      if (file === attrs.file && corrupt) return new Response(corrupted);
      return new Response(Uint8Array.from(await readFile(join(root, 'NY', file))));
    });
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', fetchMock);

    const browser = new BrowserBundleSource(base);
    await expect(browser.loadState('NY')).rejects.toThrow(/hash or size mismatch/);
    corrupt = false;
    fetchMock.mockClear();
    const progress = vi.fn();
    const loaded = await browser.loadState('NY', progress);
    expect(loaded.geoids).toEqual(ny.geoids);
    expect(progress).toHaveBeenLastCalledWith(attrs.bytes, attrs.bytes);
    expect((await browser.loadCounty(loaded, county.fips)).features).toHaveLength(county.features);
    expect(fetchMock.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/assets/NY/manifest.json', `/assets/NY/${attrs.file}`, `/assets/NY/${ny.manifest.water!.file}`,
      `/assets/NY/${ny.manifest.towns!.file}`, `/assets/NY/${ny.manifest.names!.file}`,
      `/assets/NY/${ny.manifest.points!.file}`, `/assets/NY/${county.file}`,
    ]);
    // The water sidecar: one flag per block, and every water-only block is unpopulated or nearly so.
    expect(loaded.townOf).toEqual(ny.townOf);
    expect(loaded.names).toEqual(ny.names);
    expect(loaded.points).toEqual(ny.points);
    expect(loaded.waterOnly).toHaveLength(loaded.n);
    expect(loaded.waterOnly!.reduce((sum, flag) => sum + flag, 0)).toBe(7660);
    expect(toEngineGraph(loaded, 'D20F').water).toBe(loaded.waterOnly);

    fetchMock.mockClear();
    const fresh = new BrowserBundleSource(base);
    const cached = await fresh.loadState('NY');
    expect((await fresh.loadCounty(cached, county.fips)).features).toHaveLength(county.features);
    expect(fetchMock.mock.calls.map(([url]) => url.pathname)).toEqual(['/assets/NY/manifest.json']);

    fetchMock.mockImplementation(async (url) => {
      expect(url.pathname).toBe('/assets/NY/manifest.json');
      return Response.json({ ...ny.manifest, water: undefined, towns: undefined, points: undefined, names: undefined });
    });
    const legacy = await new BrowserBundleSource(base).loadState('NY');
    expect(legacy).not.toHaveProperty('points');
    expect(legacy).not.toHaveProperty('townOf');
    expect(legacy).not.toHaveProperty('names');
    expect(legacy).not.toHaveProperty('waterOnly');
  }, 15000);

  it('points on demand: loadState does not fetch the points sidecar; loadPoints fetches it once', async () => {
    const points = ny.manifest.points!;
    const fetchMock = vi.fn(async (url: URL) => {
      const file = url.pathname.replace(/^\/assets\/NY\//, '');
      return new Response(Uint8Array.from(await readFile(join(root, 'NY', file))));
    });
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', fetchMock);
    const browser = new BrowserBundleSource(base, { points: 'on-demand' });
    const loaded = await browser.loadState('NY');
    const fetched = () => fetchMock.mock.calls.map(([url]) => url.pathname);
    expect(fetched()).not.toContain(`/assets/NY/${points.file}`);
    expect(loaded.points).toBeUndefined();
    const [a, b] = await Promise.all([browser.loadPoints(loaded), browser.loadPoints(loaded)]);
    expect(a).toBe(b);
    expect(loaded.points).toBe(a);
    expect(a).toEqual(ny.points);
    expect(fetched().filter((p) => p === `/assets/NY/${points.file}`)).toHaveLength(1);
    expect(await browser.loadPoints(loaded)).toBe(a);
  }, 15000);

  it('a bad points file does not fail the state: it loads without points, and loadPoints says why', async () => {
    const points = ny.manifest.points!;
    const bad = Uint8Array.from(await readFile(join(root, 'NY', points.file)));
    bad[bad.length - 1] ^= 1;
    let corrupt = true;
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const file = url.pathname.replace(/^\/assets\/NY\//, '');
      if (file === points.file && corrupt) return new Response(bad);
      return new Response(Uint8Array.from(await readFile(join(root, 'NY', file))));
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const browser = new BrowserBundleSource(base);
    const loaded = await browser.loadState('NY');
    expect(loaded.geoids).toEqual(ny.geoids);
    expect(loaded.points).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await expect(browser.loadPoints(loaded)).rejects.toThrow(/hash or size mismatch/);
    // A failed read is not kept: once the file is right, it loads.
    corrupt = false;
    expect(await browser.loadPoints(loaded)).toEqual(ny.points);
  }, 15000);

  it('node reader: points on demand too', async () => {
    const lazy = new NodeBundleSource(root, { points: 'on-demand' });
    const loaded = await lazy.loadState('NY');
    expect(loaded.points).toBeUndefined();
    expect(await lazy.loadPoints(loaded)).toEqual(ny.points);
    expect(loaded.points).toEqual(ny.points);
  }, 15000);
});
