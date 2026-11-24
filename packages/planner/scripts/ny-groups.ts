/**
 * Hand-picked groups on real New York. The enacted map is balanced, so each group is knocked
 * out of balance by moving blocks between its own members only (with the engine, so every
 * move keeps districts contiguous); the group stays feasible on its own. Then it is re-zeroed.
 *
 *   tsx scripts/ny-groups.ts
 */
import { isZeroed, type Assignment } from '@zd/contracts';
import { borderSolver } from '../../engine/src/index';
import { checkGroupFeasibility, districtAdjacency, districtPopulations, planGroup, verifyPlan } from '../src/index';
import { loadNY, twoWayBorders } from './ny-load';

import { capture, fixedAssignment } from './tuning-capture';

const ny = await loadNY();
const { graph, targets, k } = ny;
const adj = districtAdjacency(graph, ny.enacted, k);

/** Move people from `from` to `to` with the engine: some amount in [lo, hi], widened until one exists (setup only). */
function move(a: Assignment, from: number, to: number, lo: number, hi: number): Assignment {
  let t;
  for (let widen = 0; widen < 6 && !t; widen++) {
    const l = Math.max(1, lo - widen * 5), h = hi + widen * 10;
    const accept = Array.from({ length: h - l + 1 }, (_, i) => l + i);
    [t] = borderSolver.solve({ graph, assignment: a, from, to, accept, maxOptions: 1 });
  }
  if (!t) {
    // This is fixture setup. Preserve the difficult border cases even when a
    // compact perturbation is unavailable; the solve below still starts strictly.
    const min = Math.max(1, lo - 25);
    const accept = Array.from({ length: hi + 50 - min + 1 }, (_, i) => min + i);
    [t] = borderSolver.lastResort.solve({ graph, assignment: a, from, to, accept, maxOptions: 1 });
  }
  if (!t) throw new Error(`cannot move ${lo}..${hi} from ${from} to ${to}`);
  const out = a.slice();
  for (const b of t.blocks) out[b] = to;
  return out;
}

function run(label: string, districts: number[], assignment: Assignment, allowOutsideAbsorb = false) {
  const id = `groups/${label}`;
  assignment = fixedAssignment(id, assignment);
  const pops = districtPopulations(graph, assignment, k);
  const feas = checkGroupFeasibility({ graph, assignment, targets, districts, allowOutsideAbsorb });
  const t0 = performance.now();
  const res = planGroup({ graph, assignment, targets, districts, allowOutsideAbsorb, solver: borderSolver });
  const ms = performance.now() - t0;
  console.log(`\n== ${label}: districts ${districts.join(',')}  deviations ${districts.map((d) => `${d}:${pops[d] - targets.draTarget}`).join(' ')}`);
  console.log(`   feasible=${feas.feasible} excess=${feas.excess} -> status=${res.status} plans=${res.solutions.length} in ${ms.toFixed(0)} ms (repair calls ${res.repairCalls})`);
  if (res.message) console.log(`   message: ${res.message}`);
  const verified: boolean[] = [];
  for (const plan of res.solutions) {
    const check = verifyPlan({ graph, assignment, targets, districts, allowOutsideAbsorb, transfers: plan.transfers });
    const after = assignment.slice();
    for (const t of plan.transfers) for (const b of t.blocks) after[b] = t.to;
    const p2 = districtPopulations(graph, after, k);
    const zeroed = districts.filter((d) => isZeroed(p2[d], targets)).length;
    verified.push(check.ok && zeroed === districts.length);
    const outsideChanged = [];
    for (let d = 1; d <= k; d++) if (!districts.includes(d) && p2[d] !== pops[d]) outsideChanged.push(d);
    console.log(`   ${plan.kind}: verified=${check.ok} zeroed=${zeroed}/${districts.length} outsideChanged=[${outsideChanged}] transfers=${plan.transfers.length} twoWay=${twoWayBorders(plan.borderFlows)} blocks=${plan.stats.blocks}`);
    console.log(`     flows: ${plan.borderFlows.map((f) => `${f.from}→${f.to}:${f.people}`).join(', ')}`);
    if (!check.ok) console.log('     issues:', check.issues.slice(0, 4));
  }
  for (const f of res.failures) console.log(`   failed ${f.kind}: ${f.reason}${f.stuck ? ` stuck ${f.stuck.district} (${f.stuck.violation})` : ''}`);
  if (verified.some(ok => !ok) || (feas.feasible ? !verified.length : res.status !== 'group-unbalanced')) {
    throw new Error(`Group case failed verification: ${label}`);
  }
  capture(id, 'NY', assignment, res.status, ms, res.solutions, verified);
  return res;
}

// 1. A chain A - B - C where A and C do not touch: A's surplus must pass through B.
const chains: Array<[number, number, number]> = [];
for (let b = 1; b <= k; b++) for (const a of adj[b]) for (const c of adj[b]) if (a < c && !adj[a].includes(c)) chains.push([a, b, c]);
const pickChain = (pred: (x: [number, number, number]) => boolean) => chains.find(pred)!;
for (const [a, b, c] of [pickChain(([a, b, c]) => a >= 6 && c <= 16 && b >= 6 && b <= 16), pickChain(([a]) => a >= 17)]) {
  // B gives ~400 to A, C gives ~400 to B: A over, B near zero, C under.
  let x = move(ny.enacted, b, a, 380, 420);
  const moved = districtPopulations(graph, x, k)[a] - districtPopulations(graph, ny.enacted, k)[a];
  x = move(x, c, b, moved - 3, moved + 3);
  run(`chain through a middle district (${a} - ${b} - ${c}, ${a} and ${c} do not touch)`, [a, b, c], x);
  // Small version: a few people only (the hard case on city blocks).
  let y = move(ny.enacted, b, a, 1, 15);
  const m2 = districtPopulations(graph, y, k)[a] - districtPopulations(graph, ny.enacted, k)[a];
  y = move(y, c, b, Math.max(1, m2 - 2), m2 + 2);
  run(`small chain (${a} - ${b} - ${c})`, [a, b, c], y);
}

// 2. Four and five districts in New York City, several small internal moves.
for (const [label, group] of [['4 districts', [7, 8, 9, 10]], ['5 districts', [10, 11, 12, 13, 15]]] as Array<[string, number[]]>) {
  const g = group.filter((d) => d <= k);
  let x = ny.enacted;
  const pairs: Array<[number, number]> = [];
  for (const a of g) for (const b of adj[a]) if (g.includes(b) && a < b) pairs.push([a, b]);
  pairs.slice(0, 4).forEach(([a, b], i) => { x = move(x, i % 2 ? a : b, i % 2 ? b : a, [1, 20, 5, 60][i], [6, 40, 12, 90][i]); });
  run(`${label} (internal moves on ${pairs.slice(0, 4).map(([a, b]) => `${a}/${b}`).join(', ')})`, [...g], x);
}

// 3. A group that cannot balance on its own: a member takes people from outside.
{
  const g = [7, 8, 9, 10];
  const outside = adj[8].find((d) => !g.includes(d))!;
  const x = move(ny.enacted, outside, 8, 200, 260);
  const res = run(`cannot balance on its own (8 took people from ${outside})`, g, x);
  if (res.solutions.length) throw new Error('unbalanced group was solved');
}

// 4. Single-district fallback: one district, outside neighbors absorb, tiny amount.
{
  const x = move(ny.enacted, 14, 15, 1, 8);
  run('one district (15), neighbors absorb', [15], x, true);
}
