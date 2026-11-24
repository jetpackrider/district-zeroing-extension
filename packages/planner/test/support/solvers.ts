import type { BorderSolveRequest, BorderSolver, CapacityCurve } from '@zd/contracts';
import { ReferenceSolver } from './refSolver';

/** Counts calls on any BorderSolver. */
export class CountingSolver implements BorderSolver {
  calls = { solve: 0, capacity: 0 };
  constructor(readonly base: BorderSolver) {}
  solve(req: BorderSolveRequest) { this.calls.solve++; return this.base.solve(req); }
  solveScored(req: BorderSolveRequest) { this.calls.solve++; return this.base.solveScored(req); }
  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve { this.calls.capacity++; return this.base.capacity(req); }
}

/** ZD_SOLVER=engine runs the scenarios against packages/engine's real BorderSolver (read-only import). */
export const SOLVER_NAME = process.env.ZD_SOLVER === 'engine' ? 'engine' : 'reference';

let engine: BorderSolver | null = null;
if (SOLVER_NAME === 'engine') {
  const path = new URL('../../../engine/src/index.ts', import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ path)) as { borderSolver: BorderSolver };
  engine = mod.borderSolver;
}

export function makeSolver(): CountingSolver {
  return new CountingSolver(engine ?? new ReferenceSolver());
}
