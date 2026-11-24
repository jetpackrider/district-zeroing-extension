import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelAction } from '@zd/contracts';
import { MockController, Panel, SCENARIOS, mountPanel } from '../src';
import { solutionBadges } from '../src/format';

describe('Panel — connection states & notices', () => {
  it('renders no-tab with retry button and CSV drop zone', async () => {
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'no-tab',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    expect(screen.getByText(/No Dave's Redistricting tab active/i)).toBeInTheDocument();
    expect(screen.getByTestId('csv-dropzone')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Retry connection/i }));
    expect(actions).toContainEqual({ type: 'retry-connection' });
  });

  it('renders no-plan state telling the user to open a map, with retry and CSV fallback', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'no-plan',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    expect(screen.getByTestId('connection-pill')).toHaveTextContent(/No map open/i);
    expect(screen.getByTestId('no-plan-view')).toHaveTextContent(/No map open in Dave's Redistricting/i);
    expect(screen.getByTestId('csv-dropzone')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Check again/i }));
    expect(actions).toContainEqual({ type: 'retry-connection' });
  });

  it('renders connecting state', () => {
    const controller = new MockController({ initialScenario: 'connecting' });
    render(<Panel controller={controller} />);
    expect(screen.getByText(/Connecting to Dave's Redistricting/i)).toBeInTheDocument();
  });

  it('renders hook-failed with "DRA changed; update pending" and CSV drop zone', () => {
    const controller = new MockController({ initialScenario: 'hook-failed' });
    render(<Panel controller={controller} />);
    expect(screen.getByText(/DRA changed; update pending/i)).toBeInTheDocument();
    expect(screen.getByTestId('csv-dropzone')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/fullBlockMap not found/i)).toBeInTheDocument();
  });

  it('renders unsupported-map and notice banner', () => {
    const controller = new MockController({ initialScenario: 'unsupported-map' });
    render(<Panel controller={controller} />);
    expect(screen.getByText(/Suggestions unavailable for this map/i)).toBeInTheDocument();
    expect(screen.getByText(/2010 Census shapes/i)).toBeInTheDocument();
  });

  it('renders data-mismatch with disabled suggestions and read-only district list', () => {
    const controller = new MockController({ initialScenario: 'data-mismatch' });
    render(<Panel controller={controller} />);
    expect(screen.getByText(/Population data mismatch/i)).toBeInTheDocument();
    expect(screen.getByText(/District 13 differs by 14 people/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Find zeroing options/i })).not.toBeInTheDocument();
    expect(screen.getByText('District 13')).toBeInTheDocument();
  });

  it('renders csv mode with compact drop zone, sourceName, and Back to live tab button', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'csv-mode',
      onAction: (a) => actions.push(a),
    });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('connection-pill')).toHaveTextContent(/CSV mode/i);
    expect(screen.getByTestId('csv-dropzone')).toBeInTheDocument();
    expect(screen.getByTestId('csv-source-name')).toHaveTextContent('ny-2026-blocks.csv');

    await user.click(screen.getByTestId('back-to-live-btn'));
    expect(actions).toContainEqual({ type: 'retry-connection' });
    expect(screen.getByTestId('connection-pill')).toHaveTextContent(/Live/i);
  });

  it('allows loading a CSV while in live mode and returning back to the live tab', async () => {
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'live-csv-switch',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    expect(screen.getByTestId('live-load-csv-btn')).toBeInTheDocument();

    const csvContent = 'GEOID20,District\n360610001001000,13\n360610001001001,12\n';
    const file = new File([csvContent], 'live-override.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByTestId('live-csv-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(actions).toContainEqual({
        type: 'load-csv',
        text: csvContent,
        fileName: 'live-override.csv',
      });
    });

    expect(screen.getByTestId('connection-pill')).toHaveTextContent(/CSV mode/i);
    expect(screen.getByTestId('csv-source-name')).toHaveTextContent('live-override.csv');
    expect(screen.getByTestId('back-to-live-btn')).toBeInTheDocument();
  });
});

describe('Panel — scope selection & district picker', () => {
  it('sorts districts worst first and shows single-district header', () => {
    const controller = new MockController({ initialScenario: 'live-single' });
    render(<Panel controller={controller} />);

    expect(screen.getByText(/District 13: \+412 over/)).toBeInTheDocument();
    expect(screen.getByText(/Target 776,971/)).toBeInTheDocument();

    // District 5 (-680) has the largest absolute deviation in NY_26_SPEC, so it comes first
    const list = screen.getByRole('region', { name: /District population list/i });
    const rows = within(list).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('District 5');
  });

  it('dispatches set-scope when switching modes, checking boxes, Select all, and Add neighbors', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'live-single',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);

    // Switch to Group mode
    await user.click(screen.getByRole('button', { name: 'Group' }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'group', districts: [13], allowOutsideAbsorb: false },
    });

    // Click Add neighbors (D13 has neighbors [10, 12, 15, 16])
    await user.click(screen.getByRole('button', { name: /Add neighbors/i }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'group', districts: [10, 12, 13, 15, 16], allowOutsideAbsorb: false },
    });

    // Uncheck District 10
    await user.click(screen.getByRole('checkbox', { name: 'Select District 10' }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'group', districts: [12, 13, 15, 16], allowOutsideAbsorb: false },
    });

    // Click Select all
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'all' },
    });
  });

  it('shows group infeasibility, quick-add suggestions, and outside-absorb toggle', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'live-group-infeasible',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    const feas = screen.getByTestId('group-feasibility');
    expect(feas).toHaveTextContent(/\+1,240 over/);
    expect(feas).toHaveTextContent(/can't be zeroed on its own/i);

    await user.click(screen.getByRole('button', { name: /\+ Add District 5/i }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'group', districts: [1, 2, 3, 5], allowOutsideAbsorb: false },
    });

    await user.click(screen.getByRole('checkbox', { name: /Allow outside neighbors to absorb/i }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'group', districts: [1, 2, 3, 5], allowOutsideAbsorb: true },
    });
  });
});

