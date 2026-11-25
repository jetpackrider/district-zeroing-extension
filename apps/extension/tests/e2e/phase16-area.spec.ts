/**
 * Phase 16: the area where the user would like the swap to happen (PanelState.area).
 *
 * NY fixture (fixture/generate.mjs): a 48 x 32 grid of square blocks, 0.004° a side, from
 * (-75.2, 42.9) going east and south; 4 x 4 blocks per precinct; districts by quadrant (1 top
 * left, 2 top right, 3 bottom left, 4 bottom right; district 1 also holds the top two precincts of
 * column 6, x 24..27, and the left precinct of row 4), D1 +1146, D2 −554, D3 −439, D4 −154. Each
 * block's point (BundleManifest.points) is its square's centre.
 *
 * The fake DRA page paints the precinct under a click when a brush is set (fakeDra.setBrush), and
 * counts every press and click that reaches its map (fakeDra.mapEvents()).
 */
import { test, expect, type Page } from '@playwright/test';
import { closePages, debug, dispatch, launch, openDra, openPanel, paintStep, probe, ready, solveOne, state, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.beforeEach(async () => {
  await h.sw.evaluate(() => chrome.storage.local.remove(['areas', 'districtLocks']));
});
test.afterEach(async () => closePages(h));
test.afterAll(async () => h?.close());

const X0 = -75.2;
const Y0 = 42.9;
const D = 0.004;
/** Longitude of the west edge of block column x, latitude of the north edge of block row y. */
const lngAt = (x: number) => X0 + x * D;
const latAt = (y: number) => Y0 - y * D;

type Ring = Array<[number, number]>;

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Grid cell of a fixture GEOID: tract = 100 + precinct row·12 + precinct column, block = 1000 + row·4 + column within it. */
function cellOf(geoid: string): { x: number; y: number } {
  const tract = Number(geoid.slice(5, 11)) - 100;
  const blk = Number(geoid.slice(11, 15)) - 1000;
  const px = tract % 12;
  const py = Math.floor(tract / 12);
  return { x: px * 4 + (blk % 4), y: py * 4 + Math.floor(blk / 4) };
}
const centreOf = (c: { x: number; y: number }) => [X0 + (c.x + 0.5) * D, Y0 - (c.y + 0.5) * D] as const;

/** Blocks of the fixture whose centre lies in the ring (what the panel should count). */
function blocksInRing(ring: Ring): number {
  let n = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 48; x++) if (inRing(...centreOf({ x, y }), ring)) n++;
  return n;
}

