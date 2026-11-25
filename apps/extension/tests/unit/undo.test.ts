import { describe, expect, it } from 'vitest';
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
  type UndoContext,
} from '../../src/panel/undo';

const liveCtx: UndoContext = { mapKey: 'live|NY|4|Fixture', inWalkthrough: true, canUndoPaint: true };
const panelCtx: UndoContext = { mapKey: 'live|NY|4|Fixture', inWalkthrough: false, canUndoPaint: true };

function paintEntry(n: number, undoBefore: number, undoPos: number, topId: number, minSnapSeq = 10): PaintUndoEntry {
  return {
    stepId: `s-${n}`,
    stepIndex: n - 1,
    stepNumber: n,
    precinctId: `P${n}`,
    from: 1,
    to: 2,
    wholePrecinct: false,
    blocks: [`36001000100100${n}`],
    undoBefore,
    undoPos,
    undoTopId: topId,
    minSnapSeq,
    label: paintUndoLabel(n, 2),
  };
}

describe('undo state machine — painted steps', () => {
  it('stacks consecutive painted steps and unwinds them latest first', () => {
    let u = emptyUndo();
    expect(currentUndo(u, liveCtx)).toBeUndefined();

    u = recordPaintUndo(u, paintEntry(1, 0, 1, 101, 5));
    expect(currentUndo(u, liveCtx)).toEqual({ kind: 'paint', label: 'Undo painting step 1' });

    u = recordPaintUndo(u, paintEntry(2, 1, 2, 102, 8));
    expect(currentUndo(u, liveCtx)).toEqual({ kind: 'paint', label: 'Undo painting step 2' });
    expect(u.paintStack).toHaveLength(2);

    // Matching snapshot keeps the stack intact.
    u = reconcileDraSnapshot(u, { seq: 9, undoPos: 2, undoTopId: 102, pendingShatter: [] });
    expect(u.paintStack).toHaveLength(2);

    // Undoing step 2 exposes step 1 again.
    u = afterPaintUndone(u, 's-2', { undoPos: 1, undoTopId: 101, snapSeq: 10 });
    expect(currentUndo(u, liveCtx)).toEqual({ kind: 'paint', label: 'Undo painting step 1' });

    // Stale snapshot from before undo (seq <= 10) does not invalidate step 1.
    u = reconcileDraSnapshot(u, { seq: 10, undoPos: 2, undoTopId: 102, pendingShatter: [] });
    expect(currentUndo(u, liveCtx)).toEqual({ kind: 'paint', label: 'Undo painting step 1' });

    // Fresh snapshot at undoPos 1 keeps step 1 valid.
    u = reconcileDraSnapshot(u, { seq: 11, undoPos: 1, undoTopId: 101, pendingShatter: [] });
    expect(currentUndo(u, liveCtx)).toEqual({ kind: 'paint', label: 'Undo painting step 1' });

    // Undoing step 1 empties the stack.
    u = afterPaintUndone(u, 's-1', { undoPos: 0, snapSeq: 12 });
    expect(currentUndo(u, liveCtx)).toBeUndefined();
  });

  it('withdraws paint undo when DRA moves forward, backward, replaces the top entry at the same depth, or shatters', () => {
    const base = recordPaintUndo(recordPaintUndo(emptyUndo(), paintEntry(1, 0, 1, 101, 5)), paintEntry(2, 1, 2, 102, 8));

    // User painted by hand in DRA (cur: 2 -> 3).
    expect(currentUndo(reconcileDraSnapshot(base, { seq: 9, undoPos: 3, undoTopId: 103, pendingShatter: [] }), liveCtx)).toBeUndefined();

    // User undid by hand in DRA (cur: 2 -> 1).
    expect(currentUndo(reconcileDraSnapshot(base, { seq: 9, undoPos: 1, undoTopId: 101, pendingShatter: [] }), liveCtx)).toBeUndefined();

    // User undid + painted by hand between ticks (cur back at 2, but new stack entry object).
    expect(currentUndo(reconcileDraSnapshot(base, { seq: 9, undoPos: 2, undoTopId: 999, pendingShatter: [] }), liveCtx)).toBeUndefined();

    // User shattered a precinct by hand (uncommitted).
    expect(currentUndo(reconcileDraSnapshot(base, { seq: 9, undoPos: 2, undoTopId: 102, pendingShatter: ['P9'] }), liveCtx)).toBeUndefined();

    // Non-consecutive paint drops earlier entries instead of stacking across a gap.
    const gapped = recordPaintUndo(base, paintEntry(3, 5, 6, 106, 12));
    expect(gapped.paintStack).toHaveLength(1);
    expect(gapped.paintStack[0].stepId).toBe('s-3');
  });

  it('uses erasing wording for steps into Unassigned (district 0) and hides paint undo when painting/undoing is unavailable', () => {
    expect(paintUndoLabel(3, 0)).toBe('Undo erasing step 3');
    expect(paintUndoLabel(3, 2)).toBe('Undo painting step 3');

    const u = recordPaintUndo(emptyUndo(), paintEntry(1, 0, 1, 101, 5));
    expect(currentUndo(u, { ...liveCtx, canUndoPaint: false })).toBeUndefined();
  });
});