describe('Panel — interaction view, solve states & solution cards', () => {
  it('renders SVG schematic, dispatches hover-border, and draws plan flow arrows', () => {
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'live-group-chain',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    expect(screen.getByTestId('interaction-svg')).toBeInTheDocument();
    expect(screen.getByTestId('flow-arrow-4-7')).toBeInTheDocument();

    const edge = screen.getByTestId('border-edge-4-7');
    fireEvent.mouseEnter(edge);
    expect(actions).toContainEqual({ type: 'hover-border', a: 4, b: 7 });

    fireEvent.mouseLeave(edge);
    expect(actions).toContainEqual({ type: 'hover-border', a: null, b: null });
  });

  it('renders option & plan card stats and dispatches hover-solution and start-walkthrough', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'live-single',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    const card = screen.getByTestId('solution-card-opt-1');

    // Stats & before->after
    expect(card).toHaveTextContent('412');
    expect(card).toHaveTextContent('6');
    expect(card).toHaveTextContent('−1 healed');
    expect(card).toHaveTextContent('−184 m');
    expect(card).toHaveTextContent('District 12:');
    expect(card).toHaveTextContent('−380');
    expect(card).toHaveTextContent('+32');

    fireEvent.mouseEnter(card);
    expect(actions).toContainEqual({ type: 'hover-solution', id: 'opt-1' });

    fireEvent.mouseLeave(card);
    expect(actions).toContainEqual({ type: 'hover-solution', id: null });

    await user.click(card);
    expect(actions).toContainEqual({ type: 'start-walkthrough', solutionId: 'opt-1' });
  });

  it('renders plan card border transfers and districts touched', () => {
    const controller = new MockController({ initialScenario: 'live-group-chain' });
    render(<Panel controller={controller} />);

    const card = screen.getByTestId('solution-card-plan-splits');
    expect(card).toHaveTextContent('Plan 1');
    expect(card).toHaveTextContent('Districts touched');
    expect(card).toHaveTextContent('410');
    expect(card).toHaveTextContent('205');
  });

  it('says so on the card when an option only holds together across water', () => {
    const controller = new MockController({ initialScenario: 'live-group-chain' });
    const base = controller.getState();
    const [first, ...rest] = base.solutions;
    vi.spyOn(controller, 'getState').mockReturnValue({ ...base, solutions: [{ ...first, stats: { ...first.stats, usesWater: true } }, ...rest] });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId(`uses-water-${first.id}`)).toHaveTextContent('Crosses water');
    for (const other of rest) expect(screen.queryByTestId(`uses-water-${other.id}`)).toBeNull();
  });

  it('badges each plan with what its own numbers win, not with what it was aimed at', () => {
    const stats = (blocks: number, newPrecinctSplits: number) => ({
      people: 100, blocks, populatedBlocks: blocks, newPrecinctSplits, healedPrecinctSplits: 0,
      newCountySplits: 0, perimeterDeltaM: 0, districtsTouched: 4, cost: 0,
    });
    const card = (id: string, kind: 'fewest-splits' | 'fewest-blocks', blocks: number, splits: number) =>
      ({ id, kind, stats: stats(blocks, splits), borderFlows: [], deviations: [] });
    // The plan aimed at few blocks moves more blocks than its sibling, which wins both measures.
    const badges = solutionBadges([card('a', 'fewest-splits', 29, 2), card('b', 'fewest-blocks', 73, 5)]);
    expect(badges.get('a')).toEqual(['Fewest new splits', 'Fewest blocks']);
    expect(badges.get('b')).toEqual([]);
    // A measure every plan ties on (districts touched here) is never badged; a lone card gets none.
    expect([...badges.values()].flat()).not.toContain('Fewest districts');
    expect(solutionBadges([card('a', 'fewest-splits', 29, 2)]).get('a')).toEqual([]);
  });

  it('renders every solve status: loading-data, solving, needs-precinct-rework, group-unbalanced, error', () => {
    const controller = new MockController({ initialScenario: 'loading-data' });
    render(<Panel controller={controller} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '64');

    act(() => controller.setScenario('solving'));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '48');

    act(() => controller.setScenario('needs-precinct-rework'));
    expect(screen.getByText(/Needs precinct-level rework/i)).toBeInTheDocument();

    act(() => controller.setScenario('group-unbalanced'));
    expect(screen.getByText(/Group cannot balance on its own/i)).toBeInTheDocument();

    act(() => controller.setScenario('solve-error'));
    expect(screen.getByText(/Solver error/i)).toBeInTheDocument();
  });

  it('dispatches cancel-solve during a long solve and returns to idle', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'long-solve',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    const cancelBtn = screen.getByTestId('cancel-solve-btn');
    expect(cancelBtn).toBeEnabled();

    await user.click(cancelBtn);
    expect(actions).toContainEqual({ type: 'cancel-solve' });
    expect(screen.queryByTestId('cancel-solve-btn')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Find balancing plans/i })).toBeEnabled();
  });

  it('renders two-way trades as one trade on plan cards and in the interaction view, with number-derived badges', () => {
    const controller = new MockController({ initialScenario: 'live-twoway-26' });
    render(<Panel controller={controller} />);

    // Plan 1 (fewest-splits) actually has fewer blocks (78) than Plan 2 (fewest-blocks, 84)
    const plan1 = screen.getByTestId('solution-card-twoway-plan-1');
    expect(plan1).toHaveTextContent('Plan 1');
    expect(plan1).toHaveTextContent('Fewest new splits');
    expect(plan1).toHaveTextContent('Fewest blocks');

    const plan2 = screen.getByTestId('solution-card-twoway-plan-2');
    expect(plan2).not.toHaveTextContent('Fewest blocks');

    const plan3 = screen.getByTestId('solution-card-twoway-plan-3');
    expect(plan3).toHaveTextContent('Fewest districts');

    // Two-way trade 9 ⇄ 8 renders as a single trade pill with both amounts and net
    const twoWayPill = within(plan1).getByTestId('flow-twoway-8-9');
    expect(twoWayPill).toHaveTextContent(/2-way/i);
    expect(twoWayPill).toHaveTextContent(/9→8\s*25/);
    expect(twoWayPill).toHaveTextContent(/8→9\s*23/);
    expect(twoWayPill).toHaveTextContent(/net 9→8\s*2/);

    // Interaction view renders a unified two-way trade arrow group, not overlapping one-way arrows
    const svg = screen.getByTestId('interaction-svg');
    expect(within(svg).getByTestId('flow-twoway-8-9')).toBeInTheDocument();
    expect(within(svg).queryByTestId('flow-arrow-9-8')).not.toBeInTheDocument();
    expect(within(svg).queryByTestId('flow-arrow-8-9')).not.toBeInTheDocument();

    // Hovering the 8-9 border edge displays both legs and the net in the readout
    fireEvent.mouseEnter(within(svg).getByTestId('border-edge-8-9'));
    const readout = screen.getByTestId('interaction-readout');
    expect(readout).toHaveTextContent(/2-way/i);
    expect(readout).toHaveTextContent(/25/);
    expect(readout).toHaveTextContent(/23/);
    expect(readout).toHaveTextContent(/net 9→8\s*2/);
  });

  it('mounts the mini-map slot outside a walkthrough when state.mapMode === "mini"', () => {
    const cleanup = vi.fn();
    const renderMiniMap = vi.fn((container: HTMLElement) => {
      const node = document.createElement('div');
      node.textContent = 'Preview MapLibre Canvas';
      container.appendChild(node);
      return cleanup;
    });

    const controller = new MockController({ initialScenario: 'mini-map-options' });
    const { unmount } = render(<Panel controller={controller} renderMiniMap={renderMiniMap} />);

    expect(screen.getByTestId('minimap-slot')).toHaveTextContent('Preview MapLibre Canvas');
    expect(renderMiniMap).toHaveBeenCalledTimes(1);

    // Hovering a border updates the preview caption
    const edge = screen.getByTestId('border-edge-4-7');
    fireEvent.mouseLeave(screen.getByTestId('solution-card-plan-splits'));
    fireEvent.mouseEnter(edge);
    expect(screen.getByText(/Border 4 ↔ 7/)).toBeInTheDocument();

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('Panel — walkthrough, live ticks, Esc, mini-map slot & CSV drop', () => {
  it('renders shattered vs whole-precinct wording, reacts to ticks, shows commit reminder, advances, and ends on Esc', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'walkthrough-live',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);

    // Step 2 of 4: shattered precinct wording
    expect(screen.getByTestId('step-instruction')).toHaveTextContent(
      /Step 2 of 4: with Block paint on, click the outlined precinct to shatter it, then paint the 4 highlighted blocks into District 7/i,
    );
    expect(screen.getByTestId('walkthrough-block-1')).toHaveTextContent('Done');
    expect(screen.getByTestId('walkthrough-block-2')).toHaveTextContent('To paint');

    // Tick remaining 3 blocks in step 2 -> should show commit reminder
    act(() => {
      controller.tickNextBlock();
      controller.tickNextBlock();
      controller.tickNextBlock();
    });
    expect(screen.getByTestId('walkthrough-block-4')).toHaveTextContent('Done');
    expect(screen.getByTestId('commit-reminder')).toHaveTextContent(/Click DRA's checkmark to commit/i);

    // Click Next -> advances to step 3 (whole-precinct wording!)
    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(actions).toContainEqual({ type: 'walkthrough-next' });
    expect(screen.getByTestId('step-instruction')).toHaveTextContent(/Precinct paint/i);
    expect(screen.getByTestId('step-instruction')).toHaveTextContent(/no shattering needed/i);

    // Zoom & Back buttons
    await user.click(screen.getByRole('button', { name: /Zoom to step/i }));
    expect(actions).toContainEqual({ type: 'walkthrough-zoom' });

    await user.click(screen.getByRole('button', { name: /Back/i }));
    expect(actions).toContainEqual({ type: 'walkthrough-back' });

    // Esc ends the walkthrough
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(actions).toContainEqual({ type: 'walkthrough-end' });
    expect(screen.queryByTestId('step-instruction')).not.toBeInTheDocument();
  });

  it('dispatches walkthrough-jump when clicking a step in the border/precinct outline', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'walkthrough-live',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    const step4Btn = screen.getByTestId('outline-step-3');
    await user.click(step4Btn);

    expect(actions).toContainEqual({ type: 'walkthrough-jump', index: 3 });
    expect(screen.getByTestId('step-instruction')).toHaveTextContent(/Step 4 of 4/i);
  });

  it('guides the user through both legs of a two-way trade without alarming between legs', () => {
    const controller = new MockController({ initialScenario: 'walkthrough-twoway' });
    render(<Panel controller={controller} />);

    // Up-front notice on Leg 1 explains two-way trade, order, and temporary overshoot
    const notice = screen.getByTestId('twoway-trade-notice');
    expect(notice).toHaveTextContent(/Two-way trade/i);
    expect(notice).toHaveTextContent(/Leg 1 of 2/i);
    expect(notice).toHaveTextContent(/Paint Leg 1 before Leg 2/i);
    expect(notice).toHaveTextContent(/temporarily look further from zero/i);

    // Outline unifies both legs under one two-way border group
    expect(screen.getByTestId('outline-twoway-8-9')).toBeInTheDocument();

    // Tick all blocks & commits of Leg 1 (step 1: 2 blocks + commit, step 2: 1 block + commit)
    act(() => {
      controller.tickNextBlock(); // block 1 (8)
      controller.tickNextBlock(); // block 2 (6) -> awaiting commit
      controller.tickNextBlock(); // commit step 1 -> step 2
      controller.tickNextBlock(); // block 1 (11) -> awaiting commit
      controller.tickNextBlock(); // commit step 2 -> step 3 (Leg 2!)
    });

    // Between legs: D9 is -23, D8 is +23, both marked calmly as mid-trade
    const chip9 = screen.getByTestId('live-chip-9');
    const chip8 = screen.getByTestId('live-chip-8');
    expect(chip9).toHaveAttribute('data-mid-trade', 'true');
    expect(chip8).toHaveAttribute('data-mid-trade', 'true');
    expect(chip9).toHaveTextContent(/−23/);
    expect(chip8).toHaveTextContent(/\+23/);
    expect(screen.getByTestId('mid-trade-status')).toHaveTextContent(/Between legs/i);
    expect(screen.getByTestId('twoway-trade-notice')).toHaveTextContent(/Leg 2 of 2/i);

    // Tick all blocks & commits of Leg 2 (step 3: 2 blocks + commit, step 4: 2 blocks + commit)
    act(() => {
      controller.tickNextBlock();
      controller.tickNextBlock();
      controller.tickNextBlock();
      controller.tickNextBlock();
      controller.tickNextBlock();
      controller.tickNextBlock();
    });

    // Both reach 0 ✓ and final check passes
    expect(screen.getByTestId('live-chip-9')).not.toHaveAttribute('data-mid-trade');
    expect(screen.getByTestId('live-chip-9')).toHaveTextContent('0 ✓');
    expect(screen.getByTestId('live-chip-8')).toHaveTextContent('0 ✓');
    expect(screen.getByTestId('final-check-card')).toHaveTextContent(/Final check passed/i);
  });

  it('shows stray edit warnings and dispatches walkthrough-replan', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'walkthrough-stray-edit',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    expect(screen.getByTestId('stray-edits-banner')).toHaveTextContent(/2 stray edits detected/i);

    await user.click(screen.getByRole('button', { name: /Re-plan from here/i }));
    expect(actions).toContainEqual({ type: 'walkthrough-replan' });
    expect(screen.queryByTestId('stray-edits-banner')).not.toBeInTheDocument();
  });

  it('mounts shell-supplied mini-map renderer when mapMode === "mini", calls cleanup, and notes liveTicking off', () => {
    const cleanup = vi.fn();
    const renderMiniMap = vi.fn((container: HTMLElement) => {
      const marker = document.createElement('div');
      marker.textContent = 'Injected MapLibre Canvas';
      container.appendChild(marker);
      return cleanup;
    });

    const controller = new MockController({ initialScenario: 'walkthrough-mini-map' });
    const { unmount } = render(<Panel controller={controller} renderMiniMap={renderMiniMap} />);

    expect(screen.getByTestId('live-ticking-off')).toHaveTextContent(/Live ticking is off/i);
    expect(screen.getByTestId('minimap-slot')).toHaveTextContent('Injected MapLibre Canvas');
    expect(renderMiniMap).toHaveBeenCalledTimes(1);

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('renders final check confirmation and handles unverified CSV finalCheck.ok === null', () => {
    const controller = new MockController({ initialScenario: 'walkthrough-final-check' });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('final-check-card')).toHaveTextContent(/Final check passed/i);

    act(() => controller.setScenario('walkthrough-csv-final-check'));
    const csvFinal = screen.getByTestId('final-check-card');
    expect(csvFinal).toHaveTextContent(/not verified in DRA/i);
    expect(csvFinal).not.toHaveTextContent(/confirmed against DRA/i);
    expect(csvFinal).not.toHaveTextContent(/remaining deviation/i);
    expect(within(csvFinal).queryByRole('button', { name: /Re-plan from here/i })).not.toBeInTheDocument();
  });

  it('dispatches load-csv when a CSV file is dropped onto the drop zone', async () => {
    const actions: PanelAction[] = [];
    const controller = new MockController({
      initialScenario: 'hook-failed',
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    const dropzone = screen.getByTestId('csv-dropzone');
    const csvContent = 'GEOID20,District\n360610001001000,13\n360610001001001,12\n';
    const file = new File([csvContent], 'ny-plan.csv', { type: 'text/csv' });

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => {
      expect(actions).toContainEqual({
        type: 'load-csv',
        text: csvContent,
        fileName: 'ny-plan.csv',
      });
    });
  });

  it('opens About view with DRA CC BY-SA 4.0 credit, Census public domain, and privacy statement', async () => {
    const user = userEvent.setup();
    const controller = new MockController({ initialScenario: 'live-single' });
    render(<Panel controller={controller} />);

    await user.click(screen.getByRole('button', { name: 'About' }));
    const about = screen.getByTestId('about-view');
    expect(about).toHaveTextContent(/CC BY-SA 4\.0/i);
    expect(about).toHaveTextContent(/public domain/i);
    expect(about).toHaveTextContent(/Your plan never leaves your browser/i);

    await user.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.queryByTestId('about-view')).not.toBeInTheDocument();
  });

  it('supports mountPanel(element, controller, options) lifecycle', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const renderMiniMap = vi.fn();
    const controller = new MockController({ initialState: SCENARIOS['walkthrough-mini-map'].createState() });

    let unmount!: () => void;
    act(() => {
      unmount = mountPanel(host, controller, { renderMiniMap });
    });

    expect(host.textContent).toContain('Zero Deviation');
    expect(renderMiniMap).toHaveBeenCalledTimes(1);

    act(() => {
      unmount();
    });
    expect(host.innerHTML).toBe('');
    host.remove();
  });
});

