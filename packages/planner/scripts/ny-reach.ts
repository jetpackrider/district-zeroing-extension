/**
 * How far do transfers reach? For every transfer of whole-map plans on perturbed real maps:
 * how many of its blocks are empty, how many precincts it touches (one walkthrough step each),
 * and its depth: the most block-to-block hops any moved block is from the receiving district's
 * territory as it was before the transfer. A compact bite out of a border is a few hops deep; a
 * chain of empty blocks fetching distant population is many.
 *   tsx scripts/ny-reach.ts [STATE=NY] [runs=6]
 */
import { readFile } from 'node:fs/promises';
import { computeTargets, type Assignment, type EngineGraph, type Transfer } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver } from '../../engine/src/index';
import { perturb, readAssignment } from '../../engine/scripts/cli-input';
import { planGroup, verifyPlan } from '../src/index';

const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
const state = process.argv[2] ?? 'NY';
const runs = Number(process.argv[3] ?? 6);
const bundle = await new NodeBundleSource(DATA).loadState(state);
const dataset = state === 'CA' ? 'D20FA' : 'D20F';
const graph = toEngineGraph(bundle, dataset);
const parsed = readAssignment(await readFile(`${DATA}${state}/fixtures/cd119.csv`, 'utf-8'), bundle.geoids);
const k = parsed.numDistricts;
const targets = computeTargets(graph.pop.reduce((a, b) => a + b, 0), k);
const all = Array.from({ length: k }, (_, i) => i + 1);

export function reach(g: EngineGraph, before: Assignment, t: Transfer) {
  const depth = new Map<number, number>();
  const moved = new Set<number>(t.blocks);
  let frontier: number[] = [];
  for (const b of t.blocks) {
    for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) if (before[g.adjTargets[e]] === t.to) { depth.set(b, 1); frontier.push(b); break; }
  }
  let d = 1;
  while (frontier.length) {
    const next: number[] = [];
    for (const b of frontier) for (let e = g.adjOffsets[b]; e < g.adjOffsets[b + 1]; e++) {
      const n = g.adjTargets[e];
      if (moved.has(n) && !depth.has(n)) { depth.set(n, d + 1); next.push(n); }
    }
    frontier = next; d++;
  }
  let empty = 0, maxDepth = 0;
  const precincts = new Set<number>();
  for (const b of t.blocks) { if (g.pop[b] === 0) empty++; maxDepth = Math.max(maxDepth, depth.get(b) ?? 99); precincts.add(g.precinctOf[b]); }
  return { blocks: t.blocks.length, empty, depth: maxDepth, precincts: precincts.size, people: t.people };
}

const rows: Array<ReturnType<typeof reach> & { from: number; to: number; run: number; kind: string; longReach: boolean; geoids: string[] }> = [];
const steps: number[] = [];
let success = 0;
for (let run = 0; run < runs; run++) {
  let assignment: Assignment = parsed.assignment;
  for (let d = 1; d <= k; d += 2) assignment = perturb(graph, assignment, d, 1 + (run % 3), (run + 1) * 1000 + d).assignment;
  const result = planGroup({ graph, assignment, targets, districts: all, solver: borderSolver });
  if (result.solutions.length) success++;
  console.log(`run ${run}: ${result.status}, ${result.solutions.length} plans, ${result.elapsedMs.toFixed(0)} ms`);
  if (process.env.ZD_REACH_DEBUG || !result.solutions.length) console.log(result.failures);
  for (const s of result.solutions) {
    if (!verifyPlan({ graph, assignment, targets, districts: all, transfers: s.transfers }).ok) throw new Error('Unverified plan');
    let flagged = 0;
    const working = Uint16Array.from(assignment);
    let planSteps = 0;
    for (const t of s.transfers) {
      const r = reach(graph, working, t);
      const longReach = !borderSolver.isCompactTransfer(graph, working, t);
      if (longReach) flagged++;
      rows.push({ ...r, from: t.from, to: t.to, run, kind: s.kind, longReach,
        geoids: Array.from(t.blocks, b => bundle.geoids[b]) });
      planSteps += r.precincts;
      for (const b of t.blocks) working[b] = t.to;
    }
    if (planSteps !== s.stats.steps) throw new Error(`Step count differs for ${s.id}`);
    if (!!flagged !== !!s.stats.longReach) throw new Error(`Long-reach flag differs for ${s.id}`);
    steps.push(planSteps);
  }
}
const q = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const col = (f: (r: (typeof rows)[number]) => number) => { const xs = rows.map(f); return `median ${q(xs, 0.5)}, p90 ${q(xs, 0.9)}, max ${(xs.length ? Math.max(...xs) : 0)}`; };
console.log(`${state}: ${rows.length} transfers in ${steps.length} plans over ${success}/${runs} successful runs (${dataset})`);
console.log(`walkthrough steps per plan: median ${q(steps, 0.5)}, p90 ${q(steps, 0.9)}, max ${(steps.length ? Math.max(...steps) : 0)}`);
console.log(`blocks per transfer:        ${col((r) => r.blocks)}`);
console.log(`empty blocks per transfer:  ${col((r) => r.empty)}`);
console.log(`precincts per transfer:     ${col((r) => r.precincts)}`);
console.log(`depth (hops from border):   ${col((r) => r.depth)}`);
console.log(`transfers deeper than 4 hops: ${rows.filter((r) => r.depth > 4).length}; more empty blocks than populated: ${rows.filter((r) => r.empty > r.blocks - r.empty).length}; touching 4+ precincts: ${rows.filter((r) => r.precincts >= 4).length}`);
const flagged = rows.filter(r => r.longReach);
console.log(`longReach: ${flagged.length} of ${rows.length} transfers (${(100 * flagged.length / Math.max(1, rows.length)).toFixed(2)}%)`);
if (rows.some(r => !r.longReach && (r.depth > 4 || r.empty > r.blocks - r.empty))) {
  throw new Error('Compact transfer exceeded the hop or empty-block limit');
}
console.log('worst by depth:');
for (const r of rows.slice().sort((a, b) => b.depth - a.depth || b.empty - a.empty).slice(0, 8)) console.log(`  run ${r.run} ${r.kind} ${r.from} -> ${r.to}: ${r.people} people, ${r.blocks} blocks (${r.empty} empty), ${r.precincts} precincts, depth ${r.depth}${r.longReach ? ' [longReach]' : ''}${process.env.ZD_REACH_DEBUG ? ` (${r.geoids.join(',')})` : ''}`);
if (success !== runs) process.exitCode = 1;
