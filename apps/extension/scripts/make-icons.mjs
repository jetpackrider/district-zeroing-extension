#!/usr/bin/env node
/**
 * Renders the small toolbar icons, public/icon/{16,32}.png, from assets/icon.svg with Playwright's
 * Chromium. The 48 and 128 px icons in public/icon/ are the artwork as supplied and are left alone;
 * pass --all to re-render those from the SVG as well. --opera writes the 64 px icon the Opera
 * add-ons listing asks for to docs/store/icon-64.png (it is not part of the package).
 *
 *   node scripts/make-icons.mjs [--all] [--opera]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
const opera = process.argv.includes('--opera');
const sizes = opera ? [64] : process.argv.includes('--all') ? [16, 32, 48, 128] : [16, 32];
const target = (size) => (opera ? join(root, '../../docs/store/icon-64.png') : join(root, `public/icon/${size}.png`));

const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
    await page.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
    writeFileSync(target(size), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
    console.log(target(size));
  }
} finally {
  await browser.close();
}
