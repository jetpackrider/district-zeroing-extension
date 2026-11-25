/**
 * Pure state machine for the panel's single Undo (PanelState.undo).
 *
 * Tracks only the extension's own changes:
 *  - steps painted for the user via "Paint this step" (a stack of consecutive extension paints,
 *    latest first, valid only while DRA's undo position has not moved outside our paint/undo),
 *  - the latest destructive panel setting change (Unlock all, Lock the N at zero, clearing an area,
 *    replacing an area with a new one).
 *
 * Hand-painted edits in DRA are never tracked here; they invalidate any pending paint undo.
 */

import { UNASSIGNED, type PanelState, type Scope } from '@zd/contracts';
import type { SavedArea } from './area';

export interface PaintUndoEntry {
  stepId: string;
  stepIndex: number;
  /** 1-based step number shown to the user. */
  stepNumber: number;
  precinctId: string;
  from: number;
  to: number;
  wholePrecinct: boolean;
  blocks: string[];
  /** DRA's model.undoredo.cur immediately before painting. */
  undoBefore: number;
  /** DRA's model.undoredo.cur immediately after painting. */
  undoPos: number;
  /** Identity of model.undoredo.stack[undoPos - 1] after painting, when available. */
  undoTopId?: number;
  /** Highest snapshot seq emitted before this paint (or a subsequent undo) completed. */
  minSnapSeq: number;
  label: string;
}

export type SettingUndoEntry =
  | {
      kind: 'locks';
      mapKey: string;
      prevLocks: number[];
      prevScope: Scope;
      afterScope: Scope;
      label: string;
    }
  | {
      kind: 'area';
      mapKey: string;
      prevArea: SavedArea;
      label: string;
    };

export interface UndoTrackerState {
  paintStack: PaintUndoEntry[];
  setting: SettingUndoEntry | null;
  latest: 'paint' | 'setting' | null;
}

export interface UndoContext {
  mapKey: string | null;
  inWalkthrough: boolean;
  /** True only when live, connected, editable, and DRA's paint/undo API is ok. */
  canUndoPaint: boolean;
}

export function emptyUndo(): UndoTrackerState {
  return { paintStack: [], setting: null, latest: null };
}

/** Deep-copies a SavedArea (preserving any ring or region fields). */
export function cloneSavedArea<T extends SavedArea>(area: T): T {
  const copy = { ...area };
  if (Array.isArray(copy.ring)) copy.ring = copy.ring.map(([lon, lat]) => [lon, lat] as [number, number]);
  if (copy.region) copy.region = { ...copy.region };
  if (copy.cluster) copy.cluster = { ...copy.cluster, counties: [...copy.cluster.counties] };
  return copy;
}

export function paintUndoLabel(stepNumber: number, to: number): string {
  return to === UNASSIGNED ? `Undo erasing step ${stepNumber}` : `Undo painting step ${stepNumber}`;
}

/**
 * Label when a lock change threw something away (Unlock all, Lock the N at zero, or another
 * multi-district lock change), or null for an ordinary single-district lock toggle.
 */
export function lockUndoLabel(opts: {
  locked: boolean;
  prevLocks: readonly number[];
  nextLocks: readonly number[];
  zeroedUnlocked: readonly number[];
}): string | null {
  const { locked, prevLocks, nextLocks, zeroedUnlocked } = opts;
  const prevSet = new Set(prevLocks);
  const nextSet = new Set(nextLocks);
  if (!locked) {
    const removed = prevLocks.filter((d) => !nextSet.has(d));
    if (!removed.length) return null;
    if (nextLocks.length === 0) return 'Undo unlock all';
    if (removed.length >= 2) return `Undo unlocking ${removed.length} districts`;
    return null;
  }
  const added = nextLocks.filter((d) => !prevSet.has(d));
  if (!added.length) return null;
  const zeroSet = new Set(zeroedUnlocked);
  if (zeroedUnlocked.length > 0 && added.length === zeroedUnlocked.length && added.every((d) => zeroSet.has(d))) {
    return `Undo lock the ${added.length} at zero`;
  }
  if (added.length >= 2) return `Undo locking ${added.length} districts`;
  return null;
}

export function recordPaintUndo(u: UndoTrackerState, entry: PaintUndoEntry): UndoTrackerState {
  const top = u.paintStack[u.paintStack.length - 1];
  // Keep earlier painted steps only when nothing happened in DRA between them.
  const consecutive = top !== undefined && top.undoPos === entry.undoBefore;
  const paintStack = consecutive ? [...u.paintStack, entry] : [entry];
  return { ...u, paintStack, latest: 'paint' };
}

