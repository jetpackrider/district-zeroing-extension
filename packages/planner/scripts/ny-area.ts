/**
 * Real-data check for the area preference (AreaPreference in @zd/contracts) on groups and the
 * whole map: the enacted New York map (cd119) with a few New York City districts knocked off zero
 * (each takes some of its neighbors' border blocks, as scripts/ny-real.ts does for every odd
 * district), then planned with no area, with a box around every block that moved (so a plan
 * inside it exists), and with only the western half of that box, in 'prefer' and 'only' mode;
 * for the whole map, for the group of the knocked districts and their neighbors, and for one
 * district with absorbing neighbors (the one-district fallback). Every plan is checked with the
 * independent verifyPlan, and the 'only' plans again with every block outside the area locked.
 *
 *   tsx scripts/ny-area.ts
 *
 * Block points: the bundle's points sidecar when data/NY has one, else centroids of the block
 * geometry (see packages/engine/scripts/area-points.ts); the script says which.
 * Needs data/NY (run the pipeline first).
 */
import type { AreaPreference, Assignment, GroupSolveRequest } from '@zd/contracts';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver } from '../../engine/src/index';
import { boxMask, loadBlockPoints, maskSummary, type Box } from '../../engine/scripts/area-points';
import { perturb } from '../../engine/scripts/cli-input';
import { districtAdjacency, districtPopulations, planGroup, verifyPlan } from '../src/index';
import { loadNY } from './ny-load';

const ny = await loadNY();
const { graph, targets, k } = ny;
const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const source = new NodeBundleSource(DATA);
const bundle = await source.loadState('NY');
const t0 = performance.now();
const { points, source: pointSource } = await loadBlockPoints(source, bundle);
console.log(`NY: ${graph.n.toLocaleString('en-US')} blocks, ${k} districts; block points from the ${pointSource}` +
  ` (${(performance.now() - t0).toFixed(0)} ms)` + (bundle.manifest.points ? '' : ' -- data/NY/manifest.json has no points entry yet'));

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.log(`      FAIL ${message}`);
};

// Knock a few New York City districts off zero.
const knocked: Array<[number, number]> = [[7, 3], [9, 2], [12, 4], [14, 3]];
let assignment: Assignment = ny.enacted;
const moved: number[] = [];
for (const [d, count] of knocked) {
  const result = perturb(graph, assignment, d, count, 100 + d);
  assignment = result.assignment;
  moved.push(...result.moved);
}
const pops = districtPopulations(graph, assignment, k);
console.log(`Knocked: ${knocked.map(([d]) => `${d}: ${pops[d] - targets.draTarget >= 0 ? '+' : ''}${pops[d] - targets.draTarget}`).join(', ')};` +
  ` partners ${[...new Set(moved.map((b) => ny.enacted[b]))].sort((a, b) => a - b).map((d) => `${d}: ${pops[d] - targets.draTarget}`).join(', ')}`);

// A box around every moved block, and its western half.
const lon = (b: number) => points[2 * b] / 1e6, lat = (b: number) => points[2 * b + 1] / 1e6;
const full: Box = {
  west: Math.min(...moved.map(lon)) - 0.02, east: Math.max(...moved.map(lon)) + 0.02,
  south: Math.min(...moved.map(lat)) - 0.015, north: Math.max(...moved.map(lat)) + 0.015,
};
const half: Box = { ...full, east: (full.west + full.east) / 2 };
const fullMask = boxMask(points, full);
const halfMask = boxMask(points, half);
const fmt = (box: Box) => `[${box.west.toFixed(3)}, ${box.south.toFixed(3)}, ${box.east.toFixed(3)}, ${box.north.toFixed(3)}]`;
console.log(`Box around the moved blocks ${fmt(full)}: ${maskSummary(graph, fullMask)}; ` +
  `moved blocks inside ${moved.filter((b) => fullMask[b]).length}/${moved.length}`);
