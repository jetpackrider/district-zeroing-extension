import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelAction } from '@zd/contracts';
import { MockController, Panel, SCENARIOS, mountPanel } from '../src';
import { UNASSIGNED_COLOR, formatDistrictName, formatDistrictShort, getDistrictColor, solutionBadges } from '../src/format';

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

describe('Panel — Unassigned (a map still being drawn)', () => {
  const noDistrictZero = () => expect(document.body.textContent ?? '').not.toMatch(/District 0\b/);

  it('names district 0 "Unassigned" everywhere, with a neutral grey swatch', () => {
    const districts = SCENARIOS['live-drawing-unassigned'].createState().districts;
    expect(formatDistrictName(0, districts)).toBe('Unassigned');
    expect(formatDistrictShort(0, districts)).toBe('Unassigned');
    expect(getDistrictColor(0, districts)).toBe(UNASSIGNED_COLOR);
    expect(formatDistrictName(1, districts)).toBe('District 1');
  });

  it('over district whose only unlocked neighbor is Unassigned: offers it, explains the default, and picks it', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-drawing-unassigned', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);

    const chooser = screen.getByTestId('neighbor-chooser');
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent(
      'District 1 gives 583 people to Unassigned, the only neighbor that is not locked.',
    );
    // Unassigned shows its population now → after, not a deviation, and never "further from zero".
    const row = screen.getByTestId('chooser-row-0');
    expect(row).toHaveTextContent(/Unassigned\s*pop\s*249,837\s*→\s*250,420/);
    expect(row).not.toHaveTextContent('further from zero');
    expect(screen.getByTestId('chooser-locked-note')).toHaveTextContent('District 2 is locked and is left out.');
    expect(screen.getByTestId('chooser-unassigned-note')).toHaveTextContent(
      '"Any neighbor" includes Unassigned while the map is still being drawn (249,837 people unassigned now).',
    );
    expect(within(chooser).getAllByRole('checkbox')).toHaveLength(1);

    // Locks never apply to Unassigned: its row in the district list has no lock button.
    const listRow = screen.getByTestId('unassigned-row');
    expect(listRow).toHaveTextContent(/Unassigned\s*249,837\s*no target/);
    expect(within(listRow).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Lock Unassigned/i })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Give to Unassigned' }));
    expect(actions[actions.length - 1]).toEqual({ type: 'set-scope', scope: { mode: 'one', district: 1, with: [0] } });
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 1 gives 583 people to Unassigned only.');
    expect(screen.getByRole('checkbox', { name: 'Give to Unassigned' })).toBeChecked();

    // Solving with Unassigned picked: the options move people to it, and deviations leave it out.
    await user.click(screen.getByRole('button', { name: /Find zeroing options/i }));
    const card = screen.getByTestId('solution-card-opt-1-to-0');
    expect(within(card).getByTestId('unassigned-opt-1-to-0')).toHaveTextContent('Leaves 583 more people unassigned.');
    expect(card).toHaveTextContent(/District 1:\s*\+583\s*→\s*0/);
    expect(controller.getState().solutions[0].deviations.map((d) => d.district)).toEqual([1]);
    noDistrictZero();
  });

  it('"Any neighbor" on a map still being drawn includes Unassigned next to real neighbors; a real one closer to zero ranks first', async () => {
    const user = userEvent.setup();
    const base = SCENARIOS['live-drawing-unassigned'].createState();
    // District 3 (−420) touches 0, 2 (locked) and 4 (−250,000, pushed further by giving).
    const controller = new MockController({ initialState: { ...base, scope: { mode: 'one', district: 3 }, solutions: [] } });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent(
      'District 3 takes 420 people from any neighbor, Unassigned included; the solver picks which.',
    );
    expect(screen.getByTestId('chooser-row-0')).toHaveTextContent(/249,837\s*→\s*249,417/);
    expect(screen.getByTestId('chooser-row-4')).toHaveTextContent('further from zero');
    // Unassigned (effect zero) sits before a neighbor that ends further from zero.
    let boxes = within(screen.getByTestId('neighbor-chooser')).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['Take from Unassigned', 'Take from District 4']);

    // …and after a real neighbor that the move brings closer to zero.
    act(() => {
      const s = controller.getState();
      controller.setState({
        ...s,
        lockedDistricts: [],
        districts: s.districts.map((d) => (d.index === 2 ? { ...d, pop: d.pop + 300, deviation: 300 } : d)),
      });
    });
    boxes = within(screen.getByTestId('neighbor-chooser')).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Take from District 2',
      'Take from Unassigned',
      'Take from District 4',
    ]);

    // Picking a real neighbor and Unassigned reads naturally, Unassigned last.
    await user.click(screen.getByRole('checkbox', { name: 'Take from Unassigned' }));
    await user.click(screen.getByRole('checkbox', { name: 'Take from District 2' }));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 3, with: [0, 2] });
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent(
      'District 3 takes 420 people from District 2 and Unassigned, split between them as the solver finds best.',
    );
    noDistrictZero();
  });

  it('finished map still touching empty unassigned blocks: offered, used only when picked, with a note', async () => {
    const user = userEvent.setup();
    const controller = new MockController({ initialScenario: 'live-finished-unassigned-adjacent' });
    render(<Panel controller={controller} />);
    expect(controller.getState().unassigned).toBeUndefined();
    expect(screen.queryByTestId('unassigned-row')).toBeNull();
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 1 gives 583 people to any neighbor; the solver picks which.');
    expect(screen.getByTestId('chooser-row-0')).toHaveTextContent(/pop\s*0\s*→\s*583/);
    expect(screen.getByTestId('chooser-unassigned-note')).toHaveTextContent(
      'No people are unassigned, so "Any neighbor" leaves Unassigned out. Picking it leaves 583 people unassigned.',
    );

    // "Any neighbor" here solves with District 2, not Unassigned.
    await user.click(screen.getByRole('button', { name: /Find zeroing options/i }));
    expect(controller.getState().solutions.flatMap((c) => c.borderFlows.map((f) => f.to))).toEqual([2]);

    await user.click(screen.getByRole('checkbox', { name: 'Give to Unassigned' }));
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 1 gives 583 people to Unassigned only.');
    expect(screen.getByTestId('chooser-unassigned-note')).toHaveTextContent('This leaves 583 people unassigned on a map that had none.');

    // Every real neighbor locked: the summary says to pick Unassigned rather than "any neighbor".
    act(() => controller.dispatch({ type: 'set-district-lock', districts: [2], locked: true }));
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent(
      'District 1 gives 583 people to Unassigned only.',
    );
    act(() => controller.dispatch({ type: 'set-scope', scope: { mode: 'one', district: 1 } }));
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent(
      'Every district next to District 1 is locked. Pick Unassigned to give them to unassigned blocks.',
    );
    // A lock on 0 is never taken.
    act(() => controller.dispatch({ type: 'set-district-lock', districts: [0], locked: true }));
    expect(controller.getState().lockedDistricts).toEqual([2]);
  });

  it('cards and plan flows name Unassigned and say what a plan does to it', () => {
    const controller = new MockController({ initialScenario: 'live-drawing-unassigned' });
    const base = controller.getState();
    const takeOnly = {
      ...base.solutions[0],
      id: 'take-only',
      borderFlows: [{ from: 0, to: 3, people: 420 }],
      // A stray 0 in deviations is never shown.
      deviations: [{ district: 3, before: -420, after: 0 }, { district: 0, before: 0, after: 0 }],
    };
    const plan = SCENARIOS['walkthrough-unassigned'].createState().solutions[0];
    controller.setState({ ...base, solutions: [...base.solutions, takeOnly, plan] });
    render(<Panel controller={controller} />);

    expect(screen.getByTestId('unassigned-draw-opt-1')).toHaveTextContent('Leaves 583 more people unassigned.');
    expect(screen.getByTestId('unassigned-take-only')).toHaveTextContent('Takes 420 people from unassigned blocks.');
    expect(screen.getByTestId('solution-card-take-only')).not.toHaveTextContent(/Unassigned:\s*0\s*→/);

    const planCard = screen.getByTestId(`solution-card-${plan.id}`);
    const flows = within(planCard).getByLabelText('Border transfers');
    expect(flows).toHaveTextContent(/1\s*→\s*Unassigned:\s*583/);
    expect(flows).toHaveTextContent(/Unassigned\s*→\s*3:\s*420/);
    expect(within(planCard).getByTestId(`unassigned-${plan.id}`)).toHaveTextContent('Leaves 163 more people unassigned.');
    const devs = within(planCard).getByLabelText('District deviations before and after');
    expect(devs).toHaveTextContent(/District 1:\s*\+583\s*→\s*0/);
    expect(devs).toHaveTextContent(/District 3:\s*−420\s*→\s*0/);
    expect(devs).not.toHaveTextContent('Unassigned');
    // Cards that never touch Unassigned say nothing about it.
    noDistrictZero();
  });

  it('a card on a complete map has no Unassigned line', () => {
    render(<Panel controller={new MockController({ initialScenario: 'live-single' })} />);
    expect(screen.queryByTestId('unassigned-opt-1')).toBeNull();
    expect(screen.queryByTestId('unassigned-row')).toBeNull();
    expect(screen.queryByTestId('chooser-row-0')).toBeNull();
  });

  it('walkthrough: a step into Unassigned is erasing, a step out of it paints unassigned blocks', async () => {
    const user = userEvent.setup();
    const controller = new MockController({ initialScenario: 'walkthrough-unassigned', paintDelayMs: 20 });
    render(<Panel controller={controller} />);

    const instruction = () => screen.getByTestId('step-instruction');
    expect(instruction()).toHaveTextContent(
      'Step 1 of 3: with Block paint on, click the outlined precinct to shatter it, then with the Eraser erase the 3 highlighted blocks. They become unassigned.',
    );
    expect(instruction()).not.toHaveTextContent(/into/);
    const meta = screen.getByLabelText('Current walkthrough step');
    expect(meta).toHaveTextContent(/District 1\s*→\s*Unassigned/);
    // Unassigned's swatch is neutral grey.
    const swatches = [...meta.querySelectorAll<HTMLElement>('.zd-step-border .zd-swatch')].map((el) => el.style.backgroundColor);
    expect(swatches).toContain('rgb(156, 163, 175)');
    expect(screen.getByText('Blocks to erase')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-block-1')).toHaveTextContent('To erase');
    expect(screen.getByTestId('paint-step-btn')).toHaveTextContent('Erase this step');
    expect(screen.getByTestId('paint-step-what')).toHaveTextContent(
      'Erases the 3 highlighted blocks (383 people), leaving them unassigned; no shattering or checkmark needed.',
    );

    // Erasing a block moves its people into Unassigned.
    act(() => {
      controller.tickNextBlock();
    });
    expect(controller.getState().unassigned).toEqual({ pop: 249837 + 160 });

    // Step 2: the whole precinct is erased.
    await user.click(screen.getByTestId('outline-step-1'));
    expect(instruction()).toHaveTextContent(
      'Step 2 of 3: with Precinct paint on, use the Eraser to erase the whole outlined precinct (32003-0415). Its 200 people become unassigned; no shattering needed.',
    );
    expect(screen.getByTestId('paint-step-what')).toHaveTextContent('Erases the whole precinct 32003-0415 (200 people), leaving it unassigned.');

    // Step 3: unassigned blocks painted into District 3, never "from District 0".
    await user.click(screen.getByTestId('outline-step-2'));
    expect(instruction()).toHaveTextContent(
      'Step 3 of 3: with Block paint on, click the outlined precinct to shatter it, then paint the 2 highlighted unassigned blocks into District 3.',
    );
    expect(screen.getByLabelText('Current walkthrough step')).toHaveTextContent(/Unassigned\s*→\s*District 3/);
    expect(screen.getByTestId('paint-step-btn')).toHaveTextContent('Paint this step');
    await user.click(screen.getByTestId('paint-step-btn'));
    await waitFor(() => expect(controller.getState().unassigned).toEqual({ pop: 249837 + 160 - 420 }));

    // The outline names the borders with Unassigned too.
    const outline = screen.getByLabelText('All walkthrough steps by border');
    expect(outline).toHaveTextContent(/District 1\s*→\s*Unassigned/);
    expect(outline).toHaveTextContent(/Unassigned\s*→\s*District 3/);
    noDistrictZero();
  });

  it('stray edits to or from Unassigned name it', () => {
    const base = SCENARIOS['walkthrough-unassigned'].createState();
    const controller = new MockController({
      initialState: {
        ...base,
        walkthrough: { ...base.walkthrough!, strayEdits: [{ geoid: '320030499001001', fromDistrict: 4, toDistrict: 0 }] },
      },
    });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('stray-edits-banner')).toHaveTextContent(/4\s*→\s*Unassigned/);
    noDistrictZero();
  });

  it('group mode: Unassigned is never added as a group member, and its list row cannot be selected', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const base = SCENARIOS['live-drawing-unassigned'].createState();
    const controller = new MockController({
      initialState: { ...base, scope: { mode: 'group', districts: [3], allowOutsideAbsorb: false }, solutions: [] },
      onAction: (a) => actions.push(a),
    });
    render(<Panel controller={controller} />);
    expect(within(screen.getByTestId('unassigned-row')).queryByRole('checkbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Add neighbors/i }));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'group', districts: [3, 4], allowOutsideAbsorb: false },
    });
  });
});

