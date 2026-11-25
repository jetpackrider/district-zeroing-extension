/**
 * Messages between the MAIN-world hook, the isolated relay content script and the panel page.
 *
 *   hook (MAIN world)  <-- private MessageChannel -->  relay (isolated)  <-- chrome.runtime Port -->  panel
 *
 * Everything is structured-clone / JSON friendly. The relay forwards both directions verbatim.
 */

/** Every DRA touchpoint the self-check probes. See src/dra/hooks.ts. */
export type HookId =
  | 'window.dra'
  | 'dra.model()'
  | 'model.fullBlockMap()'
  | 'model.districtOf()'
  | 'model.blockMapping'
  | 'model.datasetContext.primeDDS'
  | 'model.dataContext'
  | 'model.totalStatePop()'
  | 'model.redistrict.safeDistrictProps()'
  | 'model.derivedProps.aggregates'
  | 'model.datasetGetter()'
  | 'model.sm (shatter manager)'
  | 'model.redistrict.blockStamp()'
  | 'env.clientSession.on'
  | 'env.theMap';

export interface HookCheckItem {
  id: HookId;
  ok: boolean;
  /** Required hooks gate live mode; optional ones only degrade a feature. */
  required: boolean;
  detail?: string;
}

export interface SelfCheck {
  /** All required hooks passed. */
  ok: boolean;
  /** Map handle usable (otherwise the panel uses its own mini-map). */
  mapOk: boolean;
  items: HookCheckItem[];
  /** First failing required hook, for the "DRA changed" notice. */
  firstFailure?: HookId;
  /** What the hook saw on the page, for the panel's diagnostics (stays in the browser). */
  seen?: HookSeen;
}

/** Versions and names the hook read from DRA's page (diagnostics only; nothing depends on them). */
export interface HookSeen {
  /** window.mapboxgl.version (the spec expects "2.11.0"). */
  mapboxVersion?: string;
  /** Path of DRA's app bundle script, e.g. /scripts/draclient.bundle.js (no query string). */
  draBundle?: string;
  /** model.dataContext.version / .datasource / .planType as DRA reports them. */
  dataVersion?: string;
  datasource?: string;
  planType?: string;
  /** datasetContext.primeDDS, and which accessor produced it. */
  primeDDS?: string;
  primeDDSFrom?: 'datasetContext.primeDDS' | 'primaryDatasetKeysActual().CENSUS';
  /** How the map handle was found. */
  mapFrom?: 'env.theMap' | 'trapped mapboxgl.Map' | 'none';
  /** Keys present on window.dra and on the model (names only), to spot renames. */
  draKeys?: string[];
  modelKeys?: string[];
}

export interface HookDistrict {
  /** DRA district index; 0 = Unassigned. */
  index: number;
  label: string;
  /** Population exactly as DRA's district table shows it. */
  pop: number;
  /** DRA's per-district target (districtProps.targetPop). */
  target: number;
  color?: string;
  membersPer: number;
}

export interface HookMapInfo {
  state: string;
  datasource: string;
  planType: string;
  nDistricts: number;
  equalPop: boolean;
  allowMMD: boolean;
  /** model.restrictionTyped(): rt 'state' for a whole-state map, else county/city. */
  restriction: { rt: string; id: string | null; name: string } | null;
  isMapCollection: boolean;
  isMultiState: boolean;
  /** datasetContext.primeDDS, e.g. D20F / D20FA. */
  popField: string;
  totalPop: number;
  planName?: string;
}

export interface HookSnapshot {
  seq: number;
  /** Change signature (blockmap stamp + local block stamp + ...). */
  sig: string;
  info: HookMapInfo;
  /** Index 0 (Unassigned) included. */
  districts: HookDistrict[];
  /**
   * dra.model().fullBlockMap(): feature ID -> district index, including uncommitted block edits.
   * Sent in full on connect / request-snapshot; otherwise `featureDelta` against the snapshot `base`
   * (a real NY plan has ~14k features; one painted block changes one or two). The panel rebuilds
   * the full map and stores it here.
   */
  featureMap?: Record<string, number>;
  featureDelta?: { base: number; set: Record<string, number>; del: string[] };
  /** model.blockMapping.stamp; the panel re-requests the mapping when it changes. */
  blockMappingStamp: string;
  /** Precinct GEOIDs currently shattered and not yet committed (DRA's checkmark). */
  pendingShatter: string[];
  /** What the hook spends on DRA's page (main thread), for diagnostics and the real-scale test. */
  hookPerf?: HookPerf;
  /** Whether "paint this step for me" can be offered on this map right now (src/dra/hooks.ts paintAvailability). */
  paint?: PaintAvailability;
}

/**
 * Result of checking DRA's paint functions (names, arity, source fingerprints; nothing is called)
 * plus whether this map can be edited now. `apiOk` false = DRA's functions are not what the
 * extension expects: painting stays unavailable for the session.
 */
