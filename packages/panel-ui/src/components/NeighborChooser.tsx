import { useMemo } from 'react';
import type { PanelAction, PanelState } from '@zd/contracts';
import {
  UNASSIGNED_NAME,
  chosenNeighbors,
  deltaToGoal,
  formatDistrictName,
  formatInt,
  formatNeighborNames,
  formatPeople,
  formatSigned,
  getDeviationTone,
  isAtGoal,
  isUnassigned,
  joinNames,
  neighborChoiceRows,
  tradeDirectionPhrase,
  unassignedChoice,
} from '../format';

interface NeighborChooserProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
}

/**
 * One-district mode: which neighbors trade with the selected district. An over district gives to
 * them, an under district takes from them. Nothing picked = any neighbor (the solver decides).
 * The choice lives in the scope (`with`), so it survives re-solving.
 *
 * Unassigned (district 0) is offered as a row of its own when the district touches unassigned
 * blocks. It has no deviation, so its row shows its population before and after instead, never a
 * "further from zero" warning, and it is never locked. "Any neighbor" includes it only while it
 * holds people (a map still being drawn); on a finished map it is used only when picked.
 */
export function NeighborChooser({ state, dispatch }: NeighborChooserProps) {
  const { scope, districts, map } = state;
  const row = scope.mode === 'one' ? districts.find((d) => d.index === scope.district) : undefined;
  const goal = scope.mode === 'one' ? scope.goal : undefined;
  const locked = state.lockedDistricts;
  const allOptions = useMemo(() => (row ? neighborChoiceRows(row, districts, map, goal) : []), [row, districts, map, goal]);
  // A locked neighbor never trades, so it is not on offer.
  const options = useMemo(() => allOptions.filter((o) => !locked?.includes(o.index)), [allOptions, locked]);
  const lockedNeighbors = allOptions.filter((o) => locked?.includes(o.index));
  const pickedAll = useMemo(() => chosenNeighbors(scope, districts), [scope, districts]);
  // Locks never apply to Unassigned.
  const picked = useMemo(
    () => pickedAll.filter((d) => isUnassigned(d) || !locked?.includes(d)),
    [pickedAll, locked],
  );
  const unassigned = row ? unassignedChoice(row, state, goal) : undefined;

  if (scope.mode !== 'one' || !row || !row.neighbors || row.neighbors.length === 0) return null;
  if (isAtGoal(row.deviation, goal, map)) return null;
  if (locked?.includes(row.index)) return null;

  const pickedSet = new Set(picked);
  const delta = deltaToGoal(row.deviation, goal);
  const over = delta > 0;
  const direction = tradeDirectionPhrase(row, districts, goal);
  const pickedNames = formatNeighborNames(picked, districts);
  const name = formatDistrictName(row.index, districts);
  const giveOrTake = over ? 'give them to' : 'take them from';
  const summary =
    picked.length === 0
      ? unassigned && options.length === 0
        ? // Every real neighbor is locked: Unassigned is all that is left.
          unassigned.inDefault
          ? `${direction} ${UNASSIGNED_NAME}, the only neighbor that is not locked.`
          : `Every district next to ${name} is locked. Pick ${UNASSIGNED_NAME} to ${giveOrTake} unassigned blocks.`
        : unassigned?.inDefault
          ? `${direction} any neighbor, ${UNASSIGNED_NAME} included; the solver picks which.`
          : `${direction} any neighbor; the solver picks which.`
      : picked.length === 1
        ? `${direction} ${pickedNames[0]} only.`
        : `${direction} ${joinNames(pickedNames, 'and')}, split between them as the solver finds best.`;
  const worsePicked = options.filter((o) => o.worse && pickedSet.has(o.index));
  // Unassigned's deviation effect is zero: it sits after every real neighbor a move brings closer
  // to zero, and before those it would push further away.
  const unassignedAt = options.findIndex((o) => Math.abs(o.after) - Math.abs(o.before) > 0);
  const unassignedPos = unassignedAt < 0 ? options.length : unassignedAt;
  // How "Any neighbor" treats Unassigned, and what picking it on a finished map means.
  const unassignedPicked = pickedSet.has(0);
  const unassignedNote = !unassigned
    ? undefined
    : unassigned.inDefault
      ? `"Any neighbor" includes ${UNASSIGNED_NAME} while the map is still being drawn (${formatPeople(unassigned.before)} unassigned now).`
      : !over
        ? `No people are unassigned, so "Any neighbor" leaves ${UNASSIGNED_NAME} out; it has nobody to give.`
        : unassignedPicked
          ? `This leaves ${formatPeople(delta)} unassigned on a map that had none.`
          : `No people are unassigned, so "Any neighbor" leaves ${UNASSIGNED_NAME} out. Picking it leaves ${formatPeople(delta)} unassigned.`;

  const setWith = (next: number[]) => {
    const sorted = [...new Set(next)].sort((a, b) => a - b);
    const withGoal = goal !== undefined ? { goal } : {};
    dispatch({
      type: 'set-scope',
      scope: sorted.length
        ? { mode: 'one', district: row.index, with: sorted, ...withGoal }
        : { mode: 'one', district: row.index, ...withGoal },
    });
  };

  const toggle = (idx: number) => {
    setWith(pickedSet.has(idx) ? picked.filter((d) => d !== idx) : [...picked, idx]);
  };

  const renderRow = (o: (typeof options)[number]) => {
    const nbrName = formatDistrictName(o.index, districts);
    const color = districts.find((d) => d.index === o.index)?.color;
    const checked = pickedSet.has(o.index);
    const afterTone = getDeviationTone(o.after, map);
    return (
      <label
        key={o.index}
        className={`zd-list__row zd-chooser__row${checked ? ' zd-list__row--selected' : ''}`}
        data-testid={`chooser-row-${o.index}`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(o.index)}
          aria-label={`${over ? 'Give to' : 'Take from'} ${nbrName}`}
        />
        <span className="zd-chooser__name">
          {color && <span className="zd-swatch" style={{ backgroundColor: color }} aria-hidden="true" />}
          <span>{nbrName}</span>
        </span>
        <span className="zd-chooser__vals zd-num">
          <span className="zd-muted">{formatSigned(o.before)}</span>
          <span aria-hidden="true">→</span>
          <span className={`zd-pill zd-num zd-pill--inline zd-pill--${afterTone}`}>
            {formatSigned(o.after)}
            {o.zeroes ? ' ✓' : ''}
          </span>
          {o.worse && <span className="zd-chooser__worse">further from zero</span>}
        </span>
      </label>
    );
  };

  return (
    <section className="zd-card zd-chooser" aria-label="Neighbors to trade with" data-testid="neighbor-chooser">
      <div className="zd-chooser__head">
        <h3 className="zd-section-title">{over ? 'Give to' : 'Take from'}</h3>
        <button
          type="button"
          className="zd-btn zd-btn--sm"
          aria-pressed={picked.length === 0}
          data-testid="chooser-any"
          disabled={picked.length === 0}
          onClick={() => setWith([])}
        >
          Any neighbor
        </button>
      </div>

      <p className="zd-chooser__summary zd-num" data-testid="chooser-summary">
        {summary}
      </p>

      <div className="zd-list" role="group" aria-label={`${direction}…`}>
        <div className="zd-chooser__colhead" aria-hidden="true">
          <span>Neighbor</span>
          <span>now → if it {over ? 'takes' : 'gives'} them all</span>
        </div>
        {options.slice(0, unassignedPos).map((o) => renderRow(o))}
        {unassigned && (
          <label
            className={`zd-list__row zd-chooser__row zd-chooser__row--unassigned${unassignedPicked ? ' zd-list__row--selected' : ''}`}
            data-testid="chooser-row-0"
          >
            <input
              type="checkbox"
              checked={unassignedPicked}
              onChange={() => toggle(0)}
              aria-label={`${over ? 'Give to' : 'Take from'} ${UNASSIGNED_NAME}`}
            />
            <span className="zd-chooser__name">
              <span className="zd-swatch zd-swatch--unassigned" aria-hidden="true" />
              <span>{UNASSIGNED_NAME}</span>
            </span>
            <span className="zd-chooser__vals zd-num">
              <span className="zd-chooser__pop-label">pop</span>
              <span className="zd-muted">{formatInt(unassigned.before)}</span>
              <span aria-hidden="true">→</span>
              <span>{formatInt(unassigned.after)}</span>
              {unassigned.short && <span className="zd-chooser__pop-label">holds too few</span>}
            </span>
          </label>
        )}
        {options.slice(unassignedPos).map((o) => renderRow(o))}
      </div>

      {lockedNeighbors.length > 0 && (
        <p className="zd-note zd-note--warn" data-testid="chooser-locked-note">
          {joinNames(lockedNeighbors.map((o) => formatDistrictName(o.index, districts)))}{' '}
          {lockedNeighbors.length === 1 ? 'is locked and is' : 'are locked and are'} left out.
        </p>
      )}

      {unassignedNote && (
        <p
          className={`zd-note ${unassigned?.inDefault ? 'zd-note--info' : 'zd-note--warn'}`}
          data-testid="chooser-unassigned-note"
        >
          {unassignedNote}
        </p>
      )}

      {worsePicked.length > 0 && (
        <p className="zd-note zd-note--warn" data-testid="chooser-worse-note">
          {joinNames(worsePicked.map((o) => formatDistrictName(o.index, districts)))}{' '}
          {worsePicked.length === 1 ? 'may' : 'may each'} end further from zero than now. Allowed, because you picked{' '}
          {worsePicked.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </section>
  );
}
