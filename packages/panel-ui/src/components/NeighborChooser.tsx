import { useMemo } from 'react';
import type { PanelAction, PanelState } from '@zd/contracts';
import {
  chosenNeighbors,
  formatDistrictName,
  formatSigned,
  getDeviationTone,
  isDeviationZeroed,
  joinNames,
  neighborChoiceRows,
  tradeDirectionPhrase,
} from '../format';

interface NeighborChooserProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
}

/**
 * One-district mode: which neighbors trade with the selected district. An over district gives to
 * them, an under district takes from them. Nothing picked = any neighbor (the solver decides).
 * The choice lives in the scope (`with`), so it survives re-solving.
 */
export function NeighborChooser({ state, dispatch }: NeighborChooserProps) {
  const { scope, districts, map } = state;
  const row = scope.mode === 'one' ? districts.find((d) => d.index === scope.district) : undefined;
  const locked = state.lockedDistricts;
  const allOptions = useMemo(() => (row ? neighborChoiceRows(row, districts, map) : []), [row, districts, map]);
  // A locked neighbor never trades, so it is not on offer.
  const options = useMemo(() => allOptions.filter((o) => !locked?.includes(o.index)), [allOptions, locked]);
  const lockedNeighbors = allOptions.filter((o) => locked?.includes(o.index));
  const pickedAll = useMemo(() => chosenNeighbors(scope, districts), [scope, districts]);
  const picked = useMemo(() => pickedAll.filter((d) => !locked?.includes(d)), [pickedAll, locked]);

  if (scope.mode !== 'one' || !row || !row.neighbors || row.neighbors.length === 0) return null;
  if (isDeviationZeroed(row.deviation, map)) return null;
  if (locked?.includes(row.index)) return null;

  const pickedSet = new Set(picked);
  const over = row.deviation > 0;
  const direction = tradeDirectionPhrase(row, districts);
  const pickedNames = picked.map((d) => formatDistrictName(d, districts));
  const summary =
    picked.length === 0
      ? `${direction} any neighbor; the solver picks which.`
      : picked.length === 1
        ? `${direction} ${pickedNames[0]} only.`
        : `${direction} ${joinNames(pickedNames, 'and')}, split between them as the solver finds best.`;
  const worsePicked = options.filter((o) => o.worse && pickedSet.has(o.index));

  const setWith = (next: number[]) => {
    const sorted = [...new Set(next)].sort((a, b) => a - b);
    dispatch({
      type: 'set-scope',
      scope: sorted.length ? { mode: 'one', district: row.index, with: sorted } : { mode: 'one', district: row.index },
    });
  };

  const toggle = (idx: number) => {
    setWith(pickedSet.has(idx) ? picked.filter((d) => d !== idx) : [...picked, idx]);
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

      <div className="zd-chooser__list" role="group" aria-label={`${direction}…`}>
        <div className="zd-chooser__colhead" aria-hidden="true">
          <span>Neighbor</span>
          <span>now → if it {over ? 'takes' : 'gives'} them all</span>
        </div>
        {options.map((o) => {
          const name = formatDistrictName(o.index, districts);
          const color = districts.find((d) => d.index === o.index)?.color;
          const checked = pickedSet.has(o.index);
          const afterTone = getDeviationTone(o.after, map);
          return (
            <label
              key={o.index}
              className={`zd-chooser__row${checked ? ' zd-chooser__row--picked' : ''}`}
              data-testid={`chooser-row-${o.index}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(o.index)}
                aria-label={`${over ? 'Give to' : 'Take from'} ${name}`}
              />
              <span className="zd-chooser__name">
                {color && <span className="zd-swatch" style={{ backgroundColor: color }} aria-hidden="true" />}
                <span>{name}</span>
              </span>
              <span className="zd-chooser__vals zd-num">
                <span style={{ color: 'var(--zd-text-muted)' }}>{formatSigned(o.before)}</span>
                <span aria-hidden="true">→</span>
                <span className={`zd-dev zd-dev--inline zd-dev--${afterTone}`}>
                  {formatSigned(o.after)}
                  {o.zeroes ? ' ✓' : ''}
                </span>
                {o.worse && <span className="zd-chooser__worse">further from zero</span>}
              </span>
            </label>
          );
        })}
      </div>

      {lockedNeighbors.length > 0 && (
        <p className="zd-chooser__note" data-testid="chooser-locked-note">
          {joinNames(lockedNeighbors.map((o) => formatDistrictName(o.index, districts)))}{' '}
          {lockedNeighbors.length === 1 ? 'is locked and is' : 'are locked and are'} left out.
        </p>
      )}

      {worsePicked.length > 0 && (
        <p className="zd-chooser__note" data-testid="chooser-worse-note">
          {joinNames(worsePicked.map((o) => formatDistrictName(o.index, districts)))}{' '}
          {worsePicked.length === 1 ? 'may' : 'may each'} end further from zero than now. Allowed, because you picked{' '}
          {worsePicked.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </section>
  );
}