/** Where a longitude/latitude is on the DRA page, in page pixels. */
const screen = (dra: Page, lng: number, lat: number) =>
  dra.evaluate(([x, y]) => {
    const m = (window as any).fakeDra.map;
    const p = m.project([x, y]);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [lng, lat] as const);

const clickAt = async (dra: Page, lng: number, lat: number) => {
  const p = await screen(dra, lng, lat);
  await dra.mouse.click(p.x, p.y);
};

const mapEvents = (dra: Page) => dra.evaluate(() => (window as any).fakeDra.mapEvents());
const draPops = (dra: Page) => dra.evaluate(() => (window as any).fakeDra.districtPops());
const areaStatus = async (panel: Page) => (await probe(panel)).area;

async function startDrawing(panel: Page, dra: Page) {
  await dispatch(panel, { type: 'area-draw' });
  await waitState(panel, (s) => s.area?.drawing === true);
  await until(() => areaStatus(panel), (a: any) => a?.drawing && a.overlay);
  await dra.bringToFront();
}

/** Draws a box by clicking its four corners on DRA's map, then the first corner again. */
async function drawBox(panel: Page, dra: Page, [w, s, e, n]: [number, number, number, number]) {
  await startDrawing(panel, dra);
  for (const [x, y] of [[w, n], [e, n], [e, s], [w, s]] as const) await clickAt(dra, x, y);
  await clickAt(dra, w, n);
  return waitState(panel, (t) => !t.area?.drawing && t.area?.ring?.length === 4 && t.area.blocks !== undefined);
}

const solved = (panel: Page) => waitState(panel, (s) => s.solve.status !== 'solving' && s.solve.status !== 'idle', 60_000);

test('drawing an area on DRA\'s map: the clicks never reach DRA, the outline shows, and the blocks inside are counted', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const d = await debug(panel);
  expect(d.check.items.find((i: any) => i.id === 'map.unproject() (area drawing)')?.ok).toBe(true);
  expect(d.area.points).toBe(true);
  expect((await state(panel)).area).toBeUndefined();

  // DRA's paint tool is on: any click that got through would repaint a precinct.
  await dra.evaluate(() => (window as any).fakeDra.setBrush(1));
  const popsBefore = await draPops(dra);
  const eventsBefore = await mapEvents(dra);

  // Top half of the 1 | 2 border: columns 16..32, rows 0..16.
  const s = await drawBox(panel, dra, [lngAt(16), latAt(16), lngAt(32), latAt(0)]);
  expect(s.area.mode).toBe('prefer');
  expect(s.area.unavailable).toBeUndefined();
  const ring: Ring = s.area.ring;
  expect(ring[0][0]).toBeCloseTo(lngAt(16), 3);
  expect(ring[0][1]).toBeCloseTo(latAt(0), 3);
  expect(s.area.blocks).toBe(blocksInRing(ring));
  expect(s.area.blocks).toBe(16 * 16);
  expect(s.area.people).toBeGreaterThan(0);

  // Nothing reached DRA's map, and nothing was painted.
  expect(await mapEvents(dra)).toEqual(eventsBefore);
  expect(await draPops(dra)).toEqual(popsBefore);

  // The outline is on DRA's map, as zd- layers on top of DRA's own, and the overlay is gone.
  const a = await until(() => areaStatus(panel), (x: any) => x.ringCorners === 4 && !x.drawing && !x.overlay && x.featureCount === 1);
  expect(a.layers).toEqual(['zd-area-fill', 'zd-area-line', 'zd-area-draft', 'zd-area-corner']);
  expect(a.clicks).toBe(5);
  const p = await probe(panel);
  expect(p.onTop).toBe(true);

  // With walkthrough highlights on the map too, they stay above the area (numbers on top).
  const r = await solveOne(panel, 1);
  await dispatch(panel, { type: 'hover-solution', id: r.solutions[0].id });
  await until(() => probe(panel), (x: any) => x.featureCount > 0 && x.onTop);
  const tail = await dra.evaluate(() => (window as any).fakeDra.layerIds().filter((l: string) => l.startsWith('zd-')));
  expect(tail).toEqual(['zd-area-fill', 'zd-area-line', 'zd-area-draft', 'zd-area-corner', 'zd-fill', 'zd-line']);
  // DRA re-renders (its layers to the top) and switches basemap: everything comes back in order.
  await dra.evaluate(() => (window as any).fakeDra.rerender());
  await until(() => probe(panel), (x: any) => x.onTop);
  await dra.evaluate(() => (window as any).fakeDra.switchBasemap());
  await until(() => probe(panel), (x: any) => x.onTop && x.styleLoads >= 1 && x.area?.featureCount === 1);
  expect(await dra.evaluate(() => (window as any).fakeDra.layerIds().slice(-6))).toEqual(['zd-area-fill', 'zd-area-line', 'zd-area-draft', 'zd-area-corner', 'zd-fill', 'zd-line']);

  // The brush really paints when a click does reach DRA (so the check above means something).
  await dra.bringToFront();
  await clickAt(dra, lngAt(40.5), latAt(28.5));
  await until(() => mapEvents(dra), (e: any) => e.click === eventsBefore.click + 1);
  expect(await draPops(dra)).not.toEqual(popsBefore);
});

