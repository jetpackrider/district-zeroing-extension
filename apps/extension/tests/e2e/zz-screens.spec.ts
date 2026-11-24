import { test } from '@playwright/test';
import { dispatch, launch, openDra, openPanel, ready, solveOne, waitState } from './harness';
test.skip(!process.env.SCREENS, 'screenshots only on demand');
test('screens', async () => {
  const h = await launch();
  const dra = await openDra(h);
  const panel = await openPanel(h, dra);
  await panel.setViewportSize({ width: 400, height: 900 });
  await ready(panel);
  await panel.screenshot({ path: 'test-results/screens/panel-live.png' });
  const s = await solveOne(panel, 3);
  await panel.screenshot({ path: 'test-results/screens/panel-options.png' });
  await dispatch(panel, { type: 'start-walkthrough', solutionId: s.solutions[0].id });
  await waitState(panel, (t) => !!t.walkthrough);
  await panel.waitForTimeout(1200);
  await panel.screenshot({ path: 'test-results/screens/panel-walk.png' });
  await dra.screenshot({ path: 'test-results/screens/dra-walk.png' });
  await h.close();
});
