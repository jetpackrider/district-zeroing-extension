# @zd/extension: DRA Zero Deviation browser extension

WXT 0.21.5, Manifest V3, TypeScript. It reads the plan live from an open Dave's Redistricting tab, finds the blocks that zero a district, a group or the whole map, and walks you through painting them by hand.

**Painting for you (opt-in).** The walkthrough has a "Paint steps for me" setting, off by default and remembered (`chrome.storage.local.autoPaint`). When it is on, the current step gets a "Paint this step" button. One click paints that one step through DRA's own model actions: the same calls DRA's precinct paint and its Paint City tool make, so DRA records the edit for its Undo and syncs it. The page hook checks the map first (editable, districts not locked, the step's blocks where the plan expects them, nothing uncommitted). Afterwards it re-reads the plan and confirms that exactly the step's blocks moved. Any difference switches painting off and says what differs and how to undo it in DRA. There is no "paint everything", and it is off in CSV mode. It has **not** been run against live DRA yet: see `../../RECON.md` "Painting a step for the user" (P1, P2).

## Layout
```
src/dra/hooks.ts             every DRA touchpoint + startup self-check (one file)
src/hook/main.ts             MAIN-world hook (document_start): private MessageChannel, snapshots, change detection
src/hook/highlight.ts        zd- GeoJSON source + fill/line/label layers on DRA's map (raise after renders, re-add on style.load)
src/hook/relay.ts            isolated relay: MessageChannel <-> chrome.runtime port to the panel
src/entrypoints/             background (panel enabling + host chain), sidepanel page, the two content scripts
src/panel/controller.ts      PanelController (connection, bundle, mismatch check, solve, walkthrough, CSV)
src/panel/assignment.ts      fullBlockMap feature IDs (precinct / B_{precinct}_{bitset} / bare block) -> per-block Assignment
src/panel/walkthrough.ts     steps by border then precinct, live ticking, strays, final check
src/panel/minimap.ts         MapLibre fallback mini-map
src/panel/diagnostics.ts     copyable diagnostics text (panel page footer + console; local only)
src/worker/engine.worker.ts  engine Worker owned by the panel page
src/adapters/*.ts            one-file seams to @zd/engine, @zd/planner, @zd/bundle, @zd/panel-ui
fixture/                     fake DRA page; synthetic NY + VT bundle generator (real @zd/bundle format); real-NY plan generator
tests/unit, tests/e2e        vitest + Playwright (Chromium, extension loaded)
```

## Build and load
```
npm install
npm run build          # .output/chrome-mv3   (Chrome, Edge, Brave; Arc uses the pop-out)
npm run build:opera    # .output/opera-mv3    (adds sidebar_action)
```
Load it at `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

### Local build: data inside the extension, no server
```
npm run build:local                      # -> local/chrome-mv3, with ../../data/NY embedded
ZD_LOCAL_STATES=NY,CA npm run build:local  # pick which states to embed (comma-separated; default NY)
```
This writes a self-contained unpacked extension to `local/chrome-mv3`, which `build`, `build:test` and the tests never touch. Load that directory with Load unpacked. The panel reads `data/<STATE>/` from the extension's own files. Only the files each state's `manifest.json` names are copied, never `fixtures/`. The manifest has the same permissions as the store build, because extension pages may read their own files without any extra permission. Embed only the states you need, since each is roughly 25 MB for New York. A `dataBaseUrl` set in storage still overrides the embedded data.

### Diagnostics
The panel page has a collapsed **Diagnostics** section at the bottom, with a Copy button. It shows the hook self-check item by item, the hook version, what the hook saw (mapbox version, DRA bundle path, `dataContext`, `primeDDS`, the member names on `window.dra` and the model), the population field and target, the bundle's DRA data version, and a per-district bundle-vs-DRA population table. The same text goes to the panel page's console when it changes. It is built locally and never sent anywhere.

Data bundles: the base URL defaults to `ZD_DATA_URL` at build time. You can override it at runtime with `chrome.storage.local.set({ dataBaseUrl: '…/' })`, run from the panel's DevTools. The URL is a directory holding `<STATE>/manifest.json`. To develop against the local pipeline output:
```
npm run serve -- --port 8787 --data ../../data     # serves ../../data at http://127.0.0.1:8787/data/ with CORS
ZD_DATA_URL=http://127.0.0.1:8787/data/ npm run build
```
`chrome.storage.local.set({ miniMapTiles: '' })` turns off the mini-map's OSM street tiles.

## Tests
```
npm run typecheck
npm run test:unit                       # vitest
npm run build:test && npm run fixture:gen && npm run test:e2e
npm test                                # all of the above (also builds .output and local/ so the manifest tests run)
```
`build:test` (`ZD_TEST=1`) writes to `.output-test/` and also matches `http://localhost/*` and `http://127.0.0.1/*` so the fixture page gets the content scripts. It also enables test-only overrides. **Never ship it.** The shipped manifest's permissions are exactly `sidePanel`, `storage`, `unlimitedStorage` and `https://davesredistricting.org/*`. The e2e harness starts its own server on a free port and its own Chromium, and closes both. Run with `HEADED=1` to watch.

The fake page also has DRA's paint actions with the same signatures and undo behaviour (`actionSetFeatureDistricts`, `actionSetBlockDistricts`, `actionSetRedistrictProps`, `undoredo`, `districtLocked`, `readonly`), plus test switches on `window.fakeDra` (`setReadonly`, `lockDistrict`, `sabotageNextPaint`, `undo`, `paintCalls`). `phase12-paint` covers it.

Fake DRA page options (`fixture/www/fake-dra.js`): `plan=vt` (a two-way-trade state: district 1 holds only even-population blocks, is 3 over, and its only neighbour is 3 under, so the single-district solver finds nothing), `plan=real` (New York's enacted plan over `../../data/NY`: 288,819 blocks, precinct entries plus `B_` splits, generated by `fixture:gen` when data/NY exists), `noplan=1` (DRA with no map open; `fakeDra.openPlan()` / `closePlan()`), `readonly=1`, `paintapi=missing|arity` (a paint function missing or with another arity), `paintwait=F` (scale the post-paint waits), `nomap=1`, `break=dra|fullBlockMap|blockMapping|aggregates|clientSession`, `restrict=county|city`, `mmd=1`, `unequal=1`, `multistate=1`, `shapes=2010_VD`, `pop=D20FA`, `drift=N`.

Real-scale and local-build tests (`phase9-real-scale`, `phase10-local-build`) are skipped when `../../data/NY` is missing. The real-scale test writes its measurements to `test-results/real-scale.json`. The local-build test serves the fake page at `https://davesredistricting.org/maps` through Playwright request interception, and maps DRA's hosts to 127.0.0.1, so nothing reaches the real site.

Nothing here has been run against live DRA. See `../../RECON.md` for the console checks a signed-in tab still needs.
