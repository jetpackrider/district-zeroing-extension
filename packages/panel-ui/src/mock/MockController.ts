import { computeTargets, isZeroed } from '@zd/contracts';
import { formatDistrictName, formatSigned } from '../format';
import type {
  GroupFeasibility,
  PanelAction,
  PanelController,
  PanelState,
  Scope,
  SolutionCard,
  WalkthroughStep,
} from '@zd/contracts';
import {
  AREA_DRAWN_COUNTS,
  AREA_DRAWN_RING,
  AREA_VIEW_COUNTS,
  AREA_VIEW_RING,
  DRAWING_PLAN_SOLUTION,
  GROUP_CHAIN_SOLUTIONS,
  NY_MAP_INFO,
  SCENARIOS,
  SINGLE_DISTRICT_SOLUTIONS,
  TWO_WAY_WALKTHROUGH_SOLUTION,
  buildInteractionForDistricts,
  makeChosenNeighborOptions,
  makeChainWalkthroughSteps,
  makeMockClusterings,
  makeDrawingWalkthroughSteps,
  makeNYDistricts,
  makeTwoWayWalkthroughSteps,
} from './scenarios';
import type { ScenarioId } from './scenarios';

export interface MockControllerOptions {
  initialScenario?: ScenarioId;
  initialState?: PanelState;
  onAction?: (action: PanelAction) => void;
  /** How long a simulated "Paint this step" takes (default 700 ms). */
  paintDelayMs?: number;
  /**
   * After "Draw area", finish the drawing by itself after this many ms (the dev harness), as if the
   * user had clicked the corners on the map. Absent or 0 = wait for finishAreaDraw() (tests).
   */
  areaDrawMs?: number;
  /**
   * After "Find clusters", finish the search by itself after this many ms (the dev harness).
   * Absent or 0 = stay 'finding' until finishClusterFind() (tests).
   */
  clusterFindMs?: number;
}

/**
 * Interactive mock implementation of PanelController for the dev harness and tests.
 * Supports switching scripted scenarios, reacting to all PanelActions, and ticking
 * walkthrough blocks over time.
 */
export class MockController implements PanelController {
  private state: PanelState;
  private listeners = new Set<() => void>();
  private onAction?: (action: PanelAction) => void;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private paintDelayMs: number;
  private areaDrawMs: number;
  private areaTimer: ReturnType<typeof setTimeout> | null = null;
  private clusterFindMs: number;
  private clusterTimer: ReturnType<typeof setTimeout> | null = null;
  private paintUndoStack: Array<{ stepId: string; stepIndex: number; from: number; to: number; moved: number; label: string }> = [];
  private settingUndo:
    | { kind: 'locks'; prevLocks: number[]; prevScope: Scope; afterScope: Scope; label: string }
    | { kind: 'area'; prevArea: PanelState['area']; label: string }
    | null = null;
  private undoLatest: 'paint' | 'setting' | null = null;

  constructor(options: MockControllerOptions = {}) {
    this.onAction = options.onAction;
    this.paintDelayMs = options.paintDelayMs ?? 700;
    this.areaDrawMs = options.areaDrawMs ?? 0;
    this.clusterFindMs = options.clusterFindMs ?? 0;
    if (options.initialState) {
      this.state = structuredClone(options.initialState);
    } else {
      const id = options.initialScenario ?? 'live-single';
      this.state = SCENARIOS[id].createState();
    }
  }

  getState(): PanelState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setState(next: PanelState): void {
    this.state = next;
    this.emit();
  }

  setScenario(id: ScenarioId): void {
    this.stopAutoTick();
    this.stopAreaTimer();
    this.stopClusterTimer();
    this.clearAllUndo();
    this.state = SCENARIOS[id].createState();
    this.emit();
  }

  private clearAllUndo(): void {
    this.paintUndoStack = [];
    this.settingUndo = null;
    this.undoLatest = null;
  }

  private currentMockUndo(inWalkthrough = Boolean(this.state.walkthrough)): PanelState['undo'] {
    const settingOk = this.settingUndo !== null && !inWalkthrough;
    const paintOk = this.paintUndoStack.length > 0;
    if (this.undoLatest === 'setting' && settingOk) return { kind: 'setting', label: this.settingUndo!.label };
    if (this.undoLatest === 'paint' && paintOk) return { kind: 'paint', label: this.paintUndoStack[this.paintUndoStack.length - 1].label };
    if (paintOk) return { kind: 'paint', label: this.paintUndoStack[this.paintUndoStack.length - 1].label };
    if (settingOk) return { kind: 'setting', label: this.settingUndo!.label };
    return undefined;
  }

  startAutoTick(intervalMs = 1100): void {
    this.stopAutoTick();
    this.tickTimer = setInterval(() => {
      const progressed = this.tickNextBlock();
      if (!progressed) {
        this.stopAutoTick();
      }
    }, intervalMs);
  }

  stopAutoTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Simulates the user finishing a drawing on DRA's map: the ring replaces any area there was, with
   * made-up counts of what is inside. No effect unless drawing.
   */
  finishAreaDraw(ring: Array<[number, number]> = AREA_DRAWN_RING): void {
    this.stopAreaTimer();
    const area = this.state.area;
    if (!area?.drawing) return;
    const hadArea = Boolean(area.ring || area.region || area.cluster);
    this.setArea(
      {
        mode: area.mode, unavailable: area.unavailable, drawing: false,
        ring: ring.map((p) => [p[0], p[1]] as [number, number]), ...AREA_DRAWN_COUNTS,
      },
      hadArea ? 'Undo replacing area' : undefined,
    );
  }

