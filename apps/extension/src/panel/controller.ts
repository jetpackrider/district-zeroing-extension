/**
 * PanelController on top of the live hook (via TabLink), the bundle and the engine Worker.
 * packages/panel-ui renders getState() and dispatches PanelActions here.
 */
import {
  computeTargets,
  isZeroed,
  UNASSIGNED,
  type AreaPreference,
  type AreaState,
  type BundleSource,
  type EngineGraph,
  type GroupFeasibility,
  type InteractionGraph,
  type PanelAction,
  type PanelController,
  type PanelState,
  type PopField,
  type PopTargets,
  type Scope,
  type Solution,
  type SolutionCard,
  type StateBundle,
  type WalkthroughState,
} from '@zd/contracts';
import { createBundleSource, geoidIndex, toEngineGraph, type AppBundleSource, type CountyOutlines } from '../adapters/bundle';
import { areaCluster, clusterColors, clusterFeatures, clusterMask, clusterRequest, clusterUnavailable, countyAdjacency, countyNames, withCountyNames } from './clusters';
import type { PanelHost } from '../shared/panel-host';
import { areaSolveMessage, cleanRing, splitAreaSentences, countInside, insideMask, listRegions, nearestBlock, regionName, type AreaMode, type AreaRegion, type AreaSelection, type Ring, type SavedArea } from './area';
import { HOOK_VERSION, type AreaRing, type BBox, type ClusterFC, type HighlightFC, type HookBlockMapping, type HookSnapshot, type HookToPanel, type HighlightStatus, type PaintResult, type PaintStepRequest, type SelfCheck, type UndoPaintResult } from '../shared/protocol';
import {
  activeUndoEntry,
  afterPaintUndone,
  clearPaintUndo,
  clearSettingUndo,
  cloneSavedArea,
  currentUndo,
  emptyUndo,
  lockUndoLabel,
  paintUndoLabel,
  reconcileDraSnapshot,
  recordPaintUndo,
  recordSettingUndo,
  type PaintUndoEntry,
  type SettingUndoEntry,
  type UndoContext,
  type UndoTrackerState,
} from './undo';
import { buildLiveMapping, districtPops, featureMapToAssignment, unassignedOf, type LiveMapping } from './assignment';
import { labelIndexes, parseBlockCsv, stateFromGeoid } from './csv';
import { CancelledError, EngineClient } from './engine-client';
import { GeometryCache, type AreaSink, type ClusterSink, type HighlightItem, type HighlightSink } from './highlights';
import { detectUnsupported } from './scope';
import { TabLink, type LinkStatus } from './tab-link';
import { allStepsDone, applyTargets, buildSteps, deviationChanges, tickWalkthrough, type WalkPlan } from './walkthrough';
import { buildDiagnostics, type DiagnosticsInput } from './diagnostics';
import type { WorkerResponse } from '../worker/protocol';
import { formatGoal, joinDistrictNames, oneDistrictTrade, sanitizeScope, solveDistrictMessage, withoutLocked } from '../worker/choice';

type Source = 'live' | 'csv';

export interface ControllerOptions {
  host: PanelHost;
  tabId: number | null;
  dataBaseUrl: string;
  /** The remembered "paint the step for me" setting (off unless the user turned it on), and how to save it. */
  autoPaint?: { enabled: boolean; save: (enabled: boolean) => void };
  /**
   * Remembered district locks, per map (see `lockKey`), and how to save them. Without it locks
   * last as long as the panel is open.
   */
  locks?: { saved: Record<string, number[]>; save: (all: Record<string, number[]>) => void };
  /**
   * Remembered areas (PanelState.area), per map under the same key as the locks, and how to save
   * them. Without it an area lasts as long as the panel is open.
   */
  areas?: { saved: Record<string, SavedArea>; save: (all: Record<string, SavedArea>) => void };
}

/** How long the panel waits for DRA's map to say what is in view ("Use map view"). */
const VIEW_TIMEOUT_MS = 3000;
/** The self-check item for what area drawing needs from DRA's map (src/dra/hooks.ts). */
const AREA_DRAW_HOOK = 'map.unproject() (area drawing)';

/** How long the panel waits for the hook to report a paint (the hook itself gives up after ~8 s). */
const PAINT_TIMEOUT_MS = 30_000;

const INITIAL: PanelState = {
  connection: 'connecting',
  districts: [],
  scope: { mode: 'all' },
  solve: { status: 'idle' },
  solutions: [],
};

export class ExtensionController implements PanelController {
  private state: PanelState = INITIAL;
  private listeners = new Set<() => void>();
  readonly link: TabLink;
  private bundleSource: AppBundleSource;
  private engine: EngineClient | null = null;
  private engineGraphFor = '';

  // Live inputs
  private check: SelfCheck | null = null;
  private snap: HookSnapshot | null = null;
  private mappingStampRequested = '';
  private live: LiveMapping | null = null;
  private source: Source = 'live';

  // Data
  private bundle: StateBundle | null = null;
  private bundleState: string | null = null;
  private bundleLoading: Promise<StateBundle> | null = null;
  private geo: GeometryCache | null = null;
  private graph: EngineGraph | null = null;
  private popField: PopField = 'D20F';
  private assignment: Uint16Array | null = null;
  private targets: PopTargets | null = null;
  private mismatchChecked = '';
  private unresolved: string[] = [];

  // Solving / walkthrough
  private full = new Map<string, Solution>();
  private plan: WalkPlan | null = null;
  private solveSeq = 0;
  private scopeSeq = 0;
  private lastShownStep = -1;
  private highlightSeq = 0;
  private progressEvents = 0;
  /** District locks per map, keyed by `lockKey`. The current map's are mirrored in state.lockedDistricts. */
  private locks: Record<string, number[]> = {};
  /** Test builds only: make the worker busy before each solve (cancel tests). */
  private testSolveDelayMs = 0;

  // The area where the user would like the swap to happen (PanelState.area)
  /** Areas per map, keyed by `lockKey`. The current map's is mirrored in state.area. */
  private areas: Record<string, SavedArea> = {};
  /** True from 'area-draw' until the hook reports an outline or the drawing is stopped. */
  private areaDrawing = false;
  private areaPick: { kind: AreaRegion['kind']; reqId: number } | undefined;
  private bundleRegions: PanelState['regions'];
  /** The mode chosen while there is no area yet (used for the next one). */
  private areaPendingMode: AreaMode = 'prefer';
  /**
   * Which blocks the current area holds (AreaPreference.inside), built once per area and bundle,
   * plus the people in them for the population column last asked for.
   */
  private areaMaskCache: { bundle: StateBundle; key: string; inside: Uint8Array; blocks: number; peopleField: PopField | null; people: number } | null = null;
  /** The ring last sent to DRA's map and the mini-map (JSON; '' = none; null = send again). */
  private areaShown: string | null = null;
  private miniArea: AreaSink | null = null;
  /**
   * The block points (StateBundle.points) are read only once an area needs them (see
   * adapters/bundle.ts): the read in progress for the loaded bundle, and why it failed, if it did.
   */
  private pointsLoad: { bundle: StateBundle; promise: Promise<Int32Array | undefined> } | null = null;
  private pointsError: { bundle: StateBundle; message: string } | null = null;
  /** The notice put up when "Re-plan from here" found nothing (taken down by the next one that works). */
  private replanNotice: string | null = null;
  // County clusters (PanelState.clusters): the search in flight, the outlines drawn on hover.
  private clustersSeq = 0;
  private clusterHoverSeq = 0;
  /** Why the outlines cannot be drawn (no outlines in the data, or they failed to load), for the clusters' message. */
  private clustersNote: string | undefined;
  /** The message the search came back with (PanelState.clusters.message is it plus clustersNote). */
  private clustersResultMessage: string | undefined;
  /** The county outlines read for a state; `failed` is the note to show while they are missing. */
  private outlinesLoad: { bundle: StateBundle; promise: Promise<CountyOutlines | undefined>; failed?: string } | null = null;
  private countyAdj: { graph: EngineGraph; adj: number[][] } | null = null;
  /** The cluster picture on the maps (null = none), kept to put back after a reconnect or on the mini-map. */
  private clusterShown: ClusterFC | null = null;
  private miniClusters: ClusterSink | null = null;
  private viewWaiters = new Map<number, (ring: AreaRing | null) => void>();
  private viewSeq = 0;

