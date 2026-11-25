import type { AreaPreference, Assignment, ClusterResult, EngineGraph, GroupFeasibility, GroupSolveResult, InteractionGraph, PopTargets, SolveResult } from '@zd/contracts';

export type WorkerRequest =
  | { type: 'init'; id: number; graph: EngineGraph }
  /**
   * `locked` blocks must not move (re-plan from here: blocks of finished steps). The contract's
   * DistrictSolveRequest has no `locked`, so options touching a locked block are dropped and, if none
   * survive, the planner (which does take `locked`) is used for the group of one.
   * `testDelayMs` (test builds only): keep the worker busy this long first, so cancel can be tested
   * on the small fixture whose solves take milliseconds.
   * `absorbers`: the user's choice of neighbors (Scope `with`); absent = any neighbor. Options and
   * fallback plans that trade with any other district are dropped (see `choiceDropped`).
   * `lockedDistricts`: districts the user locked. The panel already leaves them out of `absorbers`
   * and `districts`; the worker also drops any solution that would touch one. Never holds 0.
   * Unassigned (district 0): `includeUnassigned` (with no `absorbers`) or 0 in `absorbers` lets the
   * solve trade with unassigned blocks (see UNASSIGNED in @zd/contracts). Without either, a
   * solution that touches district 0 is dropped.
   * `area`: where the user would like the moves to happen (AreaPreference), passed to the engine
   * and to the planner (also its fallback for one district). The panel sends a copy of its mask
   * and transfers the copy's buffer, so it is moved to the worker, not cloned. See worker/area.ts
   * for what the worker itself makes sure of.
   * `goal`: exact deviation goal against targets.draTarget (-1, 0 or +1); absent = usual zero rule.
   */
  | { type: 'solve-district'; id: number; assignment: Assignment; targets: PopTargets; district: number; absorbers?: number[]; includeUnassigned?: boolean; goal?: -1 | 0 | 1; neighborTolerance?: number; maxOptions?: number; locked?: Uint8Array; lockedDistricts?: number[]; area?: AreaPreference; testDelayMs?: number }
  /** `includeUnassigned` / 0 in `absorbers`: as GroupSolveRequest, with `allowOutsideAbsorb` only. `area` as above. */
  | { type: 'solve-group'; id: number; assignment: Assignment; targets: PopTargets; districts: number[]; allowOutsideAbsorb: boolean; absorbers?: number[]; includeUnassigned?: boolean; locked?: Uint8Array; lockedDistricts?: number[]; area?: AreaPreference; testDelayMs?: number }
  | { type: 'interaction'; id: number; assignment: Assignment; targets: PopTargets; districts: number[]; allowOutsideAbsorb: boolean; absorbers?: number[]; includeUnassigned?: boolean }
  /**
   * County clusters (ClusterRequest in @zd/contracts) on the worker's graph: the request without
   * `graph`. The panel cancels a search the way it cancels a solve, by restarting the worker.
   * `testDelayMs` as for solves (test builds only).
   */
  | { type: 'clusters'; id: number; numDistricts: number; tolerance: number; maxResults?: number; timeLimitMs?: number; singletons?: number[]; testDelayMs?: number };

export type WorkerResponse =
  | { type: 'ready'; id: number; elapsedMs: number }
  | { type: 'progress'; id: number; done: number; total: number }
  /**
   * `fallback`: the single-district solver found nothing and the planner's plans are returned.
   * `choiceDropped`: options or plans left out because they traded with districts outside
   * `absorbers` (`outside`), e.g. while the planner does not yet honor GroupSolveRequest.absorbers.
   * `areaDropped`: with area mode 'only', options or plans left out because they moved blocks
   * outside the area (the solver should not return any; this counts what the worker's guard took out).
   * `insideTwoWay`: with area mode 'prefer', fewer one-way options stayed inside the area than were
   * asked for, so the planner's plans that trade in both directions inside it were added: after the
   * one-way options inside (if any), before the one-way options that go outside.
   */
  | { type: 'district-result'; id: number; result: SolveResult; fallback: boolean; choiceDropped?: { plans: number; outside: number[]; fallback: boolean }; areaDropped?: number; insideTwoWay?: boolean }
  | { type: 'group-result'; id: number; result: GroupSolveResult; areaDropped?: number }
  | { type: 'interaction-result'; id: number; feasibility: GroupFeasibility; interaction: InteractionGraph | null; elapsedMs: number }
  | { type: 'clusters-result'; id: number; result: ClusterResult }
  | { type: 'error'; id: number; message: string };
