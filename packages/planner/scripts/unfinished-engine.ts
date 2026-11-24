/** Unfinished-map runs (deviations in the thousands) against packages/engine. npx tsx scripts/unfinished-engine.ts */
const enginePath = new URL('../../engine/src/index.ts', import.meta.url).href;
const { borderSolver } = (await import(/* @vite-ignore */ enginePath)) as { borderSolver: import('@zd/contracts').BorderSolver };
import { planGroup } from '../src/index';
import { generateMap, popsOf } from '../test/support/synth';
import { expectGoodPlan, range } from '../test/support/check';
for (const [side, k, skew] of [[300, 6, 0.3], [540, 26, 0.06]] as const) {
  const map = generateMap({ seed: 7, width: side, height: side, numDistricts: k, skew, precinctSize: 4, countySize: 60 });
  const devs = popsOf(map.graph, map.assignment, k).slice(1).map((p) => p - map.targets.q);
  const t = performance.now();
  const res = planGroup({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: range(k), solver: borderSolver });
  console.log(`n=${map.graph.n} k=${k} maxDev=${Math.max(...devs.map(Math.abs))} status=${res.status} ms=${(performance.now() - t).toFixed(0)} ${res.message}`);
  for (const s of res.solutions) { expectGoodPlan(map, s, range(k)); console.log(`  ${s.kind} people=${s.stats.people} blocks=${s.stats.blocks} splits=${s.stats.newPrecinctSplits} transfers=${s.transfers.length}`); }
  if (res.failures.length) console.log('  failures', JSON.stringify(res.failures).slice(0, 300));
}
