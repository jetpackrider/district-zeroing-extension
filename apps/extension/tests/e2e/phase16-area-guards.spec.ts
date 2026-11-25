/**
 * Phase 16, the area (PanelState.area): the guards around it. What the user marks must never be
 * ignored silently or let a click through to DRA's map, and an area costs nothing until it is used.
 *
 * NY fixture as in phase16-area.spec.ts: a 48 x 32 grid of square blocks, 0.004° a side, from
 * (-75.2, 42.9) going east and south; districts by quadrant (1 top left, 2 top right, 3 bottom
 * left, 4 bottom right).
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { closePages, debug, dispatch, launch, openDra, openPanel, paintStep, probe, ready, ROOT, solveOne, state, until, waitState, type Harness } from './harness';

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
const lngAt = (x: number) => X0 + x * D;
const latAt = (y: number) => Y0 - y * D;

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
/** Waits past a double-click window, so the next click is a click of its own. */
const pause = (dra: Page) => dra.waitForTimeout(500);

async function startDrawing(panel: Page, dra: Page) {
  await dispatch(panel, { type: 'area-draw' });
  await waitState(panel, (s) => s.area?.drawing === true);
  await until(() => areaStatus(panel), (a: any) => a?.drawing && a.overlay);
  await dra.bringToFront();
}

test('the block points are read only once an area needs them', async () => {
  const points: string[] = [];
  h.context.on('request', (r) => {
    if (/\/data\/NY\/points\./.test(r.url())) points.push(r.url());
  });
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  let d = await debug(panel);
  // The data has them (manifest), and they are not read: no area yet.
  expect(d.area.points).toBe(true);
  expect(d.area.pointsLoaded).toBe(false);
  expect(points).toEqual([]);
  expect((await state(panel)).area).toBeUndefined();
  await dispatch(panel, { type: 'area-use-view' });
  const s = await waitState(panel, (t) => t.area?.ring?.length === 4 && t.area.blocks !== undefined);
  expect(s.area.blocks).toBeGreaterThan(0);
  d = await debug(panel);
  expect(d.area.pointsLoaded).toBe(true);
  expect(points.length).toBeLessThanOrEqual(1);
});

test('Load CSV while drawing stops the drawing: DRA\'s map is let go and nothing is saved for the CSV map', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await startDrawing(panel, dra);
  const csv: string = await dra.evaluate(() => (window as any).fakeDra.exportCsv());
  await dispatch(panel, { type: 'load-csv', text: csv, fileName: 'plan.csv' });
  const c = await waitState(panel, (x) => x.connection === 'csv' && x.map?.sourceName === 'plan.csv');
  expect(c.area?.drawing ?? false).toBe(false);
  // The page hook stopped drawing: its overlay is gone, so clicks are DRA's again.
  await until(() => dra.evaluate(() => !!document.querySelector('.zd-area-overlay')), (x) => x === false);
  await dra.bringToFront();
  for (const [x, y] of [[2, 2], [20, 2], [10, 14], [2, 2]] as const) {
    await clickAt(dra, lngAt(x), latAt(y));
    await pause(dra);
  }
  await dra.waitForTimeout(300);
  expect((await state(panel)).area?.ring).toBeUndefined();
  const saved = await h.sw.evaluate(() => chrome.storage.local.get('areas').then((v) => v.areas ?? {}));
  expect(saved).toEqual({});
  await dispatch(panel, { type: 'retry-connection' });
  await waitState(panel, (x) => x.connection === 'live', 30_000);
});

