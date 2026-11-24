/**
 * Phase 6 check on real data: the enacted New York congressional map (119th Congress),
 * knocked out of balance by moving seeded border blocks, then re-zeroed with the real engine.
 *
 *   tsx scripts/ny-real.ts [blocksPerDistrict=4] [seed=1] [extraGroup e.g. 19,20,21,22,24,26]
 *
 * Needs data/NY (run the pipeline first).
 */
import { readFile } from 'node:fs/promises';
import { computeTargets, isZeroed, type Assignment } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver } from '../../engine/src/index';
import { perturb, readAssignment } from '../../engine/scripts/cli-input';
import { checkGroupFeasibility, districtPopulations, planGroup, verifyPlan } from '../src/index';

const DATA = new URL('../../../data/', import.meta.url).pathname;
const perDistrict = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 1);

const bundle = await new NodeBundleSource(decodeURIComponent(DATA)).loadState('NY');
const graph = toEngineGraph(bundle, 'D20F');
const csv = await readFile(decodeURIComponent(DATA) + 'NY/fixtures/cd119.csv', 'utf-8');
const parsed = readAssignment(csv, bundle.geoids);
const k = parsed.numDistricts;
const total = bundle.pop.D20F.reduce((a, b) => a + b, 0);
const targets = computeTargets(total, k);

let assignment: Assignment = parsed.assignment;
for (let d = 1; d <= k; d += 2) {
  const result = perturb(graph, assignment, d, perDistrict, seed * 1000 + d) as unknown;
  assignment = (result instanceof Uint16Array ? result : (result as { assignment: Assignment }).assignment);
}

const devs = (a: Assignment) => {
  const pops = districtPopulations(graph, a, k);
  return Array.from({ length: k }, (_, i) => pops[i + 1] - targets.draTarget);
};
const before = devs(assignment);
console.log(`NY: ${graph.n} blocks, ${k} districts, q=${targets.q}, remainder=${targets.remainder}`);
console.log('deviations before:', before.join(' '));

function run(label: string, districts: number[], allowOutsideAbsorb = false) {
  const feasibility = checkGroupFeasibility({ graph, assignment, targets, districts, allowOutsideAbsorb });
  const t0 = performance.now();
  const result = planGroup({ graph, assignment, targets, districts, allowOutsideAbsorb, solver: borderSolver });
  const ms = performance.now() - t0;
  console.log(`\n== ${label}: status=${result.status} plans=${result.solutions.length} in ${ms.toFixed(0)} ms` +
    ` (feasible=${feasibility.feasible}, excess=${feasibility.excess}, suggest=${feasibility.suggestAdd.slice(0, 4)})`);
  if (result.message) console.log('   message:', result.message);
  for (const plan of result.solutions) {
    const check = verifyPlan({ graph, assignment, targets, districts, allowOutsideAbsorb, transfers: plan.transfers });
    const after = assignment.slice();
    for (const t of plan.transfers) for (const b of t.blocks) after[b] = t.to;
    const pops = districtPopulations(graph, after, k);
    const zeroed = districts.filter((d) => isZeroed(pops[d], targets)).length;
    const s = plan.stats;
    console.log(`   ${plan.kind}: verified=${check.ok} zeroed=${zeroed}/${districts.length} borders=${plan.borderFlows.length}` +
      ` people=${s.people} blocks=${s.blocks} precinctSplits=+${s.newPrecinctSplits}/-${s.healedPrecinctSplits}` +
      ` countySplits=+${s.newCountySplits} touched=${s.districtsTouched}`);
    if (!check.ok) console.log('     issues:', check.issues.slice(0, 5));
  }
  const failures = (result as { failures?: unknown[] }).failures;
  if (failures?.length) console.log('   failures:', JSON.stringify(failures).slice(0, 600));
}

run('whole map (26 districts)', Array.from({ length: k }, (_, i) => i + 1));

// A hand-picked group: a perturbed district plus the neighbors it took blocks from.
const adj = new Set<number>();
for (let b = 0; b < graph.n; b++) {
  if (assignment[b] !== 21) continue;
  for (let e = graph.adjOffsets[b]; e < graph.adjOffsets[b + 1]; e++) {
    const d = assignment[graph.adjTargets[e]];
    if (d && d !== 21) adj.add(d);
  }
}
const group = [21, ...[...adj].sort((a, b) => a - b)];
if (process.argv[4]) run(`group ${process.argv[4]}`, process.argv[4].split(',').map(Number));
run(`group ${group.join(',')}`, group);
run('group 21 alone (cannot balance on its own)', [21]);
run('group 21 alone, outside neighbors absorb', [21], true);
