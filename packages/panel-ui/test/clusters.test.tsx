import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PanelAction, PanelState } from '@zd/contracts';
import { MockController, Panel, SCENARIOS } from '../src';
import type { ScenarioId } from '../src';
import {
  formatClusteringTitle,
  formatSeconds,
  formatSignedPct,
  formatTolerance,
  hasSelectedArea,
  truncateNames,
} from '../src/format';
import { NY_COUNTY_NAMES, NY_MAP_INFO, makeMockClusterings } from '../src/mock/scenarios';

function setup(init: { scenario?: ScenarioId; state?: PanelState } = {}) {
  const actions: PanelAction[] = [];
  const controller = new MockController({
    ...(init.state ? { initialState: init.state } : { initialScenario: init.scenario ?? 'live-single' }),
    onAction: (a) => actions.push(a),
  });
  const user = userEvent.setup();
  render(<Panel controller={controller} />);
  return { actions, controller, user };
}

const openCard = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId('clusters-toggle'));
};

const clustersOf = (actions: PanelAction[]) => actions.filter((a) => a.type.startsWith('clusters-'));

describe('County clusters — format helpers and mock data', () => {
  it('formats tolerances, signed percentages, seconds, titles and truncated names', () => {
    expect(formatTolerance(0.005)).toBe('±0.5%');
    expect(formatTolerance(0.05)).toBe('±5%');
    expect(formatTolerance(0.1)).toBe('±10%');
    expect(formatSignedPct(0.0123)).toBe('+1.2%');
    expect(formatSignedPct(-0.004)).toBe('−0.4%');
    expect(formatSignedPct(0.00001)).toBe('0.0%');
    expect(formatSeconds(10000)).toBe('10 s');
    expect(formatSeconds(2300)).toBe('2.3 s');
    expect(formatSeconds(420)).toBe('420 ms');
    expect(formatClusteringTitle({ clusterCount: 34, maxAbsDeviationPct: 0.0421 }, 0, true)).toBe(
      'Option 1: 34 clusters · worst ±4.2% · exhaustive',
    );
    expect(formatClusteringTitle({ clusterCount: 1, maxAbsDeviationPct: 0 }, 2, false, 10000)).toBe(
      'Option 3: 1 cluster · worst ±0.0% · best found in 10 s',
    );
    expect(truncateNames(['A', 'B', 'C', 'D'])).toEqual({ text: 'A, B, C, D', more: 0 });
    expect(truncateNames(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual({ text: 'A, B, C', more: 3 });
  });

  it('a cluster area counts as a selected area', () => {
    expect(hasSelectedArea({ mode: 'prefer', drawing: false, cluster: { name: 'X', counties: [1, 2] } })).toBe(true);
    expect(hasSelectedArea({ mode: 'prefer', drawing: false })).toBe(false);
  });

  it('mock clusterings cover every county once, sum to the district count, and stay within tolerance', () => {
    for (const [n, tol] of [[26, 0.05], [120, 0.02], [1, 0.05], [3, 0.1]] as const) {
      const results = makeMockClusterings(n, tol);
      expect(results.length).toBeGreaterThan(0);
      for (let i = 1; i < results.length; i++) {
        expect(results[i].stats.clusterCount).toBeLessThan(results[i - 1].stats.clusterCount);
      }
      for (const r of results) {
        const counties = r.clusters.flatMap((c) => c.counties).sort((a, b) => a - b);
        expect(counties).toEqual(NY_COUNTY_NAMES.map((_, i) => i));
        expect(r.clusters.reduce((s, c) => s + c.districts, 0)).toBe(n);
        expect(r.clusters.every((c) => c.districts >= 1 && Math.abs(c.deviationPct) <= tol)).toBe(true);
        expect(r.countyNames.map((names) => names.length)).toEqual(r.clusters.map((c) => c.counties.length));
        expect(r.stats.clusterCount).toBe(r.clusters.length);
      }
    }
  });
});

describe('County clusters — the card', () => {
  it('is collapsed by default, sits below the Area control, and opens to say what it does', async () => {
    const { user } = setup();
    const card = screen.getByTestId('clusters-view');
    const area = screen.getByTestId('area-control');
    expect(area.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('clusters-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('clusters-find')).toBeNull();

    await openCard(user);
    expect(screen.getByTestId('clusters-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(within(card).getByText('Groups of whole counties that each hold a whole number of districts.')).toBeInTheDocument();
  });

  it('is not shown during a walkthrough', () => {
    setup({ scenario: 'walkthrough-live' });
    expect(screen.queryByTestId('clusters-view')).toBeNull();
  });

  it('defaults to the map’s district count and ±5%, finds, shows progress, and cancels', async () => {
    const { actions, controller, user } = setup();
    await openCard(user);
    const input = screen.getByTestId('clusters-districts');
    expect(input).toHaveValue(26);
    expect(screen.getByTestId('clusters-size')).toHaveTextContent('776,971 per district');
    const group = screen.getByRole('group', { name: 'Each district within' });
    const labels = within(group).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['±0.5%', '±1%', '±2%', '±5%', '±10%']);
    expect(within(group).getByRole('button', { name: '±5%' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('clusters-find'));
    expect(clustersOf(actions)).toEqual([{ type: 'clusters-find', numDistricts: 26, tolerance: 0.05 }]);
    expect(controller.getState().clusters?.status).toBe('finding');
    expect(screen.getByTestId('clusters-finding')).toHaveTextContent('Finding clusters for 26 districts, ±5%');
    expect(screen.getByTestId('clusters-find')).toBeDisabled();
    expect(input).toBeDisabled();

    await user.click(screen.getByTestId('clusters-cancel'));
    expect(actions.at(-1)).toEqual({ type: 'clusters-cancel' });
    expect(controller.getState().clusters?.status).toBe('idle');
    expect(screen.queryByTestId('clusters-finding')).toBeNull();
    expect(screen.getByTestId('clusters-find')).toBeEnabled();
  });

  it('takes another district count and tolerance (a 120-seat House on a congressional map), and rejects bad counts', async () => {
    const { actions, user } = setup();
    await openCard(user);
    const input = screen.getByTestId('clusters-districts');
    const find = screen.getByTestId('clusters-find');

    for (const bad of ['0', '1000', '2.5']) {
      await user.clear(input);
      await user.type(input, bad);
      expect(find).toBeDisabled();
      expect(screen.getByTestId('clusters-invalid')).toHaveTextContent('1 to 999');
    }
    await user.clear(input);
    expect(find).toBeDisabled();

    await user.type(input, '120');
    expect(screen.queryByTestId('clusters-invalid')).toBeNull();
    await user.click(screen.getByRole('button', { name: '±2%' }));
    expect(screen.getByRole('button', { name: '±2%' })).toHaveAttribute('aria-pressed', 'true');
    // Enter in the field submits too.
    await user.type(input, '{Enter}');
    expect(clustersOf(actions)).toEqual([{ type: 'clusters-find', numDistricts: 120, tolerance: 0.02 }]);
  });

  it('lists the results: one row per clustering, expandable to clusters with names, districts and deviation', async () => {
    const { controller, user } = setup();
    await openCard(user);
    await user.click(screen.getByTestId('clusters-find'));
    act(() => controller.finishClusterFind());

    const expected = makeMockClusterings(26, 0.05);
    const rows = screen.getAllByTestId('clustering-row');
    expect(rows).toHaveLength(expected.length);
    expect(rows[0]).toHaveTextContent(
      `Option 1: ${expected[0].stats.clusterCount} clusters · worst ±${(expected[0].stats.maxAbsDeviationPct * 100).toFixed(1)}% · best found in 10 s`,
    );
    expect(screen.queryAllByTestId('cluster-row')).toHaveLength(0);

    await user.click(rows[0]);
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
    const clusterRows = screen.getAllByTestId('cluster-row');
    expect(clusterRows).toHaveLength(expected[0].clusters.length);

    const first = expected[0].clusters[0];
    const firstRow = clusterRows[0];
    expect(within(firstRow).getByTestId('cluster-districts')).toHaveTextContent(`${first.districts} districts`);
    expect(within(firstRow).getByTestId('cluster-deviation')).toHaveTextContent(
      `${formatSignedPct(first.deviationPct)} · +${Math.round(first.deviation).toLocaleString('en-US')} each`,
    );
    const single = expected[0].clusters.findIndex((c) => c.districts === 1);
    expect(within(clusterRows[single]).getByTestId('cluster-districts')).toHaveTextContent(/^1 district$/);

    // Long county lists show three names and "+N more"; the full list is in the tooltip and on expand.
    const longIdx = expected[0].countyNames.findIndex((names) => names.length > 4);
    const names = expected[0].countyNames[longIdx];
    const namesEl = within(clusterRows[longIdx]).getByTestId('cluster-names');
    expect(namesEl).toHaveAttribute('title', names.join(', '));
    expect(namesEl).toHaveTextContent(`${names.slice(0, 3).join(', ')} +${names.length - 3} more`);
    expect(namesEl).not.toHaveTextContent(names[3]);
    await user.click(within(namesEl).getByRole('button', { name: `+${names.length - 3} more` }));
    expect(namesEl).toHaveTextContent(names.join(', '));
    await user.click(within(namesEl).getByRole('button', { name: 'Show fewer' }));
    expect(namesEl).not.toHaveTextContent(names[3]);

    await user.click(rows[0]);
    expect(screen.queryAllByTestId('cluster-row')).toHaveLength(0);
  });

  it('says "exhaustive" when the search proved the ranking', async () => {
    const { controller, user } = setup();
    await openCard(user);
    const input = screen.getByTestId('clusters-districts');
    await user.clear(input);
    await user.type(input, '10');
    await user.click(screen.getByTestId('clusters-find'));
    act(() => controller.finishClusterFind());
    expect(screen.getAllByTestId('clustering-row')[0]).toHaveTextContent(/· exhaustive$/);
  });

  it('hovering a clustering or a cluster highlights it; leaving clears', async () => {
    const { actions, controller, user } = setup({ scenario: 'clusters-results' });
    await openCard(user);
    const id = makeMockClusterings(26, 0.05)[0].id;
    const row = screen.getAllByTestId('clustering-row')[0];

    fireEvent.mouseEnter(row);
    expect(actions.at(-1)).toEqual({ type: 'clusters-hover', id });
    expect(controller.getState().clusters?.hovered).toEqual({ id });
    expect(row).toHaveClass('zd-list__row--selected');
    fireEvent.mouseLeave(row);
    expect(actions.at(-1)).toEqual({ type: 'clusters-hover', id: null });
    expect(controller.getState().clusters?.hovered).toBeUndefined();

    await user.click(row);
    const clusterRow = screen.getAllByTestId('cluster-row')[2];
    fireEvent.mouseEnter(clusterRow);
    expect(actions.at(-1)).toEqual({ type: 'clusters-hover', id, cluster: 2 });
    expect(controller.getState().clusters?.hovered).toEqual({ id, cluster: 2 });
    expect(clusterRow).toHaveClass('zd-list__row--selected');
    fireEvent.mouseLeave(clusterRow);
    expect(actions.at(-1)).toEqual({ type: 'clusters-hover', id: null });

    // Collapsing the card while something is hovered clears the highlight.
    fireEvent.mouseEnter(clusterRow);
    await user.click(screen.getByTestId('clusters-toggle'));
    expect(actions.at(-1)).toEqual({ type: 'clusters-hover', id: null });
    expect(controller.getState().clusters?.hovered).toBeUndefined();
  });

  it('"Use as area" makes the cluster the swap area', async () => {
    const { actions, controller, user } = setup({ scenario: 'clusters-results' });
    expect(screen.getByTestId('area-control')).toHaveTextContent(/Mark where/);
    await openCard(user);
    const result = makeMockClusterings(26, 0.05)[1];
    await user.click(screen.getAllByTestId('clustering-row')[1]);
    const clusterRow = screen.getAllByTestId('cluster-row')[0];
    await user.click(within(clusterRow).getByTestId('cluster-use-as-area'));

    expect(actions.at(-1)).toEqual({ type: 'clusters-use-as-area', id: result.id, cluster: 0 });
    const area = controller.getState().area;
    expect(area?.cluster?.counties).toEqual(result.clusters[0].counties);
    expect(area?.people).toBe(result.clusters[0].pop);
    expect(screen.getByTestId('area-control')).not.toHaveTextContent(/Mark where/);
    expect(screen.getByTestId('area-mode-prefer')).toHaveAttribute('aria-pressed', 'true');
    // The Area card names the cluster, and offers to draw an area instead of "Redraw".
    expect(screen.getByTestId('area-cluster-name')).toHaveTextContent(area!.cluster!.name);
    expect(screen.getByTestId('area-redraw-btn')).toHaveTextContent('Draw area');
    expect(within(clusterRow).getByTestId('cluster-is-area')).toHaveTextContent('Area');
    expect(within(clusterRow).queryByTestId('cluster-use-as-area')).toBeNull();
  });

  it('shows how many options there are while closed, and keeps the district count the results were found for', async () => {
    const { user } = setup({ scenario: 'clusters-results' });
    expect(screen.getByTestId('clusters-view')).toHaveTextContent('3 options');
    await openCard(user);
    expect(screen.getByTestId('clusters-districts')).toHaveValue(26);
  });

  it('none: the message in a note, with the tolerance it was run at selected', async () => {
    const { user } = setup({ scenario: 'clusters-none' });
    await openCard(user);
    const note = screen.getByTestId('clusters-message');
    expect(note).toHaveClass('zd-note', 'zd-note--warn');
    expect(note).toHaveTextContent('No grouping of whole counties keeps every district within ±0.5%');
    expect(screen.getByRole('button', { name: '±0.5%' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('clusters-results')).toBeNull();
  });

  it('error: the message in an error note', async () => {
    const base = SCENARIOS['clusters-none'].createState();
    const { user } = setup({
      state: { ...base, clusters: { ...base.clusters!, status: 'error', message: 'The state’s data has no county adjacency.' } },
    });
    await openCard(user);
    const note = screen.getByTestId('clusters-message');
    expect(note).toHaveClass('zd-note--error');
    expect(note).toHaveAttribute('role', 'alert');
    expect(note).toHaveTextContent('The state’s data has no county adjacency.');
  });

  it('the mock finds none below ±1%', async () => {
    const { controller, user } = setup();
    await openCard(user);
    await user.click(screen.getByRole('button', { name: '±0.5%' }));
    await user.click(screen.getByTestId('clusters-find'));
    act(() => controller.finishClusterFind());
    expect(screen.getByTestId('clusters-message')).toHaveTextContent(
      `within ±0.5% of ${Math.round(NY_MAP_INFO.totalPop / 26).toLocaleString('en-US')}`,
    );
  });
});
