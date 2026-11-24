/**
 * Whole-map benchmark on a synthetic grid. Splits wall time into planner time and solver
 * time (capacity + solve), since the reference solver is not the real engine.
 *   npx tsx scripts/bench.ts [side=540] [districts=26] [solver=ref|engine]
 */
import type { BorderSolver } from '@zd/contracts';
import { planGroup } from '../src/index';
import { generateMap, popsOf } from '../test/support/synth';
import { ReferenceSolver } from '../test/support/refSolver';
import { expectGoodPlan, range } from '../test/support/check';

const side = Number(process.argv[2] ?? 540);
const k = Number(process.argv[3] ?? 26);
const which = process.argv[4] ?? 'ref';

async function makeSolver(): Promise<BorderSolver> {
  if (which === 'ref') return new ReferenceSolver();
  const enginePath = '../../engine/src/index';
  const mod: any = await import(/* @vite-ignore */ enginePath);
  const make = mod.createBorderSolver ?? mod.createSolver ?? (mod.BorderSolverImpl && (() => new mod.BorderSolverImpl()));
  if (make) return make();
  if (mod.borderSolver) return mod.borderSolver;
  throw new Error('engine exports: ' + Object.keys(mod).join(', '));
}

function timed(base: BorderSolver) {
  const t = { capacity: 0, solve: 0, capCalls: 0, solveCalls: 0 };
  const s: BorderSolver = {
    capacity: (r) => { const a = performance.now(); try { return base.capacity(r); } finally { t.capacity += performance.now() - a; t.capCalls++; } },
    solve: (r) => { const a = performance.now(); try { return base.solve(r); } finally { t.solve += performance.now() - a; t.solveCalls++; } },
    solveScored: (r) => { const a = performance.now(); try { return base.solveScored(r); } finally { t.solve += performance.now() - a; t.solveCalls++; } },
  };
  return { s, t };
}

const tg = performance.now();
const map = generateMap({ seed: 7, width: side, height: side, numDistricts: k, precinctSize: 4, countySize: 60 });
const devs = popsOf(map.graph, map.assignment, k).slice(1).map((p) => p - map.targets.q);
console.log(`n=${map.graph.n} districts=${k} maxDev=${Math.max(...devs.map(Math.abs))} gen=${(performance.now() - tg).toFixed(0)}ms`);
const { s, t } = timed(await makeSolver());
const t0 = performance.now();
const res = planGroup({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: range(k), solver: s });
const wall = performance.now() - t0;
console.log(`status=${res.status} plans=${res.solutions.length} wall=${wall.toFixed(0)}ms solver: capacity ${t.capacity.toFixed(0)}ms/${t.capCalls} calls, solve ${t.solve.toFixed(0)}ms/${t.solveCalls} calls; planner own=${(wall - t.capacity - t.solve).toFixed(0)}ms`);
if (res.status !== 'ok') console.log(res.message, JSON.stringify(res.failures).slice(0, 400));
for (const sol of res.solutions) {
  expectGoodPlan(map, sol, range(k));
  console.log(`  ${sol.kind}: borders=${sol.borderFlows.length} people=${sol.stats.people} blocks=${sol.stats.blocks} splits=${sol.stats.newPrecinctSplits} counties=${sol.stats.newCountySplits} touched=${sol.stats.districtsTouched} (independently checked)`);
}
