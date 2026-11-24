DRA Zero-Deviation Extension: Build Spec
Nov 23, 2026
Overview and goals
A Chromium extension that reads your plan live from an open Dave's Redistricting (DRA) tab, finds the census blocks along district borders that bring one district, a group you pick, or the whole map to zero deviation, and walks you to each block until you've painted it.
• Scope: three ways to pick what to balance. One district: its neighbors absorb the difference. A group of districts you select: all of them are zeroed together, and districts outside the group stay untouched unless you allow them to absorb. The whole map: every district is zeroed.
• Target: as close to zero as possible. DRA's target is the ideal population rounded to a whole person, so when the state doesn't divide evenly the best result is 0 or one person off. Whether that's +1 or −1 depends on the state's remainder. Both count as success.
• Input: the live DRA tab. No export/import step in the main flow.
• Output: a ranked list of zeroing options. Picking one starts a guided walkthrough: highlight the block, zoom to it, confirm when it's painted, go to the next.
• Browsers: Chromium first (Chrome, Edge, Brave, Arc, Opera), Firefox later from the same codebase.
• Builder: written by Claude Code from this spec, phase by phase.
How Dave's Redistricting works under the hood
DRA puts its whole app state on the page as window.dra, including the map and the plan model, so a MAIN-world script can read the plan directly instead of decoding network traffic. Everything below comes from DRA's live client bundle (draclient.bundle.js, last modified 20 Nov 2026) and its public GitHub repos. Any DRA update can change it, so the extension needs a version check (see Risks).
What the extension needs
Where it lives in DRA
Notes
The map
window.dra.env.theMap, a Mapbox GL JS v2.11.0 map
Fallback: patch mapboxgl.Map at document_start.
The current plan
dra.model().fullBlockMap()
Includes unsaved block edits. Feature IDs are precinct GEOIDs, or B_{precinct}_{bitset} for a split precinct.
Which district a feature is in
dra.model() districtOf(id)

