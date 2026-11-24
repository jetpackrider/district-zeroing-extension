import type { WalkthroughStep } from '@zd/contracts';

export interface FlowEntry {
  from: number;
  to: number;
  people: number;
}

export interface OneWayBorderTrade {
  kind: 'one-way';
  key: string;
  a: number;
  b: number;
  from: number;
  to: number;
  people: number;
}

export interface TwoWayBorderTrade {
  kind: 'two-way';
  key: string;
  a: number;
  b: number;
  /** First leg in plan / realization order. */
  first: FlowEntry;
  /** Return leg in opposite direction. */
  second: FlowEntry;
  /** Direction of the net transfer (from netFrom → netTo). */
  netFrom: number;
  netTo: number;
  /** Absolute net people moved across this border. */
  netPeople: number;
}

export type BorderTrade = OneWayBorderTrade | TwoWayBorderTrade;

export function borderPairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Collapses a plan's directional `borderFlows` into one entry per unordered district border.
 * When both `a → b` and `b → a` are present, pairs them as a single `TwoWayBorderTrade`
 * preserving leg order and computing the net transfer.
 */
export function groupBorderTrades(flows: FlowEntry[]): BorderTrade[] {
  const order: string[] = [];
  const byPair = new Map<
    string,
    {
      firstDir: { from: number; to: number; people: number };
      secondDir?: { from: number; to: number; people: number };
    }
  >();

  for (const flow of flows) {
    if (flow.people <= 0 || flow.from === flow.to) continue;
    const key = borderPairKey(flow.from, flow.to);
    const existing = byPair.get(key);
    if (!existing) {
      order.push(key);
      byPair.set(key, { firstDir: { from: flow.from, to: flow.to, people: flow.people } });
    } else if (existing.firstDir.from === flow.from && existing.firstDir.to === flow.to) {
      existing.firstDir.people += flow.people;
    } else if (!existing.secondDir) {
      existing.secondDir = { from: flow.from, to: flow.to, people: flow.people };
    } else {
      existing.secondDir.people += flow.people;
    }
  }

  return order.map((key) => {
    const entry = byPair.get(key)!;
    const a = Math.min(entry.firstDir.from, entry.firstDir.to);
    const b = Math.max(entry.firstDir.from, entry.firstDir.to);
    if (!entry.secondDir) {
      return {
        kind: 'one-way',
        key,
        a,
        b,
        from: entry.firstDir.from,
        to: entry.firstDir.to,
        people: entry.firstDir.people,
      };
    }
    const first = entry.firstDir;
    const second = entry.secondDir;
    const diff = first.people - second.people;
    const netFrom = diff >= 0 ? first.from : second.from;
    const netTo = diff >= 0 ? first.to : second.to;
    return {
      kind: 'two-way',
      key,
      a,
      b,
      first,
      second,
      netFrom,
      netTo,
      netPeople: Math.abs(diff),
    };
  });
}

export interface WalkthroughStepRef {
  step: WalkthroughStep;
  globalIndex: number;
}

export interface WalkthroughTwoWayTrade {
  key: string;
  a: number;
  b: number;
  leg1: {
    from: number;
    to: number;
    people: number;
    steps: WalkthroughStepRef[];
    done: boolean;
    started: boolean;
  };
  leg2: {
    from: number;
    to: number;
    people: number;
    steps: WalkthroughStepRef[];
    done: boolean;
    started: boolean;
  };
  netFrom: number;
  netTo: number;
  netPeople: number;
  /** True once leg 1 has finished (or started overshooting) and leg 2 is not yet finished. */
  betweenLegs: boolean;
  /** True once leg 1 is completely done and leg 2 has not finished yet. */
  leg1DoneWaitingForLeg2: boolean;
}

function stepPeople(step: WalkthroughStep): number {
  return step.blocks.reduce((sum, b) => sum + b.people, 0);
}

function stepStarted(step: WalkthroughStep): boolean {
  return step.status === 'done' || step.status === 'awaiting-commit' || step.blocks.some((b) => b.done);
}

/**
 * Derives two-way trades from a walkthrough's ordered step list by pairing any unordered
 * district border `{a, b}` that appears in both `a → b` and `b → a` directions.
 */
