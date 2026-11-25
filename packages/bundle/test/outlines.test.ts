import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StateBundle } from '@zd/contracts';
import { BrowserBundleSource, decodeManifest, decodeOutlines, type CountyOutlines } from '../src/index';
import { NodeBundleSource } from '../src/node';

const root = fileURLToPath(new URL('../../../data/', import.meta.url));
const base = 'https://bundles.example.test/assets';
const hash = 'a'.repeat(64);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const square = [[[-73.9, 42.6], [-73.8, 42.6], [-73.8, 42.7], [-73.9, 42.6]]];
const outline = (id: number, fips: string, geometry: unknown = { type: 'Polygon', coordinates: square }) =>
  ({ type: 'Feature', id, properties: { fips }, geometry });
const baseManifest = {
  format: 1, state: 'NY', stateFips: '36', censusVintage: '2020', draDataVersion: 'v08', precinctKind: 'vtd',
  attribution: 'test', attrs: { file: `attrs.${hash}.bin.gz`, sha256: hash, bytes: 10 },
  counties: [{ fips: '36001', features: 1, file: `36001.${hash}.topo.json.gz`, sha256: hash, bytes: 10 }],
};

let ny: StateBundle;
let nyOutlines: CountyOutlines;

beforeAll(async () => {
  ny = await new NodeBundleSource(root, { points: 'on-demand' }).loadState('NY');
  nyOutlines = decodeOutlines(Uint8Array.from(gunzipSync(await readFile(join(root, 'NY', ny.manifest.outlines!.file)))).buffer,
    ny.countyFips);
});

afterEach(() => vi.unstubAllGlobals());