Block-to-precinct mapping
the map's own blockMapping (.map(), .rev())
Use this, not the raw file, because users can switch to "updated precincts" that override it.
Population field
datasetContext.primeDDS
Usually D20F (2020 Census total). Prisoner-adjusted D20FA in CA, DE, MD, NJ, NV, PA, VA, WA, and for legislative maps in CO, CT, NY.
Target population
Math.round(state total / districts)
dra-analytics
Change events
env.clientSession.on('state', …) plus the stamps.blockmap counter
Painting detection hooks here.
Rendering. Precincts and blocks aren't ordinary Mapbox layers. DRA draws them with its own WebGL layers, so Mapbox's feature lookups can't see blocks. The extension draws highlights as its own GeoJSON layer. DRA moves its layers to the top on every render and deletes every layer named dra-… when the basemap changes. So the extension's layers need a different prefix, must be raised again after renders, and must be re-added on style.load.
Sync. Edits go to the server over HTTPS long-polling (/api/sessions/sendevent, /receiveevent), with no WebSockets. An assignment edit is [1, featureId, districtIndex]. Block edits inside a shattered precinct stay local until the user clicks the checkmark or moves on. That's why reading fullBlockMap() beats watching the network.
DRA's own data files. DRA serves per-state precinct shapes, block data, block mapping and contiguity files from data.dra2020.net. They're public, but CORS only allows davesredistricting.org. Block geometry loads one precinct at a time, as .topopack files, when a precinct is shattered.
Precinct shapes.
• Defaults are 2020 Census VTDs.
• CA, HI, OR and WV use block groups instead.
• Maine adds county subdivisions.
• Florida has fixes in two counties.
• Users can switch on "updated precincts" per map. DRA blog
What "zero" means in DRA. Because the target is rounded, the best possible result for a district is a deviation of 0, or one person off. Whether that one person is +1 or −1 depends on the state's remainder, not always −1.
Block painting. It only works on 2020-shape maps. Choose Block in the Paint control, click a precinct to "shatter" it, paint blocks, then commit with the checkmark. Painting With Blocks
Exports, the fallback path.
• The block assignment CSV has the header GEOID20,District, one row per assigned block.
• It uses custom district labels if they're set, leaves unassigned blocks out, and includes only committed edits.
• Import accepts , or | separators and skips the header. Exporting Maps
No existing tool. DRA has no auto-balance or block-suggestion feature and no public API. The researcher found no third-party extension for DRA 2020.
Terms of Use (updated July 2026). Section 3 bars using "any robot, spider or other automatic device" to access or copy the site, and bars overburdening it or making derivative use of it. Extensions aren't mentioned. Terms of Use A read-only helper that highlights while you paint by hand is the low-risk design, and this spec never paints for you. It's worth emailing feedback@davesredistricting.org before publishing.
Architecture
The extension reads DRA's page, does all the math inside your browser, and sends nothing about your plan anywhere. The only network traffic it adds is downloading each state's data bundle once.
The hook and the content script talk over a private MessageChannel set up before any DRA code runs, so the page can't fake messages. The engine lives in a Worker owned by the side panel, because MV3 service workers can't start Workers and shut down after 30 seconds idle.
Data pipeline
Each state gets two files on R2:
• Attributes and adjacency file: 2 to 5 MB. The researcher measured New York at 2.2 MB.
• Geometry: split by county, so a session only downloads the counties the district touches.
DRA's live map stays the authority for which precinct each block belongs to and which population count is in use. The bundle supplies only what DRA doesn't expose cheaply: who touches whom, border lengths, and shapes.
Inputs
Input
What it gives
Source
License
TIGER2020 TABBLOCK20 (2023 re-release)
Block shapes, POP20, HOUSING20
census.gov
Public domain
Census 2020 Block Assignment Files
Block to VTD (state + county + VTD code). None for CA, HI or OR.
census.gov BAF
Public domain
DRA block_data
Total and prisoner-adjusted (T_20_CENS_ADJ_Total) population per block
dra2020/block_data
CC BY-SA 4.0, not for sale
DRA vtd_data
DRA's precinct IDs and its precinct adjacency graph
dra2020/vtd_data
CC BY-SA 4.0, not for sale
Two checks already passed for NY:
• POP20 equals DRA's block total for all 288,819 blocks.
• DRA's 14,191 NY precinct IDs exactly match the Census VTD set.
For CA, HI, OR and WV, DRA uses block groups, so the precinct key is the first 12 digits of the block GEOID.
Scale (measured)
State
Blocks
Zero-population
NY
288,819
20.2%
CA
519,723
27.3%
TX
668,757
32.8%
FL
390,066
25.7%
All 50 states + DC
8,132,968
29.1%
Adjacency must match DRA's rule. The researcher compared DRA's NY contiguity graph against adjacency built from blocks:
• It's pure rook: blocks count as neighbors only if they share an edge. Corner-only contacts don't count, and NY has 266,712 such block pairs that the extension must ignore.
• Water is crossed through water-only blocks.
• DRA adds a few hand-made links, for example Governors Island to Liberty Island.
• So the pipeline keeps water blocks as zero-population nodes and copies DRA's manual links from vtd_data.
• It bridges the few blocks with no rook neighbor (14 in NY) to the nearest block.
Pipeline steps (Python, run once per state, re-run when DRA updates its data version)
1.  Download TABBLOCK20, the BAF and DRA's block CSV. Check that the GEOID sets are identical and that POP20 equals DRA's total. Always join on GEOID, since row order differs between Census editions.
2.  Build the precinct key from DRA's vtd_data IDs, and check that summed block populations match DRA's precinct totals.
3.  Build rook adjacency with shared border lengths in meters. Use numpy segment hashing in an equal-area projection (EPSG:5070); NY took 11 s and 3.5 GB of memory. For CA and TX on a small machine, use per-county TIGER EDGES/FACES instead. libpysal ran out of memory and isn't usable at this scale.
4.  Simplify geometry with mapshaper-xl (5 to 8%, keep shapes), write TopoJSON per county, and verify the feature counts.
5.  Encode, compress, write a manifest (file hashes, Census and DRA data versions, CC BY-SA attribution), and upload to R2.
Bundle format
• attrs.bin.gz per state: a small JSON header plus typed arrays:
    ◦ sorted GEOIDs
    ◦ both population columns
    ◦ county and precinct indexes
    ◦ neighbor lists as offsets
    ◦ shared border length (Uint16 meters)
