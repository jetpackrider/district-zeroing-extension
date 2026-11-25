/// <reference lib="webworker" />
/**
 * Engine Worker, created by the panel page (MV3 service workers can't own Workers).
 * Holds the EngineGraph; every request carries the current assignment.
 */
import type { EngineGraph, Solution } from '@zd/contracts';
import { borderSolver, leansOnWater, solveDistrict } from '../adapters/engine';
import { CurveCache, groupFeasibility, interactionGraph, planGroup } from '../adapters/planner';
import { dropLocked, dropUnassigned, restrictToChoice } from './choice';
import type { WorkerRequest, WorkerResponse } from './protocol';

let graph: EngineGraph | null = null;
// Border capacity curves are the slow part of planning. The interaction view and the solve that
// follows it measure the same borders, so they share one cache (keyed by map content, never stale).
let curveCache = new CurveCache();
const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'init') {
      const t0 = performance.now();
      graph = req.graph;
      curveCache = new CurveCache();
      post({ type: 'ready', id: req.id, elapsedMs: performance.now() - t0 });
      return;
    }
    if (!graph) throw new Error('engine not initialised');
    if (__ZD_TEST__ && (req.type === 'solve-district' || req.type === 'solve-group') && req.testDelayMs) {
      const end = performance.now() + req.testDelayMs;
      while (performance.now() < end) {
        /* busy, like a long solve: the worker can't take messages until it's done or terminated */
      }
    }
    switch (req.type) {
      case 'solve-district': {
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
        let result = solveDistrict({ graph, assignment: req.assignment, targets: req.targets, district: req.district, absorbers, ...(includeUnassigned ? { includeUnassigned } : {}), neighborTolerance: req.neighborTolerance, maxOptions: req.maxOptions ?? 5 });
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
        let fallback = false;
        if (result.status !== 'already-zero' && result.status !== 'error' && result.solutions.length === 0) {
          // No one-way move hits the number (common on dense city borders). The planner can trade in
          // both directions and through other neighbors: a group of one whose neighbors absorb.
          // With a choice, only the chosen neighbors may take or give (GroupSolveRequest.absorbers).
          // Unassigned as in the one-way solve: 0 among the absorbers, or includeUnassigned.
          const planned = planGroup({ graph, assignment: req.assignment, targets: req.targets, districts: [req.district], allowOutsideAbsorb: true, absorbers, ...(includeUnassigned ? { includeUnassigned } : {}), solver: borderSolver, locked }, curveCache);
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
          const sols = restricted.kept;
          if (sols.length > 0) {
            for (const s of sols) if (leansOnWater(graph, req.assignment, s.transfers)) s.stats = { ...s.stats, usesWater: true };
            result = { status: 'ok', solutions: sols, elapsedMs: performance.now() - t0 };
            fallback = true;
          } else if (planned.message) {
            result = { ...result, message: `${result.message ?? 'No one-way move found.'} The multi-border planner found nothing either: ${planned.message}` };
          }
        }
        result = { ...result, elapsedMs: performance.now() - t0 };
        post({ type: 'district-result', id: req.id, result, fallback, ...(choiceDropped ? { choiceDropped } : {}) });
        break;
      }
      case 'solve-group': {
        // Unassigned may take or give only with "outside absorb" and the panel's permission
        // (includeUnassigned, or 0 among the absorbers); never on the whole map.
        const includeUnassigned = req.allowOutsideAbsorb && !req.absorbers && req.includeUnassigned === true;
        const unassignedAllowed = includeUnassigned || (req.allowOutsideAbsorb && (req.absorbers?.includes(0) ?? false));
        const result = planGroup({
          graph,
          assignment: req.assignment,
          targets: req.targets,
          districts: req.districts,
          allowOutsideAbsorb: req.allowOutsideAbsorb,
          absorbers: req.absorbers,
          ...(includeUnassigned ? { includeUnassigned } : {}),
          solver: borderSolver,
          locked: req.locked,
          onProgress: (done, total) => post({ type: 'progress', id: req.id, done, total }),
        }, curveCache);
        // The panel leaves locked districts out of `districts` and `absorbers`; this only guards
        // against a plan touching one anyway.
        if (req.lockedDistricts?.length) result.solutions = dropLocked(result.solutions, req.lockedDistricts);
        // Likewise district 0 without permission.
        if (!unassignedAllowed) result.solutions = dropUnassigned(result.solutions).kept;
        for (const s of result.solutions) if (leansOnWater(graph, req.assignment, s.transfers)) s.stats = { ...s.stats, usesWater: true };
        post({ type: 'group-result', id: req.id, result });
        break;
      }
      case 'interaction': {
        const t0 = performance.now();
        const includeUnassigned = req.allowOutsideAbsorb && !req.absorbers && req.includeUnassigned === true;
        const feasibility = groupFeasibility({ graph, assignment: req.assignment, targets: req.targets, districts: req.districts, allowOutsideAbsorb: req.allowOutsideAbsorb, absorbers: req.absorbers, ...(includeUnassigned ? { includeUnassigned } : {}) });
        // The capacity pass is the slow part; skip it for very large selections until asked to solve.
        const interaction = req.districts.length <= 60 ? interactionGraph({ graph, assignment: req.assignment, targets: req.targets, districts: req.districts, solver: borderSolver, curveCache }) : null;
        post({ type: 'interaction-result', id: req.id, feasibility, interaction, elapsedMs: performance.now() - t0 });
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) });
  }
};
