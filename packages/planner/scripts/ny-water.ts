/**
 * How much do plans lean on water contiguity? Runs whole-map plans on perturbed real maps twice,
 * once with the engine blind to water (as it was) and once land-first, and counts the transfers
 * that only hold together across water.
 *   tsx scripts/ny-water.ts [STATE=NY] [runs=6]
 */
import { readFile } from 'node:fs/promises';
import { computeTargets, type Assignment, type EngineGraph, type Solution } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver, isLandContiguous, landView, solveDistrict } from '../../engine/src/index';
import { meetOnLand } from '../../engine/src/land';
import { perturb, readAssignment } from '../../engine/scripts/cli-input';
import { districtPopulations, planGroup, verifyPlan } from '../src/index';

import { capture, fixedAssignment } from './tuning-capture';
import { verifySolution } from '../../engine/src/verify';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const state = process.argv[2] ?? 'NY';
const runs = Number(process.argv[3] ?? 6);
const bundle = await new NodeBundleSource(DATA).loadState(state);
const withWater = toEngineGraph(bundle, 'D20F');
const blind: EngineGraph = { ...withWater, water: undefined };
const land = landView(withWater)!;
const parsed = readAssignment(await readFile(`${DATA}${state}/fixtures/cd119.csv`, 'utf-8'), bundle.geoids);
const k = parsed.numDistricts;
const targets = computeTargets(bundle.pop.D20F.reduce((a, b) => a + b, 0), k);
const all = Array.from({ length: k }, (_, i) => i + 1);

let mode = '';
function waterTransfers(assignment: Assignment, s: Solution) {
  const working = Uint16Array.from(assignment);
  let water = 0;
  for (const t of s.transfers) {
    if (!isLandContiguous(land, working, [t])) {
      water++;
      if (process.env.ZD_WATER_DEBUG) console.log(`  ${mode} water transfer ${t.from} -> ${t.to}: ${t.people} people, ${t.blocks.length} blocks, districts meet on land: ${meetOnLand(land, working, t.from, t.to)}`);
    }
    for (const b of t.blocks) working[b] = t.to;
  }
  return water;
}

const totals = { blind: { plans: 0, transfers: 0, water: 0, ms: 0, failed: 0 }, landFirst: { plans: 0, transfers: 0, water: 0, ms: 0, failed: 0 } };
const one = { blind: { options: 0, water: 0, none: 0 }, landFirst: { options: 0, water: 0, none: 0 } };
for (let run = 0; run < runs; run++) {
  let assignment: Assignment = parsed.assignment;
  for (let d = 1; d <= k; d += 2) assignment = perturb(withWater, assignment, d, 1 + (run % 3), (run + 1) * 1000 + d).assignment;
  assignment = fixedAssignment(`water/${state}/${run}/landFirst/whole`, assignment);
  for (const [name, graph] of [['blind', blind], ['landFirst', withWater]] as const) {
    mode = `${name} plan`;
    const t0 = performance.now();
    const result = planGroup({ graph, assignment, targets, districts: all, solver: borderSolver });
    const ms = performance.now() - t0;
    totals[name].ms += ms;
    capture(`water/${state}/${run}/${name}/whole`, state, assignment, result.status, ms, result.solutions,
      result.solutions.map(s => verifyPlan({ graph: withWater, assignment, targets, districts: all, transfers: s.transfers }).ok));
    if (!result.solutions.length) totals[name].failed++;
    for (const s of result.solutions) {
      if (!verifyPlan({ graph: withWater, assignment, targets, districts: all, transfers: s.transfers }).ok) throw new Error(`${name} plan failed verification`);
      totals[name].plans++;
      totals[name].transfers += s.transfers.length;
      totals[name].water += waterTransfers(assignment, s);
    }
    // One-district mode on every district that is off.
    const pops = districtPopulations(graph, assignment, k);
    for (const d of all) {
      if (pops[d] === targets.q || (targets.remainder && pops[d] === targets.q + 1)) continue;
      mode = `${name} one-district`;
      const oneStart = performance.now();
      const r = solveDistrict({ graph, assignment, targets, district: d, neighborTolerance: 5000 });
      capture(`water/${state}/${run}/${name}/one/${d}`, state, assignment, r.status, performance.now() - oneStart, r.solutions,
        r.solutions.map(s => verifySolution(withWater, assignment, targets, s, { districts: [d], neighborTolerance: 5000 }).ok));
      if (!r.solutions.length) {
        one[name].none++;
        if (process.env.ZD_WATER_DEBUG) console.log(`  ${name} run ${run}, District ${d}: ${r.status}`);
      }
      for (const s of r.solutions) {
        one[name].options++;
        if (waterTransfers(assignment, s)) one[name].water++;
      }
    }
  }
}
console.log(`${state}: ${withWater.n} blocks, ${withWater.water!.reduce((a, b) => a + b, 0)} water-only, ${k} districts, ${runs} runs`);
for (const name of ['blind', 'landFirst'] as const) {
  const t = totals[name], o = one[name];
  console.log(`${name.padEnd(9)} whole map: ${t.plans} plans (${t.failed} runs with none), ${t.water} of ${t.transfers} transfers lean on water, ${(t.ms / runs).toFixed(0)} ms/run` +
    ` | one district: ${o.water} of ${o.options} options lean on water, ${o.none} districts with no option`);
}
if (totals.landFirst.failed || totals.landFirst.water || one.landFirst.water) process.exitCode = 1;