• Per-county .topo.json.gz: fetched on demand. A whole state is about 10 MB compressed for NY, about 20 MB for CA, and about 23 MB for TX. topojson-client neighbors() and mesh() can rebuild borders in the browser.
Hosting and caching
• R2 behind a custom domain, not r2.dev, which is rate-limited and uncached.
• CORS allows GET and HEAD. Fetches go from the extension's own pages, which have host permission for the data domain.
• Files use versioned names with immutable cache headers. A small manifest uses a short cache time.
• Files are stored as gzip bytes and decompressed with DecompressionStream.
• Cost is effectively zero: R2 egress is free, storage is $0.015/GB-month, and the free tier covers 10 GB. R2 pricing
• In the browser, files are cached in IndexedDB under unlimitedStorage.
Where the extension could disagree with DRA, and the fix
• Prisoner adjustment: NY's adjusted total is 7,391 lower, and 23,261 NY blocks change. The fix is to ship both columns and pick the one matching primeDDS.
• Updated precincts: read precinct membership from the live blockMapping, never from the bundle.
• DRA data version changes (v08 is current, dated 2026-11-02): on load, sum the bundle's populations per district and compare against DRA's displayed totals. If they differ, warn and don't suggest.
• Differential privacy noise: not a problem, because DRA uses the same noisy counts. Populated blocks with zero housing units (13,649 nationwide) are real counts and stay in.
Balancing engine
A custom TypeScript solver in a Web Worker finds 5 distinct exact-zero options for a congressional-size district in about 4 to 520 ms. In the prototype, plain TypeScript was fast enough, and a general-purpose optimization solver was 50 to 100 times slower.
The problem in one line: pick a connected set of border blocks whose population equals the deviation D, without breaking either district's contiguity and with as few new precinct splits as possible. In theory this "connected knapsack" problem is very hard (Dey, Kolay, Singh). In practice it's easy, because block populations are small enough that nearly every total is reachable. The real work is finding options that are connected, tidy and different from each other.
Targets. With state population P and k districts, the ideal is P/k. If it doesn't divide evenly, both the floor and the ceiling count as zero, so the solver accepts either sum. Against DRA's rounded target, those show up as 0 and either +1 or −1. That matches the legal one-person standard (Shahmizad and Buchanan).
Steps
1.  Direction. If your district A is over, it gives blocks to neighbors. If it's under, it takes blocks from each neighbor N. The logic is the same either way.
2.  Candidate ring. Take the giving district's blocks within 3 hops of the A/N border. Widen to 6, then 10 hops if nothing works.
3.  Grow chunks inside each border precinct. From 8 to 16 seed blocks touching the receiving district (skipping blocks whose removal would cut the district), grow a connected chunk one block at a time. Every prefix of that growth becomes an option. Also add a whole-precinct option, which creates no split and can heal an existing one. Keep only the cheapest option for each population value.
4.  Choose. Run an exact-sum knapsack over precincts, using at most one chunk per precinct, so the total hits the target at the lowest cost.
5.  Verify. Check that the giving district is still connected. If not, ban the offending chunk and solve again.
6.  Get alternatives. After accepting an answer, add a penalty to the precincts it used and solve again until there are 5 to 8 answers. Pure "k-best" output returned near-duplicates, so penalties are what make the options actually different.
7.  Re-score and sort the final answers exactly.
Every chunk touches the receiving district by construction, and chunks in different precincts never overlap. So only the giving side needs a contiguity check. Precincts you've already split come out first naturally, because splitting them further costs nothing.
Contiguity checks
• Default: a breadth-first search over the remaining district (about 0.3 to 0.6 ms on 22,000 blocks).
• Faster: search only from the blocks bordering the removed set, and stop as soon as they reconnect. Geo-graph local tests also catch holes.
• Precompute articulation points (blocks whose removal would split the district) to skip bad seeds. If cutting one would only strand a tiny or empty piece, move that piece too.
• Districts DRA already allows to have several parts, like islands: the rule is "no new pieces," not "one piece."
• The adjacency rule (blocks touching only at a corner, water crossings) must match DRA's. See open questions.
Zero-population blocks
• They don't change D but stay in every connectivity check, so the tool never strands an empty block that DRA would flag.
• They act as cheap bridges inside chunks. Chunks made only of empty blocks are dropped.
• After choosing, the tool also moves any empty block that ends up enclosed by the new border.
Ranking (cheap to update as blocks move)
Factor
Weight
New precinct split
+100
Precinct split healed
−100
New county split
+300
Blocks moved
small, populated blocks count more
Compactness
change in perimeter from shared border lengths (Polsby-Popper)
Neighbor effect
how much the move worsens or improves the neighbor's deviation
Ties break by fewest blocks, then perimeter change, then block ID, so results are repeatable.
Measured speed (Node 22, the same JavaScript engine as Chrome; synthetic district of 22,338 blocks, 40% empty)
Deviation D
Candidate blocks
5 verified options
37
2,508
4 ms
487
2,508
15 ms
1,237
2,508
54 to 102 ms
4,800
2,508
518 ms
4,999
3,819 (6 hops)
313 ms
The HiGHS optimization solver compiled to WASM took 21 to 91 seconds with full contiguity constraints. It's kept only as an optional exact checker, using the faster precedence formulation, which took 1 to 2.5 s.
TypeScript vs Rust: TypeScript with typed arrays is enough. Rust/WASM becomes worth it above about 50,000 candidate blocks, deviations in the tens of thousands, or whole-state balancing. Even then, the expected gain is only about 1.5 to 2 times faster.
Edge cases
• Deviation too big for the border: widen the ring, use whole-precinct moves, then report "needs precinct-level rework." Optionally offer to cascade: fix A by overloading N, then make N the next target.
• Neighbor pushed out of balance: by default, never leave a neighbor worse than its current deviation, or a tolerance the user sets.
• State edge or coastline: count hops only from borders between districts, and include coastline in the perimeter.
Balancing several districts
For a group of districts, or the whole map, the engine works in two stages. First it decides how many people cross each shared border. Then it picks the blocks one border at a time, using the single-district solver above. One-district mode is just the special case of a group of one whose neighbors are allowed to absorb.
What zero means for a group. Let q be the state population divided by the number of districts, rounded down. Every selected district must end at q or q + 1 people, which DRA shows as 0 or one person off. The group's combined population decides how many of its districts land on q + 1.
If the group as a whole is too far over or under for that, it can't be zeroed on its own. The panel says so and offers two fixes, for example: "This group is 1,240 over. Add District 9 or 12, or let outside neighbors absorb it." Districts outside the selection are never touched unless you allow it.
Steps
1.  Map how the districts interact. For each pair of neighboring districts in the group, run the chunk generator on their shared border, in both directions. This gives a capacity curve: how many people can cross with no new splits, how many at low cost, and how many at high cost. The panel shows this as the interaction view (see Guiding the user).
2.  Plan the transfers with min-cost flow.
    ◦ Each selected district is a node with supply equal to its population minus q.
    ◦ A sink lets up to the required number of districts keep one extra person.
    ◦ Each shared border is an arc in both directions, with costs from the capacity curve (cheapest tier first).
    ◦ The result is an exact whole number of people to move across each border.
    ◦ Districts that don't touch can still trade through the ones between them (A to B to C), and the costs keep those chains short.
    ◦ The district graph has at most a few hundred nodes, so this step takes milliseconds.
