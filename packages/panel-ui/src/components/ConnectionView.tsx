import type { PanelAction, PanelState } from '@zd/contracts';
import { formatInt, formatPopField } from '../format';
import { CsvDropZone } from './CsvDropZone';

interface ConnectionViewProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
}

export function ConnectionView({ state, dispatch }: ConnectionViewProps) {
  const { connection, map } = state;

  const handleLoadCsv = (text: string, fileName: string) => {
    dispatch({ type: 'load-csv', text, fileName });
  };

  if (connection === 'connecting') {
    return (
      <div className="zd-conn">
        <div className="zd-card" role="status">
          <div className="zd-conn__status">
            <span className="zd-spinner" aria-hidden="true" />
            <div>
              <h2 className="zd-conn__title">
                Connecting to Dave&apos;s Redistricting…
              </h2>
              <p className="zd-conn__desc">Reading the active map and verifying page hooks.</p>
            </div>
          </div>
          <div className="zd-conn__actions">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={() => dispatch({ type: 'retry-connection' })}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (connection === 'no-plan') {
    return (
      <div className="zd-conn" data-testid="no-plan-view">
        <div className="zd-card">
          <h2 className="zd-conn__title">No map open in Dave&apos;s Redistricting</h2>
          <p className="zd-conn__desc">
            You&apos;re on <strong>davesredistricting.org</strong>, but no map is open yet. Open
            one of your 2020-shape maps in that tab to read district deviations live and highlight
            blocks on the map.
          </p>
          <div className="zd-conn__actions">
            <button
              type="button"
              className="zd-btn zd-btn--primary"
              onClick={() => dispatch({ type: 'retry-connection' })}
            >
              Check again
            </button>
          </div>
        </div>
        <CsvDropZone
          onLoadCsv={handleLoadCsv}
          title="Or work from an exported CSV"
          hint="Drop a DRA block-assignment CSV (GEOID20,District) to solve offline without live ticking."
        />
      </div>
    );
  }

  if (connection === 'no-tab') {
    return (
      <div className="zd-conn">
        <div className="zd-card">
          <h2 className="zd-conn__title">No Dave&apos;s Redistricting tab active</h2>
          <p className="zd-conn__desc">
            Open a 2020-shape plan on <strong>davesredistricting.org</strong> to read district
            deviations live and highlight blocks directly on the map.
          </p>
          <div className="zd-conn__actions">
            <button
              type="button"
              className="zd-btn zd-btn--primary"
              onClick={() => dispatch({ type: 'retry-connection' })}
            >
              Retry connection
            </button>
          </div>
        </div>
        <CsvDropZone
          onLoadCsv={handleLoadCsv}
          title="Or work from an exported CSV"
          hint="Drop a DRA block-assignment CSV (GEOID20,District) to solve offline without live ticking."
        />
      </div>
    );
  }

  if (connection === 'hook-failed') {
    return (
      <div className="zd-conn">
        <div className="zd-note zd-note--warn" role="alert">
          <p className="zd-note__title">DRA changed; update pending</p>
          <p className="zd-note__text">
            The live connection to Dave&apos;s Redistricting failed its startup check, likely
            because DRA updated its page bundle. You can still balance your map right now by
            dropping an exported block-assignment CSV below.
          </p>
          <div className="zd-conn__actions">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={() => dispatch({ type: 'retry-connection' })}
            >
              Retry live hook
            </button>
          </div>
        </div>
        <CsvDropZone
          onLoadCsv={handleLoadCsv}
          title="Drop a DRA block-assignment CSV to continue"
          hint="In DRA, click Export → Block Assignment CSV, then drop the file here. Suggestions and walkthrough work normally (without live ticking)."
        />
      </div>
    );
  }

  if (connection === 'unsupported-map') {
    return (
      <div className="zd-conn">
        <div className="zd-note zd-note--warn" role="alert">
          <p className="zd-note__title">Suggestions unavailable for this map</p>
          <p className="zd-note__text">
            Zero-deviation balancing supports single-member, equal-population state maps using 2020
            Census shapes. Multi-member, unequal-target, county/city, multi-state, and 2010-shape
            maps are not supported.
          </p>
          {map && (
            <p className="zd-note__text zd-num">
              Detected: {map.planName ? `${map.planName} · ` : ''}
              {map.state} · {map.numDistricts} districts · {formatPopField(map.popField)}
            </p>
          )}
          <div className="zd-conn__actions">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={() => dispatch({ type: 'retry-connection' })}
            >
              Re-check map
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (connection === 'data-mismatch') {
    return (
      <div className="zd-conn">
        <div className="zd-note zd-note--error" role="alert">
          <p className="zd-note__title">Population data mismatch — suggestions disabled</p>
          <p className="zd-note__text">
            The extension&apos;s block bundle does not match Dave&apos;s Redistricting&apos;s
            district totals for this map (DRA may have released a new data version). Suggestions are
            paused so no inaccurate block moves are recommended.
          </p>
          {map && (
            <p className="zd-note__text zd-num">
              {map.planName ? `${map.planName} · ` : ''}
              {map.state} · Total pop {formatInt(map.totalPop)} · Target {formatInt(map.target)} (
              {formatPopField(map.popField)})
            </p>
          )}
          <div className="zd-conn__actions">
            <button
              type="button"
              className="zd-btn zd-btn--sm"
              onClick={() => dispatch({ type: 'retry-connection' })}
            >
              Retry check
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