test('while drawing: drag pans, the wheel zooms, a double-click finishes; DRA re-rendering its map pane does not break it; Esc cancels', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const before = await mapEvents(dra);
  await startDrawing(panel, dra);

  const A = [lngAt(2), latAt(2)] as const;
  const B = [lngAt(20), latAt(4)] as const;
  const C = [lngAt(10), latAt(14)] as const;
  await clickAt(dra, ...A);
  await until(() => areaStatus(panel), (x: any) => x.corners === 1);

  // Drag: the map pans, no corner is added.
  const camera = () => dra.evaluate(() => {
    const m = (window as any).fakeDra.map;
    const c = m.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: m.getZoom() };
  });
  const c0 = await camera();
  const from = await screen(dra, lngAt(30), latAt(20));
  await dra.mouse.move(from.x, from.y);
  await dra.mouse.down();
  for (let i = 1; i <= 6; i++) await dra.mouse.move(from.x + 15 * i, from.y + 5 * i);
  await dra.mouse.up();
  const c1 = await camera();
  expect(c1.lng).toBeLessThan(c0.lng); // dragged right: the view moved west
  let st = await areaStatus(panel);
  expect(st.corners).toBe(1);
  expect(st.pans).toBe(1);

  // Wheel: zooms in around the pointer.
  await dra.mouse.move(from.x, from.y);
  await dra.mouse.wheel(0, -300);
  await until(camera, (c) => c.zoom > c1.zoom + 0.5);

  // DRA re-renders its map pane (drops what is not the map's own) and its layers.
  await dra.evaluate(() => (window as any).fakeDra.wipeMapDom());
  await until(() => areaStatus(panel), (x: any) => x.overlay && x.drawing);
  await dra.evaluate(() => (window as any).fakeDra.rerender());

  await clickAt(dra, ...B);
  const pc = await screen(dra, ...C);
  await dra.mouse.dblclick(pc.x, pc.y);
  const s = await waitState(panel, (t) => !t.area?.drawing && t.area?.ring?.length === 3);
  const ring: Ring = s.area.ring;
  [A, B, C].forEach((p, i) => {
    expect(ring[i][0]).toBeCloseTo(p[0], 3);
    expect(ring[i][1]).toBeCloseTo(p[1], 3);
  });
  expect(s.area.blocks).toBe(blocksInRing(ring));
  st = await areaStatus(panel);
  expect(st.zooms).toBeGreaterThan(0);
  // Nothing of it reached DRA: no press, click or double-click (DRA would also zoom on one).
  const after = await mapEvents(dra);
  expect(after.click).toBe(before.click);
  expect(after.mousedown).toBe(before.mousedown);
  expect(after.dblclick).toBe(before.dblclick);
  expect(after.canvasPointerdown).toBe(before.canvasPointerdown);

  // Esc on DRA's page cancels a new drawing; the area stays as it was.
  await startDrawing(panel, dra);
  await clickAt(dra, lngAt(30), latAt(30));
  await dra.keyboard.press('Escape');
  const t = await waitState(panel, (x) => !x.area?.drawing);
  expect(t.area.ring).toEqual(ring);
  await until(() => areaStatus(panel), (x: any) => !x.drawing && !x.overlay && x.ringCorners === 3);

  // The panel's Cancel does the same.
  await startDrawing(panel, dra);
  await dispatch(panel, { type: 'area-cancel-draw' });
  await until(() => areaStatus(panel), (x: any) => !x.drawing && !x.overlay);
  expect((await state(panel)).area.ring).toEqual(ring);
});

test('Prefer vs Only: an area where nothing works; Only says the area is why, Prefer fills from outside and the card says so', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  // Deep inside district 3 (bottom left), far from district 1: nothing there can zero district 1.
  await drawBox(panel, dra, [lngAt(2), latAt(31), lngAt(8), latAt(26)]);
  await dispatch(panel, { type: 'set-area-mode', mode: 'only' });
  expect((await state(panel)).area.mode).toBe('only');

  const only = await solveOne(panel, 1);
  console.log(`  only, small area: ${only.solutions.length} option(s), ${only.solve.status}: ${only.solve.message}`);
  expect(only.solutions).toEqual([]);
  expect(only.solve.message).toMatch(/area/i);
  expect(only.solve.message).toMatch(/Prefer/);
  expect(only.solve.message).toMatch(/bigger area/);
  await expect(panel.getByTestId('area-solve-failed')).toBeVisible();

  // Changing the mode drops what was on offer (it was found for the old rules).
  await dispatch(panel, { type: 'set-area-mode', mode: 'prefer' });
  const s1 = await state(panel);
  expect(s1.solutions).toEqual([]);
  expect(s1.solve.status).toBe('idle');

  await dispatch(panel, { type: 'solve' });
  const prefer = await solved(panel);
  console.log(`  prefer, small area: ${prefer.solutions.length} option(s), outside ${prefer.solutions.map((c: any) => c.stats.outsideArea).join(',')}`);
  expect(prefer.solutions.length).toBeGreaterThan(0);
  for (const card of prefer.solutions) expect(card.stats.outsideArea).toBeGreaterThan(0);
  expect(prefer.solve.message).toMatch(/outside/);
  await expect(panel.getByTestId(`outside-area-${prefer.solutions[0].id}`)).toBeVisible();
});