3.  Turn each transfer into blocks, largest first. Each border runs the single-district solver with its transfer as the exact target. It works on the plan as already updated by earlier borders, so moves on one border account for moves already made on another.
4.  Check the whole plan.
    ◦ Every district must be contiguous and at q or q + 1.
    ◦ No block moves twice.
    ◦ If a border can't hit its number, or a district that gives on two borders gets cut in two, lower that border's capacity and re-plan from step 2.
5.  Offer alternatives. Re-run steps 2 to 4 with different weights to produce three plans: fewest new precinct splits, fewest blocks moved, and fewest districts touched.
Speed (estimate, to be measured in Phase 2). The flow step is negligible. The total is roughly the number of borders with a transfer times one single-border solve, which measured tens of milliseconds for typical deviations. A finished 26-district map should take a few seconds. State house maps with 100 to 400 districts run in the Worker with a progress bar.
Unfinished maps. If deviations are in the thousands, whole-precinct moves come out first, because they create no splits. Block-level fixes follow. A big imbalance still produces a usable plan, just a longer one.
Prototype code from the research is in the workspace (proto/balance.mjs) and can seed Phase 2.
Guiding the user
Picking an option starts a step-by-step walkthrough. Each step highlights the blocks to paint right on DRA's map, zooms there, and ticks off each block as soon as DRA's own plan shows it in the right district. The extension never paints anything itself.
The options list (side panel)
• The header shows the selected district, its population, the target, and the deviation, for example "District 13: +412 over."
• Each option card shows: people moved, blocks moved, new precinct splits, new county splits, change in compactness, and the effect on each neighbor ("District 12: −380 → +32").
• Hovering a card previews its blocks on the map. Clicking starts the walkthrough.
The walkthrough
1.  Steps are grouped by precinct, because DRA paints blocks one shattered precinct at a time. A step reads like: "Step 2 of 3: with Block paint on, click the outlined precinct to shatter it, then paint the 4 highlighted blocks into District 12."
2.  The map zooms (fitBounds) to that precinct. Blocks to remove from your district get one color, blocks to add get another, and each block carries a number.
3.  As you paint, the extension reads fullBlockMap(), which includes uncommitted block edits, and turns each finished block green.
4.  When a precinct's blocks are done, the panel reminds you to click DRA's checkmark to commit. Then it moves to the next step.
5.  At the end, it re-reads the plan and confirms the deviation against DRA's own numbers.
Mistakes and changes. If you paint a block that isn't in the plan, or edit something elsewhere, the panel says so. It offers "re-plan from here," which re-solves from the current map in under a second. Undo inside DRA works as normal, and the walkthrough just follows the live state.
Highlight layer rules (from the DRA research)
• Use our own GeoJSON source plus fill and line layers on dra.env.theMap, with IDs prefixed zd-, never dra-.
• Raise them again after DRA re-renders, and re-add them on style.load after a basemap change.
• Labels go in a symbol layer, or in HTML markers if DRA's style has no glyphs.
Fallbacks
• No map handle (DRA renamed things): the panel shows its own MapLibre mini-map with a street basemap, the same numbered blocks, and the precinct ID to click.
• Can't read the plan live: drag-and-drop DRA's block assignment CSV into the panel. Same solver and same walkthrough, minus the live ticking.
Controls
• Next and back buttons.
• "Zoom to step" re-centers the map if you've panned away.
• Esc ends the walkthrough and clears the highlights.
Several districts or the whole map
Picking the group
• The panel lists every district with its population and deviation, sorted with the worst first.
• Check boxes select a group. There are also "Select all" and "Add neighbors" shortcuts.
• A live line shows whether the group can be zeroed on its own, and if not, how far over or under it is.
The interaction view. For the selected districts, the panel shows a small schematic of which districts touch. Each district is a node colored by its deviation. Each shared border shows how many people could cross cheaply. Hovering a border highlights it on DRA's map. This is how you see, before solving, that District 4's surplus can only reach District 9 by passing through District 7.
Plan cards. Each of the three plans shows:
• the transfer on every border ("4 → 7: 312 people, 7 → 9: 205 people"), also drawn as arrows on the schematic
• total blocks moved, new precinct and county splits, and the number of districts touched
• before and after deviation for each district
The walkthrough across several borders
• Steps are grouped by border, then by precinct, in the order the engine realized them.
• The header tracks every selected district's deviation live, so you see each one reach zero.
• Painting out of order is fine. The panel ticks off whatever matches and re-checks the rest.
• "Re-plan from here" re-solves only the borders not yet done.
Tech stack and browser support
The extension is built with WXT on Manifest V3, in TypeScript throughout, with the engine in a Web Worker spawned by the side panel.
Piece
Choice
Why
Build framework
WXT 0.21.x
Most active option. One codebase emits side_panel for Chrome and sidebar_action for Firefox, and it supports MAIN-world content scripts. It's pre-1.0, so pin the version. Plasmo hasn't shipped since May 2025.
Language
TypeScript
Same language for hooks, panel and engine. Rust/WASM only if profiling demands it.
Page hook
Content script declared in the manifest with world: "MAIN", run_at: "document_start"
Runs before DRA's bundle, so it can wrap fetch and trap the map constructor. Content scripts docs
UI
chrome.sidePanel, enabled only on davesredistricting.org tabs
Chrome 114+. Per-tab enabling via setOptions. sidePanel API
Engine host
Dedicated Worker created by the side panel page
MV3 service workers can't create Workers and die after 30 s idle. The panel lives as long as the user is working.
Data cache
IndexedDB (or OPFS from the worker) with unlimitedStorage
No quota or eviction, no install warning.
Data host
Cloudflare R2 with CORS for the extension origin
Downloading data (not code) is allowed under MV3. Remote code rules
Browser support
• Chrome, Brave: full support.
• Edge: supported. Known bug: the panel may not reappear after switching tabs. MS Learn
• Opera (required target): Opera added chrome.sidePanel in Opera Stable 135, but users report it misbehaving and it isn't documented on Opera's own API page. Opera forum So the panel code feature-detects in this order:
    1.  chrome.sidePanel if it exists and opens.
    2.  Opera's own sidebar (sidebar_action manifest key, opr.sidebarAction API), which Opera has supported since Opera 30. Opera docs
    3.  A pop-out window running the same panel page.