describe('undo state machine — panel settings', () => {
  it('labels destructive lock changes and ignores ordinary single-district toggles', () => {
    // Unlock all (2 locked -> 0)
    expect(lockUndoLabel({ locked: false, prevLocks: [2, 3], nextLocks: [], zeroedUnlocked: [] })).toBe('Undo unlock all');
    // Unlock all (1 locked -> 0)
    expect(lockUndoLabel({ locked: false, prevLocks: [2], nextLocks: [], zeroedUnlocked: [] })).toBe('Undo unlock all');
    // Unlocking just 1 of 2 locked districts: ordinary toggle
    expect(lockUndoLabel({ locked: false, prevLocks: [2, 3], nextLocks: [3], zeroedUnlocked: [] })).toBeNull();

    // Lock the N at zero (2 at zero)
    expect(lockUndoLabel({ locked: true, prevLocks: [], nextLocks: [3, 4], zeroedUnlocked: [3, 4] })).toBe('Undo lock the 2 at zero');
    // Lock the 1 at zero
    expect(lockUndoLabel({ locked: true, prevLocks: [1], nextLocks: [1, 7], zeroedUnlocked: [7] })).toBe('Undo lock the 1 at zero');
    // Locking a single non-zero district: ordinary toggle
    expect(lockUndoLabel({ locked: true, prevLocks: [], nextLocks: [2], zeroedUnlocked: [3, 4] })).toBeNull();
  });

  it('keeps only the latest setting change, scopes it to its map, and hides it during a walkthrough', () => {
    let u = emptyUndo();
    u = recordSettingUndo(u, {
      kind: 'locks',
      mapKey: 'live|NY|4|Fixture',
      prevLocks: [2, 3],
      prevScope: { mode: 'all' },
      afterScope: { mode: 'all' },
      label: 'Undo unlock all',
    });
    expect(currentUndo(u, panelCtx)).toEqual({ kind: 'setting', label: 'Undo unlock all' });
    // Hidden on another map or during a walkthrough.
    expect(currentUndo(u, { ...panelCtx, mapKey: 'live|VT|4|Other' })).toBeUndefined();
    expect(currentUndo(u, liveCtx)).toBeUndefined();

    // Replacing with a newer setting change keeps only the latest.
    const area = { ring: [[0, 0], [1, 0], [1, 1]] as Array<[number, number]>, mode: 'only' as const };
    u = recordSettingUndo(u, {
      kind: 'area',
      mapKey: 'live|NY|4|Fixture',
      prevArea: cloneSavedArea(area),
      label: 'Undo clearing area',
    });
    expect(currentUndo(u, panelCtx)).toEqual({ kind: 'setting', label: 'Undo clearing area' });

    // Clearing area undo does NOT resurrect the older locks undo.
    u = clearSettingUndo(u);
    expect(currentUndo(u, panelCtx)).toBeUndefined();
  });

  it('prefers the most recent kind when both exist, and falls back after clearing it', () => {
    let u = recordPaintUndo(emptyUndo(), paintEntry(1, 0, 1, 101, 5));
    u = recordSettingUndo(u, {
      kind: 'locks',
      mapKey: 'live|NY|4|Fixture',
      prevLocks: [2, 3],
      prevScope: { mode: 'all' },
      afterScope: { mode: 'all' },
      label: 'Undo unlock all',
    });
    expect(activeUndoEntry(u, panelCtx)?.kind).toBe('setting');
    expect(currentUndo(u, panelCtx)).toEqual({ kind: 'setting', label: 'Undo unlock all' });

    // Undoing the setting exposes the still-valid paint undo underneath.
    u = clearSettingUndo(u);
    expect(activeUndoEntry(u, panelCtx)?.kind).toBe('paint');
    expect(currentUndo(u, panelCtx)).toEqual({ kind: 'paint', label: 'Undo painting step 1' });

    // Clearing paint undo leaves nothing.
    u = clearPaintUndo(u);
    expect(currentUndo(u, panelCtx)).toBeUndefined();
  });

  it('cloneSavedArea deep-copies ring coordinates and preserves extra fields', () => {
    const orig = { ring: [[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8]] as Array<[number, number]>, mode: 'prefer' as const };
    const copy = cloneSavedArea(orig);
    copy.ring[0][0] = 0;
    expect(orig.ring[0][0]).toBe(-74);
  });
});