test('while drawing, a press right after DRA re-renders its map pane never reaches DRA', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await dra.evaluate(() => (window as any).fakeDra.setBrush(1));
  const pops0 = await draPops(dra);
  const ev0 = await mapEvents(dra);
  await startDrawing(panel, dra);

  // A real click straight after the re-render: the overlay is back before it lands, so it is a corner.
  await dra.evaluate(() => (window as any).fakeDra.wipeMapDom());
  await clickAt(dra, lngAt(6), latAt(6));
  await until(() => areaStatus(panel), (x: any) => x.corners === 1);

  // Presses dispatched in the same task as the re-render, before anything could put the overlay
  // back: the window-level guard stops them.
  const p = await screen(dra, lngAt(30), latAt(10));
  await dra.evaluate(([x, y]) => {
    (window as any).fakeDra.wipeMapDom();
    const canvas = (window as any).fakeDra.map.getCanvas() as HTMLCanvasElement;
    const at = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 9, isPrimary: true }));
    canvas.dispatchEvent(new MouseEvent('mousedown', at));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerId: 9, isPrimary: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup', at));
    canvas.dispatchEvent(new MouseEvent('click', at));
  }, [p.x, p.y] as const);
  await until(() => areaStatus(panel), (x: any) => x.overlay && x.drawing);
  await dra.waitForTimeout(200);

  const ev1 = await mapEvents(dra);
  expect(ev1).toEqual(ev0);
  expect(await draPops(dra)).toEqual(pops0);
  await dispatch(panel, { type: 'area-cancel-draw' });
  await dra.evaluate(() => (window as any).fakeDra.setBrush(null));
});

test('closing too early or with crossing edges keeps drawing, with a hint; Backspace fixes it', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  await startDrawing(panel, dra);
  const hint = () => dra.evaluate(() => document.querySelector('.zd-area-hint')?.textContent ?? '');
  const A = [lngAt(2), latAt(2)] as const;
  const B = [lngAt(20), latAt(2)] as const;
  const C = [lngAt(2), latAt(14)] as const;
  const E = [lngAt(20), latAt(14)] as const;
  await clickAt(dra, ...A);
  await pause(dra);
  await clickAt(dra, ...B);
  await pause(dra);
  // Two corners, then the first again: not a third corner on top of it, and not closed.
  await clickAt(dra, ...A);
  await pause(dra);
  // A double-click on it does not close either.
  const pa = await screen(dra, ...A);
  await dra.mouse.dblclick(pa.x + 2, pa.y + 2);
  await pause(dra);
  let st = await areaStatus(panel);
  expect(st.drawing).toBe(true);
  expect(st.corners).toBe(2);
  expect(await hint()).toMatch(/at least 3 corners/);
  let s = await state(panel);
  expect(s.area.drawing).toBe(true);
  expect(s.area.ring).toBeUndefined();
  expect(s.notice?.text ?? '').not.toMatch(/not a usable area/);

  // A bow tie: A, B, C, E crosses itself (B–C crosses E–A). Closing on A is refused.
  await clickAt(dra, ...C);
  await pause(dra);
  await clickAt(dra, ...E);
  await pause(dra);
  await clickAt(dra, ...A);
  await pause(dra);
  st = await areaStatus(panel);
  expect(st.drawing).toBe(true);
  expect(st.corners).toBe(4);
  expect(await hint()).toMatch(/crosses itself/);
  expect((await state(panel)).area.ring).toBeUndefined();

  // Backspace takes E back; A, B, C is a triangle, and closing on A finishes it.
  await dra.keyboard.press('Backspace');
  await until(() => areaStatus(panel), (x: any) => x.corners === 3);
  await clickAt(dra, ...A);
  s = await waitState(panel, (t) => !t.area?.drawing && t.area?.ring?.length === 3);
  [A, B, C].forEach((q, i) => {
    expect(s.area.ring[i][0]).toBeCloseTo(q[0], 3);
    expect(s.area.ring[i][1]).toBeCloseTo(q[1], 3);
  });
});

test('DRA\'s map without what drawing uses: "Use map view" stays on and works; Draw says why', async () => {
  const dra = await openDra(h, 'nopan=1');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const d = await until(() => debug(panel), (x: any) => !!x.check);
  expect(d.check.items.find((i: any) => i.id === 'map.unproject() (area drawing)')?.ok).toBe(false);
  const s0 = await state(panel);
  expect(s0.mapMode ?? 'dra').toBe('dra');
  // Nothing in AreaState says "can't": the card would turn "Use map view" off with it.
  expect(s0.area?.unavailable).toBeUndefined();
  await expect(panel.getByTestId('area-use-view-btn')).toBeEnabled();
  await panel.getByTestId('area-use-view-btn').click();
  const s1 = await waitState(panel, (t) => t.area?.ring?.length === 4 && t.area.blocks !== undefined);
  expect(s1.area.blocks).toBeGreaterThan(0);
  await dispatch(panel, { type: 'area-draw' });
  const s2 = await waitState(panel, (t) => /lacks what drawing uses/.test(t.notice?.text ?? ''));
  expect(s2.notice.text).toMatch(/panBy/);
  expect(s2.area.drawing).toBe(false);
  expect((await areaStatus(panel)).drawing).toBe(false);
});