• Opera builds: ship a separate Opera build from WXT (wxt build -b opera) that includes sidebar_action, and list it on addons.opera.com.
• Opera lag: Opera trails Chrome by a few releases, so don't depend on recent Chrome-only additions like sidePanel.close() (141+) or onClosed (142+).
• Opera test gate: every phase that touches the UI is tested in current Opera Stable on Windows and macOS before it counts as done.
• Arc: no side panel. Uses the same pop-out window fallback.
• Firefox (later): MAIN-world scripts work from Firefox 128. Uses sidebar_action, which only opens from a user click. New Firefox add-ons must declare data_collection_permissions. Mozilla
Permissions and store policy
• Request only https://davesredistricting.org/*, sidePanel, storage, unlimitedStorage, plus the R2 origin if CORS isn't used.
• Avoid chrome.debugger. It shows a permanent "started debugging this browser" banner and slows store review.
• On the stores, the plan you're drawing counts as user data under Web Store rules. Keep it on-device, say so in the listing, and publish a short privacy policy.
• No obfuscated code. Minified is fine.
• If WASM is added later, the manifest CSP needs 'wasm-unsafe-eval', and the WASM must ship inside the package.
Build phases for Claude Code
There are ten phases, each with a test that has to pass before the next starts. New York is the test state until Phase 8. Run each phase as its own Claude Code session, with this spec in the repo as SPEC.md.
1.  Phase 0: Live recon. In a signed-in DRA tab, confirm each hook from the DRA section. Record the results in RECON.md:
    ◦ window.dra exists, and dra.model() has fullBlockMap, districtOf, blockMapping, datasetContext.primeDDS, dataContext (number of districts) and totalStatePop().
    ◦ dra.env.theMap is a Mapbox map, and a test layer survives DRA re-renders and a basemap switch.
    ◦ While you paint blocks in a shattered precinct, fullBlockMap() and the state event update before you commit.
    ◦ Switching to updated precincts changes blockMapping.
    ◦ How district labels map to district indexes (index 0 is "Unassigned").
    ◦ Two blocks touching only at a corner are not treated as connected (confirms the rook rule at block level).
    ◦ Done when: every item is confirmed or has a named replacement.
