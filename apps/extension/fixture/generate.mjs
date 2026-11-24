#!/usr/bin/env node
/**
 * Generates the synthetic test fixtures (real @zd/bundle binary format):
 *   fixture/data/<ST>/...      manifest.json, attrs.<sha>.bin.gz, <county>.<sha>.topo.json.gz
 *   fixture/www/plan.json      "NY": the fake DRA page's default plan
 *   fixture/www/plan-vt.json   "VT": the two-way-trade plan (fake page ?plan=vt)
 *
 * NY: grid of square blocks; 4x4 blocks per precinct; two counties; four districts with small
 * deviations; one precinct already split (committed as a B_{precinct}_{bitset} feature).
 *
 * VT: four vertical strips (districts 1..4, left to right). District 1 holds only even-population
 * blocks (at least 8 people each, or empty), the state total divides evenly by 4 (so only q counts
 * as zero), district 1 is 3 over and its only neighbour, district 2, is 3 under. No one-way move can
 * fix district 1 (sums of even numbers are never 3), so the single-district solver finds nothing and
 * the planner has to trade across the 1/2 border in both directions; the first leg moves at least
 * 8 people, so after it both districts sit further from zero than when they started.
 *
 * Deterministic (seeded PRNG).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
rmSync(join(here, 'data'), { recursive: true, force: true });
mkdirSync(join(here, 'www'), { recursive: true });

function encodeBitset(list, members) {
  const index = new Map(list.map((g, i) => [g, i]));
  const bytes = new Uint8Array(Math.floor((list.length + 7) / 8));
  for (const g of members) {
    const i = index.get(g);
    bytes[i >> 3] |= 1 << (i & 7);
  }
  return Buffer.from(bytes).toString('base64');
}

/**
 * cfg: { state, fips, counties: [left, right], W, H, P, X0, Y0, D, ND, seed,
 *        district(px, py, PW, PH) -> d, pop(rand, x, y, d) -> { pop, popA },
 *        split?: true (NY's committed split), adjust?(cells) (final population tweaks), planFile }
 */