test('Only keeps every moved block inside a workable area; Prefer lists inside options first', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  // District 1 and a band around its borders with 2 and 3: columns 0..32, rows 0..24.
  const s = await drawBox(panel, dra, [lngAt(0), latAt(24), lngAt(32), latAt(0)]);
  const ring: Ring = s.area.ring;

  const prefer = await solveOne(panel, 1);
  console.log(`  prefer, big area: ${prefer.solutions.length} option(s), outside ${prefer.solutions.map((c: any) => c.stats.outsideArea).join(',')}`);
  expect(prefer.solutions.length).toBeGreaterThan(0);
  const outs: number[] = prefer.solutions.map((c: any) => c.stats.outsideArea);
  expect(outs.every((x) => typeof x === 'number')).toBe(true);
  // Inside-only options first, then fewest outside blocks.
  expect([...outs].sort((a, b) => a - b)).toEqual(outs);

  await dispatch(panel, { type: 'set-area-mode', mode: 'only' });
  await dispatch(panel, { type: 'solve' });
  const only = await solved(panel);
  console.log(`  only, big area: ${only.solutions.length} option(s), ${only.solve.status}${only.solve.message ? `: ${only.solve.message}` : ''}`);
  expect(only.solutions.length).toBeGreaterThan(0);
  for (const card of only.solutions) {
    expect(card.stats.outsideArea).toBe(0);
    const geoids: string[] = await panel.evaluate((id) => (window as any).__zd.solutionBlocks(id), card.id);
    expect(geoids.length).toBeGreaterThan(0);
    for (const g of geoids) expect(inRing(...centreOf(cellOf(g)), ring)).toBe(true);
  }

  // A whole-map solve honors it too (the 2 | 4 and 3 | 4 borders run through the area).
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const group = await solved(panel);
  console.log(`  only, big area, whole map: ${group.solutions.length} plan(s), ${group.solve.status}${group.solve.message ? `: ${group.solve.message}` : ''}`);
  for (const card of group.solutions) {
    expect(card.stats.outsideArea).toBe(0);
    const geoids: string[] = await panel.evaluate((id) => (window as any).__zd.solutionBlocks(id), card.id);
    for (const g of geoids) expect(inRing(...centreOf(cellOf(g)), ring)).toBe(true);
  }
  if (!group.solutions.length) expect(group.solve.message).toMatch(/area/i);
});

