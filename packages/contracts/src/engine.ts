/**
 * Balancing engine contracts (SPEC.md "Balancing engine" and "Balancing several districts").
 *
 * packages/engine implements BorderSolver + solveDistrict (single border / one district).
 * packages/planner implements planGroup (several districts / whole map) on top of a BorderSolver.
 * Both are pure, synchronous, deterministic, and free of DOM or Node APIs so they run in a Worker.
 */

/** The block graph the engine works on. Same arrays as StateBundle, with one population column chosen. */
export interface EngineGraph {
  n: number;
  pop: Int32Array;
  countyOf: Uint16Array;
  /** Live precinct membership (from DRA's blockMapping when available, else the bundle default). */
  precinctOf: Uint32Array;
  adjOffsets: Uint32Array;
  adjTargets: Uint32Array;
  adjLen: Uint16Array;
  outerLen: Uint32Array;
  areaM2: Float32Array;
  /**
   * 1 where the block is water only. When present, the engine prefers moves whose contiguity
   * holds over land: connections that run through a water-only block, or over a zero-length
   * link (DRA's hand-made links, nearest-block bridges), are used only when no land-only move
   * hits the number. Absent = every adjacency counts the same.
   */
  water?: Uint8Array;
  /**
   * Town (city, town or other municipality) index per block; 0 = in no town. When present, a
   * move that newly splits a town between districts is counted and charged like a county split.
   */
  townOf?: Uint32Array;
}

/** District index per block. 0 = unassigned; districts are 1..numDistricts. Never mutated by the engine. */
export type Assignment = Uint16Array;

/**
 * Unassigned (district 0) as a trading partner, for maps still being drawn.
 *
 * Unassigned is not a district: it has no target, so it can take or give any number of people.
 * When a request allows it (DistrictSolveRequest / GroupSolveRequest `includeUnassigned`, or 0
 * listed in `absorbers`), a district may give blocks to Unassigned or take unassigned blocks.
 * The rules every solver and verifier apply:
 *  - The real district's side is held to the usual rules: its population must reach the target,
 *    it must gain no new pieces, the compact-first and land-first rules apply.
 *  - Unassigned's side has no rules: no population limit, no tolerance, and it may be left in
 *    any number of pieces (it is not contiguous to begin with).
 *  - Splits count as usual: a precinct, county or town divided between a district and
 *    Unassigned is divided.
 *  - Its deviation effect is zero: moving people to or from Unassigned neither helps nor hurts
 *    a neighbor, so a real neighbor that a move brings closer to zero still ranks first.
 *  - Unassigned never appears in `Solution.deviations` or in group feasibility excess; it does
 *    appear in `transfers` and `borderFlows` as district 0.
 * Without that permission, district 0 is never touched, exactly as before.
 */
export const UNASSIGNED = 0;

/**
 * An area of the map where the user would like the swap to happen (they mark it on the map; see
 * PanelState.area). `inside[b] = 1` for each block in the area. It applies to the blocks that
 * move, whichever side of a transfer they come from.
 *  - 'only': no block outside the area moves, exactly as if every outside block were locked. If
 *    nothing can be done inside, nothing is returned, with a message saying the area is the reason.
 *  - 'prefer': every option or plan that moves only blocks inside the area comes before any that
 *    moves a block outside. When fewer than the requested number exist inside (or none), options
 *    that go outside fill the remaining places, fewest outside blocks first, and say so in
 *    `SolutionStats.outsideArea`.
 * Ordering when several preferences apply: inside the area first, then a real neighbor brought
 * closer to zero before Unassigned (see UNASSIGNED), then cost.
 */
export interface AreaPreference {
  /** Length graph.n; 1 = inside the area. */
  inside: Uint8Array;
  mode: 'prefer' | 'only';
}

export interface PopTargets {
  totalPop: number;
  numDistricts: number;
  /** floor(totalPop / numDistricts). A zeroed district holds q or q + 1 people. */
  q: number;
  /** totalPop mod numDistricts: how many districts hold q + 1 when the whole map is zeroed. */
  remainder: number;
  /** DRA's displayed target, Math.round(totalPop / numDistricts). Deviations shown to the user are against this. */
  draTarget: number;
}

export interface CostWeights {
  newPrecinctSplit: number; // default +100
  healedPrecinctSplit: number; // default -100
  newCountySplit: number; // default +300
  newTownSplit: number; // a town newly divided between districts; ignored when the graph has no towns
  perStep: number; // each precinct a transfer touches: one walkthrough step the user has to paint
  perBlock: number; // small
  perPopulatedBlock: number; // small, larger than perBlock
  perimeterPerMeter: number; // compactness: change in district perimeter
  neighborDeviation: number; // per person the move worsens (+) or improves (-) the neighbor
}

