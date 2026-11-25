import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { ConnectionStatus, PanelAction } from '@zd/contracts';
import type { PanelProps } from '../types';
import { formatDistrictShort, formatSigned, formatSolutionTitle, solutionBadges } from '../format';
import { ensurePanelStyles } from '../styles/injectStyles';
import { AboutView } from './AboutView';
import { AreaControl } from './AreaControl';
import { ClustersView } from './ClustersView';
import { ConnectionView } from './ConnectionView';
import { CsvDropZone } from './CsvDropZone';
import { DistrictPicker } from './DistrictPicker';
import { InteractionView } from './InteractionView';
import { MiniMapSlot } from './MiniMapSlot';
import { NeighborChooser } from './NeighborChooser';
import { NoticeBanner } from './NoticeBanner';
import { ScopeHeader } from './ScopeHeader';
import { SolutionCard } from './SolutionCard';
import { SolveSection } from './SolveSection';
import { WalkthroughView } from './WalkthroughView';

function statusBadgeMeta(connection: ConnectionStatus): {
  label: string;
  variant: 'live' | 'csv' | 'connecting' | 'warn' | 'error' | 'idle';
} {
  switch (connection) {
    case 'live':
      return { label: 'Live', variant: 'live' };
    case 'csv':
      return { label: 'CSV mode', variant: 'csv' };
    case 'connecting':
      return { label: 'Connecting', variant: 'connecting' };
    case 'hook-failed':
      return { label: 'Update pending', variant: 'warn' };
    case 'unsupported-map':
      return { label: 'Unsupported', variant: 'warn' };
    case 'data-mismatch':
      return { label: 'Data mismatch', variant: 'error' };
    case 'no-plan':
      return { label: 'No map open', variant: 'idle' };
    case 'no-tab':
      return { label: 'No DRA tab', variant: 'idle' };
  }
}

function readCsvFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsText(file);
  });
}