test('the area is remembered for the map when the panel is reopened, cannot change during a walkthrough, and clears', async () => {
  const dra = await openDra(h);
  let panel = await openPanel(h, dra);
  await ready(panel);
  const s = await drawBox(panel, dra, [lngAt(16), latAt(16), lngAt(32), latAt(0)]);
  await dispatch(panel, { type: 'set-area-mode', mode: 'only' });
  await until(
    () => h.sw.evaluate(() => chrome.storage.local.get('areas').then((v) => Object.values(v.areas ?? {}))),
    (v: any) => v.length === 1 && v[0].mode === 'only' && v[0].ring.length === 4,
  );

  await panel.close();
  // A closed panel takes the outline off DRA's map.
  await until(() => dra.evaluate(() => (window as any).fakeDra.layerIds().filter((l: string) => l.startsWith('zd-area')).length), (n) => n === 0);
  panel = await openPanel(h, dra);
  await ready(panel);
  const back = await waitState(panel, (t) => t.area?.blocks !== undefined);
  expect(back.area.ring).toEqual(s.area.ring);
  expect(back.area.mode).toBe('only');
  expect(back.area.blocks).toBe(s.area.blocks);
  expect(back.area.drawing).toBe(false);
  // ...and the reopened panel puts it back.
  await until(() => areaStatus(panel), (x: any) => x.ringCorners === 4 && x.featureCount === 1);

  // During a walkthrough the area cannot change.
  await dispatch(panel, { type: 'set-area-mode', mode: 'prefer' });
  const r = await solveOne(panel, 1);
  expect(r.solutions.length).toBeGreaterThan(0);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  await waitState(panel, (t) => !!t.walkthrough);
  await dispatch(panel, { type: 'area-clear' });
  await dispatch(panel, { type: 'set-area-mode', mode: 'only' });
  await dispatch(panel, { type: 'area-draw' });
  const w = await state(panel);
  expect(w.area.ring).toEqual(s.area.ring);
  expect(w.area.mode).toBe('prefer');
  expect(w.area.drawing).toBe(false);
  await dispatch(panel, { type: 'walkthrough-end' });

  // Clear: gone from the panel, the storage and DRA's map; moves may happen anywhere again.
  await dispatch(panel, { type: 'area-clear' });
  const cleared = await state(panel);
  expect(cleared.area).toBeUndefined();
  await until(() => h.sw.evaluate(() => chrome.storage.local.get('areas').then((v) => Object.keys(v.areas ?? {}).length)), (n) => n === 0);
  await until(() => areaStatus(panel), (x: any) => x.ringCorners === 0 && x.layers.length === 0);
  const free = await solveOne(panel, 1);
  for (const card of free.solutions) expect(card.stats.outsideArea).toBeUndefined();
});

test('"Use map view" takes the part of DRA\'s map in view', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  // Zoom DRA's map onto the top-left quarter of the fixture (district 1's corner).
  const bounds = await dra.evaluate(([w, s, e, n]) => {
    const m = (window as any).fakeDra.map;
    m.fitBounds([[w, s], [e, n]], { duration: 0, padding: 0 });
    const b = m.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }, [lngAt(0), latAt(16), lngAt(24), latAt(0)] as const);
  await dispatch(panel, { type: 'area-use-view' });
  const s = await waitState(panel, (t) => t.area?.ring?.length === 4 && t.area.blocks !== undefined);
  const xs = s.area.ring.map((p: number[]) => p[0]);
  const ys = s.area.ring.map((p: number[]) => p[1]);
  expect(Math.min(...xs)).toBeCloseTo(bounds[0], 4);
  expect(Math.min(...ys)).toBeCloseTo(bounds[1], 4);
  expect(Math.max(...xs)).toBeCloseTo(bounds[2], 4);
  expect(Math.max(...ys)).toBeCloseTo(bounds[3], 4);
  expect(s.area.blocks).toBe(blocksInRing(s.area.ring));
  expect(s.area.blocks).toBeGreaterThanOrEqual(24 * 16);
});

