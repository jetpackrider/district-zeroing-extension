/**
 * Real-data check for planning with Unassigned (district 0, see UNASSIGNED in @zd/contracts):
 * the enacted New York map (cd119) turned into a map still being drawn, the same two maps as
 * packages/engine/scripts/ny-unassigned.ts, then planned with planGroup:
 *  - groups of one in the shape the extension's one-district fallback sends
 *    ({ districts: [d], allowOutsideAbsorb: true, absorbers }), with 0 among the absorbers or
 *    `includeUnassigned`;
 *  - groups of several districts that touch unassigned blocks, with `includeUnassigned`;
 *  - the same requests without permission, which must never touch district 0.
 * Every plan is checked with verifyPlan (same permission) and an independent recount.
 *
 *   tsx scripts/ny-unassigned.ts
 *
 * Needs data/NY (run the pipeline first).
 */
import { isZeroed, type Assignment, type GroupSolveRequest } from '@zd/contracts';
import { borderSolver } from '../../engine/src/index';
import { checkGroupFeasibility, CurveCache, districtAdjacency, districtPopulations, planGroup, unassignedContact, verifyPlan } from '../src/index';
import { loadNY } from './ny-load';

const ny = await loadNY();
const { graph, targets, k } = ny;
const { n, pop, adjOffsets, adjTargets } = graph;
console.log(`NY: ${n.toLocaleString('en-US')} blocks, ${k} districts, target ${targets.draTarget} (q=${targets.q}, remainder=${targets.remainder})`);

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.log(`   FAIL ${message}`);
};

// ---------------------------------------------------------------------------------------------
// Map edits (the same as the engine's script, so the two reports describe the same maps).

function depthInside(assignment: Assignment, district: number): Int32Array {
  const depth = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let b = 0; b < n; b++) {
    if (assignment[b] !== district) continue;
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
      if (assignment[adjTargets[e]] !== district) { depth[b] = 0; queue.push(b); break; }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const b = queue[head];
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
      const next = adjTargets[e];
      if (assignment[next] !== district || depth[next] >= 0) continue;
      depth[next] = depth[b] + 1;
      queue.push(next);
    }
  }
  return depth;
}

/** Erase `district` except a connected core around its most interior block holding >= `goal` people. */
function keepCore(assignment: Assignment, district: number, goal: number): number {
  const depth = depthInside(assignment, district);
  let seed = -1;
  for (let b = 0; b < n; b++) if (assignment[b] === district && (seed < 0 || depth[b] > depth[seed])) seed = b;
  const core = new Uint8Array(n);
  const queue = [seed];
  core[seed] = 1;
  let people = pop[seed];
  for (let head = 0; head < queue.length && people < goal; head++) {
    const b = queue[head];
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1] && people < goal; e++) {
      const next = adjTargets[e];
      if (assignment[next] !== district || core[next]) continue;
      core[next] = 1;
      people += pop[next];
      queue.push(next);
    }
  }
  for (let b = 0; b < n; b++) if (assignment[b] === district && !core[b]) assignment[b] = 0;
  return people;
}

function pieces(assignment: Assignment, district: number): number {
  const seen = new Uint8Array(n);
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (assignment[start] !== district || seen[start]) continue;
    count++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const b = stack.pop()!;
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
        const next = adjTargets[e];
        if (assignment[next] === district && !seen[next]) { seen[next] = 1; stack.push(next); }
      }
    }
  }
  return count;
}

/** Move populated border blocks between `district` and Unassigned, keeping its piece count, until ~`people` moved. */
function shiftWithUnassigned(assignment: Assignment, district: number, people: number, take: boolean): number {
  let moved = 0;
  const start = pieces(assignment, district);
  for (let pass = 0; pass < 20 && moved < people; pass++) {
    for (let b = 0; b < n && moved < people; b++) {
      if (pop[b] <= 0 || assignment[b] !== (take ? 0 : district)) continue;
      let touches = false;
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) if (assignment[adjTargets[e]] === (take ? district : 0)) touches = true;
      if (!touches || moved + pop[b] > people * 1.2) continue;
      assignment[b] = take ? district : 0;
      if (pieces(assignment, district) > start) assignment[b] = take ? 0 : district;
      else moved += pop[b];
    }
  }
  return moved;
}