export function Panel({ controller, renderMiniMap, className }: PanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const liveCsvInputRef = useRef<HTMLInputElement | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [hoveredBorder, setHoveredBorder] = useState<{ a: number; b: number } | null>(null);

  useEffect(() => {
    ensurePanelStyles(rootRef.current);
  }, []);

  const state = useSyncExternalStore(
    useCallback((cb) => controller.subscribe(cb), [controller]),
    () => controller.getState(),
    () => controller.getState(),
  );

  // Clear local hoveredBorder when leaving the working view
  useEffect(() => {
    if (state.walkthrough || (state.connection !== 'live' && state.connection !== 'csv')) {
      setHoveredBorder(null);
    }
  }, [state.walkthrough, state.connection]);

  const dispatch = useCallback(
    (action: PanelAction) => {
      if (action.type === 'hover-border') {
        setHoveredBorder(action.a !== null && action.b !== null ? { a: action.a, b: action.b } : null);
      }
      controller.dispatch(action);
    },
    [controller],
  );

  const handleLiveCsvFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const text = await readCsvFile(file);
        if (!text.trim()) return;
        dispatch({ type: 'load-csv', text, fileName: file.name });
      } catch {
        // Ignore unreadable file errors here; the file picker remains usable.
      }
    },
    [dispatch],
  );

  const handleLiveCsvChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    void handleLiveCsvFile(file);
    e.target.value = '';
  };

  const handleLivePanelDrop = (e: DragEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || state.connection !== 'live' || state.walkthrough) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    void handleLiveCsvFile(file);
  };

  const badge = statusBadgeMeta(state.connection);
  const isWorkingMode = state.connection === 'live' || state.connection === 'csv';

  // Cmd/Ctrl+Z inside the side panel triggers PanelState.undo (never runs on DRA's page).
  useEffect(() => {
    if (!state.undo || showAbout || !isWorkingMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'z') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          (target.tagName === 'INPUT' &&
            !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(
              (target as HTMLInputElement).type.toLowerCase(),
            )))
      ) {
        return;
      }
      if (state.undo?.kind === 'paint' && state.autoPaint?.busy) return;
      e.preventDefault();
      dispatch({ type: 'undo' });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.undo, state.autoPaint?.busy, showAbout, isWorkingMode, dispatch]);

  // Choose which plan's flows to overlay on the InteractionView
  const hoveredIdx = state.hoveredSolutionId
    ? state.solutions.findIndex((s) => s.id === state.hoveredSolutionId)
    : -1;
  const activePlanCard = hoveredIdx >= 0 ? state.solutions[hoveredIdx] : undefined;
  const badges = solutionBadges(state.solutions);
  const activePlanTitle = activePlanCard
    ? formatSolutionTitle(activePlanCard.kind, hoveredIdx)
    : undefined;

  // Outside a walkthrough, show the mini-map slot when mapMode is 'mini' and there is something to show
  const hasPreviewableTarget =
    Boolean(state.hoveredSolutionId) ||
    Boolean(hoveredBorder) ||
    state.solutions.length > 0 ||
    Boolean(state.interaction && state.interaction.edges.length > 0);
  // "Use map view" with no DRA map takes the mini-map's view (AreaState), so on a live map the
  // mini-map shows whenever the area card is up, before anything can be previewed: one-district
  // scope before a solve, after an area change dropped the options, whole maps with no
  // interaction view. Without it the button would have no view to take.
  const miniForArea = state.connection === 'live' && state.area !== undefined;
  const showOutsideMiniMap =
    isWorkingMode && !state.walkthrough && state.mapMode === 'mini' && (hasPreviewableTarget || miniForArea);

  const miniMapSubCaption = activePlanTitle
    ? `Showing ${activePlanTitle}`
    : hoveredBorder
      ? `Border ${formatDistrictShort(hoveredBorder.a, state.districts)} ↔ ${formatDistrictShort(hoveredBorder.b, state.districts)}`
      : hasPreviewableTarget
        ? 'Hover a border or option to preview'
        : 'Move this map to the part you want, then press "Use map view"';

  return (
    <div
      ref={rootRef}
      className={`zd-panel${className ? ` ${className}` : ''}`}
      data-connection={state.connection}
      onDragOver={(e) => {
        if (state.connection === 'live' && !state.walkthrough && e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
        }
      }}
      onDrop={handleLivePanelDrop}
    >
      {/* Top shell bar */}
      <header className="zd-topbar">
        <div className="zd-topbar__left">
          <span className="zd-brand">Zero Deviation</span>
          <span
            className={`zd-pill zd-pill--${{
              live: 'zero', csv: 'accent', connecting: 'accent', warn: 'warn', error: 'error', idle: 'neutral',
            }[badge.variant]}`}
            data-testid="connection-pill"
          >
            <span className="zd-status-pill__dot" aria-hidden="true" />
            {badge.label}
          </span>
        </div>

        <div className="zd-topbar__right">
          {state.connection === 'live' && !showAbout && !state.walkthrough && (
            <>
              <input
                ref={liveCsvInputRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="zd-dropzone__input"
                aria-label="Load CSV instead of live DRA tab"
                data-testid="live-csv-input"
                onChange={handleLiveCsvChange}
              />
              <button
                type="button"
                className="zd-btn zd-btn--ghost zd-btn--sm"
                data-testid="live-load-csv-btn"
                title="Load a DRA block-assignment CSV instead of the live tab"
                onClick={() => liveCsvInputRef.current?.click()}
              >
                Load CSV
              </button>
            </>
          )}
          <button
            type="button"
            className="zd-btn zd-btn--ghost zd-btn--sm"
            aria-pressed={showAbout}
            onClick={() => setShowAbout((v) => !v)}
          >
            {showAbout ? 'Close' : 'About'}
          </button>
        </div>
      </header>

      {/* Notice banner */}
      {state.notice && <NoticeBanner notice={state.notice} />}

      {/* Single Undo bar for extension paints and destructive panel setting changes */}
      {state.undo && !showAbout && isWorkingMode && (
        <div className="zd-undo-bar" data-testid="undo-bar" role="region" aria-label="Undo">
          <button
            type="button"
            className="zd-btn zd-btn--sm zd-undo-btn"
            data-testid="undo-btn"
            data-undo-kind={state.undo.kind}
            disabled={state.undo.kind === 'paint' && Boolean(state.autoPaint?.busy)}
            title={`${state.undo.label} (Ctrl+Z / ⌘Z)`}
            onClick={() => dispatch({ type: 'undo' })}
          >
            <span aria-hidden="true">↶</span>
            <span className="zd-undo-btn__label">
              {/^undo\b/i.test(state.undo.label) ? state.undo.label : `Undo: ${state.undo.label}`}
            </span>
          </button>
        </div>
      )}

      {/* Main view router */}
      {showAbout ? (
        <main className="zd-body">
          <AboutView onClose={() => setShowAbout(false)} />
        </main>
      ) : !isWorkingMode ? (
        <main className="zd-body">
          <ConnectionView state={state} dispatch={dispatch} />
          {state.connection === 'data-mismatch' && state.districts.length > 0 && (
            <DistrictPicker state={state} dispatch={dispatch} readOnly />
          )}
        </main>
      ) : state.walkthrough ? (
        <WalkthroughView state={state} dispatch={dispatch} renderMiniMap={renderMiniMap} />
      ) : (
        <main className="zd-body">
          {state.connection === 'csv' && (
            <CsvDropZone
              compact
              title={state.map?.sourceName ? 'CSV:' : 'CSV mode (live ticking off)'}
              fileName={state.map?.sourceName}
              hint="Live ticking off. Drop a new DRA CSV to reload."
              onLoadCsv={(text, fileName) => dispatch({ type: 'load-csv', text, fileName })}
              secondaryAction={{
                label: 'Back to live tab',
                testId: 'back-to-live-btn',
                onClick: () => dispatch({ type: 'retry-connection' }),
              }}
            />
          )}

          <ScopeHeader state={state} dispatch={dispatch} />

          <DistrictPicker state={state} dispatch={dispatch} />

          {state.interaction && state.interaction.nodes.length > 0 && (
            <InteractionView
              interaction={state.interaction}
              districts={state.districts}
              map={state.map}
              mapMode={state.mapMode}
              activeFlows={activePlanCard?.borderFlows}
              activePlanTitle={activePlanTitle}
              dispatch={dispatch}
            />
          )}

          {showOutsideMiniMap && (
            <MiniMapSlot
              renderMiniMap={renderMiniMap}
              caption="Mini-map preview"
              subCaption={miniMapSubCaption}
              placeholderTitle="Mini-map preview active"
              placeholderText={miniMapSubCaption}
            />
          )}

          {state.scope.mode === 'one' && <NeighborChooser state={state} dispatch={dispatch} />}

          {/* Where the user would like the swap to happen: applies to every scope, so it sits just above Solve. */}
          <AreaControl state={state} dispatch={dispatch} />

          {/* County clusters (collapsed until opened); any cluster can become the area above. */}
          <ClustersView state={state} dispatch={dispatch} />

          <SolveSection state={state} dispatch={dispatch} />

          {state.solutions.length > 0 && (
            <section className="zd-solutions-list" aria-label="Balancing solutions">
              <div className="zd-section-head">
                <h3 className="zd-section-title">
                  {state.scope.mode === 'one'
                    ? state.scope.goal !== undefined
                      ? `Options for ${formatSigned(state.scope.goal)}`
                      : 'Zeroing options'
                    : 'Balancing plans'} (
                  {state.solutions.length})
                </h3>
              </div>

              {state.solutions.map((card, index) => (
                <SolutionCard
                  key={card.id}
                  card={card}
                  rankIndex={index}
                  badges={badges.get(card.id)}
                  districts={state.districts}
                  map={state.map}
                  isHovered={state.hoveredSolutionId === card.id}
                  dispatch={dispatch}
                />
              ))}
            </section>
          )}
        </main>
      )}
    </div>
  );
}
