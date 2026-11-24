/**
 * Adapter: @zd/planner (several districts / whole map). Used only inside the engine Worker.
 */
import type { Assignment, BorderSolver, EngineGraph, GroupFeasibility, GroupSolveRequest, GroupSolveResult, InteractionGraph, PopTargets } from '@zd/contracts';
import { buildInteractionGraph, checkGroupFeasibility, CurveCache, planGroup as realPlanGroup } from '@zd/planner';

export { CurveCache };

export function planGroup(req: GroupSolveRequest, curveCache?: CurveCache): GroupSolveResult {
  return realPlanGroup(req, { curveCache });
}

export function groupFeasibility(req: { graph: EngineGraph; assignment: Assignment; targets: PopTargets; districts: number[]; allowOutsideAbsorb?: boolean; absorbers?: number[] }): GroupFeasibility {
  return checkGroupFeasibility(req);
}

export function interactionGraph(req: { graph: EngineGraph; assignment: Assignment; targets: PopTargets; districts: number[]; solver: BorderSolver; locked?: Uint8Array; curveCache?: CurveCache }): InteractionGraph {
  return buildInteractionGraph(req);
}
