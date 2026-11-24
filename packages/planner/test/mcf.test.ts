import { describe, expect, it } from 'vitest';
import { minCostFlow, type FlowArc } from '../src/mcf';
import { planFlow, FLOW_PARAMS } from '../src/flowModel';
import { pairKey } from '../src/districts';
import type { CapacityCurve } from '@zd/contracts';
import { rng } from './support/synth';

function conserves(n: number, supply: number[], arcs: FlowArc[], flow: number[]) {
  const net = supply.slice();
  arcs.forEach((a, i) => {
    expect(flow[i]).toBeGreaterThanOrEqual(0);
    expect(flow[i]).toBeLessThanOrEqual(a.cap);
    net[a.from] -= flow[i];
    net[a.to] += flow[i];
  });
  for (let v = 0; v < n; v++) expect(net[v] === 0).toBe(true);
}

describe('minCostFlow, hand-computed', () => {
  it('ships along the only path', () => {
    const arcs = [{ from: 0, to: 1, cap: 10, cost: 3 }];
    const r = minCostFlow(2, [4, -4], arcs);
    expect(r).toMatchObject({ feasible: true, flow: [4], cost: 12 });
  });

  it('fills cheaper parallel tiers first (convex piecewise)', () => {
    // 0 -> 1 with tiers 3 @ 1, 4 @ 5, 10 @ 20; ship 8: 3*1 + 4*5 + 1*20 = 43
    const arcs = [
      { from: 0, to: 1, cap: 3, cost: 1 },
      { from: 0, to: 1, cap: 4, cost: 5 },
      { from: 0, to: 1, cap: 10, cost: 20 },
    ];
    const r = minCostFlow(2, [8, -8], arcs);
    expect(r.flow).toEqual([3, 4, 1]);
    expect(r.cost).toBe(43);
  });

  it('trades through a middle node when the ends do not touch', () => {
    // A(+5) - B(0) - C(-5); no A-C arc.
    const arcs = [
      { from: 0, to: 1, cap: 9, cost: 2 },
      { from: 1, to: 2, cap: 9, cost: 3 },
    ];
    const r = minCostFlow(3, [5, 0, -5], arcs);
    expect(r.flow).toEqual([5, 5]);
    expect(r.cost).toBe(25);
  });

  it('prefers the shorter chain when both exist', () => {
    // 0 -> 3 direct at 10/unit (cap 2) vs 0 -> 1 -> 2 -> 3 at 2+2+2.
    const arcs = [
      { from: 0, to: 3, cap: 2, cost: 5 },
      { from: 0, to: 1, cap: 10, cost: 2 },
      { from: 1, to: 2, cap: 10, cost: 2 },
      { from: 2, to: 3, cap: 10, cost: 2 },
    ];
    const r = minCostFlow(4, [4, 0, 0, -4], arcs);
    // 2 units direct at 5 = 10, 2 units long at 6 = 12.
    expect(r.flow).toEqual([2, 2, 2, 2]);
    expect(r.cost).toBe(22);
  });

  it('reports infeasibility when capacity is short', () => {
    const r = minCostFlow(2, [5, -5], [{ from: 0, to: 1, cap: 3, cost: 1 }]);
    expect(r.feasible).toBe(false);
    expect(r.shipped).toBe(3);
    expect(r.required).toBe(5);
  });

  it('rejects unbalanced supplies and negative costs', () => {
    expect(() => minCostFlow(2, [1, 0], [])).toThrow();
    expect(() => minCostFlow(2, [1, -1], [{ from: 0, to: 1, cap: 1, cost: -1 }])).toThrow();
  });

  it('reroutes existing flow through residual arcs', () => {
    // Classic case where the greedy first path must be undone.
    // s=0 supply 2, t=3 demand 2. 0->1 (1,1), 0->2 (1,3), 1->2 (1,0), 1->3 (1,3), 2->3 (1,1)
    const arcs = [
      { from: 0, to: 1, cap: 1, cost: 1 },
      { from: 0, to: 2, cap: 1, cost: 3 },
      { from: 1, to: 2, cap: 1, cost: 0 },
      { from: 1, to: 3, cap: 1, cost: 3 },
      { from: 2, to: 3, cap: 1, cost: 1 },
    ];
    const r = minCostFlow(4, [2, 0, 0, -2], arcs);
    expect(r.cost).toBe(8);
    conserves(4, [2, 0, 0, -2], arcs, r.flow);
  });
});

