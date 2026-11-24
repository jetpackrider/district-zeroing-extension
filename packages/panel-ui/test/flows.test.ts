import { describe, expect, it } from 'vitest';
import type { WalkthroughStep } from '@zd/contracts';
import {
  analyzeWalkthroughTwoWayTrades,
  buildWalkthroughOutline,
  groupBorderTrades,
} from '../src/flows';
import { makeTwoWayWalkthroughSteps } from '../src/mock/scenarios';

describe('groupBorderTrades', () => {
  it('pairs opposite directions on the same border into a single two-way trade with net', () => {
    const trades = groupBorderTrades([
      { from: 9, to: 8, people: 25 },
      { from: 4, to: 7, people: 410 },
      { from: 8, to: 9, people: 23 },
    ]);

    expect(trades).toHaveLength(2);
    expect(trades[0]).toEqual({
      kind: 'two-way',
      key: '8-9',
      a: 8,
      b: 9,
      first: { from: 9, to: 8, people: 25 },
      second: { from: 8, to: 9, people: 23 },
      netFrom: 9,
      netTo: 8,
      netPeople: 2,
    });
    expect(trades[1]).toEqual({
      kind: 'one-way',
      key: '4-7',
      a: 4,
      b: 7,
      from: 4,
      to: 7,
      people: 410,
    });
  });

  it('preserves leg order while computing the net toward the larger leg', () => {
    const trades = groupBorderTrades([
      { from: 8, to: 9, people: 23 },
      { from: 9, to: 8, people: 25 },
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      kind: 'two-way',
      first: { from: 8, to: 9, people: 23 },
      second: { from: 9, to: 8, people: 25 },
      netFrom: 9,
      netTo: 8,
      netPeople: 2,
    });
  });
});

describe('analyzeWalkthroughTwoWayTrades & buildWalkthroughOutline', () => {
  it('derives two-way legs and between-legs state purely from steps', () => {
    const steps = makeTwoWayWalkthroughSteps();
    const initial = analyzeWalkthroughTwoWayTrades(steps);
    const trade0 = initial.get('8-9')!;
    expect(trade0).toBeDefined();
    expect(trade0.leg1).toMatchObject({ from: 9, to: 8, people: 25, done: false, started: false });
    expect(trade0.leg2).toMatchObject({ from: 8, to: 9, people: 23, done: false, started: false });
    expect(trade0.netFrom).toBe(9);
    expect(trade0.netTo).toBe(8);
    expect(trade0.netPeople).toBe(2);
    expect(trade0.betweenLegs).toBe(false);
    expect(trade0.leg1DoneWaitingForLeg2).toBe(false);

    // Complete Leg 1 (steps 0 and 1)
    const afterLeg1: WalkthroughStep[] = steps.map((s, i) =>
      i < 2
        ? { ...s, status: 'done', blocks: s.blocks.map((b) => ({ ...b, done: true })) }
        : i === 2
          ? { ...s, status: 'active' }
          : s,
    );
    const mid = analyzeWalkthroughTwoWayTrades(afterLeg1).get('8-9')!;
    expect(mid.betweenLegs).toBe(true);
    expect(mid.leg1DoneWaitingForLeg2).toBe(true);

    // Consecutive Leg 1 + Leg 2 merge into one paired-two-way outline group
    const outline = buildWalkthroughOutline(afterLeg1, analyzeWalkthroughTwoWayTrades(afterLeg1));
    expect(outline).toHaveLength(1);
    expect(outline[0].kind).toBe('paired-two-way');
  });

  it('keeps non-adjacent two-way legs in realization order and tags each leg', () => {
    const steps: WalkthroughStep[] = [
      {
        id: 's1',
        from: 9,
        to: 8,
        precinctId: 'p1',
        wholePrecinct: false,
        status: 'active',
        blocks: [{ geoid: 'g1', number: 1, people: 25, done: false }],
      },
      {
        id: 's2',
        from: 4,
        to: 7,
        precinctId: 'p2',
        wholePrecinct: false,
        status: 'pending',
        blocks: [{ geoid: 'g2', number: 1, people: 100, done: false }],
      },
      {
        id: 's3',
        from: 8,
        to: 9,
        precinctId: 'p3',
        wholePrecinct: false,
        status: 'pending',
        blocks: [{ geoid: 'g3', number: 1, people: 23, done: false }],
      },
    ];
    const map = analyzeWalkthroughTwoWayTrades(steps);
    const outline = buildWalkthroughOutline(steps, map);
    expect(outline).toHaveLength(3);
    expect(outline[0].kind).toBe('single-run');
    expect(outline[0].kind === 'single-run' && outline[0].run.twoWay?.leg).toBe(1);
    expect(outline[1].kind === 'single-run' && outline[1].run.twoWay).toBeUndefined();
    expect(outline[2].kind === 'single-run' && outline[2].run.twoWay?.leg).toBe(2);
  });
});
