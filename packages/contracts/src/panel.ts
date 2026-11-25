/**
 * Side-panel view model (SPEC.md "Guiding the user").
 *
 * packages/panel-ui renders a PanelState and dispatches PanelActions; it knows
 * nothing about DRA, the hook, the worker or the bundle.
 * apps/extension implements PanelController on top of the live hook + engine worker.
 * Everything here is plain JSON-serializable data so it can cross postMessage.
 */

import type { GroupFeasibility, InteractionGraph, SolutionKind, SolutionStats, DeviationChange } from './engine';
import type { PopField } from './bundle';
import type { Clustering } from './clusters';

export interface DistrictRow {
  /** DRA district index, 1-based. 0 (Unassigned) is never listed. */
  index: number;
  /** DRA's label for the district (custom labels allowed). */
  label: string;
  pop: number;
  /** pop − DRA target, exactly as DRA shows it. */
  deviation: number;
  /** DRA's district color as a CSS color, when known. */
  color?: string;
  /**
   * Adjacent district indexes, when the bundle is loaded. Includes 0 when the district touches
   * unassigned blocks (Unassigned, see PanelState.unassigned).
   */
  neighbors?: number[];
}

export type Scope =
  /**
   * One district. `with` is the user's choice of which neighbors trade with it: an over
   * district gives to them, an under district takes from them. Absent or empty = any neighbor.
   * A neighbor the user picked may end further from zero than it started; that is their call.
   * `with` may contain 0 (Unassigned): give blocks to it, or take unassigned blocks.
   * "Any neighbor" includes Unassigned only while it holds people (PanelState.unassigned.pop > 0,
   * a map still being drawn); on a finished map it is used only when picked.
   * `goal` is the deviation to end at, exactly, against DRA's displayed target (the number in
   * DRA's Deviation column): -1, 0 or +1. Absent = "Zero", the usual rule (q or q + 1, see
   * PopTargets). Kept when the same district is picked again, like `with`; reset for another
   * district. Group and whole-map scopes have no goal.
   */
  | { mode: 'one'; district: number; with?: number[]; goal?: -1 | 0 | 1 }
  | { mode: 'group'; districts: number[]; allowOutsideAbsorb: boolean }
  | { mode: 'all' };

export type ConnectionStatus =
  /** No DRA map tab is active. */
  | 'no-tab'
  /** A DRA tab is active but no map is open in it (the map list, a profile page, ...). */
  | 'no-plan'
  | 'connecting'
  /** Reading the plan live from the DRA tab. */
  | 'live'
  /** Plan came from a dropped block-assignment CSV; no live ticking. */
  | 'csv'
  /** Hook self-check failed ("DRA changed; update pending"); CSV mode is offered. */
  | 'hook-failed'
  /** Multi-member, unequal-target, county/city, multi-state or 2010-shape map. */
  | 'unsupported-map'
  /** Bundle populations disagree with DRA's totals; suggestions are disabled. */
  | 'data-mismatch';

export interface MapInfo {
  state: string;
  planName?: string;
  numDistricts: number;
  popField: PopField;
  totalPop: number;
  /** DRA's rounded target. */
  target: number;
  /** In CSV mode, the name of the loaded file. */
  sourceName?: string;
}

/** A solution as the panel shows it: stats and flows, no block arrays. */
export interface SolutionCard {
  id: string;
  kind: SolutionKind;
  stats: SolutionStats;
  borderFlows: Array<{ from: number; to: number; people: number }>;
  deviations: DeviationChange[];
}

export interface WalkthroughBlock {
  geoid: string;
  /** Number drawn on the block on the map, 1-based within the step. */
  number: number;
  people: number;
  /** True once DRA's live plan shows the block in the target district. */
  done: boolean;
}

export interface WalkthroughStep {
  id: string;
  /**
   * Border this step belongs to. Steps are grouped by border, then precinct, and must be painted
   * in order. A border can be traded both ways (steps a → b, later steps b → a); the pair nets
   * out to the small amount that could not be moved one way, and between the two legs both
   * districts sit further from zero than when they started.
   */
  from: number;
  to: number;
  /** DRA precinct ID to shatter. */
  precinctId: string;
  /** True when the step moves the whole precinct (paint the precinct, no shatter). */
  wholePrecinct: boolean;
  blocks: WalkthroughBlock[];
  status: 'pending' | 'active' | 'awaiting-commit' | 'done';
}

