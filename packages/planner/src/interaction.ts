import type {
  Assignment,
  BorderSolver,
  CapacityCurve,
  CostWeights,
  EngineGraph,
  InteractionGraph,
  PopTargets,
} from '@zd/contracts';
import { districtAdjacency, districtPopulations, pairKey } from './districts';
import { resolveWeights } from './weights';

/** Capacity curves keyed by pairKey(from, to). */
export type CurveMap = Map<number, CapacityCurve>;

export interface CurveRequest {
  graph: EngineGraph;
  assignment: Assignment;
  solver: BorderSolver;
  locked?: Uint8Array;
  weights?: Partial<CostWeights>;
  /**
   * Optional cache shared between the interaction view and planGroup, so the curves the
   * panel measured for the schematic are not measured again when the user asks for plans.
   */
  curveCache?: CurveCache;
}

/**
 * Capacity curves remembered for each graph and solver, with assignment, locked mask and
 * weights compared by content. A curve is reused only for the graph that produced it,
 * so a stale map can never be served (the fingerprint is an O(n) hash, about 1 ms on New
 * York). Keeps the curves of the last few states only.
 */
export class CurveCache {
  private readonly states = new Map<string, CurveMap>();
  private readonly solverIds = new WeakMap<BorderSolver, number>();
  private readonly graphIds = new WeakMap<EngineGraph, number>();
  private nextSolverId = 1;
  private nextGraphId = 1;
  hits = 0;
  misses = 0;
  constructor(readonly maxStates = 4) {}

  /** The curve map for one state (created empty if new). */
  forState(req: Pick<CurveRequest, 'graph' | 'assignment' | 'locked' | 'weights' | 'solver'>): CurveMap {
    let sid = this.solverIds.get(req.solver);
    if (sid === undefined) { sid = this.nextSolverId++; this.solverIds.set(req.solver, sid); }
    let gid = this.graphIds.get(req.graph);
    if (gid === undefined) { gid = this.nextGraphId++; this.graphIds.set(req.graph, gid); }
    const key = `${sid}|${gid}|${hashArray(req.assignment)}|${req.locked ? hashArray(req.locked) : '-'}|${JSON.stringify(resolveWeights(req.weights))}`;
    let m = this.states.get(key);
    if (m) {
      // Most recently used last.
      this.states.delete(key);
      this.states.set(key, m);
      return m;
    }
    m = new Map();
    this.states.set(key, m);
    while (this.states.size > this.maxStates) this.states.delete(this.states.keys().next().value!);
    return m;
  }
}

function hashArray(a: ArrayLike<number>): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ a.length;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    h1 = Math.imul(h1 ^ x, 0x01000193);
    h2 = Math.imul(h2 ^ (x + i), 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** Sanitized tiers: integer people >= 0, finite cost >= 0. */
export function cleanTiers(curve: CapacityCurve | undefined): CapacityCurve['tiers'] {
  if (!curve || !Array.isArray(curve.tiers)) return [];
  const out: CapacityCurve['tiers'] = [];
  for (const t of curve.tiers) {
    const people = Math.floor(Number(t.people));
    const cost = Number(t.costPerPerson);
    if (!(people > 0) || !Number.isFinite(cost)) continue;
    out.push({ kind: t.kind, people, costPerPerson: Math.max(0, cost) });
  }
  return out;
}

/** Ask the solver for both directions of every listed border (pairs as [a, b], a < b). */
export function collectCurves(req: CurveRequest, pairs: Array<[number, number]>, into: CurveMap = new Map()): CurveMap {
  const cached = req.curveCache?.forState(req);
  for (const [a, b] of pairs) {
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const key = pairKey(from, to);
      if (into.has(key)) continue;
      const hit = cached?.get(key);
      if (hit) {
        req.curveCache!.hits++;
        into.set(key, hit);
        continue;
      }
      if (req.curveCache) req.curveCache.misses++;
      const curve = req.solver.capacity({
        graph: req.graph,
        assignment: req.assignment,
        from,
        to,
        locked: req.locked,
        weights: req.weights,
      });
      into.set(key, curve);
      cached?.set(key, curve);
    }
  }
  return into;
}

/** Sorted pairs [a, b], a < b, of neighboring districts both in `members`. */
export function internalPairs(members: number[], adjacency: number[][]): Array<[number, number]> {
  const inGroup = new Set(members);
  const pairs: Array<[number, number]> = [];
  for (const a of members) for (const b of adjacency[a]) if (b > a && inGroup.has(b)) pairs.push([a, b]);
  return pairs;
}

export function interactionFromCurves(
  members: number[],
  pops: number[],
  targets: PopTargets,
  pairs: Array<[number, number]>,
  curves: CurveMap,
): InteractionGraph {
  const sum = (key: number, cheapOnly: boolean) =>
    cleanTiers(curves.get(key)).reduce((s, t) => s + (cheapOnly && t.kind !== 'no-split' ? 0 : t.people), 0);
  return {
    nodes: members.map((d) => ({ district: d, deviation: pops[d] - targets.draTarget })),
    edges: pairs.map(([a, b]) => ({
      a,
      b,
      cheapAtoB: sum(pairKey(a, b), true),
      cheapBtoA: sum(pairKey(b, a), true),
      maxAtoB: sum(pairKey(a, b), false),
      maxBtoA: sum(pairKey(b, a), false),
    })),
  };
}

export interface InteractionRequest extends CurveRequest {
  targets: PopTargets;
  districts: number[];
}

/** The panel's interaction view for a selection, before solving. */
export function buildInteractionGraph(req: InteractionRequest): InteractionGraph {
  const k = req.targets.numDistricts;
  const members = [...new Set(req.districts)].filter((d) => d >= 1 && d <= k).sort((a, b) => a - b);
  const pops = districtPopulations(req.graph, req.assignment, k);
  const adjacency = districtAdjacency(req.graph, req.assignment, k);
  const pairs = internalPairs(members, adjacency);
  // Same weights as planGroup passes, so a shared CurveCache hits.
  const curves = collectCurves({ ...req, weights: resolveWeights(req.weights) }, pairs);
  return interactionFromCurves(members, pops, req.targets, pairs, curves);
}