test('no DRA map handle: drawing is unavailable (with the reason), "Use map view" takes the mini-map\'s view and the outline shows there', async () => {
  const dra = await openDra(h, 'nomap=1');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await waitState(panel, (t) => !!t.area?.unavailable);
  expect(s.mapMode).toBe('mini');
  expect(s.area.unavailable).toMatch(/Drawing an area needs DRA's map/);
  await dispatch(panel, { type: 'area-draw' });
  expect((await state(panel)).area.drawing).toBe(false);

  await panel.waitForSelector('.zd-minimap', { timeout: 10_000 });
  await dispatch(panel, { type: 'area-use-view' });
  const t = await waitState(panel, (x) => x.area?.ring?.length === 4 && x.area.blocks !== undefined);
  // The mini-map starts on a view of the whole fixture.
  expect(t.area.blocks).toBe(48 * 32);
  const mini = await until(
    () =>
      panel.evaluate(() => {
        const d = (document.querySelector('.zd-minimap') as any)?.__zdMap?.getSource('zd-area')?._data;
        const fc = d?.features ? d : d?.geojson;
        return fc?.features?.length ?? 0;
      }),
    (n) => n === 1,
  );
  expect(mini).toBe(1);
});

/** Every block each card moves lies inside the ring (from the GEOIDs, not the card stats). */
async function expectAllInside(panel: Page, cards: any[], ring: Ring) {
  for (const card of cards) {
    expect(card.stats.outsideArea).toBe(0);
    const geoids: string[] = await panel.evaluate((id) => (window as any).__zd.solutionBlocks(id), card.id);
    expect(geoids.length).toBeGreaterThan(0);
    for (const g of geoids) expect(inRing(...centreOf(cellOf(g)), ring)).toBe(true);
  }
}

/** How many of the blocks a card moves lie outside the ring (GEOIDs). */
async function outsideOf(panel: Page, id: string, ring: Ring): Promise<number> {
  const geoids: string[] = await panel.evaluate((x) => (window as any).__zd.solutionBlocks(x), id);
  return geoids.filter((g) => !inRing(...centreOf(cellOf(g)), ring)).length;
}

test('Prefer with a little inside: the options inside come first, the ones that fill from outside follow, flagged', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  // Around where districts 1 and 2 meet below district 1's notch (columns 12..28, rows 8..20):
  // no one-way move for district 1 stays in it, but a two-way plan does.
  const s = await drawBox(panel, dra, [lngAt(12), latAt(20), lngAt(28), latAt(8)]);
  const ring: Ring = s.area.ring;

  const prefer = await solveOne(panel, 1);
  const outs: number[] = prefer.solutions.map((c: any) => c.stats.outsideArea);
  console.log(`  prefer, one district, mixed: ${prefer.solutions.map((c: any) => `${c.kind}:${c.stats.outsideArea}`).join(' ')} | ${prefer.solve.message}`);
  expect(outs[0]).toBe(0);
  expect(outs.some((x) => x > 0)).toBe(true);
  expect([...outs].sort((a, b) => a - b)).toEqual(outs);
  // The counts on the cards are the blocks really outside the ring.
  for (const card of prefer.solutions) expect(await outsideOf(panel, card.id, ring)).toBe(card.stats.outsideArea);
  const first = prefer.solutions[0];
  const filler = prefer.solutions.find((c: any) => c.stats.outsideArea > 0);
  await expect(panel.getByTestId(`inside-area-${first.id}`)).toBeVisible();
  await expect(panel.getByTestId(`outside-area-${filler.id}`)).toBeVisible();
  await expect(panel.getByTestId(`outside-area-${filler.id}`)).toContainText(`${filler.stats.outsideArea} block`);
  await expect(panel.getByTestId(`outside-area-${first.id}`)).toHaveCount(0);
  // The status line says why the first ones trade both ways, and says it once.
  expect(prefer.solve.message).toMatch(/both directions inside it/);
  expect(prefer.solve.message).not.toMatch(/Nothing inside the area hits the target/);
  await expect(panel.getByTestId('solve-note')).toContainText('both directions inside it');

  // Whole map, the west half across the middle (columns 0..24, rows 9..23): one plan stays inside,
  // and the planner's other plan, found without the area, fills the next place, flagged.
  await dispatch(panel, { type: 'area-clear' });
  const band = await drawBox(panel, dra, [lngAt(0), latAt(23), lngAt(24), latAt(9)]);
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'all' } });
  await dispatch(panel, { type: 'solve' });
  const all = await solved(panel);
  const plans: number[] = all.solutions.map((c: any) => c.stats.outsideArea);
  console.log(`  prefer, whole map, mixed: ${all.solutions.map((c: any) => `${c.kind}:${c.stats.outsideArea}`).join(' ')} | ${all.solve.message ?? ''}`);
  expect(plans.length).toBeGreaterThan(1);
  expect(plans[0]).toBe(0);
  expect(plans.some((x) => x > 0)).toBe(true);
  expect([...plans].sort((a, b) => a - b)).toEqual(plans);
  for (const card of all.solutions) expect(await outsideOf(panel, card.id, band.area.ring)).toBe(card.stats.outsideArea);
  // The planner's whole-map line ("This group can be zeroed on its own.") is still not shown.
  expect(all.solve.message ?? '').not.toMatch(/zeroed on its own/);
});

