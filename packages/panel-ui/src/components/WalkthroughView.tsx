import { useEffect, useMemo } from 'react';
import type { PanelAction, PanelState } from '@zd/contracts';
import type { MiniMapRenderer } from '../types';
import {
  analyzeWalkthroughTwoWayTrades,
  borderPairKey,
  buildWalkthroughOutline,
} from '../flows';
import type { WalkthroughBorderRun, WalkthroughTwoWayTrade } from '../flows';
import {
  formatDistrictName,
  formatDistrictShort,
  formatInt,
  formatShortGeoid,
  formatSigned,
  getDeviationTone,
  getDistrictColor,
  getSelectedDistrictIndexes,
  isDeviationZeroed,
} from '../format';
import { AutoPaintControls } from './AutoPaintControls';
import { MiniMapSlot } from './MiniMapSlot';

interface WalkthroughViewProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
  renderMiniMap?: MiniMapRenderer;
}

export function WalkthroughView({ state, dispatch, renderMiniMap }: WalkthroughViewProps) {
  const walkthrough = state.walkthrough;

  // Esc ends the walkthrough and clears highlights
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dispatch({ type: 'walkthrough-end' });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch]);

  const twoWayTrades = useMemo(
    () => (walkthrough ? analyzeWalkthroughTwoWayTrades(walkthrough.steps) : new Map<string, WalkthroughTwoWayTrade>()),
    [walkthrough],
  );

  const outlineGroups = useMemo(
    () => (walkthrough ? buildWalkthroughOutline(walkthrough.steps, twoWayTrades) : []),
    [walkthrough, twoWayTrades],
  );

  if (!walkthrough) return null;

  const { steps, current, strayEdits, finalCheck, liveTicking, mapMode } = walkthrough;
  const clampedIndex = Math.max(0, Math.min(current, Math.max(0, steps.length - 1)));
  const activeStep = steps[clampedIndex];
  const doneStepsCount = steps.filter((s) => s.status === 'done').length;
  const stepPct = steps.length > 0 ? Math.round((doneStepsCount / steps.length) * 100) : 100;
  const showMiniMap = mapMode === 'mini' || state.mapMode === 'mini';

  // Live deviation tracking for every selected district
  const selectedIndexes = getSelectedDistrictIndexes(state.scope, state.districts, state.lockedDistricts);
  const trackedDistricts = state.districts.filter((d) => selectedIndexes.includes(d.index));
  const zeroedTracked = trackedDistricts.filter((d) => isDeviationZeroed(d.deviation, state.map)).length;

  // Identify districts currently between legs of an incomplete two-way trade so live deviations
  // do not look alarming while Leg 2 is still pending.
  const midTradeByDistrict = new Map<number, WalkthroughTwoWayTrade>();
  const activeMidTrades: WalkthroughTwoWayTrade[] = [];
  for (const trade of twoWayTrades.values()) {
    if (trade.betweenLegs) {
      midTradeByDistrict.set(trade.leg1.from, trade);
      midTradeByDistrict.set(trade.leg1.to, trade);
      activeMidTrades.push(trade);
    }
  }

  const activeTwoWay = activeStep
    ? twoWayTrades.get(borderPairKey(activeStep.from, activeStep.to))
    : undefined;
  const activeLeg: 1 | 2 | null = activeTwoWay && activeStep
    ? activeStep.from === activeTwoWay.leg1.from && activeStep.to === activeTwoWay.leg1.to
      ? 1
      : 2
    : null;

  const activeStepTotalPeople = activeStep
    ? activeStep.blocks.reduce((sum, b) => sum + b.people, 0)
    : 0;
  const activeStepDoneBlocks = activeStep
    ? activeStep.blocks.filter((b) => b.done).length
    : 0;

  const toName = activeStep ? formatDistrictName(activeStep.to, state.districts) : '';
  const fromName = activeStep ? formatDistrictName(activeStep.from, state.districts) : '';
  const fromColor = activeStep ? getDistrictColor(activeStep.from, state.districts) : undefined;
  const toColor = activeStep ? getDistrictColor(activeStep.to, state.districts) : undefined;

  const isLastStep = clampedIndex >= steps.length - 1;

  // Painting Leg 2 of a two-way trade before Leg 1 would break the border, so the button waits.
  const paintBlockedReason =
    activeTwoWay && activeLeg === 2 && !activeTwoWay.leg1.done
      ? `Paint Leg 1 first (Step ${activeTwoWay.leg1.steps[0].globalIndex + 1}); this is Leg 2 of a two-way trade.`
      : undefined;

  const renderStepButtons = (run: WalkthroughBorderRun) =>
    run.items.map(({ step, globalIndex }) => {
      const isCurrent = globalIndex === clampedIndex;
      const stepPop = step.blocks.reduce((s, b) => s + b.people, 0);
      const stepDoneBlocks = step.blocks.filter((b) => b.done).length;
      const icon =
        step.status === 'done'
          ? '✓'
          : step.status === 'awaiting-commit'
            ? '☑'
            : isCurrent || step.status === 'active'
              ? '●'
              : '○';
      const iconClass =
        step.status === 'done'
          ? 'zd-step-icon--done'
          : step.status === 'awaiting-commit'
            ? 'zd-step-icon--commit'
            : isCurrent || step.status === 'active'
              ? 'zd-step-icon--active'
              : '';

      return (
        <button
          key={step.id}
          type="button"
          className={[
            'zd-outline-step',
            isCurrent ? 'zd-outline-step--current' : '',
            step.status === 'done' ? 'zd-outline-step--done' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid={`outline-step-${globalIndex}`}
          aria-current={isCurrent ? 'step' : undefined}
          onClick={() => dispatch({ type: 'walkthrough-jump', index: globalIndex })}
        >
          <span className="zd-outline-step__left">
            <span className={`zd-step-icon ${iconClass}`} aria-hidden="true">
              {icon}
            </span>
            <span className="zd-outline-step__idx zd-num">{globalIndex + 1}.</span>
            <span className="zd-mono" style={{ fontSize: 11.5 }}>
              {step.precinctId}
            </span>
          </span>
          <span className="zd-num" style={{ fontSize: 11.5, color: 'var(--zd-text-secondary)' }}>
            {step.wholePrecinct
              ? `Whole precinct · ${formatInt(stepPop)}`
              : `${stepDoneBlocks}/${step.blocks.length} blks · ${formatInt(stepPop)}`}
          </span>
        </button>
      );
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div className="zd-body">
        {/* Header with live deviations for all selected districts */}
        <section className="zd-card zd-wt-header" aria-label="Walkthrough progress and live deviations">
          <div className="zd-wt-header__top">
            <div>
              <h2 className="zd-wt-title zd-num">
                Step {steps.length > 0 ? clampedIndex + 1 : 0} of {steps.length}
              </h2>
              <span className="zd-num" style={{ fontSize: 11.5, color: 'var(--zd-text-muted)' }}>
                {doneStepsCount} of {steps.length} precincts done ·{' '}
                {liveTicking
                  ? `${zeroedTracked}/${trackedDistricts.length} selected zeroed`
                  : 'live tracking off'}
              </span>
            </div>
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={() => dispatch({ type: 'walkthrough-end' })}
              aria-label="End walkthrough"
            >
              End <kbd className="zd-kbd">Esc</kbd>
            </button>
          </div>

          <div className="zd-progress-track" style={{ marginTop: 0 }}>
            <div className="zd-progress-fill" style={{ width: `${stepPct}%` }} />
          </div>

          {trackedDistricts.length > 0 && (
            <div className="zd-live-chips" aria-label="Live selected district deviations">
              {trackedDistricts.map((d) => {
                const tone = getDeviationTone(d.deviation, state.map);
                const midTrade = tone !== 'zero' ? midTradeByDistrict.get(d.index) : undefined;
                const isMidTrade = Boolean(midTrade);
                return (
                  <span
                    key={d.index}
                    className={[
                      'zd-live-chip',
                      tone === 'zero' ? 'zd-live-chip--zero' : '',
                      isMidTrade ? 'zd-live-chip--mid-trade' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-testid={`live-chip-${d.index}`}
                    data-mid-trade={isMidTrade ? 'true' : undefined}
                  >
                    {d.color && (
                      <span className="zd-swatch" style={{ backgroundColor: d.color }} aria-hidden="true" />
                    )}
                    <span>{formatDistrictShort(d.index, state.districts)}:</span>
                    <strong
                      className={`zd-dev zd-dev--inline ${
                        isMidTrade ? 'zd-dev--mid-trade' : `zd-dev--${tone}`
                      }`}
                    >
                      {formatSigned(d.deviation)}
                      {tone === 'zero' ? ' ✓' : ''}
                    </strong>
                    {midTrade && (
                      <span className="zd-live-chip__tag">
                        {midTrade.leg1DoneWaitingForLeg2 ? '⇄ leg 2 next' : '⇄ 2-way'}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {activeMidTrades.length > 0 && (
            <div className="zd-mid-trade-note" role="status" data-testid="mid-trade-status">
              {activeMidTrades.map((trade) => {
                const l1From = formatDistrictShort(trade.leg1.from, state.districts);
                const l1To = formatDistrictShort(trade.leg1.to, state.districts);
                const l2From = formatDistrictShort(trade.leg2.from, state.districts);
                const l2To = formatDistrictShort(trade.leg2.to, state.districts);
                return (
                  <span key={trade.key}>
                    {trade.leg1DoneWaitingForLeg2 ? (
                      <>
                        <strong>Between legs ({l1From} ⇄ {l1To}):</strong> Overshoot is expected
                        until Leg 2 ({l2From} → {l2To}: {formatInt(trade.leg2.people)}) finishes.
                      </>
                    ) : (
                      <>
                        <strong>Two-way trade ({l1From} ⇄ {l1To}):</strong> Deviations will
                        temporarily overshoot until Leg 2 ({l2From} → {l2To}) completes.
                      </>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </section>

        {/* Live ticking off notice (hidden once final check is shown) */}
        {!liveTicking && !finalCheck && (
          <div className="zd-callout zd-callout--info" role="status" data-testid="live-ticking-off">
            <p className="zd-callout__title">Live ticking is off</p>
            <p className="zd-callout__text">
              Block edits cannot be detected automatically in this mode. Paint the listed blocks in
              DRA, then use <strong>Next</strong> to advance by hand.
            </p>
          </div>
        )}

        {/* Stray edit warning */}
        {strayEdits.length > 0 && (
          <div className="zd-callout zd-callout--warn" role="alert" data-testid="stray-edits-banner">
            <p className="zd-callout__title">
              {strayEdits.length === 1
                ? '1 stray edit detected outside this plan'
                : `${strayEdits.length} stray edits detected outside this plan`}
            </p>
            <p className="zd-callout__text">
              Your DRA plan changed outside the highlighted blocks. You can undo in DRA or re-solve
              the remaining borders from your current map.
            </p>
            <ul className="zd-stray-list zd-mono">
              {strayEdits.slice(0, 4).map((edit, idx) => (
                <li key={`${edit.geoid}-${idx}`}>
                  {formatShortGeoid(edit.geoid)}:{' '}
                  {formatDistrictShort(edit.fromDistrict, state.districts)} →{' '}
                  {formatDistrictShort(edit.toDistrict, state.districts)}
                </li>
              ))}
              {strayEdits.length > 4 && <li>…and {strayEdits.length - 4} more</li>}
            </ul>
            <div>
              <button
                type="button"
                className="zd-btn zd-btn--sm zd-btn--warn"
                onClick={() => dispatch({ type: 'walkthrough-replan' })}
              >
                Re-plan from here
              </button>
            </div>
          </div>
        )}

        {/* Final check result (true = confirmed in DRA, null = CSV expected result, false = off target) */}
        {finalCheck && (
          <section
            className={`zd-callout ${
              finalCheck.ok === true
                ? 'zd-callout--ok'
                : finalCheck.ok === null
                  ? 'zd-callout--info'
                  : 'zd-callout--warn'
            }`}
            role="status"
            data-testid="final-check-card"
          >
            <p className="zd-callout__title">
              {finalCheck.ok === true
                ? '✓ Final check passed — confirmed against DRA'
                : finalCheck.ok === null
                  ? 'Steps finished — expected result (not verified in DRA)'
                  : 'Final check found remaining deviation'}
            </p>
            <p className="zd-callout__text">
              {finalCheck.ok === true
                ? 'All affected districts match the expected zero-deviation target in DRA.'
                : finalCheck.ok === null
                  ? 'Live checking is unavailable in CSV mode, so DRA was not re-read. Below is the plan’s expected outcome once every step is painted — check your district totals in DRA to confirm.'
                  : 'Re-read from DRA shows at least one district is still off target. Re-plan from here to finish.'}
            </p>
            {finalCheck.deviations.length > 0 && (
              <div className="zd-dev-changes" style={{ marginTop: 6 }}>
                {finalCheck.deviations.map((dev) => {
                  const swatch = getDistrictColor(dev.district, state.districts);
                  const afterTone = getDeviationTone(dev.after, state.map);
                  return (
                    <div key={dev.district} className="zd-dev-change">
                      <span className="zd-dev-change__name">
                        {swatch && (
                          <span className="zd-swatch" style={{ backgroundColor: swatch }} aria-hidden="true" />
                        )}
                        <span>{formatDistrictName(dev.district, state.districts)}:</span>
                      </span>
                      <span className="zd-dev-change__vals">
                        <span style={{ color: 'var(--zd-text-muted)' }}>
                          {formatSigned(dev.before)}
                        </span>
                        <span aria-hidden="true">→</span>
                        <span className={`zd-dev zd-dev--inline zd-dev--${afterTone}`}>
                          {formatSigned(dev.after)}
                          {afterTone === 'zero' && finalCheck.ok !== null ? ' ✓' : ''}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {finalCheck.ok === false && (
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="zd-btn zd-btn--sm zd-btn--warn"
                  onClick={() => dispatch({ type: 'walkthrough-replan' })}
                >
                  Re-plan from here
                </button>
              </div>
            )}
          </section>
        )}

        {/* Mini-map slot supplied by shell when mapMode === 'mini' */}
        {showMiniMap && (
          <MiniMapSlot
            renderMiniMap={renderMiniMap}
            placeholderTitle="Mini-map fallback active"
            placeholderText={`Locate precinct ${activeStep?.precinctId ?? '—'} in DRA and paint the numbered blocks.`}
          />
        )}

        {/* Two-way trade up-front guidance when the active step belongs to a two-way border */}
        {activeTwoWay && activeLeg && !finalCheck && (
          <div className="zd-callout zd-callout--twoway" role="status" data-testid="twoway-trade-notice">
            <p className="zd-callout__title">
              Two-way trade: {formatDistrictName(activeTwoWay.leg1.from, state.districts)} ⇄{' '}
              {formatDistrictName(activeTwoWay.leg1.to, state.districts)} · Leg {activeLeg} of 2
            </p>
            <p className="zd-callout__text zd-num">
              {formatDistrictShort(activeTwoWay.leg1.from, state.districts)} →{' '}
              {formatDistrictShort(activeTwoWay.leg1.to, state.districts)}:{' '}
              <strong>{formatInt(activeTwoWay.leg1.people)}</strong> people, then{' '}
              {formatDistrictShort(activeTwoWay.leg2.from, state.districts)} →{' '}
              {formatDistrictShort(activeTwoWay.leg2.to, state.districts)}:{' '}
              <strong>{formatInt(activeTwoWay.leg2.people)}</strong> people (net{' '}
              {activeTwoWay.netPeople > 0
                ? `${formatDistrictShort(activeTwoWay.netFrom, state.districts)} → ${formatDistrictShort(activeTwoWay.netTo, state.districts)}: `
                : ''}
              <strong>{formatInt(activeTwoWay.netPeople)}</strong>).
            </p>
            {activeLeg === 1 ? (
              <p className="zd-callout__text">
                The small net shift couldn&apos;t be moved one way here, so this border swaps blocks
                in both directions. <strong>Paint Leg 1 before Leg 2</strong> so the border stays
                contiguous and matches the Leg 2 blocks. Between the two legs, both districts will
                temporarily look further from zero until Leg 2 cancels the overshoot.
              </p>
            ) : activeTwoWay.leg1.done ? (
              <p className="zd-callout__text">
                Leg 1 is complete — painting Leg 2 ({formatDistrictShort(activeTwoWay.leg2.from, state.districts)} →{' '}
                {formatDistrictShort(activeTwoWay.leg2.to, state.districts)}) finishes the swap and
                brings both districts back on target.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <p className="zd-callout__text">
                  <strong>Order matters:</strong> Finish Leg 1 (
                  {formatDistrictShort(activeTwoWay.leg1.from, state.districts)} →{' '}
                  {formatDistrictShort(activeTwoWay.leg1.to, state.districts)}) before painting Leg
                  2 so the border stays contiguous.
                </p>
                <div>
                  <button
                    type="button"
                    className="zd-btn zd-btn--sm"
                    onClick={() =>
                      dispatch({
                        type: 'walkthrough-jump',
                        index: activeTwoWay.leg1.steps[0].globalIndex,
                      })
                    }
                  >
                    Go to Leg 1 (Step {activeTwoWay.leg1.steps[0].globalIndex + 1})
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Current Step Instruction Card */}
        {activeStep && (
          <section className="zd-card zd-step-card" aria-label="Current walkthrough step">
            <div className="zd-step-meta">
              <span className="zd-step-border">
                {fromColor && (
                  <span className="zd-swatch" style={{ backgroundColor: fromColor }} aria-hidden="true" />
                )}
                <span>{fromName}</span>
                <span aria-hidden="true">→</span>
                {toColor && (
                  <span className="zd-swatch" style={{ backgroundColor: toColor }} aria-hidden="true" />
                )}
                <span>{toName}</span>
                {activeLeg && (
                  <span className="zd-twoway-pill">Leg {activeLeg}/2</span>
                )}
              </span>
              <span className="zd-step-precinct" title={`Precinct ${activeStep.precinctId}`}>
                Precinct {activeStep.precinctId}
              </span>
            </div>

            <p className="zd-step-instruction" data-testid="step-instruction">
              {activeStep.wholePrecinct ? (
                <>
                  Step {clampedIndex + 1} of {steps.length}: with <strong>Precinct paint</strong> on,
                  paint the entire outlined precinct (<span className="zd-mono">{activeStep.precinctId}</span>)
                  into <strong>{toName}</strong> ({formatInt(activeStepTotalPeople)} people — no
                  shattering needed).
                </>
              ) : (
                <>
                  Step {clampedIndex + 1} of {steps.length}: with <strong>Block paint</strong> on,
                  click the outlined precinct to shatter it, then paint the{' '}
                  <strong>
                    {activeStep.blocks.length} highlighted{' '}
                    {activeStep.blocks.length === 1 ? 'block' : 'blocks'}
                  </strong>{' '}
                  into <strong>{toName}</strong>.
                </>
              )}
            </p>

            {activeStep.status === 'awaiting-commit' && (
              <div className="zd-callout zd-callout--ok" role="status" data-testid="commit-reminder">
                <p className="zd-callout__title">✓ Click DRA&apos;s checkmark to commit</p>
                <p className="zd-callout__text">
                  All blocks in this precinct are painted. Commit your shattered precinct in DRA
                  before moving to the next step.
                </p>
              </div>
            )}

            {state.autoPaint && (
              <AutoPaintControls
                autoPaint={state.autoPaint}
                step={activeStep}
                toName={toName}
                blockedReason={paintBlockedReason}
                dispatch={dispatch}
              />
            )}

            {/* Per-block ticks */}
            {activeStep.blocks.length > 0 && (
              <div>
                <div className="zd-section-head" style={{ marginBottom: 5 }}>
                  <span className="zd-section-title">
                    {activeStep.wholePrecinct ? 'Precinct blocks' : 'Blocks to paint'}
                  </span>
                  <span className="zd-num" style={{ fontSize: 11.5, color: 'var(--zd-text-muted)' }}>
                    {activeStepDoneBlocks}/{activeStep.blocks.length} done ·{' '}
                    {formatInt(activeStepTotalPeople)} people
                  </span>
                </div>

                <ul className="zd-block-list" aria-label="Blocks in current step">
                  {activeStep.blocks.map((block) => (
                    <li
                      key={block.geoid}
                      className={`zd-block-item${block.done ? ' zd-block-item--done' : ''}`}
                      data-testid={`walkthrough-block-${block.number}`}
                    >
                      <span className="zd-block-item__left">
                        <span className="zd-block-num" aria-label={`Block number ${block.number}`}>
                          {block.done ? '✓' : block.number}
                        </span>
                        <span className="zd-block-geoid" title={block.geoid}>
                          {formatShortGeoid(block.geoid)}
                        </span>
                      </span>
                      <span className="zd-block-right">
                        <span>{formatInt(block.people)} pop</span>
                        <span className="zd-block-status">{block.done ? 'Done' : 'To paint'}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Steps grouped by border, then precinct — clickable to jump */}
        <section className="zd-outline" aria-label="All walkthrough steps by border">
          <div className="zd-section-head" style={{ marginBottom: 0, paddingLeft: 2 }}>
            <h3 className="zd-section-title">
              Steps by border ({outlineGroups.length}{' '}
              {outlineGroups.length === 1 ? 'border' : 'borders'})
            </h3>
            <span style={{ fontSize: 11, color: 'var(--zd-text-muted)', whiteSpace: 'nowrap' }}>
              Click to jump
            </span>
          </div>

          {outlineGroups.map((group) => {
            if (group.kind === 'paired-two-way') {
              const { trade, leg1Run, leg2Run } = group;
              const l1FromColor = getDistrictColor(trade.leg1.from, state.districts);
              const l1ToColor = getDistrictColor(trade.leg1.to, state.districts);
              const totalSteps = leg1Run.items.length + leg2Run.items.length;
              const totalDone =
                leg1Run.items.filter((i) => i.step.status === 'done').length +
                leg2Run.items.filter((i) => i.step.status === 'done').length;

              return (
                <div
                  key={group.key}
                  className="zd-border-group zd-border-group--twoway"
                  data-testid={`outline-twoway-${trade.a}-${trade.b}`}
                >
                  <div className="zd-border-group__head zd-border-group__head--twoway">
                    <span className="zd-step-border">
                      {l1FromColor && (
                        <span className="zd-swatch" style={{ backgroundColor: l1FromColor }} aria-hidden="true" />
                      )}
                      <span>{formatDistrictName(trade.leg1.from, state.districts)}</span>
                      <span aria-hidden="true">⇄</span>
                      {l1ToColor && (
                        <span className="zd-swatch" style={{ backgroundColor: l1ToColor }} aria-hidden="true" />
                      )}
                      <span>{formatDistrictName(trade.leg1.to, state.districts)}</span>
                      <span className="zd-twoway-pill">2-way</span>
                    </span>
                    <span className="zd-num" style={{ color: 'var(--zd-text-muted)', fontWeight: 500 }}>
                      net {formatInt(trade.netPeople)} · {totalDone}/{totalSteps}
                    </span>
                  </div>

                  <div className="zd-border-leg-head zd-num">
                    <span>
                      Leg 1 (paint first): {formatDistrictShort(trade.leg1.from, state.districts)} →{' '}
                      {formatDistrictShort(trade.leg1.to, state.districts)}
                    </span>
                    <span>{formatInt(trade.leg1.people)} people</span>
                  </div>
                  {renderStepButtons(leg1Run)}

                  <div className="zd-border-leg-head zd-num">
                    <span>
                      Leg 2 (paint second): {formatDistrictShort(trade.leg2.from, state.districts)} →{' '}
                      {formatDistrictShort(trade.leg2.to, state.districts)}
                    </span>
                    <span>{formatInt(trade.leg2.people)} people</span>
                  </div>
                  {renderStepButtons(leg2Run)}
                </div>
              );
            }

            const { run } = group;
            const gFromColor = getDistrictColor(run.from, state.districts);
            const gToColor = getDistrictColor(run.to, state.districts);
            const groupDone = run.items.filter((i) => i.step.status === 'done').length;
            return (
              <div
                key={group.key}
                className={`zd-border-group${run.twoWay ? ' zd-border-group--twoway' : ''}`}
              >
                <div className="zd-border-group__head">
                  <span className="zd-step-border">
                    {gFromColor && (
                      <span className="zd-swatch" style={{ backgroundColor: gFromColor }} aria-hidden="true" />
                    )}
                    <span>{formatDistrictName(run.from, state.districts)}</span>
                    <span aria-hidden="true">→</span>
                    {gToColor && (
                      <span className="zd-swatch" style={{ backgroundColor: gToColor }} aria-hidden="true" />
                    )}
                    <span>{formatDistrictName(run.to, state.districts)}</span>
                    {run.twoWay && (
                      <span className="zd-twoway-pill">
                        2-way · Leg {run.twoWay.leg}/2
                      </span>
                    )}
                  </span>
                  <span className="zd-num" style={{ color: 'var(--zd-text-muted)', fontWeight: 500 }}>
                    {groupDone}/{run.items.length}
                  </span>
                </div>

                {renderStepButtons(run)}
              </div>
            );
          })}
        </section>
      </div>

      {/* Sticky walkthrough navigation bar */}
      <footer className="zd-wt-footer" aria-label="Walkthrough controls">
        <div className="zd-wt-controls">
          <button
            type="button"
            className="zd-btn"
            disabled={clampedIndex <= 0}
            onClick={() => dispatch({ type: 'walkthrough-back' })}
          >
            ← Back
          </button>

          <button
            type="button"
            className="zd-btn"
            onClick={() => dispatch({ type: 'walkthrough-zoom' })}
          >
            Zoom to step
          </button>

          {finalCheck ? (
            <button
              type="button"
              className="zd-btn zd-btn--primary"
              onClick={() => dispatch({ type: 'walkthrough-end' })}
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              className="zd-btn zd-btn--primary"
              onClick={() => dispatch({ type: 'walkthrough-next' })}
            >
              {isLastStep ? 'Finish' : 'Next →'}
            </button>
          )}
        </div>

        {strayEdits.length === 0 && (
          <button
            type="button"
            className="zd-btn zd-btn--ghost zd-btn--sm"
            style={{ alignSelf: 'center' }}
            onClick={() => dispatch({ type: 'walkthrough-replan' })}
          >
            Re-plan from here
          </button>
        )}
      </footer>
    </div>
  );
}
