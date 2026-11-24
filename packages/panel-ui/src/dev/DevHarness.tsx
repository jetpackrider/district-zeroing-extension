import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PanelAction } from '@zd/contracts';
import { Panel } from '../components/Panel';
import { MockController } from '../mock/MockController';
import { SCENARIO_LIST } from '../mock/scenarios';
import type { ScenarioId } from '../mock/scenarios';
import type { MiniMapRenderer } from '../types';
import './harness.css';

const WIDTH_PRESETS = [300, 340, 400, 520, 700] as const;

interface ActionLogEntry {
  id: number;
  time: string;
  action: PanelAction;
}

/** Demo mini-map renderer supplied by the dev harness when mapMode === 'mini'. */
const demoMiniMapRenderer: MiniMapRenderer = (container) => {
  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'width:100%;height:100%;position:relative;background:linear-gradient(135deg,#dbeafe 0%,#e2e8f0 50%,#dcfce7 100%);display:flex;align-items:center;justify-content:center;overflow:hidden;';

  wrapper.innerHTML = `
    <svg viewBox="0 0 320 200" style="width:100%;height:100%;display:block;">
      <path d="M20,40 L140,25 L210,70 L180,170 L45,160 Z" fill="rgba(245,158,11,0.22)" stroke="#b45309" stroke-width="2" stroke-dasharray="5 3"/>
      <polygon points="118,52 162,48 175,92 128,96" fill="rgba(29,95,214,0.38)" stroke="#1d5fd6" stroke-width="2"/>
      <polygon points="128,96 175,92 165,134 122,128" fill="rgba(21,128,61,0.36)" stroke="#15803d" stroke-width="2"/>
      <circle cx="147" cy="72" r="11" fill="#1d5fd6"/><text x="147" y="76" text-anchor="middle" fill="#fff" font-size="11" font-weight="700" font-family="sans-serif">1</text>
      <circle cx="149" cy="113" r="11" fill="#15803d"/><text x="149" y="117" text-anchor="middle" fill="#fff" font-size="11" font-weight="700" font-family="sans-serif">2</text>
    </svg>
    <div style="position:absolute;bottom:6px;left:8px;background:rgba(15,23,42,0.78);color:#fff;font-size:10.5px;padding:2px 7px;border-radius:4px;font-family:monospace;">
      Shell-supplied MapLibre mini-map slot
    </div>
  `;

  container.appendChild(wrapper);
  return () => {
    container.removeChild(wrapper);
  };
};

export function DevHarness() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('live-group-chain');
  const [panelWidth, setPanelWidth] = useState<number>(360);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [autoTick, setAutoTick] = useState(false);
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);

  const handleAction = useCallback((action: PanelAction) => {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    setActionLog((prev) => [
      { id: Date.now() + Math.random(), time, action },
      ...prev.slice(0, 11),
    ]);
  }, []);

  const controller = useMemo(
    () => new MockController({ initialScenario: 'live-group-chain', onAction: handleAction }),
    [handleAction],
  );

  useEffect(() => {
    return () => controller.stopAutoTick();
  }, [controller]);

  const handleSelectScenario = (id: ScenarioId) => {
    setScenarioId(id);
    setAutoTick(false);
    controller.setScenario(id);
  };

  const toggleAutoTick = () => {
    if (autoTick) {
      controller.stopAutoTick();
      setAutoTick(false);
    } else {
      controller.startAutoTick(900);
      setAutoTick(true);
    }
  };

  const currentScenario = SCENARIO_LIST.find((s) => s.id === scenarioId);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof SCENARIO_LIST>();
    for (const item of SCENARIO_LIST) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <div className="harness-shell" data-harness-theme={theme}>
      <aside className="harness-controls">
        <div className="harness-header">
          <h1>@zd/panel-ui Harness</h1>
          <p>Inspect every PanelState across 300–700 px and light/dark themes.</p>
        </div>

        <div className="harness-block">
          <label htmlFor="scenario-select" className="harness-label">
            Scenario
          </label>
          <select
            id="scenario-select"
            className="harness-select"
            value={scenarioId}
            onChange={(e) => handleSelectScenario(e.target.value as ScenarioId)}
          >
            {grouped.map(([category, items]) => (
              <optgroup key={category} label={category}>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {currentScenario && <p className="harness-desc">{currentScenario.description}</p>}
        </div>

        <div className="harness-block">
          <div className="harness-row">
            <label htmlFor="width-slider" className="harness-label">
              Panel width
            </label>
            <span className="harness-mono">{panelWidth} px</span>
          </div>
          <input
            id="width-slider"
            type="range"
            min={300}
            max={700}
            step={10}
            value={panelWidth}
            onChange={(e) => setPanelWidth(Number(e.target.value))}
          />
          <div className="harness-presets">
            {WIDTH_PRESETS.map((w) => (
              <button
                key={w}
                type="button"
                className={panelWidth === w ? 'active' : ''}
                onClick={() => setPanelWidth(w)}
              >
                {w}px
              </button>
            ))}
          </div>
        </div>

        <div className="harness-block">
          <span className="harness-label">Appearance</span>
          <div className="harness-presets">
            {(['system', 'light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={theme === mode ? 'active' : ''}
                onClick={() => setTheme(mode)}
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="harness-block">
          <span className="harness-label">Simulators</span>
          <div className="harness-presets">
            <button type="button" onClick={toggleAutoTick} className={autoTick ? 'active' : ''}>
              {autoTick ? 'Stop auto-tick' : 'Auto-tick blocks'}
            </button>
            <button type="button" onClick={() => controller.tickNextBlock()}>
              Tick 1 block
            </button>
            <button type="button" onClick={() => controller.injectStrayEdit()}>
              Stray edit
            </button>
            <button
              type="button"
              onClick={() =>
                controller.dispatch({
                  type: 'load-csv',
                  fileName: 'ny-2026-export.csv',
                  text: 'GEOID20,District\n360610001001000,13\n360610001001001,12\n',
                })
              }
            >
              Simulate CSV load
            </button>
          </div>
        </div>

        <div className="harness-block harness-log-block">
          <div className="harness-row">
            <span className="harness-label">Dispatched Actions</span>
            {actionLog.length > 0 && (
              <button type="button" className="harness-clear" onClick={() => setActionLog([])}>
                Clear
              </button>
            )}
          </div>
          <div className="harness-log">
            {actionLog.length === 0 ? (
              <span className="harness-log-empty">Interact with the panel to see actions…</span>
            ) : (
              actionLog.map((entry) => (
                <div key={entry.id} className="harness-log-item">
                  <span className="harness-log-time">{entry.time}</span>
                  <code>{JSON.stringify(entry.action)}</code>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>

      <main className="harness-stage">
        <div
          className="harness-frame"
          style={{ width: `${panelWidth}px` }}
          data-theme-wrapper={theme}
        >
          <ThemeFrame theme={theme}>
            <Panel controller={controller} renderMiniMap={demoMiniMapRenderer} />
          </ThemeFrame>
        </div>
      </main>
    </div>
  );
}

function ThemeFrame({
  theme,
  children,
}: {
  theme: 'system' | 'light' | 'dark';
  children: React.ReactNode;
}) {
  useEffect(() => {
    const panels = document.querySelectorAll('.zd-panel');
    panels.forEach((el) => {
      if (theme === 'system') {
        el.removeAttribute('data-theme');
      } else {
        el.setAttribute('data-theme', theme);
      }
    });
  }, [theme]);

  return <>{children}</>;
}
