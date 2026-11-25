/**
 * Unassigned (district 0) as a trading partner on a map still being drawn: the neighbor choice, the
 * one-district request, the worker's guards, and erase steps in the walkthrough.
 */
import { describe, expect, it } from 'vitest';
import type { Solution, WalkthroughState } from '@zd/contracts';
import { dropLocked, dropUnassigned, oneDistrictTrade, restrictToChoice, sanitizeScope, solveDistrictMessage, withoutLocked } from '../../src/worker/choice';
import { districtPops, unassignedOf } from '../../src/panel/assignment';
import { buildSteps, isEraseStep, tickWalkthrough, type StepContext, type WalkPlan } from '../../src/panel/walkthrough';

const sol = (id: string, flows: Array<[number, number]>) => ({
  id,
  transfers: flows.map(([from, to]) => ({ from, to, blocks: new Uint32Array([1]), people: 5 })),
  borderFlows: flows.map(([from, to]) => ({ from, to, people: 5 })),
});
const name = (d: number) => `District ${d}`;
/** Deviations per district; asking for district 0's throws (Unassigned has none). */
const devs = (m: Record<number, number>) => (d: number) => {
  if (d === 0) throw new Error('asked for a deviation of Unassigned');
  return m[d] ?? 0;
};

describe('neighbor choice with Unassigned', () => {
  it('restrictToChoice treats a chosen 0 like any chosen neighbor, and an unchosen 0 as outside', () => {
    const sols = [sol('a', [[1, 0]]), sol('b', [[1, 2]]), sol('c', [[1, 0], [1, 2]]), sol('d', [[1, 3]])];
    const onlyU = restrictToChoice(sols, 1, [0]);
    expect(onlyU.kept.map((s) => s.id)).toEqual(['a']);
    expect(onlyU.outside).toEqual([2, 3]);
    expect(restrictToChoice(sols, 1, [0, 2]).kept.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const no0 = restrictToChoice(sols, 1, [2]);
    expect(no0.kept.map((s) => s.id)).toEqual(['b']);
    expect(no0.outside).toEqual([0, 3]);
  });

  it('dropUnassigned removes any solution that touches district 0', () => {
    const r = dropUnassigned([sol('a', [[1, 0]]), sol('b', [[1, 2]]), sol('c', [[0, 1]])]);
    expect(r.kept.map((s) => s.id)).toEqual(['b']);
    expect(r.dropped).toBe(2);
  });

  it('0 is never locked: dropLocked and withoutLocked ignore it', () => {
    const sols = [sol('a', [[1, 0]]), sol('b', [[1, 2]])];
    expect(dropLocked(sols, [0]).map((s) => s.id)).toEqual(['a', 'b']);
    expect(dropLocked(sols, [0, 2]).map((s) => s.id)).toEqual(['a']);
    expect(withoutLocked({ mode: 'one', district: 1, with: [0, 2] }, [2])).toEqual({ mode: 'one', district: 1, with: [0] });
    expect(withoutLocked({ mode: 'one', district: 1, with: [0] }, [0])).toEqual({ mode: 'one', district: 1, with: [0] });
  });

  it('sanitizeScope keeps 0 while the district touches unassigned blocks, and never puts 0 in a group', () => {
    const nbrs = (d: number) => (d === 1 ? [0, 2] : d === 3 ? [2] : undefined);
    expect(sanitizeScope({ mode: 'one', district: 1, with: [2, 0, 0] }, nbrs)).toEqual({ mode: 'one', district: 1, with: [0, 2] });
    expect(sanitizeScope({ mode: 'one', district: 3, with: [0] }, nbrs)).toEqual({ mode: 'one', district: 3 });
    expect(sanitizeScope({ mode: 'one', district: 1, with: [-1] }, nbrs)).toEqual({ mode: 'one', district: 1 });
    expect(sanitizeScope({ mode: 'group', districts: [0, 1, 2], allowOutsideAbsorb: true }, nbrs)).toEqual({ mode: 'group', districts: [1, 2], allowOutsideAbsorb: true });
    const g = { mode: 'group' as const, districts: [1, 2], allowOutsideAbsorb: false };
    expect(sanitizeScope(g, nbrs)).toBe(g);
  });

  it('solveDistrictMessage names district 0 "Unassigned"', () => {
    const none = solveDistrictMessage({ district: 1, chosen: [0], shown: 0, status: 'needs-precinct-rework', fallback: false, name });
    expect(none).toBe('No way to zero District 1 trading only with Unassigned was found. Pick more neighbors, or choose "Any neighbor".');
    const dropped = solveDistrictMessage({ district: 1, chosen: [2], shown: 1, status: 'ok', fallback: false, dropped: { plans: 1, outside: [0], fallback: false }, name });
    expect(dropped).toBe('1 other option also traded with Unassigned, which you did not pick, so it is not shown.');
    const twoWay = solveDistrictMessage({ district: 1, chosen: [0], shown: 2, status: 'ok', fallback: true, name });
    expect(twoWay).toMatch(/trade with Unassigned in both directions\. Paint the steps in order: after the first leg District 1 sits further from zero/);
  });
});

describe('one-district request (oneDistrictTrade)', () => {
  const base = { district: 1, name, lockedDistricts: [] as number[], unassignedPop: 0 };

  it("the user's case: the only real neighbor is locked, the rest of the border is unassigned and holds people", () => {
    const t = oneDistrictTrade({ ...base, neighbors: [0, 2], lockedDistricts: [2], unassignedPop: 12_000, deviationOf: devs({ 1: 583, 2: 0 }) });
    expect(t.error).toBeUndefined();
    expect(t.absorbers).toEqual([0]);
    expect(t.includeUnassigned).toBeUndefined();
    expect(t.chosen).toEqual([]);
  });

  it('"Any neighbor" includes Unassigned only while it holds people', () => {
    expect(oneDistrictTrade({ ...base, neighbors: [0, 2], unassignedPop: 50, deviationOf: devs({}) })).toEqual({ chosen: [], includeUnassigned: true });
    // A finished map (or unassigned water blocks with nobody in them): exactly the request of before.
    expect(oneDistrictTrade({ ...base, neighbors: [0, 2], unassignedPop: 0, deviationOf: devs({}) })).toEqual({ chosen: [] });
    expect(oneDistrictTrade({ ...base, neighbors: [2, 3], unassignedPop: 0, deviationOf: devs({}) })).toEqual({ chosen: [] });
    // Locks on a finished map: the open real neighbors, as before.
    expect(oneDistrictTrade({ ...base, neighbors: [2, 3], lockedDistricts: [3], deviationOf: devs({}) })).toEqual({ chosen: [], absorbers: [2] });
    // Locks while people are unassigned: Unassigned is one of the open neighbors.
    expect(oneDistrictTrade({ ...base, neighbors: [0, 2, 3], lockedDistricts: [3], unassignedPop: 9, deviationOf: devs({}) }).absorbers).toEqual([0, 2]);
  });

  it('a picked Unassigned is used even when it holds no one; its deviation is never asked for', () => {
    const only = oneDistrictTrade({ ...base, with: [0], neighbors: [0, 2], deviationOf: devs({ 1: 40 }) });
    expect(only.absorbers).toEqual([0]);
    expect(only.chosen).toEqual([0]);
    expect(only.neighborTolerance).toBe(41);
    const both = oneDistrictTrade({ ...base, with: [0, 2], neighbors: [0, 2], deviationOf: devs({ 1: 40, 2: -15 }) });
    expect(both.absorbers).toEqual([0, 2]);
    expect(both.neighborTolerance).toBe(56); // |−15| + |40| + 1: from District 2 alone
  });

  it('every real neighbor locked and Unassigned adjacent but empty: says so, and suggests picking Unassigned when the district is over', () => {
    const over = oneDistrictTrade({ ...base, neighbors: [0, 2], lockedDistricts: [2], deviationOf: devs({ 1: 583 }) });
    expect(over.error).toBe('Every district next to District 1 is locked. District 1 also touches unassigned blocks, but no one is unassigned, so "Any neighbor" leaves them out. Pick Unassigned to give blocks to it, or unlock one of its neighbors.');
    const under = oneDistrictTrade({ ...base, neighbors: [0, 2], lockedDistricts: [2], deviationOf: devs({ 1: -583 }) });
    expect(under.error).toMatch(/hold no people, so there is no one to take/);
    // No unassigned blocks at all: today's message.
    const closed = oneDistrictTrade({ ...base, neighbors: [2], lockedDistricts: [2], deviationOf: devs({ 1: 583 }) });
    expect(closed.error).toBe('Every district next to District 1 is locked, so there is nowhere for people to go. Unlock one of its neighbors.');
  });

  it('a locked or non-adjacent pick is ignored, falling back to any open neighbor', () => {
    const t = oneDistrictTrade({ ...base, with: [2], neighbors: [0, 2], lockedDistricts: [2], unassignedPop: 5, deviationOf: devs({}) });
    expect(t).toEqual({ chosen: [], absorbers: [0] });
    // Neighbors not known yet: the pick stands.
    expect(oneDistrictTrade({ ...base, with: [0], neighbors: undefined, deviationOf: devs({}) }).absorbers).toEqual([0]);
  });
});

describe('unassigned blocks (PanelState.unassigned)', () => {
  it('counts blocks and people in district 0, matching districtPops[0]', () => {
    const pop = Int32Array.from([10, 0, 7, 3]);
    const a = Uint16Array.from([1, 0, 0, 2]);
    expect(unassignedOf(pop, a)).toEqual({ blocks: 2, pop: 7 });
    expect(districtPops(pop, a, 2)[0]).toBe(7);
    // A zero-population unassigned block still counts as unassigned (the row shows, with 0 people).
    expect(unassignedOf(pop, Uint16Array.from([1, 0, 1, 2]))).toEqual({ blocks: 1, pop: 0 });
    expect(unassignedOf(pop, Uint16Array.from([1, 1, 1, 2]))).toEqual({ blocks: 0, pop: 0 });
  });
});

describe('walkthrough steps to and from Unassigned', () => {
  // precinct P0 = blocks 0,1 (district 1); precinct P1 = blocks 2,3 (unassigned).
  const geoids = ['a0', 'a1', 'b2', 'b3'];
  const ctx: StepContext = {
    geoids,
    pop: Int32Array.from([10, 12, 8, 5]),
    precinctOf: Uint32Array.from([0, 0, 1, 1]),
    precinctIds: ['P0', 'P1'],
    blocksOfPrecinct: (p) => (p === 0 ? [0, 1] : [2, 3]),
  };
  const base = Uint16Array.from([1, 1, 0, 0]);
  const solution = (transfers: Array<[number, number, number[]]>): Solution => ({
    id: 's',
    kind: 'fewest-splits',
    transfers: transfers.map(([from, to, blocks]) => ({ from, to, blocks: Uint32Array.from(blocks), people: blocks.reduce((s, b) => s + ctx.pop[b], 0) })),
    borderFlows: [],
    stats: {} as any,
    deviations: [],
  });

  it('an erase step ticks off when DRA shows its blocks unassigned; a whole unassigned precinct is a whole-precinct step', () => {
    const b = buildSteps(solution([[1, 0, [1]], [0, 1, [2, 3]]]), base, ctx);
    expect(b.steps.map((s) => `${s.from}>${s.to}:${s.precinctId}:${s.wholePrecinct}`)).toEqual(['1>0:P0:false', '0>1:P1:true']);
    expect(b.steps.map(isEraseStep)).toEqual([true, false]);
    const plan: WalkPlan = { solutionId: 's', target: new Map([[1, 0], [2, 1], [3, 1]]), stepBlocks: b.stepBlocks, baseline: base, popsBefore: new Map(), districts: [1] };
    let w: WalkthroughState = { solutionId: 's', steps: b.steps, current: 0, strayEdits: [], liveTicking: true, mapMode: 'dra' };
    w = tickWalkthrough(w, plan, Uint16Array.from([1, 0, 0, 0]), new Set(), geoids);
    expect(w.steps.map((s) => s.status)).toEqual(['done', 'active']);
    expect(w.strayEdits).toEqual([]);
    w = tickWalkthrough(w, plan, Uint16Array.from([1, 0, 1, 1]), new Set(), geoids);
    expect(w.steps.map((s) => s.status)).toEqual(['done', 'done']);
    // A block erased that the plan does not move is a stray edit, to district 0.
    const stray = tickWalkthrough(w, plan, Uint16Array.from([0, 0, 1, 1]), new Set(), geoids);
    expect(stray.strayEdits).toEqual([{ geoid: 'a0', fromDistrict: 1, toDistrict: 0 }]);
  });
});