test('a group with an area: Only keeps its plans inside, the mode switch in the panel works, and a small area fails with the area message', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const s = await drawBox(panel, dra, [lngAt(12), latAt(20), lngAt(28), latAt(8)]);
  const ring: Ring = s.area.ring;
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'group', districts: [1, 2], allowOutsideAbsorb: true } });
  // The panel's own switch, clicked.
  await panel.getByTestId('area-mode-only').click();
  await waitState(panel, (t) => t.area?.mode === 'only');
  await dispatch(panel, { type: 'solve' });
  const only = await solved(panel);
  console.log(`  only, group 1+2: ${only.solutions.map((c: any) => `${c.kind}:${c.stats.outsideArea}`).join(' ')} | ${only.solve.message ?? ''}`);
  expect(only.solve.status).toBe('done');
  expect(only.solutions.length).toBeGreaterThan(0);
  await expectAllInside(panel, only.solutions, ring);

  // A small area away from where the group can balance: nothing, and the area is named as the reason.
  await dispatch(panel, { type: 'area-clear' });
  await dispatch(panel, { type: 'set-area-mode', mode: 'only' }); // the next area starts in Only
  const small = await drawBox(panel, dra, [lngAt(22), latAt(14), lngAt(26), latAt(10)]);
  expect(small.area.mode).toBe('only');
  await dispatch(panel, { type: 'solve' });
  const none = await solved(panel);
  console.log(`  only, group 1+2, small area: ${none.solve.status}: ${none.solve.message}`);
  expect(none.solutions).toEqual([]);
  expect(none.solve.message).toMatch(/^Nothing inside your area zeroes this group/);
  await expect(panel.getByTestId('area-solve-failed')).toBeVisible();
  // "Prefer the area instead" in the callout switches the mode (and drops the old result).
  await panel.getByTestId('area-solve-failed').getByRole('button', { name: 'Prefer the area instead' }).click();
  const back = await waitState(panel, (t) => t.area?.mode === 'prefer' && t.solve.status === 'idle');
  expect(back.solutions).toEqual([]);
  await dispatch(panel, { type: 'solve' });
  const prefer = await solved(panel);
  expect(prefer.solutions.length).toBeGreaterThan(0);
  for (const card of prefer.solutions) expect(card.stats.outsideArea).toBeGreaterThan(0);
  expect(prefer.solve.message).toMatch(/^Nothing inside your area works/);
  // Said once: the planner's own note is not repeated.
  expect(prefer.solve.message).not.toMatch(/No plan moves only blocks inside the area/);

  // The panel's Clear button.
  await panel.getByTestId('area-clear-btn').click();
  await waitState(panel, (t) => t.area === undefined);
});

test('re-plan from here keeps the area: with Only, the new plan still moves only blocks inside it', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  // District 1 and a band around its borders with 2 and 3 (as above), Only.
  const s = await drawBox(panel, dra, [lngAt(0), latAt(24), lngAt(32), latAt(0)]);
  const ring: Ring = s.area.ring;
  await dispatch(panel, { type: 'set-area-mode', mode: 'only' });
  const r = await solveOne(panel, 1);
  expect(r.solutions.length).toBeGreaterThan(0);
  await expectAllInside(panel, r.solutions, ring);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = await waitState(panel, (t) => !!t.walkthrough);
  // Paint the first step, then re-plan from the map as it is now.
  const first = w.walkthrough.steps[0];
  await paintStep(dra, first);
  await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === first.id).status === 'done');
  await dispatch(panel, { type: 'walkthrough-replan' });
  const re = await waitState(panel, (x) => x.walkthrough && x.walkthrough.solutionId !== w.walkthrough.solutionId && x.solve.status === 'done', 30_000);
  console.log(`  re-plan with Only: ${re.solutions.map((c: any) => `${c.kind}:${c.stats.outsideArea}`).join(' ')} | ${re.solve.message ?? ''}`);
  expect(re.area.ring).toEqual(ring);
  expect(re.area.mode).toBe('only');
  expect(re.solutions.length).toBeGreaterThan(0);
  await expectAllInside(panel, re.solutions, ring);
  // Every step of the new walkthrough is inside too.
  for (const st of re.walkthrough.steps) for (const b of st.blocks) expect(inRing(...centreOf(cellOf(b.geoid)), ring)).toBe(true);
  await dispatch(panel, { type: 'walkthrough-end' });
});