function generate(cfg) {
  const { state, fips: STATE_FIPS, counties: COUNTIES, W, H, P, X0, Y0, D, ND } = cfg;
  let seed = cfg.seed;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const PW = W / P;
  const PH = H / P;

  // --- blocks -----------------------------------------------------------------
  const cells = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const county = x < W / 2 ? 0 : 1;
      const px = Math.floor(x / P);
      const py = Math.floor(y / P);
      const lx = x % P;
      const ly = y % P;
      // tract per precinct, block number within it
      const tract = String(100 + py * PW + px).padStart(6, '0');
      const blockNo = String(1000 + ly * P + lx).padStart(4, '0');
      const geoid = `${COUNTIES[county]}${tract}${blockNo}`;
      const { pop, popA } = cfg.pop(rand, x, y, cfg.district(px, py, PW, PH));
      const precinct = `${COUNTIES[county]}${String(py * PW + px + 1).padStart(6, '0')}`;
      cells.push({ x, y, county, px, py, geoid, pop, popA, precinct });
    }
  }
  const cellAt = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? cells[y * W + x] : null);
  const sorted = cells.slice().sort((a, b) => (a.geoid < b.geoid ? -1 : 1));
  sorted.forEach((c, i) => (c.index = i));
  const n = sorted.length;

  // --- precincts / districts -------------------------------------------------
  const precinctIds = [...new Set(sorted.map((c) => c.precinct))].sort();
  const pIndex = new Map(precinctIds.map((p, i) => [p, i]));
  const districtOfPrecinct = new Map();
  for (let py = 0; py < PH; py++) {
    for (let px = 0; px < PW; px++) {
      const id = cells[py * P * W + px * P].precinct;
      districtOfPrecinct.set(id, cfg.district(px, py, PW, PH));
    }
  }
  const blocksOf = new Map(precinctIds.map((p) => [p, []]));
  for (const c of sorted) blocksOf.get(c.precinct).push(c.geoid);
  for (const list of blocksOf.values()) list.sort();

  let splitPrecinct = null;
  let splitTop = [];
  if (cfg.split) {
    // One committed split precinct on the 2/4 border: its top row of blocks is painted into 2.
    splitPrecinct = cells[(PH / 2) * P * W + (PW / 2 + 1) * P].precinct;
    splitTop = cells.filter((c) => c.precinct === splitPrecinct && c.y === (PH / 2) * P).map((c) => c.geoid);
  }
  const districtOfCell = (c) => (c.precinct === splitPrecinct ? (splitTop.includes(c.geoid) ? 2 : 4) : districtOfPrecinct.get(c.precinct));
  cfg.adjust?.(sorted, districtOfCell);

  const featureMap = {};
  for (const [p, d] of districtOfPrecinct) if (p !== splitPrecinct) featureMap[p] = d;
  if (splitPrecinct) {
    const list = blocksOf.get(splitPrecinct);
    const rest = list.filter((g) => !splitTop.includes(g));
    featureMap[`B_${splitPrecinct}_${encodeBitset(list, splitTop)}`] = 2;
    featureMap[`B_${splitPrecinct}_${encodeBitset(list, rest)}`] = 4;
  }

  // --- adjacency (rook) ---------------------------------------------------------
  const M_PER_DEG_LAT = 111_320;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((Y0 * Math.PI) / 180);
  const edgeNS = Math.round(D * mPerDegLon); // horizontal edge length (top/bottom)
  const edgeEW = Math.round(D * M_PER_DEG_LAT); // vertical edge length (left/right)
  const nbrs = sorted.map(() => []);
  const outerLen = new Uint32Array(n);
  const area = new Float32Array(n);
  for (const c of sorted) {
    area[c.index] = edgeNS * edgeEW;
    for (const [dx, dy, len] of [[1, 0, edgeEW], [-1, 0, edgeEW], [0, 1, edgeNS], [0, -1, edgeNS]]) {
      const o = cellAt(c.x + dx, c.y + dy);
      if (o) nbrs[c.index].push([o.index, len]);
      else outerLen[c.index] += len;
    }
  }
  for (const l of nbrs) l.sort((a, b) => a[0] - b[0]);
  const m = nbrs.reduce((s, l) => s + l.length, 0);

  // --- attrs.bin -----------------------------------------------------------------
  const header = Buffer.from(JSON.stringify({ n, m, countyFips: COUNTIES, precinctIds }), 'utf8');
  const parts = [];
  let offset = 8 + header.length;
  function align(width) {
    const start = Math.ceil(offset / width) * width;
    if (start > offset) parts.push(Buffer.alloc(start - offset));
    offset = start;
  }
  function push(typed) {
    align(typed.BYTES_PER_ELEMENT);
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    parts.push(b);
    offset += b.length;
  }
  const geoidDeltas = new BigUint64Array(n);
  let prev = 0n;
  sorted.forEach((c, i) => {
    const v = BigInt(c.geoid);
    geoidDeltas[i] = v - prev;
    prev = v;
  });
  const pop = Int32Array.from(sorted, (c) => c.pop);
  const adjDeltas = Int32Array.from(sorted, (c) => c.popA - c.pop);
  const countyOf = Uint16Array.from(sorted, (c) => c.county);
  const precinctOf = Uint32Array.from(sorted, (c) => pIndex.get(c.precinct));
  const degrees = Uint32Array.from(nbrs, (l) => l.length);
  const targetDeltas = new Int32Array(m);
  const adjLen = new Uint16Array(m);
  {
    let e = 0;
    nbrs.forEach((l, i) =>
      l.forEach(([t, len]) => {
        targetDeltas[e] = t - i;
        adjLen[e++] = len;
      }),
    );
  }
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0x5a444231, 0);
  head.writeUInt32LE(header.length, 4);
  for (const arr of [geoidDeltas, pop, adjDeltas, countyOf, precinctOf, degrees, targetDeltas, adjLen, outerLen, area]) push(arr);
  const attrs = Buffer.concat([head, header, ...parts]);

  // --- geometry ------------------------------------------------------------------
  const ring = (c) => {
    const x0 = X0 + c.x * D;
    const y0 = Y0 - c.y * D;
    return [[x0, y0], [x0 + D, y0], [x0 + D, y0 - D], [x0, y0 - D], [x0, y0]];
  };

  const outDir = join(here, 'data', state);
  mkdirSync(outDir, { recursive: true });
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const writeRef = (name, raw) => {
    const gz = gzipSync(raw, { level: 9 });
    const h = sha(gz);
    const file = name(h);
    writeFileSync(join(outDir, file), gz);
    return { file, sha256: h, bytes: gz.length };
  };
  const attrsRef = writeRef((h) => `attrs.${h}.bin.gz`, attrs);
  const counties = COUNTIES.map((fips, ci) => {
    const members = sorted.filter((c) => c.county === ci);
    const arcs = members.map(ring);
    const topo = {
      type: 'Topology',
      objects: { blocks: { type: 'GeometryCollection', geometries: members.map((c, k) => ({ type: 'Polygon', id: c.geoid, properties: { GEOID20: c.geoid }, arcs: [[k]] })) } },
      arcs,
    };
    return { fips, features: members.length, ...writeRef((h) => `${fips}.${h}.topo.json.gz`, Buffer.from(JSON.stringify(topo))) };
  });
  const manifest = {
    format: 1,
    state,
    stateFips: STATE_FIPS,
    censusVintage: 'synthetic-fixture',
    draDataVersion: 'fixture',
    precinctKind: 'vtd',
    attribution: 'Synthetic test fixture (no real data).',
    attrs: attrsRef,
    counties,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // --- fake DRA page data -----------------------------------------------------------
  const plan = {
    state,
    nDistricts: ND,
    center: [X0 + (W * D) / 2, Y0 - (H * D) / 2],
    bounds: [X0, Y0 - H * D, X0 + W * D, Y0],
    blocks: sorted.map((c) => ({ geoid: c.geoid, precinct: c.precinct, pop: c.pop, popA: c.popA, ring: ring(c) })),
    rev: Object.fromEntries(blocksOf),
    featureMap,
    splitPrecinct,
  };
  writeFileSync(join(here, 'www', cfg.planFile), JSON.stringify(plan));

  const total = sorted.reduce((s, c) => s + c.pop, 0);
  const dpop = new Array(ND + 1).fill(0);
  for (const c of sorted) dpop[districtOfCell(c)] += c.pop;
  const target = Math.round(total / ND);
  console.log(`fixture ${state}: ${n} blocks, ${precinctIds.length} precincts, total ${total}, target ${target}, remainder ${total % ND}`);
  console.log('  district deviations:', dpop.slice(1).map((p, i) => `D${i + 1} ${p - target >= 0 ? '+' : ''}${p - target}`).join(', '));
  return { total, dpop };
}

