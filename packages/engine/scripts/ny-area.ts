/**
 * Real-data check for the area preference (AreaPreference in @zd/contracts) on one district:
 * the enacted New York map (cd119), a district knocked off zero by taking a few of its
 * neighbors' border blocks (as scripts/cli.ts does), then zeroed with no area, with a box around
 * part of its border with the neighbor that lost the most blocks, and with a box well inside the
 * district (away from every border), each in 'prefer' and 'only' mode. Every option is checked
 * with the independent verifier, and the 'only' options again with every outside block locked.
 *
 *   tsx scripts/ny-area.ts
 *
 * Block points: the bundle's points sidecar when data/NY has one, else centroids of the block
 * geometry (see scripts/area-points.ts); the script says which.
 * Needs data/NY (run the pipeline first).
 */
import { readFile } from 'node:fs/promises';
import { computeTargets, type AreaPreference, type Assignment, type SolveResult } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { solveDistrict } from '../src/index';
import { populations } from '../src/model';
import { verifySolution } from '../src/verify';
import { borderBox, boxAround, boxMask, loadBlockPoints, maskSummary, type Box } from './area-points';
import { perturb, readAssignment } from './cli-input';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const source = new NodeBundleSource(DATA);
const bundle = await source.loadState('NY');
const graph = toEngineGraph(bundle, 'D20F');
const parsed = readAssignment(await readFile(DATA + 'NY/fixtures/cd119.csv', 'utf8'), bundle.geoids);
const k = parsed.numDistricts;
const targets = computeTargets(graph.pop.reduce((sum, p) => sum + p, 0), k);
const { n, adjOffsets, adjTargets } = graph;
const t0 = performance.now();
const { points, source: pointSource } = await loadBlockPoints(source, bundle);
console.log(`NY: ${n.toLocaleString('en-US')} blocks, ${k} districts, target ${targets.draTarget}; ` +
  `block points from the ${pointSource} (${(performance.now() - t0).toFixed(0)} ms)` +
  (bundle.manifest.points ? '' : ' -- data/NY/manifest.json has no points entry yet'));

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.log(`      FAIL ${message}`);
};

/** The block of `district` furthest (in hops) from every other district. */
function deepest(assignment: Assignment, district: number): number {
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
  return queue[queue.length - 1];
}

const fmt = (box: Box) => `[${box.west.toFixed(3)}, ${box.south.toFixed(3)}, ${box.east.toFixed(3)}, ${box.north.toFixed(3)}]`;

function run(label: string, assignment: Assignment, district: number, area?: AreaPreference): SolveResult {
  const start = performance.now();
  const result = solveDistrict({ graph, assignment, targets, district, maxOptions: 6, ...(area ? { area } : {}) });
  const ms = performance.now() - start;
  let verified = 0, lockedOk = 0;
  const outside = area ? area.inside.map(v => (v ? 0 : 1)) : undefined;
  for (const solution of result.solutions) {
    const check = verifySolution(graph, assignment, targets, solution, { districts: [district], neighborTolerance: 0 });
    if (check.ok) verified++;
    else fail(`${label}: ${check.error}`);
    if (area) {
      let count = 0;
      for (const t of solution.transfers) for (const b of t.blocks) if (!area.inside[b]) count++;
      if (solution.stats.outsideArea !== count) fail(`${label}: outsideArea ${solution.stats.outsideArea}, counted ${count}`);
      if (area.mode === 'only') {
        const locked = verifySolution(graph, assignment, targets, solution, { districts: [district], locked: outside });
        if (locked.ok) lockedOk++;
        else fail(`${label}: moves a block outside the area: ${locked.error}`);
      }
    } else if (solution.stats.outsideArea !== undefined) fail(`${label}: outsideArea without an area`);
  }
  const counts = result.solutions.map(s => s.stats.outsideArea ?? 0);
  if (counts.some((c, i) => i && c < counts[i - 1])) fail(`${label}: not ordered fewest outside first`);
  console.log(`   ${label.padEnd(16)} ${result.status.padEnd(22)} ${String(result.solutions.length).padStart(2)} options` +
    ` ${ms.toFixed(0).padStart(6)} ms  verified ${verified}/${result.solutions.length}` +
    (area?.mode === 'only' ? `, outside locked ${lockedOk}/${result.solutions.length}` : '') +
    (area ? `  outsideArea [${counts.join(', ')}]` : '') +
    `  people/blocks [${result.solutions.map(s => `${s.stats.people}/${s.stats.blocks}`).join(' ')}]`);
  if (result.message) console.log(`      message: ${result.message}`);
  return result;
}

const cases: Array<{ district: number; count: number; seed: number }> = [
  { district: 3, count: 3, seed: 11 },
  { district: 10, count: 4, seed: 5 },
  { district: 12, count: 2, seed: 7 },
  { district: 21, count: 6, seed: 3 },
  { district: 24, count: 3, seed: 9 },
  { district: 17, count: 8, seed: 13 },
];
for (const { district, count, seed } of cases) {
  const { assignment, moved } = perturb(graph, parsed.assignment, district, count, seed);
  const lost = new Map<number, number>();
  for (const b of moved) lost.set(parsed.assignment[b], (lost.get(parsed.assignment[b]) ?? 0) + 1);
  const neighbor = [...lost].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const deviation = populations(graph, assignment)[district] - targets.draTarget;
  console.log(`\n== District ${district}: took ${count} border blocks (seed ${seed}), now ${deviation >= 0 ? '+' : ''}${deviation};` +
    ` most from District ${neighbor}`);
  const none = run('no area', assignment, district);
  const part = borderBox(graph, assignment, points, district, neighbor)!;
  const partMask = boxMask(points, part);
  console.log(`   box over part of the ${district} | ${neighbor} border ${fmt(part)}: ${maskSummary(graph, partMask)}`);
  const prefer = run('prefer, border', assignment, district, { inside: partMask, mode: 'prefer' });
  const only = run('only, border', assignment, district, { inside: partMask, mode: 'only' });
  if (prefer.solutions.length < Math.min(6, none.solutions.length)) fail('prefer offered fewer options than no area');
  for (const s of only.solutions) if (!prefer.solutions.some(p => p.id === s.id) && prefer.solutions.length < 6) fail('an only option is missing from prefer');
  const core = boxAround(points, deepest(assignment, district), 0.02, 0.015);
  const coreMask = boxMask(points, core);
  console.log(`   box well inside District ${district} ${fmt(core)}: ${maskSummary(graph, coreMask)}`);
  run('prefer, inland', assignment, district, { inside: coreMask, mode: 'prefer' });
  const inland = run('only, inland', assignment, district, { inside: coreMask, mode: 'only' });
  if (inland.solutions.length) console.log('      (the box reaches a border after all)');
  const all = run('whole state', assignment, district, { inside: new Uint8Array(n).fill(1), mode: 'only' });
  if (all.solutions.map(s => s.id).join() !== none.solutions.map(s => s.id).join()) fail('a whole-state area changed the options');
}

console.log(`\n${failures ? `${failures} FAILURES` : 'All options verified.'}`);
if (failures) process.exitCode = 1;