/** Erase `district`'s precincts that touch `other`, one whole precinct at a time, up to ~`people`. */
function eraseBand(assignment: Assignment, district: number, other: number, people: number): number {
  const touching = new Set<number>();
  for (let b = 0; b < n; b++) {
    if (assignment[b] !== district) continue;
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) if (assignment[adjTargets[e]] === other) touching.add(graph.precinctOf[b]);
  }
  let erased = 0;
  for (const precinct of [...touching].sort((a, b) => a - b)) {
    if (erased >= people) break;
    let inPrecinct = 0;
    const blocks: number[] = [];
    for (let b = 0; b < n; b++) if (assignment[b] === district && graph.precinctOf[b] === precinct) { blocks.push(b); inPrecinct += pop[b]; }
    if (erased + inPrecinct > people * 1.5) continue;
    for (const b of blocks) assignment[b] = 0;
    if (pieces(assignment, district) > 1) { for (const b of blocks) assignment[b] = district; continue; }
    erased += inPrecinct;
  }
  return erased;
}

// ---------------------------------------------------------------------------------------------

const cache = new CurveCache();
const timings: number[] = [];

function describeMap(assignment: Assignment, districts: number[]) {
  const pops = districtPopulations(graph, assignment, k);
  const adj = districtAdjacency(graph, assignment, k);
  const touches = unassignedContact(graph, assignment, k);
  let blocks = 0, people = 0;
  for (let b = 0; b < n; b++) if (!assignment[b]) { blocks++; people += pop[b]; }
  console.log(`${blocks.toLocaleString('en-US')} unassigned blocks holding ${people.toLocaleString('en-US')} people`);
  for (const d of districts) {
    console.log(`   District ${d}: ${pops[d] - targets.draTarget >= 0 ? '+' : ''}${pops[d] - targets.draTarget}, neighbors ${adj[d].join(',')}${touches[d] ? ' + Unassigned' : ''}`);
  }
}

/**
 * Plan one request and check every plan. `expect`: 'ok' = must find a verified plan;
 * 'no-zero' = whatever happens, district 0 must not be touched (no permission).
 */