// --- NY: the default fixture (unchanged byte for byte from the first version) ----------
generate({
  state: 'NY',
  fips: '36',
  counties: ['36901', '36903'], // left / right half
  W: 48,
  H: 32,
  P: 4,
  X0: -75.2,
  Y0: 42.9,
  D: 0.004,
  ND: 4,
  seed: 20261123,
  planFile: 'plan.json',
  split: true,
  district(px, py, PW, PH) {
    let d = py < PH / 2 ? (px < PW / 2 ? 1 : 2) : px < PW / 2 ? 3 : 4;
    // Imbalance: district 1 takes two precincts from 2 and one from 3.
    if ((px === PW / 2 && py === 0) || (px === PW / 2 && py === 1)) d = 1;
    if (px === 0 && py === PH / 2) d = 1;
    return d;
  },
  pop(rand) {
    const zero = rand() < 0.2;
    const pop = zero ? 0 : 1 + Math.floor(rand() * 40);
    const adj = pop > 0 && rand() < 0.03 ? -Math.min(pop, 1 + Math.floor(rand() * 5)) : 0; // prisoner adjustment
    return { pop, popA: pop + adj };
  },
});

// --- VT: two-way trade needed (see the header) ---------------------------------------
generate({
  state: 'VT',
  fips: '50',
  counties: ['50901', '50903'],
  W: 32,
  H: 16,
  P: 4,
  X0: -72.9,
  Y0: 44.6,
  D: 0.004,
  ND: 4,
  seed: 4242,
  planFile: 'plan-vt.json',
  district(px) {
    return 1 + Math.floor(px / 2); // strips of 2 precinct columns
  },
  pop(rand, x, y, d) {
    const zero = rand() < 0.2;
    let pop;
    if (zero) pop = 0;
    else if (d === 1) pop = 2 * (4 + Math.floor(rand() * 17)); // 8..40, even
    else pop = 1 + Math.floor(rand() * 40);
    return { pop, popA: pop };
  },
  adjust(sorted, districtOf) {
    // Exact sums: D1 = q + 3, D2 = q - 3, D3 = D4 = q (total = 4q, no remainder).
    const sums = [0, 0, 0, 0, 0];
    for (const c of sorted) sums[districtOf(c)] += c.pop;
    const q = sums[1] - 3;
    const want = { 2: q - 3, 3: q, 4: q };
    for (const d of [2, 3, 4]) {
      let delta = want[d] - sums[d];
      // Spread the correction over the district's populated blocks furthest from district 1 (right edge
      // of the strip, away from the 1/2 border), keeping every block at 1..80 people.
      const pool = sorted.filter((c) => districtOf(c) === d && c.pop > 0).sort((a, b) => b.x - a.x || a.y - b.y);
      for (let guard = 0; delta !== 0 && guard < 100000; guard++) {
        const c = pool[guard % pool.length];
        if (delta > 0 && c.pop < 80) {
          c.pop++;
          delta--;
        } else if (delta < 0 && c.pop > 1) {
          c.pop--;
          delta++;
        }
      }
      if (delta !== 0) throw new Error(`VT fixture: could not balance district ${d}`);
    }
    for (const c of sorted) c.popA = c.pop;
  },
});
