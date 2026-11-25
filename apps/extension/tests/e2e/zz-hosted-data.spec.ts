/**
 * On demand (HOSTED=1): the panel loads New York from the published data host instead of the local
 * data folder, so a broken upload, a CORS change or a checksum mismatch shows up here.
 */
import { test, expect } from '@playwright/test';
import { debug, dispatch, hasRealNY, launch, openDra, openPanel, solveOne, state, until, waitState } from './harness';

const HOST = process.env.ZD_DATA_URL ?? 'https://jetpackrider.github.io/zero-deviation-data/v1';
test.skip(!process.env.HOSTED, 'hosted-data check only on demand');
test.skip(!hasRealNY(), 'fixture/www/plan-real-ny.json missing');

test('the panel loads NY from the data host and solves on it', async () => {
  test.setTimeout(300_000);
  const h = await launch();
  await h.sw.evaluate((url) => chrome.storage.local.set({ dataBaseUrl: url }), HOST);
  const requests: string[] = [];
  h.context.on('request', (r) => {
    if (r.url().startsWith(HOST)) requests.push(r.url());
  });
  const dra = await openDra(h, 'plan=real', 120_000);
  const panel = await openPanel(h, dra);
  const s = await waitState(panel, (x) => x.connection === 'live' && x.solve.status === 'idle' && x.districts.length === 26, 180_000);
  expect(s.map.totalPop).toBe(20_201_249);
  expect(requests.some((u) => u.endsWith('/NY/manifest.json'))).toBe(true);
  // The area needs the bundle's block points (the `points` sidecar). Without them on the host the
  // area is marked unavailable with the reason, "Use map view" does nothing, and solving works.
  const points = (await until(() => debug(panel), (x: any) => x.area.points !== null, 120_000)).area.points;
  const d = await state(panel);
  console.log(`  hosted NY: block points ${points ? 'yes' : 'no'}${d.area?.unavailable ? `; area unavailable: ${d.area.unavailable}` : ''}`);
  if (points) expect(d.area?.unavailable).toBeUndefined();
  else {
    expect(d.area?.unavailable).toMatch(/no block locations/);
    await dispatch(panel, { type: 'area-use-view' });
    expect((await state(panel)).area?.ring).toBeUndefined();
  }
  const worst = [...s.districts].sort((a: any, b: any) => Math.abs(b.deviation) - Math.abs(a.deviation))[0];
  const r = await solveOne(panel, worst.index);
  console.log(`  hosted NY: ${requests.length} requests to the host; district ${worst.index} (${worst.deviation}): ${r.solve.status}, ${r.solutions.length} option(s)`);
  expect((await state(panel)).connection).toBe('live');
  expect(['done', 'needs-precinct-rework']).toContain(r.solve.status);
  await h.close();
});
