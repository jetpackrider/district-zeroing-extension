import { expect, test, type Page } from '@playwright/test';
import { closePages, dispatch, launch, openDra, openPanel, probe, ready, solveOne, state, until, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.beforeEach(async () => {
  await h.sw.evaluate(() => chrome.storage.local.remove(['areas', 'districtLocks']));
});
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const pickedTown = { kind: 'town', index: 2, name: 'Eastfield town' };

const storedAreas = () => h.sw.evaluate(async () => Object.values((await chrome.storage.local.get('areas')).areas ?? {}));

async function waitForPicker(panel: Page) {
  await expect(panel.getByTestId('area-pick-hint')).toHaveText(/pick a town/i);
  await until(() => probe(panel), (status) => status.area?.overlay && status.area.drawing);
}

test('balances within a county, safely picks a town on the map, and remembers the region', async () => {
  const dra = await openDra(h);
  let panel = await openPanel(h, dra);
  await ready(panel);

  expect((await state(panel)).regions).toEqual({
    counties: [{ index: 1, name: 'East County' }, { index: 0, name: 'West County' }],
    towns: [{ index: 2, name: 'Eastfield town' }, { index: 1, name: 'Westfield town' }],
  });
  await panel.getByRole('button', { name: 'County', exact: true }).click();
  await panel.getByRole('searchbox', { name: 'Search counties' }).fill('west');
  await expect(panel.getByRole('option', { name: 'East County' })).toHaveCount(0);
  await panel.getByRole('combobox', { name: 'County' }).selectOption({ label: 'West County' });
  await expect(panel.getByTestId('area-region-name')).toHaveText('West County');
  await expect(panel.getByTestId('area-counts')).toContainText('768 blocks');
  await panel.getByTestId('area-mode-only').click();

  const only = await solveOne(panel, 1);
  expect(only.solutions.length).toBeGreaterThan(0);
  for (const card of only.solutions) {
    const geoids: string[] = await panel.evaluate((id) => (window as any).__zd.solutionBlocks(id), card.id);
    expect(geoids.length).toBeGreaterThan(0);
    expect(geoids.every((geoid) => geoid.startsWith('36901'))).toBe(true);
    expect(card.stats.outsideArea).toBe(0);
  }

  await panel.getByTestId('area-mode-prefer').click();
  const prefer = await solveOne(panel, 1);
  expect(prefer.solutions.length).toBeGreaterThan(0);
  const outsideCounts: number[] = [];
  for (const card of prefer.solutions) {
    const geoids: string[] = await panel.evaluate((id) => (window as any).__zd.solutionBlocks(id), card.id);
    const outside = geoids.filter((geoid) => !geoid.startsWith('36901')).length;
    expect(card.stats.outsideArea).toBe(outside);
    outsideCounts.push(outside);
  }
  expect(outsideCounts[0]).toBe(0);
  expect(outsideCounts).toEqual([...outsideCounts].sort((a, b) => a - b));

  await panel.getByRole('button', { name: 'Town', exact: true }).click();
  await panel.getByRole('button', { name: 'Pick on map' }).click();
  await waitForPicker(panel);
  await dra.bringToFront();
  await dra.keyboard.press('Escape');
  await expect(panel.getByTestId('area-pick-hint')).toHaveCount(0);
  await expect(panel.getByTestId('area-region-name')).toHaveText('West County');
  await until(() => probe(panel), (status) => !status.area?.overlay);

  await panel.bringToFront();
  await panel.getByRole('button', { name: 'Pick on map' }).click();
  await waitForPicker(panel);
  await panel.getByTestId('area-cancel-draw-btn').click();
  await expect(panel.getByTestId('area-pick-hint')).toHaveCount(0);
  await expect(panel.getByTestId('area-region-name')).toHaveText('West County');
  await until(() => probe(panel), (status) => !status.area?.overlay);

  await panel.getByRole('button', { name: 'Pick on map' }).click();
  await waitForPicker(panel);
  await dra.bringToFront();
  const before = await dra.evaluate(() => {
    const fake = (window as any).fakeDra;
    fake.setBrush(1);
    const p = fake.map.project([-75.078, 42.878]); // Column 30, row 5, in Eastfield and District 2.
    const canvas = fake.map.getCanvas().getBoundingClientRect();
    return { x: canvas.left + p.x, y: canvas.top + p.y, events: fake.mapEvents(), pops: fake.districtPops() };
  });
  await dra.mouse.click(before.x, before.y);
  await expect(panel.getByTestId('area-region-name')).toHaveText('Eastfield town');
  await expect(panel.getByTestId('area-counts')).toContainText('384 blocks');
  const area = (await state(panel)).area;
  expect(area).toMatchObject({ region: pickedTown, mode: 'prefer', drawing: false, blocks: 384 });
  expect(area.ring).toBeUndefined();
  expect(area.people).toBeGreaterThan(0);
  expect(await dra.evaluate(() => (window as any).fakeDra.mapEvents())).toEqual(before.events);
  expect(await dra.evaluate(() => (window as any).fakeDra.districtPops())).toEqual(before.pops);

  await until(storedAreas, (areas: any[]) => areas.length === 1 && areas[0].region?.name === pickedTown.name);
  expect(await storedAreas()).toEqual([{ region: pickedTown, mode: 'prefer' }]);
  await panel.close();
  panel = await openPanel(h, dra);
  await ready(panel);
  await expect(panel.getByTestId('area-region-name')).toHaveText('Eastfield town');
  expect((await state(panel)).area).toMatchObject(area);

  // Eastfield town (top-right) does not touch District 3 (bottom-left): Only reports the border message.
  await panel.getByTestId('area-mode-only').click();
  const offBorder = await solveOne(panel, 3);
  expect(offBorder.solutions).toEqual([]);
  expect(offBorder.solve.message).toMatch(/does not reach District 3's border/i);
  await expect(panel.getByTestId('area-solve-failed')).toBeVisible();
  await expect(panel.getByTestId('area-solve-failed')).toContainText(/does not reach District 3's border/i);

  await panel.getByTestId('area-clear-btn').click();
  await expect(panel.getByTestId('area-region-name')).toHaveCount(0);
  await until(storedAreas, (areas) => areas.length === 0);
  expect((await state(panel)).area).toBeUndefined();
  const unrestricted = await solveOne(panel, 3);
  expect(unrestricted.solutions.length).toBeGreaterThan(0);
  for (const card of unrestricted.solutions) expect(card.stats.outsideArea).toBeUndefined();
});

test('chooses and solves in a named region without block points', async () => {
  const manifestUrl = new URL('NY/manifest.json', h.dataUrl).href;
  await h.context.route(manifestUrl, async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    delete manifest.points;
    await route.fulfill({ response, json: manifest });
  });
  try {
    const dra = await openDra(h);
    const panel = await openPanel(h, dra);
    await ready(panel);
    await dispatch(panel, { type: 'area-pick-region', kind: 'town' });
    await expect(panel.getByTestId('area-unavailable')).toHaveText(/no block locations/i);
    expect((await state(panel)).area.picking).toBeUndefined();
    expect((await probe(panel)).area?.overlay).toBe(false);

    await panel.getByRole('button', { name: 'Town', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Pick on map' })).toBeDisabled();
    await panel.getByRole('combobox', { name: 'Town' }).selectOption({ label: pickedTown.name });
    await expect(panel.getByTestId('area-region-name')).toHaveText(pickedTown.name);
    await expect(panel.getByTestId('area-counts')).toContainText('384 blocks');
    await panel.getByTestId('area-mode-only').click();
    const result = await solveOne(panel, 4);
    expect(result.solutions.length).toBeGreaterThan(0);
    for (const card of result.solutions) {
      const geoids: string[] = await panel.evaluate((id) => (window as any).__zd.solutionBlocks(id), card.id);
      expect(geoids.length).toBeGreaterThan(0);
      for (const geoid of geoids) {
        expect(geoid.slice(0, 5)).toBe('36903');
        // The fixture assigns only the top four rows of 12 precincts to towns.
        expect(Number(geoid.slice(5, 11))).toBeLessThan(148);
      }
    }
  } finally {
    await h.context.unroute(manifestUrl);
  }
});
