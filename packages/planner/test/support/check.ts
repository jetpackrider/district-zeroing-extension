import { expect } from 'vitest';
import type { Assignment, PopTargets, Solution } from '@zd/contracts';
import type { SynthMap } from './synth';
import { piecesPerDistrict, popsOf } from './synth';

export const range = (k: number) => Array.from({ length: k }, (_, i) => i + 1);

/**
 * Test-side plan check, sharing no code with the planner or verifyPlan. Returns the final
 * assignment.
 */
export function expectGoodPlan(
  map: SynthMap,
  sol: Solution,
  districts: number[],
  opts: { allowOutside?: boolean; locked?: Uint8Array; start?: Assignment; targets?: PopTargets } = {},
): Assignment {
  const { graph } = map;
  const targets = opts.targets ?? map.targets;
  const start = opts.start ?? map.assignment;
  const k = targets.numDistricts;
  const final = start.slice();
  const moved = new Set<number>();
  let people = 0;
  for (const t of sol.transfers) {
    let sum = 0;
    for (let i = 0; i < t.blocks.length; i++) {
      const b = t.blocks[i];
      if (i > 0) expect(b).toBeGreaterThan(t.blocks[i - 1]);
      expect(moved.has(b), `block ${b} moved twice`).toBe(false);
      moved.add(b);
      expect(final[b]).toBe(t.from);
      if (opts.locked) expect(opts.locked[b], `locked block ${b} moved`).toBe(0);
      final[b] = t.to;
      sum += graph.pop[b];
    }
    expect(sum).toBe(t.people);
    people += sum;
  }
  const sel = new Set(districts);
  const before = popsOf(graph, start, k);
  const after = popsOf(graph, final, k);
  for (const d of districts) {
    const ok = after[d] === targets.q || (targets.remainder > 0 && after[d] === targets.q + 1);
    expect(ok, `District ${d} ends at ${after[d]} (q=${targets.q})`).toBe(true);
  }
  for (let b = 0; b < graph.n; b++) {
    if (final[b] === start[b]) continue;
    for (const d of [start[b], final[b]]) {
      if (!sel.has(d)) expect(opts.allowOutside, `outside District ${d} touched`).toBe(true);
    }
  }
  const pb = piecesPerDistrict(graph, start, k);
  const pa = piecesPerDistrict(graph, final, k);
  for (let d = 1; d <= k; d++) expect(pa[d], `District ${d} pieces`).toBeLessThanOrEqual(pb[d]);

  // Reported numbers agree with the transfers.
  expect(sol.stats.people).toBe(people);
  expect(sol.stats.blocks).toBe(moved.size);
  const steps = sol.transfers.reduce((sum, t) =>
    sum + new Set(Array.from(t.blocks, b => graph.precinctOf[b])).size, 0);
  expect(sol.stats.steps).toBe(steps);
  const flowSum = new Map<string, number>();
  for (const t of sol.transfers) flowSum.set(`${t.from}>${t.to}`, (flowSum.get(`${t.from}>${t.to}`) ?? 0) + t.people);
  expect(sol.borderFlows.length).toBe(flowSum.size);
  for (const f of sol.borderFlows) expect(flowSum.get(`${f.from}>${f.to}`)).toBe(f.people);
  const changed = range(k).filter((d) => before[d] !== after[d]);
  expect(sol.deviations.map((x) => x.district)).toEqual(changed);
  for (const dv of sol.deviations) {
    expect(dv.before).toBe(before[dv.district] - targets.draTarget);
    expect(dv.after).toBe(after[dv.district] - targets.draTarget);
  }
  const touched = new Set(sol.transfers.flatMap((t) => [t.from, t.to]));
  expect(sol.stats.districtsTouched).toBe(touched.size);
  return final;
}

/** JSON-friendly copy of a result for determinism checks. */
export function snapshot(x: unknown): string {
  return JSON.stringify(x, (key, v) => (key === 'elapsedMs' ? 0 : ArrayBuffer.isView(v) ? Array.from(v as Uint32Array) : v));
}