console.log(`Western half ${fmt(half)}: ${maskSummary(graph, halfMask)}; moved blocks inside ${moved.filter((b) => halfMask[b]).length}/${moved.length}`);

function run(label: string, base: Omit<GroupSolveRequest, 'solver'>, area?: AreaPreference) {
  const req: GroupSolveRequest = { ...base, solver: borderSolver, ...(area ? { area } : {}) };
  const start = performance.now();
  const res = planGroup(req);
  const ms = performance.now() - start;
  const outside = area?.inside.map((v) => (v ? 0 : 1));
  let verified = 0, lockedOk = 0;
  for (const plan of res.solutions) {
    const check = verifyPlan({ ...req, transfers: plan.transfers });
    if (check.ok) verified++;
    else fail(`${label}: ${JSON.stringify(check.issues.slice(0, 3))}`);
    if (area) {
      let count = 0;
      for (const t of plan.transfers) for (const b of t.blocks) if (!area.inside[b]) count++;
      if (plan.stats.outsideArea !== count) fail(`${label}: outsideArea ${plan.stats.outsideArea}, counted ${count}`);
      if (area.mode === 'only') {
        const locked = verifyPlan({ ...req, transfers: plan.transfers, locked: outside });
        if (locked.ok) lockedOk++;
        else fail(`${label}: a block outside the area moved`);
      }
    } else if (plan.stats.outsideArea !== undefined) fail(`${label}: outsideArea without an area`);
  }
  const counts = res.solutions.map((s) => s.stats.outsideArea ?? 0);
  if (counts.some((c, i) => i && c < counts[i - 1])) fail(`${label}: not ordered fewest outside first`);
  console.log(`   ${label.padEnd(14)} ${res.status.padEnd(22)} ${res.solutions.length} plans ${(ms / 1000).toFixed(2).padStart(6)} s` +
    `  verified ${verified}/${res.solutions.length}` + (area?.mode === 'only' ? `, outside locked ${lockedOk}/${res.solutions.length}` : '') +
    (area ? `  outsideArea [${counts.join(', ')}]` : '') +
    `  blocks [${res.solutions.map((s) => s.stats.blocks).join(', ')}]  kinds [${res.solutions.map((s) => s.kind).join(', ')}]`);
  if (res.message) console.log(`      message: ${res.message}`);
  return res;
}

function all(label: string, base: Omit<GroupSolveRequest, 'solver'>) {
  console.log(`\n== ${label}`);
  const none = run('no area', base);
  const prefer = run('prefer, box', base, { inside: fullMask, mode: 'prefer' });
  run('only, box', base, { inside: fullMask, mode: 'only' });
  run('prefer, half', base, { inside: halfMask, mode: 'prefer' });
  run('only, half', base, { inside: halfMask, mode: 'only' });
  if (none.status === 'ok' && prefer.status !== 'ok') fail('prefer found no plan where no area did');
}

const whole = Array.from({ length: k }, (_, i) => i + 1);
all('whole map', { graph, assignment, targets, districts: whole });

const adj = districtAdjacency(graph, assignment, k);
const group = [...new Set([...knocked.map(([d]) => d), ...moved.map((b) => ny.enacted[b])])].sort((a, b) => a - b);
console.log(`\n(group neighbors: ${group.map((d) => `${d}: ${adj[d].join(',')}`).join('; ')})`);
all(`group ${group.join(', ')}`, { graph, assignment, targets, districts: group });

// The one-district fallback: one knocked district, its neighbors absorb.
{
  const [d] = knocked[0];
  const one = perturb(graph, ny.enacted, d, knocked[0][1], 100 + d).assignment;
  all(`one district (${d}), neighbors absorb`, { graph, assignment: one, targets, districts: [d], allowOutsideAbsorb: true });
}

console.log(`\n${failures ? `${failures} FAILURES` : 'All plans verified.'}`);
if (failures) process.exitCode = 1;
