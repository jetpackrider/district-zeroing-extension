/**
 * One-district goal (-1 | 0 | +1) in choice helpers and the worker's solveOneDistrict.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DistrictSolveRequest, EngineGraph, GroupSolveRequest, Solution, SolveResult } from '@zd/contracts';
import {
  choiceTolerance,
  formatGoal,
  oneDistrictTrade,
  sanitizeScope,
  solveDistrictMessage,
  withoutLocked,
} from '../../src/worker/choice';

const engine = vi.hoisted(() => ({
  calls: [] as DistrictSolveRequest[],
  result: null as SolveResult | null,
}));
const planner = vi.hoisted(() => ({
  calls: [] as GroupSolveRequest[],
  plans: [] as Solution[],
}));

vi.mock('../../src/adapters/engine', () => ({
  borderSolver: {},
  leansOnWater: () => false,
  solveDistrict: (req: DistrictSolveRequest) => {
    engine.calls.push(req);
    return engine.result;
  },
}));
vi.mock('../../src/adapters/planner', () => ({
  planGroup: (req: GroupSolveRequest) => {
    planner.calls.push(req);
    return {
      status: 'ok',
      solutions: planner.plans,
      elapsedMs: 0,
      feasibility: { feasible: true, excess: 0, suggestAdd: [] },
      interaction: { nodes: [], edges: [] },
    };
  },
}));

const { solveOneDistrict } = await import('../../src/worker/district');

const n = 6;
const graph = { n } as unknown as EngineGraph;
const targets = { totalPop: 200, numDistricts: 2, q: 100, remainder: 0, draTarget: 100 };

function baseReq(goal?: -1 | 0 | 1) {
  return {
    type: 'solve-district' as const,
    id: 1,
    assignment: new Uint16Array(n),
    targets,
    district: 1,
    ...(goal !== undefined ? { goal } : {}),
  };
}

beforeEach(() => {
  engine.calls = [];
  engine.result = { status: 'needs-precinct-rework', solutions: [], elapsedMs: 0 };
  planner.calls = [];
  planner.plans = [];
});

describe('one-district goal in choice helpers', () => {
  it('formatGoal formats -1, 0, +1 with typographic minus', () => {
    expect(formatGoal(-1)).toBe('\u22121');
    expect(formatGoal(0)).toBe('0');
    expect(formatGoal(1)).toBe('+1');
  });

  it('sanitizeScope preserves valid goal with and without neighbor choice, and drops invalid goal', () => {
    const nbrs = (d: number) => (d === 1 ? [2, 3] : undefined);
    expect(sanitizeScope({ mode: 'one', district: 1, goal: -1 }, nbrs)).toEqual({ mode: 'one', district: 1, goal: -1 });
    expect(sanitizeScope({ mode: 'one', district: 1, with: [3, 2, 1], goal: 1 }, nbrs)).toEqual({
      mode: 'one',
      district: 1,
      with: [2, 3],
      goal: 1,
    });
    expect(sanitizeScope({ mode: 'one', district: 1, with: [4], goal: 1 }, nbrs)).toEqual({
      mode: 'one',
      district: 1,
      goal: 1,
    });
    expect(sanitizeScope({ mode: 'one', district: 1, goal: undefined }, nbrs)).toEqual({ mode: 'one', district: 1 });
    expect('goal' in sanitizeScope({ mode: 'one', district: 1, goal: undefined }, nbrs)).toBe(false);
    expect(sanitizeScope({ mode: 'one', district: 1, goal: 2 as unknown as 1 }, nbrs)).toEqual({
      mode: 'one',
      district: 1,
    });
  });

  it('withoutLocked keeps goal when stripping locked neighbors from with', () => {
    expect(withoutLocked({ mode: 'one', district: 1, with: [2, 3], goal: -1 }, [2])).toEqual({
      mode: 'one',
      district: 1,
      with: [3],
      goal: -1,
    });
    expect(withoutLocked({ mode: 'one', district: 1, with: [2], goal: 1 }, [2])).toEqual({
      mode: 'one',
      district: 1,
      goal: 1,
    });
  });

  it('choiceTolerance and oneDistrictTrade honor goal (including direction flip at deviation 0)', () => {
    // At deviation 0 aiming for +1 or -1: chosen neighbor at 0 needs tolerance >= 1.
    expect(choiceTolerance(0, [0], 1)).toBe(1);
    expect(choiceTolerance(0, [0], -1)).toBe(1);
    // At +34 aiming for +1 -> moves 33; chosen neighbor at -10 or +5 -> worst 10 + 33 = 43.
    expect(choiceTolerance(34, [-10, 5], 1)).toBe(43);
    // At +34 aiming for -1 -> moves 35; worst 10 + 35 = 45.
    expect(choiceTolerance(34, [-10, 5], -1)).toBe(45);

    const name = (d: number) => `District ${d}`;
    // All real neighbors locked, Unassigned holds 0 people:
    // At dev 0 aiming for -1, District 1 needs to GIVE 1 block (can pick Unassigned).
    const giveErr = oneDistrictTrade({
      district: 1,
      goal: -1,
      neighbors: [0, 2],
      lockedDistricts: [2],
      unassignedPop: 0,
      deviationOf: () => 0,
      name,
    });
    expect(giveErr.error).toMatch(/Pick Unassigned to give blocks to it/);

    // At dev 0 aiming for +1, District 1 needs to TAKE 1 person (cannot take from empty Unassigned).
    const takeErr = oneDistrictTrade({
      district: 1,
      goal: 1,
      neighbors: [0, 2],
      lockedDistricts: [2],
      unassignedPop: 0,
      deviationOf: () => 0,
      name,
    });
    expect(takeErr.error).toMatch(/there is no one to take/);
  });

  it('solveDistrictMessage uses goal wording when a goal is set', () => {
    const name = (d: number) => `District ${d}`;
    expect(
      solveDistrictMessage({
        district: 2,
        chosen: [1],
        goal: -1,
        shown: 0,
        status: 'needs-precinct-rework',
        fallback: false,
        message: 'Out of reach.',
        name,
      }),
    ).toBe('No way to bring District 2 to \u22121 trading only with District 1 was found. Out of reach. Pick more neighbors, or choose "Any neighbor".');

    expect(
      solveDistrictMessage({
        district: 2,
        chosen: [1],
        goal: 1,
        shown: 0,
        status: 'already-zero',
        fallback: false,
        message: 'District 2 is already at +1.',
        name,
      }),
    ).toBe('District 2 is already at +1.');
  });
});

describe('solveOneDistrict goal forwarding', () => {
  it('forwards goal to solveDistrict and goals: { [district]: goal } to the planner fallback', () => {
    solveOneDistrict(graph, baseReq(-1), {} as never);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].goal).toBe(-1);
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0].goals).toEqual({ 1: -1 });
  });

  it('omits goal and goals when goal is absent (Zero default)', () => {
    solveOneDistrict(graph, baseReq(undefined), {} as never);
    expect(engine.calls).toHaveLength(1);
    expect('goal' in engine.calls[0]).toBe(false);
    expect(planner.calls).toHaveLength(1);
    expect('goals' in planner.calls[0]).toBe(false);
  });

  it('does not invoke planner fallback when solveDistrict reports already-zero for the goal', () => {
    engine.result = { status: 'already-zero', solutions: [], elapsedMs: 0 };
    const r = solveOneDistrict(graph, baseReq(1), {} as never);
    expect(r.result.status).toBe('already-zero');
    expect(engine.calls[0].goal).toBe(1);
    expect(planner.calls).toHaveLength(0);
  });
});
