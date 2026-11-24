import { computeTargets } from '@zd/contracts';
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
  GROUP_CHAIN_SOLUTIONS,
  NY_MAP_INFO,
  SCENARIOS,
  SINGLE_DISTRICT_SOLUTIONS,
  TWO_WAY_WALKTHROUGH_SOLUTION,
  buildInteractionForDistricts,
  makeChosenNeighborOptions,
  makeChainWalkthroughSteps,
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

  constructor(options: MockControllerOptions = {}) {
    this.onAction = options.onAction;
    this.paintDelayMs = options.paintDelayMs ?? 700;
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
    this.state = SCENARIOS[id].createState();
    this.emit();
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

    // If awaiting commit, simulate user clicking DRA's checkmark and advancing
    if (cur.status === 'awaiting-commit') {
      cur.status = 'done';
      if (wt.current + 1 < steps.length) {
        steps[wt.current + 1].status = 'active';
        this.state = {
          ...this.state,
          walkthrough: { ...wt, steps, current: wt.current + 1 },
        };
      } else {
        this.state = {
          ...this.state,
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
        const districts = this.applyLiveTransfer(cur.from, cur.to, moved);
        const hasNext = wt.current + 1 < steps.length;
        if (hasNext) steps[wt.current + 1].status = 'active';
        this.state = {
          ...this.state,
          districts,
          walkthrough: {
            ...wt,
            steps,
            current: hasNext ? wt.current + 1 : wt.current,
            finalCheck: hasNext ? undefined : this.buildFinalCheck(districts),
          },
        };
        this.emit();
        return true;
      }

      nextBlock.done = true;
      const districts = this.applyLiveTransfer(cur.from, cur.to, nextBlock.people);
      const allBlocksDone = cur.blocks.every((b) => b.done);
      cur.status = allBlocksDone ? 'awaiting-commit' : 'active';
      this.state = {
        ...this.state,
        districts,
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
      const districts = this.applyLiveTransfer(step.from, step.to, moved);
      const next = steps.findIndex((s, i) => i > w.current && s.status !== 'done');
      if (next >= 0 && steps[next].status === 'pending') steps[next].status = 'active';
      this.state = {
        ...this.state,
        districts,
        autoPaint: { ...a, busy: false },
        walkthrough: {
          ...w,
          steps,
          current: next >= 0 ? next : w.current,
          finalCheck: next >= 0 ? undefined : this.buildFinalCheck(districts),
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
      case 'set-district-lock': {
        if (this.state.walkthrough) return;
        const next = new Set(this.state.lockedDistricts ?? []);
        for (const d of action.districts) {
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
                  return keep.length ? { ...scope, with: keep } : { mode: 'one' as const, district: scope.district };
                })()
              : scope;
        this.state = { ...this.state, lockedDistricts, scope: cleaned, solutions: [], hoveredSolutionId: undefined, solve: { status: 'idle' } };
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
        this.state = SCENARIOS['live-single'].createState();
        this.emit();
        break;
      }
    }
  }

  private handleSetScope(scope: Scope): void {
    const districts = this.state.districts;
    if (scope.mode === 'one' && scope.with) {
      // Like the real controller: only districts that touch this one can be chosen.
      const district = scope.district;
      const nbrs = districts.find((d) => d.index === district)?.neighbors ?? [];
      const keep = [...new Set(scope.with)].filter((d) => nbrs.includes(d)).sort((a, b) => a - b);
      scope = keep.length ? { mode: 'one', district, with: keep } : { mode: 'one', district };
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
    const { scope, districts } = this.state;
    if (scope.mode === 'one') {
      const targetRow = districts.find((d) => d.index === scope.district);
      if (!targetRow || Math.abs(targetRow.deviation) <= 1) {
        this.state = {
          ...this.state,
          solve: { status: 'done', elapsedMs: 6, message: 'District is already at zero deviation.' },
          solutions: [],
        };
        this.emit();
        return;
      }
      if (scope.with && scope.with.length > 0) {
        this.state = {
          ...this.state,
          solve: { status: 'done', elapsedMs: 31 },
          solutions: makeChosenNeighborOptions(districts, scope.district, scope.with),
        };
        this.emit();
        return;
      }
      const nbr = targetRow.neighbors?.[0] ?? (targetRow.index === 1 ? 2 : 1);
      const nbrRow = districts.find((d) => d.index === nbr);
      const from = targetRow.deviation > 0 ? targetRow.index : nbr;
      const to = targetRow.deviation > 0 ? nbr : targetRow.index;
      const people = Math.abs(targetRow.deviation);
      const solutions: SolutionCard[] =
        scope.district === 13
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
                  { district: targetRow.index, before: targetRow.deviation, after: 0 },
                  ...(nbrRow
                    ? [
                        {
                          district: nbrRow.index,
                          before: nbrRow.deviation,
                          after: nbrRow.deviation + targetRow.deviation,
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

    this.state = {
      ...this.state,
      hoveredSolutionId: undefined,
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

  private applyLiveTransfer(from: number, to: number, people: number) {
    return this.state.districts.map((d) => {
      if (d.index === from) {
        return { ...d, pop: d.pop - people, deviation: d.deviation - people };
      }
      if (d.index === to) {
        return { ...d, pop: d.pop + people, deviation: d.deviation + people };
      }
      return d;
    });
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
    const ok = deviations.every((d) => Math.abs(d.after) <= 1);
    return { ok: ok as boolean | null, deviations };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
