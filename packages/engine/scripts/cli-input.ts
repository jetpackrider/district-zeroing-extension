import type { Assignment, EngineGraph } from '@zd/contracts';
import { seededRandom } from './random';

export function readAssignment(csv: string, geoids: readonly string[]) {
  const lines = csv.split(/\r?\n/);
  const header = lines[0]?.replace(/^\uFEFF/, '').trim();
  const separator = header === 'GEOID20,District' ? ',' : header === 'GEOID20|District' ? '|' : undefined;
  if (!separator) throw new Error('Expected a GEOID20,District or GEOID20|District header.');
  const index = new Map(geoids.map((geoid, b) => [geoid, b]));
  const byBlock = new Map<number, string>();
  const labels = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const split = line.indexOf(separator);
    const geoid = line.slice(0, split);
    const raw = line.slice(split + 1).trim();
    const label = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
    const block = index.get(geoid);
    if (split < 0 || !label || block === undefined || byBlock.has(block)) {
      throw new Error(`Invalid, unknown, or duplicate assignment on CSV line ${i + 1}.`);
    }
    byBlock.set(block, label);
    if (label !== '0') labels.add(label);
  }
  const numeric = [...labels].every(label => /^[1-9]\d*$/.test(label) && Number(label) <= 65535);
  const ordered = [...labels].sort(numeric ? (a, b) => Number(a) - Number(b) : undefined);
  const districts = new Map(ordered.map((label, i) => [label, numeric ? Number(label) : i + 1]));
  if (!districts.size || districts.size > 65535) throw new Error('Invalid district count.');
  const assignment = new Uint16Array(geoids.length);
  for (const [block, label] of byBlock) assignment[block] = districts.get(label) ?? 0;
  return { assignment, districts, numDistricts: numeric ? Number(ordered[ordered.length - 1]) : ordered.length };
}

/** Move seeded, populated border blocks into the selected district without cutting any source component. */
export function perturb(graph: EngineGraph, assignment: Assignment, district: number, count: number, seed: number) {
  const after = assignment.slice();
  const { n, pop, adjOffsets, adjTargets } = graph;
  const random = seededRandom(seed);
  const candidates: Array<{ b: number; order: number }> = [];
  for (let b = 0; b < n; b++) {
    if (!assignment[b] || assignment[b] === district || pop[b] <= 0) continue;
    for (let edge = adjOffsets[b]; edge < adjOffsets[b + 1]; edge++) {
      if (assignment[adjTargets[edge]] !== district) continue;
      candidates.push({ b, order: random() });
      break;
    }
  }
  candidates.sort((a, b) => a.order - b.order || a.b - b.b);
  const queue = new Uint32Array(n);
  const visited = new Uint32Array(n);
  let visit = 0;
  function safe(block: number) {
    const source = after[block];
    const neighbors = new Set<number>();
    for (let edge = adjOffsets[block]; edge < adjOffsets[block + 1]; edge++) {
      const next = adjTargets[edge];
      if (after[next] === source) neighbors.add(next);
    }
    if (neighbors.size <= 1) return true;
    const start = neighbors.values().next().value!;
    visited[block] = visited[start] = ++visit;
    queue[0] = start;
    neighbors.delete(start);
    let length = 1;
    for (let head = 0; head < length; head++) {
      const current = queue[head];
      for (let edge = adjOffsets[current]; edge < adjOffsets[current + 1]; edge++) {
        const next = adjTargets[edge];
        if (visited[next] === visit || after[next] !== source) continue;
        visited[next] = visit;
        if (neighbors.delete(next) && !neighbors.size) return true;
        queue[length++] = next;
      }
    }
    return false;
  }
  const moved: number[] = [];
  for (const { b } of candidates) {
    if (moved.length === count) break;
    if (!safe(b)) continue;
    after[b] = district;
    moved.push(b);
  }
  if (moved.length !== count) throw new Error(`Only ${moved.length} of ${count} contiguous perturbations were available.`);
  return { assignment: after, moved };
}