function planCase(label: string, assignment: Assignment, extra: Omit<GroupSolveRequest, 'graph' | 'assignment' | 'targets' | 'solver'>, expect: 'ok' | 'no-zero') {
  const req: GroupSolveRequest = { graph, assignment, targets, solver: borderSolver, ...extra };
  const snapshot = assignment.slice();
  const permitted = !!req.allowOutsideAbsorb && (req.absorbers ? req.absorbers.includes(0) : req.includeUnassigned === true);
  const feasibility = checkGroupFeasibility(req);
  const t0 = performance.now();
  const res = planGroup(req, { curveCache: cache });
  const ms = performance.now() - t0;
  timings.push(ms);
  const opts = [
    req.allowOutsideAbsorb ? 'outside' : '',
    req.absorbers ? `absorbers [${req.absorbers.join(',')}]` : '',
    req.includeUnassigned ? 'includeUnassigned' : '',
  ].filter(Boolean).join(', ');
  console.log(`\n-- ${label}: [${req.districts.join(',')}]${opts ? ` (${opts})` : ''}: feasible=${feasibility.feasible} excess=${feasibility.excess}; ` +
    `${res.status}, ${res.solutions.length} plans in ${ms.toFixed(0)} ms, ${res.repairCalls} repair calls`);
  if (res.status !== 'ok') console.log(`   ${res.message}`);
  if (assignment.some((d, b) => d !== snapshot[b])) fail('the assignment was mutated');
  if (expect === 'ok' && res.solutions.length === 0) fail('no plan');
  for (const plan of res.solutions) {
    const check = verifyPlan({ ...req, transfers: plan.transfers });
    const after = assignment.slice();
    for (const t of plan.transfers) for (const b of t.blocks) after[b] = t.to;
    const p2 = districtPopulations(graph, after, k);
    const zeroed = req.districts.every((d) => isZeroed(p2[d], targets));
    const zero = plan.transfers.some((t) => t.from === 0 || t.to === 0);
    const s = plan.stats;
    console.log(`   ${check.ok && zeroed ? 'verified' : 'NOT VERIFIED'} ${plan.kind}: ${plan.borderFlows.map((f) => `${f.from}→${f.to}:${f.people}`).join(' ')}` +
      ` transfers=${plan.transfers.length} blocks=${s.blocks} steps=${s.steps} precinctSplits=+${s.newPrecinctSplits}/-${s.healedPrecinctSplits}` +
      ` countySplits=+${s.newCountySplits} perimeter=${s.perimeterDeltaM.toFixed(0)}m touched=${s.districtsTouched}${s.longReach ? ' longReach' : ''}${s.usesWater ? ' usesWater' : ''}`);
    if (!check.ok) fail(check.issues.slice(0, 3).map((i) => i.detail).join('; '));
    if (!zeroed) fail('a selected district is not zeroed');
    if (zero && !permitted) fail('touches Unassigned without permission');
    if (plan.deviations.some((d) => d.district === 0)) fail('Unassigned has a deviation');
    // Two-way trades with Unassigned are pointless; report them (not a failure).
    const into = new Set(plan.borderFlows.filter((f) => f.from === 0).map((f) => f.to));
    for (const f of plan.borderFlows) if (f.to === 0 && into.has(f.from)) console.log(`   note: two-way trade between ${f.from} and Unassigned`);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
console.log('\n=== 1. Upstate in progress: 21 erased, 24 cut back to a core ===');
const upstate = ny.enacted.slice();
for (let b = 0; b < n; b++) if (upstate[b] === 21) upstate[b] = 0;
keepCore(upstate, 24, Math.round(targets.draTarget / 3));
const took22 = shiftWithUnassigned(upstate, 22, 583, true);
const took25 = shiftWithUnassigned(upstate, 25, 300, true);
const gave20 = shiftWithUnassigned(upstate, 20, 400, false);
console.log(`22 took ${took22} people, 25 took ${took25}, 20 erased ${gave20}`);
describeMap(upstate, [19, 20, 22, 23, 24, 25, 26]);

// The user's case: a group of one whose real neighbors are locked, so only Unassigned may take.
planCase('22, only Unassigned (fallback shape)', upstate, { districts: [22], allowOutsideAbsorb: true, absorbers: [0] }, 'ok');
planCase('22, any neighbor plus Unassigned', upstate, { districts: [22], allowOutsideAbsorb: true, includeUnassigned: true }, 'ok');
planCase('22 without permission', upstate, { districts: [22], allowOutsideAbsorb: true }, 'no-zero');
planCase('20 (under), only Unassigned', upstate, { districts: [20], allowOutsideAbsorb: true, absorbers: [0] }, 'ok');
planCase('20 without permission', upstate, { districts: [20], allowOutsideAbsorb: true }, 'no-zero');
planCase('25, chosen neighbors 0 and 23 (fallback shape)', upstate, { districts: [25], allowOutsideAbsorb: true, absorbers: [0, 23] }, 'ok');
// Groups of several districts that touch Unassigned.
planCase('group 20+22+25 with includeUnassigned', upstate, { districts: [20, 22, 25], allowOutsideAbsorb: true, includeUnassigned: true }, 'ok');
planCase('group 20+22+25, outside but no permission', upstate, { districts: [20, 22, 25], allowOutsideAbsorb: true }, 'no-zero');
planCase('group 19+20+22+23+25 with includeUnassigned', upstate, { districts: [19, 20, 22, 23, 25], allowOutsideAbsorb: true, includeUnassigned: true }, 'ok');
planCase('group 19+20+22+23+25, only Unassigned outside', upstate, { districts: [19, 20, 22, 23, 25], allowOutsideAbsorb: true, absorbers: [0] }, 'ok');
// Whole map without permission: Unassigned's people are missing, so it cannot be zeroed, and 0 is never touched.
planCase('whole map, no permission', upstate, { districts: Array.from({ length: k }, (_, i) => i + 1) }, 'no-zero');

// ---------------------------------------------------------------------------------------------
console.log('\n=== 2. A band of precincts: 18 erased along its border with 17 ===');
const band = ny.enacted.slice();
const erased = eraseBand(band, 18, 17, 3000);
console.log(`erased ${erased} people of District 18`);
describeMap(band, [16, 17, 18, 19]);
planCase('18 (under), only Unassigned', band, { districts: [18], allowOutsideAbsorb: true, absorbers: [0] }, 'ok');
planCase('18 without permission', band, { districts: [18], allowOutsideAbsorb: true }, 'no-zero');
const pulled = shiftWithUnassigned(band, 17, 250, true);
console.log(`\n17 took ${pulled} people from the band`);
describeMap(band, [16, 17, 18]);
planCase('group 17+18 with includeUnassigned', band, { districts: [17, 18], allowOutsideAbsorb: true, includeUnassigned: true }, 'ok');
planCase('group 17+18, no outside', band, { districts: [17, 18] }, 'no-zero');
planCase('17, any neighbor plus Unassigned', band, { districts: [17], allowOutsideAbsorb: true, includeUnassigned: true }, 'ok');

const sorted = [...timings].sort((a, b) => a - b);
console.log(`\n${timings.length} requests; planner time median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, max ${sorted[sorted.length - 1].toFixed(0)} ms, total ${timings.reduce((s, x) => s + x, 0).toFixed(0)} ms`);
console.log(failures ? `${failures} FAILURES` : 'All plans verified.');
if (failures) process.exitCode = 1;
