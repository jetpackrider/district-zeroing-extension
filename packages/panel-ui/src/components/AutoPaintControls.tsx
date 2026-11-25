import type { PanelAction, PanelState, WalkthroughStep } from '@zd/contracts';
import { formatInt, isUnassigned } from '../format';

interface AutoPaintControlsProps {
  autoPaint: NonNullable<PanelState['autoPaint']>;
  step: WalkthroughStep;
  /** Name of the receiving district, e.g. "District 12" ("Unassigned" for a step that erases). */
  toName: string;
  /**
   * Set when this step should not be painted yet even though painting is on, e.g. Leg 2 of a
   * two-way trade while Leg 1 is unfinished. Shown instead of enabling the button.
   */
  blockedReason?: string;
  dispatch: (action: PanelAction) => void;
}

/** One sentence: what turning the setting on does. */
export const AUTO_PAINT_EXPLANATION =
  "When this is on, each step gets a button that has DRA paint that one step's blocks for you, through DRA's own painting, so DRA's Undo can take it back.";

/**
 * "Paint steps for me" (opt-in) and, when it is on, the "Paint this step" button for the current
 * step. Painting is an alternative to following the step by hand, never a replacement: the by-hand
 * instructions stay above this.
 */
export function AutoPaintControls({ autoPaint, step, toName, blockedReason, dispatch }: AutoPaintControlsProps) {
  const { available, enabled, busy, reason } = autoPaint;
  const on = available && enabled;
  const people = step.blocks.reduce((s, b) => s + b.people, 0);
  const awaitingCommit = step.status === 'awaiting-commit';
  const done = step.status === 'done';
  // A step into Unassigned (district 0) erases: DRA paints the blocks with its Eraser's value, 0.
  const erasing = isUnassigned(step.to);
  const blocksText = `${step.blocks.length} highlighted ${step.blocks.length === 1 ? 'block' : 'blocks'}`;
  const disabledWhy = busy
    ? undefined
    : awaitingCommit
      ? "This step's blocks are painted already; commit the shattered precinct with DRA's checkmark."
      : blockedReason;

  return (
    <div className="zd-autopaint" data-testid="auto-paint">
      {on && !done && (
        <div className="zd-autopaint__action">
          <button
            type="button"
            className="zd-btn zd-btn--primary zd-btn--sm"
            data-testid="paint-step-btn"
            disabled={Boolean(busy) || Boolean(disabledWhy)}
            aria-busy={busy ? true : undefined}
            onClick={() => dispatch({ type: 'walkthrough-paint-step' })}
          >
            {busy ? (erasing ? 'Erasing…' : 'Painting…') : erasing ? 'Erase this step' : 'Paint this step'}
          </button>
          <span className="zd-autopaint__what" data-testid="paint-step-what">
            {busy
              ? `DRA is ${erasing ? 'erasing' : 'painting'} this step; the extension then re-reads the plan to check it.`
              : erasing
                ? step.wholePrecinct
                  ? `Erases the whole precinct ${step.precinctId} (${formatInt(people)} people), leaving it unassigned.`
                  : `Erases the ${blocksText} (${formatInt(people)} people), leaving them unassigned; no shattering or checkmark needed.`
                : step.wholePrecinct
                  ? `Moves the whole precinct ${step.precinctId} (${formatInt(people)} people) into ${toName}.`
                  : `Moves the ${blocksText} (${formatInt(people)} people) into ${toName}; no shattering or checkmark needed.`}
          </span>
          {disabledWhy && (
            <span className="zd-autopaint__note" data-testid="paint-step-blocked">
              {disabledWhy}
            </span>
          )}
          {!busy && available && reason && (
            <span className="zd-autopaint__note zd-autopaint__note--warn" role="status" data-testid="paint-step-note">
              {reason}
            </span>
          )}
          <span className="zd-autopaint__alt">Or paint it by hand as described above.</span>
        </div>
      )}

      <label className="zd-checkbox-inline zd-autopaint__setting">
        <input
          type="checkbox"
          data-testid="auto-paint-toggle"
          checked={on}
          disabled={!available || Boolean(busy)}
          onChange={(e) => dispatch({ type: 'set-auto-paint', enabled: e.target.checked })}
        />
        <span>Paint steps for me</span>
      </label>
      <span className="zd-autopaint__explain">{AUTO_PAINT_EXPLANATION}</span>
      {!available && reason && (
        <span className="zd-autopaint__note zd-autopaint__note--warn" role="status" data-testid="auto-paint-unavailable">
          {reason}
        </span>
      )}
      {available && !enabled && reason && (
        <span className="zd-autopaint__note zd-autopaint__note--warn" role="status" data-testid="paint-step-note">
          {reason}
        </span>
      )}
    </div>
  );
}
