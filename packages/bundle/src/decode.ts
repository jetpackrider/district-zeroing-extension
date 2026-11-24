import type { BundleFileRef, BundleManifest, CountyGeometry, StateBundle } from '@zd/contracts';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';

const utf8 = new TextDecoder('utf-8', { fatal: true });
export const FORMAT = 1;

export function stateCode(state: string): string {
  const code = state.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Invalid state code ${state}`);
  return code;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validFile(value: unknown, filename: (hash: string) => string): value is BundleFileRef {
  const ref = object(value);
  return typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)
    && ref.file === filename(ref.sha256) && integer(ref.bytes, 1, 0xffffffff);
}

function validTowns(value: unknown): boolean {
  const ref = object(value);
  return validFile(ref, hash => `towns.${hash}.bin.gz`)
    && integer(ref.count, 0, 0x80000000)
    && typeof ref.kind === 'string' && ref.kind.trim().length > 0;
}

export function decodeManifest(value: unknown, state: string): BundleManifest {
  const manifest = object(value);
  if (manifest.format !== FORMAT || manifest.state !== state || typeof manifest.stateFips !== 'string'
      || !/^[0-9]{2}$/.test(manifest.stateFips) || typeof manifest.censusVintage !== 'string'
      || typeof manifest.draDataVersion !== 'string' || typeof manifest.attribution !== 'string'
      || (manifest.precinctKind !== 'vtd' && manifest.precinctKind !== 'bg')
      || !validFile(manifest.attrs, (hash) => `attrs.${hash}.bin.gz`)
      || (manifest.water !== undefined && !validFile(manifest.water, (hash) => `water.${hash}.bin.gz`))
      || (manifest.towns !== undefined && !validTowns(manifest.towns))
      || !Array.isArray(manifest.counties) || !manifest.counties.length) {
    throw new Error(`Invalid ${state} bundle manifest`);
  }
  const counties = new Set<string>();
  for (const value of manifest.counties) {
    const county = object(value);
    const fips = county.fips;
    if (typeof fips !== 'string' || !/^[0-9]{5}$/.test(fips) || !fips.startsWith(manifest.stateFips)
        || counties.has(fips) || !integer(county.features, 1, 0x80000000)
        || !validFile(county, (hash) => `${fips}.${hash}.topo.json.gz`)) {
      throw new Error(`Invalid county entry in ${state} bundle manifest`);
    }
    counties.add(fips);
  }
  return manifest as unknown as BundleManifest;
}

function strings(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.every((key) => typeof key === 'string' && pattern.test(key))
    && new Set(value).size === value.length;
}

/** The water sidecar: one byte per block, 1 = water only. */
export function decodeWater(data: ArrayBuffer, n: number): Uint8Array {
  const water = new Uint8Array(data);
  if (water.length !== n || water.some((flag) => flag > 1)) throw new Error('Invalid water file');
  return water;
}

/** Little-endian town indices, with 0 reserved for blocks outside municipalities. */
export function decodeTowns(data: ArrayBuffer, n: number, count: number): Uint32Array {
  if (data.byteLength !== 4 * n || count > n) throw new Error('Invalid town file length or count');
  const towns = new Uint32Array(data);
  const seen = new Uint8Array(count + 1);
  let distinct = 0;
  for (const town of towns) {
    if (town > count) throw new Error('Invalid town index');
    if (town && !seen[town]) {
      seen[town] = 1;
      distinct++;
    }
  }
  if (distinct !== count) throw new Error('Town count differs from manifest');
  return towns;
}

export function decodeAttrs(data: ArrayBuffer, manifest: BundleManifest): StateBundle {
  const view = new DataView(data);
  if (data.byteLength < 8 || view.getUint32(0, false) !== 0x5a444231 || manifest.format !== FORMAT) {
    throw new Error('Invalid attributes magic or format version');
  }
  const headerEnd = 8 + view.getUint32(4, true);
  if (headerEnd > data.byteLength) throw new Error('Truncated attributes header');
  const { n, m, countyFips, precinctIds } = object(JSON.parse(utf8.decode(new Uint8Array(data, 8, headerEnd - 8))));
  if (!integer(n, 1, 0x80000000) || !integer(m, 0, 0xffffffff) || m % 2
      || !strings(countyFips, /^[0-9]{5}$/) || !strings(precinctIds, /^[A-Za-z0-9_.\/-]+$/)
      || !precinctIds.length || countyFips.length !== manifest.counties.length
      || countyFips.some((fips, i) => fips !== manifest.counties[i].fips)
      || n !== manifest.counties.reduce((sum, county) => sum + county.features, 0)) {
    throw new Error('Invalid attributes header');
  }

  let offset = headerEnd;
  function take(width: number, length: number): number {
    const start = Math.ceil(offset / width) * width;
    offset = start + width * length;
    if (offset > data.byteLength) throw new Error('Truncated attributes array');
    return start;
  }

  // Supported browser and Node platforms are little-endian.
  const geoidDeltas = new BigUint64Array(data, take(8, n), n);
  const pop = new Int32Array(data, take(4, n), n);
  const adjustedDeltas = new Int32Array(data, take(4, n), n);
  const countyOf = new Uint16Array(data, take(2, n), n);
  const precinctOf = new Uint32Array(data, take(4, n), n);
  const degrees = new Uint32Array(data, take(4, n), n);
  const targetDeltas = new Int32Array(data, take(4, m), m);
  const adjLen = new Uint16Array(data, take(2, m), m);
  const outerLen = new Uint32Array(data, take(4, n), n);
  const areaM2 = new Float32Array(data, take(4, n), n);
  if (offset !== data.byteLength) {
    throw new Error('Invalid attributes length');
  }

  const geoids = new Array<string>(n);
  const adjusted = new Int32Array(n);
  const adjOffsets = new Uint32Array(n + 1);
  const adjTargets = new Uint32Array(m);
  const countyCounts = new Uint32Array(countyFips.length);
  let geoid = 0n;
  for (let i = 0; i < n; i++) {
    geoid += geoidDeltas[i];
    const id = geoid.toString().padStart(15, '0');
    const county = countyOf[i];
    const adjustedPop = pop[i] + adjustedDeltas[i];
    if (geoidDeltas[i] === 0n || id.length !== 15 || id.slice(0, 5) !== countyFips[county]
        || precinctOf[i] >= precinctIds.length || pop[i] < 0 || !integer(adjustedPop, -0x80000000, 0x7fffffff)
        || !Number.isFinite(areaM2[i]) || areaM2[i] < 0) {
      throw new Error(`Invalid attributes for block ${i}`);
    }
    geoids[i] = id;
    adjusted[i] = adjustedPop;
    countyCounts[county]++;

    const start = adjOffsets[i];
    const end = start + degrees[i];
    if (end > m) throw new Error(`Invalid CSR degree for block ${i}`);
    adjOffsets[i + 1] = end;
    let previous = -1;
    for (let edge = start; edge < end; edge++) {
      const target = i + targetDeltas[edge];
      if (target <= previous || target >= n || target === i) throw new Error(`Invalid neighbor for block ${i}`);
      adjTargets[edge] = previous = target;
    }
  }
  if (adjOffsets[n] !== m) throw new Error('Invalid CSR degree total');
  if (manifest.counties.some((county, i) => county.features !== countyCounts[i])) {
    throw new Error('County block counts differ from manifest');
  }
  return {
    manifest, n, geoids, pop: { D20F: pop, D20FA: adjusted }, countyFips, countyOf, precinctIds, precinctOf,
    adjOffsets, adjTargets, adjLen, outerLen, areaM2,
  };
}

interface BlockProperties { GEOID20: string }

export function decodeCounty(data: ArrayBuffer, countyFips: string, count: number): CountyGeometry {
  const parsed = object(JSON.parse(utf8.decode(data)));
  const collections = Object.values(object(parsed.objects));
  if (parsed.type !== 'Topology' || collections.length !== 1
      || object(collections[0]).type !== 'GeometryCollection') {
    throw new Error(`Invalid county topology ${countyFips}`);
  }
  // topojson-client expands delta-encoded arcs, including reversed references.
  const topology = parsed as unknown as Topology<Record<string, GeometryCollection<BlockProperties>>>;
  const [collection] = Object.values(topology.objects);
  const decoded = feature(topology, collection);
  if (decoded.features.length !== count) throw new Error(`Invalid feature count in county ${countyFips}`);
  const seen = new Set<string>();
  const features: CountyGeometry['features'] = [];
  for (const item of decoded.features) {
    const { id, geometry, properties } = item;
    if (typeof id !== 'string' || !/^[0-9]{15}$/.test(id) || !id.startsWith(countyFips)
        || properties?.GEOID20 !== id || seen.has(id)
        || (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon')) {
      throw new Error(`Invalid block feature in county ${countyFips}`);
    }
    seen.add(id);
    features.push({ type: 'Feature', id, properties, geometry });
  }
  return { type: 'FeatureCollection', countyFips, features };
}
