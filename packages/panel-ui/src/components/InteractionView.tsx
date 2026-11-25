import { useId, useMemo, useState } from 'react';
import type { DistrictRow, InteractionGraph, MapInfo, PanelAction } from '@zd/contracts';
import { borderPairKey, groupBorderTrades } from '../flows';
import type { BorderTrade } from '../flows';
import {
  formatDistrictName,
  formatDistrictShort,
  formatInt,
  formatSigned,
  getDeviationTone,
  getDistrictColor,
} from '../format';
import { computeGraphLayout } from '../layout/graphLayout';

interface InteractionViewProps {
  interaction: InteractionGraph;
  districts: DistrictRow[];
  map?: MapInfo;
  mapMode?: 'dra' | 'mini';
  activeFlows?: Array<{ from: number; to: number; people: number }>;
  activePlanTitle?: string;
  dispatch: (action: PanelAction) => void;
}

export function InteractionView({
  interaction,
  districts,
  map,
  mapMode,
  activeFlows,
  activePlanTitle,
  dispatch,
}: InteractionViewProps) {
  const markerId = useId();
  const twoWayMarkerId = useId();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const layout = useMemo(() => computeGraphLayout(interaction, 360), [interaction]);

  const nodeMap = useMemo(() => {
    const m = new Map<number, (typeof layout.nodes)[number]>();
    for (const n of layout.nodes) m.set(n.district, n);
    return m;
  }, [layout.nodes]);

  const trades = useMemo(() => groupBorderTrades(activeFlows ?? []), [activeFlows]);

  const tradeByEdge = useMemo(() => {
    const m = new Map<string, BorderTrade>();
    for (const trade of trades) {
      m.set(trade.key, trade);
    }
    return m;
  }, [trades]);

  const hoveredEdge = useMemo(
    () => (hoveredKey ? layout.edges.find((e) => borderPairKey(e.a, e.b) === hoveredKey) ?? null : null),
    [layout.edges, hoveredKey],
  );
  const hoveredTrade = hoveredKey ? tradeByEdge.get(hoveredKey) : undefined;

  if (layout.nodes.length === 0) return null;

  const dense = layout.nodes.length > 10;
  const hasFlows = trades.length > 0;
  const hasTwoWayTrades = trades.some((t) => t.kind === 'two-way');

  return (
    <section className="zd-card" aria-label="District interaction schematic">
      <div className="zd-section-head">
        <h3 className="zd-section-title">
          Interaction view ({layout.nodes.length} {layout.nodes.length === 1 ? 'district' : 'districts'})
        </h3>
        {activePlanTitle && (
          <span
            className="zd-num zd-interaction__plan"
          >
            Arrows: {activePlanTitle}
          </span>
        )}
      </div>

      <div className="zd-interaction__wrap">
        <svg
          className="zd-interaction__svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`Schematic of ${layout.nodes.length} selected districts and ${layout.edges.length} shared borders`}
          data-testid="interaction-svg"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="6.5"
              markerHeight="6.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.2 L 9 5 L 0 8.8 z" fill="var(--zd-accent)" />
            </marker>
            <marker
              id={twoWayMarkerId}
              viewBox="0 0 10 10"
              refX="8.2"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8.8 5 L 0 8.5 z" fill="var(--zd-twoway)" />
            </marker>
          </defs>

          {/* Shared border edges */}
          {layout.edges.map((edge) => {
            const key = borderPairKey(edge.a, edge.b);
            const isHovered = hoveredKey === key;
            const hasFlowHere = tradeByEdge.has(key);

            const mx = (edge.x1 + edge.x2) / 2;
            const my = (edge.y1 + edge.y2) / 2;
            const maxCheap = Math.max(edge.cheapAtoB, edge.cheapBtoA);
            const cheapLabel =
              layout.nodes.length <= 6 && edge.cheapAtoB !== edge.cheapBtoA
                ? `${formatInt(edge.cheapAtoB)}/${formatInt(edge.cheapBtoA)}`
                : formatInt(maxCheap);

            const showCheapPill = (!dense || isHovered) && !hasFlowHere;

            return (
              <g
                key={key}
                data-testid={`border-edge-${edge.a}-${edge.b}`}
                tabIndex={0}
                role="button"
                aria-label={`Shared border between ${formatDistrictName(edge.a, districts)} and ${formatDistrictName(edge.b, districts)}: cheap capacity ${formatInt(edge.cheapAtoB)} and ${formatInt(edge.cheapBtoA)}`}
                className="zd-interaction__edge"
                onMouseEnter={() => {
                  setHoveredKey(key);
                  dispatch({ type: 'hover-border', a: edge.a, b: edge.b });
                }}
                onMouseLeave={() => {
                  setHoveredKey((prev) => (prev === key ? null : prev));
                  dispatch({ type: 'hover-border', a: null, b: null });
                }}
                onFocus={() => {
                  setHoveredKey(key);
                  dispatch({ type: 'hover-border', a: edge.a, b: edge.b });
                }}
                onBlur={() => {
                  setHoveredKey((prev) => (prev === key ? null : prev));
                  dispatch({ type: 'hover-border', a: null, b: null });
                }}
              >
                {/* Wide invisible hit target for easy hovering */}
                <line
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke="transparent"
                  strokeWidth={14}
                />
                {/* Visible border line */}
                <line
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke={isHovered ? 'var(--zd-accent)' : 'var(--zd-border-strong)'}
                  strokeWidth={isHovered ? 2.6 : hasFlows && !hasFlowHere ? 1 : 1.5}
                  strokeOpacity={hasFlows && !hasFlowHere && !isHovered ? 0.42 : 0.9}
                  strokeDasharray={maxCheap === 0 ? '3 3' : undefined}
                />

                {showCheapPill && (
                  <g pointerEvents="none">
                    <rect
                      x={mx - Math.max(16, cheapLabel.length * 3.4 + 6)}
                      y={my - 8}
                      width={Math.max(32, cheapLabel.length * 6.8 + 12)}
                      height={16}
                      rx={4}
                      fill={isHovered ? 'var(--zd-accent-soft)' : 'var(--zd-surface)'}
                      stroke={isHovered ? 'var(--zd-accent)' : 'var(--zd-border)'}
                      strokeWidth={1}
                    />
                    <text
                      x={mx}
                      y={my + 3.5}
                      textAnchor="middle"
                      fontSize="var(--zd-text-xs)"
                      fontWeight="var(--zd-weight-medium)"
                      fill={isHovered ? 'var(--zd-accent)' : 'var(--zd-text-secondary)'}
                      className="zd-num"
                    >
                      {cheapLabel}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Plan transfer arrows (one-way straight arrows; two-way trades as twin curved arcs + single pill) */}
          {trades.map((trade) => {
            const isHovered = hoveredKey === trade.key;

            if (trade.kind === 'two-way') {
              const fromNode = nodeMap.get(trade.first.from);
              const toNode = nodeMap.get(trade.first.to);
              if (!fromNode || !toNode) return null;

              const dx = toNode.x - fromNode.x;
              const dy = toNode.y - fromNode.y;
              const dist = Math.hypot(dx, dy);
              if (dist < 1) return null;

              const ux = dx / dist;
              const uy = dy / dist;
              // Perpendicular unit vector for separating the two curved arrows
              const nx = -uy;
              const ny = ux;
              const endOffset = dense ? 3.5 : 4.5;
              const curveOffset = Math.min(dense ? 11 : 16, Math.max(dense ? 7 : 10, dist * 0.16));

              const padStart = layout.nodeRadius + 1.5;
              const padEnd = layout.nodeRadius + 4.5;

              // Leg 1 arc: first.from -> first.to (offset +n)
              const s1x = fromNode.x + ux * padStart + nx * endOffset;
              const s1y = fromNode.y + uy * padStart + ny * endOffset;
              const e1x = toNode.x - ux * padEnd + nx * endOffset;
              const e1y = toNode.y - uy * padEnd + ny * endOffset;
              const c1x = (s1x + e1x) / 2 + nx * curveOffset;
              const c1y = (s1y + e1y) / 2 + ny * curveOffset;

              // Leg 2 arc: second.from (= first.to) -> second.to (= first.from) (offset -n)
              const s2x = toNode.x - ux * padStart - nx * endOffset;
              const s2y = toNode.y - uy * padStart - ny * endOffset;
              const e2x = fromNode.x + ux * padEnd - nx * endOffset;
              const e2y = fromNode.y + uy * padEnd - ny * endOffset;
              const c2x = (s2x + e2x) / 2 - nx * curveOffset;
              const c2y = (s2y + e2y) / 2 - ny * curveOffset;

              const mx = (fromNode.x + toNode.x) / 2;
              const my = (fromNode.y + toNode.y) / 2;

              const showFullPill = !dense || trades.length <= 12 || isHovered;
              const pillLabel = showFullPill
                ? dist >= 105 || isHovered
                  ? `${formatInt(trade.first.people)}⇄${formatInt(trade.second.people)} (${formatInt(trade.netPeople)})`
                  : `${formatInt(trade.first.people)}⇄${formatInt(trade.second.people)}`
                : '⇄';
              const pillW = showFullPill ? Math.max(36, pillLabel.length * 5.6 + 10) : 18;
              const pillH = showFullPill ? 16 : 14;

              return (
                <g
                  key={trade.key}
                  pointerEvents="none"
                  data-testid={`flow-twoway-${trade.a}-${trade.b}`}
                >
                  <path
                    d={`M ${s1x} ${s1y} Q ${c1x} ${c1y} ${e1x} ${e1y}`}
                    fill="none"
                    stroke="var(--zd-twoway)"
                    strokeWidth={dense ? 1.8 : 2.2}
                    markerEnd={`url(#${twoWayMarkerId})`}
                  />
                  <path
                    d={`M ${s2x} ${s2y} Q ${c2x} ${c2y} ${e2x} ${e2y}`}
                    fill="none"
                    stroke="var(--zd-twoway)"
                    strokeWidth={dense ? 1.8 : 2.2}
                    strokeDasharray="3.5 2"
                    markerEnd={`url(#${twoWayMarkerId})`}
                  />
                  <rect
                    x={mx - pillW / 2}
                    y={my - pillH / 2}
                    width={pillW}
                    height={pillH}
                    rx={pillH / 2}
                    fill="var(--zd-twoway)"
                  />
                  <text
                    x={mx}
                    y={my}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="var(--zd-text-xs)"
                    fontWeight="var(--zd-weight-bold)"
                    fill="var(--zd-twoway-text)"
                    className="zd-num"
                  >
                    {pillLabel}
                  </text>
                </g>
              );
            }

            const fromNode = nodeMap.get(trade.from);
            const toNode = nodeMap.get(trade.to);
            if (!fromNode || !toNode) return null;

            const dx = toNode.x - fromNode.x;
            const dy = toNode.y - fromNode.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 1) return null;

            const ux = dx / dist;
            const uy = dy / dist;
            const padStart = layout.nodeRadius + 2;
            const padEnd = layout.nodeRadius + 5;
            const sx = fromNode.x + ux * padStart;
            const sy = fromNode.y + uy * padStart;
            const ex = toNode.x - ux * padEnd;
            const ey = toNode.y - uy * padEnd;
            const mx = (sx + ex) / 2;
            const my = (sy + ey) / 2;
            const label = formatInt(trade.people);
            const pillW = Math.max(26, label.length * 6.2 + 10);

            return (
              <g
                key={trade.key}
                pointerEvents="none"
                data-testid={`flow-arrow-${trade.from}-${trade.to}`}
              >
                <line
                  x1={sx}
                  y1={sy}
                  x2={ex}
                  y2={ey}
                  stroke="var(--zd-accent)"
                  strokeWidth={dense ? 2 : 2.5}
                  markerEnd={`url(#${markerId})`}
                />
                {(!dense || trades.length <= 12 || isHovered) && (
                  <>
                    <rect
                      x={mx - pillW / 2}
                      y={my - 8}
                      width={pillW}
                      height={16}
                      rx={8}
                      fill="var(--zd-accent)"
                    />
                    <text
                      x={mx}
                      y={my + 3.5}
                      textAnchor="middle"
                      fontSize="var(--zd-text-xs)"
                      fontWeight="var(--zd-weight-bold)"
                      fill="var(--zd-accent-text)"
                      className="zd-num"
                    >
                      {label}
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* District nodes */}
          {layout.nodes.map((node) => {
            const tone = getDeviationTone(node.deviation, map);
            const shortLabel = formatDistrictShort(node.district, districts);
            const swatch = getDistrictColor(node.district, districts);

            const fill =
              tone === 'over'
                ? 'var(--zd-over-bg)'
                : tone === 'under'
                  ? 'var(--zd-under-bg)'
                  : 'var(--zd-zero-bg)';
            const stroke =
              tone === 'over'
                ? 'var(--zd-over)'
                : tone === 'under'
                  ? 'var(--zd-under)'
                  : 'var(--zd-zero)';

            return (
              <g key={node.district} data-testid={`interaction-node-${node.district}`}>
                <title>
                  {formatDistrictName(node.district, districts)}: {formatSigned(node.deviation)}
                </title>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={layout.nodeRadius}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={2}
                />
                {swatch && (
                  <circle
                    cx={node.x + layout.nodeRadius * 0.68}
                    cy={node.y - layout.nodeRadius * 0.68}
                    r={dense ? 3.5 : 4.2}
                    fill={swatch}
                    stroke="var(--zd-surface)"
                    strokeWidth={1.2}
                  />
                )}
                <text
                  x={node.x}
                  y={dense ? node.y + 3.5 : node.y - 2}
                  textAnchor="middle"
                  fontSize="var(--zd-text-xs)"
                  fontWeight="var(--zd-weight-bold)"
                  fill="var(--zd-text)"
                  className="zd-num"
                >
                  {shortLabel.length > 4 ? shortLabel.slice(0, 4) : shortLabel}
                </text>
                {!dense && (
                  <text
                    x={node.x}
                    y={node.y + 10.5}
                    textAnchor="middle"
                    fontSize="var(--zd-text-xs)"
                    fontWeight="var(--zd-weight-bold)"
                    fill={stroke}
                    className="zd-num"
                  >
                    {formatSigned(node.deviation)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="zd-interaction__readout zd-num" data-testid="interaction-readout">
        {hoveredEdge ? (
          <>
            {hoveredTrade?.kind === 'two-way' ? (
              <span>
                <strong className="zd-interaction__trade">
                  {formatDistrictShort(hoveredTrade.first.from, districts)} ⇄{' '}
                  {formatDistrictShort(hoveredTrade.first.to, districts)} (2-way):
                </strong>{' '}
                {formatDistrictShort(hoveredTrade.first.from, districts)}→
                {formatDistrictShort(hoveredTrade.first.to, districts)}{' '}
                <strong>{formatInt(hoveredTrade.first.people)}</strong>,{' '}
                {formatDistrictShort(hoveredTrade.second.from, districts)}→
                {formatDistrictShort(hoveredTrade.second.to, districts)}{' '}
                <strong>{formatInt(hoveredTrade.second.people)}</strong> · net{' '}
                {hoveredTrade.netPeople > 0
                  ? `${formatDistrictShort(hoveredTrade.netFrom, districts)}→${formatDistrictShort(hoveredTrade.netTo, districts)} `
                  : ''}
                <strong>{formatInt(hoveredTrade.netPeople)}</strong>
              </span>
            ) : hoveredTrade?.kind === 'one-way' ? (
              <span>
                <strong>
                  {formatDistrictShort(hoveredTrade.from, districts)} →{' '}
                  {formatDistrictShort(hoveredTrade.to, districts)}: {formatInt(hoveredTrade.people)}
                </strong>{' '}
                · cheap {formatInt(hoveredEdge.cheapAtoB)}/{formatInt(hoveredEdge.cheapBtoA)}
              </span>
            ) : (
              <span>
                <strong>
                  {formatDistrictShort(hoveredEdge.a, districts)} ↔{' '}
                  {formatDistrictShort(hoveredEdge.b, districts)}
                </strong>{' '}
                cheap: {formatDistrictShort(hoveredEdge.a, districts)}→
                {formatDistrictShort(hoveredEdge.b, districts)} {formatInt(hoveredEdge.cheapAtoB)},{' '}
                {formatDistrictShort(hoveredEdge.b, districts)}→
                {formatDistrictShort(hoveredEdge.a, districts)} {formatInt(hoveredEdge.cheapBtoA)}
              </span>
            )}
            <span className="zd-muted">
              max {formatInt(hoveredEdge.maxAtoB)} / {formatInt(hoveredEdge.maxBtoA)}
            </span>
          </>
        ) : (
          <span className="zd-muted">
            {mapMode === 'mini'
              ? hasTwoWayTrades
                ? 'Hover a border to preview it on the mini-map and see two-way trade legs.'
                : 'Hover a border to preview it on the mini-map and see directional capacity.'
              : hasTwoWayTrades
                ? 'Hover a border to highlight it on DRA and see capacity or two-way trade legs.'
                : 'Hover a border to highlight it on DRA and see directional capacity.'}
          </span>
        )}
      </div>

      <div className="zd-interaction__legend">
        <span className="zd-legend-item">
          <span className="zd-legend-dot zd-legend-dot--over" /> Over (+)
        </span>
        <span className="zd-legend-item">
          <span className="zd-legend-dot zd-legend-dot--under" /> Under (−)
        </span>
        <span className="zd-legend-item">
          <span className="zd-legend-dot zd-legend-dot--zero" /> Zeroed
        </span>
        {hasTwoWayTrades ? (
          <span className="zd-legend-item">
            <span className="zd-legend-dot zd-legend-dot--twoway" /> ⇄ Two-way trade
          </span>
        ) : (
          <span className="zd-legend-item">Edge # = no-split capacity</span>
        )}
      </div>
    </section>
  );
}
