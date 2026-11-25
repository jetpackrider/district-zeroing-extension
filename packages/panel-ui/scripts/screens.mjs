import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../../apps/extension/node_modules/playwright/index.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/screens.mjs OUTPUT_DIRECTORY');
const output = resolve(process.argv[2]);
const root = fileURLToPath(new URL('../', import.meta.url));
const narrow = new Set(['live-single', 'live-whole-map-26', 'walkthrough-live', 'live-area-prefer']);
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  const { SCENARIO_LIST } = await server.ssrLoadModule('/src/mock/scenarios.ts');
  browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let count = 0;
  for (const { id } of SCENARIO_LIST) {
    const sizes = [[400, 'light'], [400, 'dark']];
    if (narrow.has(id)) sizes.push([300, 'light']);
    for (const [width, theme] of sizes) {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(origin + '?' + new URLSearchParams({ scenario: id, width, theme, bare: '1' }));
      const panel = page.locator(`.zd-panel[data-theme="${theme}"]`);
      await panel.waitFor();
      await page.evaluate(() => document.fonts.ready);
      // Expand the viewport to include sticky controls at their natural positions.
      const { height } = await panel.boundingBox();
      await page.setViewportSize({ width, height: Math.ceil(height) });
      await panel.screenshot({ path: join(output, `${id}-${width}-${theme}.png`), animations: 'disabled' });
      count++;
      if (errors.length) throw new Error(`${id}: ${errors.join(', ')}`);
    }
  }
  console.log(`Captured ${count} panels across ${SCENARIO_LIST.length} scenarios in ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
