import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'wxt';

/**
 * Build-time switches:
 *   ZD_TEST=1        test build: also matches http://localhost and http://127.0.0.1 (fixture page),
 *                    enables test-only hooks, writes to .output-test/. Never ship it.
 *   ZD_LOCAL=1       local build (`npm run build:local`): a self-contained unpacked extension in
 *                    local/chrome-mv3 with the data bundles of ZD_LOCAL_STATES (default NY) copied
 *                    inside it, read from the extension's own files. No server needed. Same
 *                    permissions as the store build. Not wiped by `build`, `build:test` or tests.
 *   ZD_LOCAL_STATES  comma-separated states to embed in the local build (default "NY"), from ../../data.
 *   ZD_DATA_URL=...  default base URL of the per-state data bundles (overridable at runtime in storage).
 */
const TEST = process.env.ZD_TEST === '1';
const LOCAL = !TEST && process.env.ZD_LOCAL === '1';
const DRA_MATCH = 'https://davesredistricting.org/*';
const TEST_MATCHES = ['http://localhost/*', 'http://127.0.0.1/*'];
/** `extension:` = resolve against the extension's own files (chrome.runtime.getURL). */
const EMBEDDED_DATA_URL = 'extension:data/';
const DATA_URL = LOCAL ? EMBEDDED_DATA_URL : (process.env.ZD_DATA_URL ?? 'https://jetpackrider.github.io/zero-deviation-data/v1');
const DATA_ROOT = resolve('../../data');

function localStates(): string[] {
  const raw = process.env.ZD_LOCAL_STATES ?? 'NY';
  const states = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  for (const s of states) if (!/^[A-Z]{2}$/.test(s)) throw new Error(`ZD_LOCAL_STATES: bad state code "${s}"`);
  return states;
}

/** Only the files a state's manifest names (manifest, attrs, water, towns, one file per county); never fixtures/ or anything else in data/. */
function embeddedFiles(state: string): Array<{ absoluteSrc: string; relativeDest: string }> {
  const dir = join(DATA_ROOT, state);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`build:local: no bundle for ${state} (${manifestPath} is missing)`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { state: string; attrs: { file: string }; water?: { file: string }; towns?: { file: string }; counties: Array<{ file: string }> };
  if (manifest.state !== state) throw new Error(`build:local: ${manifestPath} is for ${manifest.state}, not ${state}`);
  const files = ['manifest.json', manifest.attrs.file, ...(manifest.water ? [manifest.water.file] : []), ...(manifest.towns ? [manifest.towns.file] : []), ...manifest.counties.map((c) => c.file)];
  return files.map((f) => {
    if (!/^[\w.-]+$/.test(f)) throw new Error(`build:local: unexpected file name ${f}`);
    const absoluteSrc = join(dir, f);
    if (!existsSync(absoluteSrc)) throw new Error(`build:local: ${state} manifest names ${f}, which is missing`);
    return { absoluteSrc, relativeDest: `data/${state}/${f}` };
  });
}

// Resolved when the config loads, so a bad ZD_LOCAL_STATES fails before WXT cleans local/chrome-mv3.
const LOCAL_FILES = LOCAL ? localStates().flatMap(embeddedFiles) : [];

export default defineConfig({
  srcDir: 'src',
  outDir: TEST ? '.output-test' : LOCAL ? 'local' : '.output',
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: TEST ? 'Zero Deviation (TEST BUILD)' : LOCAL ? 'Zero Deviation (local build)' : 'Zero Deviation',
    // At most 132 characters: the Chrome Web Store shows this as the listing's summary.
    description: 'Finds the census blocks that bring a district, group, or whole map to zero deviation in Dave\'s Redistricting, and walks you there.',
    // SPEC "Permissions and store policy": exactly these. sidePanel is added by WXT for the sidepanel entrypoint.
    // The local build needs nothing more: extension pages can fetch the extension's own files.
    permissions: ['sidePanel', 'storage', 'unlimitedStorage'],
    host_permissions: TEST ? [DRA_MATCH, ...TEST_MATCHES] : [DRA_MATCH],
    action: { default_title: 'Zero Deviation' },
    ...(browser === 'opera'
      ? {
          // Opera's own sidebar (opr.sidebarAction), the second link in the panel chain.
          sidebar_action: {
            default_panel: 'sidepanel.html?host=opera-sidebar',
            default_title: 'Zero Deviation',
            default_icon: 'icon/32.png',
          },
        }
      : {}),
  }),
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      // MapLibre's CSP build needs its worker as a packaged file (extension CSP forbids blob: workers).
      files.push({ absoluteSrc: resolve('node_modules/maplibre-gl/dist/maplibre-gl-csp-worker.js'), relativeDest: 'maplibre-gl-csp-worker.js' });
      files.push(...LOCAL_FILES);
    },
    'build:manifestGenerated': (_wxt, manifest) => {
      if (!TEST) return;
      for (const cs of manifest.content_scripts ?? []) {
        cs.matches = [...new Set([...(cs.matches ?? []), ...TEST_MATCHES])];
      }
    },
  },
  vite: () => ({
    define: {
      __ZD_TEST__: JSON.stringify(TEST),
      __ZD_BUILD__: JSON.stringify(TEST ? 'test' : LOCAL ? 'local' : 'store'),
      __ZD_EMBEDDED_STATES__: JSON.stringify(LOCAL ? localStates() : []),
      __ZD_HOST_PATTERNS__: JSON.stringify(TEST ? [DRA_MATCH, ...TEST_MATCHES] : [DRA_MATCH]),
      __ZD_DATA_URL__: JSON.stringify(DATA_URL),
    },
    worker: { format: 'es' },
    resolve: { dedupe: ['react', 'react-dom'] },
  }),
});
