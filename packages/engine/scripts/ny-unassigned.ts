/**
 * Real-data check for trading with Unassigned (district 0, see UNASSIGNED in @zd/contracts):
 * the enacted New York map (cd119) turned into a map still being drawn, then zeroed with
 * `includeUnassigned` / `absorbers: [0]`. Every option is checked with the independent verifier.
 *
 *   tsx scripts/ny-unassigned.ts
 *
 * Two partly drawn maps:
 *  1. Upstate in progress: District 21 is erased and District 24 is cut back to a core of about a
 *     third of its people (a district still being drawn). Intact District 22 then takes unassigned
 *     blocks until it is about 583 over (the user's case: its real neighbors have no room, so only
 *     Unassigned can take people), District 25 takes some until it is about 300 over, and
 *     District 20 erases border blocks until it is about 400 under.
 *  2. A band of precincts: District 18's precincts along its border with 17 are erased until
 *     about 3,000 people are unassigned, leaving 18 under by that much; then 17 takes a few of
 *     the band's blocks and is over.
 *
 * Needs data/NY (run the pipeline first).
 */
import { readFile } from 'node:fs/promises';
import {
  computeTargets, type Assignment, type DistrictSolveRequest, type EngineGraph, type PopTargets,
  type Solution, type Transfer,
} from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver, isLandContiguous, landView, solveDistrict } from '../src/index';
import { populations } from '../src/model';
import { verifySolution } from '../src/verify';
import { readAssignment } from './cli-input';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const bundle = await new NodeBundleSource(DATA).loadState('NY');
const graph = toEngineGraph(bundle, 'D20F');
const parsed = readAssignment(await readFile(DATA + 'NY/fixtures/cd119.csv', 'utf8'), bundle.geoids);
const k = parsed.numDistricts;
const targets = computeTargets(graph.pop.reduce((sum, p) => sum + p, 0), k);
const { n, pop, adjOffsets, adjTargets } = graph;
const land = landView(graph);
console.log(`NY: ${n.toLocaleString('en-US')} blocks, ${k} districts, target ${targets.draTarget}` +
  ` (q=${targets.q}, remainder=${targets.remainder}), water=${!!graph.water}, towns=${!!graph.townOf}`);

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.log(`   FAIL ${message}`);
};

/** Hop distance from the district's boundary, inward (multi-source BFS). */
function depthInside(assignment: Assignment, district: number): Int32Array {
  const depth = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let b = 0; b < n; b++) {
    if (assignment[b] !== district) continue;
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
      if (assignment[adjTargets[e]] !== district) {
        depth[b] = 0;
        queue.push(b);
        break;
      }
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

/**
 * Erase `district` except a connected core grown by BFS from its most interior block until the
 * core holds at least `goal` people. Returns the core's population.
 */
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

/** Pieces of a district on the full graph. */
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
        if (assignment[next] === district && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
  }
  return count;
}

/**
 * Move populated blocks between `district` and Unassigned along their border, one at a time and
 * keeping the district's piece count, until at least `people` have moved: `take` pulls unassigned
 * blocks in, otherwise border blocks are erased. Returns the people moved.
 */
function shiftWithUnassigned(assignment: Assignment, district: number, people: number, take: boolean): number {
  let moved = 0;
  const start = pieces(assignment, district);
  for (let pass = 0; pass < 20 && moved < people; pass++) {
    for (let b = 0; b < n && moved < people; b++) {
      if (pop[b] <= 0 || assignment[b] !== (take ? 0 : district)) continue;
      let touches = false;
      for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
        if (assignment[adjTargets[e]] === (take ? district : 0)) touches = true;
      }
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
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
      if (assignment[adjTargets[e]] === other) touching.add(graph.precinctOf[b]);
    }
  }
  let erased = 0;
  for (const precinct of [...touching].sort((a, b) => a - b)) {
    if (erased >= people) break;
    let inPrecinct = 0;
    const blocks: number[] = [];
    for (let b = 0; b < n; b++) if (assignment[b] === district && graph.precinctOf[b] === precinct) {
      blocks.push(b);
      inPrecinct += pop[b];
    }
    if (erased + inPrecinct > people * 1.5) continue;
    for (const b of blocks) assignment[b] = 0;
    if (pieces(assignment, district) > 1) {
      for (const b of blocks) assignment[b] = district;
      continue;
    }
    erased += inPrecinct;
  }
  return erased;
}