export function analyzeWalkthroughTwoWayTrades(
  steps: WalkthroughStep[],
): Map<string, WalkthroughTwoWayTrade> {
  const pairOrder: string[] = [];
  const buckets = new Map<
    string,
    {
      leg1From: number;
      leg1To: number;
      leg1Steps: WalkthroughStepRef[];
      leg2Steps: WalkthroughStepRef[];
    }
  >();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const key = borderPairKey(step.from, step.to);
    const existing = buckets.get(key);
    if (!existing) {
      pairOrder.push(key);
      buckets.set(key, {
        leg1From: step.from,
        leg1To: step.to,
        leg1Steps: [{ step, globalIndex: i }],
        leg2Steps: [],
      });
    } else if (step.from === existing.leg1From && step.to === existing.leg1To) {
      existing.leg1Steps.push({ step, globalIndex: i });
    } else {
      existing.leg2Steps.push({ step, globalIndex: i });
    }
  }

  const result = new Map<string, WalkthroughTwoWayTrade>();
  for (const key of pairOrder) {
    const b = buckets.get(key)!;
    if (b.leg2Steps.length === 0) continue;

    const leg1People = b.leg1Steps.reduce((sum, item) => sum + stepPeople(item.step), 0);
    const leg2People = b.leg2Steps.reduce((sum, item) => sum + stepPeople(item.step), 0);
    const leg1Done = b.leg1Steps.every((item) => item.step.status === 'done');
    const leg2Done = b.leg2Steps.every((item) => item.step.status === 'done');
    const leg1Started = b.leg1Steps.some((item) => stepStarted(item.step));
    const leg2Started = b.leg2Steps.some((item) => stepStarted(item.step));

    const diff = leg1People - leg2People;
    const netFrom = diff >= 0 ? b.leg1From : b.leg1To;
    const netTo = diff >= 0 ? b.leg1To : b.leg1From;

    result.set(key, {
      key,
      a: Math.min(b.leg1From, b.leg1To),
      b: Math.max(b.leg1From, b.leg1To),
      leg1: {
        from: b.leg1From,
        to: b.leg1To,
        people: leg1People,
        steps: b.leg1Steps,
        done: leg1Done,
        started: leg1Started,
      },
      leg2: {
        from: b.leg1To,
        to: b.leg1From,
        people: leg2People,
        steps: b.leg2Steps,
        done: leg2Done,
        started: leg2Started,
      },
      netFrom,
      netTo,
      netPeople: Math.abs(diff),
      betweenLegs: leg1Started && !leg2Done,
      leg1DoneWaitingForLeg2: leg1Done && !leg2Done,
    });
  }

  return result;
}

export interface WalkthroughBorderRun {
  key: string;
  from: number;
  to: number;
  items: WalkthroughStepRef[];
  /** Present if this run is one leg of a two-way trade. */
  twoWay?: {
    trade: WalkthroughTwoWayTrade;
    leg: 1 | 2;
  };
}

export type WalkthroughOutlineGroup =
  | {
      kind: 'single-run';
      key: string;
      run: WalkthroughBorderRun;
    }
  | {
      kind: 'paired-two-way';
      key: string;
      trade: WalkthroughTwoWayTrade;
      leg1Run: WalkthroughBorderRun;
      leg2Run: WalkthroughBorderRun;
    };

/**
 * Groups walkthrough steps in realization order into outline blocks.
 * When Leg 1 and Leg 2 of a two-way trade occur consecutively, merges them into a single
 * unified `paired-two-way` card so the border reads as one trade with two ordered legs.
 * When other borders sit between the legs, keeps realization order and tags each run as Leg 1 / Leg 2.
 */
export function buildWalkthroughOutline(
  steps: WalkthroughStep[],
  twoWayMap: Map<string, WalkthroughTwoWayTrade>,
): WalkthroughOutlineGroup[] {
  const runs: WalkthroughBorderRun[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const last = runs[runs.length - 1];
    if (last && last.from === step.from && last.to === step.to) {
      last.items.push({ step, globalIndex: i });
    } else {
      const pairKey = borderPairKey(step.from, step.to);
      const trade = twoWayMap.get(pairKey);
      const twoWay = trade
        ? {
            trade,
            leg: (step.from === trade.leg1.from && step.to === trade.leg1.to ? 1 : 2) as 1 | 2,
          }
        : undefined;
      runs.push({
        key: `${step.from}-${step.to}-${i}`,
        from: step.from,
        to: step.to,
        items: [{ step, globalIndex: i }],
        twoWay,
      });
    }
  }

  const groups: WalkthroughOutlineGroup[] = [];
  for (let i = 0; i < runs.length; i++) {
    const cur = runs[i];
    const next = runs[i + 1];
    if (
      cur.twoWay &&
      next?.twoWay &&
      cur.twoWay.trade.key === next.twoWay.trade.key &&
      cur.twoWay.leg === 1 &&
      next.twoWay.leg === 2
    ) {
      groups.push({
        kind: 'paired-two-way',
        key: `twoway-${cur.twoWay.trade.key}-${i}`,
        trade: cur.twoWay.trade,
        leg1Run: cur,
        leg2Run: next,
      });
      i++;
    } else {
      groups.push({
        kind: 'single-run',
        key: cur.key,
        run: cur,
      });
    }
  }

  return groups;
}
