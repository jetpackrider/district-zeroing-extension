import type { PanelAction, PanelState } from '@zd/contracts';
import { formatElapsed } from '../format';

interface SolveSectionProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
}

export function SolveSection({ state, dispatch }: SolveSectionProps) {
  const { solve, scope, solutions, connection } = state;
  const isBusy = solve.status === 'loading-data' || solve.status === 'solving';
  const emptyGroup = scope.mode === 'group' && scope.districts.length === 0;
  const solveBlocked =
    isBusy || emptyGroup || connection === 'data-mismatch' || connection === 'unsupported-map';

  const buttonLabel =
    scope.mode === 'one'
      ? solutions.length > 0
        ? 'Re-solve district'
        : 'Find zeroing options'
      : solutions.length > 0
        ? 'Re-solve plans'
        : 'Find balancing plans';

  const pct =
    solve.progress !== undefined
      ? Math.max(0, Math.min(100, Math.round(solve.progress * 100)))
      : null;

  return (
    <section aria-label="Solver controls and status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="zd-solve-btn-row">
        <button
          type="button"
          className="zd-btn zd-btn--primary zd-btn--full"
          disabled={solveBlocked}
          onClick={() => dispatch({ type: 'solve' })}
        >
          {isBusy ? (solve.status === 'loading-data' ? 'Loading state data…' : 'Solving…') : buttonLabel}
        </button>
        {isBusy && (
          <button
            type="button"
            className="zd-btn zd-solve-cancel-btn"
            data-testid="cancel-solve-btn"
            onClick={() => dispatch({ type: 'cancel-solve' })}
          >
            Cancel
          </button>
        )}
      </div>

      {(solve.status === 'loading-data' || solve.status === 'solving') && (
        <div className="zd-card zd-solve-status" role="status" aria-live="polite">
          <div className="zd-solve-status__row">
            <span>
              {solve.message ??
                (solve.status === 'loading-data'
                  ? 'Downloading state block graph…'
                  : 'Searching border moves…')}
            </span>
            {pct !== null && <span className="zd-num" style={{ fontWeight: 650 }}>{pct}%</span>}
          </div>
          <div
            className="zd-progress-track"
            role="progressbar"
            aria-valuenow={pct ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`zd-progress-fill${pct === null ? ' zd-progress-fill--indeterminate' : ''}`}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
        </div>
      )}

      {solve.status === 'done' && (
        <div
          className={solutions.length === 0 ? 'zd-callout zd-callout--ok' : 'zd-solve-status__row'}
          role="status"
          style={solutions.length > 0 ? { fontSize: 11.5, color: 'var(--zd-text-muted)', padding: '0 2px' } : undefined}
        >
          {solutions.length === 0 ? (
            <>
              <p className="zd-callout__title">✓ Already at zero deviation</p>
              <p className="zd-callout__text">
                {solve.message ?? 'Every selected district is already within target (0 or ±1).'}
              </p>
            </>
          ) : (
            <>
              <span className="zd-num">
                {solutions.length}{' '}
                {scope.mode === 'one'
                  ? solutions.length === 1
                    ? 'option'
                    : 'options'
                  : solutions.length === 1
                    ? 'plan'
                    : 'plans'}{' '}
                ready · hover to preview, click to start walkthrough
              </span>
              {solve.elapsedMs !== undefined && (
                <span className="zd-num" style={{ whiteSpace: 'nowrap', flex: 'none' }}>
                  {formatElapsed(solve.elapsedMs)}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {solve.status === 'needs-precinct-rework' && (
        <div className="zd-callout zd-callout--warn" role="alert">
          <p className="zd-callout__title">Needs precinct-level rework</p>
          <p className="zd-callout__text">
            {solve.message ??
              'This deviation is too large to close along the current block border without cutting a district. Move whole precincts in DRA first, then solve again.'}
          </p>
        </div>
      )}

      {solve.status === 'group-unbalanced' && (
        <div className="zd-callout zd-callout--warn" role="alert">
          <p className="zd-callout__title">Group cannot balance on its own</p>
          <p className="zd-callout__text">
            {solve.message ??
              'The selected districts have too much net excess or deficit to zero internally. Add one of the suggested neighboring districts above, or allow outside neighbors to absorb.'}
          </p>
        </div>
      )}

      {solve.status === 'error' && (
        <div className="zd-callout zd-callout--error" role="alert">
          <p className="zd-callout__title">Solver error</p>
          <p className="zd-callout__text">
            {solve.message ?? 'Could not compute balancing moves. Try again.'}
          </p>
          <div style={{ marginTop: 4 }}>
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={() => dispatch({ type: 'solve' })}
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
