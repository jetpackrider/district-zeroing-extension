/** Shared loader for the New York scripts: the enacted 119th-Congress map and a seeded imbalance. */
import { readFile } from 'node:fs/promises';
import { computeTargets, type Assignment, type EngineGraph, type PopTargets } from '@zd/contracts';
import { toEngineGraph } from '../../bundle/src/index';
import { NodeBundleSource } from '../../bundle/src/node';
import { perturb, readAssignment } from '../../engine/scripts/cli-input';

export interface NY {
  graph: EngineGraph;
  enacted: Assignment;
  targets: PopTargets;
  k: number;
}

export async function loadNY(): Promise<NY> {
  const DATA = decodeURIComponent(new URL('../../../data/', import.meta.url).pathname);
  const bundle = await new NodeBundleSource(DATA).loadState('NY');
  const graph = toEngineGraph(bundle, 'D20F');
  const parsed = readAssignment(await readFile(DATA + 'NY/fixtures/cd119.csv', 'utf-8'), bundle.geoids);
  const k = parsed.numDistricts;
  const targets = computeTargets(bundle.pop.D20F.reduce((a, b) => a + b, 0), k);
  return { graph, enacted: parsed.assignment, targets, k };
}

/** The same imbalance scripts/ny-real.ts builds: every odd district takes `perDistrict` border blocks. */
export function perturbWholeMap(ny: NY, perDistrict: number, seed: number): Assignment {
  let assignment = ny.enacted;
  for (let d = 1; d <= ny.k; d += 2) {
    const result = perturb(ny.graph, assignment, d, perDistrict, seed * 1000 + d) as unknown;
    assignment = result instanceof Uint16Array ? result : (result as { assignment: Assignment }).assignment;
  }
  return assignment;
}

/** Number of borders traded in both directions in a plan. */
export function twoWayBorders(flows: Array<{ from: number; to: number }>): number {
  const keys = new Set(flows.map((f) => `${f.from}>${f.to}`));
  let n = 0;
  for (const f of flows) if (f.from < f.to && keys.has(`${f.to}>${f.from}`)) n++;
  return n;
}
