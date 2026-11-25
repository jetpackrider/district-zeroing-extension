import { useState } from 'react';
import type { FormEvent } from 'react';
import type { PanelAction, PanelState } from '@zd/contracts';
import {
  CLUSTER_TOLERANCES,
  DEFAULT_CLUSTER_TOLERANCE,
  formatClusteringTitle,
  formatInt,
  formatPeople,
  formatSigned,
  formatSignedPct,
  formatTolerance,
  truncateNames,
} from '../format';

interface ClustersViewProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
}

type ClustersState = NonNullable<PanelState['clusters']>;
type ClusteringResult = ClustersState['results'][number];

export const CLUSTERS_EXPLAIN = 'Groups of whole counties that each hold a whole number of districts.';
const MAX_DISTRICTS = 999;

/** A whole number of districts from 1 to 999, or null. */
function parseDistricts(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_DISTRICTS ? n : null;
}

function sameCounties(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/**
 * County clusters (PanelState.clusters): split the state into groups of whole, contiguous
 * counties, each holding close to a whole number of districts, for the number of districts the
 * user enters (default: the open map's) and a tolerance per district. Each result is a clustering,
 * expandable to its clusters; hovering one outlines it on DRA's map, and any cluster can become
 * the swap area (AreaState.cluster). Collapsed by default; not shown during a walkthrough.
 */
export function ClustersView({ state, dispatch }: ClustersViewProps) {
  const clusters = state.clusters;
  const [open, setOpen] = useState(false);
  const [districtsDraft, setDistrictsDraft] = useState<string | null>(null);
  const [toleranceChoice, setToleranceChoice] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [namesOpen, setNamesOpen] = useState<ReadonlySet<string>>(new Set());

  const defaultDistricts = clusters?.numDistricts ?? state.map?.numDistricts;
  const districtsText = districtsDraft ?? (defaultDistricts !== undefined ? String(defaultDistricts) : '');
  const numDistricts = parseDistricts(districtsText);
  const tolerance = toleranceChoice ?? clusters?.tolerance ?? DEFAULT_CLUSTER_TOLERANCE;
  const finding = clusters?.status === 'finding';
  const totalPop = state.map?.totalPop;
  const sizePreview = numDistricts !== null && totalPop ? totalPop / numDistricts : undefined;
  const results = clusters?.results ?? [];
  const hovered = clusters?.hovered;
  const areaBusy = Boolean(state.area?.drawing || state.area?.picking);

  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const handleFind = (e?: FormEvent) => {
    e?.preventDefault();
    if (numDistricts === null || finding) return;
    setExpanded(new Set());
    setNamesOpen(new Set());
    dispatch({ type: 'clusters-find', numDistricts, tolerance });
  };

  const handleToggleOpen = () => {
    if (open && hovered) dispatch({ type: 'clusters-hover', id: null });
    setOpen((v) => !v);
  };

  const hoverOn = (id: string, cluster?: number) => ({
    onMouseEnter: () => dispatch(cluster === undefined ? { type: 'clusters-hover', id } : { type: 'clusters-hover', id, cluster }),
    onMouseLeave: () => dispatch({ type: 'clusters-hover', id: null }),
  });

  const renderCluster = (result: ClusteringResult, i: number) => {
    const cluster = result.clusters[i];
    const names = result.countyNames[i] ?? [];
    const key = `${result.id}:${i}`;
    const showAll = namesOpen.has(key);
    const { text, more } = truncateNames(names);
    const full = names.join(', ');
    const isArea = Boolean(state.area?.cluster && sameCounties(state.area.cluster.counties, cluster.counties));
    const isHovered = hovered?.id === result.id && hovered.cluster === i;
    const pct = formatSignedPct(cluster.deviationPct);
    const people = formatSigned(cluster.deviation);
    const tone = Math.round(cluster.deviation) === 0 ? 'zero' : cluster.deviation > 0 ? 'over' : 'under';
    const districtsLabel = `${cluster.districts.toLocaleString('en-US')} ${cluster.districts === 1 ? 'district' : 'districts'}`;
    return (
      <li
        key={key}
        className={`zd-list__row zd-clusters__cluster${isHovered ? ' zd-list__row--selected' : ''}`}
        data-testid="cluster-row"
        {...hoverOn(result.id, i)}
      >
        <div className="zd-clusters__cluster-main">
          <p className="zd-clusters__names" title={full} data-testid="cluster-names">
            {showAll ? full : text}
            {more > 0 && (
              <>
                {' '}
                <button
                  type="button"
                  className="zd-btn zd-btn--ghost zd-btn--sm zd-clusters__more"
                  aria-expanded={showAll}
                  onClick={() => setNamesOpen((s) => toggle(s, key))}
                >
                  {showAll ? 'Show fewer' : `+${more} more`}
                </button>
              </>
            )}
          </p>
          <div className="zd-clusters__meta">
            <span className="zd-pill zd-pill--neutral zd-num" data-testid="cluster-districts">
              {districtsLabel}
            </span>
            <span
              className={`zd-pill zd-pill--${tone} zd-num`}
              title={`${pct} per district (${people} people)`}
              data-testid="cluster-deviation"
            >
              {pct} · {people}
              {cluster.districts > 1 ? ' each' : ''}
            </span>
            <span className="zd-clusters__pop zd-num">{formatPeople(cluster.pop)}</span>
          </div>
        </div>
        {isArea ? (
          <span className="zd-pill zd-pill--accent" data-testid="cluster-is-area">
            Area
          </span>
        ) : (
          <button
            type="button"
            className="zd-btn zd-btn--sm"
            data-testid="cluster-use-as-area"
            disabled={areaBusy}
            title={`Make ${names.length === 1 ? names[0] : `these ${names.length} counties`} the swap area`}
            onClick={() => dispatch({ type: 'clusters-use-as-area', id: result.id, cluster: i })}
          >
            Use as area
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="zd-card zd-clusters" aria-label="County clusters" data-testid="clusters-view">
      <div className="zd-clusters__head">
        <button
          type="button"
          className="zd-btn zd-btn--ghost zd-btn--sm"
          aria-expanded={open}
          data-testid="clusters-toggle"
          onClick={handleToggleOpen}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="zd-section-title">County clusters</span>
        </button>
        {!open && finding && <span className="zd-pill zd-pill--accent">Finding…</span>}
        {!open && clusters?.status === 'done' && results.length > 0 && (
          <span className="zd-pill zd-pill--neutral zd-num">
            {results.length} {results.length === 1 ? 'option' : 'options'}
          </span>
        )}
      </div>

      {open && (
        <div className="zd-clusters__body">
          <p className="zd-clusters__what">{CLUSTERS_EXPLAIN}</p>

          <form className="zd-clusters__form" onSubmit={handleFind}>
            <label className="zd-clusters__field">
              <span className="zd-clusters__label">Districts</span>
              <input
                type="number"
                className="zd-clusters__input zd-num"
                min={1}
                max={MAX_DISTRICTS}
                step={1}
                inputMode="numeric"
                value={districtsText}
                disabled={finding}
                aria-invalid={numDistricts === null}
                data-testid="clusters-districts"
                onChange={(e) => setDistrictsDraft(e.currentTarget.value)}
              />
              {sizePreview !== undefined && (
                <span className="zd-clusters__size zd-num" data-testid="clusters-size">
                  {formatInt(sizePreview)} per district
                </span>
              )}
            </label>

            <div className="zd-clusters__field">
              <span className="zd-clusters__label" id="zd-clusters-tolerance-label">
                Each district within
              </span>
              <div className="zd-segmented" role="group" aria-labelledby="zd-clusters-tolerance-label">
                {CLUSTER_TOLERANCES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="zd-btn zd-btn--sm zd-segmented__btn zd-num"
                    aria-pressed={tolerance === t}
                    disabled={finding}
                    onClick={() => setToleranceChoice(t)}
                  >
                    {formatTolerance(t)}
                  </button>
                ))}
              </div>
            </div>

            {numDistricts === null && (
              <p className="zd-note zd-note--warn" data-testid="clusters-invalid">
                Enter a whole number of districts from 1 to {MAX_DISTRICTS}.
              </p>
            )}

            <div className="zd-clusters__actions">
              <button
                type="submit"
                className="zd-btn zd-btn--primary zd-btn--sm"
                data-testid="clusters-find"
                disabled={numDistricts === null || finding}
              >
                Find clusters
              </button>
            </div>
          </form>

          {finding && clusters && (
            <div className="zd-clusters__finding" role="status" data-testid="clusters-finding">
              <div className="zd-clusters__finding-row">
                <span>
                  Finding clusters for {formatInt(clusters.numDistricts)} districts, {formatTolerance(clusters.tolerance)}…
                </span>
                <button
                  type="button"
                  className="zd-btn zd-btn--sm"
                  data-testid="clusters-cancel"
                  onClick={() => dispatch({ type: 'clusters-cancel' })}
                >
                  Cancel
                </button>
              </div>
              <div className="zd-progress-track" aria-hidden="true">
                <div className="zd-progress-fill zd-progress-fill--indeterminate" />
              </div>
            </div>
          )}

          {(clusters?.status === 'none' || clusters?.status === 'error') && (
            <p
              className={`zd-note zd-note--${clusters.status === 'error' ? 'error' : 'warn'}`}
              role={clusters.status === 'error' ? 'alert' : 'status'}
              data-testid="clusters-message"
            >
              {clusters.message ??
                (clusters.status === 'error'
                  ? 'Could not find clusters.'
                  : `No clustering of whole counties keeps every district within ${formatTolerance(clusters.tolerance)}.`)}
            </p>
          )}

          {clusters?.status === 'done' && results.length === 0 && (
            <p className="zd-note zd-note--warn" role="status" data-testid="clusters-message">
              {clusters.message ?? 'No clusterings found.'}
            </p>
          )}

          {clusters?.status === 'done' && results.length > 0 && (
            <div className="zd-clusters__results" data-testid="clusters-results">
              <p className="zd-clusters__summary zd-num">
                {formatInt(clusters.numDistricts)} districts
                {clusters.districtSize !== undefined ? ` of ${formatInt(clusters.districtSize)}` : ''},{' '}
                {formatTolerance(clusters.tolerance)} each
              </p>
              {clusters.message && <p className="zd-note zd-note--info">{clusters.message}</p>}
              <ol className="zd-list zd-clusters__options" aria-label="Clusterings">
                {results.map((result, index) => {
                  const isOpen = expanded.has(result.id);
                  const isHovered = hovered?.id === result.id && hovered.cluster === undefined;
                  return (
                    <li key={result.id} className="zd-clusters__option" data-testid="clustering">
                      <button
                        type="button"
                        className={`zd-clusters__toggle zd-num${isHovered ? ' zd-list__row--selected' : ''}`}
                        aria-expanded={isOpen}
                        data-testid="clustering-row"
                        {...hoverOn(result.id)}
                        onClick={() => setExpanded((s) => toggle(s, result.id))}
                      >
                        <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                        <span>
                          {formatClusteringTitle(result.stats, index, clusters.exhaustive ?? false, clusters.elapsedMs)}
                        </span>
                      </button>
                      {isOpen && (
                        <ol className="zd-clusters__clusters" aria-label={`Option ${index + 1} clusters`}>
                          {result.clusters.map((_, i) => renderCluster(result, i))}
                        </ol>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