export interface WalkthroughState {
  solutionId: string;
  steps: WalkthroughStep[];
  /** Index into steps. */
  current: number;
  /** Edits seen in the live plan that are not part of the walkthrough. */
  strayEdits: Array<{ geoid: string; fromDistrict: number; toDistrict: number }>;
  /**
   * Set after the last step: the plan re-read against DRA's own numbers.
   * `ok` is null when no live check is possible (CSV mode); then `deviations` holds the
   * expected result of the plan, not a reading from DRA.
   */
  finalCheck?: { ok: boolean | null; deviations: DeviationChange[] };
  /** False in CSV mode, or when the mini-map fallback is in use. */
  liveTicking: boolean;
  /** 'dra' = highlights drawn on DRA's map; 'mini' = panel's own MapLibre mini-map. */
  mapMode: 'dra' | 'mini';
}

/**
 * The area of the map where the user would like the swap to happen. They draw it on DRA's map
 * (click to add corners; double-click, or click the first corner, to finish; Esc cancels) or take
 * the part of the map in view. Remembered per map, like locks. Changing it, or its mode, drops the
 * options on offer (they were found for the old area). It cannot change during a walkthrough.
 */
export interface AreaState {
  /** The outline as drawn: one closed ring of [longitude, latitude], first point not repeated. Absent while drawing a first area, and for a region. */
  ring?: Array<[number, number]>;
  /**
   * When the area is a whole county or town rather than a drawn shape: every block in it ("find
   * balance in this county / town"). `index` is the bundle's county index or town index; `name`
   * as in the bundle's names. `ring` is absent then. Remembered per map like a drawn area.
   */
  region?: { kind: 'county' | 'town'; index: number; name: string };
  /**
   * When the area is a county cluster (clusters-use-as-area): every block of these counties
   * (bundle county indexes). `ring` and `region` are absent then. Remembered per map like the others.
   */
  cluster?: { name: string; counties: number[] };
  /** True while waiting for a click on DRA's map to pick a county or town (area-pick-region). */
  picking?: 'county' | 'town';
  /** How the solver treats it (AreaPreference.mode). Default 'prefer'. */
  mode: 'prefer' | 'only';
  /** Blocks and people inside, once the state's data (with block points) is loaded. */
  blocks?: number;
  people?: number;
  /** True while the user is drawing on the map. */
  drawing: boolean;
  /**
   * Why an area cannot be used or drawn right now, when it can't: e.g. the state's data has no
   * block points, or there is no DRA map to draw on (then "Use map view" may still work).
   */
  unavailable?: string;
}

export interface PanelState {
  connection: ConnectionStatus;
  /** One-line banner, e.g. the unsupported-map reason or a data-mismatch warning. */
  notice?: { level: 'info' | 'warn' | 'error'; text: string };
  map?: MapInfo;
  /** All districts, in DRA order. The panel sorts for display. */
  districts: DistrictRow[];
  scope: Scope;
  /**
   * Unassigned (district 0): DRA's Unassigned row. Absent when no block is unassigned. Not a
   * district: it has no deviation, is never listed in `districts`, and cannot be locked.
   */
  unassigned?: { pop: number };
  /** Present for group scope once the bundle is loaded. */
  feasibility?: GroupFeasibility;
  /** Present for group / all scope after the capacity pass. */
  interaction?: InteractionGraph;
  solve: {
    status: 'idle' | 'loading-data' | 'solving' | 'done' | 'needs-precinct-rework' | 'group-unbalanced' | 'error';
    /** 0..1 while loading data or solving. */
    progress?: number;
    message?: string;
    elapsedMs?: number;
  };
  solutions: SolutionCard[];
  hoveredSolutionId?: string;
  walkthrough?: WalkthroughState;
  /**
   * Where highlights are drawn right now: 'dra' = on DRA's map, 'mini' = no usable DRA map, so
   * the panel shows its own mini-map slot whenever there is something to show (a hovered option
   * or border, or a walkthrough step), not only during a walkthrough. Absent = 'dra'.
   */
  mapMode?: 'dra' | 'mini';
  /**
   * Painting a walkthrough step for the user. Off unless the user turns it on. `available` is
   * false when it cannot be offered at all (CSV mode, a read-only map, or DRA's paint functions
   * are not what the extension expects); `reason` then says why. `busy` while a step is being
   * painted.
   */
  autoPaint?: { available: boolean; enabled: boolean; busy?: boolean; reason?: string };
  /**
   * County clusters (see contracts/clusters.ts). Absent until the user opens the tool. The
   * district count defaults to the open map's; the user may enter another (e.g. plan a 120-seat
   * House while a congressional map is open).
   */
  clusters?: {
    status: 'idle' | 'finding' | 'done' | 'none' | 'error';
    numDistricts: number;
    /** Fraction, e.g. 0.05 for ±5%. */
    tolerance: number;
    /** People per district for numDistricts. */
    districtSize?: number;
    results: Array<Clustering & { countyNames: string[][] }>;
    exhaustive?: boolean;
    message?: string;
    elapsedMs?: number;
    /** The clustering (and cluster) highlighted on the map. */
    hovered?: { id: string; cluster?: number };
  };
  /** The area the user marked for the swap; absent = none (anywhere). See AreaState. */
  area?: AreaState;
  /**
   * Counties and towns the user can pick as an area, sorted by name. Present once the state's
   * data is loaded; `towns` is empty when the data has no towns or no names.
   */
  regions?: { counties: Array<{ index: number; name: string }>; towns: Array<{ index: number; name: string }> };
  /**
   * What the panel's Undo would undo right now; absent = nothing to undo. Only the extension's
   * own changes: a step it painted for the user (undone through DRA's own Undo, and only while
   * that paint is still the latest edit in DRA's undo history), or a panel change that threw
   * something away (Unlock all, Lock the N at zero, clearing or replacing an area). Hand-painted
   * edits are DRA's to undo.
   */
  undo?: { kind: 'paint' | 'setting'; label: string };
  /**
   * Districts the user locked (finished ones, usually). No suggestion moves a block into or out
   * of a locked district: it is never a neighbor that absorbs, and group and whole-map plans leave
   * it out. Remembered per map. Absent = none. Never contains 0 (Unassigned).
   */
  lockedDistricts?: number[];
}

