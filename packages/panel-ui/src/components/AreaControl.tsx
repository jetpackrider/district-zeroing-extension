import { useEffect, useState } from 'react';
import type { PanelAction, PanelState } from '@zd/contracts';
import { formatBlocks, formatPeople, hasSelectedArea } from '../format';

interface AreaControlProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
}

/** One line per mode, under the Prefer / Only switch. */
const MODE_EXPLAIN: Record<'prefer' | 'only', string> = {
  prefer: 'Moves inside come first. Outside only to fill in when nothing inside works, and the card says so.',
  only: 'Nothing outside the area moves. If nothing works inside, no options are found.',
};

export const AREA_DRAW_HINT = 'Click the map to add corners. Double-click or click the first corner to finish. Esc cancels.';
const REGION_OPTIONS = [
  { kind: 'county', title: 'County', list: 'counties' },
  { kind: 'town', title: 'Town', list: 'towns' },
] as const;

/**
 * The area of the map where the user would like the swap to happen (PanelState.area). It applies
 * to one district, group and whole-map solves alike, so it sits with the scope controls, just above
 * the solve button.
 *
 * Three states:
 *  - no area: "Draw area" (on DRA's map) or "Use map view" (the part of the map in view);
 *  - drawing: how to draw, and Cancel;
 *  - an area: what is inside it, the Prefer / Only switch, and Redraw / Use map view / Clear.
 *
 * `area.unavailable` says why it can't be used right now. Without a DRA map to draw on (mapMode
 * 'mini') only drawing is off and "Use map view" still works (it takes the mini-map's view);
 * otherwise (say, the state's data has no block points) neither way of marking one works. Clear
 * always works.
 */
