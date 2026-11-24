/**
 * Walkthrough model (SPEC "The walkthrough" / "The walkthrough across several borders").
 * Steps are grouped by border (in realization order), then by precinct (DRA paints one shattered
 * precinct at a time). Each block ticks off as soon as the live plan shows it in its target district.
 */

import type { DeviationChange, Solution, WalkthroughState, WalkthroughStep } from '@zd/contracts';

export interface StepContext {
  geoids: string[];
  pop: Int32Array;
  precinctOf: Uint32Array;
  precinctIds: string[];
  /** Live block lists per precinct (bundle indexes), to decide whole-precinct moves. */
  blocksOfPrecinct: (precinctIndex: number) => ArrayLike<number>;
}

export interface WalkPlan {
  solutionId: string;
  /** block index -> target district, for every planned block. */
  target: Map<number, number>;
  /** block index per WalkthroughBlock, parallel to steps[s].blocks. */
  stepBlocks: number[][];
  /** Assignment when the walkthrough (or the last re-plan) started. */
  baseline: Uint16Array;
  /** DRA's district pops when the walkthrough started (for the final check). */
  popsBefore: Map<number, number>;
  /** Districts whose population the plan changes. */
  districts: number[];
}

export interface BuiltSteps {
  steps: WalkthroughStep[];
  stepBlocks: number[][];
  /**
   * Blocks that appear in more than one transfer (or in `exclude`). The planner promises none: a
   * two-way trade's return leg is made of different blocks. A plan with any is refused, because the
   * walkthrough would expect the block in two districts at once.
   */
  duplicates: number[];
}

/**
 * Steps in transfer order (the order the planner realized them; a two-way trade's legs in order),
 * then by precinct. `exclude`: blocks already owned by finished steps (re-plan from here).
 */
export function buildSteps(solution: Solution, assignment: Uint16Array, ctx: StepContext, idPrefix = '', exclude?: ReadonlySet<number>): BuiltSteps {
  const steps: WalkthroughStep[] = [];
  const stepBlocks: number[][] = [];
  const seen = new Set<number>(exclude ?? []);
  const duplicates: number[] = [];
  for (const t of solution.transfers) {
    for (const b of t.blocks) {
      if (seen.has(b)) duplicates.push(b);
      seen.add(b);
    }
  }
  // Transfers are applied in order; a later leg sees the map as the earlier legs left it.
  let working: Uint16Array | null = null;
  solution.transfers.forEach((t, ti) => {
    const now = working ?? assignment;
    const byPrecinct = new Map<number, number[]>();
    const order: number[] = [];
    for (const b of t.blocks) {
      const p = ctx.precinctOf[b];
      let list = byPrecinct.get(p);
      if (!list) {
        byPrecinct.set(p, (list = []));
        order.push(p);
      }
      list.push(b);
    }
    for (const p of order) {
      const blocks = byPrecinct.get(p)!;
      const all = ctx.blocksOfPrecinct(p);
      // Whole-precinct move: the transfer takes every block of the precinct, and the precinct is
      // entirely in the giving district now (so painting the precinct moves exactly these blocks).
      let whole = all.length > 0 && blocks.length === all.length;
      if (whole) for (let k = 0; k < all.length; k++) if (all[k] < 0 || now[all[k]] !== t.from) whole = false;
      steps.push({
        id: `${idPrefix}${solution.id}:${ti}:${ctx.precinctIds[p] ?? p}`,
        from: t.from,
        to: t.to,
        precinctId: ctx.precinctIds[p] ?? String(p),
        wholePrecinct: whole,
        blocks: blocks.map((b, i) => ({ geoid: ctx.geoids[b], number: i + 1, people: ctx.pop[b], done: false })),
        status: 'pending',
      });
      stepBlocks.push(blocks);
    }
    if (ti < solution.transfers.length - 1) {
      working ??= assignment.slice();
      for (const b of t.blocks) working[b] = t.to;
    }
  });
  return { steps, stepBlocks, duplicates };
}

/** The assignment after applying a plan's targets (CSV mode's expected result). */
export function applyTargets(base: Uint16Array, target: ReadonlyMap<number, number>): Uint16Array {
  const a = base.slice();
  for (const [b, d] of target) a[b] = d;
  return a;
}

