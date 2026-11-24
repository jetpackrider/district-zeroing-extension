# RECON: DRA hooks (Phase 0)

**Status: static recon only. Nothing here has been checked against a live, signed-in DRA tab.**

Source: one download of `https://davesredistricting.org/scripts/draclient.bundle.js` (2,338,041 bytes, `Last-Modified: Fri, 20 Nov 2026 10:33:22 GMT`, the single bundle that `/maps` references), plus the app page itself. No API endpoints and nothing on data.dra2020.net were requested. The bundle is minified, so local names (`OZ`, `He`, `cO`, …) change on every DRA deploy. The **property and method names** below are the stable part, and they're what the extension uses (all in `apps/extension/src/dra/hooks.ts`).

Each item is marked:
- **CONFIRMED (static)**: the name and shape are in the bundle exactly as the spec says.
- **DIFFERENT**: the bundle differs from the spec; the real name is given, and the extension uses it.
- **NEEDS LIVE**: only a running tab can settle it. A console snippet and the expected result are given.

To run a snippet, open a signed-in DRA tab with one of your maps open (`https://davesredistricting.org/join/...`), open DevTools → Console, and paste it.

---

## Summary

| # | Phase 0 item | Result |
|---|---|---|
| 1 | `window.dra` exists | CONFIRMED (static), set on DOMContentLoaded |
| 2 | `dra.model().fullBlockMap()` | CONFIRMED (static); includes uncommitted edits as **bare block GEOIDs** (new detail) |
| 3 | `model.districtOf(id)` | CONFIRMED (static) |
| 4 | blockMapping `.map()` / `.rev()` | **DIFFERENT**: `model.blockMapping` is a **getter on the model**, not on the map; it's a `MultiBlockMapping` (`map`, `rev`, `forEachRev`, `forEachBlock`, `stamp`) |
| 5 | `datasetContext.primeDDS` | CONFIRMED (static), a getter on the model |
| 6 | `dataContext` (district count) | CONFIRMED (static): `{state, datasource, precincts, version, planType, nDistricts, equalPop, allowMMD}` |
| 7 | `totalStatePop()` | CONFIRMED (static); uses the restriction aggregate on county/city maps |
| 8 | Target `Math.round(total / districts)` | **DIFFERENT (source)**: DRA computes it in `redistrict.safeDistrictProps().targetPop(model, i)`, not dra-analytics; same formula for equal-pop single-member maps |
| 9 | District population as DRA shows it | Found: `model.datasetGetter(model.derivedProps.aggregates[i], primeDDS)('Tot')` |
| 10 | `env.theMap` is a Mapbox map | CONFIRMED (static): Mapbox GL **v2.11.0** global script; `env.theMap` set in `handleFirstConfig` |
| 11 | Fallback: trap `mapboxgl.Map` | CONFIRMED feasible: the bundle captures `const He = mapboxgl` and calls `new He.Map(...)`, so patching `window.mapboxgl.Map` at document_start works |
| 12 | `env.clientSession.on('state', …)` | CONFIRMED (static) |
| 13 | `stamps.blockmap` counter | CONFIRMED (static), read through `model.redistrict.blockStamp()` |
| 14 | Feature IDs: precinct / `B_{precinct}_{bitset}` | CONFIRMED (static), bitset decoded; **also** legacy `vfeature_{precinct}_{chunk}_{hash}` exists |
| 15 | DRA deletes `dra-…` layers on basemap change | CONFIRMED (static): `changeStyle()` removes `/^dra-/` then `setStyle(url, {diff:false})` |
| 16 | DRA moves its layers to the top on render | CONFIRMED (static): sorts custom layers by `zindex` and `moveLayer`s each |
| 17 | Test layer survives re-renders + basemap switch | NEEDS LIVE (fixture-proven only) |
| 18 | `fullBlockMap()` and the state event update while painting before commit | NEEDS LIVE: statically, `fullBlockMap()` yes; the session `'state'` event **no** (local block edits only bump `sm.localBlockStamp`) |
| 19 | Updated precincts change blockMapping | NEEDS LIVE (statically, its `stamp` changes) |
| 20 | Label ↔ index (0 = Unassigned) | NEEDS LIVE (statically, index 0 has label `""`) |
| 21 | Corner-only contact is not adjacency | NEEDS LIVE |
| 22 | Sync: `/api/sessions/sendevent`, `/receiveevent` | CONFIRMED (static) |
| 23 | Out-of-scope map detection fields | Found (see below); NEEDS LIVE for the values on real maps |
| 24 | Paint actions for the opt-in "paint this step" (whole precinct, blocks), undo, read-only/lock/shatter handling | Found (static, see "Painting a step for the user"); NEEDS LIVE: P1 (functions) and P2 (first use on a copy) |

---

## Details

### 1. `window.dra`: CONFIRMED (static)
```js
function OZ(e){ window.dra = { app: e, env: e.props.env, model: () => e.props.curModel, Poly, G, topoCache, ... } }
function AZ(){ _Z = new DZ; _Z.initialize(); OZ(_Z) }
"loading" === document.readyState ? document.addEventListener("DOMContentLoaded", AZ) : AZ()
```
`window.dra` exists from DOMContentLoaded on. `dra.model()` returns `undefined` until a plan is open. The hook waits for both and reports "no plan open" without blaming the hooks. The panel shows this as connection `no-plan`, also when a plan closes mid-session (going back to the map list). Round 1 reported that case as a hook failure.