/** A set of blocks moving from one district to another. `blocks` is sorted ascending. */
export interface Transfer {
  from: number;
  to: number;
  blocks: Uint32Array;
  people: number;
}

export interface SolutionStats {
  people: number;
  blocks: number;
  populatedBlocks: number;
  newPrecinctSplits: number;
  healedPrecinctSplits: number;
  newCountySplits: number;
  /** Towns newly divided between districts. Absent when the graph has no town information. */
  newTownSplits?: number;
  /** Change in total district perimeter in meters (negative = more compact). */
  perimeterDeltaM: number;
  districtsTouched: number;
  /** Final exact score; lower is better. */
  cost: number;
  /**
   * True when the move only keeps a district in one piece, or only reaches the receiving
   * district, across water or a zero-length link. Such options rank after every land-only one.
   */
  usesWater?: boolean;
  /**
   * Walkthrough steps this takes: one per precinct per transfer. What the user will actually
   * have to do, so it is shown on the card before they start.
   */
  steps?: number;
  /**
   * With an area (AreaPreference): how many moved blocks lie outside it. 0 = all inside. Absent
   * when the request had no area.
   */
  outsideArea?: number;
  /**
   * True when some transfer reaches further than a compact bite out of the border: a block more
   * than a few hops from the receiving district's territory, or a chain of empty blocks fetching
   * distant population. Only produced when nothing compact hits the number; such options rank
   * after every compact one.
   */
  longReach?: boolean;
}

/** Deviation against PopTargets.draTarget, before and after applying a solution. */
export interface DeviationChange {
  district: number;
  before: number;
  after: number;
}

export type SolutionKind = 'single' | 'fewest-splits' | 'fewest-blocks' | 'fewest-districts';

/**
 * One ranked option (single-district mode) or one plan (group / whole-map mode).
 * `transfers` are in realization order; applying them in order to the input
 * assignment yields the result. No block appears in more than one transfer.
 */
export interface Solution {
  id: string;
  kind: SolutionKind;
  transfers: Transfer[];
  /**
   * People crossing each border in each direction, e.g. 4 → 7: 312. One entry per
   * (from, to) pair used. A border may be traded in both directions at once (4 → 7: 7
   * and 7 → 4: 6 for a net of 1) when the net amount cannot be moved one way; then
   * both directions are listed with their gross amounts.
   */
  borderFlows: Array<{ from: number; to: number; people: number }>;
  stats: SolutionStats;
  /** Every district whose population changes. */
  deviations: DeviationChange[];
}

// ---------------------------------------------------------------------------
// Single border / single district (packages/engine)
// ---------------------------------------------------------------------------

export interface BorderSolveRequest {
  graph: EngineGraph;
  assignment: Assignment;
  /** Giving district. */
  from: number;
  /** Receiving district. */
  to: number;
  /** Acceptable totals of people to move. Usually one value; two when either q or q + 1 is fine. */
  accept: number[];
  /** How many distinct options to return (default 5, max 8). */
  maxOptions?: number;
  /** locked[i] = 1 means block i must not move (e.g. already moved earlier in this plan). */
  locked?: Uint8Array;
  weights?: Partial<CostWeights>;
}

/** Cumulative capacity of one border in one direction, cheapest tier first. */
export interface CapacityCurve {
  from: number;
  to: number;
  tiers: Array<{
    /** 'no-split': moves that create no new precinct split and no new county split. */
    kind: 'no-split' | 'low' | 'high';
    /** People that can cross within this tier (not cumulative). */
    people: number;
    /** Approximate cost per person in this tier, for the flow planner. */
    costPerPerson: number;
  }>;
}

export interface BorderSolver {
  /**
   * Options moving exactly one of `accept` people from `from` to `to`, best first.
   * Every returned option keeps both districts free of new pieces ("no new pieces",
   * not "one piece"). Returns [] when the border cannot hit the number.
   */
  solve(req: BorderSolveRequest): Transfer[];
  /** Like solve, with the exact stats for each option. */
  solveScored(req: BorderSolveRequest): Array<{ transfer: Transfer; stats: SolutionStats }>;
  /** How many people can cross this border in this direction, by cost tier. */
  capacity(req: Omit<BorderSolveRequest, 'accept' | 'maxOptions'>): CapacityCurve;
}