/**
 * Re-tick every block from the live assignment and advance the current step.
 * Painting out of order is fine: whatever matches is ticked, the rest re-checked next time.
 */
export function tickWalkthrough(
  w: WalkthroughState,
  plan: WalkPlan,
  live: Uint16Array,
  pendingShatter: ReadonlySet<string>,
  geoids: string[],
): WalkthroughState {
  const steps: WalkthroughStep[] = w.steps.map((s, si) => {
    const idx = plan.stepBlocks[si];
    let allDone = true;
    const blocks = s.blocks.map((blk, k) => {
      const done = live[idx[k]] === s.to;
      if (!done) allDone = false;
      return done === blk.done ? blk : { ...blk, done };
    });
    let status: WalkthroughStep['status'] = 'pending';
    if (allDone) status = !s.wholePrecinct && pendingShatter.has(s.precinctId) ? 'awaiting-commit' : 'done';
    else status = 'pending';
    return { ...s, blocks, status };
  });
  // Current = the step the user is on. It moves on by itself only when that step has just been
  // finished (so "back" or a jump to a finished step stays put), to the next unfinished step after it
  // (wrapping to the first unfinished one).
  let current = Math.max(0, Math.min(w.current, steps.length - 1));
  const was = w.steps[current]?.status;
  if (steps.length && steps[current].status === 'done' && was !== 'done') {
    let next = steps.findIndex((s, i) => i > current && s.status !== 'done');
    if (next < 0) next = steps.findIndex((s) => s.status !== 'done');
    current = next >= 0 ? next : current;
  }
  for (let i = 0; i < steps.length; i++) if (i === current && steps[i].status === 'pending') steps[i] = { ...steps[i], status: 'active' };

  // Stray edits: blocks whose district changed since the baseline and that the plan doesn't explain.
  // A planned block counts as explained only in its target district, so the first leg of a two-way
  // trade (which pushes both districts away from zero until the return leg is painted) is never a
  // stray, and nothing here judges deviations mid-walkthrough.
  const strayEdits: WalkthroughState['strayEdits'] = [];
  for (let b = 0; b < live.length && strayEdits.length < 200; b++) {
    if (live[b] === plan.baseline[b]) continue;
    const want = plan.target.get(b);
    if (want !== undefined && live[b] === want) continue;
    strayEdits.push({ geoid: geoids[b], fromDistrict: plan.baseline[b], toDistrict: live[b] });
  }
  return { ...w, steps, current, strayEdits };
}

export function allStepsDone(w: WalkthroughState): boolean {
  return w.steps.length > 0 && w.steps.every((s) => s.status === 'done');
}

export function deviationChanges(districts: number[], before: Map<number, number>, after: Map<number, number>, draTarget: number): DeviationChange[] {
  return districts.map((d) => ({ district: d, before: (before.get(d) ?? 0) - draTarget, after: (after.get(d) ?? 0) - draTarget }));
}

/** Bounding box of GeoJSON coordinates. */
export function bboxOf(coords: unknown, box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]): [number, number, number, number] {
  if (Array.isArray(coords)) {
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [x, y] = coords as [number, number];
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    } else for (const c of coords) bboxOf(c, box);
  }
  return box;
}

/** A label point for a polygon: centroid of the largest ring's vertices (good enough for blocks). */
export function labelPoint(geometry: { type: string; coordinates: unknown }): [number, number] {
  const rings: number[][][] = geometry.type === 'Polygon' ? [(geometry.coordinates as number[][][])[0]] : (geometry.coordinates as number[][][][]).map((p) => p[0]);
  let best = rings[0];
  let bestArea = -1;
  for (const r of rings) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = r;
    }
  }
  // Polygon centroid (shoelace).
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const f = best[j][0] * best[i][1] - best[i][0] * best[j][1];
    a2 += f;
    cx += (best[j][0] + best[i][0]) * f;
    cy += (best[j][1] + best[i][1]) * f;
  }
  if (Math.abs(a2) < 1e-15) return best[0] as [number, number];
  return [cx / (3 * a2), cy / (3 * a2)];
}
