import type { SolutionKind } from '@zd/contracts';
import { pairKey } from './districts';
import { cleanTiers, type CurveMap } from './interaction';
import { minCostFlow, type FlowArc } from './mcf';

/** Integer cost knobs for one plan kind. */
export interface FlowCostParams {
  /** Multiplier from a tier's costPerPerson to integer flow cost. */
  tierScale: number;
  /** Extra integer cost per person for entering a tier that allows splits. */
  splitTierCost?: { low: number; high: number };
  /** Cost per person per border crossed (keeps chains short). */
  hop: number;
  /** Extra cost per person sent into an already balanced selected district (a relay). */
  relayPenalty: number;
  /** Cost per person that pushes an outside absorber further from zero. */
  absorbPenalty: number;
  /**
   * Fixed cost for opening a directed border. Deterministic slope scaling re-solves with
   * per-person cost F / flow and keeps the plan with the lowest cost including the fixed fees.
   */
  fixedCharge?: number;
  /** Slope-scaling rounds when fixedCharge > 0. */
  scalingRounds?: number;
}

export const FLOW_PARAMS: Record<Exclude<SolutionKind, 'single'>, FlowCostParams> = {
  'fewest-splits': { tierScale: 1000, hop: 1, relayPenalty: 0, absorbPenalty: 100_000, fixedCharge: 420_000, scalingRounds: 8 },
  'fewest-blocks': { tierScale: 200, hop: 1000, relayPenalty: 0, absorbPenalty: 100_000, fixedCharge: 90_000, scalingRounds: 8 },
  'fewest-districts': { tierScale: 1000, hop: 1000, relayPenalty: 50_000, absorbPenalty: 100_000, fixedCharge: 620_000, scalingRounds: 8 },
};

export interface FlowModelInput {
  /** Selected districts, sorted. */
  members: number[];
  /** pop - q per selected district. */
  supply: Map<number, number>;
  /** 1 if a district may keep q + 1. */
  hi: 0 | 1;
  /** Directed borders to offer, [from, to]. Both directions should be listed. */
  borders: Array<[number, number]>;
  curves: CurveMap;
  /** Outside districts allowed to absorb, with their pop - q. */
  absorbers: Map<number, number>;
  /** Upper bounds on people per directed border (from re-planning), keyed by pairKey. */
  caps: Map<number, number>;
  params: FlowCostParams;
  /**
   * When set, every selected district may leave people unplaced at this cost per person,
   * so the flow always succeeds and moves as much as the borders allow (see `unmet`).
   */
  slackCost?: number;
}

export interface BorderFlow {
  from: number;
  to: number;
  people: number;
}

export interface FlowPlan {
  feasible: boolean;
  /** Net people per border, largest first (ties by from, then to). */
  borders: BorderFlow[];
  /** Selected districts that keep the extra person (q + 1). */
  extra: number[];
  cost: number;
  /** People left unplaced through slack (0 = every selected district reaches zero). */
  unmet: number;
}

type ArcMeta = { type: 'border'; from: number; to: number } | { type: 'extra'; d: number } | { type: 'absorb' } | { type: 'slack' };

/** Convex tiers for an outside district absorbing g >= 0 people when its pop - q is d. */
export function absorbTiers(d: number, hi: number, big: number, eps: number, penalty: number): Array<{ cap: number; cost: number }> {
  const tiers: Array<{ cap: number; cost: number }> = [];
  if (d < hi) {
    tiers.push({ cap: hi - d, cost: eps }); // toward zero / into the zero band
    if (d < 0) tiers.push({ cap: -d, cost: eps + Math.floor(penalty / 2) }); // overshoot, no worse than now
  }
  tiers.push({ cap: big, cost: eps + penalty });
  return tiers;
}