describe('Panel — an area of the map for the swap', () => {
  it('searches counties, keeps the mode when picking a town, and cancels with Esc or Cancel', async () => {
    const user = userEvent.setup();
    const controller = new MockController({ initialScenario: 'live-area-prefer' });
    render(<Panel controller={controller} />);

    await user.click(screen.getByRole('button', { name: 'County' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search counties' }), 'suff');
    expect(screen.queryByRole('option', { name: 'New York County' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'County' }), 'Suffolk County');
    expect(screen.getByTestId('area-region-name')).toHaveTextContent('Suffolk County');
    expect(controller.getState().area?.ring).toBeUndefined();
    await user.click(screen.getByTestId('area-mode-only'));

    await user.click(screen.getByRole('button', { name: 'Town' }));
    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    expect(screen.getByTestId('area-pick-hint')).toHaveTextContent('pick a town');
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('area-region-name')).toHaveTextContent('Suffolk County');

    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('area-pick-hint')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    act(() => controller.finishAreaPick(339));
    expect(screen.getByTestId('area-region-name')).toHaveTextContent('Huntington town');
    expect(screen.getByTestId('area-mode-only')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('area-region-name')).toBeNull();
  });

  it('allows choosing a town by name while map picking is unavailable', async () => {
    const user = userEvent.setup();
    const base = SCENARIOS['live-area-prefer'].createState();
    const controller = new MockController({
      initialState: { ...base, area: { mode: 'prefer', drawing: false, unavailable: 'No block locations for map picking.' } },
    });
    render(<Panel controller={controller} />);
    await user.click(screen.getByRole('button', { name: 'Town' }));
    expect(screen.getByRole('button', { name: 'Pick on map' })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Town' }), 'Huntington town');
    expect(screen.getByTestId('area-region-name')).toHaveTextContent('Huntington town');
    expect(screen.getByTestId('area-counts')).toHaveTextContent('1,284 blocks');
  });

  it('with no area: says what it does, and offers Draw area and Use map view', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);
    const box = screen.getByTestId('area-control');
    expect(box).toHaveTextContent("Mark where you'd like the swap to happen");
    expect(within(box).queryByTestId('area-mode-prefer')).toBeNull();

    await user.click(within(box).getByRole('button', { name: 'Use map view' }));
    expect(actions).toContainEqual({ type: 'area-use-view' });
    // The mock takes the view, counts what is inside, and drops the options (found without it).
    expect(screen.getByTestId('area-counts')).toHaveTextContent('4,702 blocks, 312,845 people inside');
    expect(screen.queryByTestId('solution-card-opt-1')).toBeNull();
  });

  it('drawing: shows how to draw and Cancel; finishing sets the area with Prefer on; Esc cancels a redraw', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);

    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    expect(actions).toContainEqual({ type: 'area-draw' });
    expect(screen.getByTestId('area-draw-hint')).toHaveTextContent(
      'Click the map to add corners. Double-click or click the first corner to finish. Esc cancels.',
    );
    expect(screen.queryByRole('button', { name: 'Draw area' })).toBeNull();
    // Drawing alone changes nothing: the options found before are still on offer.
    expect(screen.getByTestId('solution-card-opt-1')).toBeInTheDocument();

    // Cancel a first drawing: back to no area.
    await user.click(screen.getByTestId('area-cancel-draw-btn'));
    expect(actions).toContainEqual({ type: 'area-cancel-draw' });
    expect(screen.getByRole('button', { name: 'Draw area' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    act(() => controller.finishAreaDraw());
    expect(screen.getByTestId('area-counts')).toHaveTextContent('1,284 blocks, 61,530 people inside');
    expect(screen.getByTestId('area-mode-prefer')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('area-mode-only')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('area-mode-explain')).toHaveTextContent(/Moves inside come first/);

    // Redraw, then Esc: the area stays as it was.
    await user.click(screen.getByRole('button', { name: 'Redraw' }));
    expect(screen.getByTestId('area-draw-hint')).toHaveTextContent(/current area stays until you finish/);
    await user.keyboard('{Escape}');
    expect(actions.filter((a) => a.type === 'area-cancel-draw')).toHaveLength(2);
    expect(screen.queryByTestId('area-draw-hint')).toBeNull();
    expect(screen.getByTestId('area-counts')).toHaveTextContent('1,284 blocks');
  });

  it('the Prefer / Only switch dispatches set-area-mode and explains each; Clear removes the area', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-area-prefer', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);

    // Pressing the mode that is already on does nothing.
    await user.click(screen.getByTestId('area-mode-prefer'));
    expect(actions).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Only' }));
    expect(actions).toContainEqual({ type: 'set-area-mode', mode: 'only' });
    expect(screen.getByTestId('area-mode-only')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('area-mode-explain')).toHaveTextContent('Nothing outside the area moves.');
    // A new mode drops the options (they were found for the old one).
    expect(screen.queryByTestId('solution-card-opt-1')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(actions).toContainEqual({ type: 'area-clear' });
    expect(screen.getByRole('button', { name: 'Draw area' })).toBeInTheDocument();
  });

  it('cards: "Moves N blocks outside your area" when some go outside, "Inside your area" when none do; the solve note reads', () => {
    const controller = new MockController({ initialScenario: 'live-area-prefer' });
    render(<Panel controller={controller} />);

    expect(screen.getByTestId('outside-area-opt-4')).toHaveTextContent('Moves 4 blocks outside your area.');
    expect(screen.queryByTestId('inside-area-opt-4')).toBeNull();
    for (const id of ['opt-1', 'opt-2', 'opt-3']) {
      expect(screen.getByTestId(`inside-area-${id}`)).toHaveTextContent('Inside your area');
      expect(screen.queryByTestId(`outside-area-${id}`)).toBeNull();
    }
    expect(screen.getByTestId('solve-note')).toHaveTextContent(/the last one moves 4 blocks outside it/);

    // Without an area, cards say nothing about one.
    act(() => controller.setScenario('live-single'));
    expect(screen.queryByTestId('inside-area-opt-1')).toBeNull();
    expect(screen.queryByTestId('outside-area-opt-4')).toBeNull();
    expect(screen.queryByTestId('solve-note')).toBeNull();
  });

  it('one block outside reads in the singular, on plan cards too', () => {
    const base = SCENARIOS['live-group-chain'].createState();
    const [first, ...rest] = base.solutions;
    const controller = new MockController({
      initialState: {
        ...base,
        area: { ring: [[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8]], mode: 'prefer', drawing: false },
        solutions: [{ ...first, stats: { ...first.stats, outsideArea: 1 } }, ...rest.map((c) => ({ ...c, stats: { ...c.stats, outsideArea: 0 } }))],
      },
    });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId(`outside-area-${first.id}`)).toHaveTextContent('Moves 1 block outside your area.');
    expect(screen.getByTestId(`inside-area-${rest[0].id}`)).toBeInTheDocument();
    // No counts yet (the state's data is still loading): says it is counting.
    expect(screen.getByTestId('area-control')).toHaveTextContent('Counting blocks inside…');
  });

  it('Only with nothing inside: the controller\'s message reads under an area heading, with the ways out', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-area-only-none', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);
    const failed = screen.getByTestId('area-solve-failed');
    expect(failed).toHaveTextContent('Nothing found in your area');
    expect(failed).toHaveTextContent(/fewer than the 412 to move/);
    expect(screen.queryByText(/Already at zero deviation/i)).toBeNull();

    await user.click(within(failed).getByRole('button', { name: 'Prefer the area instead' }));
    expect(actions).toContainEqual({ type: 'set-area-mode', mode: 'prefer' });
    expect(screen.queryByTestId('area-solve-failed')).toBeNull();
  });

  it('an error message about something else keeps its own heading with an area set', () => {
    const base = SCENARIOS['solve-error'].createState();
    const controller = new MockController({
      initialState: { ...base, area: { ring: [[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8]], mode: 'only', drawing: false } },
    });
    render(<Panel controller={controller} />);
    expect(screen.getByText(/Solver error/i)).toBeInTheDocument();
    expect(screen.queryByTestId('area-solve-failed')).toBeNull();
  });

  it('solving with an area: Prefer fills in from outside and says so; Only leaves the outside option out', async () => {
    const user = userEvent.setup();
    const base = SCENARIOS['live-single'].createState();
    const area = { ring: [[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8]] as Array<[number, number]>, mode: 'prefer' as const, drawing: false };
    const controller = new MockController({ initialState: { ...base, area, solutions: [], solve: { status: 'idle' } } });
    render(<Panel controller={controller} />);

    await user.click(screen.getByRole('button', { name: /Find zeroing options/i }));
    expect(screen.getByTestId('outside-area-opt-4')).toHaveTextContent('Moves 3 blocks outside your area.');
    expect(screen.getByTestId('inside-area-opt-1')).toBeInTheDocument();
    expect(screen.getByTestId('solve-note')).toHaveTextContent(/Only 3 options fit inside your area/);

    await user.click(screen.getByRole('button', { name: 'Only' }));
    await user.click(screen.getByRole('button', { name: /Find zeroing options/i }));
    expect(screen.queryByTestId('solution-card-opt-4')).toBeNull();
    expect(screen.getByTestId('inside-area-opt-3')).toBeInTheDocument();
  });

  it('unavailable: says why; without a DRA map only drawing is off; otherwise neither way works, Clear still does', () => {
    const controller = new MockController({ initialScenario: 'live-area-unavailable' });
    render(<Panel controller={controller} />);
    expect(screen.getByTestId('area-unavailable')).toHaveTextContent(/No DRA map to draw on/);
    expect(screen.getByRole('button', { name: 'Draw area' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use map view' })).toBeEnabled();

    act(() => controller.dispatch({ type: 'area-use-view' }));
    expect(screen.getByRole('button', { name: 'Redraw' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use map view' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled();

    // On DRA's map but the state's data has no block points: nothing can mark an area.
    act(() =>
      controller.setState({
        ...controller.getState(),
        mapMode: 'dra',
        area: { mode: 'prefer', drawing: false, unavailable: "This state's data has no block points yet, so an area can't be used." },
      }),
    );
    expect(screen.getByTestId('area-unavailable')).toHaveTextContent(/no block points/);
    expect(screen.getByRole('button', { name: 'Draw area' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use map view' })).toBeDisabled();
  });

  it('without a DRA map, the mini-map shows for "Use map view" before anything can be previewed, and stays when an area is set', () => {
    const cleanup = vi.fn();
    const renderMiniMap = vi.fn((container: HTMLElement) => {
      container.appendChild(document.createElement('canvas'));
      return cleanup;
    });
    // One district, not solved yet: no options, no interaction view (scope 'one' never has one).
    const base = SCENARIOS['live-single'].createState();
    const unavailable = 'Drawing an area needs DRA\'s map, which the extension cannot reach on this page. "Use map view" takes the part of the panel\'s map in view.';
    const controller = new MockController({
      initialState: { ...base, mapMode: 'mini', solutions: [], hoveredSolutionId: undefined, interaction: undefined, solve: { status: 'idle' }, area: { mode: 'prefer', drawing: false, unavailable } },
    });
    render(<Panel controller={controller} renderMiniMap={renderMiniMap} />);
    expect(screen.getByRole('button', { name: 'Use map view' })).toBeEnabled();
    expect(screen.getByTestId('minimap-slot')).toBeInTheDocument();
    expect(renderMiniMap).toHaveBeenCalledTimes(1);
    // An area set from that view drops the options (there were none): the mini-map stays mounted.
    act(() => controller.setState({ ...controller.getState(), area: { mode: 'prefer', drawing: false, unavailable, ring: [[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8]], blocks: 12, people: 340 } }));
    expect(screen.getByTestId('minimap-slot')).toBeInTheDocument();
    expect(renderMiniMap).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    // In CSV mode there is no area card to serve, so nothing to preview means no mini-map.
    act(() => controller.setState({ ...controller.getState(), connection: 'csv', area: undefined }));
    expect(screen.queryByTestId('minimap-slot')).toBeNull();
  });

  it('is not shown during a walkthrough', () => {
    const base = SCENARIOS['walkthrough-live'].createState();
    const controller = new MockController({ initialState: { ...base, area: { mode: 'prefer', drawing: false, ring: [[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8]] } } });
    render(<Panel controller={controller} />);
    expect(screen.queryByTestId('area-control')).toBeNull();
  });
});

describe('Panel — Undo', () => {
  it('hides the Undo button when PanelState.undo is absent, and shows its label when set', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const base = SCENARIOS['walkthrough-live'].createState();
    const controller = new MockController({
      initialState: { ...base, undo: undefined },
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    expect(screen.queryByTestId('undo-btn')).toBeNull();

    act(() =>
      controller.setState({
        ...controller.getState(),
        undo: { kind: 'paint', label: 'Undo painting step 3' },
      }),
    );

    const btn = screen.getByTestId('undo-btn');
    expect(btn).toHaveTextContent('Undo painting step 3');
    expect(btn).toHaveAttribute('data-undo-kind', 'paint');

    await user.click(btn);
    expect(actions).toContainEqual({ type: 'undo' });
  });

  it('triggers Undo on Cmd/Ctrl+Z inside the side panel, but ignores Shift+Z and text inputs', () => {
    const actions: PanelAction[] = [];
    const base = SCENARIOS['live-single'].createState();
    const controller = new MockController({
      initialState: { ...base, undo: { kind: 'setting', label: 'Undo unlock all' } },
      onAction: (a) => actions.push(a),
    });

    render(<Panel controller={controller} />);
    expect(screen.getByTestId('undo-btn')).toHaveTextContent('Undo unlock all');

    // Shift+Ctrl+Z (Redo) does not trigger undo.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(actions.filter((a) => a.type === 'undo')).toHaveLength(0);

    // Text input keeps native undo.
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    try {
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
      expect(actions.filter((a) => a.type === 'undo')).toHaveLength(0);
    } finally {
      input.remove();
    }

    // Ctrl+Z triggers undo.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(actions).toContainEqual({ type: 'undo' });

    // Cmd+Z triggers undo too.
    act(() =>
      controller.setState({
        ...controller.getState(),
        undo: { kind: 'setting', label: 'Undo clearing area' },
      }),
    );
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(actions.filter((a) => a.type === 'undo')).toHaveLength(2);
  });

  it('restores locks after Unlock all and clears Undo once undone', async () => {
    const user = userEvent.setup();
    const base = SCENARIOS['live-single'].createState();
    const controller = new MockController({
      initialState: { ...base, lockedDistricts: [5, 7] },
    });

    render(<Panel controller={controller} />);
    await user.click(screen.getByTestId('unlock-all'));
    expect(controller.getState().lockedDistricts).toEqual([]);
    expect(screen.getByTestId('undo-btn')).toHaveTextContent('Undo unlock all');

    await user.click(screen.getByTestId('undo-btn'));
    expect(controller.getState().lockedDistricts).toEqual([5, 7]);
    expect(screen.queryByTestId('undo-btn')).toBeNull();
  });
});

describe('Panel — Aim for goal (−1 · Zero · +1) in one-district mode', () => {
  it('shows Aim for in one-district mode with Zero selected by default, hidden in group and whole-map modes', async () => {
    const user = userEvent.setup();
    const controller = new MockController({ initialScenario: 'live-single' });
    render(<Panel controller={controller} />);

    const goalControl = screen.getByTestId('goal-control');
    expect(goalControl).toHaveTextContent('Aim for');
    expect(screen.getByTestId('goal-minus-1')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('goal-zero')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('goal-plus-1')).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Group' }));
    expect(screen.queryByTestId('goal-control')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Whole map' }));
    expect(screen.queryByTestId('goal-control')).toBeNull();
  });

  it('picking +1 or −1 updates scope, header, chooser numbers and solve; picking Zero clears goal', async () => {
    const user = userEvent.setup();
    const actions: PanelAction[] = [];
    const controller = new MockController({ initialScenario: 'live-single', onAction: (a) => actions.push(a) });
    render(<Panel controller={controller} />);

    // District 13 is +412 over; target 776,971; neighbor 12 is −380.
    // Pick neighbor 12 first, then switch goal to +1: `with` is kept.
    await user.click(screen.getByRole('checkbox', { name: 'Give to District 12' }));
    await user.click(screen.getByTestId('goal-plus-1'));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'one', district: 13, with: [12], goal: 1 },
    });
    expect(screen.getByTestId('goal-plus-1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('goal-zero')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Goal +1')).toBeInTheDocument();
    expect(screen.getByText(/Goal pop 776,972/)).toBeInTheDocument();
    // +412 aiming for +1 gives 411 people; D12 (−380) would become +31.
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 13 gives 411 people to District 12 only.');
    expect(screen.getByTestId('chooser-row-12')).toHaveTextContent(/District 12\s*−380\s*→\s*\+31/);

    // Switch to −1: gives 413 people; D12 (−380) would become +33.
    await user.click(screen.getByTestId('goal-minus-1'));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'one', district: 13, with: [12], goal: -1 },
    });
    expect(screen.getByText('Goal −1')).toBeInTheDocument();
    expect(screen.getByText(/Goal pop 776,970/)).toBeInTheDocument();
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 13 gives 413 people to District 12 only.');
    expect(screen.getByTestId('chooser-row-12')).toHaveTextContent(/District 12\s*−380\s*→\s*\+33/);

    // Solve with goal −1: card moves 413 and lands D13 at −1.
    await user.click(screen.getByRole('button', { name: /Find options for −1/i }));
    const card = screen.getByTestId('solution-card-opt-13-to-12');
    expect(card).toHaveTextContent('413');
    expect(card).toHaveTextContent(/District 13:\s*\+412\s*→\s*−1/);

    // Picking Zero clears goal (dispatch set-scope without goal) while keeping `with`.
    await user.click(screen.getByTestId('goal-zero'));
    expect(actions[actions.length - 1]).toEqual({
      type: 'set-scope',
      scope: { mode: 'one', district: 13, with: [12] },
    });
    expect('goal' in controller.getState().scope).toBe(false);
    expect(screen.getByTestId('goal-zero')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 13 gives 412 people to District 12 only.');
  });

  it('district at 0: direction flips for +1 (takes 1) and −1 (gives 1); already-at-goal hides chooser and reports message', async () => {
    const user = userEvent.setup();
    const base = SCENARIOS['live-single'].createState();
    // District 7 is at 0 in NY_26_SPEC (neighbors [4, 5, 6, 8, 9, 11]; D4 is +410, D8 is −340).
    const controller = new MockController({
      initialState: { ...base, scope: { mode: 'one', district: 7 }, solutions: [], solve: { status: 'idle' } },
    });
    render(<Panel controller={controller} />);

    // At 0 with Zero: chooser hidden, Aim for visible.
    expect(screen.queryByTestId('neighbor-chooser')).toBeNull();
    expect(screen.getByTestId('goal-control')).toBeInTheDocument();

    // Aim for +1: District 7 must TAKE 1 person; D4 (+410 -> +409).
    await user.click(screen.getByTestId('goal-plus-1'));
    expect(screen.getByTestId('neighbor-chooser')).toBeInTheDocument();
    expect(within(screen.getByTestId('neighbor-chooser')).getByText('Take from')).toBeInTheDocument();
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 7 takes 1 person from any neighbor');
    expect(screen.getByTestId('chooser-row-4')).toHaveTextContent(/\+410\s*→\s*\+409/);

    // Aim for −1: District 7 must GIVE 1 person; D8 (−340 -> −339).
    await user.click(screen.getByTestId('goal-minus-1'));
    expect(within(screen.getByTestId('neighbor-chooser')).getByText('Give to')).toBeInTheDocument();
    expect(screen.getByTestId('chooser-summary')).toHaveTextContent('District 7 gives 1 person to any neighbor');
    expect(screen.getByTestId('chooser-row-8')).toHaveTextContent(/−340\s*→\s*−339/);

    // District already at −1 with goal −1: chooser hidden, solve says "District 7 is already at −1."
    act(() => {
      const s = controller.getState();
      controller.setState({
        ...s,
        districts: s.districts.map((d) => (d.index === 7 ? { ...d, pop: s.map!.target - 1, deviation: -1 } : d)),
      });
    });
    expect(screen.queryByTestId('neighbor-chooser')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Find options for −1/i }));
    expect(screen.getByText('✓ Already at −1')).toBeInTheDocument();
    expect(screen.getByText('District 7 is already at −1.')).toBeInTheDocument();
  });

  it('keeps goal when the same district is clicked again or a neighbor changes, and resets for another district', async () => {
    const user = userEvent.setup();
    const controller = new MockController({ initialScenario: 'live-single' });
    render(<Panel controller={controller} />);

    await user.click(screen.getByTestId('goal-plus-1'));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13, goal: 1 });

    // Toggling a neighbor keeps goal.
    await user.click(screen.getByRole('checkbox', { name: 'Give to District 12' }));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13, with: [12], goal: 1 });

    // Locking that neighbor removes it from `with` and keeps goal.
    await user.click(screen.getByRole('button', { name: 'Lock District 12' }));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13, goal: 1 });

    // Clicking District 13 again keeps goal; clicking District 5 resets goal.
    const list = screen.getByRole('region', { name: /District population list/i });
    const rowOf = (name: string) => within(list).getAllByRole('button').find((b) => b.textContent?.includes(name))!;
    await user.click(rowOf('District 13'));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 13, goal: 1 });

    await user.click(rowOf('District 5'));
    expect(controller.getState().scope).toEqual({ mode: 'one', district: 5 });
    expect(screen.getByTestId('goal-zero')).toHaveAttribute('aria-pressed', 'true');
  });
});