describe('Panel — paint the step for me (opt-in)', () => {
  it('is absent unless the controller offers it, and shows the one-sentence explanation', () => {
    const plain = new MockController({ initialScenario: 'walkthrough-live' });
    const { unmount } = render(<Panel controller={plain} />);
    expect(screen.queryByTestId('auto-paint')).not.toBeInTheDocument();
    unmount();

    const base = SCENARIOS['walkthrough-live'].createState();
    const controller = new MockController({ initialState: { ...base, autoPaint: { available: true, enabled: false } } });
    render(<Panel controller={controller} />);
    const toggle = screen.getByRole('checkbox', { name: /Paint steps for me/i });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(screen.getByTestId('auto-paint')).toHaveTextContent(/has DRA paint that one step's blocks for you/i);
    // Off: no paint button; the by-hand instructions are there as always.
    expect(screen.queryByTestId('paint-step-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-instruction')).toHaveTextContent(/click the outlined precinct to shatter it/i);
  });

  it('turning it on dispatches set-auto-paint and shows "Paint this step"; clicking paints with a busy state, then the step ticks', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const base = SCENARIOS['walkthrough-live'].createState();
    const controller = new MockController({ initialState: { ...base, autoPaint: { available: true, enabled: false } }, onAction: (a) => actions.push(a), paintDelayMs: 30 });
    render(<Panel controller={controller} />);
    await user.click(screen.getByRole('checkbox', { name: /Paint steps for me/i }));
    expect(actions).toContainEqual({ type: 'set-auto-paint', enabled: true });

    const btn = screen.getByTestId('paint-step-btn');
    expect(btn).toHaveTextContent('Paint this step');
    expect(screen.getByTestId('paint-step-what')).toHaveTextContent(/Moves the 4 highlighted blocks .* into District 7; no shattering or checkmark needed/i);
    expect(screen.getByText(/Or paint it by hand as described above/i)).toBeInTheDocument();
    // The by-hand instructions stay.
    expect(screen.getByTestId('step-instruction')).toHaveTextContent(/Block paint/i);

    await user.click(btn);
    expect(actions).toContainEqual({ type: 'walkthrough-paint-step' });
    expect(screen.getByTestId('paint-step-btn')).toHaveTextContent('Painting…');
    expect(screen.getByTestId('paint-step-btn')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Paint steps for me/i })).toBeDisabled();

    // Done: step 2 ticked, the walkthrough moved on to step 3 (a whole precinct).
    await waitFor(() => expect(screen.getByTestId('step-instruction')).toHaveTextContent(/Precinct paint/i));
    expect(screen.getByTestId('outline-step-1')).toHaveTextContent('✓');
    expect(screen.getByTestId('paint-step-btn')).toHaveTextContent('Paint this step');
    expect(screen.getByTestId('paint-step-what')).toHaveTextContent(/Moves the whole precinct/i);
  });

  it('a refusal reads next to the button and the setting stays on', () => {
    const base = SCENARIOS['walkthrough-live'].createState();
    const controller = new MockController({ initialState: { ...base, autoPaint: { available: true, enabled: true, reason: 'Not painted: District 7 is locked in DRA. Unlock it in DRA to paint into it.' } } });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('paint-step-note')).toHaveTextContent(/District 7 is locked in DRA/i);
    expect(screen.getByRole('checkbox', { name: /Paint steps for me/i })).toBeChecked();
    expect(screen.getByTestId('paint-step-btn')).toBeEnabled();
  });

  it('awaiting commit: the button is disabled with the commit hint; the checkmark reminder stays', () => {
    const base = SCENARIOS['walkthrough-awaiting-commit'].createState();
    const controller = new MockController({ initialState: { ...base, autoPaint: { available: true, enabled: true } } });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('commit-reminder')).toBeInTheDocument();
    expect(screen.getByTestId('paint-step-btn')).toBeDisabled();
    expect(screen.getByTestId('paint-step-blocked')).toHaveTextContent(/commit the shattered precinct with DRA's checkmark/i);
  });

  it('two-way trade: Leg 2 cannot be painted before Leg 1, and the trade guidance still reads', async () => {
    const user = userEvent.setup();
    const controller = new MockController({ initialScenario: 'walkthrough-auto-paint-twoway', paintDelayMs: 10 });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('twoway-trade-notice')).toHaveTextContent(/Leg 2 of 2/i);
    expect(screen.getByTestId('paint-step-btn')).toBeDisabled();
    expect(screen.getByTestId('paint-step-blocked')).toHaveTextContent(/Paint Leg 1 first \(Step 1\)/i);

    // Go to Leg 1 and paint it step by step; then Leg 2 is paintable.
    await user.click(screen.getByRole('button', { name: /Go to Leg 1/i }));
    expect(screen.getByTestId('twoway-trade-notice')).toHaveTextContent(/Leg 1 of 2/i);
    await user.click(screen.getByTestId('paint-step-btn'));
    await waitFor(() => expect(screen.getByTestId('outline-step-0')).toHaveTextContent('✓'));
    await waitFor(() => expect(screen.getByTestId('paint-step-btn')).toBeEnabled());
    await user.click(screen.getByTestId('paint-step-btn'));
    await waitFor(() => expect(screen.getByTestId('outline-step-1')).toHaveTextContent('✓'));
    await waitFor(() => expect(screen.getByTestId('twoway-trade-notice')).toHaveTextContent(/Leg 2 of 2/i));
    expect(screen.getByTestId('paint-step-btn')).toBeEnabled();
    expect(screen.queryByTestId('paint-step-blocked')).not.toBeInTheDocument();
  });

  it('unavailable: the setting is disabled with the reason', () => {
    const controller = new MockController({ initialScenario: 'walkthrough-auto-paint-unavailable' });
    render(<Panel controller={controller} />);
    const toggle = screen.getByRole('checkbox', { name: /Paint steps for me/i });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('auto-paint-unavailable')).toHaveTextContent(/read-only/i);
    expect(screen.queryByTestId('paint-step-btn')).not.toBeInTheDocument();
  });

  it('a paint that did something else: switched off, the difference and the undo advice are shown', () => {
    const controller = new MockController({ initialScenario: 'walkthrough-auto-paint-mismatch' });
    render(<Panel controller={controller} />);
    expect(screen.getByRole('checkbox', { name: /Paint steps for me/i })).not.toBeChecked();
    const why = screen.getByTestId('auto-paint-unavailable');
    expect(why).toHaveTextContent(/did not do what was asked/i);
    expect(why).toHaveTextContent(/not part of this step/i);
    expect(why).toHaveTextContent(/DRA's own Undo/i);
    expect(screen.queryByTestId('paint-step-btn')).not.toBeInTheDocument();
  });
});

