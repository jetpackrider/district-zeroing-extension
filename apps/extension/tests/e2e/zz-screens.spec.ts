/**
 * README screenshots (docs/readme/*.png), on demand: SCREENS=1 npx playwright test zz-screens.
 * The panel runs against the fake DRA page serving New York's enacted congressional plan over the
 * real NY bundle, with three small precincts moved across borders so there is something to fix.
 * Needs data/NY (see the README's "Build it" section).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch, hasRealNY, launch, openDra, openPanel, REAL_DATA, ROOT, state, until, waitState } from './harness';

test.skip(!process.env.SCREENS, 'screenshots only on demand');
test.skip(!hasRealNY(), 'data/NY or fixture/www/plan-real-ny.json missing');

const OUT = join(ROOT, '../../docs/readme');

test('screens', async () => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const h = await launch({ data: REAL_DATA, scale: 2 });
  const dra = await openDra(h, 'plan=real', 120_000);
  const panel = await openPanel(h, dra);
  await panel.setViewportSize({ width: 420, height: 860 });
  await waitState(panel, (s) => s.connection === 'live' && s.solve.status === 'idle' && s.districts.length === 26, 120_000);

  // Something to fix: one small whole precinct moved across each of three borders.
  for (const [a, b] of [[3, 4], [10, 12], [21, 20]] as const) {
    const p = (await panel.evaluate(([x, y]) => (window as any).__zd.borderPrecincts(x, y, 1), [a, b]))[0];
    expect(p).toBeTruthy();
    await dra.evaluate(([pid, d]) => (window as any).fakeDra.paintPrecinct(pid, d), [p.id, b]);
  }
  const pops: number[] = await dra.evaluate(() => (window as any).fakeDra.districtPops());
  const s0 = await until(() => state(panel), (s) => s.districts.every((d: any) => d.pop === pops[d.index]), 30_000);

  const shoot = async (name: string, prepare?: (p: Page) => Promise<void>) => {
    for (const scheme of ['light', 'dark'] as const) {
      await panel.emulateMedia({ colorScheme: scheme });
      await panel.evaluate(() => window.scrollTo(0, 0));
      if (prepare) await prepare(panel);
      await panel.waitForTimeout(250);
      await panel.screenshot({ path: join(OUT, `${name}-${scheme}.png`) });
    }
  };

  // 1. One district, with its finished neighbors locked.
  const worst = [...s0.districts].sort((x: any, y: any) => Math.abs(y.deviation) - Math.abs(x.deviation))[0];
  await dispatch(panel, { type: 'set-scope', scope: { mode: 'one', district: worst.index } });
  const finished = s0.districts.filter((d: any) => d.deviation === 0).slice(0, 3).map((d: any) => d.index);
  await dispatch(panel, { type: 'set-district-lock', districts: finished, locked: true });
  await shoot('panel-districts');

  // 2. The ranked options for that district.
  await dispatch(panel, { type: 'solve' });
  const solved = await waitState(panel, (s) => s.solve.status === 'done' && s.solutions.length > 0, 120_000);
  await shoot('panel-options', async (p) => {
    await p.getByText(/Zeroing options/i).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await p.evaluate(() => window.scrollBy(0, -12));
  });

  // 3. The walkthrough of the option with the most steps (a shattered precinct reads better than
  //    a whole one), cropped to its content.
  const pick = [...solved.solutions].sort((x: any, y: any) => (y.stats.steps ?? 0) - (x.stats.steps ?? 0) || y.stats.blocks - x.stats.blocks)[0];
  await dispatch(panel, { type: 'start-walkthrough', solutionId: pick.id });
  await waitState(panel, (t) => !!t.walkthrough);
  await panel.waitForTimeout(1200);
  const bottom = await panel.evaluate(() => Math.max(...[...document.querySelectorAll('.zd-panel *')].map((e) => e.getBoundingClientRect().bottom)));
  if (bottom + 14 < 860) await panel.setViewportSize({ width: 420, height: Math.ceil(bottom + 14) });
  await shoot('panel-walk');
  await h.close();
});
