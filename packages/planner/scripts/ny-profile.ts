/**
 * Where the time goes in a whole-map run on real New York.
 *   tsx scripts/ny-profile.ts [blocks=1..4] [seeds=1..5]
 */
import type { BorderSolveRequest, BorderSolver, CapacityCurve } from '@zd/contracts';
import { borderSolver } from '../../engine/src/index';
import { buildInteractionGraph, CurveCache, planGroup } from '../src/index';
import { loadNY, perturbWholeMap } from './ny-load';

class Timed implements BorderSolver {
  solveMs = 0; solveCalls = 0; capMs = 0; capCalls = 0;
  solve(req: BorderSolveRequest) { const t = performance.now(); try { return borderSolver.solve(req); } finally { this.solveMs += performance.now() - t; this.solveCalls++; } }
  solveScored(req: BorderSolveRequest) { const t = performance.now(); try { return borderSolver.solveScored(req); } finally { this.solveMs += performance.now() - t; this.solveCalls++; } }
  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve { const t = performance.now(); try { return borderSolver.capacity(req); } finally { this.capMs += performance.now() - t; this.capCalls++; } }
}
const ny = await loadNY();
const all = Array.from({ length: ny.k }, (_, i) => i + 1);
const maxB = Number(process.argv[2] ?? 4), maxS = Number(process.argv[3] ?? 5);
console.log('blocks seed total_ms capacity(calls/ms) solve(calls/ms) repairCalls planner_ms | view_ms then plan_ms with a shared CurveCache');
const sum = { total: 0, cap: 0, solve: 0, n: 0, view: 0, shared: 0 };
for (let per = 1; per <= maxB; per++) for (let seed = 1; seed <= maxS; seed++) {
  const assignment = perturbWholeMap(ny, per, seed);
  const s = new Timed();
  const t0 = performance.now();
  const res = planGroup({ graph: ny.graph, assignment, targets: ny.targets, districts: all, solver: s });
  const total = performance.now() - t0;
  const cache = new CurveCache();
  const t1 = performance.now();
  buildInteractionGraph({ graph: ny.graph, assignment, targets: ny.targets, districts: all, solver: borderSolver, curveCache: cache });
  const view = performance.now() - t1;
  const t2 = performance.now();
  planGroup({ graph: ny.graph, assignment, targets: ny.targets, districts: all, solver: borderSolver }, { curveCache: cache });
  const shared = performance.now() - t2;
  sum.view += view; sum.shared += shared;
  sum.total += total; sum.cap += s.capMs; sum.solve += s.solveMs; sum.n++;
  console.log(`${per} ${seed} ${total.toFixed(0)} ${s.capCalls}/${s.capMs.toFixed(0)} ${s.solveCalls}/${s.solveMs.toFixed(0)} ${res.repairCalls} ${(total - s.capMs - s.solveMs).toFixed(0)} | ${view.toFixed(0)} then ${shared.toFixed(0)}  ${res.status} ${res.solutions.length}`);
}
console.log(`mean: total ${(sum.total / sum.n).toFixed(0)} ms, capacity ${(sum.cap / sum.n).toFixed(0)} ms, solve ${(sum.solve / sum.n).toFixed(0)} ms, planner ${((sum.total - sum.cap - sum.solve) / sum.n).toFixed(0)} ms; with shared cache: view ${(sum.view / sum.n).toFixed(0)} ms then plan ${(sum.shared / sum.n).toFixed(0)} ms`);