export function planFlow(input: FlowModelInput): FlowPlan {
  const { members, supply, hi, params } = input;
  const nodeOf = new Map<number, number>();
  members.forEach((d, i) => nodeOf.set(d, i));
  const T = members.length;
  const absorbers = [...input.absorbers.keys()].sort((a, b) => a - b);
  const inNode = new Map<number, number>();
  const outNode = new Map<number, number>();
  absorbers.forEach((o, j) => {
    inNode.set(o, T + 1 + 2 * j);
    outNode.set(o, T + 2 + 2 * j);
  });
  const numNodes = T + 1 + 2 * absorbers.length;
  const sup = new Array<number>(numNodes).fill(0);
  let total = 0;
  let big = 1;
  for (const d of members) {
    const s = supply.get(d) ?? 0;
    sup[nodeOf.get(d)!] = s;
    total += s;
    big += Math.abs(s);
  }
  sup[T] = -total;
  big += Math.abs(total);

  const arcs: FlowArc[] = [];
  const meta: ArcMeta[] = [];
  /** Total offered capacity per directed border (for the first slope-scaling round). */
  const borderCap = new Map<number, number>();
  if (hi) {
    for (const d of members) {
      arcs.push({ from: nodeOf.get(d)!, to: T, cap: 1, cost: 0 });
      meta.push({ type: 'extra', d });
    }
  }
  for (const [from, to] of input.borders) {
    const u = nodeOf.has(from) ? nodeOf.get(from)! : outNode.get(from);
    const v = nodeOf.has(to) ? nodeOf.get(to)! : inNode.get(to);
    if (u === undefined || v === undefined) continue;
    if (!nodeOf.has(from) && !nodeOf.has(to)) continue; // never route outside-to-outside
    const tiers = cleanTiers(input.curves.get(pairKey(from, to)))
      .map((t, i) => ({ ...t, i }))
      .sort((a, b) => a.costPerPerson - b.costPerPerson || a.i - b.i);
    let remaining = input.caps.has(pairKey(from, to)) ? input.caps.get(pairKey(from, to))! : Infinity;
    const toSupply = supply.get(to);
    const relay = toSupply !== undefined && toSupply >= 0 && toSupply <= hi ? params.relayPenalty : 0;
    for (const t of tiers) {
      if (remaining <= 0) break;
      const cap = Math.min(t.people, remaining);
      remaining -= cap;
      const split = t.kind === 'no-split' ? 0 : (params.splitTierCost?.[t.kind] ?? 0);
      arcs.push({ from: u, to: v, cap, cost: Math.round(t.costPerPerson * params.tierScale) + params.hop + relay + split });
      meta.push({ type: 'border', from, to });
      borderCap.set(pairKey(from, to), (borderCap.get(pairKey(from, to)) ?? 0) + cap);
    }
  }
  for (const o of absorbers) {
    const d = input.absorbers.get(o)!;
    for (const t of absorbTiers(d, hi, big, params.hop, params.absorbPenalty)) {
      arcs.push({ from: inNode.get(o)!, to: T, cap: t.cap, cost: t.cost });
      meta.push({ type: 'absorb' });
    }
    // Giving people up is gaining in the mirrored band (x -> hi - x).
    for (const t of absorbTiers(hi - d, hi, big, params.hop, params.absorbPenalty)) {
      arcs.push({ from: T, to: outNode.get(o)!, cap: t.cap, cost: t.cost });
      meta.push({ type: 'absorb' });
    }
  }

  if (input.slackCost !== undefined) {
    const sc = Math.round(input.slackCost);
    for (const d of members) {
      arcs.push({ from: nodeOf.get(d)!, to: T, cap: big, cost: sc });
      meta.push({ type: 'slack' });
      arcs.push({ from: T, to: nodeOf.get(d)!, cap: big, cost: sc });
      meta.push({ type: 'slack' });
    }
  }

  const F = Math.max(0, Math.round(params.fixedCharge ?? 0));
  const rounds = F > 0 ? Math.max(1, params.scalingRounds ?? 8) : 1;
  const slope = new Map<number, number>();
  if (F > 0) for (const [key, cap] of borderCap) slope.set(key, Math.round(F / Math.max(1, cap)));
  let res: ReturnType<typeof minCostFlow> | null = null;
  let bestTrue = Infinity;
  const seenFlows = new Set<string>();
  for (let round = 0; round < rounds; round++) {
    const roundArcs = F > 0
      ? arcs.map((a, i) => {
          const m = meta[i];
          return m.type === 'border' ? { ...a, cost: a.cost + (slope.get(pairKey(m.from, m.to)) ?? 0) } : a;
        })
      : arcs;
    const r = minCostFlow(numNodes, sup, roundArcs);
    if (!r.feasible) {
      if (round === 0) return { feasible: false, borders: [], extra: [], cost: r.cost, unmet: 0 };
      break;
    }
    // True cost: linear part on the base arcs plus F per directed border used.
    const perBorder = new Map<number, number>();
    let trueCost = 0;
    r.flow.forEach((f, i) => {
      trueCost += f * arcs[i].cost;
      const m = meta[i];
      if (m.type === 'border' && f > 0) perBorder.set(pairKey(m.from, m.to), (perBorder.get(pairKey(m.from, m.to)) ?? 0) + f);
    });
    trueCost += F * perBorder.size;
    if (trueCost < bestTrue) {
      bestTrue = trueCost;
      res = r;
    }
    const sig = r.flow.join(',');
    if (seenFlows.has(sig)) break; // converged (or cycling)
    seenFlows.add(sig);
    for (const [key, f] of perBorder) slope.set(key, Math.round(F / f));
  }
  if (!res) return { feasible: false, borders: [], extra: [], cost: 0, unmet: 0 };

  const directed = new Map<number, number>();
  const extra: number[] = [];
  let unmet = 0;
  res.flow.forEach((f, i) => {
    if (f <= 0) return;
    const m = meta[i];
    if (m.type === 'slack') unmet += f;
    if (m.type === 'border') directed.set(pairKey(m.from, m.to), (directed.get(pairKey(m.from, m.to)) ?? 0) + f);
    else if (m.type === 'extra') extra.push(m.d);
  });
  const borders: BorderFlow[] = [];
  const done = new Set<number>();
  for (const [key, f] of directed) {
    const from = Math.floor(key / 65536), to = key % 65536;
    if (done.has(key)) continue;
    const back = pairKey(to, from);
    done.add(key).add(back);
    const net = f - (directed.get(back) ?? 0);
    if (net > 0) borders.push({ from, to, people: net });
    else if (net < 0) borders.push({ from: to, to: from, people: -net });
  }
  borders.sort((a, b) => b.people - a.people || a.from - b.from || a.to - b.to);
  return { feasible: true, borders, extra: extra.sort((a, b) => a - b), cost: res.cost, unmet };
}