### 2. `fullBlockMap()`: CONFIRMED (static), with one new detail
```js
fullBlockMap(){ let e = this.redistrict?.blockMap() ?? {}; /* committed */
  Object.keys(this.sm.blockmap) /* uncommitted (ShatterManager) */ .forEach(t => { e[t] = this.sm.blockmap[t] }); return e }
```
While a precinct is shattered, `sm.blockmap` holds **bare 15-digit block GEOIDs** (DRA's `pc(id)`: length ≥ 15 and not a vfeature or cfeature), so `fullBlockMap()` has *both* the committed precinct (or `B_` features) *and* the block entries. The extension applies whole precincts first, then `B_` splits, then bare blocks, with the later entries winning (`src/panel/assignment.ts`).

### 3. `districtOf(id)`: CONFIRMED (static)
`districtOf(e){ if(!e) return 0; if(this.sm.blockmap[e] !== undefined) return this.sm.blockmap[e]; return this.redistrict.blockMap()[e] ?? 0 }`

### 4. Block mapping: DIFFERENT
The spec says "the map's own blockMapping (.map(), .rev())". The real one is a **getter on the model**:
```js
get blockMapping(){ return this.dfPrecinctOverrides.blockMapping() }  // MultiBlockMapping, includes "updated precincts" layers
get blockMappingFull(){ ... }
```
`MultiBlockMapping` has `entries[{tag, bm, rbm}]`, `map(block) → precinct`, `rev(precinct) → blocks` (**each rev list is sorted**), `forEachRev(cb)`, `forEachBlock(cb)`, `multimap`, and `stamp`, which increments on change. The hook reads `model.blockMapping` and sends `forEachRev` to the panel once per `stamp`.

### 5–7. `datasetContext.primeDDS`, `dataContext`, `totalStatePop()`: CONFIRMED (static)
```js
get dataContext(){ ... return { state, datasource: dataSource().kind, precincts, version, planType, nDistricts, equalPop: scenario.bEqualPop, allowMMD } }
totalStatePop(){ let r = this.stateAgg(); return r ? PF.getPackedField(r, this.datasetContext.primeDDS, "Tot") : 0 }
stateAgg(){ let r = this.restriction(); return r ? r.aggregate : env.rdm.stateAgg(state, datasource) }
```
`datasetContext = { dsGroup, dsMeta, primeDDS: CENSUS key, primeVDS, primeEDS }`.

### 8–9. Target and district populations "exactly as DRA shows them"
DRA's district table (`rows` dataflow) computes:
```js
const { aggregates } = model.derivedProps;        // per-district aggregates, index 0 = unassigned
const k = model.primaryDatasetKeysActual()?.CENSUS; // == datasetContext.primeDDS
pop[i] = model.datasetGetter(aggregates[i], k)("Tot");
dev[i] = pop[i] - redistrict.safeDistrictProps().targetPop(model, i);
targetPop(m, i): !equalPop → this[i].target; !allowMMD → Math.round(m.totalStatePop() / nDistricts); MMD → round(total * membersPer / totalMembers)
```
The hook uses exactly these calls. Labels are `safeDistrictProps()[i].label`, and colours are `derivedProps.colors[i].colorSolid`, falling back to `districtProps[i].color`. The plan name is `derivedProps.displayName`.

### 10–11. Map: CONFIRMED (static)
The app page loads `https://api.mapbox.com/mapbox-gl-js/v2.11.0/mapbox-gl.js` as a plain `<script>` (it assigns `window.mapboxgl`) before `/scripts/draclient.bundle.js`. The bundle does `const He = mapboxgl` and later `new He.Map(...)`, and `this.env.theMap = …` is set in `handleFirstConfig`. The hook prefers `dra.env.theMap`. Its fallback traps the `window.mapboxgl` assignment at document_start and subclasses `.Map` to record instances.

### 12–13. Change events: CONFIRMED (static)
- `env.clientSession.on("state", …)` is the OT engine's `emit("state")`. It fires on remote edits, server acks and `addLocalEdit` (committed edits).
- The stamps counter is `redistrict.blockStamp()` (`value.stamps.blockmap`).
- **New:** uncommitted block painting inside a shattered precinct calls `sm.blockmapChange()`, which does `localBlockStamp++` and `model.upfire(...)`. That is a model event, **not** the session `'state'` event. The hook therefore polls a signature every 300 ms (`blockStamp | sm.localBlockStamp | blockMapping.stamp | district pops | pending shatter`) and also listens to `'state'`.
- Commit detection: `model.sm.shatterMap[precinct].state` ∈ `shattering | shattered | coalescing | coalesced`, and `sm.quiescent()` means nothing is pending. A walkthrough step shows "awaiting commit" while its precinct is `shattering` or `shattered`.
- **How the hook reads it (round 2).** Each 300 ms tick reads only the cheap signature (`sessionID | blockStamp() | sm.localBlockStamp | blockMapping.stamp | district pops | pending shatter`). When it changes, the hook sends a snapshot whose `fullBlockMap()` part is a **delta** against the previous snapshot. It walks DRA's object once and never copies it. If none of the three stamps changed (only pops did, because DRA recomputes aggregates lazily), it skips reading `fullBlockMap()`, except that it really re-reads at least every 2 s, in case a live edit changes the map without bumping a stamp. A panel that misses a base asks for a full snapshot. **This leans on the stamps more than round 1 did; L4 below now also checks it.**
- The full startup self-check runs once per tick until every required hook passes, then every 10 s and after any failed read. It used to run on every tick: at New York scale (14,367 features) it cost ~16 ms of DRA's main thread every 300 ms. The `fullBlockMap()` probe now counts keys instead of copying.

### 14. Feature IDs: CONFIRMED (static), plus a legacy form
```js
splitToVgeoid(e){ return e.bitset ? `B_${e.geoid}_${e.bitset}` : `vfeature_${e.geoid}_${e.chunk}_${e.id}` }
ListToBitset: toBits: byte floor(i/8) |= [1,2,4,...,128][i%8] over list = blockMapping.rev(geoid); then base64 (window.btoa)
function sd(e,t,i){ let r = i.rev(e); return t.length == r.length ? e : `B_${e}_${new ListToBitset(r, nc).toBitString(t)}` }
```
The bitset is **base64 of bytes; bit i (LSB first) selects `rev(precinct)[i]`**, where rev is DRA's sorted list. The extension decodes it with the live `rev()` lists. The legacy `vfeature_…_{hash}` IDs can't be decoded from the ID alone. The extension reports them as unresolved, which trips the data-mismatch guard instead of guessing.

### 15–16. Layers: CONFIRMED (static)
```js
changeStyle(e){ ...; (rootMap.getStyle()?.layers||[]).filter(l => /^dra-/.test(l.id)).forEach(l => rootMap.removeLayer(l.id)); ...; rootMap.setStyle(aD(e), {diff:false}); ... }
trackBgLayers(){ rootMap.getStyle().layers.forEach(l => { 0 !== l.id.indexOf("dra-") && (bgLayers[l.id] = true) }) }
... r.sort((a,b) => a.zindex - b.zindex); for (...) rootMap.moveLayer(r[e].name)
```
Basemaps are `mapbox://styles/dra2020/...`. Note: `trackBgLayers` counts every non-`dra-` layer, ours included, as a "background" layer. It looks harmless, since it only records IDs, but check it live (item 17).

### 22. Sync: CONFIRMED (static)
`/api/sessions/sendevent/{sessionID}` and `/api/sessions/receiveevent/{sessionID}` (long-poll). The extension doesn't touch them.

### 23. Out-of-scope detection (what the extension reads)
- 2010-shape: `dataContext.datasource` ∈ `2010_VD | 2016_BG | 2020_VD | 2030_VD`. Anything other than `2020_VD` is unsupported (block painting is 2020-only: `Support["2010_VD"].blockediting = false`).
- Multi-state: `dataContext.state` starts with `"+"` (`MULTI_PREFIX`, `isMultiState`).
- County or city: `model.restrictionTyped()` → `{ rt: "state" | <county/city>, id, name }`.
- Multi-member: `dataContext.allowMMD` and `safeDistrictProps()[i].membersPer > 1`.
- Unequal target: `dataContext.equalPop === false`.
- Also: `model.isMapCollection` (all-states collection) and `planType === "coi"`.

---

## Seen on the live site

First live run, 23 Nov 2026 (Chrome 157, a 20-district New York map opened as `#viewmap::…`):

- **`datasetContext.primeDDS` is not always `D20F`/`D20FA`.** On this map it was `48eb784a-3b94-4005-b940-3cceeb5c92ba.ds`, an opaque dataset id, while the statewide total it produced (20,201,249) was the plain 2020 Census total. What kind of dataset that id names is not known yet (a per-map or user dataset is the guess). The extension no longer trusts the name: when the key is not a bundle column, it picks the bundle column whose totals equal DRA's for every district, and only reports a data mismatch when neither column does (`checkMismatch` in `apps/extension/src/panel/controller.ts`).
- **The hook, the relay and the self-check all worked** once the tab had been reloaded after installing. A tab opened before the extension was installed has no content script; the panel now says so instead of sitting on "Connecting".

## Live checks (paste into the DevTools console of a signed-in DRA tab with a 2020 map open)

### L1. Hooks exist (items 1–9, 12–13)
```js
(() => { const m = dra.model(), dp = m.redistrict.safeDistrictProps(), k = m.datasetContext.primeDDS;
  return { model: !!m, fbm: typeof m.fullBlockMap, districtOf: typeof m.districtOf,
    bm: !!m.blockMapping && typeof m.blockMapping.rev, bmStamp: m.blockMapping?.stamp, primeDDS: k,
    dc: m.dataContext, total: m.totalStatePop(), blockStamp: m.redistrict.blockStamp(),
    session: typeof dra.env.clientSession.on, sm: Object.keys(m.sm.shatterMap),
    rows: dp.map((d,i)=> i && [i, d.label, m.datasetGetter(m.derivedProps.aggregates[i], k)('Tot'), dp.targetPop(m,i)]).filter(Boolean) } })()
```
**Expect:** every type is `"function"`, `bm` is `"function"`, `primeDDS` is `"D20F"` (or `"D20FA"` in the prisoner-adjusted states), and `dc.nDistricts` matches the map. The `rows` pops and targets equal DRA's district table: pop column, plus deviation = pop − target.

### L2. Map handle (item 10)
```js
({ ver: mapboxgl.version, isMap: dra.env.theMap instanceof mapboxgl.Map, layers: dra.env.theMap.getStyle().layers.map(l=>l.id).slice(-8), glyphs: dra.env.theMap.getStyle().glyphs })
```
**Expect:** `ver: "2.11.0"`, `isMap: true`, the last layers are `dra-…`, and `glyphs` is a `mapbox://fonts/...` URL. With glyphs present the extension uses a symbol layer for the numbers, borrowing a `text-font` the style already uses; without them it uses HTML labels.

### L3. Our layer survives re-renders and a basemap switch (item 17)
```js
(() => { const M = dra.env.theMap; const fc = {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[M.getCenter().lng-.01,M.getCenter().lat-.01],[M.getCenter().lng+.01,M.getCenter().lat-.01],[M.getCenter().lng+.01,M.getCenter().lat+.01],[M.getCenter().lng-.01,M.getCenter().lat+.01],[M.getCenter().lng-.01,M.getCenter().lat-.01]]]}}]};
  const add = () => { if(!M.getSource('zd-test')) M.addSource('zd-test',{type:'geojson',data:fc}); if(!M.getLayer('zd-test')) M.addLayer({id:'zd-test',type:'fill',source:'zd-test',paint:{'fill-color':'#f0f','fill-opacity':.5}}); };
  const raise = () => { const o = M.style._order; if (M.getLayer('zd-test') && o[o.length-1] !== 'zd-test') { M.moveLayer('zd-test'); window.__zdRaises = (window.__zdRaises||0)+1; } };
  add(); M.on('styledata', () => requestAnimationFrame(raise)); M.on('style.load', () => { window.__zdStyleLoads=(window.__zdStyleLoads||0)+1; add(); });
  return 'added: pan, paint a precinct, then switch the basemap; then run L3b'; })()
```
L3b: `({ top: dra.env.theMap.style._order.slice(-3), raises: window.__zdRaises, styleLoads: window.__zdStyleLoads, present: !!dra.env.theMap.getLayer('zd-test') })`
**Expect:** a magenta square stays visible over the precinct colours. `top` ends with `'zd-test'`, `raises ≥ 1` after painting (DRA re-render), `styleLoads ≥ 1` after a basemap switch, and `present: true`.

### L4. Uncommitted painting (item 18)
First run:
```js
window.__zdState = 0; dra.env.clientSession.on('state', () => window.__zdState++); window.__zdSnap = () => { const m = dra.model(); return { local: m.sm.localBlockStamp, stamp: m.redistrict.blockStamp(), shattered: Object.entries(m.sm.shatterMap).map(([k,v]) => k+':'+v.state), blockKeys: Object.keys(m.fullBlockMap()).filter(k => /^\d{15,}$/.test(k)).length, stateEvents: window.__zdState } }; __zdSnap()
```
Then pick Block paint, click a precinct to shatter it, paint 2 blocks into another district **without** clicking the checkmark, and run `__zdSnap()`. Then click the checkmark and run `__zdSnap()` again.
**Also check (round 2):** every time `fullBlockMap()` changes, at least one of `stamp`, `local` or `blockMapping.stamp` changes too. The hook skips re-reading the feature map when none of them moved (it still re-reads every 2 s). If you find an edit that changes `fullBlockMap()` without moving a stamp (undo/redo, a remote edit), note it. The panel would then lag by up to 2 s.
**Expect, before the commit:** `local` went up, `shattered` lists the precinct as `shattered`, `blockKeys > 0`, and `stateEvents` is probably unchanged (that's what the static reading says; the extension doesn't depend on it). **After the commit:** `shattered` is empty, `blockKeys` is 0, `stamp` went up, `stateEvents` went up, and `fullBlockMap()` now has a `B_{precinct}_…` key. Also check whether DRA's district table updated **before** the commit. The extension's data-mismatch check skips while anything is shattered, so either way is safe, but please record it.

### L5. Bitset decoding (item 14)
After L4 (a committed split), run:
```js
(() => { const m = dra.model(), bm = m.blockMapping, fbm = m.fullBlockMap(); const k = Object.keys(fbm).find(k => k.startsWith('B_')); const [, p, bits] = /^B_([^_]*)_(.*)$/.exec(k); const list = bm.rev(p), b = atob(bits), out = []; for (let i=0;i<b.length;i++) for (let j=0;j<8;j++) if (b.charCodeAt(i) & (1<<j)) out.push(list[8*i+j]); return { k, district: fbm[k], blocks: out, allKnown: out.every(Boolean) }; })()
```
**Expect:** `blocks` are exactly the blocks you painted (or their complement for the other `B_` key), and `allKnown` is `true`.

### L6. Updated precincts (item 19)
Run `({ stamp: dra.model().blockMapping.stamp, n: (() => { let n=0; dra.model().blockMapping.forEachRev(() => n++); return n })() })`, switch on "updated precincts" for the map, then run it again.
**Expect:** `stamp` changes, and `n` may change.

### L7. Labels ↔ indexes (item 20)
`dra.model().redistrict.safeDistrictProps().map(d => [d.index, d.label, d.membersPer])` and `dra.model().districtOrder()`
**Expect:** index 0 has label `""` (Unassigned), districts are 1..n, and with custom labels `districtOrder()` maps label → index. The CSV fallback assumes numeric labels are the indexes and numbers custom labels in natural sort order. Please confirm on a map with custom labels that the export's labels match `districtOrder()`.

### L8. Corner-only contact (item 21)
Find two blocks that touch only at a corner (a checkerboard corner in a city grid). Put one in a district whose only link to the rest of the district is that corner, then read `dra.model().districtContiguity` (or DRA's contiguity warning in the analytics panel).
**Expect:** DRA flags the district as non-contiguous, which confirms rook adjacency at block level.

### L9. Out-of-scope fields (item 23)
`(() => { const m = dra.model(); return { dc: m.dataContext, r: m.restrictionTyped(), coll: m.isMapCollection } })()`
Run it on a county map, a multi-member map, a 2010 map and a multi-state map. **Expect:** `r.rt !== 'state'`, `dc.allowMMD === true`, `dc.datasource === '2010_VD'` and `dc.state` starting with `"+"`, respectively.

---

### Split precincts at scale (fixture only)
The real-scale fixture (`apps/extension/fixture/gen-real.mjs`, fake page `?plan=real`) encodes New York's enacted plan the way item 14 says DRA does: 14,015 whole-precinct entries plus 176 split precincts as `B_{precinct}_{bitset}`, one per district, over the sorted `rev()` list. That's 14,367 features. The extension decodes it with no unresolved features, and the bundle's populations match the fake DRA's for all 26 districts plus Unassigned. This shows the decoder and the format agree. It does not show that DRA itself writes them this way (L5).

### L10. Diagnostics (first live run)
The panel page has a collapsed **Diagnostics** section at the bottom, below the panel, with a Copy button. It lists the self-check item by item, the hook protocol version, `mapboxgl.version`, the DRA bundle script path, `dataContext` (datasource, version, planType), `primeDDS` and which accessor produced it, how the map handle was found, the names on `window.dra` and the model's members (to spot renames), the population field and target read, the bundle's DRA data version, and a per-district bundle-vs-DRA population table with any unresolved feature IDs. The same text is logged to the panel page's console (right-click the panel → Inspect) whenever it changes. It is built from what the extension read and is never sent anywhere. On the first live run, copy it and keep it with the L1–L9 results.

## How the extension degrades if any of this is wrong
- Every required hook is probed at startup (`selfCheck()` in `apps/extension/src/dra/hooks.ts`). A failure shows "DRA changed; update pending. Hook that failed: `<exact hook>`" and offers the CSV drop.
- If the map handle fails, the panel uses its own MapLibre mini-map.
- If population totals disagree, or feature IDs can't be resolved, the panel shows `data-mismatch` and makes no suggestions.

---

## Painting a step for the user (opt-in)

**Status: static recon of the same bundle (2,338,041 bytes, `Last-Modified: Fri, 20 Nov 2026 10:33:22 GMT`), plus the fake page. The paint path has never run against live DRA.** Do the live check (P1) and the first-use procedure (P2) below before trusting it.

The owner asked for "an option to paint the shown step for you". The extension still never paints on its own: the setting is off by default, and each paint is one walkthrough step, started by one click on that step's "Paint this step" button.

### Painting: what DRA does

Names like `Nr`, `jr`, `Zr`, `Qr` below are minified action IDs (numbers that change on every deploy). The extension never uses them. It calls the model methods they dispatch to, and those method names are stable. The model's own dispatcher is a plain switch with nothing extra around the calls:
```js
fire(e,t){switch(e){ ... case Zr:this.actionShatter(t);break; ... case Qr:this.actionUnshatter();break;
  case Nr:this.actionSetFeatureDistricts(t);break; case jr:this.actionSetBlockDistricts(t);break; ...
  case $s:this.actionUndo();break; case Us:this.actionRedo();break; ... case qr:this.actionPaintCity(t);break; ...
  default:return this._fire(e,t)} return!0}
```

**(a) Painting a whole precinct.** The map view's `colorAt` handles a paint stroke. `e.multi` holds the features under the brush: precincts, or the split pieces (`B_…`) of a split precinct:
```js
colorAt(e){const{actions:t,mouseMode:i,curDistrict:r,curModel:n}=this.props;if(n.isMapCollection)return!1;
  if(e.multi&&e.multi.length>0){const n="erase"===i?0:r;let s={};
    return e.multi.forEach(e=>{s[e.properties.id]=n}),
      t.fire(Nr,{blockMap:s,filterLocked:!0,coalesce:!0,pushUndo:!0}),this.triggerRepaint(e.multi),!0}return!1}
```
That is `model.actionSetFeatureDistricts({ blockMap: { [featureId]: district }, filterLocked: true, coalesce: true, pushUndo: true })`:
```js
actionSetFeatureDistricts(e){const{css:t,redistrict:i,sm:r}=this;let n=e.blockMap;
  if(e.filterLocked?n=this.filterDistricts(n):e.filterNoChange&&(n=this.filterNoChange(n)),
     e.coalesce&&(n=this.coalesceDistrictVFeatures(n)),
     null!=n&&(e.enforceDistrictCount&&this.assureDistrictCount(n),
       e.pushUndo&&this.recordUndoSetFeatureDistricts(n,e.counter),
       r.setFeatureDistricts(n,e.counter),r.filterOutFeatures(n),
       !Ge.Util.isEmpty(n)&&t&&t.bInSession&&i.metaProps())){
    let r=i.metaProps(),o=t.startLocalEdit(),a=r.blockMap; ...
    let d=new Ge.OT.OTMapResource(a);
    for(var s in n)if(n.hasOwnProperty(s)){let e=n[s]>r.nDistricts?0:n[s];d.edits.push([0==e?Ge.OT.OpMapDel:Ge.OT.OpMapSet,s,e]),...}
    o.edits.push(d);let u=new Ge.OT.OTCounterResource(ou);u.edits.push([Ge.OT.OpCounterAdd,"blockmap",1]),o.edits.push(u),t.addLocal(o)}}
```
- `filterLocked` → `filterDistricts`: drops every entry whose current **or** new district is locked, and every entry that doesn't change. It drops them silently.
- `coalesce` → `coalesceDistrictVFeatures`: when every split piece of a precinct ends up in one district, it replaces them with the precinct ID.
- `pushUndo` → `recordUndoSetFeatureDistricts(n, counter)` records the old value of every key (`districtOf(key)`, so 0 for a key that is new) against the new one:
  ```js
  recordUndoSetFeatureDistricts(e,t){let i={};for(var r in e)e.hasOwnProperty(r)&&(i[r]=this.districtOf(r));
    this.undoredo.push({undo:[{id:Nr,arg:{blockMap:Ge.Util.deepCopy(i)}}],redo:[{id:Nr,arg:{blockMap:Ge.Util.deepCopy(e)}}]},t)}
  ```
- `sm.setFeatureDistricts` / `sm.filterOutFeatures`: the shatter manager keeps any key that is in its own uncommitted `sm.blockmap`, and every bare block ID (`pc()`), out of the committed edit:
  ```js
  filterOutFeatures(e){Object.keys(this.blockmap).forEach(t=>{delete e[t]}),Object.keys(e).forEach(t=>{pc(t)&&(tO("attempt to set blockid"),delete e[t])})}
  ```
- Then it makes one OT edit: a set or delete per key (0 deletes), plus `stamps.blockmap += 1` (the `blockStamp()` the hook reads). It hands the edit to `css.addLocal`, which applies it to the local state **synchronously** and emits `state`:
  ```js
  addLocal(e){if(this.clientEngine){ ... this.clientEngine.addLocalEdit(e),this.parent.speed.speedUp(),this.tick()}}
  addLocalEdit(e){try{this.actionAllClient.compose(e),this.actionAllPendingClient.compose(e),this.stateLocal.compose(e),delete this.valCache,this.emit("state")}catch(e){...}}
  ```
  DRA's own session loop (`tick()`, `/api/sessions/sendevent`) then sends it to the server. **It returns nothing** (`undefined`). The only signs that it is done are the state change, the `state` event, `blockStamp()`, and one more entry in `undoredo`.

**(b) Painting blocks inside a shattered precinct, then the checkmark.** This is DRA's interactive path:
1. With Block paint on, a click on a precinct fires `Zr` → `actionShatter(id)` → `actionShatterSingle`/`actionShatterGroup` → `actionShatterBase([ids])`. That opens an undo composite and calls `sm.shatter(ids, counter)`. The precinct goes to `shatterMap[id].state = "shattering"`, and to `"shattered"` once its block geometry has loaded (`_computeShatter` → `toShattered`, which copies each block's district into `sm.blockmap`).
2. Each block stroke is the same `colorAt` call with block IDs. In `actionSetFeatureDistricts`, `sm.setFeatureDistricts` updates `sm.blockmap` (`localBlockStamp++`). `filterOutFeatures` then deletes every bare block ID, so **nothing goes to the server yet**. (The undo record is pushed before that filter, so each stroke can be undone.)
3. The checkmark, `handleShatterClick(){ t.fire(Qr) }`, calls `actionUnshatter()` → `actionShatterBase([])` → `sm.shatter([], counter)` → `unshatterOne` → `toCoalescing`. That step groups the blocks by district, splits each group into contiguous pieces (`sD(blocks, multi)` over each block's `properties.contiguity`), and builds vfeatures. Once their geometry is computed (`isAllComplete`), `toCoalesced` fires:
   ```js
   this.model.fire(Nr,{filterNoChange:!0,pushUndo:!0,blockMap:t,counter:this.counter})   // t = precinct + old splits zeroed, new B_ splits set
   ```
   When every block ended up in one district, `toCoalescing` instead fires the precinct ID itself with the same options.

This path is a multi-stage, asynchronous state machine. It depends on DRA loading block geometry, on the map's shatter UI and marker, and on the shatter manager's internal state. It is not a self-contained entry point.

**The self-contained entry point DRA itself uses for blocks** is `actionSetBlockDistricts`. It takes block IDs and turns them into exactly the committed feature edit the checkmark would make: the precinct and its old split pieces zeroed, and one feature per district, `sd()` = the precinct ID if one district holds all of it, else `B_{precinct}_{bitset}`. It then calls `actionSetFeatureDistricts`:
```js
actionSetBlockDistricts(e){const{css:t,redistrict:i,sm:r}=this;let n=Ge.Util.deepCopy(e),s=n.blockMap;n.blockMap={};let o=n.blockMap,a=this.blockMapping,l=new Set,c=new Set;
  Object.keys(s).forEach(e=>c.add(a.map(e)));let d={};
  c.forEach(e=>{let t=r.vfeatureByGeoid(e);if(o[e]=0,t?.length)t.forEach(e=>{o[e]=0;let t=nd(e,a),i=this.districtOf(e),r=this.districtLocked(i);t?.length&&t.forEach(e=>{d[e]=i,r&&l.add(e)})});
    else{let t=a.rev(e),i=this.districtOf(e),r=this.districtLocked(i);t?.length&&t.forEach(e=>{d[e]=i,r&&l.add(e)})}});
  let u=this.restriction();Object.keys(s).forEach(t=>{let i=s[t];i&&u&&!u.includesBlock(t)||e.filterLocked&&(this.districtLocked(i)||l.has(t))||(d[t]=i)}),
  n.filterLocked=!1,n.coalesce=!1;let p={};Object.keys(d).forEach(e=>{let t=a.map(e),i=d[e]; ... p[t].get(i).push(e)}),
  Object.keys(p).forEach(e=>{p[e].forEach((t,i)=>{o[sd(e,t,a)]=i})}),this.actionSetFeatureDistricts(n)}
function sd(e,t,i){let r=i.rev(e);return t.length==r.length?e:`B_${e}_${new Ge.Util.ListToBitset(r,nc).toBitString(t)}`}
```
DRA's own **Paint City** tool calls it like this, and the extension copies that sequence exactly:
```js
actionPaintCity(e){ ... let r=this.undoredo.startComposite();
  this.actionSetBlockDistricts({filterLocked:!0,blockMap:i,filterNoChange:!0,pushUndo:!0,counter:r}),
  this.actionSetRedistrictProps({fixContiguity:!0,counter:r}),this.undoredo.endComposite() ... }
```
DRA's CSV import does the same pair (`fire(Vr, …)` then `fire(gs, {fixContiguity: !0})`). `fixContiguity: true` tells a later dataflow, `DFFixContiguity`, to re-split any `B_` feature that isn't contiguous. It doesn't change any block's district, and it folds its edit into the same undo step through `undoredo.openComposite()`:
```js
...o=s&&s.fixContiguity...if(a&&n&&!this.model.readonly&&this.model.dataComplete&&o){ ... if(i.length>1){ ... l[e]=0,i.forEach(i=>{t.bitset=r.toBitString(i),l[Zi.DT.splitToVgeoid(t)]=a[e]})} ...
  e=this.model.undoredo.openComposite(),this.model.actionSetFeatureDistricts({blockMap:l,noAutoCreate:!0,pushUndo:void 0!==e,counter:e})),
  this.model.actionSetRedistrictProps({fixContiguity:!1,noundo:void 0===e,counter:e})
```
The one difference from the checkmark: the checkmark splits pieces into contiguous parts at once (`sD`), while the block-level setter leaves that to `DFFixContiguity`. The end state is the same: the same blocks in the same districts, with contiguous split features.

**Undo.** Every path above records undo:
```js
class dO{ ... startComposite(){return this.cur<this.stack.length&&this.stack.splice(this.cur),this.composite=this.cur,this.counter++,this.counter}
  endComposite(){ ... merges stack[composite..cur) into one entry ... }
  push(e,t){if(!this.bInUndo)if(...,t&&this.cur&&this.stack[this.cur-1].counter===t){/* merge into top */}else e.counter=e.counter||t,this.stack.push(e),this.cur++}
  undo(){if(this.cur>0){let e=this.stack[this.cur-1];this.bInUndo=!0;for(let t=e.undo.length-1;t>=0;t--)this.actions.fire(e.undo[t].id,Ge.Util.deepCopy(e.undo[t].arg));this.bInUndo=!1,this.cur--}} ... }
actionUndo(){this.undoredo.undo()}
```
One paint = one undo entry (`undoredo.cur` goes up by exactly 1). DRA's Undo replays the recorded old values through `actionSetFeatureDistricts`, which restores the precinct's old features and deletes the new ones (their old value is 0).

**What the actions do not check, and how the extension handles each:**
- **Read-only maps.** None of these actions checks it. The UI does, and so does `actionSetDistrictOrder` (`!i.bReadOnly`). `addLocalEdit` doesn't check `bReadOnly` either, so on a read-only map the edit would apply locally and never be saved. The model's own getter covers every case: `get readonly(){ return userRestricted() || inMaintenance() || null==css || css.bReadOnly }` (a locked map sets `bReadOnly` too). There's also `get frozen(){ return css && css.bFrozen }`. The server sync only happens when `css.bInSession`, which is `get bInSession(){ return null!=this.clientEngine }`. **The extension refuses unless `readonly === false`, `frozen` is false and `css.bInSession === true`.**
- **Locked districts.** `filterLocked` drops entries silently, so a paint into or out of a locked district would just not happen. Locks are `districtProps()[i].lock`, read through `model.districtLocked(i)`. **The extension refuses when the step's giving or receiving district is locked.**
- **A precinct already shattered, or uncommitted block edits.** `sm.setFeatureDistricts` writes into `sm.blockmap` for keys it already holds, and `filterOutFeatures` drops those keys from the committed edit. A committed edit to a precinct DRA has shattered would then be overwritten when the user clicks the checkmark (`toCoalescing` zeroes the precinct and re-sets it from `sm.blockmap`). **The extension refuses while `sm.shatterMap` or `sm.blockmap` has anything in it**, in any precinct, not only the step's.
- **Legacy `vfeature_…` splits.** `actionSetBlockDistricts` zeroes them, but `nd()` can't decode them, so their blocks would fall out of the plan. **The extension refuses to paint a precinct that has one.** It already reports such maps as a data mismatch.
- **County and city maps** (`restriction()`): blocks outside the restriction are skipped silently. The extension doesn't support those maps at all.

### What the extension calls (src/dra/hooks.ts `paintStep`)

**Whole-precinct step** (`wholePrecinct: true`). This is the map's own precinct paint:
```js
model.actionSetFeatureDistricts({ blockMap: { [k]: to for every fullBlockMap() key of the precinct: its ID, or its B_ pieces }, filterLocked: true, coalesce: true, pushUndo: true })
```
**Block step**. This is DRA's own Paint City sequence:
```js
const counter = model.undoredo.startComposite();
try {
  model.actionSetBlockDistricts({ filterLocked: true, blockMap: { [blockGeoid]: to, ... }, filterNoChange: true, pushUndo: true, counter });
  model.actionSetRedistrictProps({ fixContiguity: true, counter });
} finally { model.undoredo.endComposite(); }
```
No shatter, no checkmark: the step is committed directly and shows as done, not "awaiting commit". The extension never calls `actionUndo`, never calls DRA's network endpoints, and never writes into DRA's objects.

**Checked before offering it** (`paintAvailability`; nothing is called). Each of these must be a function with this exact `length`, and its source must still mention these property names, which survive minification:

| Function | Arity | Its code must mention |
|---|---|---|
| `model.actionSetFeatureDistricts` | 1 | blockMap, filterLocked, coalesce, pushUndo, recordUndoSetFeatureDistricts, filterOutFeatures |
| `model.actionSetBlockDistricts` | 1 | blockMap, blockMapping, filterLocked, districtLocked, actionSetFeatureDistricts |
| `model.actionSetRedistrictProps` | 1 | fixContiguity, counter, noundo |
| `model.recordUndoSetFeatureDistricts` | 2 | undoredo, districtOf |
| `model.districtLocked` | 1 | |
| `model.actionUndo` | 0 | undoredo |
| `model.undoredo.startComposite` / `endComposite` / `push` / `undo` | 0 / 0 / 2 / 0 | composite + counter / composite / – / – |

Plus `typeof model.readonly === 'boolean'`, a numeric `model.undoredo.cur`, and object `model.sm.shatterMap` / `sm.blockmap`. Then, on every snapshot, it checks that the map is editable: `readonly`, `frozen`, `css.bInSession === true`, and not a collection. Any failure makes painting unavailable, with the failing check as the reason. Nothing else about the extension changes.

**Guards at click time** (`paintRefusal`, re-read from DRA, not from the panel's copy): editable as above; `from`/`to` valid and different; neither district locked; no shattered precinct and no uncommitted block edit anywhere; `dataComplete` not false; every step block in the step's precinct per `blockMapping.map()`; no unreadable `vfeature_` key in that precinct; every step block in `from` right now (decoded from `fullBlockMap()` the same way the panel decodes it). For a whole-precinct step, the step's blocks must also be exactly `rev(precinct)`, all in `from`. One paint at a time, in both the hook and the panel. None while a solve or re-plan runs. No solve or re-plan while a paint is in flight.

**Checked after.** The hook waits up to 5 s for the step's blocks to show up in `to`, then until `fullBlockMap()` is unchanged for two reads 250 ms apart (up to 3 s more, which covers `DFFixContiguity`). It then compares before and after **block by block** in every precinct whose features changed, plus the step's precinct. It expects exactly the step's blocks to change, all to `to`, and nothing else; no new uncommitted edits; `undoredo.cur` up by exactly 1; and no change to `blockMapping`. On any difference, or if DRA threw or nothing changed, painting is switched off for the session and the setting is saved as off. The panel says what differs (blocks that didn't move, blocks that went elsewhere, blocks outside the step that changed, features it can't read). It also says whether DRA's Undo has something to take back. If nothing changed, it says there is nothing to undo, so the user doesn't undo an earlier edit of their own.

### P1. Live check: the functions exist with the expected arity (paints nothing)
Paste into the DevTools console of the DRA tab with your map open. It reads names, arity and source text only, and calls none of the actions:
```js
(() => { const m = dra.model(), u = m.undoredo || {};
  const spec = { actionSetFeatureDistricts: [m.actionSetFeatureDistricts, 1, ['blockMap','filterLocked','coalesce','pushUndo','recordUndoSetFeatureDistricts','filterOutFeatures']],
    actionSetBlockDistricts: [m.actionSetBlockDistricts, 1, ['blockMap','blockMapping','filterLocked','districtLocked','actionSetFeatureDistricts']],
    actionSetRedistrictProps: [m.actionSetRedistrictProps, 1, ['fixContiguity','counter','noundo']],
    recordUndoSetFeatureDistricts: [m.recordUndoSetFeatureDistricts, 2, ['undoredo','districtOf']],
    districtLocked: [m.districtLocked, 1, []], actionUndo: [m.actionUndo, 0, ['undoredo']],
    'undoredo.startComposite': [u.startComposite, 0, ['composite','counter']], 'undoredo.endComposite': [u.endComposite, 0, ['composite']],
    'undoredo.push': [u.push, 2, []], 'undoredo.undo': [u.undo, 0, []] };
  const fns = Object.fromEntries(Object.entries(spec).map(([k, [f, n, w]]) => [k, typeof f !== 'function' ? 'MISSING' : f.length !== n ? `arity ${f.length}, expected ${n}` : (w.filter(x => !Function.prototype.toString.call(f).includes(x)).map(x => 'no ' + x).join(', ') || 'ok')]));
  return { fns, readonly: m.readonly, frozen: m.frozen, bInSession: m.css && m.css.bInSession, undoDepth: u.cur, shattered: Object.keys(m.sm.shatterMap), uncommittedBlocks: Object.keys(m.sm.blockmap).length,
    locked: m.redistrict.safeDistrictProps().map((d, i) => i && d.lock && i).filter(Boolean) }; })()
```
**Expect:** every entry in `fns` is `"ok"`. On a map you own: `readonly: false`, `frozen: false` (or `undefined`), `bInSession: true`, a number for `undoDepth`, `shattered: []`, `uncommittedBlocks: 0`. On a view-only link, `readonly: true`. The panel's Diagnostics section has the same list under "[painting a step for you]".

### P2. First use: on a copy of a map
1. In DRA, make a copy of a map (DRA's copy/duplicate command for a map; check the exact menu name in DRA) and open the copy. Paint nothing on the original until this has gone well. Open the panel, wait for **Live**, solve, and pick an option whose walkthrough has a **whole-precinct** step and a **block** step.
2. Run P1 above and keep the result. Note DRA's population for the step's two districts.
3. In the walkthrough, tick **Paint steps for me**. Go to the whole-precinct step and click **Paint this step**. Check:
   - DRA's map shows the precinct in the receiving district, and DRA's district table shows the two districts' populations changed by the step's people, with no other district changing.
   - The step ticks in the panel and there's no "stray edits" warning.
   - DRA's **Undo** is available. Click it once: the precinct goes back and the step un-ticks. Click **Redo** (or paint again) to continue.
4. Go to a block step and click **Paint this step**. Check:
   - DRA shows the numbered blocks in the receiving district and the rest of the precinct unchanged, with no shatter marker and no checkmark waiting. A moment later DRA may re-draw the precinct's pieces (its contiguity fix). The blocks' districts must not change when it does.
   - The step ticks; DRA's district table matches the panel.
   - Click DRA's **Undo** once: the whole step goes back in one go. Paint it again.
5. Reload the DRA tab and check that the painted steps are still there, which shows DRA saved them to its server. Open the map's revision history if you want to see the edit recorded.
6. If anything differs (blocks elsewhere, more than one Undo needed, a step that did not tick, a red "did not do what was asked" message), stop. Copy the panel's Diagnostics, and use DRA's Undo to take the edit back. The panel switches painting off by itself when its after-check finds a difference.

**Assumptions the static reading could not settle (check them in P2):**
- That DRA's map re-colours from the state change alone. `colorAt` also calls `this.triggerRepaint(e.multi)` for an immediate repaint, which the extension can't call, since it is on the map view, not the model. The state event should re-render it anyway (step 3).
- That `fullBlockMap()` reflects the edit within 5 s. Statically it is synchronous.
- That `DFFixContiguity` runs soon after a block paint and merges into the same undo step. If the user does something else first, `openComposite()` merges into whatever entry is on top. The blocks' districts are the same either way.
- That a remote collaborator's edit landing during the ~1 s check would be reported as a difference. That is intended: the extension stops rather than guesses.
