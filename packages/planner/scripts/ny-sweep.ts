/**
 * Whole-map sweep on real New York: blocks-per-district 1..4 x seeds 1..5.
 *   tsx scripts/ny-sweep.ts [maxBlocks=4] [maxSeed=5]
 */
import { isZeroed } from '@zd/contracts';
import { borderSolver } from '../../engine/src/index';
import { districtPopulations, planGroup, verifyPlan } from '../src/index';
import { loadNY, perturbWholeMap, twoWayBorders } from './ny-load';

import { capture, fixedAssignment } from './tuning-capture';

const maxBlocks = Number(process.argv[2] ?? 4);
const maxSeed = Number(process.argv[3] ?? 5);
const ny = await loadNY();
const { graph, targets, k } = ny;
const all = Array.from({ length: k }, (_, i) => i + 1);
console.log('blocks seed  maxDev  status  compactKindsOk/3  distinctPlans(verified, 26/26)  time_ms  repairCalls  per-plan: kind transfers twoWayBorders people blocks');
let failedRuns = 0;
for (let per = 1; per <= maxBlocks; per++) {
  for (let seed = 1; seed <= maxSeed; seed++) {
    const id = `sweep/${per}/${seed}`;
    const assignment = fixedAssignment(id, perturbWholeMap(ny, per, seed));
    const pops = districtPopulations(graph, assignment, k);
    const maxDev = Math.max(...all.map((d) => Math.abs(pops[d] - targets.draTarget)));
    const t0 = performance.now();
    const res = planGroup({ graph, assignment, targets, districts: all, solver: borderSolver });
    const ms = performance.now() - t0;
    const verified: boolean[] = [];
    let good = 0;
    const parts: string[] = [];
    const relaxed: string[] = [];
    for (const plan of res.solutions) {
      const check = verifyPlan({ graph, assignment, targets, districts: all, transfers: plan.transfers });
      const after = assignment.slice();
      for (const t of plan.transfers) {
        if (plan.stats.longReach && !borderSolver.isCompactTransfer(graph, after, t)) {
          const empty = t.blocks.filter(b => graph.pop[b] === 0).length;
          relaxed.push(`${t.from}→${t.to}: ${t.people} people / ${t.blocks.length} blocks / ${empty} empty`);
        }
        for (const b of t.blocks) after[b] = t.to;
      }
      const p2 = districtPopulations(graph, after, k);
      const zeroed = all.filter((d) => isZeroed(p2[d], targets)).length;
      verified.push(check.ok && zeroed === k);
      if (verified.at(-1)) good++;
      parts.push(`${plan.kind}${check.ok && zeroed === k ? '' : '(BAD)'} t=${plan.transfers.length} 2way=${twoWayBorders(plan.borderFlows)} p=${plan.stats.people} b=${plan.stats.blocks} steps=${plan.stats.steps}`);
    }
    capture(id, 'NY', assignment, res.status, ms, res.solutions, verified);
    if (!good) failedRuns++;
    console.log(`${per} ${seed}  ${String(maxDev).padStart(5)}  ${res.status}  ${3 - res.failures.length}/3  ${good}/${res.solutions.length}  ${ms.toFixed(0).padStart(6)}  ${res.repairCalls}  ${parts.join(' | ')}`);
    if (relaxed.length) console.log(`     longReach: ${relaxed.join(' | ')}`);
    for (const f of res.failures) {
      console.log(`     failed ${f.kind}: ${f.reason}${f.stuck ? ` stuck district ${f.stuck.district} residual ${f.stuck.residual} (violation ${f.stuck.violation}) neighbors ${f.stuck.neighbors.join(',')}` : ''} unmet=${f.unmet} lastBorders=${f.borders.map((b) => `${b.from}>${b.to}:${b.people}`).join(' ')}`);
    }
  }
}
console.log(`runs with no verified plan: ${failedRuns}`);
if (failedRuns) process.exitCode = 1;