  /** Simulates clicking a named region on DRA's map. */
  finishAreaPick(index?: number): void {
    const kind = this.state.area?.picking;
    if (!kind) return;
    const regions = kind === 'county' ? this.state.regions?.counties : this.state.regions?.towns;
    const selected = index ?? regions?.[0]?.index;
    if (selected !== undefined) this.useRegion(kind, selected);
  }

  private useRegion(kind: 'county' | 'town', index: number): void {
    const { area, regions, walkthrough } = this.state;
    const choice = (kind === 'county' ? regions?.counties : regions?.towns)?.find((r) => r.index === index);
    if (walkthrough || !choice) return;
    this.stopAreaTimer();
    const hadArea = Boolean(area?.ring || area?.region || area?.cluster);
    this.setArea(
      {
        mode: area?.mode ?? 'prefer', unavailable: area?.unavailable, drawing: false,
        region: { kind, ...choice }, ...(kind === 'county' ? AREA_VIEW_COUNTS : AREA_DRAWN_COUNTS),
      },
      hadArea ? 'Undo replacing area' : undefined,
    );
  }

  /**
   * A new area (or mode, or none): like the extension, the options on offer were found for the old
   * one, so they are dropped.
   */
  private setArea(area: PanelState['area'], undoLabel?: string): void {
    const prevArea = this.state.area;
    if (undoLabel && prevArea && (prevArea.ring || prevArea.region || prevArea.cluster)) {
      this.settingUndo = { kind: 'area', prevArea: structuredClone(prevArea), label: undoLabel };
      this.undoLatest = 'setting';
    }
    this.state = {
      ...this.state,
      area,
      undo: this.currentMockUndo(),
      solutions: [],
      hoveredSolutionId: undefined,
      solve: { status: 'idle' },
    };
    this.emit();
  }

  private stopAreaTimer(): void {
    if (this.areaTimer !== null) {
      clearTimeout(this.areaTimer);
      this.areaTimer = null;
    }
  }

  /**
   * Simulates the county-cluster search finishing: made-up clusterings for the requested district
   * count and tolerance, or none below ±1%. No effect unless finding.
   */
  finishClusterFind(): void {
    this.stopClusterTimer();
    const clusters = this.state.clusters;
    if (clusters?.status !== 'finding') return;
    const { numDistricts, tolerance } = clusters;
    const totalPop = this.state.map?.totalPop ?? NY_MAP_INFO.totalPop;
    const districtSize = totalPop / numDistricts;
    const tight = tolerance < 0.01 && numDistricts > 1;
    const pct = `±${Number((tolerance * 100).toFixed(2))}%`;
    this.state = {
      ...this.state,
      clusters: {
        ...clusters,
        status: tight ? 'none' : 'done',
        districtSize,
        results: tight ? [] : makeMockClusterings(numDistricts, tolerance, totalPop),
        exhaustive: tight || numDistricts <= 14,
        elapsedMs: tight ? 840 : numDistricts <= 14 ? 2300 : 10000,
        message: tight
          ? `No grouping of whole counties keeps every district within ${pct} of ${Math.round(districtSize).toLocaleString('en-US')}. Try a wider tolerance.`
          : undefined,
        hovered: undefined,
      },
    };
    this.emit();
  }

  private stopClusterTimer(): void {
    if (this.clusterTimer !== null) {
      clearTimeout(this.clusterTimer);
      this.clusterTimer = null;
    }
  }

  private useCluster(id: string, index: number): void {
    const { area, clusters, walkthrough } = this.state;
    const clustering = clusters?.results.find((r) => r.id === id);
    const cluster = clustering?.clusters[index];
    if (walkthrough || !clustering || !cluster || area?.drawing || area?.picking) return;
    this.stopAreaTimer();
    const names = clustering.countyNames[index] ?? [];
    const name = names.length === 1 ? names[0] : `${names[0] ?? 'County'} cluster (${names.length} counties)`;
    const hadArea = Boolean(area?.ring || area?.region || area?.cluster);
    this.setArea(
      {
        mode: area?.mode ?? 'prefer', unavailable: area?.unavailable, drawing: false,
        cluster: { name, counties: [...cluster.counties] }, blocks: cluster.counties.length * 731, people: cluster.pop,
      },
      hadArea ? 'Undo replacing area' : undefined,
    );
  }

