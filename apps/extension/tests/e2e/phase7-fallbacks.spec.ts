/** Phase 7: forced fallbacks against the fixture. */
import { test, expect } from '@playwright/test';
import { closePages, debug, dispatch, launch, openDra, openPanel, ready, solveOne, state, tabIdOf, until, waitState, type Harness } from './harness';

let h: Harness;
test.beforeAll(async () => (h = await launch()));
test.afterEach(async () => {
  await h.sw.evaluate(() => chrome.storage.local.remove(['zdForcePanelHost', 'zdSimulateNoSidePanel']));
  await closePages(h);
});
test.afterAll(async () => h?.close());

async function csvOf(dra: any): Promise<string> {
  return dra.evaluate(() => {
    const f = (window as any).fakeDra;
    return fetch('/plan.json')
      .then((r) => r.json())
      .then((plan) => ['GEOID20,District', ...plan.blocks.map((b: any) => [b.geoid, f.districtOfBlock(b.geoid)]).filter((r: any) => r[1]).map((r: any) => r.join(','))].join('\n'));
  });
}

test('startup self-check names the exact hook that failed; CSV drag-and-drop takes over', async () => {
  const dra = await openDra(h, 'break=fullBlockMap');
  const panel = await openPanel(h, dra);
  const s = await waitState(panel, (t) => t.connection === 'hook-failed');
  expect(s.notice.text).toContain('model.fullBlockMap()');
  expect(s.notice.text).toMatch(/DRA changed; update pending/);
  const d = await debug(panel);
  expect(d.check.items.filter((i: any) => !i.ok).map((i: any) => i.id)).toEqual(['model.fullBlockMap()']);

  // Real drag-and-drop of DRA's block-assignment CSV onto the panel page.
  const text = await csvOf(dra);
  await panel.evaluate(async (csv) => {
    const dt = new DataTransfer();
    dt.items.add(new File([csv], 'fixture-block-assignments.csv', { type: 'text/csv' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, text);
  const c = await waitState(panel, (t) => t.connection === 'csv' && t.districts.length === 4);
  const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  expect(c.districts.map((r: any) => r.pop)).toEqual(pops.slice(1));
  await until(() => debug(panel), (x) => x.assignmentReady);
  const r = await solveOne(panel, 1);
  expect(r.solutions.length).toBeGreaterThan(0);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = await waitState(panel, (t) => !!t.walkthrough);
  expect(w.walkthrough.liveTicking).toBe(false);
  for (let i = 0; i < w.walkthrough.steps.length; i++) await dispatch(panel, { type: 'walkthrough-next' });
  await waitState(panel, (t) => t.walkthrough.steps.every((x: any) => x.status === 'done'));
});

test('window.dra missing entirely is reported as the failing hook', async () => {
  const dra = await openDra(h, 'break=dra').catch(async () => null);
  // fakeDra still loads (it just never sets window.dra).
  const page = dra ?? h.context.pages().at(-1)!;
  const panel = await openPanel(h, page);
  const s = await waitState(panel, (t) => t.connection === 'hook-failed', 15_000);
  expect(s.notice.text).toContain('window.dra');
});

test('no map handle: walkthrough uses the panel mini-map (MapLibre) with the numbered blocks', async () => {
  const dra = await openDra(h, 'nomap=1');
  const panel = await openPanel(h, dra);
  await ready(panel);
  const d = await debug(panel);
  expect(d.check.mapOk).toBe(false);
  expect(d.check.items.find((i: any) => i.id === 'env.theMap').ok).toBe(false);
  expect(d.mapMode).toBe('mini');
  const r = await solveOne(panel, 3);
  await dispatch(panel, { type: 'start-walkthrough', solutionId: r.solutions[0].id });
  const w = await waitState(panel, (t) => !!t.walkthrough);
  expect(w.walkthrough.mapMode).toBe('mini');
  const step = w.walkthrough.steps[0];
  await panel.waitForSelector('.zd-minimap', { timeout: 10_000 });
  const mini = await until(
    () =>
      panel.evaluate(() => {
        const el = document.querySelector('.zd-minimap') as any;
        const m = el?.__zdMap;
        const data = m?.getSource('zd')?._data;
        const fc = data?.features ? data : data?.geojson;
        return { features: fc?.features?.length ?? 0, labels: document.querySelectorAll('.zd-mini-label').length };
      }),
    (x) => x.labels === step.blocks.length,
  );
  expect(mini.features).toBeGreaterThan(0);
  // Ticking still works from the live plan.
  await dra.evaluate(([pid, d]) => (window as any).fakeDra.paintPrecinct(pid, d), [step.precinctId, step.to]);
  // (whole-precinct paint ticks every block in it)
  if (step.wholePrecinct) await waitState(panel, (t) => t.walkthrough.steps[0].status === 'done');
});

for (const [query, kind] of [
  ['restrict=county', /county map/],
  ['restrict=city', /city map/],
  ['mmd=1', /Multi-member/],
  ['unequal=1', /unequal|different population targets/],
  ['multistate=1', /Multi-state/],
  ['shapes=2010_VD', /2020-shape/],
] as const) {
  test(`out-of-scope map is detected: ${query}`, async () => {
    const dra = await openDra(h, query);
    const panel = await openPanel(h, dra);
    const s = await waitState(panel, (t) => t.connection === 'unsupported-map');
    expect(s.notice.text).toMatch(kind);
    await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: 1 } });
    await dispatch(panel, { type: 'solve' });
    const t = await waitState(panel, (x) => x.solve.status === 'error');
    expect(t.solutions).toEqual([]);
  });
}

test('panel chain: no usable sidePanel -> pop-out window running the same panel page', async () => {
  const dra = await openDra(h);
  const tabId = await tabIdOf(h, dra);
  await h.sw.evaluate(() => chrome.storage.local.set({ zdSimulateNoSidePanel: true }));
  await new Promise((r) => setTimeout(r, 200));
  const popup = h.context.waitForEvent('page', { predicate: (p) => p.url().includes('host=popout') });
  const host = await h.sw.evaluate((id) => (globalThis as any).__zdOpenPanel(id), tabId);
  expect(host).toBe('popout');
  const panel = await popup;
  await panel.waitForFunction(() => !!(window as any).__zd);
  await ready(panel);
  expect((await state(panel)).connection).toBe('live');
  // Second click focuses the existing pop-out instead of opening another.
  await until(() => h.sw.evaluate(() => (globalThis as any).__zdLivePanels()), (l: any[]) => l.some((p) => p.host === 'popout' && p.tabId === tabId));
  const before = h.context.pages().length;
  expect(await h.sw.evaluate((id) => (globalThis as any).__zdOpenPanel(id), tabId)).toBe('popout');
  await new Promise((r) => setTimeout(r, 500));
  expect(h.context.pages().length).toBe(before);
});

test('panel chain: chrome.sidePanel.open without a user gesture fails and falls back to the pop-out', async () => {
  const dra = await openDra(h);
  const tabId = await tabIdOf(h, dra);
  const popup = h.context.waitForEvent('page', { predicate: (p) => p.url().includes('host=popout') });
  const host = await h.sw.evaluate((id) => (globalThis as any).__zdOpenPanel(id), tabId);
  expect(host).toBe('popout');
  await popup;
});

test('side panel is enabled only on DRA tabs', async () => {
  const dra = await openDra(h);
  const tabId = await tabIdOf(h, dra);
  const other = await h.context.newPage();
  await other.goto('about:blank');
  const otherId = await h.sw.evaluate(async () => (await chrome.tabs.query({ url: 'about:blank' }))[0]?.id);
  const opts = await until(
    () => h.sw.evaluate(async ([a, b]) => [await chrome.sidePanel.getOptions({ tabId: a }), await chrome.sidePanel.getOptions({ tabId: b })], [tabId, otherId]),
    (o: any[]) => o[0].enabled === true,
  );
  expect(opts[0]).toMatchObject({ enabled: true });
  expect(opts[1].enabled).not.toBe(true);
});
