import type { Assignment, EngineGraph, GroupFeasibility, GroupSolveResult, InteractionGraph, PopTargets, SolveResult } from '@zd/contracts';

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
   */
  | { type: 'solve-district'; id: number; assignment: Assignment; targets: PopTargets; district: number; absorbers?: number[]; includeUnassigned?: boolean; neighborTolerance?: number; maxOptions?: number; locked?: Uint8Array; lockedDistricts?: number[]; testDelayMs?: number }
  /** `includeUnassigned` / 0 in `absorbers`: as GroupSolveRequest, with `allowOutsideAbsorb` only. */
  | { type: 'solve-group'; id: number; assignment: Assignment; targets: PopTargets; districts: number[]; allowOutsideAbsorb: boolean; absorbers?: number[]; includeUnassigned?: boolean; locked?: Uint8Array; lockedDistricts?: number[]; testDelayMs?: number }
  | { type: 'interaction'; id: number; assignment: Assignment; targets: PopTargets; districts: number[]; allowOutsideAbsorb: boolean; absorbers?: number[]; includeUnassigned?: boolean };

export type WorkerResponse =
  | { type: 'ready'; id: number; elapsedMs: number }
  | { type: 'progress'; id: number; done: number; total: number }
  /**
   * `fallback`: the single-district solver found nothing and the planner's plans are returned.
   * `choiceDropped`: options or plans left out because they traded with districts outside
   * `absorbers` (`outside`), e.g. while the planner does not yet honor GroupSolveRequest.absorbers.
   */
  | { type: 'district-result'; id: number; result: SolveResult; fallback: boolean; choiceDropped?: { plans: number; outside: number[]; fallback: boolean } }
  | { type: 'group-result'; id: number; result: GroupSolveResult }
  | { type: 'interaction-result'; id: number; feasibility: GroupFeasibility; interaction: InteractionGraph | null; elapsedMs: number }
  | { type: 'error'; id: number; message: string };
