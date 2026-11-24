import type { Assignment, BorderSolveRequest, BorderSolver, CapacityCurve, Transfer } from '@zd/contracts';

/** Amounts a border may deliver, per direction. Missing key = unrestricted; [] = nothing. */
export type Allowed = Map<string, number[]>;

export const dir = (from: number, to: number) => `${from}>${to}`;

/**
 * Wraps a solver so each listed border and direction can only deliver amounts from a fixed
 * set, the way the real engine on city blocks can move 4 or 7 people but not 1. Capacity is
 * the base solver's (it keeps overstating what can be delivered, like the real engine).
 */
export class RestrictedSolver implements BorderSolver {
  calls = { solve: 0, capacity: 0 };
  /** Every request seen, for assertions. */
  requests: BorderSolveRequest[] = [];
  constructor(readonly base: BorderSolver, readonly allowed: Allowed) {}

  private filter(req: BorderSolveRequest): BorderSolveRequest | null {
    const set = this.allowed.get(dir(req.from, req.to));
    if (!set) return req;
    const ok = new Set(set);
    const accept = req.accept.filter((x) => ok.has(x));
    return accept.length ? { ...req, accept } : null;
  }

  solve(req: BorderSolveRequest): Transfer[] {
    this.calls.solve++;
    this.requests.push(req);
    const r = this.filter(req);
    return r ? this.base.solve(r) : [];
  }

  solveScored(req: BorderSolveRequest) {
    this.calls.solve++;
    this.requests.push(req);
    const r = this.filter(req);
    return r ? this.base.solveScored(r) : [];
  }

  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve {
    this.calls.capacity++;
    return this.base.capacity(req);
  }
}

/**
 * A solver that ignores `locked` and, before its real options, offers a set of blocks that
 * already moved earlier in the plan (in `from` now, originally elsewhere) whose total is
 * acceptable: the tempting "just send the same blocks back" answer for a return trade.
 */
export class ReturnTempter implements BorderSolver {
  injected = 0;
  constructor(readonly base: BorderSolver, readonly original: Assignment) {}

  private tempt(req: BorderSolveRequest): Transfer | null {
    const moved: number[] = [];
    for (let b = 0; b < req.graph.n; b++) if (req.assignment[b] === req.from && this.original[b] !== req.from && req.graph.pop[b] > 0) moved.push(b);
    if (!moved.length) return null;
    const accept = new Set(req.accept);
    // Small subset-sum over the moved blocks (first 16).
    const list = moved.slice(0, 16);
    for (let mask = 1; mask < 1 << list.length; mask++) {
      let sum = 0;
      const blocks: number[] = [];
      for (let i = 0; i < list.length; i++) if (mask & (1 << i)) { sum += req.graph.pop[list[i]]; blocks.push(list[i]); }
      if (accept.has(sum)) return { from: req.from, to: req.to, blocks: Uint32Array.from(blocks), people: sum };
    }
    return null;
  }

  solve(req: BorderSolveRequest): Transfer[] {
    const t = this.tempt(req);
    const rest = this.base.solve({ ...req, locked: undefined });
    if (t) this.injected++;
    return t ? [t, ...rest] : rest;
  }

  solveScored(req: BorderSolveRequest) {
    return this.solve(req).map((transfer) => ({
      transfer,
      stats: { people: transfer.people, blocks: transfer.blocks.length, populatedBlocks: 0, newPrecinctSplits: 0, healedPrecinctSplits: 0, newCountySplits: 0, perimeterDeltaM: 0, districtsTouched: 2, cost: 0 },
    }));
  }

  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve {
    return this.base.capacity(req);
  }
}