describe('Panel — town splits on option cards', () => {
  it('shows town splits next to county splits only when the card has them', () => {
    const controller = new MockController({ initialScenario: 'live-single' });
    render(<Panel controller={controller} />);
    const withTowns = screen.getByTestId('solution-card-opt-1');
    expect(within(withTowns).getByTestId('town-splits-opt-1')).toHaveTextContent(/Town splits\s*\+1/);
    const without = screen.getByTestId('solution-card-opt-2');
    expect(within(without).queryByText(/Town splits/i)).not.toBeInTheDocument();
    expect(within(without).getByText(/County splits/i)).toBeInTheDocument();
  });
});

describe('Panel — choosing which neighbor trades with one district', () => {
  it('over district: says who gives to whom, lists neighbors with now → if it takes all, and picks one', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);

    const chooser = screen.getByTestId('neighbor-chooser');
    expect(within(chooser).getByText('Give to')).toBeInTheDocument();
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 13 gives 412 people to any neighbor; the solver picks which.');
    expect(screen.getByTestId('chooser-any')).toHaveAttribute('aria-pressed', 'true');
    // D13 neighbors [10, 12, 15, 16]; each row shows its deviation now and if it took all 412.
    expect(screen.getByTestId('chooser-row-12')).toHaveTextContent(/District 12\s*−380\s*→\s*\+32/);
    expect(screen.getByTestId('chooser-row-16')).toHaveTextContent(/−275\s*→\s*\+137/);
    expect(screen.getByTestId('chooser-row-10')).toHaveTextContent(/\+260\s*→\s*\+672/);
    expect(screen.getByTestId('chooser-row-10')).toHaveTextContent('further from zero');
    expect(screen.getByTestId('chooser-row-12')).not.toHaveTextContent('further from zero');
    // Most helped first.
    const rows = within(chooser).getAllByRole('checkbox');
    expect(rows[0]).toHaveAccessibleName('Give to District 12');

    await user.click(screen.getByRole('checkbox', { name: 'Give to District 12' }));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-scope', scope: { mode: 'one', district: 13, with: [12] } });
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 13 gives 412 people to District 12 only.');
    expect(screen.getByTestId('chooser-any')).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('checkbox', { name: 'Give to District 16' }));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-scope', scope: { mode: 'one', district: 13, with: [12, 16] } });
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 13 gives 412 people to District 12 and District 16');

    // The choice survives a re-solve, and the options only touch the chosen neighbors.
    await user.click(screen.getByRole('button', { name: /Find zeroing options/i }));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13, with: [12, 16] });
    const touched = new Set(controller.getState().solutions.flatMap((c) => c.borderFlows.flatMap((f) => [f.from, f.to])));
    expect([...touched].sort((a, b) => a - b)).toEqual([12, 13, 16]);
    expect(screen.getByRole('checkbox', { name: 'Give to District 12' })).toBeChecked();
  });

  it('under district: says it takes from, and the neighbor gives the whole difference', async () => {
    const controller = new MockController({ initialScenario: 'live-single-take-from' });
    render(<Panel controller={controller} />);
    const chooser = screen.getByTestId('neighbor-chooser');
    expect(within(chooser).getByText('Take from')).toBeInTheDocument();
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 5 takes 680 people from District 4 only.');
    // D4 is +410; giving 680 leaves it at −270 (closer to zero, so no warning).
    expect(screen.getByTestId('chooser-row-4')).toHaveTextContent(/\+410\s*→\s*−270/);
    expect(screen.getByRole('checkbox', { name: 'Take from District 4' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Take from District 3' })).not.toBeChecked();
    expect(screen.queryByTestId('chooser-worse-note')).toBeNull();
    // Cards show the direction: 4 → 5.
    const card = screen.getByTestId('solution-card-opt-5-to-4');
    expect(card).toHaveTextContent(/District 4:\s*\+410\s*→\s*−270/);
  });

  it('a chosen neighbor that ends further from zero is allowed and said so', () => {
    const controller = new MockController({ initialScenario: 'live-single-chosen-further' });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('chooser-worse-note')).toHaveTextContent('District 10 may end further from zero than now. Allowed, because you picked it.');
  });

  it('"Any neighbor" clears the choice', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single-give-to', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 13 gives 412 people to District 12 and District 16');
    await user.click(screen.getByTestId('chooser-any'));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-scope', scope: { mode: 'one', district: 13 } });
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('any neighbor');
    for (const cb of within(screen.getByTestId('neighbor-chooser')).getAllByRole('checkbox')) expect(cb).not.toBeChecked();
  });

  it('resets when another district is selected, keeps the choice when the same one is clicked again', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single-give-to', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);
    const list = screen.getByRole('region', { name: /District population list/i });
    const rowOf = (name: string) => within(list).getAllByRole('button').find((b) => b.textContent?.includes(name))!;

    await user.click(rowOf('District 13'));
    expect(actions).toHaveLength(0);
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13, with: [12, 16] });

    await user.click(rowOf('District 5'));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-scope', scope: { mode: 'one', district: 5 } });
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 5 takes 680 people from any neighbor');
  });

  it('a chosen district that is no longer a neighbor is not shown as chosen', () => {
    const controller = new MockController({ initialScenario: 'live-single' });
    const base = controller.getState();
    const districts = base.districts.map((d) => (d.index === 13 ? { ...d, neighbors: [10, 15, 16] } : d));
    vi.spyOn(controller, 'getState').mockReturnValue({ ...base, districts, scope: { mode: 'one', district: 13, with: [12] } });
    render(<Panel controller={controller} />);
    expect(screen.queryByTestId('chooser-row-12')).toBeNull();
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('any neighbor');
  });

  it('is not shown for a district already at zero, or outside one-district mode', () => {
    const controller = new MockController({ initialScenario: 'live-single' });
    const base = controller.getState();
    const spy = vi.spyOn(controller, 'getState').mockReturnValue({ ...base, scope: { mode: 'one', district: 7 } });
    const { unmount } = render(<Panel controller={controller} />);
    expect(screen.queryByTestId('neighbor-chooser')).toBeNull();
    unmount();
    spy.mockRestore();
    render(<Panel controller={new MockController({ initialScenario: 'live-group-chain' })} />);
    expect(screen.queryByTestId('neighbor-chooser')).toBeNull();
  });
});