describe('minCostFlow vs brute force on small random instances', () => {
  it('matches exhaustive search on 300 instances', () => {
    const rand = rng(12345);
    for (let trial = 0; trial < 300; trial++) {
      const n = 3 + Math.floor(rand() * 2); // 3..4 nodes
      const m = 2 + Math.floor(rand() * 5); // 2..6 arcs
      const arcs: FlowArc[] = [];
      for (let i = 0; i < m; i++) {
        const from = Math.floor(rand() * n);
        let to = Math.floor(rand() * (n - 1));
        if (to >= from) to++;
        arcs.push({ from, to, cap: Math.floor(rand() * 4), cost: Math.floor(rand() * 6) });
      }
      const supply = new Array<number>(n).fill(0);
      for (let i = 0; i < n - 1; i++) supply[i] = Math.floor(rand() * 5) - 2;
      supply[n - 1] = -supply.slice(0, n - 1).reduce((s, x) => s + x, 0);

      // Exhaustive: every integer flow vector within caps.
      let best = Infinity;
      const f = new Array<number>(m).fill(0);
      const rec = (i: number) => {
        if (i === m) {
          const net = supply.slice();
          let c = 0;
          for (let j = 0; j < m; j++) {
            net[arcs[j].from] -= f[j];
            net[arcs[j].to] += f[j];
            c += f[j] * arcs[j].cost;
          }
          if (net.every((x) => x === 0) && c < best) best = c;
          return;
        }
        for (let x = 0; x <= arcs[i].cap; x++) { f[i] = x; rec(i + 1); }
      };
      rec(0);

      const r = minCostFlow(n, supply, arcs);
      if (best === Infinity) {
        expect(r.feasible, `trial ${trial}`).toBe(false);
      } else {
        expect(r.feasible, `trial ${trial}`).toBe(true);
        expect(r.cost, `trial ${trial}`).toBe(best);
        conserves(n, supply, arcs, r.flow);
      }
    }
  });

  it('is deterministic', () => {
    const arcs = [
      { from: 0, to: 1, cap: 5, cost: 1 },
      { from: 0, to: 2, cap: 5, cost: 1 },
      { from: 1, to: 3, cap: 5, cost: 1 },
      { from: 2, to: 3, cap: 5, cost: 1 },
    ];
    const a = minCostFlow(4, [3, 0, 0, -3], arcs);
    const b = minCostFlow(4, [3, 0, 0, -3], arcs);
    expect(a.flow).toEqual(b.flow);
  });
});

describe('planFlow (district model)', () => {
  const curve = (from: number, to: number, cheap: number, more: number): CapacityCurve => ({
    from,
    to,
    tiers: [
      { kind: 'no-split', people: cheap, costPerPerson: 0.1 },
      { kind: 'low', people: more, costPerPerson: 1 },
    ],
  });

  it('routes a surplus through the middle district, exact integer people', () => {
    const curves = new Map([
      [pairKey(1, 2), curve(1, 2, 100, 1000)], [pairKey(2, 1), curve(2, 1, 100, 1000)],
      [pairKey(2, 3), curve(2, 3, 100, 1000)], [pairKey(3, 2), curve(3, 2, 100, 1000)],
    ]);
    const p = planFlow({
      members: [1, 2, 3],
      supply: new Map([[1, 400], [2, 0], [3, -400]]),
      hi: 0,
      borders: [[1, 2], [2, 1], [2, 3], [3, 2]],
      curves,
      absorbers: new Map(),
      caps: new Map(),
      params: FLOW_PARAMS['fewest-splits'],
    });
    expect(p.feasible).toBe(true);
    expect(p.borders).toEqual([
      { from: 1, to: 2, people: 400 },
      { from: 2, to: 3, people: 400 },
    ]);
  });

  it('lets exactly the right number of districts keep q + 1', () => {
    const curves = new Map<number, CapacityCurve>();
    const borders: Array<[number, number]> = [];
    for (const [a, b] of [[1, 2], [2, 3], [3, 4], [1, 4]]) {
      curves.set(pairKey(a, b), curve(a, b, 50, 500));
      curves.set(pairKey(b, a), curve(b, a, 50, 500));
      borders.push([a, b], [b, a]);
    }
    // Supplies sum to 2: two districts keep q + 1.
    const supply = new Map([[1, 30], [2, -10], [3, 1], [4, -19]]);
    const p = planFlow({ members: [1, 2, 3, 4], supply, hi: 1, borders, curves, absorbers: new Map(), caps: new Map(), params: FLOW_PARAMS['fewest-splits'] });
    expect(p.feasible).toBe(true);
    expect(p.extra).toHaveLength(2);
    const end = new Map(supply);
    for (const b of p.borders) {
      end.set(b.from, end.get(b.from)! - b.people);
      end.set(b.to, end.get(b.to)! + b.people);
    }
    expect([...end.values()].sort()).toEqual([0, 0, 1, 1]);
    expect(p.extra.every((d) => end.get(d) === 1)).toBe(true);
  });

  it('honors lowered caps and becomes infeasible when nothing is left', () => {
    const curves = new Map([[pairKey(1, 2), curve(1, 2, 100, 100)], [pairKey(2, 1), curve(2, 1, 100, 100)]]);
    const base = { members: [1, 2], supply: new Map([[1, 50], [2, -50]]), hi: 0 as const, borders: [[1, 2], [2, 1]] as Array<[number, number]>, curves, absorbers: new Map(), params: FLOW_PARAMS['fewest-splits'] };
    expect(planFlow({ ...base, caps: new Map() }).borders).toEqual([{ from: 1, to: 2, people: 50 }]);
    expect(planFlow({ ...base, caps: new Map([[pairKey(1, 2), 49]]) }).feasible).toBe(false);
  });
});
