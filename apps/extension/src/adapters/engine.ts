/**
 * Adapter: @zd/engine (single border / single district). Swap the import to change implementation.
 * Used only inside the engine Worker.
 */
import type { Assignment, BorderSolver, DistrictSolveRequest, EngineGraph, SolveResult, Transfer } from '@zd/contracts';
import { borderSolver as realBorderSolver, isLandContiguous, landView, solveDistrict as realSolveDistrict } from '@zd/engine';

export const borderSolver: BorderSolver = realBorderSolver;
export function solveDistrict(req: DistrictSolveRequest): SolveResult {
  return realSolveDistrict(req);
}

/**
 * True when some transfer of a plan, applied in order, only holds together across water (see the
 * engine's land.ts). Always false when the graph has no water information.
 */
export function leansOnWater(graph: EngineGraph, assignment: Assignment, transfers: readonly Transfer[]): boolean {
  const land = landView(graph);
  if (!land) return false;
  const working = Uint16Array.from(assignment);
  for (const t of transfers) {
    if (!isLandContiguous(land, working, [t])) return true;
    for (const b of t.blocks) working[b] = t.to;
  }
  return false;
}