describe('Panel — steps and reach on cards', () => {
  it('shows the number of walkthrough steps on option and plan cards, and badges the fewest', () => {
    const controller = new MockController({ initialScenario: 'live-single' });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('steps-opt-1')).toHaveTextContent(/Steps to paint\s*2/);
    expect(screen.getByTestId('cta-steps-opt-4')).toHaveTextContent('5 steps');
    const badges = (id: string) => within(screen.getByTestId(`solution-card-${id}`)).queryByLabelText('Plan highlights')?.textContent ?? '';
    expect(badges('opt-1')).toContain('Fewest steps');
    expect(badges('opt-3')).toContain('Fewest steps');
    expect(badges('opt-2')).not.toContain('Fewest steps');
  });

  it('whole-map plans say how long the walkthrough is before it starts', () => {
    const controller = new MockController({ initialScenario: 'live-whole-map-26' });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('cta-steps-whole-splits')).toHaveTextContent('79 steps');
    expect(screen.getByTestId('steps-whole-blocks')).toHaveTextContent('64');
  });

  it('Fewest steps comes from the cards\' numbers, and only when every card has them', () => {
    const stats = (steps?: number) => ({
      people: 100, blocks: 10, populatedBlocks: 10, newPrecinctSplits: 1, healedPrecinctSplits: 0,
      newCountySplits: 0, perimeterDeltaM: 0, districtsTouched: 2, cost: 0, ...(steps === undefined ? {} : { steps }),
    });
    const card = (id: string, steps?: number) => ({ id, kind: 'single' as const, stats: stats(steps), borderFlows: [], deviations: [] });
    const b = solutionBadges([card('a', 12), card('b', 3)]);
    expect(b.get('b')).toEqual(['Fewest steps']);
    expect(b.get('a')).toEqual([]);
    expect([...solutionBadges([card('a', 12), card('b')]).values()].flat()).not.toContain('Fewest steps');
    expect([...solutionBadges([card('a', 3), card('b', 3)]).values()].flat()).not.toContain('Fewest steps');
  });

  it('says so on the card when an option reaches further than a compact bite of the border', () => {
    const controller = new MockController({ initialScenario: 'live-single' });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('long-reach-opt-4')).toHaveTextContent(/Long reach/);
    expect(screen.queryByTestId('long-reach-opt-1')).toBeNull();
  });

  it('a card without a step count shows no steps cell', () => {
    const controller = new MockController({ initialScenario: 'live-single' });
    const base = controller.getState();
    const [first, ...rest] = base.solutions;
    const { steps: _drop, ...noSteps } = first.stats;
    void _drop;
    vi.spyOn(controller, 'getState').mockReturnValue({ ...base, solutions: [{ ...first, stats: noSteps }, ...rest] });
    render(<Panel controller={controller} />);
    expect(screen.queryByTestId(`steps-${first.id}`)).toBeNull();
    expect(screen.getByTestId(`steps-${rest[0].id}`)).toBeInTheDocument();
  });
});

