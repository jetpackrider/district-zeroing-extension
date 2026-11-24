#!/usr/bin/env node
/**
 * Real-scale fixture: the fake DRA page's `?plan=real` mode serves New York's enacted
 * congressional plan (data/NY/fixtures/cd119.csv) over the real NY bundle (data/NY: 288,819 blocks,
 * 14,191 precincts), through the same window.dra shape as the synthetic fixture.
 *
 *   fixture/www/plan-real-ny.json   { state, nDistricts, center, geoids, pop, popA, precinctIds, precinctOf, featureMap }
 *
 * The feature map is what DRA's fullBlockMap() holds for a committed plan (RECON.md items 2 and 14):
 *   - a precinct ID for every precinct wholly in one district,
 *   - for a split precinct, one `B_{precinct}_{bitset}` entry per district, where the bitset is
 *     base64 of bytes and bit i (LSB first) selects rev(precinct)[i], rev being the precinct's
 *     blocks in sorted GEOID order (DRA's ListToBitset over blockMapping.rev()),
 *   - unassigned blocks are left out (district 0).
 *
 * Reads data/NY only. Skips (exit 0, no output) when data/NY is absent. Does not modify data/.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '../../../data/NY');
const OUT = join(here, 'www', 'plan-real-ny.json');
if (!existsSync(join(DATA, 'manifest.json')) || !existsSync(join(DATA, 'fixtures/cd119.csv'))) {
  console.log('gen-real: data/NY (manifest.json + fixtures/cd119.csv) not found; skipping the real-scale fixture.');
  process.exit(0);
}
const t0 = Date.now();
const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const raw = gunzipSync(readFileSync(join(DATA, manifest.attrs.file)));
const data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const view = new DataView(data);
if (view.getUint32(0, false) !== 0x5a444231) throw new Error('bad attrs magic');
const headerEnd = 8 + view.getUint32(4, true);
const { n, m, precinctIds } = JSON.parse(Buffer.from(data, 8, headerEnd - 8).toString('utf8'));
let offset = headerEnd;
const take = (width, length) => {
  const start = Math.ceil(offset / width) * width;
  offset = start + width * length;
  return start;
};
// Layout: docs/BUNDLE_FORMAT.md (same order as packages/bundle decodeAttrs).
const geoidDeltas = new BigUint64Array(data, take(8, n), n);
const pop = new Int32Array(data, take(4, n), n);
const adjDeltas = new Int32Array(data, take(4, n), n);
take(2, n); // countyOf
const precinctOf = new Uint32Array(data, take(4, n), n);
void m;

const geoids = new Array(n);
let g = 0n;
for (let i = 0; i < n; i++) {
  g += geoidDeltas[i];
  geoids[i] = g.toString().padStart(15, '0');
}
const index = new Map(geoids.map((x, i) => [x, i]));

// Enacted plan, block level.
const district = new Uint16Array(n);
let rows = 0;
let maxD = 0;
for (const line of readFileSync(join(DATA, 'fixtures/cd119.csv'), 'utf8').split(/\r?\n/)) {
  const [geoid, label] = line.split(/[,|]/);
  if (!/^\d{15}$/.test(geoid ?? '')) continue;
  const i = index.get(geoid);
  if (i === undefined) throw new Error(`cd119.csv: ${geoid} is not in the bundle`);
  const d = Number(label);
  if (!Number.isInteger(d) || d < 1) throw new Error(`cd119.csv: non-numeric district ${label}`);
  district[i] = d;
  if (d > maxD) maxD = d;
  rows++;
}

// Precinct -> blocks in sorted GEOID order (the bundle is sorted, so iteration order is enough).
const members = Array.from({ length: precinctIds.length }, () => []);
for (let i = 0; i < n; i++) members[precinctOf[i]].push(i);

function bitset(list, chosen) {
  const bytes = new Uint8Array(Math.floor((list.length + 7) / 8));
  list.forEach((b, k) => {
    if (chosen(b)) bytes[k >> 3] |= 1 << (k & 7);
  });
  return Buffer.from(bytes).toString('base64');
}

const featureMap = {};
let whole = 0;
let split = 0;
for (let p = 0; p < members.length; p++) {
  const list = members[p];
  if (!list.length) continue;
  const ds = [...new Set(list.map((b) => district[b]))];
  if (ds.length === 1) {
    if (ds[0]) {
      featureMap[precinctIds[p]] = ds[0];
      whole++;
    }
    continue;
  }
  split++;
  for (const d of ds) if (d) featureMap[`B_${precinctIds[p]}_${bitset(list, (b) => district[b] === d)}`] = d;
}

const total = pop.reduce((s, x) => s + x, 0);
const dpop = new Array(maxD + 1).fill(0);
for (let i = 0; i < n; i++) dpop[district[i]] += pop[i];
const target = Math.round(total / maxD);
const plan = {
  state: 'NY',
  nDistricts: maxD,
  center: [-73.95, 40.7],
  geoids,
  pop: Array.from(pop),
  popA: Array.from(pop, (x, i) => x + adjDeltas[i]),
  precinctIds,
  precinctOf: Array.from(precinctOf),
  featureMap,
};
writeFileSync(OUT, JSON.stringify(plan));
console.log(`gen-real: ${n} blocks, ${precinctIds.length} precincts (${whole} whole, ${split} split), ${rows} CSV rows, ${maxD} districts, total ${total}, target ${target}, in ${Date.now() - t0} ms`);
console.log('  deviations:', dpop.slice(1).map((x, i) => `${i + 1}:${x - target}`).join(' '), ` unassigned pop ${dpop[0]}`);