  // Painting a step for the user (opt-in; see src/dra/hooks.ts paintStep)
  /** The user's remembered choice. What the panel shows is this AND available. */
  private autoPaintPref = false;
  private paintBusy = false;
  /** Set after a paint that did not do what was asked: painting stays off for this panel session. */
  private paintBroken: string | null = null;
  /** Why the last paint of a step was refused (shown with that step only). */
  private paintNote: { stepId: string; text: string } | null = null;
  private paintSeq = 0;
  private paintWaiter: { reqId: number; stepId: string; stepIndex: number; step: PaintStepRequest; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Last paint outcome, for the diagnostics. */
  private lastPaint: string | null = null;

  // Panel Undo (PanelState.undo): consecutive extension paints in DRA, or latest destructive setting change.
  private undoState: UndoTrackerState = emptyUndo();
  private undoBusy = false;
  private undoSeq = 0;
  private undoWaiter: { reqId: number; entry: PaintUndoEntry; timer: ReturnType<typeof setTimeout> } | null = null;

  // Map sinks
  private hookSink: HighlightSink;
  private miniSink: HighlightSink | null = null;
  private lastHighlight: { fc: HighlightFC; fit?: BBox } | null = null;
  private probeWaiters = new Map<number, (s: HighlightStatus) => void>();
  private probeSeq = 0;

  // Diagnostics and timings (local only; see diagnostics.ts)
  private hookVersion: string | null = null;
  /** Last exception the page hook reported (it would otherwise vanish in DRA's console). */
  private hookError: string | null = null;
  /** The link-stage notice currently shown, so it can be cleared when the stage moves on. */
  private linkNotice: string | null = null;
  private popCheck: DiagnosticsInput['popCheck'] = null;
  private csvInfo: { fileName: string; rows: number; missing: number; labels: number } | null = null;
  private lastLivePopField = new Map<string, PopField>();
  /**
   * DRA dataset keys that are not one of the bundle's column names (seen live: a UUID such as
   * "48eb784a-….ds"), mapped to the bundle column whose district totals equal DRA's exactly.
   * Keyed `${state}|${draField}`. Filled by checkMismatch; the numbers decide, not the name.
   */
  private fieldAlias = new Map<string, PopField>();
  private columnFor(state: string, draField: string): PopField {
    if (draField === 'D20F' || draField === 'D20FA') return draField;
    return this.fieldAlias.get(`${state}|${draField}`) ?? 'D20F';
  }
  private diagListeners = new Set<() => void>();
  readonly perf = {
    snapshots: 0,
    lastSnapshotMs: 0,
    maxSnapshotMs: 0,
    totalSnapshotMs: 0,
    lastRecomputeMs: 0,
    maxRecomputeMs: 0,
    mappingMs: 0,
    mappingBlocks: 0,
    graphMs: 0,
    lastSolveMs: 0,
    lastSolveWorkerMs: 0,
    lastCancelMs: 0,
    lastHoverMs: 0,
    lastStepMs: 0,
    tableReadyAt: 0,
    bundleMs: 0,
    /** Building the area's inside mask (once per ring). */
    areaMaskMs: 0,
    /** Reading the block points (once per state, when an area first needs them). */
    pointsMs: 0,
    /** Reading the county outlines (once per state, when clusters are first drawn). */
    outlinesMs: 0,
    startedAt: performance.now(),
  };

  constructor(private readonly opts: ControllerOptions) {
    this.bundleSource = createBundleSource(opts.dataBaseUrl);
    this.autoPaintPref = opts.autoPaint?.enabled === true;
    this.locks = { ...(opts.locks?.saved ?? {}) };
    this.areas = { ...(opts.areas?.saved ?? {}) };
    this.link = new TabLink(opts.host, opts.tabId, (m) => this.onHookMessage(m), (s) => this.onLinkStatus(s));
    this.hookSink = {
      show: (fc, fit) => this.link.send({ t: 'highlight', fc, fit }),
      clear: () => this.link.send({ t: 'clear-highlight' }),
      fit: (bbox) => this.link.send({ t: 'fit', bbox }),
    };
  }

  start() {
    void this.link.start();
  }

  // ---------------------------------------------------------------------------
  // PanelController
  // ---------------------------------------------------------------------------

  getState(): PanelState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(action: PanelAction): void {
    switch (action.type) {
      case 'set-scope':
        this.setScope(action.scope);
        break;
      case 'set-district-lock':
        this.setDistrictLock(action.districts, action.locked);
        break;
      case 'area-draw':
        this.areaDraw();
        break;
      case 'area-cancel-draw':
        this.areaCancelDraw();
        break;
      case 'area-use-view':
        void this.areaUseView();
        break;
      case 'area-use-region':
        this.areaUseRegion(action.kind, action.index);
        break;
      case 'area-pick-region':
        this.areaPickRegion(action.kind);
        break;
      case 'area-clear':
        this.areaClear();
        break;
      case 'undo':
        this.undo();
        break;
      case 'set-area-mode':
        this.setAreaMode(action.mode);
        break;
      case 'clusters-find':
        this.clustersFind(action.numDistricts, action.tolerance);
        break;
      case 'clusters-cancel':
        void this.clustersCancel();
        break;
      case 'clusters-hover':
        void this.clustersHover(action.id, action.cluster);
        break;
      case 'clusters-use-as-area':
        this.clustersUseAsArea(action.id, action.cluster);
        break;
      case 'solve':
        if (this.paintBusy || this.undoBusy) break; // never solve under a paint or undo in flight
        void this.solve();
        break;
      case 'cancel-solve':
        void this.cancelSolve();
        break;
      case 'walkthrough-jump':
        this.jumpTo(action.index);
        break;
      case 'hover-solution':
        void this.hoverSolution(action.id);
        break;
      case 'hover-border':
        void this.hoverBorder(action.a, action.b);
        break;
      case 'start-walkthrough':
        this.startWalkthrough(action.solutionId);
        break;
      case 'walkthrough-next':
        this.moveStep(+1);
        break;
      case 'walkthrough-back':
        this.moveStep(-1);
        break;
      case 'walkthrough-zoom':
        void this.showCurrentStep(true);
        break;
      case 'walkthrough-replan':
        if (this.paintBusy || this.undoBusy) break; // never re-plan under a paint or undo in flight
        void this.replan();
        break;
      case 'set-auto-paint':
        this.setAutoPaint(action.enabled);
        break;
      case 'walkthrough-paint-step':
        this.paintCurrentStep();
        break;
      case 'walkthrough-end':
        this.endWalkthrough();
        break;
      case 'load-csv':
        void this.loadCsv(action.text, action.fileName);
        break;
      case 'retry-connection':
        this.retry();
        break;
    }
  }

  private set(patch: Partial<PanelState>) {
    const next = { ...this.state, ...patch };
    // Where highlights go is derived from the link + self-check; keep both copies in sync.
    const mode = this.mapMode();
    if (next.mapMode !== mode) next.mapMode = mode;
    if (next.walkthrough && next.walkthrough.mapMode !== mode) next.walkthrough = { ...next.walkthrough, mapMode: mode };
    // "Paint the step for me" is derived too: available only on a live, editable map whose paint
    // functions passed the hook's check, and never enabled unless the user turned it on.
    const ap = this.autoPaintState(next);
    if (JSON.stringify(ap) !== JSON.stringify(next.autoPaint)) next.autoPaint = ap;
    // Locks belong to the map: a different map shows its own.
    const locks = next.map ? (this.locks[lockKey(next.map)] ?? []).filter((d) => d >= 1 && d <= next.map!.numDistricts) : [];
    if (JSON.stringify(locks) !== JSON.stringify(next.lockedDistricts ?? [])) next.lockedDistricts = locks;
    // Drawing stops by itself when it can no longer go on: a walkthrough started, the panel went to
    // CSV mode, the data has no block points, DRA's map went out of reach. Otherwise the page
    // would keep taking clicks for an outline the panel can no longer use.
    if ((this.areaDrawing || this.areaPick) && (next.walkthrough || this.areaUnavailable(next, 'draw'))) {
      this.areaDrawing = false;
      this.areaPick = undefined;
      this.link?.send({ t: 'area-draw-cancel' });
    }
    next.regions = next.connection === 'live' && this.bundle && next.map?.state === this.bundle.manifest.state ? this.bundleRegions : undefined;
    // So does the area, with what is inside it and why it can't be used, when it can't.
    const area = this.areaState(next);
    if (JSON.stringify(area) !== JSON.stringify(next.area)) next.area = area;
    // The panel's single Undo (latest extension paint still at the top of DRA's undo stack, or latest destructive setting).
    const undo = currentUndo(this.undoState, this.undoContext(next));
    if (JSON.stringify(undo) !== JSON.stringify(next.undo)) next.undo = undo;
    this.state = next;
    this.syncAreaOutline();
    for (const l of this.diagListeners) {
      try {
        l();
      } catch {
        /* */
      }
    }
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Connection and live data
  // ---------------------------------------------------------------------------

  private onLinkStatus(s: LinkStatus) {
    // A (re)connected page may have lost the area outline (reload): send it again. A page that
    // went away took any drawing with it.
    if (s.kind === 'connected') this.areaShown = null;
    else {
      this.areaDrawing = false;
      this.areaPick = undefined;
    }
    if (this.source === 'csv') {
      if (s.kind !== 'connected') this.check = null;
      this.set({}); // map mode may change
      return;
    }
    if (s.kind === 'no-tab') {
      this.check = null;
      this.snap = null;
      this.undoState = emptyUndo();
      this.set({ connection: 'no-tab', notice: { level: 'info', text: 'Open a map on davesredistricting.org in this window, or drop a DRA block-assignment CSV here.' } });
    } else if (s.kind === 'connecting' && (this.state.connection === 'no-tab' || this.state.connection === 'no-plan')) {
      this.set({ connection: 'connecting', notice: undefined });
      this.applyLinkNotice();
    } else {
      this.set({});
      this.applyLinkNotice();
      // The page takes highlights off when its panel disconnects; after a reconnect to the same
      // page, put back what was showing.
      if (s.kind === 'connected' && this.lastHighlight && this.mapMode() === 'dra') this.hookSink.show(this.lastHighlight.fc);
      if (s.kind === 'connected' && this.clusterShown) this.link.send({ t: 'clusters-show', fc: this.clusterShown });
    }
  }

  /**
   * While connecting, say which link of tab -> content script -> page hook is missing. Without
   * this the panel just says "Connecting" forever when the tab was opened before the extension
   * was installed or reloaded (content scripts only attach when a page loads).
   */
  private applyLinkNotice() {
    if (this.source === 'csv') return;
    const stage = this.link.status.kind === 'connecting' ? this.link.stage() : 'hook';
    const text =
      stage === 'no-content-script'
        ? "The extension isn't attached to this tab: the tab was open before the extension was installed or reloaded. Reload the DRA tab."
        : stage === 'relay-only'
          ? "The extension is attached to this tab but its page hook didn't start. Reload the DRA tab; if this message stays, copy the diagnostics below."
          : null;
    if (text === this.linkNotice) return;
    const mine = this.linkNotice !== null && this.state.notice?.text === this.linkNotice;
    this.linkNotice = text;
    if (text) this.set({ notice: { level: 'warn', text } });
    else if (mine) this.set({ notice: undefined });
  }

  private onHookMessage(m: HookToPanel) {
    switch (m.t) {
      case 'self-check':
        this.hookVersion = m.hookVersion;
        this.onSelfCheck(m.check);
        break;
      case 'snapshot':
        this.onSnapshot(m.snap);
        break;
      case 'block-mapping':
        void this.onBlockMapping(m.mapping);
        break;
      case 'highlight-status': {
        const w = m.reqId !== undefined ? this.probeWaiters.get(m.reqId) : undefined;
        if (w && m.reqId !== undefined) {
          this.probeWaiters.delete(m.reqId);
          w(m.status);
        }
        break;
      }
      case 'alive':
        this.hookVersion = m.hookVersion;
        this.set({});
        break;
      case 'paint-result':
        this.onPaintResult(m.reqId, m.result);
        break;
      case 'undo-result':
        this.onUndoResult(m.reqId, m.result);
        break;
      case 'area-drawn':
        this.onAreaDrawn(m.ring);
        break;
      case 'area-picked':
        void this.onAreaPicked(m);
        break;
      case 'area-draw-ended':
        if (!this.areaDrawing) break;
        this.areaDrawing = false;
        this.set(m.reason === 'unavailable' ? { notice: { level: 'warn', text: `Drawing an area could not start: ${m.detail ?? "DRA's map is not ready."} "Use map view" may still work.` } } : {});
        break;
      case 'view': {
        const w = this.viewWaiters.get(m.reqId);
        if (w) {
          this.viewWaiters.delete(m.reqId);
          w(m.ring);
        }
        break;
      }
      case 'error':
        console.warn('[zd] hook error', m.message);
        this.hookError = m.message;
        // Only interrupt the user with it while nothing is working yet.
        if (this.source === 'live' && this.state.connection === 'connecting') {
          this.set({ notice: { level: 'error', text: `The page hook hit an error on this page: ${m.message.split('\n')[0]}. Copy the diagnostics below.` } });
        } else this.set({});
        break;
    }
  }

  private onSelfCheck(check: SelfCheck) {
    this.check = check;
    if (this.source === 'csv') {
      this.set({});
      return;
    }
    if (!check.ok) {
      const f = check.items.find((i) => i.id === check.firstFailure);
      // "no plan open": a DRA tab without a map (map list, profile, home). Not a hook failure.
      if (f?.id === 'dra.model()' && f.detail?.startsWith('no plan open')) {
        this.enterNoPlan();
        return;
      }
      this.set({
        connection: 'hook-failed',
        notice: { level: 'error', text: `DRA changed; update pending. Hook that failed: ${f?.id ?? 'unknown'}${f?.detail ? ` (${f.detail})` : ''}. You can drop DRA's block-assignment CSV here instead.` },
      });
      return;
    }
    const c = this.state.connection;
    if (c === 'hook-failed' || c === 'no-tab' || c === 'no-plan') this.set({ connection: 'connecting', notice: undefined });
    else this.set({});
  }

  /** A DRA tab with no map open: drop everything derived from the last plan. */
  private enterNoPlan() {
    if (this.state.connection === 'no-plan') return;
    if (this.state.walkthrough) this.endWalkthrough();
    this.areaCancelDraw();
    this.snap = null;
    this.undoState = emptyUndo();
    this.resetDerived();
    this.solveSeq++;
    this.set({
      connection: 'no-plan',
      notice: { level: 'info', text: 'Open one of your maps in DRA to start, or drop a DRA block-assignment CSV here.' },
      map: undefined,
      districts: [],
      unassigned: undefined,
      solutions: [],
      hoveredSolutionId: undefined,
      feasibility: undefined,
      interaction: undefined,
      walkthrough: undefined,
      solve: this.state.solve.status === 'loading-data' ? this.state.solve : { status: 'idle' },
    });
  }

  /** The full feature map as of snapshot `featureSeq` (the hook sends deltas against it). */
  private features: Record<string, number> | null = null;
  private featureSeq = -1;

  private onSnapshot(snap: HookSnapshot) {
    if (this.source === 'csv') return;
    const t0 = performance.now();
    if (snap.featureMap) {
      this.features = snap.featureMap;
    } else if (snap.featureDelta && this.features && snap.featureDelta.base === this.featureSeq) {
      for (const k of snap.featureDelta.del) delete this.features[k];
      Object.assign(this.features, snap.featureDelta.set);
    } else {
      // Missed a base (reconnect, a second panel): ask for the whole map again.
      this.features = null;
      this.featureSeq = -1;
      this.link.send({ t: 'request-snapshot' });
      return;
    }
    this.featureSeq = snap.seq;
    snap = { ...snap, featureMap: this.features, featureDelta: undefined };
    const prev = this.snap;
    this.snap = snap;
    const info = snap.info;
    const target = snap.districts[1]?.target ?? Math.round(info.totalPop / Math.max(1, info.nDistricts));
    const prevRows = new Map(this.state.districts.map((r) => [r.index, r]));
    const rows = snap.districts
      .filter((d) => d.index > 0)
      .map((d) => {
        const old = prevRows.get(d.index);
        const deviation = d.pop - d.target;
        // Keep row identity when nothing changed (cheap re-renders on big maps).
        if (old && old.pop === d.pop && old.deviation === deviation && old.label === d.label && old.color === d.color) return old;
        return { index: d.index, label: d.label, pop: d.pop, deviation, color: d.color, neighbors: old?.neighbors };
      });
    const map: PanelState['map'] = { state: info.state, planName: info.planName, numDistricts: info.nDistricts, popField: this.columnFor(info.state, info.popField), totalPop: info.totalPop, target };
    this.targets = computeTargets(info.totalPop, info.nDistricts);
    if (info.popField === 'D20F' || info.popField === 'D20FA') this.lastLivePopField.set(info.state, info.popField);

    const unsupported = detectUnsupported(info, snap.districts);
    if (unsupported) {
      this.set({ connection: 'unsupported-map', notice: { level: 'warn', text: unsupported.text }, map, districts: rows });
      return;
    }
    const patch: Partial<PanelState> = { districts: rows };
    // Until the bundle gives a block-level assignment (recompute), DRA's own Unassigned row decides.
    if (!this.assignment) {
      const pop = snap.districts.find((d) => d.index === UNASSIGNED)?.pop ?? 0;
      const unassigned = pop > 0 ? { pop } : undefined;
      if (JSON.stringify(unassigned) !== JSON.stringify(this.state.unassigned)) patch.unassigned = unassigned;
    }
    const sameMap = this.state.map && JSON.stringify(this.state.map) === JSON.stringify(map);
    if (!sameMap) patch.map = map;
    const c = this.state.connection;
    if (c === 'connecting' || c === 'unsupported-map' || c === 'no-tab' || c === 'no-plan') {
      patch.connection = 'live';
      patch.notice = undefined;
    }
    // Plan changed under us (another map opened): drop everything derived.
    if (prev && (prev.info.state !== info.state || prev.info.nDistricts !== info.nDistricts || prev.sig.split('|')[0] !== snap.sig.split('|')[0])) {
      const keep = [this.features, this.featureSeq] as const;
      this.areaCancelDraw(); // the outline would land on the other map
      this.undoState = emptyUndo();
      this.resetDerived();
      [this.features, this.featureSeq] = keep;
      patch.solutions = [];
      patch.walkthrough = undefined;
    } else if (!this.paintBusy && !this.undoBusy) {
      // Withdraw paint undo immediately if DRA's undo position moved or the user shattered a precinct by hand.
      this.undoState = reconcileDraSnapshot(this.undoState, {
        seq: snap.seq,
        undoPos: snap.undoPos,
        undoTopId: snap.undoTopId,
        pendingShatter: snap.pendingShatter,
      });
    }
    this.set(patch);
    void this.ensureData(info.state, info.popField);
    if (snap.blockMappingStamp !== this.mappingStampRequested) {
      this.mappingStampRequested = snap.blockMappingStamp;
      this.link.send({ t: 'request-block-mapping' });
    }
    this.recompute();
    const ms = performance.now() - t0;
    this.perf.snapshots++;
    this.perf.lastSnapshotMs = ms;
    this.perf.totalSnapshotMs += ms;
    if (ms > this.perf.maxSnapshotMs) this.perf.maxSnapshotMs = ms;
  }

  private resetDerived() {
    this.features = null;
    this.featureSeq = -1;
    this.live = null;
    this.assignment = null;
    this.mappingStampRequested = '';
    this.mismatchChecked = '';
    this.full.clear();
    this.plan = null;
    this.lastHighlight = null;
  }

  private async ensureData(state: string, popField: string) {
    this.popField = this.columnFor(state, popField);
    if (this.bundle && this.bundleState === state) return this.bundle;
    if (this.bundleLoading && this.bundleState === state) return this.bundleLoading;
    this.bundleState = state;
    this.bundle = null;
    // County clusters belong to the state they were found for.
    this.dropClusters();
    this.set({ solve: { status: 'loading-data', progress: 0, message: `Loading ${state} data…` }, clusters: undefined });
    const t0 = performance.now();
    this.bundleLoading = this.bundleSource.loadState(state, (loaded, total) => {
      if (total > 0) this.set({ solve: { status: 'loading-data', progress: loaded / total, message: `Loading ${state} data…` } });
    });
    try {
      const b = await this.bundleLoading;
      if (this.bundleState !== state) return b;
      this.perf.bundleMs = performance.now() - t0;
      this.bundle = b;
      this.bundleRegions = listRegions(b);
      this.geo = new GeometryCache(this.bundleSource, b);
      this.set({ solve: { status: 'idle' } });
      this.recompute();
      return b;
    } catch (e) {
      this.bundleLoading = null;
      this.set({ solve: { status: 'error', message: `Could not load the ${state} data bundle: ${e instanceof Error ? e.message : String(e)}` } });
      return null;
    }
  }

  private async onBlockMapping(mapping: HookBlockMapping) {
    const b = this.bundle ?? (this.bundleState ? await this.bundleLoading?.catch(() => null) : null);
    if (!b) {
      // Bundle not ready; ask again once it is.
      this.mappingStampRequested = '';
      return;
    }
    if (this.source !== 'live') return;
    const t0 = performance.now();
    this.live = buildLiveMapping(mapping, b.n, (g) => geoidIndex(b, g), b.precinctIds, b.precinctOf);
    this.perf.mappingMs = performance.now() - t0;
    this.perf.mappingBlocks = b.n - this.live.unmappedBlocks;
    this.mismatchChecked = '';
    this.recompute();
  }

  private indexOf = (g: string) => (this.bundle ? geoidIndex(this.bundle, g) : -1);

  /** Recompute the live assignment and everything that depends on it. */
  private recompute() {
    if (this.source !== 'live') return;
    const b = this.bundle;
    const snap = this.snap;
    if (!b || !snap || !this.live) return;
    const t0 = performance.now();
    const res = featureMapToAssignment(snap.featureMap ?? {}, this.live, b.n, this.indexOf);
    this.assignment = res.assignment;
    this.unresolved = res.unresolved;
    this.ensureGraph();
    this.checkMismatch();
    this.syncUnassigned();
    this.updateNeighbors();
    this.tick();
    const ms = performance.now() - t0;
    this.perf.lastRecomputeMs = ms;
    if (ms > this.perf.maxRecomputeMs) this.perf.maxRecomputeMs = ms;
    if (!this.perf.tableReadyAt && this.state.connection === 'live') this.perf.tableReadyAt = performance.now();
  }

  private ensureGraph() {
    const b = this.bundle;
    if (!b) return;
    const key = `${b.manifest.state}|${this.popField}|${this.live?.stamp ?? 'bundle'}`;
    if (this.engineGraphFor === key && this.graph) return;
    const t0 = performance.now();
    const precinctOf = this.live?.precinctOf ?? b.precinctOf;
    this.graph = toEngineGraph(b, this.popField, precinctOf);
    this.engineGraphFor = key;
    if (!this.engine) this.engine = new EngineClient();
    void this.engine.init(this.graph).catch(() => {});
    this.perf.graphMs = performance.now() - t0;
    if (this.state.scope.mode !== 'one') this.refreshInteraction();
  }

  /** SPEC: compare bundle populations per district against DRA's totals; refuse to suggest on a mismatch. */
  private checkMismatch() {
    const b = this.bundle;
    const snap = this.snap;
    const a = this.assignment;
    if (!b || !snap || !a || snap.pendingShatter.length) return;
    const key = `${this.live?.stamp}|${snap.info.popField}`;
    if (this.mismatchChecked === key) return;
    this.mismatchChecked = key;
    const k = snap.info.nDistricts;
    const problems: string[] = [];
    const rows: NonNullable<DiagnosticsInput['popCheck']>['rows'] = [];
    let bundleTotal = 0;
    const draField = snap.info.popField;
    const named = draField === 'D20F' || draField === 'D20FA';
    let fieldNote = named ? `DRA field ${draField}` : '';
    if (!named) {
      // DRA names the dataset with a key the bundle doesn't know (a per-map or custom dataset id).
      // The name proves nothing either way, so let the numbers decide: use the bundle column whose
      // totals equal DRA's for every district. If neither does, this really is different data.
      const fits = (['D20F', 'D20FA'] as PopField[]).filter((f) => {
        const pops = districtPops(b.pop[f], a, k);
        return snap.districts.every((d) => d.index > k || pops[d.index] === d.pop);
      });
      const pick = fits.includes(this.popField) ? this.popField : fits[0];
      if (!pick) {
        problems.push(`DRA is using its own population dataset for this map (${draField}), and neither population column in the data bundle matches its district totals`);
        fieldNote = `DRA field ${draField}: matches neither bundle column (differences below are against ${this.popField})`;
      } else {
        fieldNote = `DRA field ${draField}: not a bundle column name; matched by numbers to ${fits.join(' and ')}, using ${pick}`;
        this.fieldAlias.set(`${snap.info.state}|${draField}`, pick);
        if (pick !== this.popField) {
          this.popField = pick;
          this.ensureGraph();
        }
        if (this.state.map && this.state.map.popField !== pick) this.set({ map: { ...this.state.map, popField: pick } });
      }
    }
    {
      const pops = districtPops(b.pop[this.popField], a, k);
      for (const d of snap.districts) {
        if (d.index > k) continue;
        bundleTotal += pops[d.index];
        rows.push({ index: d.index, label: d.label, dra: d.pop, bundle: pops[d.index] });
        if (pops[d.index] !== d.pop) problems.push(`${d.index === 0 ? 'Unassigned' : `District ${d.label}`}: DRA ${d.pop.toLocaleString('en-US')}, data ${pops[d.index].toLocaleString('en-US')}`);
      }
    }
    this.popCheck = { field: this.popField, fieldNote, draTotal: snap.info.totalPop, bundleTotal, rows, unresolved: this.unresolved.slice(0, 20), unresolvedCount: this.unresolved.length, unknownGeoids: this.live?.unknownGeoids ?? 0, unmappedBlocks: this.live?.unmappedBlocks ?? 0 };
    if (this.unresolved.length) problems.push(`${this.unresolved.length} map features couldn't be resolved to blocks (e.g. ${this.unresolved[0]})`);
    if (problems.length) {
      this.set({
        connection: 'data-mismatch',
        notice: { level: 'warn', text: `The data bundle disagrees with DRA, so suggestions are off. ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}.` },
        solutions: [],
      });
    } else if (this.state.connection === 'data-mismatch' || this.state.connection === 'connecting') {
      this.set({ connection: 'live', notice: undefined });
    }
  }

  /**
   * PanelState.unassigned: present while some block is unassigned. Live, its people are DRA's
   * Unassigned row (the mismatch check holds the bundle to it); CSV, the bundle's count.
   */
  private syncUnassigned() {
    const a = this.assignment;
    const b = this.bundle;
    if (!a || !b) return;
    const u = unassignedOf(b.pop[this.popField], a);
    const draPop = this.source === 'live' ? this.snap?.districts.find((d) => d.index === UNASSIGNED)?.pop : undefined;
    const unassigned = u.blocks ? { pop: draPop ?? u.pop } : undefined;
    if (JSON.stringify(unassigned) !== JSON.stringify(this.state.unassigned)) this.set({ unassigned });
  }

  /** People in unassigned blocks of the map a solve plans from (CSV: including steps marked painted). */
  private unassignedPop(assignment: Uint16Array): number {
    return this.bundle ? unassignedOf(this.bundle.pop[this.popField], assignment).pop : (this.state.unassigned?.pop ?? 0);
  }

  private neighborsKey = '';
  /** Adjacent districts per district; 0 (Unassigned) is listed for a district touching unassigned blocks. */
  private updateNeighbors() {
    const g = this.graph;
    const a = this.assignment;
    if (!g || !a) return;
    const k = this.targets?.numDistricts ?? this.state.districts.length;
    const sets = Array.from({ length: k + 1 }, () => new Set<number>());
    for (let i = 0; i < g.n; i++) {
      const da = a[i];
      if (!da || da > k) continue;
      for (let e = g.adjOffsets[i]; e < g.adjOffsets[i + 1]; e++) {
        const db = a[g.adjTargets[e]];
        if (db !== da) sets[da].add(db);
      }
    }
    const key = sets.map((s) => [...s].sort((x, y) => x - y).join(',')).join(';');
    if (key === this.neighborsKey) return;
    this.neighborsKey = key;
    this.set({ districts: this.state.districts.map((r) => ({ ...r, neighbors: [...(sets[r.index] ?? [])].sort((x, y) => x - y) })) });
    this.pruneChoice();
  }

  /** A chosen neighbor that no longer touches the district is taken off the choice, and the user is told. */
  private pruneChoice() {
    const scope = this.state.scope;
    if (scope.mode !== 'one' || !scope.with?.length) return;
    const next = sanitizeScope(scope, this.neighborsOf);
    const kept = next.mode === 'one' ? (next.with ?? []) : [];
    const gone = scope.with.filter((d) => !kept.includes(d));
    if (!gone.length) return;
    const who = this.districtName(scope.district);
    const tail = kept.length ? '' : ` ${who} now trades with any neighbor.`;
    const verb = gone.length === 1 ? 'no longer touches' : 'no longer touch';
    this.set({ scope: next, notice: { level: 'info', text: `${this.districtNames(gone)} ${verb} ${who}, so ${gone.length === 1 ? 'it is' : 'they are'} off the list of districts that trade with it.${tail}` } });
  }

  /** 'dra' when the hook gives us DRA's map, else the panel's own mini-map. */
  mapMode(): 'dra' | 'mini' {
    return this.link?.status.kind === 'connected' && this.check?.mapOk ? 'dra' : 'mini';
  }

  /** retry-connection: leave CSV mode (if in it) and go back to the live tab. */
  private retry() {
    if (this.source === 'csv') {
      if (this.state.walkthrough) this.endWalkthrough();
      this.source = 'live';
      this.undoState = emptyUndo();
      this.resetDerived();
      this.snap = null;
      this.csvInfo = null;
      this.targets = null;
      this.neighborsKey = '';
      this.solveSeq++;
      this.set({ ...INITIAL, unassigned: undefined, scope: this.state.scope, solve: this.bundleLoading && !this.bundle ? this.state.solve : { status: 'idle' } });
    }
    this.link.reconnect();
    this.link.send({ t: 'run-self-check' });
  }

  // ---------------------------------------------------------------------------
  // Scope, feasibility, interaction view
  // ---------------------------------------------------------------------------

  private scopeDistricts(scope: Scope = this.state.scope): number[] {
    const k = this.targets?.numDistricts ?? 0;
    if (scope.mode === 'one') return [scope.district];
    const locked = this.lockedSet();
    if (scope.mode === 'group') return scope.districts.filter((d) => !locked.has(d));
    return Array.from({ length: k }, (_, i) => i + 1).filter((d) => !locked.has(d));
  }

  private lockedSet(): Set<number> {
    return new Set(this.state.lockedDistricts ?? []);
  }

  /**
   * With "outside neighbors absorb": who outside the group may take or give. With locks, the
   * outside districts that are not locked (`absorbers`); without, any outside neighbor (no
   * `absorbers`). Unassigned joins in either way while unassigned blocks hold people (0 in
   * `absorbers`, or `includeUnassigned`). The whole map and a closed group trade with no one outside.
   */
  private outsideTrade(scope: Scope, districts: number[], unassignedPop: number): { absorbers?: number[]; includeUnassigned?: boolean } {
    if (scope.mode !== 'group' || !scope.allowOutsideAbsorb) return {};
    const withUnassigned = unassignedPop > 0;
    const locked = this.lockedSet();
    if (!locked.size) return withUnassigned ? { includeUnassigned: true } : {};
    const inGroup = new Set(districts);
    const k = this.targets?.numDistricts ?? 0;
    const open = Array.from({ length: k }, (_, i) => i + 1).filter((d) => !inGroup.has(d) && !locked.has(d));
    return { absorbers: withUnassigned ? [UNASSIGNED, ...open] : open };
  }

  /** Lock or unlock districts: a locked district is never changed by a suggestion. */
  private setDistrictLock(districts: number[], lock: boolean) {
    const map = this.state.map;
    if (!map || this.state.walkthrough) return;
    const prevLocks = this.state.lockedDistricts ?? [];
    const next = new Set(prevLocks);
    for (const d of districts) {
      // 0 (Unassigned) is not a district and is never locked.
      if (!Number.isInteger(d) || d < 1 || d > map.numDistricts) continue;
      if (lock) next.add(d);
      else next.delete(d);
    }
    const list = [...next].sort((a, b) => a - b);
    if (JSON.stringify(list) === JSON.stringify(prevLocks)) return;
    const targets = this.targets ?? computeTargets(map.totalPop, map.numDistricts);
    const prevSet = new Set(prevLocks);
    const zeroedUnlocked = this.state.districts
      .filter((d) => !prevSet.has(d.index) && isZeroed(d.pop, targets))
      .map((d) => d.index);
    const prevScope = this.state.scope;
    const afterScope = withoutLocked(prevScope, list);
    const label = lockUndoLabel({ locked: lock, prevLocks, nextLocks: list, zeroedUnlocked });
    if (label) {
      this.undoState = recordSettingUndo(this.undoState, {
        kind: 'locks',
        mapKey: this.areaKey(map),
        prevLocks: prevLocks.slice(),
        prevScope,
        afterScope,
        label,
      });
    } else {
      this.undoState = clearSettingUndo(this.undoState, 'locks');
    }
    const key = lockKey(map);
    if (list.length) this.locks[key] = list;
    else delete this.locks[key];
    this.opts.locks?.save({ ...this.locks });
    // Whatever was on offer was planned without this lock (or around it): start over.
    this.solveSeq++;
    this.full.clear();
    this.highlightSeq++;
    this.clearMap();
    this.set({
      scope: afterScope,
      solutions: [],
      hoveredSolutionId: undefined,
      feasibility: undefined,
      interaction: undefined,
      solve: this.state.solve.status === 'loading-data' ? this.state.solve : { status: 'idle' },
    });
    this.refreshInteraction();
  }

  // ---------------------------------------------------------------------------
  // The area where the user would like the swap to happen (PanelState.area)
  // ---------------------------------------------------------------------------

  /** PanelState.area for `st`: the current map's area, the drawing flag, counts, and why it can't be used. */
  private areaState(st: PanelState): AreaState | undefined {
    const map = st.map;
    if (!map) return undefined;
    const saved = this.areas[this.areaKey(map)];
    const drawing = this.areaDrawing;
    const picking = this.areaPick?.kind;
    const unavailable = this.regionUnavailable(saved?.region, map.state) ?? this.savedClusterUnavailable(saved?.cluster, map.state) ?? this.areaUnavailable(st, 'draw');
    if (saved?.ring || drawing) void this.ensurePoints();
    // No area and nothing to explain: absent (moves may happen anywhere).
    if (!saved && !drawing && !picking && !unavailable) return undefined;
    const a: AreaState = { mode: saved?.mode ?? this.areaPendingMode, drawing, ...(picking ? { picking } : {}) };
    if (saved) {
      if (saved.region) a.region = saved.region;
      else if (saved.cluster) a.cluster = saved.cluster;
      else a.ring = saved.ring;
      const m = this.areaMask(saved, map.state);
      if (m) {
        a.blocks = m.blocks;
        a.people = this.areaPeople(m);
      }
    }
    if (unavailable) a.unavailable = unavailable;
    return a;
  }

  /**
   * Why an area cannot be used ('use': a solve, "Use map view") or drawn ('draw') right now;
   * undefined when it can. Before the state's data is loaded nothing is known against it: the area
   * can be marked, and its counts come with the data.
   */
  private areaUnavailable(st: PanelState, what: 'use' | 'draw'): string | undefined {
    if (st.connection === 'csv') return 'An area needs the live DRA tab, so it is off in CSV mode.';
    if (st.connection !== 'live') return 'An area can be marked on a live, supported DRA map only.';
    const b = this.bundle;
    if (b && st.map && b.manifest.state === st.map.state) {
      // The manifest says whether the state's data has block points; they are read on demand.
      if (!b.manifest.points) return "This state's data has no block locations for drawing an area or picking on the map.";
      if (this.pointsError?.bundle === b) return `The block locations for this state could not be loaded (${this.pointsError.message}). Close and reopen the panel to try again.`;
    }
    if (what === 'draw') {
      // A DRA tab opened before an extension update runs an older page hook, which cannot draw.
      if (this.hookVersion && this.hookVersion !== HOOK_VERSION) return 'Drawing an area needs the DRA tab to be reloaded (its page hook is from an older version of the extension).';
      if (this.mapMode() !== 'dra') return 'Drawing an area needs DRA\'s map, which the extension cannot reach on this page. "Use map view" takes the part of the panel\'s map in view.';
      // DRA's map without what drawing uses (the self-check's AREA_DRAW_HOOK item) is not a reason
      // here: "Use map view" still works on that map, and AreaState.unavailable turns both buttons
      // off. areaDraw says why instead, when the user asks to draw.
    }
    return undefined;
  }

  /**
   * Starts reading the loaded state's block points if they are listed and not read yet; resolves
   * with them (undefined without them). On success the area's counts appear (set); on failure
   * areaUnavailable says why.
   */
  private ensurePoints(): Promise<Int32Array | undefined> {
    const b = this.bundle;
    if (!b || !b.manifest.points) return Promise.resolve(undefined);
    if (b.points) return Promise.resolve(b.points);
    if (this.pointsError?.bundle === b) return Promise.resolve(undefined);
    if (this.pointsLoad?.bundle === b) return this.pointsLoad.promise;
    const t0 = performance.now();
    const promise = this.bundleSource.loadPoints(b).then(
      (points) => {
        this.perf.pointsMs = performance.now() - t0;
        if (this.bundle === b) {
          this.areaMaskCache = null;
          this.set({});
          this.fitMiniIdle();
        }
        return points;
      },
      (e: unknown) => {
        this.pointsError = { bundle: b, message: e instanceof Error ? e.message : String(e) };
        if (this.bundle === b) this.set({});
        return undefined;
      },
    );
    this.pointsLoad = { bundle: b, promise };
    return promise;
  }

  /**
   * What a map's area is remembered under. A live map: DRA's own id for it (the session id that
   * leads its snapshot signature) when the page gives one, so two maps with the same name and size
   * never share an area (with Only, one would silently narrow the other's solves) and a renamed map
   * keeps its own. Without an id, and for a CSV, as the district locks (lockKey).
   */
  private areaKey(map: NonNullable<PanelState['map']>): string {
    if (!map.sourceName && this.snap && this.snap.info.state === map.state && this.snap.info.nDistricts === map.numDistricts) {
      const session = this.snap.sig.split('|')[0];
      if (session) return `live|${map.state}|${map.numDistricts}|session:${session}`;
    }
    return lockKey(map);
  }

  private regionUnavailable(region: AreaRegion | undefined, state: string): string | undefined {
    const b = this.bundle;
    if (region && b?.manifest.state === state && regionName(b, region.kind, region.index) !== region.name) {
      return `Choose ${region.name} again to use it with the current data.`;
    }
    return undefined;
  }

  /** Why a remembered county cluster cannot be used with the loaded data (see clusterUnavailable). */
  private savedClusterUnavailable(cluster: AreaState['cluster'], state: string): string | undefined {
    const b = this.bundle;
    return cluster && b?.manifest.state === state ? clusterUnavailable(cluster, b.countyFips.length) : undefined;
  }

  /** inside[] for the selected region, cluster or ring on the loaded bundle. */
  private areaMask(area: Pick<AreaState, 'ring' | 'region' | 'cluster'>, state: string) {
    const b = this.bundle;
    if (b?.manifest.state !== state) return null;
    const { ring, region, cluster } = area;
    const key = JSON.stringify(region ?? (cluster ? { cluster: cluster.counties } : ring));
    if (!key) return null;
    const c = this.areaMaskCache;
    if (c && c.bundle === b && c.key === key) return c;
    const t0 = performance.now();
    let inside: Uint8Array;
    if (region) {
      const membership = region.kind === 'county' ? b.countyOf : b.townOf;
      if (!membership || this.regionUnavailable(region, state)) return null;
      inside = Uint8Array.from(membership, (index) => Number(index === region.index));
    } else if (cluster) {
      if (clusterUnavailable(cluster, b.countyFips.length)) return null;
      inside = clusterMask(b.countyOf, cluster.counties);
    } else if (ring && b.points) {
      inside = insideMask(b.points, b.n, ring);
    } else {
      return null;
    }
    let blocks = 0;
    for (let i = 0; i < inside.length; i++) blocks += inside[i];
    this.perf.areaMaskMs = performance.now() - t0;
    this.areaMaskCache = { bundle: b, key, inside, blocks, peopleField: null, people: 0 };
    return this.areaMaskCache;
  }

  private areaPeople(m: NonNullable<ExtensionController['areaMaskCache']>): number {
    if (m.peopleField !== this.popField) {
      m.people = countInside(m.inside, m.bundle.pop[this.popField]).people;
      m.peopleField = this.popField;
    }
    return m.people;
  }

  /** What a solve passes to the worker (AreaPreference), or undefined: no area, or it can't be used now. */
  private solveArea(): { inside: Uint8Array; mode: AreaMode; blocks: number } | undefined {
    const st = this.state;
    if (!st.area || !st.map || st.connection !== 'live') return undefined;
    const m = this.areaMask(st.area, st.map.state);
    return m ? { inside: m.inside, mode: st.area.mode, blocks: m.blocks } : undefined;
  }

  /** Puts the current ring on DRA's map and the mini-map when it changed (or must be sent again). */
  private syncAreaOutline() {
    const ring = this.state.area?.ring ?? null;
    const key = ring ? JSON.stringify(ring) : '';
    if (key === this.areaShown) return;
    this.areaShown = key;
    this.link?.send({ t: 'area-show', ring });
    this.miniArea?.show(ring);
  }

  private saveAreas() {
    this.opts.areas?.save({ ...this.areas });
  }

  /** The options on offer were found for the old area (or none): drop them, like a lock change. */
  private dropForArea() {
    this.solveSeq++;
    this.full.clear();
    this.highlightSeq++;
    this.clearMap();
    this.set({ solutions: [], hoveredSolutionId: undefined, solve: this.state.solve.status === 'loading-data' ? this.state.solve : { status: 'idle' } });
  }

  /** Makes `ring` the current map's area (replacing any), keeping its mode. */
  private setAreaRing(ring: Ring) {
    const map = this.state.map;
    if (!map || this.state.walkthrough) {
      // Not taken: make sure DRA's map shows what the panel has, not what was just drawn.
      this.areaShown = null;
      this.set({});
      return;
    }
    const why = this.areaUnavailable(this.state, 'use');
    if (why) {
      // E.g. the panel went to CSV mode, or the data turned out to have no block points, while
      // the user drew: an area that cannot be used is not saved (it would show, and do nothing).
      this.areaShown = null;
      this.set({ notice: { level: 'warn', text: `The area was not kept: ${why}` } });
      return;
    }
    this.saveAreaSelection(map, { ring });
  }

  private saveAreaSelection(map: NonNullable<PanelState['map']>, area: AreaSelection) {
    const key = this.areaKey(map);
    const prev = this.areas[key];
    const next: SavedArea = { ...area, mode: prev?.mode ?? this.areaPendingMode };
    if (prev && JSON.stringify({ ring: prev.ring, region: prev.region, cluster: prev.cluster }) !== JSON.stringify({ ring: next.ring, region: next.region, cluster: next.cluster })) {
      this.undoState = recordSettingUndo(this.undoState, {
        kind: 'area',
        mapKey: key,
        prevArea: cloneSavedArea(prev),
        label: 'Undo replacing area',
      });
    }
    this.areas[key] = next;
    this.saveAreas();
    this.dropForArea();
  }

  private areaUseRegion(kind: AreaRegion['kind'], index: number) {
    const { map, connection, walkthrough } = this.state;
    const b = this.bundle;
    if (!map || connection !== 'live' || walkthrough || b?.manifest.state !== map.state) return;
    const name = regionName(b, kind, index);
    if (!name) return;
    this.areaCancelDraw();
    this.saveAreaSelection(map, { region: { kind, index, name } });
  }

  private areaPickRegion(kind: AreaRegion['kind']) {
    const { map, walkthrough, regions } = this.state;
    if (!map || walkthrough || this.areaDrawing || this.areaPick) return;
    if (!(kind === 'county' ? regions?.counties.length : regions?.towns.length)) return;
    if (this.areaUnavailable(this.state, 'draw')) return;
    const pick = { kind, reqId: ++this.viewSeq };
    this.areaPick = pick;
    this.link.send({ t: 'area-pick-start', ...pick });
    this.set({});
    void this.ensurePoints();
  }

  private async onAreaPicked({ reqId, point, detail }: Extract<HookToPanel, { t: 'area-picked' }>) {
    const pick = this.areaPick;
    if (!pick || pick.reqId !== reqId) return;
    if (!point) {
      this.areaPick = undefined;
      this.set(detail ? { notice: { level: 'warn', text: detail } } : {});
      return;
    }
    const b = this.bundle;
    const points = await this.ensurePoints();
    if (this.areaPick !== pick) return;
    this.areaPick = undefined;
    if (!points || !b || this.bundle !== b) {
      this.set({});
      return;
    }
    const block = nearestBlock(points, point);
    const index = (pick.kind === 'county' ? b.countyOf : b.townOf)?.[block];
    if (index === undefined || !regionName(b, pick.kind, index)) {
      this.set({ notice: { level: 'info', text: `The nearest block has no ${pick.kind} to select. Choose one from the list or pick another spot.` } });
      return;
    }
    this.areaUseRegion(pick.kind, index);
  }

  /** area-draw: drawing happens on DRA's map (src/hook/area.ts); the hook reports the outline. */
  private areaDraw() {
    if (!this.state.map || this.state.walkthrough || this.areaDrawing || this.areaPick) return;
    if (this.areaUnavailable(this.state, 'draw')) return; // state.area.unavailable says why
    const item = this.check?.items.find((i) => i.id === AREA_DRAW_HOOK);
    if (item && !item.ok) {
      this.set({ notice: { level: 'warn', text: `Drawing an area needs DRA's map, and it lacks what drawing uses (${item.detail ?? 'unknown'}). "Use map view" still works: move DRA's map to the part you want and press it.` } });
      return;
    }
    this.areaDrawing = true;
    this.link.send({ t: 'area-draw-start' });
    this.set({});
  }

  private areaCancelDraw() {
    if (!this.areaDrawing && !this.areaPick) return;
    this.areaDrawing = false;
    this.areaPick = undefined;
    this.link.send({ t: 'area-draw-cancel' });
    this.set({});
  }

  private onAreaDrawn(ring: AreaRing) {
    if (!this.areaDrawing) {
      // Cancelled here while the user finished there: keep what the panel has.
      this.areaShown = null;
      this.set({});
      return;
    }
    this.areaDrawing = false;
    const clean = cleanRing(ring);
    if (!clean) {
      this.areaShown = null;
      this.set({ notice: { level: 'warn', text: 'The outline drawn was not a usable area (it needs at least 3 corners, and its edges must not cross). Draw it again.' } });
      return;
    }
    this.setAreaRing(clean);
  }

  /** area-use-view: the part of DRA's map in view, or of the mini-map when DRA's map is out of reach. */
  private async areaUseView() {
    const map = this.state.map;
    if (!map || this.state.walkthrough || this.areaUnavailable(this.state, 'use')) return;
    this.areaCancelDraw();
    const key = this.areaKey(map);
    const previous = this.areas[key];
    const fromDra = this.mapMode() === 'dra';
    const ring = fromDra ? await this.requestView() : (this.miniArea?.view() ?? null);
    // The map may have changed (or a walkthrough started) while DRA answered.
    if (!this.state.map || this.areaKey(this.state.map) !== key || this.state.walkthrough) return;
    if (this.areas[key] !== previous || this.areaDrawing || this.areaPick) return;
    const clean = cleanRing(ring);
    if (!clean) {
      this.set({ notice: { level: 'warn', text: fromDra ? "DRA's map did not say what is in view. Try again, or draw the area." : "The panel's map is not showing yet, so there is no view to take. Try again once it shows." } });
      return;
    }
    this.setAreaRing(clean);
  }

  private requestView(): Promise<AreaRing | null> {
    const reqId = ++this.viewSeq;
    return new Promise((resolve) => {
      this.viewWaiters.set(reqId, resolve);
      this.link.send({ t: 'request-view', reqId });
      setTimeout(() => {
        if (this.viewWaiters.delete(reqId)) resolve(null);
      }, VIEW_TIMEOUT_MS);
    });
  }

  private areaClear() {
    const map = this.state.map;
    if (!map || this.state.walkthrough) return;
    this.areaCancelDraw();
    const key = this.areaKey(map);
    const prev = this.areas[key];
    if (!prev) return;
    this.undoState = recordSettingUndo(this.undoState, {
      kind: 'area',
      mapKey: key,
      prevArea: cloneSavedArea(prev),
      label: 'Undo clearing area',
    });
    delete this.areas[key];
    this.saveAreas();
    this.dropForArea();
  }

  private setAreaMode(mode: AreaMode) {
    if (mode !== 'prefer' && mode !== 'only') return;
    const map = this.state.map;
    if (!map || this.state.walkthrough) return;
    const key = this.areaKey(map);
    const saved = this.areas[key];
    if (!saved) {
      // No area yet: the next one starts in this mode.
      if (this.areaPendingMode !== mode) {
        this.areaPendingMode = mode;
        this.set({});
      }
      return;
    }
    if (saved.mode === mode) return;
    this.areas[key] = { ...saved, mode };
    this.areaPendingMode = mode;
    this.saveAreas();
    this.dropForArea();
  }

  // ---------------------------------------------------------------------------
  // County clusters (PanelState.clusters, contracts/clusters.ts)
  // ---------------------------------------------------------------------------

  /** clusters-find: run the search in the engine worker on the loaded state's graph. */
  private clustersFind(numDistricts: number, tolerance: number) {
    const b = this.bundle;
    const graph = this.graph;
    const prev = this.state.clusters;
    const refuse = (message: string) => {
      this.clustersResultMessage = message;
      this.set({ clusters: { status: 'error', numDistricts: Number(numDistricts), tolerance: Number(tolerance), results: [], message } });
    };
    if (!b || !graph || !this.engine || (this.state.map && b.manifest.state !== this.state.map.state)) {
      refuse("The state's data is not loaded yet. Find clusters once it is in.");
      return;
    }
    let totalPop = 0;
    for (let i = 0; i < graph.n; i++) totalPop += graph.pop[i];
    const req = clusterRequest({ numDistricts, tolerance, counties: b.countyFips.length, totalPop, testDelayMs: this.testSolveDelayMs });
    if (!req.body) {
      refuse(req.message);
      return;
    }
    const body = req.body;
    // A search still running would hold up this one (the worker does one thing at a time).
    if (prev?.status === 'finding') void this.stopClusterSearch();
    const seq = ++this.clustersSeq;
    this.clusterHoverSeq++;
    this.showClusters(null);
    this.clustersResultMessage = undefined;
    this.clustersNote = undefined;
    const base = { numDistricts: body.numDistricts, tolerance: body.tolerance };
    this.set({ clusters: { status: 'finding', ...base, districtSize: totalPop / body.numDistricts, results: [] } });
    const names = countyNames(b);
    const run = (retries: number): Promise<void> =>
      this.engine!.request<Extract<WorkerResponse, { type: 'clusters-result' }>>(body)
        .then(({ result }) => {
          if (seq !== this.clustersSeq || this.bundle !== b) return;
          const status = result.status === 'ok' ? (result.clusterings.length ? 'done' : 'none') : result.status;
          const pct = `±${+(body.tolerance * 100).toFixed(2)}%`;
          const message =
            result.message ??
            (status === 'none'
              ? `No split of the state into whole-county clusters fits ${body.numDistricts.toLocaleString('en-US')} districts at ${pct}${result.exhaustive ? '' : ' (none was found in the time allowed)'}. Try a larger tolerance.`
              : undefined);
          this.clustersResultMessage = message;
          this.set({
            clusters: {
              status,
              ...base,
              districtSize: result.districtSize,
              results: withCountyNames(result, names),
              exhaustive: result.exhaustive,
              ...(this.clustersMessage() ? { message: this.clustersMessage() } : {}),
              elapsedMs: Math.round(result.elapsedMs),
            },
          });
        })
        .catch((e: unknown) => {
          if (seq !== this.clustersSeq) return;
          // The worker was restarted under the search (a solve was cancelled, say): run it again.
          if (e instanceof CancelledError && retries > 0 && this.engine) return run(retries - 1);
          const message = e instanceof CancelledError ? 'The search was interrupted. Find clusters again.' : `The cluster search failed: ${e instanceof Error ? e.message : String(e)}`;
          this.clustersResultMessage = message;
          this.set({ clusters: { status: 'error', ...base, results: [], message } });
        });
    void run(1);
  }

  /** clusters-cancel: like cancel-solve, the worker is restarted (a search can't be interrupted otherwise). */
  private async clustersCancel() {
    const c = this.state.clusters;
    if (c?.status !== 'finding' || !this.engine) return;
    this.clustersSeq++;
    this.clustersResultMessage = 'Cancelled.';
    this.set({ clusters: { ...c, status: 'idle', results: [], message: 'Cancelled.' } });
    await this.stopClusterSearch();
  }

  /**
   * Restarts the engine worker to stop a cluster search. Whatever was queued behind the search
   * goes with it: a solve is reported cancelled, the interaction view is measured again.
   */
  private async stopClusterSearch() {
    if (!this.engine) return;
    if (this.state.solve.status === 'solving') {
      this.solveSeq++;
      this.set({ solve: { status: 'idle', message: 'Cancelled, with the cluster search.' } });
    }
    this.scopeSeq++;
    this.interactionInFlight = 0;
    try {
      await this.engine.restart();
    } catch (e) {
      if (!(e instanceof CancelledError)) console.warn('[zd] engine restart failed', e);
    }
    if (!this.state.interaction && !this.state.feasibility) this.refreshInteraction();
  }

  /** Forget the clusters (another state): results, the picture on the maps, the outlines read. */
  private dropClusters() {
    if (this.state.clusters?.status === 'finding' && this.engine) void this.engine.restart().catch(() => {});
    this.clustersSeq++;
    this.clusterHoverSeq++;
    this.showClusters(null);
    this.clustersNote = undefined;
    this.clustersResultMessage = undefined;
    this.outlinesLoad = null;
    this.countyAdj = null;
  }

  private clustersMessage(): string | undefined {
    const parts = [this.clustersResultMessage, this.clustersNote].filter(Boolean);
    return parts.length ? parts.join(' ') : undefined;
  }

  private setClustersNote(note: string | undefined) {
    if (note === this.clustersNote) return;
    this.clustersNote = note;
    const c = this.state.clusters;
    if (!c) return;
    const message = this.clustersMessage();
    const { message: _old, ...rest } = c;
    this.set({ clusters: message ? { ...rest, message } : rest });
  }

  /** The county outlines (BundleManifest.outlines), read once per state; undefined without them (clustersNote says why). */
  private ensureOutlines(): Promise<CountyOutlines | undefined> {
    const b = this.bundle;
    if (!b) return Promise.resolve(undefined);
    if (!b.manifest.outlines) {
      this.setClustersNote("This state's data has no county outlines yet, so clusters are not drawn on the map.");
      return Promise.resolve(undefined);
    }
    if (this.outlinesLoad?.bundle !== b) {
      const t0 = performance.now();
      const load: { bundle: StateBundle; promise: Promise<CountyOutlines | undefined>; failed?: string } = { bundle: b, promise: Promise.resolve(undefined) };
      load.promise = this.bundleSource.loadOutlines(b).then(
        (fc) => {
          this.perf.outlinesMs = performance.now() - t0;
          return fc;
        },
        (e: unknown) => {
          // Kept for this state (no retry on every hover); reopening the panel tries again.
          load.failed = `The county outlines could not be loaded (${e instanceof Error ? e.message : String(e)}), so clusters are not drawn on the map.`;
          return undefined;
        },
      );
      this.outlinesLoad = load;
    }
    const load = this.outlinesLoad;
    // The note on every call, not only the first: a new search clears it.
    return load.promise.then((fc) => {
      if (load.failed && this.bundle === b) this.setClustersNote(load.failed);
      return fc;
    });
  }

  private countyAdjacencyOf(graph: EngineGraph, counties: number): number[][] {
    if (this.countyAdj?.graph !== graph) this.countyAdj = { graph, adj: countyAdjacency(graph, counties) };
    return this.countyAdj.adj;
  }

  /** clusters-hover: outline a clustering (or one cluster of it) on DRA's map and the mini-map; null clears. */
  private async clustersHover(id: string | null, cluster?: number) {
    const c = this.state.clusters;
    const seq = ++this.clusterHoverSeq;
    if (!c) return;
    if (id === null) {
      if (c.hovered) this.set({ clusters: { ...c, hovered: undefined } });
      this.showClusters(null);
      return;
    }
    const clustering = c.results.find((r) => r.id === id);
    if (!clustering) return;
    const emphasize = cluster !== undefined && Number.isInteger(cluster) && cluster >= 0 && cluster < clustering.clusters.length ? cluster : undefined;
    this.set({ clusters: { ...c, hovered: { id, ...(emphasize !== undefined ? { cluster: emphasize } : {}) } } });
    const b = this.bundle;
    const graph = this.graph;
    if (!b || !graph) return;
    const outlines = await this.ensureOutlines();
    if (seq !== this.clusterHoverSeq || this.bundle !== b) return;
    if (!outlines) {
      this.showClusters(null);
      return;
    }
    const colors = clusterColors(clustering, this.countyAdjacencyOf(graph, b.countyFips.length));
    const { fc, missing } = clusterFeatures({ clustering, outlines, countyFips: b.countyFips, colors, emphasize });
    this.setClustersNote(missing ? `${missing} ${missing === 1 ? 'county has' : 'counties have'} no outline in this state's data, so ${missing === 1 ? 'it is' : 'they are'} not drawn.` : undefined);
    this.showClusters(fc);
  }

  private showClusters(fc: ClusterFC | null) {
    if (!fc && !this.clusterShown) return;
    this.clusterShown = fc;
    this.link?.send({ t: 'clusters-show', fc });
    this.miniClusters?.show(fc);
  }

  /** clusters-use-as-area: one cluster's counties become the swap area (AreaState.cluster). */
  private clustersUseAsArea(id: string, index: number) {
    const { map, connection, walkthrough, clusters } = this.state;
    const b = this.bundle;
    if (!map || walkthrough || !clusters || b?.manifest.state !== map.state) return;
    const cluster = clusters.results.find((r) => r.id === id)?.clusters[index];
    if (!cluster) return;
    if (connection !== 'live') {
      this.set({ notice: { level: 'warn', text: 'A cluster can be the area on a live DRA map only.' } });
      return;
    }
    this.areaCancelDraw();
    this.saveAreaSelection(map, { cluster: areaCluster(countyNames(b), cluster) });
  }

  private interactionInFlight = 0;

  private neighborsOf = (d: number) => this.state.districts.find((r) => r.index === d)?.neighbors;

  private districtName(d: number): string {
    if (d === UNASSIGNED) return 'Unassigned';
    const label = this.state.districts.find((r) => r.index === d)?.label?.trim();
    if (!label) return `District ${d}`;
    return /^\d+$/.test(label) ? `District ${label}` : label;
  }

  private districtNames(ds: number[]): string {
    return joinDistrictNames(ds, (d) => this.districtName(d));
  }

  private setScope(scope: Scope) {
    scope = withoutLocked(sanitizeScope(scope, this.neighborsOf), this.state.lockedDistricts ?? []);
    if (this.state.walkthrough) this.endWalkthrough();
    // A whole-map capacity pass can take seconds on a real state; don't make a one-district solve
    // queue behind it. Restarting the worker is cheap (tens of ms) and only drops cached curves.
    if (scope.mode === 'one' && this.interactionInFlight && this.engine && this.state.solve.status !== 'solving') {
      this.scopeSeq++;
      this.interactionInFlight = 0;
      void this.engine.restart().catch(() => {});
    }
    this.full.clear();
    this.set({ scope, solutions: [], hoveredSolutionId: undefined, feasibility: undefined, interaction: undefined, solve: { status: this.bundle ? 'idle' : this.state.solve.status } });
    this.refreshInteraction();
  }

  private refreshInteraction() {
    const scope = this.state.scope;
    if (scope.mode === 'one' || !this.engine || !this.assignment || !this.targets || !this.graph) return;
    const districts = this.scopeDistricts(scope);
    if (!districts.length) return;
    const seq = ++this.scopeSeq;
    this.interactionInFlight++;
    const engine = this.engine;
    const gen = engine.generation;
    const done = () => {
      if (engine.generation === gen && this.interactionInFlight > 0) this.interactionInFlight--;
    };
    this.engine
      .request<Extract<WorkerResponse, { type: 'interaction-result' }>>({
        type: 'interaction',
        assignment: this.assignment,
        targets: this.targets,
        districts,
        allowOutsideAbsorb: scope.mode === 'group' ? scope.allowOutsideAbsorb : false,
        ...this.outsideTrade(scope, districts, this.unassignedPop(this.assignment)),
      })
      .then((r) => {
        done();
        if (seq !== this.scopeSeq) return;
        const patch: { feasibility?: GroupFeasibility; interaction?: InteractionGraph } = {};
        const feasibility = this.unlockedOnly(r.feasibility);
        if (scope.mode === 'group') patch.feasibility = feasibility;
        else if (!feasibility.feasible) patch.feasibility = feasibility;
        if (r.interaction) patch.interaction = r.interaction;
        this.set(patch);
      })
      .catch((e) => {
        done();
        if (!(e instanceof CancelledError)) console.warn('[zd] interaction failed', e);
      });
  }

  // ---------------------------------------------------------------------------
  // Solving
  // ---------------------------------------------------------------------------

  /** Locked districts are never offered as ones to add to the group. */
  private unlockedOnly(f: GroupFeasibility): GroupFeasibility {
    const locked = this.lockedSet();
    return locked.size && f.suggestAdd.some((d) => locked.has(d)) ? { ...f, suggestAdd: f.suggestAdd.filter((d) => !locked.has(d)) } : f;
  }

  private canSuggest(): string | null {
    const c = this.state.connection;
    if (c !== 'live' && c !== 'csv') return c === 'data-mismatch' ? 'Suggestions are off: the data bundle disagrees with DRA.' : 'Not connected to a supported DRA map.';
    if (!this.bundle || !this.assignment || !this.targets || !this.engine) return 'Still loading data…';
    return null;
  }

  /** The map to plan from: live = what DRA shows; CSV = the loaded file plus the steps marked painted. */
  private planningAssignment(): Uint16Array {
    const a = this.assignment!;
    const w = this.state.walkthrough;
    const plan = this.plan;
    if (this.source !== 'csv' || !w || !plan) return a.slice();
    const done = new Map<number, number>();
    w.steps.forEach((s, i) => {
      if (s.status === 'done') for (const b of plan.stepBlocks[i]) done.set(b, s.to);
    });
    return applyTargets(a, done);
  }

  /** Resolves true when it found solutions (with `autoStart`, a walkthrough of the first started); else false or undefined. */
  private async solve(opts: { locked?: Uint8Array; autoStart?: boolean } = {}): Promise<boolean | undefined> {
    const why = this.canSuggest();
    if (why) {
      this.set({ solve: { status: 'error', message: why } });
      return;
    }
    const scope = this.state.scope;
    const lockedDistricts = this.state.lockedDistricts ?? [];
    const lockedSet = new Set(lockedDistricts);
    const lockedNames = this.districtNames(lockedDistricts);
    if (scope.mode === 'one' && scope.district === UNASSIGNED) {
      this.set({ solutions: [], solve: { status: 'error', message: 'Unassigned is not a district, so it has no number to reach. Pick a district to zero; it can trade with Unassigned.' } });
      return;
    }
    if (scope.mode === 'one' && lockedSet.has(scope.district)) {
      this.set({ solutions: [], solve: { status: 'error', message: `${this.districtName(scope.district)} is locked, so nothing may change it. Unlock it in the district list to zero it.` } });
      return;
    }
    const assignment = this.planningAssignment();
    const unassignedPop = this.unassignedPop(assignment);
    // One district: who it trades with (the choice, or any neighbor; with locks, the open ones;
    // Unassigned per the Scope 'one' rule). Nobody to trade with: say so instead of solving.
    const devOf = (d: number) => this.state.districts.find((r) => r.index === d)?.deviation ?? 0;
    const trade =
      scope.mode === 'one'
        ? oneDistrictTrade({ district: scope.district, with: scope.with, goal: scope.goal, neighbors: this.neighborsOf(scope.district), lockedDistricts, unassignedPop, deviationOf: devOf, name: (d) => this.districtName(d) })
        : null;
    if (trade?.error) {
      this.set({ solutions: [], solve: { status: 'error', message: trade.error } });
      return;
    }
    // The user's area, for every kind of solve (re-plan from here included). Its block points are
    // read the first time an area needs them; a solve started before they are in waits for them.
    if (this.state.area?.ring && this.bundle?.manifest.points && !this.bundle.points) {
      const before = this.solveSeq;
      this.set({ solve: { status: 'loading-data', message: 'Loading block locations for your area…' } });
      await this.ensurePoints();
      if (this.solveSeq !== before) return; // something else started (or dropped) a solve meanwhile
    }
    // An area that is marked but cannot be used now (no block points in the data, say) is never
    // ignored silently: with Only nothing is solved (blocks outside it would move), with Prefer the
    // solve runs without it and the status line says so.
    const area = this.solveArea();
    const selected = this.state.area;
    const areaIgnored = (selected?.ring || selected?.region || selected?.cluster) && !area
      ? (selected.region && this.state.map
          ? this.regionUnavailable(selected.region, this.state.map.state)
          : selected.cluster && this.state.map
            ? this.savedClusterUnavailable(selected.cluster, this.state.map.state)
            : this.areaUnavailable(this.state, 'use')) ?? 'which blocks are inside it is not known yet.'
      : undefined;
    if (areaIgnored && this.state.area?.mode === 'only') {
      this.set({ solutions: [], solve: { status: 'error', message: `Your area is set to Only, but it can't be used: ${areaIgnored} Clear the area (or switch it to Prefer) to zero without it.` } });
      return;
    }
    // Each request gets its own copy of the mask, moved to the worker rather than cloned.
    const areaPayload = (): { fields: { area?: AreaPreference }; transfer: Transferable[] } => {
      if (!area) return { fields: {}, transfer: [] };
      const inside = area.inside.slice();
      return { fields: { area: { inside, mode: area.mode } }, transfer: [inside.buffer] };
    };
    const seq = ++this.solveSeq;
    const targets = this.targets!;
    this.set({ solve: { status: 'solving', progress: 0 }, solutions: [], hoveredSolutionId: undefined });
    const t0 = performance.now();
    try {
      let solutions: Solution[];
      let status: PanelState['solve']['status'] = 'done';
      let message: string | undefined;
      let feasibility: GroupFeasibility | undefined;
      let interaction: InteractionGraph | undefined;
      let workerMs = 0;
      if (scope.mode === 'one' && trade) {
        // The user's choice of neighbors (absent = any neighbor, today's behavior: no neighbor may end
        // further from zero). A chosen neighbor may take or give the whole difference, whatever it
        // does to its own deviation: that is the user's call. Unassigned has no limit either way.
        const district = scope.district;
        const chosen = trade.chosen;
        const goal = scope.goal;
        const choice = {
          ...(trade.absorbers ? { absorbers: trade.absorbers } : {}),
          ...(trade.includeUnassigned ? { includeUnassigned: true } : {}),
          ...(trade.neighborTolerance !== undefined ? { neighborTolerance: trade.neighborTolerance } : {}),
          ...(goal !== undefined ? { goal } : {}),
        };
        const ap = areaPayload();
        const r = await this.engine!.request<Extract<WorkerResponse, { type: 'district-result' }>>({ type: 'solve-district', assignment, targets, district: scope.district, ...choice, maxOptions: 6, locked: opts.locked, lockedDistricts, ...ap.fields, testDelayMs: this.testSolveDelayMs || undefined }, undefined, ap.transfer);
        solutions = r.result.solutions;
        message = r.result.message;
        status = mapStatus(r.result.status);
        workerMs = r.result.elapsedMs;
        if (r.result.status === 'already-zero') {
          message = message ?? (goal !== undefined ? `${this.districtName(district)} is already at ${formatGoal(goal)}.` : 'This district is already at zero.');
        }
        message = solveDistrictMessage({
          district: scope.district,
          chosen,
          goal,
          shown: solutions.length,
          status: r.result.status,
          fallback: r.fallback,
          message,
          dropped: r.choiceDropped,
          name: (d) => this.districtName(d),
        });
        if (area) {
          // With 'only' and nothing found, the area is why; with 'prefer', say when every option leaves it.
          // (With a choice of neighbors, the "pick more neighbors" advice is already in the message.)
          message = areaSolveMessage({ mode: area.mode, status, alreadyZero: r.result.status === 'already-zero', outside: solutions.map((s) => s.stats.outsideArea), blocksInside: area.blocks, who: this.districtName(district), areaDropped: r.areaDropped, message });
          if (r.insideTwoWay) {
            const oneWayInside = solutions.some((s) => s.kind === 'single' && s.stats.outsideArea === 0);
            const note = oneWayInside
              ? 'After the one-way options inside your area come plans that trade in both directions inside it (paint their steps in order); options that move blocks outside it come last.'
              : 'No one-way move stays inside your area, so the first plans trade in both directions inside it (paint their steps in order); the options after them move blocks outside it.';
            message = message ? `${note} ${message}` : note;
          }
        }
        if (!solutions.length && lockedSet.size && r.result.status !== 'already-zero' && r.result.status !== 'error') {
          const shut = (this.neighborsOf(district) ?? []).filter((d) => lockedSet.has(d));
          if (shut.length) message = `${message ? `${message} ` : ''}${this.districtNames(shut)} ${shut.length === 1 ? 'is a locked neighbor and was' : 'are locked neighbors and were'} left out; unlocking gives more room.`;
        }
      } else {
        const districts = this.scopeDistricts(scope);
        if (!districts.length) {
          this.set({ solve: { status: 'error', message: scope.mode === 'all' ? 'Every district is locked. Unlock the ones you want to change.' : 'No districts selected.' } });
          return;
        }
        const ap = areaPayload();
        const r = await this.engine!.request<Extract<WorkerResponse, { type: 'group-result' }>>(
          { type: 'solve-group', assignment, targets, districts, allowOutsideAbsorb: scope.mode === 'group' ? scope.allowOutsideAbsorb : false, ...this.outsideTrade(scope, districts, unassignedPop), locked: opts.locked, lockedDistricts, ...ap.fields, testDelayMs: this.testSolveDelayMs || undefined },
          (done, total) => {
            this.progressEvents++;
            if (seq === this.solveSeq) this.set({ solve: { status: 'solving', progress: total ? done / total : 0 } });
          },
          ap.transfer,
        );
        solutions = r.result.solutions;
        message = r.result.message;
        status = mapStatus(r.result.status);
        workerMs = r.result.elapsedMs;
        feasibility = this.unlockedOnly(r.result.feasibility);
        interaction = r.result.interaction?.nodes?.length ? r.result.interaction : undefined;
        // The planner words its feasibility line for a group; on the whole map it is noise, and
        // with locks the thing worth saying is what was left alone.
        // (The planner may put an area note in front of it; areaSolveMessage says that its own way.)
        if (scope.mode === 'all' && solutions.length && (area ? splitAreaSentences(message).rest : message) === 'This group can be zeroed on its own.') {
          message = lockedSet.size ? `${lockedNames} ${lockedDistricts.length === 1 ? 'is locked and stays as it is' : 'are locked and stay as they are'}; these plans change only the other ${districts.length} districts.` : undefined;
        }
        if (r.result.status === 'group-unbalanced' && scope.mode === 'all' && lockedSet.size) {
          // Whole map with locks = the unlocked districts on their own. They must hold exactly
          // the right number of people between them, and each connected patch of them must too.
          const off = r.result.feasibility.excess;
          const size = off ? `${Math.abs(off).toLocaleString('en-US')} ${Math.abs(off) === 1 ? 'person' : 'people'} ${off > 0 ? 'over' : 'under'}` : 'out of balance';
          const helps = r.result.feasibility.suggestAdd.filter((d) => lockedSet.has(d));
          message = `With ${lockedNames} locked, the unlocked districts that touch each other are ${size} between them, so they cannot all reach zero. ${helps.length ? `Unlock ${this.districtName(helps[0])}, which could absorb the difference` : 'Unlock a district next to them that is off the other way'}, or zero the locked districts' neighbors first.`;
        }
        if (r.result.status === 'group-unbalanced' && scope.mode === 'all' && unassignedPop > 0) {
          // The whole map never trades with Unassigned, and the targets count everyone: while people
          // are unassigned the districts are short by that many between them. That is the reason.
          const who = `${unassignedPop.toLocaleString('en-US')} ${unassignedPop === 1 ? 'person is' : 'people are'}`;
          message = `${who} still unassigned; finish assigning them, or zero districts one at a time or as a group with Unassigned.`;
        }
        if (area) message = areaSolveMessage({ mode: area.mode, status, outside: solutions.map((s) => s.stats.outsideArea), blocksInside: area.blocks, who: scope.mode === 'all' ? 'the map' : 'this group', areaDropped: r.areaDropped, message });
      }
      if (seq !== this.solveSeq) return;
      if (solutions.some(hasTwoWayTrade) && scope.mode !== 'one') {
        message = message ?? 'Some borders are traded in both directions; paint the steps in order.';
      }
      this.full = new Map(solutions.map((s) => [s.id, s]));
      // How many walkthrough steps each card takes, before the user starts it: the solver's count
      // when it gives one, else the walkthrough's own steps (one per precinct per transfer).
      const ctx = this.bundle ? this.stepContext() : null;
      const cards: SolutionCard[] = solutions.map((s) => {
        let steps = s.stats.steps;
        if (ctx) {
          const built = buildSteps(s, assignment, ctx).steps.length;
          if (steps === undefined) steps = built;
          else if (steps !== built) console.warn('[zd] solver step count differs from the walkthrough', s.id, steps, built);
        }
        return { id: s.id, kind: s.kind, stats: steps === undefined ? s.stats : { ...s.stats, steps }, borderFlows: s.borderFlows, deviations: s.deviations };
      });
      // The engine's own elapsed time (real since the engine update); the round trip is kept for diagnostics.
      this.perf.lastSolveMs = performance.now() - t0;
      this.perf.lastSolveWorkerMs = workerMs;
      if (areaIgnored) {
        const note = `Your area was not used: ${areaIgnored}`;
        message = message ? `${note} ${message}` : note;
      }
      const patch: Partial<PanelState> = { solutions: cards, solve: { status, message, elapsedMs: Math.round(workerMs || this.perf.lastSolveMs) } };
      if (scope.mode === 'group' && feasibility) patch.feasibility = feasibility;
      if (interaction) patch.interaction = interaction;
      this.set(patch);
      if (opts.autoStart && solutions[0]) this.startWalkthrough(solutions[0].id, true);
      return solutions.length > 0;
    } catch (e) {
      if (seq !== this.solveSeq || e instanceof CancelledError) return;
      this.set({ solve: { status: 'error', message: e instanceof Error ? e.message : String(e) } });
    }
  }

  /** cancel-solve: the worker is single-threaded, so stop it by terminating it and start a fresh one. */
  private async cancelSolve() {
    if (this.state.solve.status !== 'solving' || !this.engine) return;
    this.solveSeq++;
    this.scopeSeq++;
    this.interactionInFlight = 0;
    const t0 = performance.now();
    this.set({ solve: { status: 'idle', message: 'Cancelled.' } });
    try {
      await this.engine.restart();
    } catch (e) {
      if (!(e instanceof CancelledError)) console.warn('[zd] engine restart failed', e);
    }
    this.perf.lastCancelMs = performance.now() - t0;
    // The view on screen is still right for this map; re-measuring would only refill the worker's
    // curve cache and make the next solve queue behind a whole-map capacity pass.
    if (!this.state.interaction && !this.state.feasibility) this.refreshInteraction();
  }

  // ---------------------------------------------------------------------------
  // Map highlighting
  // ---------------------------------------------------------------------------

  private sink(): HighlightSink {
    return this.mapMode() === 'dra' || !this.miniSink ? this.hookSink : this.miniSink;
  }

  private show(fc: HighlightFC, fit?: BBox) {
    this.lastHighlight = { fc, fit };
    // Always draw on whichever map we have; the mini-map also keeps the last highlight for mounting.
    if (this.mapMode() === 'dra') this.hookSink.show(fc, fit);
    this.miniSink?.show(fc, fit);
  }

  private clearMap() {
    this.lastHighlight = null;
    this.hookSink.clear();
    this.miniSink?.clear();
  }

  /** Highlight role of a block moving from -> to. Going to Unassigned (an erase) is neutral grey. */
  private roleFor(from: number, to: number): HighlightItem['role'] {
    if (to === UNASSIGNED) return 'erase';
    const s = this.state.scope;
    if (s.mode === 'one') return from === s.district ? 'remove' : 'add';
    return 'add';
  }

  private async hoverSolution(id: string | null) {
    this.set({ hoveredSolutionId: id ?? undefined });
    const seq = ++this.highlightSeq;
    if (!id) {
      if (this.state.walkthrough) await this.showCurrentStep(false);
      else this.clearMap();
      return;
    }
    const sol = this.full.get(id);
    if (!sol || !this.geo) return;
    const t0 = performance.now();
    const items: HighlightItem[] = [];
    for (const t of sol.transfers) for (const b of t.blocks) items.push({ block: b, role: this.roleFor(t.from, t.to) });
    const { fc } = await this.geo.build(items);
    if (seq !== this.highlightSeq) return;
    this.show(fc);
    this.perf.lastHoverMs = performance.now() - t0;
  }

  private async hoverBorder(a: number | null, b: number | null) {
    const seq = ++this.highlightSeq;
    if (a === null || b === null) {
      if (this.state.walkthrough) await this.showCurrentStep(false);
      else this.clearMap();
      return;
    }
    const g = this.graph;
    const asg = this.assignment;
    if (!g || !asg || !this.geo) return;
    const items: HighlightItem[] = [];
    for (let i = 0; i < g.n; i++) {
      const d = asg[i];
      if (d !== a && d !== b) continue;
      const other = d === a ? b : a;
      for (let e = g.adjOffsets[i]; e < g.adjOffsets[i + 1]; e++) {
        if (asg[g.adjTargets[e]] === other) {
          items.push({ block: i, role: 'border' });
          break;
        }
      }
    }
    const { fc } = await this.geo.build(items);
    if (seq === this.highlightSeq) this.show(fc);
  }

  // ---------------------------------------------------------------------------
  // Walkthrough
  // ---------------------------------------------------------------------------

  private stepContext() {
    const b = this.bundle!;
    const live = this.live;
    const precinctOf = live?.precinctOf ?? b.precinctOf;
    const precinctIds = live?.precinctIds ?? b.precinctIds;
    let members: Map<number, number[]> | null = null;
    return {
      geoids: b.geoids,
      pop: b.pop[this.popField],
      precinctOf,
      precinctIds,
      blocksOfPrecinct: (p: number) => {
        const fromLive = live?.blocksOf.get(precinctIds[p]);
        if (fromLive) return fromLive;
        if (!members) {
          members = new Map();
          for (let i = 0; i < b.n; i++) {
            const list = members.get(precinctOf[i]);
            if (list) list.push(i);
            else members.set(precinctOf[i], [i]);
          }
        }
        return members.get(p) ?? [];
      },
    };
  }

  private currentDraPops(): Map<number, number> {
    const m = new Map<number, number>();
    if (this.source === 'live' && this.snap) for (const d of this.snap.districts) m.set(d.index, d.pop);
    else if (this.bundle && this.assignment && this.targets) districtPops(this.bundle.pop[this.popField], this.assignment, this.targets.numDistricts).forEach((p, i) => m.set(i, p));
    return m;
  }

  private startWalkthrough(solutionId: string, keepDone = false) {
    const sol = this.full.get(solutionId);
    if (!sol || !this.assignment || !this.bundle) return;
    this.areaCancelDraw(); // the area cannot change during a walkthrough
    this.undoState = clearSettingUndo(this.undoState); // locks and area cannot change during a walkthrough
    const ctx = this.stepContext();
    const prev = keepDone ? this.state.walkthrough : undefined;
    const prevPlan = keepDone ? this.plan : null;
    const doneSteps = prev && prevPlan ? prev.steps.map((s, i) => ({ s, idx: prevPlan.stepBlocks[i] })).filter((x) => x.s.status === 'done') : [];
    const doneBlocks = new Set<number>(doneSteps.flatMap((x) => x.idx));
    const base = this.planningAssignment();
    const built = buildSteps(sol, base, ctx, keepDone ? `r${this.solveSeq}:` : '', doneBlocks);
    if (built.duplicates.length) {
      // The walkthrough would expect a block in two districts. The planner promises this never happens.
      console.warn('[zd] plan moves blocks twice', solutionId, built.duplicates.slice(0, 10).map((b) => this.bundle!.geoids[b]));
      this.set({ notice: { level: 'error', text: `This plan would move ${built.duplicates.length} block(s) twice (e.g. ${this.bundle.geoids[built.duplicates[0]]}), so it was not started. Pick another plan or solve again.` } });
      return;
    }
    const target = new Map<number, number>();
    for (const t of sol.transfers) for (const b of t.blocks) target.set(b, t.to);
    for (const { s, idx } of doneSteps) idx.forEach((b) => target.set(b, s.to));
    const districts = [...new Set([...sol.deviations.map((d) => d.district), ...(prevPlan?.districts ?? [])])].sort((x, y) => x - y);
    this.plan = {
      solutionId,
      target,
      stepBlocks: [...doneSteps.map((x) => x.idx), ...built.stepBlocks],
      // Strays are judged against the map the plan was made from: after a re-plan that is the current
      // map (edits made before it are part of what it solved), not the map the first plan started on.
      baseline: base,
      popsBefore: prevPlan?.popsBefore ?? this.currentDraPops(),
      districts,
    };
    const w: WalkthroughState = {
      solutionId,
      steps: [...doneSteps.map((x) => x.s), ...built.steps],
      current: doneSteps.length,
      strayEdits: [],
      liveTicking: this.source === 'live',
      mapMode: this.mapMode(),
    };
    if (w.steps[w.current]?.status === 'pending') w.steps[w.current] = { ...w.steps[w.current], status: 'active' };
    this.lastShownStep = -1;
    this.set({ walkthrough: w, hoveredSolutionId: undefined });
    this.tick();
    void this.showCurrentStep(true);
  }

  private tick() {
    const w = this.state.walkthrough;
    const plan = this.plan;
    if (!w || !plan || !this.assignment || !this.bundle) return;
    if (this.source !== 'live') return;
    const t0 = performance.now();
    const pending = new Set(this.snap?.pendingShatter ?? []);
    let next = tickWalkthrough(w, plan, this.assignment, pending, this.bundle.geoids);
    next = this.withFinalCheck(next);
    const changedDone = next.steps.some((s, i) => s.status !== w.steps[i].status || s.blocks.some((b, k) => b.done !== w.steps[i].blocks[k].done));
    const changed = changedDone || next.current !== w.current || next.strayEdits.length !== w.strayEdits.length || JSON.stringify(next.strayEdits) !== JSON.stringify(w.strayEdits) || JSON.stringify(next.finalCheck) !== JSON.stringify(w.finalCheck);
    if (changed) this.set({ walkthrough: next });
    this.perf.lastStepMs = performance.now() - t0;
    if (next.current !== this.lastShownStep) void this.showCurrentStep(true);
    else if (changedDone) void this.showCurrentStep(false);
  }

  private withFinalCheck(w: WalkthroughState): WalkthroughState {
    const plan = this.plan;
    const targets = this.targets;
    if (!plan || !targets || !allStepsDone(w) || (this.snap?.pendingShatter.length ?? 0) > 0) return w.finalCheck ? { ...w, finalCheck: undefined } : w;
    const after = this.currentDraPops();
    const scope = this.state.scope;
    const scopeDistricts = this.scopeDistricts(scope);
    const goal = scope.mode === 'one' ? scope.goal : undefined;
    const ok = scopeDistricts.every((d) =>
      goal !== undefined ? (after.get(d) ?? 0) === targets.draTarget + goal : isZeroed(after.get(d) ?? 0, targets),
    );
    return { ...w, finalCheck: { ok, deviations: deviationChanges(plan.districts, plan.popsBefore, after, targets.draTarget) } };
  }

  /** CSV mode has no live plan to re-read: report the plan's expected result, with ok = null. */
  private expectedFinalCheck(): WalkthroughState['finalCheck'] {
    const plan = this.plan;
    const b = this.bundle;
    const targets = this.targets;
    if (!plan || !b || !targets || !this.assignment) return { ok: null, deviations: [] };
    const after = districtPops(b.pop[this.popField], applyTargets(this.assignment, plan.target), targets.numDistricts);
    const afterMap = new Map(after.map((p, i) => [i, p] as const));
    return { ok: null, deviations: deviationChanges(plan.districts, plan.popsBefore, afterMap, targets.draTarget) };
  }

  private setCurrent(index: number, markPainted: boolean) {
    const w = this.state.walkthrough;
    if (!w || !w.steps.length) return;
    const current = Math.max(0, Math.min(w.steps.length - 1, index));
    const steps = w.steps.map((s, i) => (i === current && s.status === 'pending' ? { ...s, status: 'active' as const } : i !== current && s.status === 'active' ? { ...s, status: 'pending' as const } : s));
    let next: WalkthroughState = { ...w, current, steps };
    // In CSV mode there is no live ticking: "next" marks the step painted.
    if (this.source === 'csv' && markPainted && w.steps[w.current]) {
      next.steps[w.current] = { ...next.steps[w.current], status: 'done', blocks: next.steps[w.current].blocks.map((b) => ({ ...b, done: true })) };
      if (current === w.current && next.steps[current].status === 'done') {
        const after = next.steps.findIndex((s, i) => i > current && s.status !== 'done');
        if (after >= 0) next = { ...next, current: after, steps: next.steps.map((s, i) => (i === after && s.status === 'pending' ? { ...s, status: 'active' as const } : s)) };
      }
    }
    if (this.source === 'csv') next = { ...next, finalCheck: allStepsDone(next) ? this.expectedFinalCheck() : undefined };
    this.set({ walkthrough: next });
    void this.showCurrentStep(true);
  }

  private moveStep(delta: number) {
    const w = this.state.walkthrough;
    if (!w) return;
    this.setCurrent(w.current + delta, delta > 0);
  }

  /** walkthrough-jump: go straight to a step. Painting out of order is fine; nothing is marked painted. */
  private jumpTo(index: number) {
    const w = this.state.walkthrough;
    if (!w || !Number.isInteger(index) || index < 0 || index >= w.steps.length) return;
    this.setCurrent(index, false);
  }

  private async showCurrentStep(fit: boolean) {
    const w = this.state.walkthrough;
    const plan = this.plan;
    if (!w || !plan || !this.geo || !this.bundle) return;
    const step = w.steps[w.current];
    if (!step) return;
    const seq = ++this.highlightSeq;
    this.lastShownStep = w.current;
    const idx = plan.stepBlocks[w.current];
    const items: HighlightItem[] = [];
    // Precinct outline (the precinct to shatter), drawn under the numbered blocks.
    const ctx = this.stepContext();
    const p = ctx.precinctOf[idx[0]];
    const all = ctx.blocksOfPrecinct(p);
    const planned = new Set(idx);
    for (let k = 0; k < all.length; k++) if (all[k] >= 0 && !planned.has(all[k])) items.push({ block: all[k], role: 'precinct' });
    step.blocks.forEach((blk, k) => items.push({ block: idx[k], role: blk.done ? 'done' : this.roleFor(step.from, step.to), label: String(blk.number) }));
    const { fc, bbox } = await this.geo.build(items);
    if (seq !== this.highlightSeq) return;
    this.show(fc, fit && bbox ? bbox : undefined);
  }

  private async replan() {
    const w = this.state.walkthrough;
    const plan = this.plan;
    if (!w || !plan || !this.assignment) return;
    // Lock the blocks of finished steps (finished borders) so the re-plan only touches the rest.
    const locked = new Uint8Array(this.assignment.length);
    w.steps.forEach((s, i) => {
      if (s.status === 'done') for (const b of plan.stepBlocks[i]) locked[b] = 1;
    });
    // Blocks of finished steps are locked in both scopes, so no block is ever planned to move twice
    // (in particular the first leg of a two-way trade is never undone by the re-plan).
    const found = await this.solve({ locked, autoStart: true });
    // A re-plan that works starts a new walkthrough. One that finds nothing leaves this one up, and
    // the walkthrough view does not show the solve status, so say it in the banner (with what can
    // be done from here: the area and the districts cannot change during a walkthrough).
    const st = this.state;
    if (!st.walkthrough || st.solve.status === 'solving' || st.solve.status === 'loading-data') return;
    if (found) {
      if (this.replanNotice && st.notice?.text === this.replanNotice) this.set({ notice: undefined });
      this.replanNotice = null;
      return;
    }
    const why = st.solve.message ?? 'no plan for the rest was found.';
    const text = `Re-plan from here found nothing: ${why} You can keep painting this walkthrough, or end it to change the area or the districts and solve again.`;
    this.replanNotice = text;
    this.set({ notice: { level: 'warn', text } });
  }

  private endWalkthrough() {
    this.plan = null;
    this.highlightSeq++;
    this.set({ walkthrough: undefined });
    this.clearMap();
  }

  // ---------------------------------------------------------------------------
  // Painting the current step for the user (opt-in, one step per click)
  // ---------------------------------------------------------------------------

  /** Why painting cannot be offered right now, or null when it can. */
  private paintUnavailable(st: PanelState): string | null {
    if (this.source === 'csv') return 'Painting for you needs the live DRA tab, so it is off in CSV mode.';
    if (this.paintBroken) return this.paintBroken;
    if (st.connection !== 'live') return 'Painting for you needs a live, supported DRA map.';
    const p = this.snap?.paint;
    if (!p) return "This DRA tab's page hook does not report whether it can paint. Reload the DRA tab.";
    if (!p.ok) return p.reason ?? 'Painting is not available on this map.';
    return null;
  }

  private autoPaintState(st: PanelState): PanelState['autoPaint'] {
    const why = this.paintUnavailable(st);
    if (why) return { available: false, enabled: false, ...(this.paintBusy ? { busy: true } : {}), reason: why };
    const w = st.walkthrough;
    const stepId = w?.steps[w.current]?.id;
    const note = this.paintNote && this.paintNote.stepId === stepId ? this.paintNote.text : undefined;
    return { available: true, enabled: this.autoPaintPref, ...(this.paintBusy ? { busy: true } : {}), ...(note ? { reason: note } : {}) };
  }

  private setAutoPaint(enabled: boolean) {
    // Turning it off always works; turning it on only when it can be offered.
    if (enabled && this.paintUnavailable(this.state)) return;
    if (this.autoPaintPref === enabled) return;
    this.autoPaintPref = enabled;
    this.paintNote = null;
    this.opts.autoPaint?.save(enabled);
    this.set({});
  }

  private refusePaint(stepId: string, text: string) {
    this.paintNote = { stepId, text };
    this.set({});
  }

  /** walkthrough-paint-step: paint the current step through DRA's own actions, then let the hook verify it. */
  private paintCurrentStep(skipPanelChecks = false) {
    const ap = this.state.autoPaint;
    const w = this.state.walkthrough;
    if (!skipPanelChecks && (!ap?.available || !ap.enabled)) return;
    if (this.paintBusy || this.paintWaiter || this.undoBusy || this.undoWaiter || !w || !this.plan) return;
    const step = w.steps[w.current];
    if (!step) return;
    if (step.status === 'done') return this.refusePaint(step.id, 'This step is already painted.');
    if (step.status === 'awaiting-commit') return this.refusePaint(step.id, "This step's blocks are painted; commit the shattered precinct with DRA's checkmark.");
    const solving = this.state.solve.status;
    if (solving === 'solving' || solving === 'loading-data') return this.refusePaint(step.id, 'Wait for the solve or re-plan to finish.');
    const reqId = ++this.paintSeq;
    const stepIndex = w.current;
    const reqStep: PaintStepRequest = { stepId: step.id, precinctId: step.precinctId, from: step.from, to: step.to, wholePrecinct: step.wholePrecinct, blocks: step.blocks.map((b) => b.geoid) };
    this.paintBusy = true;
    this.paintNote = null;
    this.paintWaiter = {
      reqId,
      stepId: step.id,
      stepIndex,
      step: reqStep,
      timer: setTimeout(() => {
        if (this.paintWaiter?.reqId !== reqId) return;
        this.onPaintResult(reqId, {
          status: 'mismatch',
          stepId: step.id,
          summary: `The DRA tab did not answer within ${PAINT_TIMEOUT_MS / 1000} s, so the extension cannot tell whether it painted.`,
          details: [],
          changedSomething: true,
          undoRecorded: false,
        });
      }, PAINT_TIMEOUT_MS),
    };
    this.set({});
    this.link.send({ t: 'paint-step', reqId, step: reqStep });
  }

  private onPaintResult(reqId: number, r: PaintResult) {
    const waiter = this.paintWaiter;
    if (!waiter || waiter.reqId !== reqId) return; // late answer after a timeout: already reported
    clearTimeout(waiter.timer);
    this.paintWaiter = null;
    this.paintBusy = false;
    const n = waiter.stepIndex + 1;
    if (r.status === 'painted') {
      this.lastPaint = `step ${n} (${r.stepId}): painted, ${r.blocksMoved} blocks moved, ${r.featuresChanged} DRA features changed, ${r.ms} ms`;
      if (r.undoPos !== undefined && r.undoBefore !== undefined) {
        const entry: PaintUndoEntry = {
          stepId: waiter.step.stepId,
          stepIndex: waiter.stepIndex,
          stepNumber: n,
          precinctId: waiter.step.precinctId,
          from: waiter.step.from,
          to: waiter.step.to,
          wholePrecinct: waiter.step.wholePrecinct,
          blocks: waiter.step.blocks,
          undoBefore: r.undoBefore,
          undoPos: r.undoPos,
          ...(r.undoTopId !== undefined ? { undoTopId: r.undoTopId } : {}),
          minSnapSeq: r.snapSeq ?? 0,
          label: paintUndoLabel(n, waiter.step.to),
        };
        this.undoState = recordPaintUndo(this.undoState, entry);
        if (this.snap && this.snap.seq > entry.minSnapSeq) {
          this.undoState = reconcileDraSnapshot(this.undoState, {
            seq: this.snap.seq,
            undoPos: this.snap.undoPos,
            undoTopId: this.snap.undoTopId,
            pendingShatter: this.snap.pendingShatter,
          });
        }
      }
      this.set({});
      // Tick from the fresh plan right away (the hook also sends one after every paint).
      this.link.send({ t: 'request-snapshot' });
      return;
    }
    if (r.status === 'refused') {
      this.lastPaint = `step ${n} (${r.stepId}): refused: ${r.reason}`;
      this.paintNote = { stepId: r.stepId, text: `Not painted: ${r.reason}` };
      if (this.snap) {
        this.undoState = reconcileDraSnapshot(this.undoState, {
          seq: this.snap.seq,
          undoPos: this.snap.undoPos,
          undoTopId: this.snap.undoTopId,
          pendingShatter: this.snap.pendingShatter,
        });
      }
      this.set({});
      return;
    }
    // Anything other than exactly what was asked: stop for good (this session), switch the setting
    // off, say precisely what differs and how to take it back. The extension never calls undo itself.
    this.undoState = clearPaintUndo(this.undoState);
    const undo = !r.changedSomething
      ? 'Nothing changed in DRA, so there is nothing to undo.'
      : r.undoRecorded
        ? "DRA's own Undo (its Undo button, or Ctrl+Z in the DRA tab) takes this edit back in one step."
        : "DRA's own Undo (its Undo button, or Ctrl+Z in the DRA tab) should take this edit back; check the precinct afterwards, because DRA's undo history did not move by exactly one step.";
    const text = `Painting step ${n} did not do what was asked, so painting for you is now off. ${r.summary} ${r.details.join(' ')} ${undo}`.replace(/\s+/g, ' ').trim();
    this.lastPaint = `step ${n} (${r.stepId}): MISMATCH: ${text}`;
    console.warn('[zd] paint mismatch', r);
    this.paintBroken = text;
    this.paintNote = null;
    this.autoPaintPref = false;
    this.opts.autoPaint?.save(false);
    this.set({ notice: { level: 'error', text: `Painting step ${n} did not do what was asked. ${r.summary} ${undo}` } });
    this.link.send({ t: 'request-snapshot' });
  }

  // ---------------------------------------------------------------------------
  // Undo (PanelState.undo): painted steps via DRA's actionUndo, or destructive panel settings
  // ---------------------------------------------------------------------------

  private undoContext(st: PanelState): UndoContext {
    return {
      mapKey: st.map ? this.areaKey(st.map) : null,
      inWalkthrough: Boolean(st.walkthrough),
      canUndoPaint: this.source === 'live' && st.connection === 'live' && this.snap?.paint?.ok === true,
    };
  }

  private undo() {
    if (this.paintBusy || this.paintWaiter || this.undoBusy || this.undoWaiter) return;
    const active = activeUndoEntry(this.undoState, this.undoContext(this.state));
    if (!active) return;
    if (active.kind === 'setting') {
      this.undoSetting(active.entry);
      return;
    }
    this.undoPaintedStep(active.entry);
  }

  private undoSetting(entry: SettingUndoEntry) {
    const map = this.state.map;
    if (!map || this.state.walkthrough) return;
    this.undoState = clearSettingUndo(this.undoState);
    if (entry.kind === 'locks') {
      const key = lockKey(map);
      if (entry.prevLocks.length) this.locks[key] = entry.prevLocks.slice();
      else delete this.locks[key];
      this.opts.locks?.save({ ...this.locks });
      const scope =
        JSON.stringify(this.state.scope) === JSON.stringify(entry.afterScope)
          ? entry.prevScope
          : withoutLocked(this.state.scope, entry.prevLocks);
      this.solveSeq++;
      this.full.clear();
      this.highlightSeq++;
      this.clearMap();
      this.set({
        scope,
        solutions: [],
        hoveredSolutionId: undefined,
        feasibility: undefined,
        interaction: undefined,
        solve: this.state.solve.status === 'loading-data' ? this.state.solve : { status: 'idle' },
      });
      this.refreshInteraction();
      return;
    }
    this.areaCancelDraw();
    const key = this.areaKey(map);
    const restored = cloneSavedArea(entry.prevArea);
    this.areas[key] = restored;
    this.areaPendingMode = restored.mode;
    this.saveAreas();
    this.dropForArea();
  }

  private undoPaintedStep(entry: PaintUndoEntry) {
    const reqId = ++this.undoSeq;
    this.undoBusy = true;
    this.undoWaiter = {
      reqId,
      entry,
      timer: setTimeout(() => {
        if (this.undoWaiter?.reqId !== reqId) return;
        this.onUndoResult(reqId, {
          status: 'mismatch',
          stepId: entry.stepId,
          summary: `The DRA tab did not answer within ${PAINT_TIMEOUT_MS / 1000} s, so the extension cannot tell whether undo ran.`,
          details: [],
          changedSomething: true,
        });
      }, PAINT_TIMEOUT_MS),
    };
    this.set({});
    this.link.send({
      t: 'undo-paint',
      reqId,
      req: {
        stepId: entry.stepId,
        precinctId: entry.precinctId,
        from: entry.from,
        to: entry.to,
        wholePrecinct: entry.wholePrecinct,
        blocks: entry.blocks,
        expectedUndoPos: entry.undoPos,
        ...(entry.undoTopId !== undefined ? { expectedUndoTopId: entry.undoTopId } : {}),
      },
    });
  }

  private onUndoResult(reqId: number, r: UndoPaintResult) {
    const waiter = this.undoWaiter;
    if (!waiter || waiter.reqId !== reqId) return;
    clearTimeout(waiter.timer);
    this.undoWaiter = null;
    this.undoBusy = false;
    const { entry } = waiter;
    if (r.status === 'undone') {
      this.lastPaint = `undo step ${entry.stepNumber} (${r.stepId}): undone, ${r.blocksRestored} blocks restored, ${r.featuresChanged} DRA features changed, ${r.ms} ms`;
      this.undoState = afterPaintUndone(this.undoState, entry.stepId, r);
      const w = this.state.walkthrough;
      const idx = w ? w.steps.findIndex((s) => s.id === entry.stepId) : -1;
      if (idx >= 0) this.setCurrent(idx, false);
      else this.set({});
      this.link.send({ t: 'request-snapshot' });
      return;
    }
    if (r.status === 'refused') {
      this.lastPaint = `undo step ${entry.stepNumber} (${r.stepId}): refused: ${r.reason}`;
      if (r.stale) this.undoState = clearPaintUndo(this.undoState);
      this.set({ notice: { level: 'warn', text: `Could not undo step ${entry.stepNumber}: ${r.reason}` } });
      return;
    }
    this.undoState = clearPaintUndo(this.undoState);
    const text = `Undoing step ${entry.stepNumber} did not put the blocks back as expected. ${r.summary} ${r.details.join(' ')}`.replace(/\s+/g, ' ').trim();
    this.lastPaint = `undo step ${entry.stepNumber} (${r.stepId}): MISMATCH: ${text}`;
    console.warn('[zd] undo mismatch', r);
    this.set({ notice: { level: 'error', text } });
    this.link.send({ t: 'request-snapshot' });
  }

  // ---------------------------------------------------------------------------
  // CSV fallback
  // ---------------------------------------------------------------------------

  /** load-csv: allowed in any connection state, including live ('retry-connection' goes back). */
  private async loadCsv(text: string, fileName: string) {
    const parsed = parseBlockCsv(text);
    if (!parsed.rows.length) {
      this.set({ notice: { level: 'error', text: `${fileName}: no block rows found${parsed.errors.length ? ` (${parsed.errors[0]})` : ''}.` } });
      return;
    }
    const state = stateFromGeoid(parsed.rows[0].geoid);
    if (!state) {
      this.set({ notice: { level: 'error', text: `${fileName}: unknown state FIPS ${parsed.rows[0].geoid.slice(0, 2)}.` } });
      return;
    }
    if (this.state.walkthrough) this.endWalkthrough();
    this.source = 'csv';
    this.solveSeq++;
    this.undoState = emptyUndo();
    this.resetDerived();
    this.snap = null;
    this.targets = null;
    this.neighborsKey = '';
    const back = this.link.status.kind !== 'no-tab' ? ' Use "retry connection" to go back to the live tab.' : '';
    this.set({
      connection: 'csv',
      notice: { level: 'info', text: `Using ${fileName}. The CSV holds committed edits only and there is no live ticking: press Next after painting each step.${back}` },
      map: undefined,
      districts: [],
      unassigned: undefined,
      solutions: [],
      hoveredSolutionId: undefined,
      feasibility: undefined,
      interaction: undefined,
      walkthrough: undefined,
    });
    // The CSV doesn't say which population DRA uses; the live tab for the same state does, if we saw one.
    const b = await this.ensureData(state, this.lastLivePopField.get(state) ?? 'D20F');
    if (!b || this.source !== 'csv') return;
    const idx = labelIndexes(parsed.labels);
    const a = new Uint16Array(b.n);
    let missing = 0;
    for (const r of parsed.rows) {
      const i = geoidIndex(b, r.geoid);
      if (i < 0) missing++;
      else a[i] = idx.get(r.label) ?? 0;
    }
    const k = Math.max(...idx.values());
    const pop = b.pop[this.popField];
    let total = 0;
    for (let i = 0; i < b.n; i++) total += pop[i];
    this.targets = computeTargets(total, k);
    this.assignment = a;
    this.csvInfo = { fileName, rows: parsed.rows.length, missing, labels: parsed.labels.length };
    this.ensureGraph();
    const pops = districtPops(pop, a, k);
    const labelOf = new Map([...idx.entries()].map(([l, i]) => [i, l]));
    this.set({
      map: { state, numDistricts: k, popField: this.popField, totalPop: total, target: this.targets.draTarget, sourceName: fileName },
      districts: Array.from({ length: k }, (_, j) => ({ index: j + 1, label: labelOf.get(j + 1) ?? String(j + 1), pop: pops[j + 1], deviation: pops[j + 1] - this.targets!.draTarget })),
      ...(missing ? { notice: { level: 'warn' as const, text: `${fileName}: ${missing} GEOIDs are not in the ${state} data bundle.` } } : {}),
    });
    this.neighborsKey = '';
    this.syncUnassigned();
    this.updateNeighbors();
    if (this.state.scope.mode !== 'one') this.refreshInteraction();
  }

  // ---------------------------------------------------------------------------
  // Mini-map + test hooks
  // ---------------------------------------------------------------------------

  /** The mini-map (fallback): its highlight sink, and its side of the area (outline, "Use map view"). */
  attachMiniSink(sink: HighlightSink | null, area: AreaSink | null = null, clusters: ClusterSink | null = null) {
    this.miniSink = sink;
    this.miniArea = sink ? area : null;
    this.miniClusters = sink ? clusters : null;
    this.miniClusters?.show(this.clusterShown);
    if (sink && this.lastHighlight) sink.show(this.lastHighlight.fc, this.lastHighlight.fit);
    this.miniArea?.show(this.state.area?.ring ?? null);
    if (this.miniArea && this.source === 'live') {
      // The panel shows the mini-map for "Use map view" too, before anything is highlighted: point
      // it at the area, or at the state (from its block points, read for this).
      this.fitMiniIdle();
      if (!this.state.area?.ring) void this.ensurePoints();
    }
  }

  /** With nothing highlighted, the mini-map looks at the area, else at the whole state. */
  private fitMiniIdle() {
    const sink = this.miniSink;
    if (!sink || !this.miniArea || this.lastHighlight) return;
    const box = this.idleBox();
    if (box) sink.show({ type: 'FeatureCollection', features: [] }, box);
  }

  private idleBoxCache: { bundle: StateBundle; box: BBox } | null = null;

  private idleBox(): BBox | null {
    const ring = this.state.area?.ring;
    if (ring) {
      const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of ring) {
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
      return box;
    }
    const b = this.bundle;
    if (!b?.points || !this.state.map || b.manifest.state !== this.state.map.state) return null;
    if (this.idleBoxCache?.bundle !== b) {
      const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < b.n; i++) {
        const x = b.points[2 * i] / 1e6;
        const y = b.points[2 * i + 1] / 1e6;
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x;
        if (y > box[3]) box[3] = y;
      }
      this.idleBoxCache = { bundle: b, box };
    }
    return this.idleBoxCache.box;
  }

  /** Calls `listener` after every state change (diagnostics footer). */
  onDiagnosticsChange(listener: () => void): () => void {
    this.diagListeners.add(listener);
    return () => this.diagListeners.delete(listener);
  }

  /** Copyable plain-text diagnostics for a first live run. Built locally; nothing is sent anywhere. */
  diagnostics(): string {
    return buildDiagnostics(this.diagnosticsInput());
  }

  /** One line per link of tab -> content script (relay) -> page hook. */
  private linkDetail(): string[] {
    const l = this.link;
    const out = [`stage: ${l.stage()}`];
    out.push(l.relay ? `content script: attached (hook channel ${l.relay.hookAttached ? 'received' : 'NOT received'}, page ${l.relay.readyState}, running ${Math.round(l.relay.ageMs / 1000)} s)` : `content script: not heard from (${l.failedAttempts} failed attempts${l.lastConnectError ? `; ${l.lastConnectError}` : ''})`);
    out.push(l.alive ? `page hook: alive (v${l.alive.hookVersion}, window.dra ${l.alive.draPresent ? 'present' : 'MISSING'}, plan ${l.alive.planOpen ? 'open' : 'not open'}, page ${l.alive.readyState}, ${l.alive.offers} channel offer(s))` : 'page hook: not heard from');
    return out;
  }

  diagnosticsInput(): DiagnosticsInput {
    const b = this.bundle;
    return {
      extensionVersion: typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '?',
      build: __ZD_BUILD__,
      panelHookVersion: HOOK_VERSION,
      hookVersion: this.hookVersion,
      dataBaseUrl: this.opts.dataBaseUrl,
      link: this.link.status.kind,
      linkDetail: this.linkDetail(),
      hookError: this.hookError,
      connection: this.state.connection,
      source: this.source,
      mapMode: this.mapMode(),
      check: this.check,
      info: this.snap?.info ?? null,
      districtCount: this.snap ? this.snap.districts.length - 1 : this.state.districts.length,
      target: this.state.map?.target ?? null,
      featureCount: this.snap?.featureMap ? Object.keys(this.snap.featureMap).length : null,
      pendingShatter: this.snap?.pendingShatter ?? [],
      blockMappingStamp: this.snap?.blockMappingStamp ?? null,
      bundle: b ? { state: b.manifest.state, draDataVersion: b.manifest.draDataVersion, censusVintage: b.manifest.censusVintage, precinctKind: b.manifest.precinctKind, blocks: b.n, precincts: b.precinctIds.length, counties: b.manifest.counties.length, attrsFile: b.manifest.attrs.file } : null,
      popField: this.popField,
      popCheck: this.popCheck,
      csv: this.csvInfo,
      notice: this.state.notice?.text ?? null,
      solve: this.state.solve,
      paint: { availability: this.snap?.paint ?? null, setting: this.autoPaintPref, shown: this.state.autoPaint ?? null, last: this.lastPaint },
      area: this.state.area
        ? { corners: this.state.area.ring?.length ?? 0, mode: this.state.area.mode, blocks: this.state.area.blocks, people: this.state.area.people, drawing: this.state.area.drawing, unavailable: this.state.area.unavailable, points: b ? !!b.manifest.points : null, pointsLoaded: b ? !!b.points : null, maskMs: this.perf.areaMaskMs }
        : null,
      perf: { ...this.perf, engineInitMs: this.engine?.lastInitMs ?? 0, workerGeneration: this.engine?.generation ?? 0 },
    };
  }

  /**
   * Whole precincts now entirely in district `a` with a block touching district `b`, smallest
   * population first (tests use them to perturb a real map). Read-only.
   */
  borderPrecincts(a: number, b: number, limit = 5): Array<{ id: string; pop: number }> {
    const g = this.graph;
    const asg = this.assignment;
    const bundle = this.bundle;
    if (!g || !asg || !bundle) return [];
    const ctx = this.stepContext();
    const touching = new Set<number>();
    for (let i = 0; i < g.n; i++) {
      if (asg[i] !== a) continue;
      for (let e = g.adjOffsets[i]; e < g.adjOffsets[i + 1]; e++) if (asg[g.adjTargets[e]] === b) touching.add(ctx.precinctOf[i]);
    }
    const out: Array<{ id: string; pop: number }> = [];
    for (const p of touching) {
      const blocks = ctx.blocksOfPrecinct(p);
      let pop = 0;
      let whole = blocks.length > 0;
      for (let k = 0; k < blocks.length; k++) {
        const blk = blocks[k];
        if (blk < 0 || asg[blk] !== a) whole = false;
        else pop += g.pop[blk];
      }
      if (whole && pop > 0) out.push({ id: ctx.precinctIds[p], pop });
    }
    return out.sort((x, y) => x.pop - y.pop || (x.id < y.id ? -1 : 1)).slice(0, limit);
  }

  /** Test builds only: send a paint for the current step without the panel's own checks, so the page hook's guards answer. */
  testPaintSkippingPanelChecks() {
    if (__ZD_TEST__) this.paintCurrentStep(true);
  }

  setTestSolveDelay(ms: number) {
    if (__ZD_TEST__) this.testSolveDelayMs = ms;
  }

  /** Asks the hook for the highlight layer status (tests and diagnostics). */
  probeHighlight(): Promise<HighlightStatus> {
    const reqId = ++this.probeSeq;
    return new Promise((resolve) => {
      this.probeWaiters.set(reqId, resolve);
      this.link.send({ t: 'probe-highlight', reqId });
      setTimeout(() => {
        if (this.probeWaiters.delete(reqId)) resolve({ mapPresent: false, layers: [], onTop: false, featureCount: 0, rendered: 0, labelMode: 'none', htmlLabels: 0, styleLoads: 0, raises: 0, dataWrites: 0 });
      }, 2000);
    });
  }

  debug() {
    return {
      check: this.check,
      source: this.source,
      bundleLoaded: !!this.bundle,
      liveStamp: this.live?.stamp,
      unresolved: this.unresolved.length,
      assignmentReady: !!this.assignment,
      mapMode: this.mapMode(),
      link: this.link.status,
      lastHighlightFeatures: this.lastHighlight?.fc.features.length ?? 0,
      plan: this.plan ? { blocks: this.plan.target.size } : null,
      sink: this.sink() === this.hookSink ? 'hook' : 'mini',
      miniSink: !!this.miniSink,
      progressEvents: this.progressEvents,
      workerGeneration: this.engine?.generation ?? 0,
      perf: { ...this.perf, engineInitMs: this.engine?.lastInitMs ?? 0 },
      hookVersion: this.hookVersion,
      hookPerf: this.snap?.hookPerf ?? null,
      paint: { setting: this.autoPaintPref, busy: this.paintBusy, broken: this.paintBroken, last: this.lastPaint, hook: this.snap?.paint ?? null },
      solutionsFull: [...this.full.values()].map((s) => ({ id: s.id, transfers: s.transfers.map((t) => ({ from: t.from, to: t.to, people: t.people, blocks: t.blocks.length })) })),
      area: { drawing: this.areaDrawing, saved: Object.keys(this.areas).length, maskBlocks: this.areaMaskCache?.blocks ?? null, maskMs: this.perf.areaMaskMs, points: this.bundle ? !!this.bundle.manifest.points : null, pointsLoaded: this.bundle ? !!this.bundle.points : null, key: this.state.map ? this.areaKey(this.state.map) : null },
    };
  }

  /** Test builds: the loaded state's county names and adjacency (tests check clusters against them). */
  countyGraph(): { names: string[]; fips: string[]; adjacency: number[][] } | null {
    const b = this.bundle;
    if (!b || !this.graph) return null;
    return { names: countyNames(b), fips: b.countyFips.slice(), adjacency: this.countyAdjacencyOf(this.graph, b.countyFips.length) };
  }

  /** GEOIDs of the blocks a solution on offer moves (tests check them against the area). */
  solutionBlocks(id: string): string[] {
    const sol = this.full.get(id);
    const b = this.bundle;
    if (!sol || !b) return [];
    const moved = new Set<number>();
    for (const t of sol.transfers) for (const i of t.blocks) moved.add(i);
    return [...moved].map((i) => b.geoids[i]);
  }
}

function hasTwoWayTrade(s: Solution): boolean {
  const dirs = new Set(s.borderFlows.map((f) => `${f.from}>${f.to}`));
  return s.borderFlows.some((f) => dirs.has(`${f.to}>${f.from}`));
}

function mapStatus(s: string): PanelState['solve']['status'] {
  switch (s) {
    case 'ok':
    case 'already-zero':
      return 'done';
    case 'needs-precinct-rework':
      return 'needs-precinct-rework';
    case 'group-unbalanced':
      return 'group-unbalanced';
    default:
      return 'error';
  }
}

/** What a map's district locks are remembered under. DRA gives the panel no map id, so: where the plan came from, its state, its size and its name. */
function lockKey(map: NonNullable<PanelState['map']>): string {
  return [map.sourceName ? 'csv' : 'live', map.state, map.numDistricts, map.sourceName ?? map.planName ?? ''].join('|');
}