  /**
   * Simulates the user painting the next unfinished block in the current walkthrough step
   * (or committing an awaiting-commit step), updating district deviations live.
   */
  tickNextBlock(): boolean {
    const wt = this.state.walkthrough;
    if (!wt || wt.finalCheck) return false;

    const steps = wt.steps.map((s) => ({
      ...s,
      blocks: s.blocks.map((b) => ({ ...b })),
    }));
    const cur = steps[wt.current];
    if (!cur) return false;

    // A manual edit in DRA moves DRA's undo history, withdrawing any pending paint undo.
    if (this.paintUndoStack.length > 0) {
      this.paintUndoStack = [];
      this.undoLatest = this.settingUndo ? 'setting' : null;
    }

    // If awaiting commit, simulate user clicking DRA's checkmark and advancing
    if (cur.status === 'awaiting-commit') {
      cur.status = 'done';
      if (wt.current + 1 < steps.length) {
        steps[wt.current + 1].status = 'active';
        this.state = {
          ...this.state,
          undo: this.currentMockUndo(true),
          walkthrough: { ...wt, steps, current: wt.current + 1 },
        };
      } else {
        this.state = {
          ...this.state,
          undo: this.currentMockUndo(true),
          walkthrough: {
            ...wt,
            steps,
            finalCheck: this.buildFinalCheck(),
          },
        };
      }
      this.emit();
      return true;
    }

    // Find next undone block in current step
    const nextBlock = cur.blocks.find((b) => !b.done);
    if (nextBlock) {
      if (cur.wholePrecinct) {
        // Whole-precinct step ticks all blocks at once and marks done
        let moved = 0;
        for (const b of cur.blocks) {
          if (!b.done) {
            b.done = true;
            moved += b.people;
          }
        }
        cur.status = 'done';
        const live = this.applyLiveTransfer(cur.from, cur.to, moved);
        const hasNext = wt.current + 1 < steps.length;
        if (hasNext) steps[wt.current + 1].status = 'active';
        this.state = {
          ...this.state,
          ...live,
          undo: this.currentMockUndo(true),
          walkthrough: {
            ...wt,
            steps,
            current: hasNext ? wt.current + 1 : wt.current,
            finalCheck: hasNext ? undefined : this.buildFinalCheck(live.districts),
          },
        };
        this.emit();
        return true;
      }

      nextBlock.done = true;
      const live = this.applyLiveTransfer(cur.from, cur.to, nextBlock.people);
      const allBlocksDone = cur.blocks.every((b) => b.done);
      cur.status = allBlocksDone ? 'awaiting-commit' : 'active';
      this.state = {
        ...this.state,
        ...live,
        undo: this.currentMockUndo(true),
        walkthrough: { ...wt, steps },
      };
      this.emit();
      return true;
    }

    return false;
  }