export interface PaintAvailability {
  ok: boolean;
  apiOk: boolean;
  /** Why painting is unavailable (first failing check), for the panel and the diagnostics. */
  reason?: string;
  /** Each function check, for the diagnostics. */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/** One walkthrough step to paint in DRA (the panel's WalkthroughStep, reduced to what the hook needs). */
export interface PaintStepRequest {
  stepId: string;
  precinctId: string;
  from: number;
  to: number;
  wholePrecinct: boolean;
  /** Block GEOIDs of the step. */
  blocks: string[];
}

/**
 * - painted: the plan was re-read and exactly the step's blocks moved, to exactly `to`.
 * - refused: a guard said no before anything was called; nothing changed in DRA.
 * - mismatch: DRA was called and the re-read plan differs from what was asked (or nothing changed,
 *   or DRA threw). Painting must stop; `undoHint` says whether DRA's Undo has something to take back.
 */
export type PaintResult =
  | { status: 'painted'; stepId: string; blocksMoved: number; featuresChanged: number; ms: number }
  | { status: 'refused'; stepId: string; reason: string }
  | { status: 'mismatch'; stepId: string; summary: string; details: string[]; changedSomething: boolean; undoRecorded: boolean };

export interface HookPerf {
  /** Poll ticks so far (every 300 ms), and their cost on the page's main thread. */
  ticks: number;
  tickAvgMs: number;
  tickMaxMs: number;
  tickTotalMs?: number;
  /** Cost of reading this snapshot (fullBlockMap copy, districts, info). */
  readMs: number;
  /** Cost of posting the previous snapshot onto the channel (structured clone). */
  sendMs?: number;
  /** Cost of the last full self-check. */
  selfCheckMs: number;
  /** Cost of the last block-mapping read. */
  mappingMs: number;
}

/** model.blockMapping, reversed: precinct ID -> sorted block GEOIDs (DRA's own rev() order). */
export interface HookBlockMapping {
  stamp: string;
  rev: Record<string, string[]>;
}

export interface HighlightFeatureProps {
  /**
   * 'remove' = leaves the user's district, 'add' = joins it, 'erase' = goes to Unassigned (DRA's
   * eraser; neutral grey), 'done' = painted, 'precinct' = outline to shatter, 'border' =
   * interaction-view hover.
   */
  role: 'remove' | 'add' | 'erase' | 'done' | 'precinct' | 'border' | 'preview';
  label?: string;
  geoid?: string;
}

export interface HighlightFC {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string | number;
    properties: HighlightFeatureProps;
    geometry: { type: string; coordinates: unknown };
  }>;
}

export type BBox = [number, number, number, number];

export interface HighlightStatus {
  mapPresent: boolean;
  layers: string[];
  /** Our layers are the topmost layers of the style. */
  onTop: boolean;
  featureCount: number;
  /** Features the map actually has in its tiles (querySourceFeatures). */
  rendered: number;
  labelMode: 'symbol' | 'html' | 'none';
  htmlLabels: number;
  styleLoads: number;
  raises: number;
  /** Times the highlight data was written to the map source (each one re-places the labels). */
  dataWrites: number;
}

export type HookToPanel =
  | { t: 'self-check'; check: SelfCheck; hookVersion: string }
  | { t: 'snapshot'; snap: HookSnapshot }
  | { t: 'block-mapping'; mapping: HookBlockMapping }
  | { t: 'highlight-status'; status: HighlightStatus; reqId?: number }
  | { t: 'paint-result'; reqId: number; result: PaintResult }
  | { t: 'error'; message: string }
  /** From the hook, first thing after every 'hello': it is running, whatever the self-check says. */
  | { t: 'alive'; hookVersion: string; draPresent: boolean; planOpen: boolean; readyState: string; offers: number }
  /**
   * From the relay itself (not the hook), on every panel connection and when the hook's port
   * arrives: the content script is in the tab, and whether it has the hook's end of the channel.
   */
  | { t: 'relay'; hookAttached: boolean; readyState: string; ageMs: number };

export type PanelToHook =
  | { t: 'hello' }
  | { t: 'request-snapshot' }
  | { t: 'request-block-mapping' }
  | { t: 'run-self-check' }
  | { t: 'highlight'; fc: HighlightFC; fit?: BBox }
  | { t: 'clear-highlight' }
  | { t: 'fit'; bbox: BBox }
  | { t: 'probe-highlight'; reqId?: number }
  /** Paint one walkthrough step through DRA's own actions (opt-in, one step per user click). */
  | { t: 'paint-step'; reqId: number; step: PaintStepRequest };

/** Envelope on the private MessageChannel and the runtime port, so stray messages are ignored. */
export const ZD_TAG = 'zd/v1';
export interface Envelope<T> {
  zd: typeof ZD_TAG;
  msg: T;
}
export function wrap<T>(msg: T): Envelope<T> {
  return { zd: ZD_TAG, msg };
}
export function unwrap<T>(data: unknown): T | null {
  if (data && typeof data === 'object' && (data as Envelope<T>).zd === ZD_TAG) return (data as Envelope<T>).msg;
  return null;
}

export const RUNTIME_PORT_NAME = 'zd-panel';
/**
 * DOM event the relay fires on `document` when it starts. The two content scripts both run at
 * document_start but in different worlds, and the hook's port offer is delivered asynchronously;
 * if the relay was not listening yet, the offer is lost. The event lets the hook offer once more.
 */
export const RELAY_READY_EVENT = 'zd-relay-ready';
export const HOOK_VERSION = '2';