function deviation(assignment: Assignment, district: number) {
  return populations(graph, assignment)[district] - targets.draTarget;
}

function describe(solution: Solution): string {
  const flows = solution.borderFlows.map(f => `${f.from}→${f.to}:${f.people}`).join(' ');
  const s = solution.stats;
  return `${flows} blocks=${s.blocks} steps=${s.steps} precinctSplits=+${s.newPrecinctSplits}/-${s.healedPrecinctSplits}` +
    ` countySplits=+${s.newCountySplits} townSplits=+${s.newTownSplits ?? 0} perimeter=${s.perimeterDeltaM.toFixed(0)}m` +
    `${s.usesWater ? ' usesWater' : ''}`;
}

function solveCase(label: string, assignment: Assignment, district: number, extra: Partial<DistrictSolveRequest>) {
  const request: DistrictSolveRequest = { graph, assignment, targets, district, maxOptions: 5, ...extra };
  const snapshot = assignment.slice();
  const t0 = performance.now();
  const result = solveDistrict(request);
  const ms = performance.now() - t0;
  console.log(`\n-- ${label}: District ${district} at ${deviation(assignment, district) >= 0 ? '+' : ''}` +
    `${deviation(assignment, district)}; status=${result.status}, ${result.solutions.length} options in ${ms.toFixed(0)} ms`);
  if (assignment.some((d, b) => d !== snapshot[b])) fail('the assignment was mutated');
  const permitted = extra.absorbers ? extra.absorbers.includes(0) : !!extra.includeUnassigned;
  for (const solution of result.solutions) {
    const check = verifySolution(graph, assignment, targets, solution, { districts: [district], neighborTolerance: 0 });
    const zero = solution.transfers.some(t => t.from === 0 || t.to === 0);
    console.log(`   ${check.ok ? 'verified' : 'NOT VERIFIED'} ${describe(solution)}`);
    if (!check.ok) fail(check.error);
    if (zero && !permitted) fail('touches Unassigned without permission');
    if (solution.deviations.some(change => change.district === 0)) fail('Unassigned has a deviation');
    if (land && !solution.stats.usesWater && !isLandContiguous(land, assignment, solution.transfers)) {
      fail('not land-contiguous but not marked usesWater');
    }
  }
  return result;
}

function borderCase(assignment: Assignment, from: number, to: number) {
  let t0 = performance.now();
  const curve = borderSolver.capacity({ graph, assignment, from, to });
  const capMs = performance.now() - t0;
  const total = curve.tiers.reduce((sum, tier) => sum + tier.people, 0);
  console.log(`   border ${from}→${to}: capacity ${total} (${curve.tiers.map(t => `${t.kind} ${t.people}`).join(', ') || 'none'})` +
    ` in ${capMs.toFixed(0)} ms`);
  const amounts = [...new Set([1, 10, 100, 583, 1500, total].filter(a => a > 0 && a <= total))];
  for (const amount of amounts) {
    t0 = performance.now();
    const scored = borderSolver.solveScored({ graph, assignment, from, to, accept: [amount], maxOptions: 3 });
    const ms = performance.now() - t0;
    let verified = 0;
    for (const { transfer, stats } of scored) {
      const check = verifySolution(graph, assignment, targets, borderSolution(assignment, targets, transfer, stats), { districts: [] });
      if (check.ok) verified++;
      else fail(`border ${from}→${to} ${amount}: ${check.error}`);
    }
    console.log(`     ${amount} people: ${scored.length} options (${verified} verified) in ${ms.toFixed(0)} ms`);
  }
}

