/** One whole-map run on real New York: tsx scripts/ny-one.ts blocks seed [kind] */
import { borderSolver } from '../../engine/src/index';
import { planGroup } from '../src/index';
import { loadNY, perturbWholeMap } from './ny-load';
const ny = await loadNY();
const assignment = perturbWholeMap(ny, Number(process.argv[2] ?? 1), Number(process.argv[3] ?? 1));
const all = Array.from({ length: ny.k }, (_, i) => i + 1);
const t0 = performance.now();
const res = planGroup({ graph: ny.graph, assignment, targets: ny.targets, districts: all, solver: borderSolver },
  { onRepairDebug: process.env.ZD_REPAIR_DEBUG ? (message) => console.error(message) : undefined });
console.log(res.status, res.solutions.map((s) => s.kind), (performance.now() - t0).toFixed(0), 'ms', 'repairCalls', res.repairCalls);
for (const f of res.failures) console.log(JSON.stringify({ ...f, borders: f.borders.length }));
