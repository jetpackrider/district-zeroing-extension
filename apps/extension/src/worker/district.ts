/**
 * One district (the worker's 'solve-district'): the one-way solve, the guards that keep its result
 * within what the panel asked (Unassigned, the choice of neighbors, locks, the area), and the
 * multi-border planner when it is needed. Kept out of engine.worker.ts so it can be unit-tested
 * (tests/unit/district.test.ts) with the engine and the planner stubbed.
 */
import type { AreaPreference, EngineGraph, Solution } from '@zd/contracts';
import { borderSolver, leansOnWater, solveDistrict } from '../adapters/engine';
import { planGroup, type CurveCache } from '../adapters/planner';
import { applyArea, mergeInsideFirst } from './area';
import { dropLocked, dropUnassigned, restrictToChoice } from './choice';
import type { WorkerRequest, WorkerResponse } from './protocol';

type DistrictRequest = Extract<WorkerRequest, { type: 'solve-district' }>;
type DistrictResponse = Extract<WorkerResponse, { type: 'district-result' }>;

export function solveOneDistrict(graph: EngineGraph, req: DistrictRequest, curveCache: CurveCache): DistrictResponse {
  const t0 = performance.now();
  const locked = req.locked;
  const lockedDistricts = req.lockedDistricts ?? [];
  // Painted blocks stay put, and so does every block of a district the user locked.
  const touchesLocked = (sol: Solution) => (!!locked && sol.transfers.some((t) => t.blocks.some((b) => locked[b]))) || dropLocked([sol], lockedDistricts).length === 0;
  const absorbers = req.absorbers && req.absorbers.length ? req.absorbers : undefined;
  // Unassigned (district 0) trades only with permission: "any neighbor" with
  // includeUnassigned, or 0 among the absorbers. Otherwise it is never touched.
  const includeUnassigned = !absorbers && req.includeUnassigned === true;
  const unassignedAllowed = includeUnassigned || (absorbers?.includes(0) ?? false);
  let choiceDropped: { plans: number; outside: number[]; fallback: boolean } | undefined;
  const noteDropped = (r: { dropped: number; outside: number[] }, isFallback: boolean) => {
    if (!r.dropped) return;
    choiceDropped = { plans: (choiceDropped?.plans ?? 0) + r.dropped, outside: [...new Set([...(choiceDropped?.outside ?? []), ...r.outside])].sort((a, b) => a - b), fallback: isFallback };
  };
  // The user's area (AreaPreference): the engine and the planner take it; applyArea only makes
  // sure every result keeps its rules (outsideArea on each, nothing outside with 'only',
  // inside-first with 'prefer').
  const area = req.area;
  const withArea = area ? { area } : {};
  const goal = req.goal;
  const withGoal = goal !== undefined ? { goal } : {};
  let areaDropped = 0;
  let result = solveDistrict({ graph, assignment: req.assignment, targets: req.targets, district: req.district, absorbers, ...(includeUnassigned ? { includeUnassigned } : {}), ...withArea, ...withGoal, neighborTolerance: req.neighborTolerance, maxOptions: req.maxOptions ?? 5 });
  if (!unassignedAllowed && result.solutions.length) {
    // The engine leaves district 0 alone without permission; this only guards against it not doing so.
    const r = dropUnassigned(result.solutions);
    noteDropped({ dropped: r.dropped, outside: [0] }, false);
    if (r.dropped) result = r.kept.length ? { ...result, solutions: r.kept } : { ...result, status: 'needs-precinct-rework', solutions: [] };
  }
  if (absorbers && result.solutions.length) {
    // The engine honors `absorbers`; this only guards against it not doing so.
    const r = restrictToChoice(result.solutions, req.district, absorbers);
    noteDropped(r, false);
    if (r.dropped) result = r.kept.length ? { ...result, solutions: r.kept } : { ...result, status: 'needs-precinct-rework', solutions: [] };
  }
  if ((locked || lockedDistricts.length) && result.solutions.length) {
    const kept = result.solutions.filter((s) => !touchesLocked(s));
    result = kept.length ? { ...result, solutions: kept } : { ...result, status: 'needs-precinct-rework', solutions: [], message: locked ? 'Every option would move a block that is already painted.' : 'Every option would change a locked district.' };
  }
  if (area && result.solutions.length) {
    const r = applyArea(result.solutions, area);
    areaDropped += r.dropped;
    result = r.kept.length ? { ...result, solutions: r.kept } : { ...result, status: 'needs-precinct-rework', solutions: [] };
  }
  // The multi-border planner for this one district: a group of one whose neighbors absorb,
  // trading in both directions and through other neighbors. With a choice, only the chosen
  // neighbors may take or give (GroupSolveRequest.absorbers); Unassigned as in the one-way
  // solve (0 among the absorbers, or includeUnassigned). `lock` = blocks that may not move.
  // `a` goes to the planner; `keep` (default `a`) is the area rule the plans are held to here.
  const plansFor = (a: AreaPreference | undefined, lock: Uint8Array | undefined, keep: AreaPreference | undefined = a) => {
    const planned = planGroup({ graph: graph, assignment: req.assignment, targets: req.targets, districts: [req.district], allowOutsideAbsorb: true, absorbers, ...(includeUnassigned ? { includeUnassigned } : {}), ...(a ? { area: a } : {}), ...(goal !== undefined ? { goals: { [req.district]: goal } } : {}), solver: borderSolver, locked: lock }, curveCache);
    // Until the planner honors `absorbers`, a plan may still go through a district the user did
    // not pick: such plans are dropped here and the panel says so.
    let candidates = planned.solutions.filter((s) => !touchesLocked(s));
    if (!unassignedAllowed) {
      const r = dropUnassigned(candidates);
      noteDropped({ dropped: r.dropped, outside: [0] }, true);
      candidates = r.kept;
    }
    const restricted = restrictToChoice(candidates, req.district, absorbers);
    noteDropped(restricted, true);
    const inArea = applyArea(restricted.kept, keep);
    areaDropped += inArea.dropped;
    for (const s of inArea.kept) if (leansOnWater(graph, req.assignment, s.transfers)) s.stats = { ...s.stats, usesWater: true };
    return { planned, sols: inArea.kept };
  };
  let fallback = false;
  let insideTwoWay = false;
  const maxOptions = req.maxOptions ?? 5;
  const insideOneWay = result.solutions.filter((s) => (s.stats.outsideArea ?? 0) === 0).length;
  if (area?.mode === 'prefer' && result.solutions.length && insideOneWay < maxOptions) {
    // Prefer, and fewer one-way options stay inside the area than were asked for. Everything
    // that stays inside comes before anything that goes outside (AreaPreference), so look for
    // plans that trade in both directions inside it, to take places the outside one-way
    // options would otherwise fill: the planner with every outside block locked. It is given
    // no area: the lock already keeps it inside, and with one it would plan a second time
    // (its 'only' check of whether the area is the reason, which can only find nothing new
    // under this lock). The plans are held to 'only' here.
    const lock = locked ? locked.slice() : new Uint8Array(graph.n);
    for (let b = 0; b < graph.n; b++) if (area.inside[b] !== 1) lock[b] = 1;
    const inside = plansFor(undefined, lock, { inside: area.inside, mode: 'only' }).sols;
    const merged = mergeInsideFirst(result.solutions, inside, maxOptions);
    if (merged.added) {
      result = { ...result, status: 'ok', solutions: merged.solutions };
      insideTwoWay = true;
    }
  }
  if (result.status !== 'already-zero' && result.status !== 'error' && result.solutions.length === 0) {
    // No one-way move hits the number (common on dense city borders): the planner's plans.
    const { planned, sols } = plansFor(area, locked);
    if (sols.length > 0) {
      result = { status: 'ok', solutions: sols, elapsedMs: performance.now() - t0 };
      fallback = true;
    } else if (planned.message) {
      result = { ...result, message: `${result.message ?? 'No one-way move found.'} The multi-border planner found nothing either: ${planned.message}` };
    }
  }
  result = { ...result, elapsedMs: performance.now() - t0 };
  return { type: 'district-result', id: req.id, result, fallback, ...(choiceDropped ? { choiceDropped } : {}), ...(areaDropped ? { areaDropped } : {}), ...(insideTwoWay ? { insideTwoWay } : {}) };
}
