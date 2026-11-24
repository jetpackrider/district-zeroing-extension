/**
 * One-district mode on dense borders: where the single-district solver finds nothing, does the
 * planner (a group of one whose neighbors absorb, with two-way trades) find a verified plan?
 * The enacted NY map is used unchanged; the target is shifted by a few people so every district
 * has a small deviation that no previous move can simply be reversed to fix.
 *   tsx scripts/ny-fallback.ts [shift=3]
 */
import { readFile } from 'node:fs/promises';
import { computeTargets, isZeroed } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver, solveDistrict } from '../../engine/src/index';
import { readAssignment } from '../../engine/scripts/cli-input';
import { CurveCache, districtPopulations, planGroup, verifyPlan } from '../src/index';

import { capture } from './tuning-capture';
import { verifySolution } from '../../engine/src/verify';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const shift = Number(process.argv[2] ?? 3);
const bundle = await new NodeBundleSource(DATA).loadState('NY');
const graph = toEngineGraph(bundle, 'D20F');
const { assignment, numDistricts: k } = readAssignment(await readFile(DATA + 'NY/fixtures/cd119.csv', 'utf-8'), bundle.geoids);
const total = bundle.pop.D20F.reduce((a, b) => a + b, 0);
const targets = computeTargets(total - shift * k, k);
const pops = districtPopulations(graph, assignment, k);
const cache = new CurveCache();
let direct = 0, fellBack = 0, rescued = 0, stuck = 0;
for (let d = 1; d <= k; d++) {
  const dev = pops[d] - targets.draTarget;
  const t0 = performance.now();
  const one = solveDistrict({ graph, assignment, targets, district: d, neighborTolerance: 50 });
  const ms1 = performance.now() - t0;
  const verified = one.solutions.map(s => verifySolution(graph, assignment, targets, s, {
    districts: [d], neighborTolerance: 50,
  }).ok);
  if (verified.some(ok => !ok)) throw new Error(`District ${d} received an unverified option`);
  capture(`fallback/direct/${d}`, 'NY', assignment, one.status, ms1, one.solutions, verified);
  if (one.status === 'already-zero' || one.solutions.length) { direct++; console.log(`d${d} dev ${dev}: solver ${one.status}, ${one.solutions.length} options, ${ms1.toFixed(0)} ms`); continue; }
  fellBack++;
  const t1 = performance.now();
  const plan = planGroup({ graph, assignment, targets, districts: [d], allowOutsideAbsorb: true, solver: borderSolver }, { curveCache: cache });
  const ms2 = performance.now() - t1;
  const good = plan.solutions.filter((s) => {
    const after = assignment.slice();
    for (const t of s.transfers) for (const b of t.blocks) after[b] = t.to;
    return verifyPlan({ graph, assignment, targets, districts: [d], allowOutsideAbsorb: true, transfers: s.transfers }).ok
      && isZeroed(districtPopulations(graph, after, k)[d], targets);
  });
  if (good.length !== plan.solutions.length) throw new Error(`District ${d} received an unverified plan`);
  capture(`fallback/planner/${d}`, 'NY', assignment, plan.status, ms2, plan.solutions, plan.solutions.map(s => good.includes(s)));
  if (good.length) rescued++; else stuck++;
  console.log(`d${d} dev ${dev}: solver ${one.status} (0 options, ${ms1.toFixed(0)} ms) -> planner ${plan.status}, ${good.length}/${plan.solutions.length} verified, ${ms2.toFixed(0)} ms` +
    (good[0] ? `  e.g. ${good[0].borderFlows.map((f) => `${f.from}>${f.to}:${f.people}`).join(' ')}` : `  ${plan.message ?? ''}`));
}
console.log(`\nsolved directly: ${direct}; needed the planner: ${fellBack}; rescued by the planner: ${rescued}; still stuck: ${stuck}`);
if (stuck) process.exitCode = 1;