function borderSolution(assignment: Assignment, targets: PopTargets, transfer: Transfer, stats: Solution['stats']): Solution {
  const pops = populations(graph, assignment);
  const { from, to, people } = transfer;
  const deviations = [];
  if (from) deviations.push({ district: from, before: pops[from] - targets.draTarget, after: pops[from] - people - targets.draTarget });
  if (to) deviations.push({ district: to, before: pops[to] - targets.draTarget, after: pops[to] + people - targets.draTarget });
  deviations.sort((a, b) => a.district - b.district);
  return { id: '', kind: 'single', transfers: [transfer], borderFlows: [{ from, to, people }], stats, deviations };
}

function unassignedSummary(assignment: Assignment) {
  let blocks = 0, people = 0;
  for (let b = 0; b < n; b++) if (!assignment[b]) {
    blocks++;
    people += pop[b];
  }
  return `${blocks.toLocaleString('en-US')} unassigned blocks holding ${people.toLocaleString('en-US')} people`;
}

// ---------------------------------------------------------------------------------------------
console.log('\n=== 1. Upstate in progress: 21 erased, 24 cut back to a core ===');
const upstate = parsed.assignment.slice();
for (let b = 0; b < n; b++) if (upstate[b] === 21) upstate[b] = 0;
keepCore(upstate, 24, Math.round(targets.draTarget / 3));
const took22 = shiftWithUnassigned(upstate, 22, 583, true);
const took25 = shiftWithUnassigned(upstate, 25, 300, true);
const gave20 = shiftWithUnassigned(upstate, 20, 400, false);
console.log(`${unassignedSummary(upstate)}; 22 took ${took22} people, 25 took ${took25}, 20 erased ${gave20}`);
for (const d of [19, 20, 22, 23, 24, 25]) {
  const neighbors = new Set<number>();
  for (let b = 0; b < n; b++) if (upstate[b] === d) {
    for (let e = adjOffsets[b]; e < adjOffsets[b + 1]; e++) {
      const other = upstate[adjTargets[e]];
      if (other !== d) neighbors.add(other);
    }
  }
  console.log(`   District ${d}: ${deviation(upstate, d)} off, ${pieces(upstate, d)} piece(s), touches ${[...neighbors].sort((a, b) => a - b).join(',')}`);
}

const without22 = solveCase('22 without permission', upstate, 22, {});
if (without22.solutions.some(s => s.transfers.some(t => t.from === 0 || t.to === 0))) fail('22 touched Unassigned');
solveCase('22, only Unassigned (its real neighbors locked): absorbers [0]', upstate, 22, { absorbers: [0] });
solveCase('22 with includeUnassigned', upstate, 22, { includeUnassigned: true });
solveCase('25 without permission', upstate, 25, {});
solveCase('25 with includeUnassigned (over, gives)', upstate, 25, { includeUnassigned: true });
solveCase('20 without permission', upstate, 20, {});
solveCase('20 with includeUnassigned (under, takes)', upstate, 20, { includeUnassigned: true });
console.log('\n   Border solves and capacity with Unassigned on either side:');
for (const [from, to] of [[22, 0], [0, 22], [25, 0], [0, 20], [20, 0]]) borderCase(upstate, from, to);

// ---------------------------------------------------------------------------------------------
console.log('\n=== 2. A band of precincts: 18 erased along its border with 17 ===');
const band = parsed.assignment.slice();
const erased = eraseBand(band, 18, 17, 3000);
console.log(`${unassignedSummary(band)} (erased ${erased} people of District 18); ` +
  `District 18 ${deviation(band, 18)}, District 17 ${deviation(band, 17)}`);
solveCase('18 without permission', band, 18, {});
solveCase('18 with includeUnassigned', band, 18, { includeUnassigned: true });
solveCase('18 with absorbers [0]', band, 18, { absorbers: [0] });
const pulled = shiftWithUnassigned(band, 17, 250, true);
console.log(`\n17 took ${pulled} people from the band: District 17 ${deviation(band, 17)}`);
solveCase('17 with includeUnassigned (over, gives back)', band, 17, { includeUnassigned: true });
for (const [from, to] of [[0, 18], [18, 0], [17, 0]]) borderCase(band, from, to);

console.log(`\n${failures ? `${failures} FAILURES` : 'All options verified.'}`);
if (failures) process.exitCode = 1;