2.  Phase 1: NY data bundle. Python pipeline per the Data section, uploaded to R2.
    ◦ Done when: block populations match DRA's block CSV exactly; precinct sums match DRA's precinct totals; and precinct adjacency derived from the block graph equals DRA's NY precinct graph.
3.  Phase 2: Engine as a standalone library. Port the research prototype (proto/balance.mjs) to TypeScript with typed arrays, plus a command-line test harness that reads a DRA block assignment CSV.
    ◦ Done when: for a real NY congressional map, it returns 5 or more distinct options at the target in under 1 s; an independent check confirms every option keeps both districts contiguous; and results are identical across runs.
4.  Phase 3: Extension skeleton (WXT). MAIN-world hook reads window.dra and passes data over a MessageChannel to the content script, which relays it to the side panel.
    ◦ Done when: the panel shows each district's population and deviation exactly as DRA shows them, in Chrome, Edge, Brave and Opera.
5.  Phase 4: Options list. Run the engine in a Worker started by the panel. Option cards show their stats, and hovering a card previews its blocks on DRA's map.
    ◦ Done when: the highlight layer stays visible through panning, re-renders and a basemap change.
6.  Phase 5: Walkthrough. Step-by-step guidance, per-block ticking from the live plan, commit reminders, "re-plan from here," and a final check.
    ◦ Done when: you can zero a real NY district by following the steps, and DRA shows 0 or one person off.