export interface DistrictSolveRequest {
  graph: EngineGraph;
  assignment: Assignment;
  targets: PopTargets;
  /** The district to zero. Its neighbors absorb the difference. */
  district: number;
  /**
   * Restrict which neighbors may absorb. Default: all adjacent districts, plus Unassigned when
   * `includeUnassigned`. May list 0 (Unassigned, see UNASSIGNED), which allows it on its own.
   */
  absorbers?: number[];
  /** With no `absorbers`: also trade with adjacent unassigned blocks (see UNASSIGNED). Default false. */
  includeUnassigned?: boolean;
  /** Where the user would like the moves to happen (see AreaPreference). Absent = anywhere. */
  area?: AreaPreference;
  /**
   * The deviation the district should end at, against DRA's displayed target (targets.draTarget):
   * -1, 0 or +1, exactly. Absent = "zero" as everywhere else: q or q + 1 (see PopTargets), which
   * DRA may show as 0 or as one person off when the state does not divide evenly. With a goal,
   * 'already-zero' means the district already sits at exactly that deviation.
   */
  goal?: -1 | 0 | 1;
  /**
   * A neighbor may not end further from draTarget than max(|its current deviation|, neighborTolerance).
   * Default 0: never leave a neighbor worse than it is now.
   */
  neighborTolerance?: number;
  maxOptions?: number;
  weights?: Partial<CostWeights>;
}

export type SolveStatus =
  | 'ok'
  /** Already at q or q + 1. */
  | 'already-zero'
  /** Ring widened to 10 hops and whole-precinct moves tried; nothing hits the target. */
  | 'needs-precinct-rework'
  /** Group / map cannot be zeroed as selected (see GroupFeasibility). */
  | 'group-unbalanced'
  | 'error';

export interface SolveResult {
  status: SolveStatus;
  solutions: Solution[];
  message?: string;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Several districts / whole map (packages/planner)
// ---------------------------------------------------------------------------

export interface GroupFeasibility {
  feasible: boolean;
  /** Signed people the group must shed (+) or gain (−) before every member can sit at q or q + 1. 0 when feasible. */
  excess: number;
  /** Districts outside the group, adjacent to it, whose deviation would help absorb `excess`, best first. */
  suggestAdd: number[];
}

/** Schematic of how selected districts touch (the panel's "interaction view"). */
export interface InteractionGraph {
  nodes: Array<{ district: number; deviation: number }>;
  edges: Array<{
    a: number;
    b: number;
    /** People that can cross a → b / b → a with no new precinct or county splits (the 'no-split' tier). */
    cheapAtoB: number;
    cheapBtoA: number;
    /** Total people that can cross in each direction at any cost. */
    maxAtoB: number;
    maxBtoA: number;
  }>;
}

export interface GroupSolveRequest {
  graph: EngineGraph;
  assignment: Assignment;
  targets: PopTargets;
  /** Districts to zero together. All districts 1..numDistricts for whole-map mode. */
  districts: number[];
  /** When false (default), districts outside `districts` are never touched. */
  allowOutsideAbsorb?: boolean;
  /**
   * With `allowOutsideAbsorb`: the only outside districts that may take or give. Absent = any
   * outside district that touches the group. No other outside district is touched. May list 0
   * (Unassigned, see UNASSIGNED).
   */
  absorbers?: number[];
  /**
   * With `allowOutsideAbsorb` and no `absorbers`: Unassigned may also take or give (see
   * UNASSIGNED). Default false. It has no target and unlimited room, so an over group touching
   * unassigned blocks it may use is always feasible; an under group is feasible only if the
   * unassigned areas it touches hold enough people.
   */
  includeUnassigned?: boolean;
  /** Where the user would like the moves to happen (see AreaPreference). Absent = anywhere. */
  area?: AreaPreference;
  /**
   * Exact deviation goals for some members, against targets.draTarget (see
   * DistrictSolveRequest.goal), keyed by district. Used by the one-district fallback (a group of
   * one) when the user aims for -1, 0 or +1. Members without an entry use the usual rule.
   */
  goals?: Record<number, -1 | 0 | 1>;
  solver: BorderSolver;
  weights?: Partial<CostWeights>;
  /** done / total border realizations, for the progress bar. */
  onProgress?: (done: number, total: number) => void;
  /**
   * "Re-plan from here": borders already painted by the user. Blocks listed here
   * are locked and their effect is already in `assignment`.
   */
  locked?: Uint8Array;
}

export interface GroupSolveResult extends SolveResult {
  feasibility: GroupFeasibility;
  interaction: InteractionGraph;
}
