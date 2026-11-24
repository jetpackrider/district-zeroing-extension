/**
 * The panel says which link of tab -> content script -> page hook is missing, instead of sitting
 * on "Connecting" (the first live run did exactly that with no way to tell why).
 */
import { test, expect } from '@playwright/test';
import { launch, openDra, openPanel, ready, type Harness } from './harness';

test('a healthy link reports every stage in the diagnostics', async () => {
  const h: Harness = await launch();
  try {
    const dra = await openDra(h);
    const panel = await openPanel(h, dra);
    await ready(panel);
    const text: string = await panel.evaluate(() => (window as any).__zd.diagnostics());
    expect(text).toContain('stage: hook');
    expect(text).toMatch(/content script: attached \(hook channel received/);
    expect(text).toMatch(/page hook: alive \(v\d+, window\.dra present, plan open/);
  } finally {
    await h.close();
  }
});
