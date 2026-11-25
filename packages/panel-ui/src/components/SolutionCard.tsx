import { useMemo, useState } from 'react';
import type { DistrictRow, MapInfo, PanelAction, SolutionCard as SolutionCardData } from '@zd/contracts';
import { groupBorderTrades } from '../flows';
import {
  formatBlocks,
  formatCompactness,
  formatDistrictName,
  formatDistrictShort,
  formatInt,
  formatPeople,
  formatSigned,
  formatSolutionTitle,
  formatSteps,
  getDeviationTone,
  getDistrictColor,
  isUnassigned,
  unassignedNet,
} from '../format';

interface SolutionCardProps {
  card: SolutionCardData;
  rankIndex: number;
  /** What this card is best at among its siblings (see solutionBadges). */
  badges?: string[];
  districts: DistrictRow[];
  map?: MapInfo;
  isHovered: boolean;
  dispatch: (action: PanelAction) => void;
}

const PREVIEW_LIMIT = 6;

export function SolutionCard({
  card,
  rankIndex,
  badges,
  districts,
  map,
  isHovered,
  dispatch,
}: SolutionCardProps) {
  const [showAllFlows, setShowAllFlows] = useState(false);
  const [showAllDevs, setShowAllDevs] = useState(false);

  const trades = useMemo(() => groupBorderTrades(card.borderFlows), [card.borderFlows]);
  const hasTwoWay = trades.some((t) => t.kind === 'two-way');
  const isPlan = card.kind !== 'single' || trades.length > 1 || hasTwoWay;
  const title = formatSolutionTitle(card.kind, rankIndex);
  const compactness = formatCompactness(card.stats.perimeterDeltaM);

  // Unassigned (district 0) has no deviation; it is never listed among the deviations.
  const deviations = useMemo(() => card.deviations.filter((d) => !isUnassigned(d.district)), [card.deviations]);
  const unassigned = useMemo(() => unassignedNet(card), [card]);
  const visibleTrades = showAllFlows ? trades : trades.slice(0, PREVIEW_LIMIT);
  const visibleDevs = showAllDevs ? deviations : deviations.slice(0, PREVIEW_LIMIT);

  const winsSplits = Boolean(badges?.includes('Fewest new splits'));
  const winsBlocks = Boolean(badges?.includes('Fewest blocks'));
  const winsDistricts = Boolean(badges?.includes('Fewest districts'));
  const winsSteps = Boolean(badges?.includes('Fewest steps'));
  const steps = card.stats.steps;
  const hasSteps = typeof steps === 'number';
  const hasTowns = card.stats.newTownSplits !== undefined;
  // People, blocks, precinct splits, county splits, compactness, then the optional ones.
  const statCount = 5 + (hasSteps ? 1 : 0) + (hasTowns ? 1 : 0) + (isPlan ? 1 : 0);
  // With an area (AreaPreference) the solver counts the moved blocks outside it; absent = no area.
  const outsideArea = card.stats.outsideArea;
  const insideArea = outsideArea === 0;

  const startWalkthrough = () => {
    dispatch({ type: 'start-walkthrough', solutionId: card.id });
  };

  return (
    <div
      className={`zd-card zd-solution-card${isHovered ? ' zd-solution-card--hovered' : ''}`}
      role="button"
      tabIndex={0}
      data-testid={`solution-card-${card.id}`}
      onMouseEnter={() => dispatch({ type: 'hover-solution', id: card.id })}
      onMouseLeave={() => dispatch({ type: 'hover-solution', id: null })}
      onFocus={() => dispatch({ type: 'hover-solution', id: card.id })}
      onBlur={() => dispatch({ type: 'hover-solution', id: null })}
      onClick={startWalkthrough}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          startWalkthrough();
        }
      }}
    >
      <div className="zd-solution-card__head">
        <div className="zd-solution-card__head-main">
          <span className="zd-solution-card__title">{title}</span>
          {((badges && badges.length > 0) || insideArea) && (
            <div className="zd-solution-card__badges" aria-label="Plan highlights">
              {badges?.map((label) => (
                <span key={label} className="zd-pill zd-pill--zero">
                  {label}
                </span>
              ))}
              {insideArea && (
                <span
                  className="zd-pill zd-pill--accent"
                  data-testid={`inside-area-${card.id}`}
                >
                  Inside your area
                </span>
              )}
            </div>
          )}
        </div>
        <span className="zd-solution-card__cta">
          {hasSteps && (
            <span className="zd-solution-card__cta-steps" data-testid={`cta-steps-${card.id}`}>
              {formatSteps(steps)} ·{' '}
            </span>
          )}
          Walkthrough →
        </span>
      </div>

      {outsideArea !== undefined && outsideArea > 0 && (
        <div className="zd-note zd-note--warn" data-testid={`outside-area-${card.id}`}>
          Moves {formatBlocks(outsideArea)} outside your area.
        </div>
      )}

      {card.stats.usesWater && (
        <div className="zd-note zd-note--warn" data-testid={`uses-water-${card.id}`}>
          Crosses water: no way to do this over land alone was found.
        </div>
      )}

      {card.stats.longReach && (
        <div className="zd-note zd-note--warn" data-testid={`long-reach-${card.id}`}>
          Long reach: no compact bite out of the border hits the number, so this one reaches further
          in, through a chain of blocks.
        </div>
      )}

      {unassigned.traded && (
        <div className="zd-note zd-note--info" data-testid={`unassigned-${card.id}`}>
          {unassigned.net > 0
            ? `Leaves ${formatInt(unassigned.net)} more ${unassigned.net === 1 ? 'person' : 'people'} unassigned.`
            : unassigned.net < 0
              ? `Takes ${formatPeople(unassigned.net)} from unassigned blocks.`
              : 'Swaps blocks with Unassigned; as many people are unassigned as before.'}
        </div>
      )}

      {/* Primary stats grid */}
      <div
        className={`zd-stats-grid${isPlan ? ' zd-stats-grid--plan' : ''}${statCount % 2 === 1 ? ' zd-stats-grid--odd' : ''}`}
      >
        <div className="zd-stat">
          <span className="zd-stat__label">People moved</span>
          <span className="zd-stat__val zd-num">{formatInt(card.stats.people)}</span>
        </div>

        {hasSteps && (
          <div className={`zd-stat${winsSteps ? ' zd-stat--win' : ''}`} data-testid={`steps-${card.id}`}>
            <span className="zd-stat__label">Steps to paint</span>
            <span className="zd-stat__val zd-num">{formatInt(steps)}</span>
            <span className="zd-stat__sub">one per precinct</span>
          </div>
        )}

        <div className={`zd-stat${winsBlocks ? ' zd-stat--win' : ''}`}>
          <span className="zd-stat__label">Blocks moved</span>
          <span className="zd-stat__val zd-num">{formatInt(card.stats.blocks)}</span>
          {card.stats.populatedBlocks !== card.stats.blocks && (
            <span className="zd-stat__sub zd-num">{formatInt(card.stats.populatedBlocks)} pop.</span>
          )}
        </div>

        <div className={`zd-stat${winsSplits ? ' zd-stat--win' : ''}`}>
          <span className="zd-stat__label">Precinct splits</span>
          <span className="zd-stat__val zd-num">
            {card.stats.newPrecinctSplits > 0 ? `+${card.stats.newPrecinctSplits}` : '0'}
          </span>
          {card.stats.healedPrecinctSplits > 0 && (
            <span className="zd-stat__sub zd-num zd-stat__val--better">
              −{card.stats.healedPrecinctSplits} healed
            </span>
          )}
        </div>

        <div className={`zd-stat${winsSplits ? ' zd-stat--win' : ''}`}>
          <span className="zd-stat__label">County splits</span>
          <span className="zd-stat__val zd-num">
            {card.stats.newCountySplits > 0 ? `+${card.stats.newCountySplits}` : '0'}
          </span>
        </div>

        {card.stats.newTownSplits !== undefined && (
          <div className="zd-stat" data-testid={`town-splits-${card.id}`}>
            <span className="zd-stat__label">Town splits</span>
            <span className="zd-stat__val zd-num">
              {card.stats.newTownSplits > 0 ? `+${card.stats.newTownSplits}` : '0'}
            </span>
          </div>
        )}

        <div className="zd-stat">
          <span className="zd-stat__label">Compactness</span>
          <span
            className={`zd-stat__val zd-num${
              compactness.tone === 'better'
                ? ' zd-stat__val--better'
                : compactness.tone === 'worse'
                  ? ' zd-stat__val--worse'
                  : ''
            }`}
          >
            {compactness.value}
          </span>
          <span className="zd-stat__sub">{compactness.label}</span>
        </div>

        {isPlan && (
          <div className={`zd-stat${winsDistricts ? ' zd-stat--win' : ''}`}>
            <span className="zd-stat__label">Districts touched</span>
            <span className="zd-stat__val zd-num">{formatInt(card.stats.districtsTouched)}</span>
          </div>
        )}
      </div>

      {/* Multi-border plan flows (two-way borders collapsed into one trade) */}
      {isPlan && trades.length > 0 && (
        <div className="zd-stack">
          <div className="zd-flows-list" aria-label="Border transfers">
            {visibleTrades.map((trade) => {
              if (trade.kind === 'two-way') {
                const firstFromColor = getDistrictColor(trade.first.from, districts);
                const firstToColor = getDistrictColor(trade.first.to, districts);
                const firstFromShort = formatDistrictShort(trade.first.from, districts);
                const firstToShort = formatDistrictShort(trade.first.to, districts);
                const netFromShort = formatDistrictShort(trade.netFrom, districts);
                const netToShort = formatDistrictShort(trade.netTo, districts);
                return (
                  <span
                    key={trade.key}
                    className="zd-pill zd-pill--twoway zd-num zd-flow-trade"
                    data-testid={`flow-twoway-${trade.a}-${trade.b}`}
                  >
                    <span className="zd-pill zd-flow-pill__tag">2-way</span>
                    <span className="zd-flow-pill__pair">
                      {firstFromColor && (
                        <span
                          className="zd-swatch"
                          style={{ backgroundColor: firstFromColor }}
                          aria-hidden="true"
                        />
                      )}
                      <span>{firstFromShort}</span>
                      <span aria-hidden="true">⇄</span>
                      {firstToColor && (
                        <span
                          className="zd-swatch"
                          style={{ backgroundColor: firstToColor }}
                          aria-hidden="true"
                        />
                      )}
                      <span>{firstToShort}:</span>
                    </span>
                    <span className="zd-flow-pill__legs">
                      {firstFromShort}→{firstToShort} <strong>{formatInt(trade.first.people)}</strong>,{' '}
                      {firstToShort}→{firstFromShort} <strong>{formatInt(trade.second.people)}</strong>
                    </span>
                    <span className="zd-flow-pill__net">
                      (net {trade.netPeople > 0 ? `${netFromShort}→${netToShort} ` : ''}
                      <strong>{formatInt(trade.netPeople)}</strong>)
                    </span>
                  </span>
                );
              }

              const fromColor = getDistrictColor(trade.from, districts);
              const toColor = getDistrictColor(trade.to, districts);
              return (
                <span key={trade.key} className="zd-pill zd-pill--neutral zd-num">
                  {fromColor && (
                    <span className="zd-swatch" style={{ backgroundColor: fromColor }} aria-hidden="true" />
                  )}
                  <span>{formatDistrictShort(trade.from, districts)}</span>
                  <span aria-hidden="true">→</span>
                  {toColor && (
                    <span className="zd-swatch" style={{ backgroundColor: toColor }} aria-hidden="true" />
                  )}
                  <span>{formatDistrictShort(trade.to, districts)}:</span>
                  <strong>{formatInt(trade.people)}</strong>
                </span>
              );
            })}
          </div>
          {trades.length > PREVIEW_LIMIT && (
            <button
              type="button"
              className="zd-btn zd-btn--ghost zd-btn--sm zd-expand-link"
              onClick={(e) => {
                e.stopPropagation();
                setShowAllFlows((v) => !v);
              }}
            >
              {showAllFlows
                ? 'Show fewer transfers'
                : `Show all ${trades.length} border transfers`}
            </button>
          )}
        </div>
      )}

      {/* Before → after deviations */}
      {deviations.length > 0 && (
        <div className="zd-stack">
          <div className="zd-dev-changes" aria-label="District deviations before and after">
            {visibleDevs.map((dev) => {
              const swatch = getDistrictColor(dev.district, districts);
              const afterTone = getDeviationTone(dev.after, map);
              return (
                <div key={dev.district} className="zd-dev-change">
                  <span className="zd-dev-change__name">
                    {swatch && (
                      <span className="zd-swatch" style={{ backgroundColor: swatch }} aria-hidden="true" />
                    )}
                    <span>{formatDistrictName(dev.district, districts)}:</span>
                  </span>
                  <span className="zd-dev-change__vals">
                    <span className="zd-muted">{formatSigned(dev.before)}</span>
                    <span aria-hidden="true">→</span>
                    <span className={`zd-pill zd-num zd-pill--inline zd-pill--${afterTone}`}>
                      {formatSigned(dev.after)}
                      {afterTone === 'zero' ? ' ✓' : ''}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          {deviations.length > PREVIEW_LIMIT && (
            <button
              type="button"
              className="zd-btn zd-btn--ghost zd-btn--sm zd-expand-link"
              onClick={(e) => {
                e.stopPropagation();
                setShowAllDevs((v) => !v);
              }}
            >
              {showAllDevs
                ? 'Show fewer districts'
                : `Show all ${deviations.length} affected districts`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