  /** Simulates the extension painting the current step in DRA: busy, then every block ticks at once. */
  private handlePaintStep(): void {
    const ap = this.state.autoPaint;
    const wt = this.state.walkthrough;
    if (!ap?.available || !ap.enabled || ap.busy || !wt) return;
    const cur = wt.steps[wt.current];
    if (!cur || cur.status === 'done' || cur.status === 'awaiting-commit') return;
    this.state = { ...this.state, autoPaint: { ...ap, busy: true, reason: undefined } };
    this.emit();
    setTimeout(() => {
      const w = this.state.walkthrough;
      const a = this.state.autoPaint;
      if (!a) return;
      if (!w || !w.steps[w.current] || w.steps[w.current].id !== cur.id) {
        this.state = { ...this.state, autoPaint: { ...a, busy: false } };
        this.emit();
        return;
      }
      const steps = w.steps.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b })) }));
      const step = steps[w.current];
      let moved = 0;
      for (const b of step.blocks) {
        if (!b.done) moved += b.people;
        b.done = true;
      }
      // Painting a block step commits it directly: no shatter, no checkmark.
      step.status = 'done';
      const live = this.applyLiveTransfer(step.from, step.to, moved);
      const next = steps.findIndex((s, i) => i > w.current && s.status !== 'done');
      if (next >= 0 && steps[next].status === 'pending') steps[next].status = 'active';
      const label = step.to === 0 ? `Undo erasing step ${w.current + 1}` : `Undo painting step ${w.current + 1}`;
      this.paintUndoStack.push({ stepId: step.id, stepIndex: w.current, from: step.from, to: step.to, moved, label });
      this.undoLatest = 'paint';
      this.state = {
        ...this.state,
        ...live,
        autoPaint: { ...a, busy: false },
        undo: this.currentMockUndo(true),
        walkthrough: {
          ...w,
          steps,
          current: next >= 0 ? next : w.current,
          finalCheck: next >= 0 ? undefined : this.buildFinalCheck(live.districts),
        },
      };
      this.emit();
    }, this.paintDelayMs);
  }

  /** Injects a simulated stray edit into the active walkthrough. */
  injectStrayEdit(): void {
    const wt = this.state.walkthrough;
    if (!wt) return;
    const step = wt.steps[wt.current];
    const fromDistrict = step?.from ?? 4;
    const toDistrict = fromDistrict === 4 ? 5 : 1;
    const suffix = String(1000 + wt.strayEdits.length * 7);
    this.state = {
      ...this.state,
      walkthrough: {
        ...wt,
        strayEdits: [
          ...wt.strayEdits,
          { geoid: `36059407102${suffix}`, fromDistrict, toDistrict },
        ],
      },
    };
    this.emit();
  }

  dispatch(action: PanelAction): void {
    this.onAction?.(action);

    switch (action.type) {
      case 'set-scope': {
        this.handleSetScope(action.scope);
        break;
      }
      case 'area-draw': {
        const area = this.state.area;
        if (this.state.walkthrough || area?.drawing || area?.picking || area?.unavailable) return;
        // Drawing alone does not change the area, so the options stay until it is finished.
        this.state = { ...this.state, area: { ...(area ?? { mode: 'prefer' }), drawing: true } };
        this.emit();
        if (this.areaDrawMs > 0) {
          this.stopAreaTimer();
          this.areaTimer = setTimeout(() => this.finishAreaDraw(), this.areaDrawMs);
        }
        break;
      }
      case 'area-cancel-draw': {
        this.stopAreaTimer();
        const area = this.state.area;
        if (!area?.drawing && !area?.picking) return;
        // Cancelling a first drawing leaves no area at all; otherwise the old one stays.
        this.state = {
          ...this.state,
          area: area.ring || area.region || area.cluster || area.unavailable ? { ...area, drawing: false, picking: undefined } : undefined,
        };
        this.emit();
        break;
      }
      case 'area-use-view': {
        const area = this.state.area;
        if (this.state.walkthrough) return;
        if (area?.unavailable && this.state.mapMode !== 'mini') return;
        this.stopAreaTimer();
        const hadArea = Boolean(area?.ring || area?.region || area?.cluster);
        this.setArea(
          {
            mode: area?.mode ?? 'prefer',
            ring: AREA_VIEW_RING.map((p) => [p[0], p[1]] as [number, number]),
            ...AREA_VIEW_COUNTS,
            drawing: false,
            ...(area?.unavailable ? { unavailable: area.unavailable } : {}),
          },
          hadArea ? 'Undo replacing area' : undefined,
        );
        break;
      }
      case 'area-use-region':
        this.useRegion(action.kind, action.index);
        break;
      case 'area-pick-region': {
        const { area, regions, walkthrough } = this.state;
        const choices = action.kind === 'county' ? regions?.counties : regions?.towns;
        if (walkthrough || area?.drawing || area?.picking || area?.unavailable || !choices?.length) return;
        this.state = { ...this.state, area: { mode: 'prefer', ...area, drawing: false, picking: action.kind } };
        this.emit();
        if (this.areaDrawMs > 0) this.areaTimer = setTimeout(() => this.finishAreaPick(), this.areaDrawMs);
        break;
      }
      case 'area-clear': {
        if (this.state.walkthrough || !this.state.area) return;
        this.stopAreaTimer();
        const unavailable = this.state.area.unavailable;
        this.setArea(
          unavailable ? { mode: this.state.area.mode, drawing: false, unavailable } : undefined,
          'Undo clearing area',
        );
        break;
      }
      case 'clusters-find': {
        if (this.state.walkthrough || this.state.clusters?.status === 'finding') return;
        this.stopClusterTimer();
        this.state = {
          ...this.state,
          clusters: { status: 'finding', numDistricts: action.numDistricts, tolerance: action.tolerance, results: [] },
        };
        this.emit();
        if (this.clusterFindMs > 0) this.clusterTimer = setTimeout(() => this.finishClusterFind(), this.clusterFindMs);
        break;
      }
      case 'clusters-cancel': {
        const clusters = this.state.clusters;
        if (clusters?.status !== 'finding') return;
        this.stopClusterTimer();
        this.state = { ...this.state, clusters: { ...clusters, status: 'idle', results: [], hovered: undefined } };
        this.emit();
        break;
      }
      case 'clusters-hover': {
        const clusters = this.state.clusters;
        if (!clusters) return;
        const hovered =
          action.id === null || !clusters.results.some((r) => r.id === action.id)
            ? undefined
            : action.cluster === undefined
              ? { id: action.id }
              : { id: action.id, cluster: action.cluster };
        if (JSON.stringify(hovered) === JSON.stringify(clusters.hovered)) return;
        this.state = { ...this.state, clusters: { ...clusters, hovered } };
        this.emit();
        break;
      }
      case 'clusters-use-as-area':
        this.useCluster(action.id, action.cluster);
        break;
      case 'undo': {
        this.handleUndo();
        break;
      }
      case 'set-area-mode': {
        const area = this.state.area;
        if (this.state.walkthrough || !area || area.mode === action.mode) return;
        this.setArea({ ...area, mode: action.mode });
        break;
      }
      case 'set-district-lock': {
        if (this.state.walkthrough) return;
        const prevLocks = this.state.lockedDistricts ?? [];
        const prevSet = new Set(prevLocks);
        const next = new Set(prevLocks);
        // Unassigned (0) is not a district and is never locked.
        for (const d of action.districts.filter((x) => x !== 0)) {
          if (action.locked) next.add(d);
          else next.delete(d);
        }
        const lockedDistricts = [...next].sort((a, b) => a - b);
        const scope = this.state.scope;
        // Like the extension: a locked district leaves the group and the neighbor choice.
        const cleaned: typeof scope =
          scope.mode === 'group'
            ? { ...scope, districts: scope.districts.filter((d) => !next.has(d)) }
            : scope.mode === 'one' && scope.with
              ? (() => {
                  const keep = scope.with!.filter((d) => !next.has(d));
                  const withGoal = scope.goal !== undefined ? { goal: scope.goal } : {};
                  return keep.length ? { ...scope, with: keep } : { mode: 'one' as const, district: scope.district, ...withGoal };
                })()
              : scope;
        if (JSON.stringify(lockedDistricts) !== JSON.stringify(prevLocks)) {
          const map = this.state.map;
          const targets = map ? computeTargets(map.totalPop, map.numDistricts) : null;
          const zeroedUnlocked = this.state.districts
            .filter((d) => !prevSet.has(d.index) && (targets ? isZeroed(d.pop, targets) : d.deviation === 0))
            .map((d) => d.index);
          const added = lockedDistricts.filter((d) => !prevSet.has(d));
          const removed = prevLocks.filter((d) => !next.has(d));
          let label: string | null = null;
          if (!action.locked && removed.length > 0 && lockedDistricts.length === 0) label = 'Undo unlock all';
          else if (action.locked && added.length > 0 && zeroedUnlocked.length > 0 && added.length === zeroedUnlocked.length && added.every((d) => zeroedUnlocked.includes(d))) {
            label = `Undo lock the ${added.length} at zero`;
          } else if (action.locked && added.length >= 2) label = `Undo locking ${added.length} districts`;
          if (label) {
            this.settingUndo = { kind: 'locks', prevLocks: prevLocks.slice(), prevScope: scope, afterScope: cleaned, label };
            this.undoLatest = 'setting';
          } else if (this.settingUndo?.kind === 'locks') {
            this.settingUndo = null;
            this.undoLatest = this.paintUndoStack.length ? 'paint' : null;
          }
        }
        this.state = {
          ...this.state,
          lockedDistricts,
          scope: cleaned,
          undo: this.currentMockUndo(),
          solutions: [],
          hoveredSolutionId: undefined,
          solve: { status: 'idle' },
        };
        this.emit();
        break;
      }
      case 'hover-solution': {
        if (this.state.hoveredSolutionId === (action.id ?? undefined)) return;
        this.state = {
          ...this.state,
          hoveredSolutionId: action.id ?? undefined,
        };
        this.emit();
        break;
      }
      case 'hover-border': {
        // Real shell highlights border on DRA map; no panel state mutation needed.
        break;
      }
      case 'solve': {
        this.handleSolve();
        break;
      }
      case 'cancel-solve': {
        if (this.state.solve.status === 'solving' || this.state.solve.status === 'loading-data') {
          this.state = {
            ...this.state,
            solve: { status: 'idle' },
          };
          this.emit();
        }
        break;
      }
      case 'start-walkthrough': {
        this.handleStartWalkthrough(action.solutionId);
        break;
      }
      case 'walkthrough-next': {
        this.handleWalkthroughNext();
        break;
      }
      case 'walkthrough-back': {
        const wt = this.state.walkthrough;
        if (!wt || wt.current <= 0) return;
        this.state = {
          ...this.state,
          walkthrough: { ...wt, current: wt.current - 1 },
        };
        this.emit();
        break;
      }
      case 'walkthrough-jump': {
        const wt = this.state.walkthrough;
        if (!wt || wt.steps.length === 0) return;
        const nextIndex = Math.max(0, Math.min(action.index, wt.steps.length - 1));
        const steps = wt.steps.map((s, idx) =>
          idx === nextIndex && s.status === 'pending' ? { ...s, status: 'active' as const } : s,
        );
        this.state = {
          ...this.state,
          walkthrough: { ...wt, steps, current: nextIndex },
        };
        this.emit();
        break;
      }
      case 'walkthrough-zoom': {
        // Handled by map highlight layer in real shell.
        break;
      }
      case 'walkthrough-replan': {
        const wt = this.state.walkthrough;
        if (!wt) return;
        this.state = {
          ...this.state,
          notice: { level: 'info', text: 'Re-planned remaining borders from current map.' },
          walkthrough: {
            ...wt,
            strayEdits: [],
            finalCheck: undefined,
          },
        };
        this.emit();
        break;
      }
      case 'walkthrough-end': {
        this.stopAutoTick();
        this.state = {
          ...this.state,
          walkthrough: undefined,
        };
        this.emit();
        break;
      }
      case 'load-csv': {
        this.stopAutoTick();
        this.clearAllUndo();
        const rows = Math.max(0, action.text.trim().split(/\r?\n/).length - 1);
        const districts = this.state.districts.length > 0 ? this.state.districts : makeNYDistricts();
        const baseMap = this.state.map ?? NY_MAP_INFO;
        this.state = {
          ...this.state,
          connection: 'csv',
          notice: {
            level: 'info',
            text: `Loaded ${rows.toLocaleString('en-US')} block rows from CSV. Live ticking is off.`,
          },
          map: { ...baseMap, sourceName: action.fileName },
          districts,
          scope: { mode: 'one', district: 13 },
          solve: { status: 'done', elapsedMs: 42 },
          solutions: SINGLE_DISTRICT_SOLUTIONS,
          walkthrough: undefined,
          undo: undefined,
        };
        this.emit();
        break;
      }
      case 'set-auto-paint': {
        const ap = this.state.autoPaint;
        if (!ap || (!ap.available && action.enabled) || ap.busy) return;
        this.state = { ...this.state, autoPaint: { ...ap, enabled: action.enabled, reason: ap.available ? undefined : ap.reason } };
        this.emit();
        break;
      }
      case 'walkthrough-paint-step': {
        this.handlePaintStep();
        break;
      }
      case 'retry-connection': {
        this.stopAreaTimer();
        this.stopClusterTimer();
        this.clearAllUndo();
        this.state = SCENARIOS['live-single'].createState();
        this.emit();
        break;
      }
    }
  }

  private handleUndo(): void {
    const cur = this.state.undo;
    if (!cur) return;
    if (cur.kind === 'paint') {
      const entry = this.paintUndoStack.pop();
      if (!entry) {
        this.state = { ...this.state, undo: this.currentMockUndo() };
        this.emit();
        return;
      }
      const live = this.applyLiveTransfer(entry.to, entry.from, entry.moved);
      const wt = this.state.walkthrough;
      let walkthrough = wt;
      if (wt) {
        const idx = wt.steps.findIndex((s) => s.id === entry.stepId);
        if (idx >= 0) {
          const steps = wt.steps.map((s, i) =>
            i === idx
              ? { ...s, status: 'active' as const, blocks: s.blocks.map((b) => ({ ...b, done: false })) }
              : s.status === 'active'
                ? { ...s, status: 'pending' as const }
                : s,
          );
          walkthrough = { ...wt, steps, current: idx, finalCheck: undefined };
        }
      }
      this.undoLatest = this.paintUndoStack.length ? 'paint' : this.settingUndo ? 'setting' : null;
      this.state = { ...this.state, ...live, walkthrough, undo: this.currentMockUndo(Boolean(walkthrough)) };
      this.emit();
      return;
    }
    const entry = this.settingUndo;
    this.settingUndo = null;
    this.undoLatest = this.paintUndoStack.length ? 'paint' : null;
    if (!entry || this.state.walkthrough) {
      this.state = { ...this.state, undo: this.currentMockUndo() };
      this.emit();
      return;
    }
    if (entry.kind === 'locks') {
      const scope = JSON.stringify(this.state.scope) === JSON.stringify(entry.afterScope) ? entry.prevScope : this.state.scope;
      this.state = {
        ...this.state,
        lockedDistricts: entry.prevLocks,
        scope,
        undo: this.currentMockUndo(),
        solutions: [],
        hoveredSolutionId: undefined,
        solve: { status: 'idle' },
      };
      this.emit();
      return;
    }
    this.state = {
      ...this.state,
      area: entry.prevArea,
      undo: this.currentMockUndo(),
      solutions: [],
      hoveredSolutionId: undefined,
      solve: { status: 'idle' },
    };
    this.emit();
  }

  private handleSetScope(scope: Scope): void {
    const districts = this.state.districts;
    if (scope.mode === 'one') {
      const district = scope.district;
      const withGoal = scope.goal !== undefined ? { goal: scope.goal } : {};
      if (scope.with) {
        // Like the real controller: only districts that touch this one can be chosen.
        const nbrs = districts.find((d) => d.index === district)?.neighbors ?? [];
        const keep = [...new Set(scope.with)].filter((d) => nbrs.includes(d)).sort((a, b) => a - b);
        scope = keep.length ? { mode: 'one', district, with: keep, ...withGoal } : { mode: 'one', district, ...withGoal };
      } else {
        scope = { mode: 'one', district, ...withGoal };
      }
    }
    let feasibility: GroupFeasibility | undefined;
    let interaction = undefined;

    if (scope.mode === 'group') {
      feasibility = this.computeMockFeasibility(scope.districts);
      if (scope.districts.length > 0) {
        interaction = buildInteractionForDistricts(districts, scope.districts);
      }
    } else if (scope.mode === 'all') {
      interaction = buildInteractionForDistricts(
        districts,
        districts.map((d) => d.index),
      );
    }

    this.state = {
      ...this.state,
      scope,
      feasibility,
      interaction,
      solve: { status: 'idle' },
      solutions: [],
      hoveredSolutionId: undefined,
    };
    this.emit();
  }

  private handleSolve(): void {
    this.solveAnywhere();
    this.applyMockArea();
  }

  /**
   * With an area, a rough imitation of AreaPreference on whatever the mock solve produced:
   *  - 'prefer': every card is inside except the last one (when there are two or more), which
   *    fills in with a few blocks outside, and the status line says why;
   *  - 'only': that last card is dropped; with nothing left, the message says the area is why.
   */
  private applyMockArea(): void {
    const area = this.state.area;
    const { solutions, solve } = this.state;
    if (!(area?.ring || area?.region || area?.cluster) || solve.status !== 'done' || solutions.length === 0) return;
    const what = this.state.scope.mode === 'one' ? 'option' : 'plan';
    const stamp = (card: SolutionCard, outsideArea: number): SolutionCard => ({ ...card, stats: { ...card.stats, outsideArea } });
    let next: SolutionCard[];
    let message: string | undefined;
    if (area.mode === 'prefer') {
      const last = solutions.length - 1;
      next = solutions.map((card, i) => stamp(card, i === last && last > 0 ? 3 : 0));
      if (last > 0) message = `Only ${last} ${last === 1 ? what : `${what}s`} fit inside your area; the last one moves a few blocks outside it.`;
    } else {
      next = solutions.slice(0, -1).map((card) => stamp(card, 0));
      if (next.length === 0) {
        message = `Nothing can be done inside your area. Choose Prefer to allow moves outside it, or mark a larger area.`;
      }
    }
    this.state = { ...this.state, solutions: next, solve: { ...solve, message: message ?? solve.message } };
    this.emit();
  }

  private solveAnywhere(): void {
    const { scope, districts } = this.state;
    if (scope.mode === 'one') {
      const targetRow = districts.find((d) => d.index === scope.district);
      const goal = scope.goal;
      const alreadyAtGoal = !targetRow
        ? true
        : goal !== undefined
          ? targetRow.deviation === goal
          : Math.abs(targetRow.deviation) <= 1;
      if (!targetRow || alreadyAtGoal) {
        const message =
          targetRow && goal !== undefined
            ? `${formatDistrictName(targetRow.index, districts)} is already at ${formatSigned(goal)}.`
            : 'District is already at zero deviation.';
        this.state = {
          ...this.state,
          solve: { status: 'done', elapsedMs: 6, message },
          solutions: [],
        };
        this.emit();
        return;
      }
      if (scope.with && scope.with.length > 0) {
        this.state = {
          ...this.state,
          solve: { status: 'done', elapsedMs: 31 },
          solutions: makeChosenNeighborOptions(districts, scope.district, scope.with, goal),
        };
        this.emit();
        return;
      }
      // "Any neighbor": an unlocked one, and Unassigned (0) only while it holds people.
      const lockedSet = new Set(this.state.lockedDistricts ?? []);
      const allowed = (targetRow.neighbors ?? []).filter((d) =>
        d === 0 ? (this.state.unassigned?.pop ?? 0) > 0 : !lockedSet.has(d),
      );
      const nbr = allowed[0] ?? targetRow.neighbors?.[0] ?? (targetRow.index === 1 ? 2 : 1);
      const nbrRow = districts.find((d) => d.index === nbr);
      const delta = targetRow.deviation - (goal ?? 0);
      const from = delta > 0 ? targetRow.index : nbr;
      const to = delta > 0 ? nbr : targetRow.index;
      const people = Math.abs(delta);
      const solutions: SolutionCard[] =
        scope.district === 13 && goal === undefined
          ? SINGLE_DISTRICT_SOLUTIONS
          : [
              {
                id: `opt-${scope.district}-1`,
                kind: 'single',
                stats: {
                  people,
                  blocks: Math.max(2, Math.round(people / 65)),
                  populatedBlocks: Math.max(2, Math.round(people / 75)),
                  newPrecinctSplits: 1,
                  healedPrecinctSplits: 0,
                  newCountySplits: 0,
                  perimeterDeltaM: -85,
                  districtsTouched: 2,
                  cost: 112,
                  steps: Math.max(1, Math.round(people / 120)),
                },
                borderFlows: [{ from, to, people }],
                deviations: [
                  { district: targetRow.index, before: targetRow.deviation, after: goal ?? 0 },
                  ...(nbrRow
                    ? [
                        {
                          district: nbrRow.index,
                          before: nbrRow.deviation,
                          after: nbrRow.deviation + delta,
                        },
                      ]
                    : []),
                ],
              },
            ];
      this.state = {
        ...this.state,
        solve: { status: 'done', elapsedMs: 29 },
        solutions,
      };
      this.emit();
      return;
    }

    if (scope.mode === 'group') {
      const feasibility = this.computeMockFeasibility(scope.districts);
      if (!feasibility.feasible && !scope.allowOutsideAbsorb) {
        this.state = {
          ...this.state,
          feasibility,
          solve: {
            status: 'group-unbalanced',
            message: `Selected group is ${feasibility.excess > 0 ? `+${feasibility.excess}` : feasibility.excess} off target.`,
          },
          solutions: [],
        };
        this.emit();
        return;
      }
      this.state = {
        ...this.state,
        feasibility,
        solve: { status: 'done', elapsedMs: 360 },
        solutions: GROUP_CHAIN_SOLUTIONS,
      };
      this.emit();
      return;
    }

    // Whole map
    const wholeState = SCENARIOS['live-whole-map-26'].createState();
    this.state = {
      ...this.state,
      interaction: wholeState.interaction,
      solve: wholeState.solve,
      solutions: wholeState.solutions,
    };
    this.emit();
  }

  private handleStartWalkthrough(solutionId: string): void {
    const card = this.state.solutions.find((s) => s.id === solutionId);
    const liveTicking = this.state.connection === 'live';

    const steps: WalkthroughStep[] =
      solutionId === 'plan-splits'
        ? makeChainWalkthroughSteps()
        : solutionId === TWO_WAY_WALKTHROUGH_SOLUTION.id
          ? makeTwoWayWalkthroughSteps()
          : solutionId === DRAWING_PLAN_SOLUTION.id
            ? makeDrawingWalkthroughSteps()
            : (card?.borderFlows ?? [{ from: 13, to: 12, people: 412 }]).slice(0, 6).map((flow, idx) => {
                const b1 = Math.max(1, Math.round(flow.people * 0.4));
                const b2 = Math.max(1, Math.round(flow.people * 0.35));
                const b3 = Math.max(1, flow.people - b1 - b2);
                return {
                  id: `wt-step-${idx + 1}`,
                  from: flow.from,
                  to: flow.to,
                  precinctId: `36061-${String(110 + idx * 7).padStart(4, '0')}`,
                  wholePrecinct: idx === 1 && flow.people >= 150,
                  status: idx === 0 ? 'active' : 'pending',
                  blocks:
                    flow.people < 3
                      ? [{ geoid: `3606100420010${idx}1`, number: 1, people: flow.people, done: false }]
                      : [
                          { geoid: `3606100420010${idx}1`, number: 1, people: b1, done: false },
                          { geoid: `3606100420010${idx}4`, number: 2, people: b2, done: false },
                          { geoid: `3606100420010${idx}8`, number: 3, people: b3, done: false },
                        ],
                };
              });

    this.settingUndo = null;
    this.undoLatest = this.paintUndoStack.length ? 'paint' : null;
    this.state = {
      ...this.state,
      hoveredSolutionId: undefined,
      undo: this.currentMockUndo(true),
      walkthrough: {
        solutionId,
        steps,
        current: 0,
        strayEdits: [],
        liveTicking,
        mapMode: this.state.mapMode ?? 'dra',
      },
    };
    this.emit();
  }

  private handleWalkthroughNext(): void {
    const wt = this.state.walkthrough;
    if (!wt) return;
    const steps = wt.steps.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b })) }));

    if (wt.current < steps.length - 1) {
      if (!wt.liveTicking && steps[wt.current]) {
        steps[wt.current].status = 'done';
        steps[wt.current].blocks.forEach((b) => {
          b.done = true;
        });
      }
      const nextIndex = wt.current + 1;
      if (steps[nextIndex].status === 'pending') {
        steps[nextIndex].status = 'active';
      }
      this.state = {
        ...this.state,
        walkthrough: { ...wt, steps, current: nextIndex },
      };
      this.emit();
      return;
    }

    // On last step: run final check
    if (steps[wt.current]) {
      steps[wt.current].status = 'done';
      steps[wt.current].blocks.forEach((b) => {
        b.done = true;
      });
    }
    this.state = {
      ...this.state,
      walkthrough: {
        ...wt,
        steps,
        finalCheck: this.buildFinalCheck(),
      },
    };
    this.emit();
  }

  private computeMockFeasibility(selectedIndexes: number[]): GroupFeasibility {
    const map = this.state.map ?? NY_MAP_INFO;
    const targets = computeTargets(map.totalPop, map.numDistricts);
    const set = new Set(selectedIndexes);
    const selected = this.state.districts.filter((d) => set.has(d.index));
    const sumPop = selected.reduce((s, d) => s + d.pop, 0);
    const minValid = selected.length * targets.q;
    const maxValid = selected.length * (targets.q + (targets.remainder > 0 ? 1 : 0));

    if (selected.length === 0) {
      return { feasible: false, excess: 0, suggestAdd: [] };
    }
    if (sumPop >= minValid && sumPop <= maxValid) {
      return { feasible: true, excess: 0, suggestAdd: [] };
    }

    const excess = sumPop > maxValid ? sumPop - maxValid : sumPop - minValid;
    const adjacentOutside = new Set<number>();
    for (const d of selected) {
      for (const nbr of d.neighbors ?? []) {
        if (!set.has(nbr)) adjacentOutside.add(nbr);
      }
    }

    const suggestAdd = [...adjacentOutside]
      .map((idx) => this.state.districts.find((d) => d.index === idx)!)
      .filter(Boolean)
      .filter((d) => (excess > 0 ? d.deviation < 0 : d.deviation > 0))
      .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
      .slice(0, 2)
      .map((d) => d.index);

    return { feasible: false, excess, suggestAdd };
  }

  /** Live districts (and DRA's Unassigned row) after `people` move from one district to another. */
  private applyLiveTransfer(from: number, to: number, people: number): Pick<PanelState, 'districts' | 'unassigned'> {
    const districts = this.state.districts.map((d) => {
      if (d.index === from) {
        return { ...d, pop: d.pop - people, deviation: d.deviation - people };
      }
      if (d.index === to) {
        return { ...d, pop: d.pop + people, deviation: d.deviation + people };
      }
      return d;
    });
    // Unassigned (0) is not in `districts`: erasing adds to it, painting unassigned blocks takes from it.
    let unassigned = this.state.unassigned;
    if (from === 0 || to === 0) {
      const pop = (unassigned?.pop ?? 0) + (to === 0 ? people : 0) - (from === 0 ? people : 0);
      unassigned = { pop: Math.max(0, pop) };
    }
    return { districts, unassigned };
  }

  private buildFinalCheck(districts = this.state.districts) {
    const wt = this.state.walkthrough;
    const card = this.state.solutions.find((s) => s.id === wt?.solutionId);
    if (this.state.connection === 'csv') {
      return {
        ok: null as boolean | null,
        deviations: card ? card.deviations.map((dv) => ({ ...dv })) : [],
      };
    }
    const deviations = card
      ? card.deviations.map((dv) => {
          const live = districts.find((d) => d.index === dv.district);
          return {
            district: dv.district,
            before: dv.before,
            after: live ? live.deviation : dv.after,
          };
        })
      : [];
    const scope = this.state.scope;
    const ok =
      scope.mode === 'one' && scope.goal !== undefined
        ? deviations.some((d) => d.district === scope.district && d.after === scope.goal)
        : deviations.every((d) => Math.abs(d.after) <= 1);
    return { ok: ok as boolean | null, deviations };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