export type PanelAction =
  | { type: 'set-scope'; scope: Scope }
  /** Start drawing an area on DRA's map (see AreaState). Finishing replaces any existing area. */
  | { type: 'area-draw' }
  /** Stop drawing without changing the area. */
  | { type: 'area-cancel-draw' }
  /** Make the part of the map now in view (DRA's map, or the mini-map) the area. */
  | { type: 'area-use-view' }
  /** Make a whole county or town the area (from PanelState.regions). */
  | { type: 'area-use-region'; kind: 'county' | 'town'; index: number }
  /** The next click on DRA's map picks the county or town there as the area; Esc cancels. */
  | { type: 'area-pick-region'; kind: 'county' | 'town' }
  /** Find county clusters for this many districts and tolerance (fraction). */
  | { type: 'clusters-find'; numDistricts: number; tolerance: number }
  | { type: 'clusters-cancel' }
  /** Highlight a clustering (all its clusters) or one cluster of it on the map; null clears. */
  | { type: 'clusters-hover'; id: string | null; cluster?: number }
  /** Make one cluster the swap area (sets AreaState.cluster with its counties listed). */
  | { type: 'clusters-use-as-area'; id: string; cluster: number }
  /** Undo what PanelState.undo describes. Ignored when it is absent. */
  | { type: 'undo' }
  /** Remove the area: moves may happen anywhere again. */
  | { type: 'area-clear' }
  | { type: 'set-area-mode'; mode: 'prefer' | 'only' }
  /** Lock or unlock districts (see PanelState.lockedDistricts). Ignored during a walkthrough. */
  | { type: 'set-district-lock'; districts: number[]; locked: boolean }
  | { type: 'solve' }
  /** Abandon a running solve (long whole-map plans). No effect when nothing is running. */
  | { type: 'cancel-solve' }
  | { type: 'hover-solution'; id: string | null }
  /** Highlight one border on DRA's map from the interaction view. */
  | { type: 'hover-border'; a: number; b: number } | { type: 'hover-border'; a: null; b: null }
  | { type: 'start-walkthrough'; solutionId: string }
  | { type: 'walkthrough-next' }
  | { type: 'walkthrough-back' }
  /** Go straight to a step (index into WalkthroughState.steps). Painting out of order is allowed. */
  | { type: 'walkthrough-jump'; index: number }
  | { type: 'walkthrough-zoom' }
  | { type: 'walkthrough-replan' }
  /** Turn "paint the step for me" on or off. */
  | { type: 'set-auto-paint'; enabled: boolean }
  /** Paint the current step's blocks in DRA. Only when autoPaint is available and enabled; one step per user click. */
  | { type: 'walkthrough-paint-step' }
  | { type: 'walkthrough-end' }
  /**
   * CSV mode: the text of a DRA block-assignment CSV (header GEOID20,District). Allowed in any
   * connection state, including 'live'; 'retry-connection' goes back to the live tab.
   */
  | { type: 'load-csv'; text: string; fileName: string }
  | { type: 'retry-connection' };

export interface PanelController {
  getState(): PanelState;
  /** Calls `listener` after every state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  dispatch(action: PanelAction): void;
}
