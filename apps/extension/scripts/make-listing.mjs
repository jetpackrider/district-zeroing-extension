// Chrome Web Store listing images, built from the README screenshots and banner.
// Writes docs/store/*.png. Run from apps/extension:  node scripts/make-listing.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readme = join(here, '../../../docs/readme');
const out = join(here, '../../../docs/store');
const png = (name) => `data:image/png;base64,${readFileSync(join(readme, name)).toString('base64')}`;
const hero = readFileSync(join(readme, 'hero.svg'), 'utf8');

const base = `
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 800px; overflow: hidden; color: #fff;
    font-family: ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: radial-gradient(900px 600px at 78% 45%, rgba(47,107,255,.20), transparent 70%), linear-gradient(135deg, #0E1728, #0A1120); }
  .wrap { display: flex; height: 800px; padding: 0 84px; gap: 72px; align-items: center; }
  .copy { flex: 1; }
  .step { font: 600 20px ui-monospace, SFMono-Regular, Menlo, monospace; color: #7FB0FF; letter-spacing: 1px; margin-bottom: 18px; }
  h1 { font-size: 62px; line-height: 1.05; letter-spacing: -1.6px; font-weight: 750; }
  p { margin-top: 24px; font-size: 26px; line-height: 1.4; color: #A9B8D2; max-width: 560px; }
  .brand { position: absolute; left: 84px; bottom: 54px; display: flex; align-items: center; gap: 12px; font-size: 20px; font-weight: 650; color: #D7E0EF; }
  .brand small { font-weight: 450; color: #6F82A3; font-size: 17px; }
  .shot { width: 400px; height: 704px; border-radius: 16px; overflow: hidden; border: 1px solid #2A3954;
    box-shadow: 0 30px 80px rgba(0,0,0,.55); background: #fff; flex: none; }
  .shot img { width: 400px; display: block; }
`;
const logo = `<svg width="30" height="30" viewBox="0 0 60 60"><circle cx="30" cy="30" r="27.5" fill="#0B1220" stroke="#fff" stroke-width="3.5"/><rect x="20" y="15" width="20" height="30" rx="10" fill="none" stroke="#fff" stroke-width="5.5"/><line x1="37.5" y1="19" x2="22.5" y2="41" stroke="#fff" stroke-width="3.8" stroke-linecap="round"/></svg>`;
const slide = (n, title, text, image) => `<style>${base}</style><div class="wrap">
  <div class="copy"><div class="step">STEP ${n} OF 3</div><h1>${title}</h1><p>${text}</p></div>
  <div class="shot"><img src="${png(image)}"></div></div>
  <div class="brand">${logo} Zero Deviation <small>for Dave's Redistricting · not affiliated</small></div>`;

const pages = [
  ['screenshot-1.png', 1280, 800, slide(1, 'Pick what to fix', 'One district, a group, or the whole map. Lock the districts that are finished and choose which neighbor gives or takes.', 'panel-districts-light.png')],
  ['screenshot-2.png', 1280, 800, slide(2, 'Compare the options', 'Every option reaches exactly zero and says what it costs first: steps to paint, precinct, county and town splits, compactness.', 'panel-options-light.png')],
  ['screenshot-3.png', 1280, 800, slide(3, 'Paint it, block by block', 'Blocks are numbered on the map and tick off as you paint them. Districts stay in one piece, and your plan never leaves your browser.', 'panel-walk-light.png')],
  ['promo-small.png', 440, 280, `<style>* { margin: 0; box-sizing: border-box } body { width: 440px; height: 280px; overflow: hidden; color: #fff;
       font-family: ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
       background: radial-gradient(300px 220px at 76% 50%, rgba(47,107,255,.22), transparent 70%), linear-gradient(135deg, #0E1728, #0A1120);
       display: flex; align-items: center; padding: 0 22px 0 26px; gap: 14px; }
     .t { flex: 1 } .t b { display: block; font-size: 31px; line-height: 1.02; letter-spacing: -.8px; font-weight: 750; margin-top: 12px }
     .t span { display: block; margin-top: 10px; font-size: 14px; line-height: 1.35; color: #A9B8D2 }
     .g { width: 214px; flex: none } .g svg { display: block; width: 214px; height: 177px }</style>
     <div class="t">${logo.replace('width="30" height="30"', 'width="38" height="38"')}<b>Zero<br>Deviation</b><span>Exactly zero,<br>block by block.</span></div>
     <div class="g">${hero.replace(/viewBox="[^"]*"/, 'viewBox="722 26 407 336"')}</div>`],
  ['promo-marquee.png', 1400, 560, `<style>* { margin: 0 } body { width: 1400px; height: 560px; overflow: hidden; background: #070C16; display: flex; align-items: center; justify-content: center; }
     .h { width: 1320px; }</style><div class="h">${hero}</div>`],
];

const browser = await chromium.launch();
for (const [file, width, height, html] of pages) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 7000; }));
  await page.screenshot({ path: join(out, file), omitBackground: false });
  await page.close();
  console.log(file, `${width}x${height}`);
}
await browser.close();
