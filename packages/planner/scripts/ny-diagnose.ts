/** Which of a failed plan's border transfers can the engine not deliver on its own? tsx scripts/ny-diagnose.ts [perDistrict=1] [seed=2] */
import { readFile } from 'node:fs/promises';
import { computeTargets, type Assignment } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver } from '../../engine/src/index';
import { perturb, readAssignment } from '../../engine/scripts/cli-input';
import { planGroup } from '../src/index';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const perDistrict = Number(process.argv[2] ?? 1);
const seed = Number(process.argv[3] ?? 2);
const bundle = await new NodeBundleSource(DATA).loadState('NY');
const graph = toEngineGraph(bundle, 'D20F');
const parsed = readAssignment(await readFile(DATA + 'NY/fixtures/cd119.csv', 'utf-8'), bundle.geoids);
const k = parsed.numDistricts;
const targets = computeTargets(bundle.pop.D20F.reduce((a, b) => a + b, 0), k);
let assignment: Assignment = parsed.assignment;
for (let d = 1; d <= k; d += 2) assignment = perturb(graph, assignment, d, perDistrict, seed * 1000 + d).assignment;

const result = planGroup({ graph, assignment, targets, districts: Array.from({ length: k }, (_, i) => i + 1), solver: borderSolver });
console.log('status', result.status, 'plans', result.solutions.length);
const failures = (result as unknown as { failures: Array<{ kind: string; reason: string; borders: Array<{ from: number; to: number; people: number }> }> }).failures ?? [];
for (const f of failures) {
  console.log(`\n${f.kind} (${f.reason}): each border tried alone on the starting map`);
  for (const b of f.borders) {
    const curve = borderSolver.capacity({ graph, assignment, from: b.from, to: b.to });
    const t0 = performance.now();
    const hit = borderSolver.solve({ graph, assignment, from: b.from, to: b.to, accept: [b.people], maxOptions: 1 });
    const ms = performance.now() - t0;
    const near: number[] = [];
    if (!hit.length) for (let delta = 1; delta <= 6 && near.length < 4; delta++) for (const v of [b.people - delta, b.people + delta]) {
      if (v > 0 && borderSolver.solve({ graph, assignment, from: b.from, to: b.to, accept: [v], maxOptions: 1 }).length) near.push(v);
    }
    console.log(`  ${b.from} -> ${b.to}: ${String(b.people).padStart(4)}  ${hit.length ? 'ok  ' : 'FAIL'} ${ms.toFixed(0).padStart(5)} ms  capacity ${curve.tiers.map((t) => `${t.kind}:${t.people}`).join(' ')}${near.length ? `  nearest solvable: ${near.join(',')}` : ''}`);
  }
}
