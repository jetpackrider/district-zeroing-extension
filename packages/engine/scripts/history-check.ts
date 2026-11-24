/**
 * The engine caches per-graph state between calls. This checks that results do not depend on
 * what was solved before: each case is solved on a fresh graph object (cold cache) and again
 * after a run of unrelated calls on other assignments, including one mutated in place.
 *   tsx scripts/history-check.ts
 */
import { readFile } from 'node:fs/promises';
import { computeTargets, type Assignment, type EngineGraph } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver, solveDistrict } from '../src/index';
import { verifySolution } from '../src/verify';
import { perturb, readAssignment } from './cli-input';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const bundle = await new NodeBundleSource(DATA).loadState('NY');
const fresh = (): EngineGraph => ({ ...toEngineGraph(bundle, 'D20F') });
const parsed = readAssignment(await readFile(DATA + 'NY/fixtures/cd119.csv', 'utf-8'), bundle.geoids);
const k = parsed.numDistricts;
const targets = computeTargets(bundle.pop.D20F.reduce((a, b) => a + b, 0), k);
const base = fresh();
const cases = [3, 7, 12, 15, 20, 26].map((d) => ({ d, assignment: perturb(base, parsed.assignment, d, 3, 100 + d).assignment as Assignment }));

const strip = (value: unknown) => JSON.stringify(value, (key, v) => (key === 'elapsedMs' ? 0 : ArrayBuffer.isView(v) ? Array.from(v as Uint32Array) : v));
const district = (graph: EngineGraph, c: (typeof cases)[number]) => strip(solveDistrict({ graph, assignment: c.assignment, targets, district: c.d }));
const border = (graph: EngineGraph, c: (typeof cases)[number], to: number) =>
  strip(borderSolver.solveScored({ graph, assignment: c.assignment, from: c.d, to, accept: [37, 38], maxOptions: 3 }));
const neighborOf = (c: (typeof cases)[number]) => {
  for (let b = 0; b < base.n; b++) if (c.assignment[b] === c.d) for (let e = base.adjOffsets[b]; e < base.adjOffsets[b + 1]; e++) {
    const other = c.assignment[base.adjTargets[e]];
    if (other && other !== c.d) return other;
  }
  return 0;
};

// Cold: a new graph object per call, so nothing is cached.
const cold = cases.map((c) => ({ district: district(fresh(), c), border: border(fresh(), c, neighborOf(c)) }));

// Warm: one graph object, with unrelated calls and an in-place mutation in between.
const warm = fresh();
const scratch = parsed.assignment.slice();
let bad = 0, checked = 0, unverified = 0;
for (let round = 0; round < 3; round++) {
  const order = round === 1 ? [...cases.keys()].reverse() : [...cases.keys()];
  for (const i of order) {
    const c = cases[i];
    // noise: capacity + solves on a different assignment, then mutate that assignment in place
    const other = cases[(i + 2) % cases.length];
    borderSolver.capacity({ graph: warm, assignment: other.assignment, from: other.d, to: neighborOf(other) });
    const moved = borderSolver.solve({ graph: warm, assignment: scratch, from: c.d, to: neighborOf(c), accept: [50 + round, 51 + round], maxOptions: 1 });
    for (const t of moved) for (const b of t.blocks) scratch[b] = t.to;
    solveDistrict({ graph: warm, assignment: scratch, targets, district: other.d });
    const d = district(warm, c), b = border(warm, c, neighborOf(c));
    checked += 2;
    if (d !== cold[i].district) { bad++; console.log(`MISMATCH solveDistrict d=${c.d} round=${round}`); }
    if (b !== cold[i].border) { bad++; console.log(`MISMATCH solveScored d=${c.d} round=${round}`); }
    for (const s of solveDistrict({ graph: warm, assignment: c.assignment, targets, district: c.d }).solutions) {
      if (!verifySolution(warm, c.assignment, targets, s).ok) unverified++;
    }
  }
}
const before = parsed.assignment.slice();
console.log(`${checked} warm results compared with cold: ${bad} mismatches, ${unverified} unverified solutions`);
console.log('input assignment untouched:', cases.every((c) => c.assignment.length === before.length) && strip(parsed.assignment) === strip(before));
console.log('options per case (cold):', cold.map((c, i) => `d${cases[i].d}:${JSON.parse(c.district).solutions.length}`).join(' '));