describe('Panel — locking finished districts', () => {
  it('locks a district from its row, takes it off the neighbor choice, and unlocks it again', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);

    // District 13 trades with 12 only; then 12 is locked.
    await user.click(screen.getByRole('checkbox', { name: 'Give to District 12' }));
    await user.click(screen.getByRole('button', { name: 'Lock District 12' }));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-district-lock', districts: [12], locked: true });
    // Locking is not selecting: District 13 is still the one being zeroed.
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13 });
    expect(controller.getState().lockedDistricts).toEqual([12]);

    expect(screen.queryByTestId('chooser-row-12')).not.toBeInTheDocument();
    expect(screen.getByTestId('chooser-locked-note')).toHaveTextContent('District 12 is locked and is left out.');
    expect(screen.getByTestId('lock-bar')).toHaveTextContent('1 locked');

    // A locked row cannot be picked as the district to zero.
    const list = screen.getByRole('region', { name: /District population list/i });
    await user.click(within(list).getByText('District 12'));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13 });

    await user.click(screen.getByRole('button', { name: 'Unlock District 12' }));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-district-lock', districts: [12], locked: false });
    expect(screen.getByTestId('chooser-row-12')).toBeInTheDocument();
  });

  it('whole map and group leave locked districts out; "Unlock all" brings them back', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);

    await user.click(screen.getByRole('button', { name: 'Lock District 10' }));
    await user.click(screen.getByRole('button', { name: 'Whole map' }));
    const total = controller.getState().districts.length;
    expect(screen.getByText(`Whole map (${total - 1} of ${total} districts)`)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select District 10' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select District 10' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select District 12' })).toBeChecked();

    // Group: "Add neighbors" skips the locked one (District 13 touches 10, 12, 15, 16).
    await user.click(screen.getByRole('button', { name: 'One district' }));
    await user.click(screen.getByRole('button', { name: 'Group' }));
    const start = (controller.getState().scope as { districts: number[] }).districts[0];
    const nbrs = controller.getState().districts.find((d) => d.index === start)!.neighbors!;
    await user.click(screen.getByRole('button', { name: /Add neighbors/i }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'group', districts: [start, ...nbrs.filter((d) => d !== 10)].sort((a, b) => a - b), allowOutsideAbsorb: false },
    });

    await user.click(screen.getByTestId('unlock-all'));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-district-lock', districts: [10], locked: false });
    expect(controller.getState().lockedDistricts).toEqual([]);
  });

  it('"Lock the N at zero" locks every finished district at once', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single', onAction: (a) => actions.push(a) });
    const state = controller.getState();
    const target = state.map!.target;
    const zeroed = [3, 7];
    controller.setState({ ...state, districts: state.districts.map((d) => (zeroed.includes(d.index) ? { ...d, pop: target, deviation: 0 } : d)) });
    render(<Panel controller={controller} />);

    const already = controller.getState().districts.filter((d) => d.deviation === 0).map((d) => d.index).sort((a, b) => a - b);
    await user.click(screen.getByTestId('lock-zeroed'));
    const last = actions[actions.length - 1] as Extract<PanelAction, { type: 'set-district-lock' }>;
    expect(last.type).toBe('set-district-lock');
    expect(last.locked).toBe(true);
    expect([...last.districts].sort((a, b) => a - b)).toEqual(already);
    expect(screen.getByRole('button', { name: 'Unlock District 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('lock-zeroed')).not.toBeInTheDocument();
  });
});