test('re-plan from here that finds nothing says so in the banner (the walkthrough view shows no solve status)', async () => {
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await ready(panel);
  const r = await solveOne(panel, 1);
  expect(r.solutions.length).toBeGreaterThan(0);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  let w = (await waitState(panel, (t) => !!t.walkthrough)).walkthrough;
  // Paint every step: from here there is nothing left to plan.
  for (let guard = 0; guard < 50 && !w.steps.every((x: any) => x.status === 'done'); guard++) {
    const step = w.steps.find((x: any) => x.status !== 'done');
    await paintStep(dra, step);
    w = (await waitState(panel, (t) => t.walkthrough.steps.find((x: any) => x.id === step.id).status === 'done')).walkthrough;
  }
  await dispatch(panel, { type: 'walkthrough-replan' });
  const s = await waitState(panel, (t) => /^Re-plan from here found nothing/.test(t.notice?.text ?? ''), 30_000);
  expect(s.walkthrough).toBeTruthy();
  expect(s.notice.level).toBe('warn');
  // Scoped to the panel: the diagnostics footer repeats the notice text (debounced), outside #root.
  await expect(panel.locator('#root').getByText(/Re-plan from here found nothing/)).toBeVisible();
  await dispatch(panel, { type: 'walkthrough-end' });
});

test.describe('state data without block points', () => {
  let bare: Harness;
  test.beforeAll(async () => {
    // The fixture data with NY's points sidecar left out of the manifest (as on a data host
    // published before points existed).
    const dir = mkdtempSync(join(tmpdir(), 'zd-nopoints-'));
    cpSync(join(ROOT, 'fixture/data'), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'NY/manifest.json'), 'utf8'));
    delete manifest.points;
    writeFileSync(join(dir, 'NY/manifest.json'), JSON.stringify(manifest));
    bare = await launch({ data: dir });
  });
  test.afterAll(async () => bare?.close());

  test('an area saved earlier is not ignored silently: Only does not solve, Prefer solves without it and says so', async () => {
    // Saved under the map's id (DRA's session id), as the panel keeps areas.
    const key = 'live|NY|4|session:fixture-session-NY';
    const ring = [[lngAt(0), latAt(0)], [lngAt(20), latAt(0)], [lngAt(20), latAt(20)], [lngAt(0), latAt(20)]];
    await bare.sw.evaluate(([k, r]) => chrome.storage.local.set({ areas: { [k as string]: { ring: r, mode: 'only' } } }), [key, ring] as const);
    const dra = await openDra(bare);
    const panel = await openPanel(bare, dra);
    await ready(panel);
    const d = await until(() => debug(panel), (x: any) => x.area.points !== null);
    expect(d.area.points).toBe(false);
    expect(d.area.key).toBe(key);
    const s = await waitState(panel, (t) => !!t.area?.unavailable);
    expect(s.area.unavailable).toMatch(/no block locations/);
    expect(s.area.ring).toHaveLength(4);
    expect(s.area.mode).toBe('only');

    const only = await solveOne(panel, 1);
    expect(only.solutions).toEqual([]);
    expect(only.solve.status).toBe('error');
    expect(only.solve.message).toMatch(/set to Only, but it can't be used/);

    await dispatch(panel, { type: 'set-area-mode', mode: 'prefer' });
    await dispatch(panel, { type: 'solve' });
    const prefer = await waitState(panel, (t) => t.solve.status !== 'solving' && t.solve.status !== 'idle', 40_000);
    expect(prefer.solutions.length).toBeGreaterThan(0);
    expect(prefer.solve.message).toMatch(/^Your area was not used: /);
    for (const card of prefer.solutions) expect(card.stats.outsideArea).toBeUndefined();

    // A new area cannot be marked on this data: "Use map view" keeps nothing.
    await dispatch(panel, { type: 'area-clear' });
    await waitState(panel, (t) => !t.area?.ring);
    await dispatch(panel, { type: 'area-use-view' });
    await dra.waitForTimeout(300);
    expect((await state(panel)).area?.ring).toBeUndefined();
    await closePages(bare);
  });
});
