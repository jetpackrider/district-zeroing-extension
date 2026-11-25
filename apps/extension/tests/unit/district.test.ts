/**
 * One district in the worker (src/worker/district.ts) with an area set to Prefer: when the
 * one-way options do not fill the places inside the area, the planner is asked for two-way plans
 * inside it, once, with every outside block locked and no area of its own. The engine and the
 * planner are stubbed, so these tests are about what the worker asks for and how it merges.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineGraph, GroupSolveRequest, Solution, SolveResult } from '@zd/contracts';

const engine = vi.hoisted(() => ({ result: null as SolveResult | null }));
const planner = vi.hoisted(() => ({ calls: [] as GroupSolveRequest[], plans: [] as Solution[] }));

vi.mock('../../src/adapters/engine', () => ({
  borderSolver: {},
  leansOnWater: () => false,
  solveDistrict: () => engine.result,
}));
vi.mock('../../src/adapters/planner', () => ({
  planGroup: (req: GroupSolveRequest) => {
    planner.calls.push(req);
    return { status: 'ok', solutions: planner.plans, elapsedMs: 0, feasibility: { feasible: true, excess: 0, suggestAdd: [] }, interaction: { nodes: [], edges: [] } };
  },
}));

const { solveOneDistrict } = await import('../../src/worker/district');

const n = 8;
const graph = { n } as unknown as EngineGraph;
/** Blocks 0-3 inside the area, 4-7 outside. */
const inside = Uint8Array.from([1, 1, 1, 1, 0, 0, 0, 0]);
const outsideOf = (blocks: number[]) => blocks.filter((b) => !inside[b]).length;

function sol(id: string, give: number[], take: number[] = [], kind: Solution['kind'] = 'single'): Solution {
  const transfers = [{ from: 1, to: 2, blocks: Uint32Array.from(give), people: give.length }];
  if (take.length) transfers.push({ from: 2, to: 1, blocks: Uint32Array.from(take), people: take.length });
  const blocks = give.length + take.length;
  return {
    id,
    kind,
    transfers,
    borderFlows: transfers.map((t) => ({ from: t.from, to: t.to, people: t.people })),
    stats: { people: blocks, blocks, populatedBlocks: blocks, newPrecinctSplits: 0, healedPrecinctSplits: 0, newCountySplits: 0, perimeterDeltaM: 0, districtsTouched: 2, cost: 1, outsideArea: outsideOf([...give, ...take]) },
    deviations: [],
  };
}

function request(maxOptions: number) {
  return {
    type: 'solve-district' as const,
    id: 1,
    assignment: new Uint16Array(n),
    targets: { totalPop: 0, numDistricts: 2, q: 0, remainder: 0, draTarget: 0 },
    district: 1,
    maxOptions,
    area: { inside, mode: 'prefer' as const },
  };
}

beforeEach(() => {
  planner.calls = [];
  planner.plans = [];
});

describe('one district, Prefer', () => {
  it('some one-way options inside, the rest outside: two-way plans inside take places before the outside ones', () => {
    // outsideArea 0, 2, 2, 3: the case the worker used to skip (it asked only when every option went outside).
    engine.result = { status: 'ok', solutions: [sol('in', [0]), sol('o1', [4, 5]), sol('o2', [5, 6]), sol('o3', [4, 5, 6])], elapsedMs: 0 };
    planner.plans = [sol('two-way', [1], [2], 'fewest-splits')];
    const r = solveOneDistrict(graph, request(4), {} as never);
    expect(planner.calls.length).toBe(1);
    expect(r.result.solutions.map((s) => s.id)).toEqual(['in', 'two-way', 'o1', 'o2']);
    expect(r.insideTwoWay).toBe(true);
  });

  it('asks the planner once, with every outside block locked and no area (no second "is the area why" pass)', () => {
    engine.result = { status: 'ok', solutions: [sol('o1', [4])], elapsedMs: 0 };
    const r = solveOneDistrict(graph, { ...request(5), locked: Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0]) }, {} as never);
    expect(planner.calls.length).toBe(1);
    const call = planner.calls[0];
    expect(call.area).toBeUndefined();
    // Outside blocks locked, plus the painted block 1.
    expect(Array.from(call.locked!)).toEqual([0, 1, 0, 0, 1, 1, 1, 1]);
    expect(r.result.solutions.map((s) => s.id)).toEqual(['o1']);
    expect(r.insideTwoWay).toBeUndefined();
  });

  it('every place filled inside: the planner is not asked', () => {
    engine.result = { status: 'ok', solutions: [sol('a', [0]), sol('b', [1]), sol('c', [2])], elapsedMs: 0 };
    const r = solveOneDistrict(graph, request(3), {} as never);
    expect(planner.calls.length).toBe(0);
    expect(r.result.solutions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