describe('county outlines sidecar', () => {
  it('validates the optional outlines entry in the manifest', () => {
    const valid = { file: `outlines.${hash}.json.gz`, sha256: hash, bytes: 42 };
    expect(decodeManifest({ ...baseManifest, outlines: valid }, 'NY').outlines).toEqual(valid);
    expect(decodeManifest(baseManifest, 'NY').outlines).toBeUndefined();
    for (const bad of [{ ...valid, file: `outlines.${hash}.bin.gz` }, { ...valid, file: `names.${hash}.json.gz` },
      { ...valid, bytes: 0 }, { ...valid, sha256: 'b'.repeat(64) }]) {
      expect(() => decodeManifest({ ...baseManifest, outlines: bad }, 'NY')).toThrow(/manifest/);
    }
  });

  it('decodes one feature per county in county order, as Polygon or MultiPolygon', () => {
    const fips = ['36001', '36003'];
    const multi = { type: 'MultiPolygon', coordinates: [square, square] };
    const decoded = decodeOutlines(encode({ type: 'FeatureCollection', features: [outline(0, '36001'), outline(1, '36003', multi)] }), fips);
    expect(decoded.features.map((f) => [f.id, f.properties.fips, f.geometry.type])).toEqual([
      [0, '36001', 'Polygon'], [1, '36003', 'MultiPolygon']]);
  });

  it.each([
    ['too few features', [outline(0, '36001')]],
    ['ids out of order', [outline(1, '36001'), outline(0, '36003')]],
    ['string id', [{ ...outline(0, '36001'), id: '0' }, outline(1, '36003')]],
    ['wrong FIPS', [outline(0, '36001'), outline(1, '36005')]],
    ['a line', [outline(0, '36001'), outline(1, '36003', { type: 'LineString', coordinates: square[0] })]],
    ['an open ring', [outline(0, '36001'), outline(1, '36003', { type: 'Polygon', coordinates: [square[0].slice(0, 3)] })]],
    ['latitude past 90', [outline(0, '36001'), outline(1, '36003', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 91], [0, 0]]] })]],
    ['an empty MultiPolygon', [outline(0, '36001'), outline(1, '36003', { type: 'MultiPolygon', coordinates: [] })]],
  ])('rejects outlines with %s', (_, features) => {
    expect(() => decodeOutlines(encode({ type: 'FeatureCollection', features }), ['36001', '36003'])).toThrow();
  });

  it('New York: 62 county outlines from the pipeline, each inside the state', () => {
    expect(nyOutlines.type).toBe('FeatureCollection');
    expect(nyOutlines.features).toHaveLength(62);
    nyOutlines.features.forEach((feature, index) => {
      expect(feature.id).toBe(index);
      expect(feature.properties.fips).toBe(ny.countyFips[index]);
    });
    const albany = nyOutlines.features[0];
    const rings = albany.geometry.type === 'Polygon' ? [albany.geometry.coordinates[0]] : albany.geometry.coordinates.map((p) => p[0]);
    const points = rings.flat();
    // Albany County, NY: about 73.7°–74.3° W, 42.4°–42.8° N; five decimals at most.
    expect(Math.min(...points.map((p) => p[0]))).toBeGreaterThan(-74.4);
    expect(Math.max(...points.map((p) => p[0]))).toBeLessThan(-73.6);
    expect(Math.min(...points.map((p) => p[1]))).toBeGreaterThan(42.3);
    expect(Math.max(...points.map((p) => p[1]))).toBeLessThan(42.9);
    expect(points.every(([x, y]) => Math.abs(x * 1e5 - Math.round(x * 1e5)) < 1e-6 && Math.abs(y * 1e5 - Math.round(y * 1e5)) < 1e-6)).toBe(true);
  });

  it('every local state bundle lists a valid outlines file, within 1 MB', async () => {
    const states = (await readdir(root)).filter((name) => /^[A-Z]{2}$/.test(name)).sort();
    expect(states.length).toBeGreaterThanOrEqual(51);
    for (const state of states) {
      const manifest = decodeManifest(JSON.parse(await readFile(join(root, state, 'manifest.json'), 'utf-8')), state);
      const ref = manifest.outlines;
      expect(ref, state).toBeDefined();
      const packed = await readFile(join(root, state, ref!.file));
      expect([packed.byteLength, createHash('sha256').update(packed).digest('hex')], state).toEqual([ref!.bytes, ref!.sha256]);
      expect(ref!.bytes, state).toBeLessThan(1_000_000);
      const decoded = decodeOutlines(Uint8Array.from(gunzipSync(packed)).buffer, manifest.counties.map((c) => c.fips));
      expect(decoded.features, state).toHaveLength(manifest.counties.length);
    }
  }, 60000);

  it('node reader: loads the outlines on demand, once', async () => {
    const source = new NodeBundleSource(root, { points: 'on-demand' });
    const loaded = await source.loadState('NY');
    const [a, b] = await Promise.all([source.loadOutlines(loaded), source.loadOutlines(loaded)]);
    expect(a).toBe(b);
    expect(a).toEqual(nyOutlines);
    expect(await source.loadOutlines(loaded)).toBe(a);
    expect(await source.loadOutlines({ ...loaded, manifest: { ...loaded.manifest, outlines: undefined } })).toBeUndefined();
  }, 15000);

  it('browser reader: not fetched by loadState; fetched once on demand, verified, retried, then served from IndexedDB', async () => {
    const ref = ny.manifest.outlines!;
    const bad = Uint8Array.from(await readFile(join(root, 'NY', ref.file)));
    bad[bad.length - 1] ^= 1;
    let corrupt = true;
    const fetchMock = vi.fn(async (url: URL) => {
      const file = url.pathname.replace(/^\/assets\/NY\//, '');
      if (file === ref.file && corrupt) return new Response(bad);
      return new Response(Uint8Array.from(await readFile(join(root, 'NY', file))));
    });
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', fetchMock);
    const fetched = () => fetchMock.mock.calls.map(([url]) => url.pathname).filter((path) => path === `/assets/NY/${ref.file}`);

    const browser = new BrowserBundleSource(base, { points: 'on-demand' });
    const loaded = await browser.loadState('NY');
    expect(fetched()).toHaveLength(0);
    await expect(browser.loadOutlines(loaded)).rejects.toThrow(/hash or size mismatch/);
    corrupt = false;
    const [a, b] = await Promise.all([browser.loadOutlines(loaded), browser.loadOutlines(loaded)]);
    expect(a).toBe(b);
    expect(a).toEqual(nyOutlines);
    expect(fetched()).toHaveLength(2);

    // A new reader (a new panel) finds the verified bytes in IndexedDB.
    fetchMock.mockClear();
    const fresh = new BrowserBundleSource(base, { points: 'on-demand' });
    expect(await fresh.loadOutlines(await fresh.loadState('NY'))).toEqual(nyOutlines);
    expect(fetched()).toHaveLength(0);
  }, 20000);
});
