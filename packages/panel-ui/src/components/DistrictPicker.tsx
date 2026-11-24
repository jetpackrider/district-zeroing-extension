import { useMemo, useState } from 'react';
import type { PanelAction, PanelState } from '@zd/contracts';
import {
  formatDistrictName,
  formatInt,
  formatSigned,
  getDeviationTone,
  getSelectedDistrictIndexes,
  sortDistrictsWorstFirst,
} from '../format';

interface DistrictPickerProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
  readOnly?: boolean;
}

export function DistrictPicker({ state, dispatch, readOnly = false }: DistrictPickerProps) {
  const { districts, scope, feasibility, map } = state;
  const [collapsed, setCollapsed] = useState(false);

  const sorted = useMemo(() => sortDistrictsWorstFirst(districts), [districts]);
  const lockedList = state.lockedDistricts;
  const lockedSet = useMemo(() => new Set(lockedList ?? []), [lockedList]);
  const selectedSet = useMemo(
    () => new Set(getSelectedDistrictIndexes(scope, districts, lockedList)),
    [scope, districts, lockedList],
  );
  // Locks cannot change under a walkthrough: its plan was made with the locks as they were.
  const canLock = !readOnly && !state.walkthrough && !!map;
  const lockedCount = districts.filter((d) => lockedSet.has(d.index)).length;
  const zeroedUnlocked = districts.filter(
    (d) => !lockedSet.has(d.index) && getDeviationTone(d.deviation, map) === 'zero',
  );

  // Compute unselected neighbors of the currently selected districts
  const addableNeighbors = useMemo(() => {
    const out = new Set<number>();
    for (const row of districts) {
      if (!selectedSet.has(row.index) || !row.neighbors) continue;
      for (const nbr of row.neighbors) {
        if (!selectedSet.has(nbr) && !lockedSet.has(nbr)) out.add(nbr);
      }
    }
    return [...out].sort((a, b) => a - b);
  }, [districts, selectedSet, lockedSet]);

  const showCheckboxes = !readOnly && (scope.mode === 'group' || scope.mode === 'all');

  const handleToggleDistrict = (districtIndex: number) => {
    if (readOnly || lockedSet.has(districtIndex)) return;
    if (scope.mode === 'one') {
      // The same district again keeps its neighbor choice; another district starts from "any neighbor".
      if (districtIndex === scope.district) return;
      dispatch({ type: 'set-scope', scope: { mode: 'one', district: districtIndex } });
      return;
    }

    const next = new Set(selectedSet);
    if (next.has(districtIndex)) {
      next.delete(districtIndex);
    } else {
      next.add(districtIndex);
    }
    const allowOutsideAbsorb = scope.mode === 'group' ? scope.allowOutsideAbsorb : false;
    dispatch({
      type: 'set-scope',
      scope: {
        mode: 'group',
        districts: [...next].sort((a, b) => a - b),
        allowOutsideAbsorb,
      },
    });
  };

  const setLock = (indexes: number[], locked: boolean) => {
    if (!canLock || indexes.length === 0) return;
    dispatch({ type: 'set-district-lock', districts: indexes, locked });
  };

  const handleSelectAll = () => {
    if (readOnly) return;
    dispatch({ type: 'set-scope', scope: { mode: 'all' } });
  };

  const handleAddNeighbors = () => {
    if (readOnly || addableNeighbors.length === 0) return;
    const merged = new Set([...selectedSet, ...addableNeighbors]);
    const allowOutsideAbsorb = scope.mode === 'group' ? scope.allowOutsideAbsorb : false;
    dispatch({
      type: 'set-scope',
      scope: {
        mode: 'group',
        districts: [...merged].sort((a, b) => a - b),
        allowOutsideAbsorb,
      },
    });
  };

  const handleAddSuggested = (districtIndex: number) => {
    if (readOnly || scope.mode !== 'group') return;
    const merged = new Set([...scope.districts, districtIndex]);
    dispatch({
      type: 'set-scope',
      scope: {
        mode: 'group',
        districts: [...merged].sort((a, b) => a - b),
        allowOutsideAbsorb: scope.allowOutsideAbsorb,
      },
    });
  };

  const handleToggleOutsideAbsorb = (checked: boolean) => {
    if (readOnly || scope.mode !== 'group') return;
    dispatch({
      type: 'set-scope',
      scope: {
        mode: 'group',
        districts: scope.districts,
        allowOutsideAbsorb: checked,
      },
    });
  };

  return (
    <section className="zd-card" aria-label="Districts">
      <div className="zd-picker-toolbar">
        <button
          type="button"
          className="zd-btn zd-btn--ghost zd-btn--sm"
          style={{ paddingLeft: 2 }}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          <span className="zd-section-title" style={{ color: 'inherit' }}>
            Districts ({districts.length}) · worst first
          </span>
        </button>

        {!readOnly && (
          <div className="zd-picker-shortcuts">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={handleSelectAll}
              disabled={scope.mode === 'all'}
            >
              {lockedCount > 0 ? 'Select all unlocked' : 'Select all'}
            </button>
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={handleAddNeighbors}
              disabled={addableNeighbors.length === 0}
              title={
                addableNeighbors.length > 0
                  ? `Add ${addableNeighbors.length} adjacent district${addableNeighbors.length === 1 ? '' : 's'}`
                  : 'No unselected adjacent districts available'
              }
            >
              Add neighbors{addableNeighbors.length > 0 ? ` (+${addableNeighbors.length})` : ''}
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="zd-district-list" role="region" aria-label="District population list">
          <div className={`zd-district-head${showCheckboxes ? '' : ' zd-district-head--one'}`}>
            {showCheckboxes && <span aria-hidden="true" />}
            <span>District</span>
            <span style={{ textAlign: 'right' }}>Pop</span>
            <span style={{ textAlign: 'right' }}>Dev</span>
            <span aria-hidden="true" />
          </div>

          {sorted.map((row) => {
            const isLocked = lockedSet.has(row.index);
            const isSelected = !readOnly && selectedSet.has(row.index);
            const tone = getDeviationTone(row.deviation, map);
            const symbol = tone === 'zero' ? '✓' : tone === 'over' ? '▲' : '▼';
            const name = formatDistrictName(row.index, districts);

            return (
              <div
                key={row.index}
                className={[
                  'zd-district-row',
                  showCheckboxes ? '' : 'zd-district-row--one',
                  isSelected ? 'zd-district-row--selected' : '',
                  isLocked ? 'zd-district-row--locked' : '',
                  readOnly ? 'zd-district-row--readonly' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  if (!showCheckboxes && !readOnly) {
                    handleToggleDistrict(row.index);
                  }
                }}
                role={showCheckboxes || readOnly ? undefined : 'button'}
                tabIndex={showCheckboxes || readOnly ? undefined : 0}
                aria-pressed={showCheckboxes || readOnly ? undefined : isSelected}
                onKeyDown={(e) => {
                  if (!showCheckboxes && !readOnly && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    handleToggleDistrict(row.index);
                  }
                }}
              >
                {showCheckboxes && (
                  <input
                    type="checkbox"
                    className="zd-district-row__check"
                    checked={isSelected}
                    disabled={isLocked}
                    onChange={() => handleToggleDistrict(row.index)}
                    aria-label={`Select ${name}`}
                  />
                )}
                <span className="zd-district-row__name">
                  {row.color && (
                    <span
                      className="zd-swatch"
                      style={{ backgroundColor: row.color }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="zd-district-row__label">{name}</span>
                </span>
                <span className="zd-district-row__pop zd-num">{formatInt(row.pop)}</span>
                <span className="zd-district-row__dev">
                  <span
                    className={`zd-dev zd-dev--${tone}`}
                    aria-label={`${name} deviation ${formatSigned(row.deviation)}`}
                  >
                    <span aria-hidden="true" style={{ fontSize: '9px' }}>
                      {symbol}
                    </span>
                    {formatSigned(row.deviation)}
                  </span>
                </span>
                <button
                  type="button"
                  className={`zd-lock${isLocked ? ' zd-lock--on' : ''}`}
                  aria-pressed={isLocked}
                  aria-label={isLocked ? `Unlock ${name}` : `Lock ${name}`}
                  title={
                    isLocked
                      ? `${name} is locked: no suggestion changes it. Click to unlock.`
                      : `Lock ${name}: no suggestion will move a block into or out of it.`
                  }
                  disabled={!canLock}
                  data-testid={`lock-${row.index}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLock([row.index], !isLocked);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <LockIcon locked={isLocked} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!collapsed && !readOnly && (lockedCount > 0 || zeroedUnlocked.length > 0) && (
        <div className="zd-lock-bar" data-testid="lock-bar">
          <span className="zd-lock-bar__text zd-num">
            {lockedCount > 0
              ? `${lockedCount} locked: suggestions leave ${lockedCount === 1 ? 'it' : 'them'} alone.`
              : 'Lock a finished district and suggestions leave it alone.'}
          </span>
          <span className="zd-lock-bar__actions">
            {zeroedUnlocked.length > 0 && (
              <button
                type="button"
                className="zd-btn zd-btn--sm"
                disabled={!canLock}
                data-testid="lock-zeroed"
                onClick={() => setLock(zeroedUnlocked.map((d) => d.index), true)}
              >
                Lock the {zeroedUnlocked.length} at zero
              </button>
            )}
            {lockedCount > 0 && (
              <button
                type="button"
                className="zd-btn zd-btn--sm zd-btn--ghost"
                disabled={!canLock}
                data-testid="unlock-all"
                onClick={() => setLock([...lockedSet], false)}
              >
                Unlock all
              </button>
            )}
          </span>
        </div>
      )}

      {!readOnly && scope.mode === 'group' && (
        <>
          {feasibility && (
            <div
              className={`zd-feasibility ${feasibility.feasible ? 'zd-feasibility--ok' : 'zd-feasibility--bad'}`}
              role="status"
              data-testid="group-feasibility"
            >
              {feasibility.feasible ? (
                <p className="zd-feasibility__line">
                  ✓ This group can be zeroed on its own.
                </p>
              ) : (
                <>
                  <p className="zd-feasibility__line zd-num">
                    This group is{' '}
                    <strong>
                      {feasibility.excess > 0
                        ? `${formatSigned(feasibility.excess)} over`
                        : `${formatSigned(feasibility.excess)} under`}
                    </strong>{' '}
                    and can&apos;t be zeroed on its own.
                  </p>
                  <div className="zd-feasibility__actions">
                    {feasibility.suggestAdd.map((dIdx) => (
                      <button
                        key={dIdx}
                        type="button"
                        className="zd-btn zd-btn--sm"
                        onClick={() => handleAddSuggested(dIdx)}
                      >
                        + Add {formatDistrictName(dIdx, districts)}
                      </button>
                    ))}
                    {!scope.allowOutsideAbsorb && (
                      <button
                        type="button"
                        className="zd-btn zd-btn--sm zd-btn--warn"
                        onClick={() => handleToggleOutsideAbsorb(true)}
                      >
                        Let outside neighbors absorb
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <label className="zd-checkbox-inline">
            <input
              type="checkbox"
              checked={scope.allowOutsideAbsorb}
              onChange={(e) => handleToggleOutsideAbsorb(e.target.checked)}
            />
            <span>Allow outside neighbors to absorb excess</span>
          </label>
        </>
      )}
    </section>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill={locked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
      <path
        d={locked ? 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' : 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