7.  Phase 6: Several districts and the whole map. Add the district picker, the interaction view, border capacity curves, the min-cost flow planner, border-by-border realization, the whole-plan check, three alternative plans, and the multi-border walkthrough.
    ◦ Done when:
        ▪ All 26 districts of a real NY congressional map with small deviations reach 0 or one person off, with every district contiguous, in under 10 s.
        ▪ A hand-picked group of 3 to 5 districts works, including one that must trade through a middle district.
        ▪ A group that can't balance on its own is reported, not half-solved.
8.  Phase 7: Fallbacks.
    ◦ CSV drag-and-drop mode.
    ◦ MapLibre mini-map when the map handle is missing.
    ◦ The Opera chain: chrome.sidePanel, then opr.sidebarAction, then a pop-out window.
    ◦ Arc pop-out.
    ◦ Hook self-check at startup.
    ◦ Done when: each fallback has been forced on and works, including in current Opera Stable.
9.  Phase 8: All states.
    ◦ Run the pipeline for every state, including the block-group states (CA, HI, OR, WV), Maine, the Florida fixes, and the adjusted-population column.
    ◦ Detect map types that are out of scope and disable suggestions with a clear message: multi-member, unequal-target, county or city, multi-state, and 2010-shape maps.
    ◦ Benchmark whole-map mode on the largest state house map.
    ◦ Done when: the validation suite passes for every state.
