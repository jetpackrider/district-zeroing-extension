/**
 * PanelController on top of the live hook (via TabLink), the bundle and the engine Worker.
 * packages/panel-ui renders getState() and dispatches PanelActions here.
 */
import {
  computeTargets,
  isZeroed,
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
import { createBundleSource, geoidIndex, toEngineGraph } from '../adapters/bundle';
import type { PanelHost } from '../shared/panel-host';
import { HOOK_VERSION, type BBox, type HighlightFC, type HookBlockMapping, type HookSnapshot, type HookToPanel, type HighlightStatus, type PaintResult, type SelfCheck } from '../shared/protocol';
import { buildLiveMapping, districtPops, featureMapToAssignment, type LiveMapping } from './assignment';
import { labelIndexes, parseBlockCsv, stateFromGeoid } from './csv';
import { CancelledError, EngineClient } from './engine-client';
import { GeometryCache, type HighlightItem, type HighlightSink } from './highlights';
import { detectUnsupported } from './scope';
import { TabLink, type LinkStatus } from './tab-link';
import { allStepsDone, applyTargets, buildSteps, deviationChanges, tickWalkthrough, type WalkPlan } from './walkthrough';
import { buildDiagnostics, type DiagnosticsInput } from './diagnostics';
import type { WorkerResponse } from '../worker/protocol';
import { choiceTolerance, joinDistrictNames, sanitizeScope, solveDistrictMessage, withoutLocked } from '../worker/choice';

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
}

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
  private bundleSource: BundleSource;
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

  // Painting a step for the user (opt-in; see src/dra/hooks.ts paintStep)
  /** The user's remembered choice. What the panel shows is this AND available. */
  private autoPaintPref = false;
  private paintBusy = false;
  /** Set after a paint that did not do what was asked: painting stays off for this panel session. */
  private paintBroken: string | null = null;
  /** Why the last paint of a step was refused (shown with that step only). */
  private paintNote: { stepId: string; text: string } | null = null;
  private paintSeq = 0;
  private paintWaiter: { reqId: number; stepId: string; stepIndex: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Last paint outcome, for the diagnostics. */
  private lastPaint: string | null = null;

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
    startedAt: performance.now(),
  };

  constructor(private readonly opts: ControllerOptions) {
    this.bundleSource = createBundleSource(opts.dataBaseUrl);
    this.autoPaintPref = opts.autoPaint?.enabled === true;
    this.locks = { ...(opts.locks?.saved ?? {}) };
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
      case 'solve':
        if (this.paintBusy) break; // never solve under a paint in flight
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
        if (this.paintBusy) break; // never re-plan under a paint in flight
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
    this.state = next;
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
    if (this.source === 'csv') {
      if (s.kind !== 'connected') this.check = null;
      this.set({}); // map mode may change
      return;
    }
    if (s.kind === 'no-tab') {
      this.check = null;
      this.snap = null;
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
    this.snap = null;
    this.resetDerived();
    this.solveSeq++;
    this.set({
      connection: 'no-plan',
      notice: { level: 'info', text: 'Open one of your maps in DRA to start, or drop a DRA block-assignment CSV here.' },
      map: undefined,
      districts: [],
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
      this.resetDerived();
      [this.features, this.featureSeq] = keep;
      patch.solutions = [];
      patch.walkthrough = undefined;
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
    this.set({ solve: { status: 'loading-data', progress: 0, message: `Loading ${state} data…` } });
    const t0 = performance.now();
    this.bundleLoading = this.bundleSource.loadState(state, (loaded, total) => {
      if (total > 0) this.set({ solve: { status: 'loading-data', progress: loaded / total, message: `Loading ${state} data…` } });
    });
    try {
      const b = await this.bundleLoading;
      if (this.bundleState !== state) return b;
      this.perf.bundleMs = performance.now() - t0;
      this.bundle = b;
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

  private neighborsKey = '';
  private updateNeighbors() {
    const g = this.graph;
    const a = this.assignment;
    if (!g || !a) return;
    const k = this.targets?.numDistricts ?? this.state.districts.length;
    const sets = Array.from({ length: k + 1 }, () => new Set<number>());
    for (let i = 0; i < g.n; i++) {
      const da = a[i];
      if (!da) continue;
      for (let e = g.adjOffsets[i]; e < g.adjOffsets[i + 1]; e++) {
        const db = a[g.adjTargets[e]];
        if (db && db !== da) sets[da].add(db);
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
      this.resetDerived();
      this.snap = null;
      this.csvInfo = null;
      this.targets = null;
      this.neighborsKey = '';
      this.solveSeq++;
      this.set({ ...INITIAL, scope: this.state.scope, solve: this.bundleLoading && !this.bundle ? this.state.solve : { status: 'idle' } });
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
   * With "outside neighbors absorb" and locks: the outside districts that may still take or give.
   * Undefined when nothing is locked (any outside neighbor).
   */
  private outsideAbsorbers(scope: Scope, districts: number[]): number[] | undefined {
    const locked = this.lockedSet();
    if (scope.mode !== 'group' || !scope.allowOutsideAbsorb || !locked.size) return undefined;
    const inGroup = new Set(districts);
    const k = this.targets?.numDistricts ?? 0;
    return Array.from({ length: k }, (_, i) => i + 1).filter((d) => !inGroup.has(d) && !locked.has(d));
  }

  /** Lock or unlock districts: a locked district is never changed by a suggestion. */
  private setDistrictLock(districts: number[], lock: boolean) {
    const map = this.state.map;
    if (!map || this.state.walkthrough) return;
    const next = new Set(this.state.lockedDistricts ?? []);
    for (const d of districts) {
      if (!Number.isInteger(d) || d < 1 || d > map.numDistricts) continue;
      if (lock) next.add(d);
      else next.delete(d);
    }
    const list = [...next].sort((a, b) => a - b);
    if (JSON.stringify(list) === JSON.stringify(this.state.lockedDistricts ?? [])) return;
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
      scope: withoutLocked(this.state.scope, list),
      solutions: [],
      hoveredSolutionId: undefined,
      feasibility: undefined,
      interaction: undefined,
      solve: this.state.solve.status === 'loading-data' ? this.state.solve : { status: 'idle' },
    });
    this.refreshInteraction();
  }

  private interactionInFlight = 0;

  private neighborsOf = (d: number) => this.state.districts.find((r) => r.index === d)?.neighbors;

  private districtName(d: number): string {
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
        absorbers: this.outsideAbsorbers(scope, districts),
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

  private async solve(opts: { locked?: Uint8Array; autoStart?: boolean } = {}) {
    const why = this.canSuggest();
    if (why) {
      this.set({ solve: { status: 'error', message: why } });
      return;
    }
    const scope = this.state.scope;
    const lockedDistricts = this.state.lockedDistricts ?? [];
    const lockedSet = new Set(lockedDistricts);
    const lockedNames = this.districtNames(lockedDistricts);
    if (scope.mode === 'one' && lockedSet.has(scope.district)) {
      this.set({ solutions: [], solve: { status: 'error', message: `${this.districtName(scope.district)} is locked, so nothing may change it. Unlock it in the district list to zero it.` } });
      return;
    }
    // With locks, a one-district solve trades only with the neighbors that are not locked.
    const one = scope.mode === 'one' ? scope.district : 0;
    const openNeighbors = one && lockedSet.size ? this.neighborsOf(one)?.filter((d) => !lockedSet.has(d)) : undefined;
    if (openNeighbors && openNeighbors.length === 0) {
      this.set({ solutions: [], solve: { status: 'error', message: `Every district next to ${this.districtName(one)} is locked, so there is nowhere for people to go. Unlock one of its neighbors.` } });
      return;
    }
    const seq = ++this.solveSeq;
    const assignment = this.planningAssignment();
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
      if (scope.mode === 'one') {
        // The user's choice of neighbors (absent = any neighbor, today's behavior: no neighbor may end
        // further from zero). A chosen neighbor may take or give the whole difference, whatever it
        // does to its own deviation: that is the user's call.
        const district = scope.district;
        const chosen = scope.mode === 'one' && scope.with?.length ? scope.with.filter((d) => !lockedSet.has(d) && (this.neighborsOf(scope.district)?.includes(d) ?? true)) : [];
        const devOf = (d: number) => this.state.districts.find((r) => r.index === d)?.deviation ?? 0;
        const choice = chosen.length
          ? { absorbers: chosen, neighborTolerance: choiceTolerance(devOf(scope.district), chosen.map(devOf)) }
          : openNeighbors
            ? { absorbers: openNeighbors }
            : {};
        const r = await this.engine!.request<Extract<WorkerResponse, { type: 'district-result' }>>({ type: 'solve-district', assignment, targets, district: scope.district, ...choice, maxOptions: 6, locked: opts.locked, lockedDistricts, testDelayMs: this.testSolveDelayMs || undefined });
        solutions = r.result.solutions;
        message = r.result.message;
        status = mapStatus(r.result.status);
        workerMs = r.result.elapsedMs;
        if (r.result.status === 'already-zero') message = message ?? 'This district is already at zero.';
        message = solveDistrictMessage({
          district: scope.district,
          chosen,
          shown: solutions.length,
          status: r.result.status,
          fallback: r.fallback,
          message,
          dropped: r.choiceDropped,
          name: (d) => this.districtName(d),
        });
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
        const r = await this.engine!.request<Extract<WorkerResponse, { type: 'group-result' }>>(
          { type: 'solve-group', assignment, targets, districts, allowOutsideAbsorb: scope.mode === 'group' ? scope.allowOutsideAbsorb : false, absorbers: this.outsideAbsorbers(scope, districts), locked: opts.locked, lockedDistricts, testDelayMs: this.testSolveDelayMs || undefined },
          (done, total) => {
            this.progressEvents++;
            if (seq === this.solveSeq) this.set({ solve: { status: 'solving', progress: total ? done / total : 0 } });
          },
        );
        solutions = r.result.solutions;
        message = r.result.message;
        status = mapStatus(r.result.status);
        workerMs = r.result.elapsedMs;
        feasibility = this.unlockedOnly(r.result.feasibility);
        interaction = r.result.interaction?.nodes?.length ? r.result.interaction : undefined;
        // The planner words its feasibility line for a group; on the whole map it is noise, and
        // with locks the thing worth saying is what was left alone.
        if (scope.mode === 'all' && solutions.length && message === 'This group can be zeroed on its own.') {
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
      const patch: Partial<PanelState> = { solutions: cards, solve: { status, message, elapsedMs: Math.round(workerMs || this.perf.lastSolveMs) } };
      if (scope.mode === 'group' && feasibility) patch.feasibility = feasibility;
      if (interaction) patch.interaction = interaction;
      this.set(patch);
      if (opts.autoStart && solutions[0]) this.startWalkthrough(solutions[0].id, true);
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

  private roleFor(from: number, to: number): HighlightItem['role'] {
    const s = this.state.scope;
    if (s.mode === 'one') return from === s.district ? 'remove' : 'add';
    void to;
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
    const scopeDistricts = this.scopeDistricts();
    const ok = scopeDistricts.every((d) => isZeroed(after.get(d) ?? 0, targets));
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
    await this.solve({ locked, autoStart: true });
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
    if (this.paintBusy || this.paintWaiter || !w || !this.plan) return;
    const step = w.steps[w.current];
    if (!step) return;
    if (step.status === 'done') return this.refusePaint(step.id, 'This step is already painted.');
    if (step.status === 'awaiting-commit') return this.refusePaint(step.id, "This step's blocks are painted; commit the shattered precinct with DRA's checkmark.");
    const solving = this.state.solve.status;
    if (solving === 'solving' || solving === 'loading-data') return this.refusePaint(step.id, 'Wait for the solve or re-plan to finish.');
    const reqId = ++this.paintSeq;
    const stepIndex = w.current;
    this.paintBusy = true;
    this.paintNote = null;
    this.paintWaiter = {
      reqId,
      stepId: step.id,
      stepIndex,
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
    this.link.send({ t: 'paint-step', reqId, step: { stepId: step.id, precinctId: step.precinctId, from: step.from, to: step.to, wholePrecinct: step.wholePrecinct, blocks: step.blocks.map((b) => b.geoid) } });
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
      this.set({});
      // Tick from the fresh plan right away (the hook also sends one after every paint).
      this.link.send({ t: 'request-snapshot' });
      return;
    }
    if (r.status === 'refused') {
      this.lastPaint = `step ${n} (${r.stepId}): refused: ${r.reason}`;
      this.paintNote = { stepId: r.stepId, text: `Not painted: ${r.reason}` };
      this.set({});
      return;
    }
    // Anything other than exactly what was asked: stop for good (this session), switch the setting
    // off, say precisely what differs and how to take it back. The extension never calls undo itself.
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
    this.updateNeighbors();
    if (this.state.scope.mode !== 'one') this.refreshInteraction();
  }

  // ---------------------------------------------------------------------------
  // Mini-map + test hooks
  // ---------------------------------------------------------------------------

  attachMiniSink(sink: HighlightSink | null) {
    this.miniSink = sink;
    if (sink && this.lastHighlight) sink.show(this.lastHighlight.fc, this.lastHighlight.fit);
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
    };
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
