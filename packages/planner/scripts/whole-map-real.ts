/** Run whole-map mode on a seeded perturbation of an official Census plan. */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTargets, isZeroed, type PopField } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver } from '../../engine/src/index';
import { readAssignment } from '../../engine/scripts/cli-input';
import { districtPopulations, planGroup, verifyPlan } from '../src/index';
import { perturbWholeMap } from './ny-load';

import { capture, fixedAssignment } from './tuning-capture';

const [stateArg, blocksArg = '4', seedArg = '1', fileArg, fieldArg = 'D20F'] = process.argv.slice(2);
const state = stateArg?.toUpperCase();
const blocksPerDistrict = Number(blocksArg);
const seed = Number(seedArg);
if (!state || !/^[A-Z]{2}$/.test(state) || !Number.isSafeInteger(blocksPerDistrict) || blocksPerDistrict < 1
    || !Number.isSafeInteger(seed) || (fieldArg !== 'D20F' && fieldArg !== 'D20FA')) {
  throw new Error('Usage: tsx scripts/whole-map-real.ts STATE [blocks=4] [seed=1] [fixture] [D20F|D20FA]');
}
const field: PopField = fieldArg;
const root = fileURLToPath(new URL('../../../data/', import.meta.url));
const fixture = fileArg ?? join(root, state, 'fixtures', 'cd119.csv');
const start = performance.now();
const bundle = await new NodeBundleSource(root).loadState(state);
const graph = toEngineGraph(bundle, field);
const { assignment: enacted, numDistricts: k } = readAssignment(await readFile(fixture, 'utf8'), bundle.geoids);
const targets = computeTargets(graph.pop.reduce((a, b) => a + b, 0), k);
const districts = Array.from({ length: k }, (_, i) => i + 1);
const enactedPops = districtPopulations(graph, enacted, k);
const enactedZeroed = districts.filter((d) => isZeroed(enactedPops[d], targets)).length;
const unassignedBlocks = enacted.reduce((sum, d) => sum + Number(d === 0), 0);

console.log(JSON.stringify({ stage: 'loaded', state, fixture, field, blocks: graph.n, districts: k,
  blocksPerDistrict, seed, enactedZeroed, unassignedBlocks, unassignedPopulation: enactedPops[0] }));
const id = `real/${state}/${field}/${basename(fixture)}/${blocksPerDistrict}/${seed}`;
const assignment = fixedAssignment(id, perturbWholeMap({ graph, enacted, targets, k }, blocksPerDistrict, seed));
const pops = districtPopulations(graph, assignment, k);
const maxDeviation = Math.max(...districts.map((d) => Math.abs(pops[d] - targets.draTarget)));
const planningStart = performance.now();
console.log(JSON.stringify({ stage: 'planning', maxDeviation, setupMs: Math.round(planningStart - start) }));
const result = planGroup({ graph, assignment, targets, districts, solver: borderSolver });
const planMs = Math.round(performance.now() - planningStart);
const plans = result.solutions.map((plan) => {
  const check = verifyPlan({ graph, assignment, targets, districts, transfers: plan.transfers });
  const applied = assignment.slice();
  const longReach = [];
  for (const transfer of plan.transfers) {
    if (plan.stats.longReach && !borderSolver.isCompactTransfer(graph, applied, transfer)) {
      const { from, to, people, blocks } = transfer;
      longReach.push({ from, to, people, blocks: blocks.length, empty: blocks.filter(b => graph.pop[b] === 0).length });
    }
    for (const b of transfer.blocks) applied[b] = transfer.to;
  }
  const finalPops = districtPopulations(graph, applied, k);
  const zeroed = districts.filter((d) => isZeroed(finalPops[d], targets)).length;
  return { kind: plan.kind, verified: check.ok && zeroed === k, zeroed,
    moves: plan.stats.blocks, steps: plan.stats.steps, longReach, issues: check.issues.slice(0, 8) };
});
capture(id, state, assignment, result.status, planMs, result.solutions, plans.map(p => p.verified));
const verified = plans.filter((plan) => plan.verified).length;
console.log(JSON.stringify({ stage: 'result', state, status: result.status, message: result.message,
  planMs, totalMs: Math.round(performance.now() - start), peakRSSKiB: process.resourceUsage().maxRSS,
  verified, plans, repairCalls: result.repairCalls, failures: result.failures.map((failure) => ({
    kind: failure.kind, reason: failure.reason, unmet: failure.unmet, stuck: failure.stuck,
    borders: failure.borders.slice(0, 8),
  })),
}));
process.exitCode = verified > 0 ? 0 : 1;
