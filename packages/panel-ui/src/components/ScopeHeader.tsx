import type { PanelAction, PanelState, Scope } from '@zd/contracts';
import {
  MINUS,
  formatDeviationPhrase,
  formatDistrictName,
  formatInt,
  formatPopFieldShort,
  formatSigned,
  getDeviationTone,
  isDeviationZeroed,
  sortDistrictsWorstFirst,
} from '../format';

interface ScopeHeaderProps {
  state: PanelState;
  dispatch: (action: PanelAction) => void;
}

export function ScopeHeader({ state, dispatch }: ScopeHeaderProps) {
  const { map, districts, scope } = state;
  const lockedCount = (state.lockedDistricts ?? []).filter((d) => districts.some((r) => r.index === d)).length;
  const worst = sortDistrictsWorstFirst(districts)[0];

  const switchMode = (nextMode: Scope['mode']) => {
    if (nextMode === scope.mode) return;
    if (nextMode === 'one') {
      const targetDistrict =
        scope.mode === 'group' && scope.districts.length > 0
          ? scope.districts[0]
          : (worst?.index ?? districts[0]?.index ?? 1);
      dispatch({ type: 'set-scope', scope: { mode: 'one', district: targetDistrict } });
    } else if (nextMode === 'group') {
      const initial =
        scope.mode === 'one'
          ? [scope.district]
          : worst
            ? [worst.index]
            : districts.slice(0, 1).map((d) => d.index);
      dispatch({
        type: 'set-scope',
        scope: { mode: 'group', districts: initial, allowOutsideAbsorb: false },
      });
    } else {
      dispatch({ type: 'set-scope', scope: { mode: 'all' } });
    }
  };

  let headlineText = 'Select districts';
  let headlineSwatch: string | undefined;
  let headlineTone: 'over' | 'under' | 'zero' | null = null;
  let headlineBadge: string | null = null;
  let subItems: string[] = [];

  if (scope.mode === 'one') {
    const row = districts.find((d) => d.index === scope.district);
    if (row) {
      headlineSwatch = row.color;
      headlineTone = scope.goal !== undefined
        ? (row.deviation === scope.goal ? 'zero' : null)
        : getDeviationTone(row.deviation, map);
      headlineText = `${formatDistrictName(row.index, districts)}: ${formatDeviationPhrase(row.deviation)}`;
      if (scope.goal !== undefined) {
        headlineBadge = `Goal ${formatSigned(scope.goal)}`;
      }
      subItems = [
        `Pop ${formatInt(row.pop)}`,
        ...(map ? [`Target ${formatInt(map.target)}`] : []),
        ...(map && scope.goal !== undefined ? [`Goal pop ${formatInt(map.target + scope.goal)}`] : []),
      ];
    }
  } else if (scope.mode === 'group') {
    const selectedRows = districts.filter((d) => scope.districts.includes(d.index));
    const netDev = selectedRows.reduce((acc, d) => acc + d.deviation, 0);
    const totalPop = selectedRows.reduce((acc, d) => acc + d.pop, 0);
    headlineText = `${selectedRows.length} ${selectedRows.length === 1 ? 'district' : 'districts'} selected`;
    if (selectedRows.length > 0) {
      headlineTone = netDev === 0 ? 'zero' : netDev > 0 ? 'over' : 'under';
      headlineBadge = `Net ${formatSigned(netDev)}`;
      subItems = [
        `Group pop ${formatInt(totalPop)}`,
        ...(map ? [`Target ${formatInt(map.target)} / dist`] : []),
      ];
    } else {
      subItems = ['Check two or more districts below to balance together'];
    }
  } else {
    const zeroedCount = districts.filter((d) => isDeviationZeroed(d.deviation, map)).length;
    const maxAbs = districts.reduce((m, d) => Math.max(m, Math.abs(d.deviation)), 0);
    headlineText = lockedCount
      ? `Whole map (${districts.length - lockedCount} of ${districts.length} districts)`
      : `Whole map (${districts.length} districts)`;
    headlineTone = zeroedCount === districts.length && districts.length > 0 ? 'zero' : null;
    headlineBadge = `${zeroedCount}/${districts.length} zeroed`;
    subItems = [
      `Max dev ±${formatInt(maxAbs)}`,
      ...(map ? [`Target ${formatInt(map.target)}`] : []),
      ...(lockedCount ? [`${lockedCount} locked, left as ${lockedCount === 1 ? 'it is' : 'they are'}`] : []),
    ];
  }

  const setGoal = (nextGoal: -1 | 1 | undefined) => {
    if (scope.mode !== 'one') return;
    if (nextGoal === undefined && scope.goal === undefined) return;
    if (nextGoal !== undefined && scope.goal === nextGoal) return;
    dispatch({
      type: 'set-scope',
      scope: {
        mode: 'one',
        district: scope.district,
        ...(scope.with && scope.with.length > 0 ? { with: scope.with } : {}),
        ...(nextGoal !== undefined ? { goal: nextGoal } : {}),
      },
    });
  };

  return (
    <section className="zd-card" aria-label="Selected scope summary">
      {map && (
        <div className="zd-map-meta">
          <span className="zd-map-meta__name" title={map.planName ?? `${map.state} plan`}>
            {map.planName ? `${map.planName} (${map.state})` : `${map.state} · ${map.numDistricts} districts`}
          </span>
          <span className="zd-num">
            {formatPopFieldShort(map.popField)} · Pop {formatInt(map.totalPop)}
          </span>
        </div>
      )}

      <div className="zd-focus-headline">
        {headlineSwatch && (
          <span
            className="zd-swatch zd-swatch--lg"
            style={{ backgroundColor: headlineSwatch }}
            aria-hidden="true"
          />
        )}
        <span className="zd-focus-headline__text zd-num">{headlineText}</span>
        {headlineBadge && (
          <span className={`zd-pill zd-num ${headlineTone ? `zd-pill--${headlineTone}` : ''}`}>
            {headlineBadge}
          </span>
        )}
      </div>

      {subItems.length > 0 && (
        <div className="zd-focus-sub zd-num">
          {subItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}

      <div className="zd-segmented" role="group" aria-label="Balancing scope">
        <button
          type="button"
          className="zd-btn zd-btn--sm zd-segmented__btn"
          aria-pressed={scope.mode === 'one'}
          onClick={() => switchMode('one')}
        >
          One district
        </button>
        <button
          type="button"
          className="zd-btn zd-btn--sm zd-segmented__btn"
          aria-pressed={scope.mode === 'group'}
          onClick={() => switchMode('group')}
        >
          Group
        </button>
        <button
          type="button"
          className="zd-btn zd-btn--sm zd-segmented__btn"
          aria-pressed={scope.mode === 'all'}
          onClick={() => switchMode('all')}
        >
          Whole map
        </button>
      </div>

      {scope.mode === 'one' && (
        <div className="zd-goal-row" data-testid="goal-control">
          <span className="zd-goal-row__label">Aim for</span>
          <div className="zd-segmented zd-segmented--goal" role="group" aria-label="Aim for">
            <button
              type="button"
              className="zd-btn zd-btn--sm zd-segmented__btn zd-num"
              data-testid="goal-minus-1"
              aria-pressed={scope.goal === -1}
              onClick={() => setGoal(-1)}
            >
              {MINUS}1
            </button>
            <button
              type="button"
              className="zd-btn zd-btn--sm zd-segmented__btn"
              data-testid="goal-zero"
              aria-pressed={scope.goal === undefined}
              onClick={() => setGoal(undefined)}
            >
              Zero
            </button>
            <button
              type="button"
              className="zd-btn zd-btn--sm zd-segmented__btn zd-num"
              data-testid="goal-plus-1"
              aria-pressed={scope.goal === 1}
              onClick={() => setGoal(1)}
            >
              +1
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
