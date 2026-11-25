/**
 * Adapter: @zd/planner (several districts / whole map). Used only inside the engine Worker.
 */
import type { Assignment, BorderSolver, ClusterRequest, ClusterResult, EngineGraph, GroupFeasibility, GroupSolveRequest, GroupSolveResult, InteractionGraph, PopTargets } from '@zd/contracts';
import { buildInteractionGraph, checkGroupFeasibility, CurveCache, findCountyClusters, planGroup as realPlanGroup } from '@zd/planner';

export { CurveCache };

export function planGroup(req: GroupSolveRequest, curveCache?: CurveCache): GroupSolveResult {
  return realPlanGroup(req, { curveCache });
}

export function groupFeasibility(req: { graph: EngineGraph; assignment: Assignment; targets: PopTargets; districts: number[]; allowOutsideAbsorb?: boolean; absorbers?: number[]; includeUnassigned?: boolean }): GroupFeasibility {
  return checkGroupFeasibility(req);
}

export function interactionGraph(req: { graph: EngineGraph; assignment: Assignment; targets: PopTargets; districts: number[]; solver: BorderSolver; locked?: Uint8Array; curveCache?: CurveCache }): InteractionGraph {
  return buildInteractionGraph(req);
}

/**
 * County clusters (contracts/clusters.ts), synchronous: the worker runs it. It is stopped by
 * restarting the worker (the panel's cancel), so no shouldStop is passed.
 */
export function countyClusters(req: ClusterRequest): ClusterResult {
  return findCountyClusters(req);
}