10.  Phase 9: Publish.
    ◦ List it on the Chrome Web Store (one-time $5 developer fee), which also covers Brave, plus Microsoft Edge Add-ons and Opera add-ons. Store installs update automatically.
    ◦ Credit DRA's data (CC BY-SA 4.0) on each listing and in the extension's About screen. Census data is public domain.
    ◦ Write a one-paragraph privacy policy (the plan never leaves your browser), fill in each store's data disclosure, and email DRA before the first release.
Later: a Firefox build, and Rust/WASM if a profile of whole-map mode on big state house maps ever shows the engine is slow.
Risks and open questions
The biggest risk is DRA changing its page code. DRA serves one unversioned bundle with no caching, so a deploy can rename window.dra overnight. The extension has to notice that and fall back instead of breaking.
Risk
Likelihood
What happens
Mitigation
DRA renames or restructures window.dra, the model or the map
High over a year
Live reading or highlights stop working
Startup self-check of every hook. On failure, switch to CSV mode and the mini-map, and show "DRA changed; update pending." Keep the hook code in one file.
DRA's Terms of Use (anti-robot, derivative-use clauses)
Medium
DRA could object or block it
Read-only and guide-only, never auto-paint, no bulk fetching from DRA's servers. Email DRA before publishing.
Moves on one border interfere with another in multi-district mode
Medium
A district giving on two borders gets cut in two, or a plan fails partway
Realize borders in order on the updated plan, check every district at the end, lower that border's capacity and re-plan on failure. Phase 6 tests a trade through a middle district.
Bundle populations drift from DRA after a DRA data update
Medium
Suggestions miss zero by a few people
Compare per-district totals with DRA on load; warn and refuse to suggest on a mismatch. Track DRA's data version in the manifest.
Opera's chrome.sidePanel is new and buggy
Medium
Panel misbehaves in Opera
Fallback chain to opr.sidebarAction, then a pop-out. Opera test gate on every UI phase.
Block-level contiguity rule isn't exactly rook
Low
DRA flags a district the engine called contiguous
Phase 0 corner-touch test. The engine's contiguity rule is a single setting.
Large deviations the border ring can't fix
Low
No options found
Widen the ring, try whole-precinct moves, then say "needs precinct-level rework."
Decisions
• Free, never sold. DRA's block_data and vtd_data are used with credit under CC BY-SA 4.0. The data bundles built from them are shared under the same license. Census data is public domain. The license works the same for a public release as for a private one.
• Published on the stores so updates are automatic. This matters because DRA site changes will break the hooks from time to time, and fixes need to reach users without a reinstall. Public or unlisted is your call at publish time.
• Contact DRA before the first store release. Their Terms of Use matter more once it's public, and they might offer a supported hook.
Sources
DRA
• DRA client bundle, inspected 23 Nov 2026
• dra2020 GitHub repos, including dra-analytics, block_data and vtd_data
• Painting With Blocks · Exporting Maps · Importing Maps · Using Updated Precincts · Adjusted 2020 Census Data
• DRA Terms of Use, July 2026
Census data
• TIGER2020 TABBLOCK20
• 2020 Block Assignment Files
• 2020 geography tallies
Browser platform
• Chrome content scripts
• chrome.sidePanel
• Service worker lifecycle
• Remote hosted code
• Web Store policies
• WXT entrypoints
• Firefox 128 MV3 updates
• Opera sidebar action API · Opera forum on chrome.sidePanel
• Edge sidebar
• Cloudflare R2 pricing
Algorithm literature
• Dey, Kolay, Singh: Connected Knapsack
• Cohen-Addad, Klein, Young: balanced districting
• King et al.: Geo-graphs
• Buchanan: political districting survey
• Shahmizad and Buchanan
• Karcher v. Daggett