export function recordSettingUndo(u: UndoTrackerState, entry: SettingUndoEntry): UndoTrackerState {
  return { ...u, setting: entry, latest: 'setting' };
}

export function clearSettingUndo(u: UndoTrackerState, kind?: SettingUndoEntry['kind']): UndoTrackerState {
  if (!u.setting || (kind && u.setting.kind !== kind)) return u;
  return { ...u, setting: null, latest: u.paintStack.length ? 'paint' : null };
}

export function clearPaintUndo(u: UndoTrackerState): UndoTrackerState {
  if (!u.paintStack.length) return u;
  return { ...u, paintStack: [], latest: u.setting ? 'setting' : null };
}

/**
 * Reconcile the paint undo stack with a fresh DRA snapshot (only called when no paint/undo is in
 * flight). If DRA's undo position moved, its top stack entry changed, or DRA has uncommitted
 * shattered edits, withdraw paint undo completely.
 */
export function reconcileDraSnapshot(
  u: UndoTrackerState,
  snap: { seq: number; undoPos?: number; undoTopId?: number; pendingShatter: readonly string[] },
): UndoTrackerState {
  if (!u.paintStack.length) return u;
  const top = u.paintStack[u.paintStack.length - 1];
  if (snap.seq <= top.minSnapSeq) return u;
  if (snap.pendingShatter.length > 0) return clearPaintUndo(u);
  if (snap.undoPos === undefined || snap.undoPos !== top.undoPos) return clearPaintUndo(u);
  if (top.undoTopId !== undefined && snap.undoTopId !== undefined && snap.undoTopId !== top.undoTopId) {
    return clearPaintUndo(u);
  }
  return u;
}

/**
 * Advance the paint undo stack after DRA confirmed the top painted step was undone.
 * Earlier consecutive paints remain undoable if DRA's new undo position matches the new top.
 */
export function afterPaintUndone(
  u: UndoTrackerState,
  undoneStepId: string,
  result: { undoPos: number; undoTopId?: number; snapSeq?: number },
): UndoTrackerState {
  const top = u.paintStack[u.paintStack.length - 1];
  if (!top || top.stepId !== undoneStepId) return clearPaintUndo(u);
  const rest = u.paintStack.slice(0, -1);
  if (!rest.length) {
    return { ...u, paintStack: [], latest: u.setting ? 'setting' : null };
  }
  const nextTop = rest[rest.length - 1];
  if (
    nextTop.undoPos !== result.undoPos ||
    (nextTop.undoTopId !== undefined && result.undoTopId !== undefined && nextTop.undoTopId !== result.undoTopId)
  ) {
    return { ...u, paintStack: [], latest: u.setting ? 'setting' : null };
  }
  const updatedTop: PaintUndoEntry = {
    ...nextTop,
    minSnapSeq: Math.max(nextTop.minSnapSeq, result.snapSeq ?? 0),
  };
  return {
    ...u,
    paintStack: [...rest.slice(0, -1), updatedTop],
    latest: 'paint',
  };
}

export type ActiveUndo =
  | { kind: 'paint'; entry: PaintUndoEntry }
  | { kind: 'setting'; entry: SettingUndoEntry };

export function activeUndoEntry(u: UndoTrackerState, ctx: UndoContext): ActiveUndo | null {
  const settingValid = u.setting !== null && !ctx.inWalkthrough && ctx.mapKey !== null && u.setting.mapKey === ctx.mapKey;
  const paintValid = u.paintStack.length > 0 && ctx.canUndoPaint;
  if (u.latest === 'setting' && settingValid) return { kind: 'setting', entry: u.setting! };
  if (u.latest === 'paint' && paintValid) return { kind: 'paint', entry: u.paintStack[u.paintStack.length - 1] };
  if (paintValid) return { kind: 'paint', entry: u.paintStack[u.paintStack.length - 1] };
  if (settingValid) return { kind: 'setting', entry: u.setting! };
  return null;
}

export function currentUndo(u: UndoTrackerState, ctx: UndoContext): PanelState['undo'] {
  const active = activeUndoEntry(u, ctx);
  return active ? { kind: active.kind, label: active.entry.label } : undefined;
}