export function AreaControl({ state, dispatch }: AreaControlProps) {
  const area = state.area;
  const drawing = Boolean(area?.drawing);
  const picking = area?.picking;
  const editing = drawing || Boolean(picking);
  const hasArea = hasSelectedArea(area);
  const mode = area?.mode ?? 'prefer';
  const unavailable = area?.unavailable;
  const canDraw = !unavailable;
  const canUseView = !unavailable || state.mapMode === 'mini';
  const [regionKind, setRegionKind] = useState<'county' | 'town'>();
  const [search, setSearch] = useState('');
  const regionPicker = REGION_OPTIONS.find(({ kind }) => kind === regionKind);
  const matchingRegions = regionPicker && state.regions?.[regionPicker.list].filter(({ name }) =>
    name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  // Esc cancels drawing on DRA's map (the page hook listens there); with the side panel focused,
  // Esc here does the same.
  useEffect(() => {
    if (!editing) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dispatch({ type: 'area-cancel-draw' });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editing, dispatch]);

  const counts =
    hasArea && area.blocks !== undefined
      ? `${formatBlocks(area.blocks)}${area.people !== undefined ? `, ${formatPeople(area.people)}` : ''} inside`
      : hasArea && !unavailable
        ? 'Counting blocks inside…'
        : undefined;

  return (
    <section
      className={`zd-card zd-area${hasArea && !editing ? ' zd-area--set' : ''}`}
      aria-label="Swap area"
      data-testid="area-control"
    >
      <div className="zd-area__head">
        <h3 className="zd-section-title">Area</h3>
        {hasArea && !editing && counts && (
          <span className="zd-area__counts zd-num" data-testid="area-counts">
            {counts}
          </span>
        )}
      </div>

      {area?.region && !editing && <strong data-testid="area-region-name">{area.region.name}</strong>}
      {area?.cluster && !area.region && !editing && <strong data-testid="area-cluster-name">{area.cluster.name}</strong>}

      {editing ? (
        <>
          <p className="zd-note zd-note--info" role="status" data-testid={picking ? 'area-pick-hint' : 'area-draw-hint'}>
            {picking ? `Click DRA’s map to pick a ${picking}. Esc cancels.` : AREA_DRAW_HINT}
            {drawing && hasArea ? ' Your current area stays until you finish.' : ''}
          </p>
          <div className="zd-area__actions">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              data-testid="area-cancel-draw-btn"
              onClick={() => dispatch({ type: 'area-cancel-draw' })}
            >
              Cancel
            </button>
          </div>
        </>
      ) : !hasArea ? (
        <>
          <p className="zd-area__what">Mark where you&apos;d like the swap to happen.</p>
          <div className="zd-area__actions">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              data-testid="area-draw-btn"
              disabled={!canDraw}
              onClick={() => dispatch({ type: 'area-draw' })}
            >
              Draw area
            </button>
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              data-testid="area-use-view-btn"
              disabled={!canUseView}
              onClick={() => dispatch({ type: 'area-use-view' })}
            >
              Use map view
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="zd-segmented" role="group" aria-label="How to use the area">
            <button
              type="button"
              className="zd-btn zd-btn--sm zd-segmented__btn"
              aria-pressed={mode === 'prefer'}
              data-testid="area-mode-prefer"
              onClick={() => mode !== 'prefer' && dispatch({ type: 'set-area-mode', mode: 'prefer' })}
            >
              Prefer
            </button>
            <button
              type="button"
              className="zd-btn zd-btn--sm zd-segmented__btn"
              aria-pressed={mode === 'only'}
              data-testid="area-mode-only"
              onClick={() => mode !== 'only' && dispatch({ type: 'set-area-mode', mode: 'only' })}
            >
              Only
            </button>
          </div>
          <p className="zd-area__what" data-testid="area-mode-explain">
            {MODE_EXPLAIN[mode]}
          </p>
          <div className="zd-area__actions">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              data-testid="area-redraw-btn"
              disabled={!canDraw}
              onClick={() => dispatch({ type: 'area-draw' })}
            >
              {area?.region || area?.cluster ? 'Draw area' : 'Redraw'}
            </button>
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              data-testid="area-use-view-btn"
              disabled={!canUseView}
              onClick={() => dispatch({ type: 'area-use-view' })}
            >
              Use map view
            </button>
            <button
              type="button"
              className="zd-btn zd-btn--sm zd-btn--ghost"
              data-testid="area-clear-btn"
              onClick={() => dispatch({ type: 'area-clear' })}
            >
              Clear
            </button>
          </div>
        </>
      )}

      {!editing && REGION_OPTIONS.some(({ list }) => state.regions?.[list].length) && (
        <div className="zd-area__actions" role="group" aria-label="Choose a region">
          {REGION_OPTIONS.map(({ kind, title, list }) => (
            <button
              key={kind}
              type="button"
              className="zd-btn zd-btn--sm"
              aria-expanded={regionKind === kind}
              disabled={!state.regions?.[list].length}
              onClick={() => {
                setRegionKind(regionKind === kind ? undefined : kind);
                setSearch('');
              }}
            >
              {title}
            </button>
          ))}
        </div>
      )}
      {!editing && regionPicker && matchingRegions && (
        <div className="zd-area__picker">
          <input
            type="search"
            aria-label={`Search ${regionPicker.list}`}
            placeholder={`Search ${regionPicker.list}`}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
          <select
            aria-label={regionPicker.title}
            value=""
            onChange={(e) => {
              dispatch({ type: 'area-use-region', kind: regionPicker.kind, index: Number(e.currentTarget.value) });
              setRegionKind(undefined);
              setSearch('');
            }}
          >
            <option value="" disabled>{matchingRegions.length ? `Choose a ${regionPicker.kind}` : `No matching ${regionPicker.list}`}</option>
            {matchingRegions.map(({ index, name }) => <option key={index} value={index}>{name}</option>)}
          </select>
          <button
            type="button"
            className="zd-btn zd-btn--sm"
            disabled={Boolean(unavailable)}
            onClick={() => dispatch({ type: 'area-pick-region', kind: regionPicker.kind })}
          >
            Pick on map
          </button>
        </div>
      )}

      {unavailable && !editing && (
        <p className="zd-note zd-note--warn" data-testid="area-unavailable">
          {unavailable}
        </p>
      )}
    </section>
  );
}
