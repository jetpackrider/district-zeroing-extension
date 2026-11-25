/**
 * County clusters on real bundles: findCountyClusters on data/<ST>, every result checked with
 * verifyClustering.
 *
 *   tsx scripts/clusters-real.ts                 the standard runs (NC House/Senate, NY, TX, CA, PA, IA, DC, ...)
 *   tsx scripts/clusters-real.ts NC 120 0.05     one run: state, districts, tolerance [timeLimitMs] [--list]
 *
 * Needs data/<ST> (run the pipeline first).
 */
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { findCountyClusters, verifyClustering } from '../src/index';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const source = new NodeBundleSource(DATA, { points: 'on-demand' });

const STANDARD: Array<[string, number, number]> = [
  ['NC', 120, 0.05], ['NC', 50, 0.05],
  ['NY', 26, 0.05], ['NY', 150, 0.05],
  ['TX', 150, 0.05], ['CA', 80, 0.05], ['PA', 203, 0.05],
  ['IA', 100, 0.01], ['DC', 8, 0.05],
  ['NY', 26, 0.005], ['IA', 4, 0.005],
];

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = process.argv.includes('--list');
const runs: Array<[string, number, number, number?]> = args.length
  ? [[args[0], Number(args[1]), Number(args[2] ?? 0.05), args[3] ? Number(args[3]) : undefined]]
  : STANDARD;

let failures = 0;
for (const [state, numDistricts, tolerance, timeLimitMs] of runs) {
  const bundle = await source.loadState(state);
  const graph = toEngineGraph(bundle, 'D20F');
  const names = bundle.names?.counties ?? bundle.countyFips;
  const req = { graph, numDistricts, tolerance, ...(timeLimitMs ? { timeLimitMs } : {}) };
  const res = findCountyClusters(req, process.argv.includes('--log') ? { log: (m) => console.log('   ' + m) } : {});
  const best = res.clusterings[0];
  let verified = 0;
  for (const c of res.clusterings) {
    const check = verifyClustering(graph, req, c);
    if (check.ok) verified++;
    else { failures++; console.log('   VERIFY FAILED', c.id, check.issues.slice(0, 5)); }
  }
  const head = `${state} ${numDistricts} districts ±${tolerance * 100}% (${bundle.countyFips.length} counties, size ${Math.round(res.districtSize)}):`;
  if (!best) {
    console.log(`${head} status=${res.status} in ${res.elapsedMs.toFixed(0)} ms, exhaustive=${res.exhaustive}\n   ${res.message ?? ''}`);
    continue;
  }
  const s = best.stats;
  console.log(`${head} status=${res.status} clusters=${s.clusterCount} (single-county ${s.singleCounty})` +
    ` maxDev=${(s.maxAbsDeviationPct * 100).toFixed(2)}% largest=${s.largestClusterCounties} counties` +
    ` alternatives=${res.clusterings.length} verified=${verified}/${res.clusterings.length}` +
    ` exhaustive=${res.exhaustive} in ${res.elapsedMs.toFixed(0)} ms${res.message ? `\n   ${res.message}` : ''}`);
  const byK = new Map<number, number>();
  for (const c of best.clusters) byK.set(c.districts, (byK.get(c.districts) ?? 0) + 1);
  console.log('   clusters by district count:', [...byK.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(' '));
  if (list) {
    for (const c of best.clusters) {
      console.log(`   ${c.districts} × ${(c.deviationPct * 100).toFixed(2).padStart(6)}%  ${c.counties.map((i) => names[i].replace(/ County$/, '')).join(', ')}`);
    }
  }
}
if (failures) { console.log(`${failures} clusterings failed verification`); process.exit(1); }
