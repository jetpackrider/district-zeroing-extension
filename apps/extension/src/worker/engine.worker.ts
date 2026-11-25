/// <reference lib="webworker" />
/**
 * Engine Worker, created by the panel page (MV3 service workers can't own Workers).
 * Holds the EngineGraph; every request carries the current assignment.
 */
import type { EngineGraph } from '@zd/contracts';
import { borderSolver, leansOnWater } from '../adapters/engine';
import { countyClusters, CurveCache, groupFeasibility, interactionGraph, planGroup } from '../adapters/planner';
import { applyArea } from './area';
import { dropLocked, dropUnassigned } from './choice';
import { solveOneDistrict } from './district';
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
    if (__ZD_TEST__ && (req.type === 'solve-district' || req.type === 'solve-group' || req.type === 'clusters') && req.testDelayMs) {
      const end = performance.now() + req.testDelayMs;
      while (performance.now() < end) {
        /* busy, like a long solve: the worker can't take messages until it's done or terminated */
      }
    }
    switch (req.type) {
      case 'solve-district': {
        post(solveOneDistrict(graph, req, curveCache));
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
          ...(req.area ? { area: req.area } : {}),
          solver: borderSolver,
          locked: req.locked,
          onProgress: (done, total) => post({ type: 'progress', id: req.id, done, total }),
        }, curveCache);
        // The panel leaves locked districts out of `districts` and `absorbers`; this only guards
        // against a plan touching one anyway.
        if (req.lockedDistricts?.length) result.solutions = dropLocked(result.solutions, req.lockedDistricts);
        // Likewise district 0 without permission.
        if (!unassignedAllowed) result.solutions = dropUnassigned(result.solutions).kept;
        // And the area's rules (see applyArea).
        const inArea = applyArea(result.solutions, req.area);
        result.solutions = inArea.kept;
        for (const s of result.solutions) if (leansOnWater(graph, req.assignment, s.transfers)) s.stats = { ...s.stats, usesWater: true };
        post({ type: 'group-result', id: req.id, result, ...(inArea.dropped ? { areaDropped: inArea.dropped } : {}) });
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
      case 'clusters': {
        // Whole counties only: the assignment plays no part. Cancel = the panel restarts the worker.
        const result = countyClusters({
          graph,
          numDistricts: req.numDistricts,
          tolerance: req.tolerance,
          ...(req.maxResults !== undefined ? { maxResults: req.maxResults } : {}),
          ...(req.timeLimitMs !== undefined ? { timeLimitMs: req.timeLimitMs } : {}),
          ...(req.singletons?.length ? { singletons: req.singletons } : {}),
        });
        post({ type: 'clusters-result', id: req.id, result });
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) });
  }
};
