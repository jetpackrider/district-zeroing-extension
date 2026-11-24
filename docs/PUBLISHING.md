# Publishing (SPEC Phase 9)

Text and answers for the store listings. Nothing here has been submitted, and DRA has not been contacted.

## Before the first release

1. Run the live checks in `RECON.md` on davesredistricting.org and fix whatever they turn up.
2. Email DRA (draft below) and wait for a reply. Their Terms of Use bar automated access and derivative use; this extension only paints when the user switches that option on and clicks for each step, but it is their call. SPEC.md still describes the original read-only design.
3. Put the data bundles on Cloudflare R2 behind a custom domain (`pipeline/upload_r2.py`, not yet run) and build with `ZD_DATA_URL` set to it.
4. Decide the mini-map tile source (see "Open decisions").
5. Fill in the placeholders marked `TODO` below.

## Privacy policy

> Zero Deviation reads the district plan you have open on davesredistricting.org and works out which census blocks to move. All of that happens inside your browser. Your plan, your district assignments and your account details are never sent to us or to anyone else, and the extension has no analytics, no tracking and no accounts. It makes two kinds of network request of its own. It downloads public census data files for the state you are working on from our data host (TODO: domain), which tells that host which state you asked for and nothing about your plan. And if it cannot draw on DRA's own map, it shows a small fallback map whose background tiles come from OpenStreetMap, which tells OpenStreetMap's servers which area the map is showing. The extension stores the downloaded data files and a few settings on your device; removing the extension removes them. Contact: TODO.

## Store listing

**Name:** Zero Deviation for Dave's Redistricting (TODO: confirm name; check DRA is comfortable with their name in it)

**Short description (132 characters max on the Chrome Web Store):**
Finds the census blocks that bring a district, a group, or a whole map to zero deviation in Dave's Redistricting, and walks you there.

**Description:**

Getting the last few people out of a district in Dave's Redistricting means hunting along the border for blocks that add up to exactly the right number without cutting anything off. This extension does the hunting.

Open a map on davesredistricting.org and open the side panel. Pick one district, a group of districts, or the whole map. The extension reads your plan as it is right now, including edits you have not committed, and offers ranked ways to reach zero: how many people and blocks move, how many precincts and counties get split, and what happens to each neighbor. Pick one and it walks you through it precinct by precinct, highlighting the blocks on DRA's own map and ticking each one off as you paint it. If you prefer, an optional setting paints the current step for you when you click.

- You paint. The extension does not change your map unless you turn on "Paint steps for me", and then only one step each time you click the button.
- Zero means zero: every district ends at the ideal population, or one person off when the state does not divide evenly.
- Districts stay in one piece. Every suggestion is checked for contiguity on both sides.
- Where a small number cannot be moved one way, it trades across the border in both directions.
- Your plan never leaves your browser.

Works on maps drawn on 2020 census shapes with single-member, equal-population districts. Not affiliated with Dave's Redistricting.

Data: contains data adapted from Dave's Redistricting (github.com/dra2020), CC BY-SA 4.0. Census data is from the U.S. Census Bureau and is in the public domain. The data files this extension downloads are shared under CC BY-SA 4.0.

**Category:** Productivity / Developer tools (whichever the store offers).

## Permission justifications

| Permission | Why |
|---|---|
| `https://davesredistricting.org/*` | Read the plan from the open map and draw highlights on it. |
| `sidePanel` | The panel that lists options and steps. |
| `storage` | A few settings. |
| `unlimitedStorage` | Cache the per-state census data files (tens of MB per state) so they download once. |

Single purpose: help balance district populations in Dave's Redistricting. No remote code: the extension downloads data files only.

## Data disclosure answers

- Collects or transmits user data: **no**. The plan being drawn counts as user data under the Web Store rules, and it stays on the device.
- Sold or transferred to third parties: **no**.
- Used for purposes unrelated to the single purpose: **no**.
- Firefox, when that build exists: declare `data_collection_permissions` as none required.

## Draft email to DRA (feedback@davesredistricting.org)

> Subject: A read-only helper extension for zeroing deviations: checking with you before release
>
> Hi,
>
> I've built a free browser extension for people drawing maps in DRA. It reads the plan from the open map tab, finds the census blocks along district borders that bring a district, a group, or a whole map to zero deviation, and walks the user through painting them by hand. It never calls your API and sends nothing about the plan anywhere; everything runs in the user's browser. By default the user paints by hand. An optional setting, off by default, paints one walkthrough step per click through the page's own paint actions (`actionSetFeatureDistricts` and `actionSetBlockDistricts`), so the edit is recorded, undoable and synced by your own code exactly as a hand-painted one is.
>
> It uses your block_data and vtd_data from GitHub under CC BY-SA 4.0, with credit, and I'm sharing the derived data files under the same license. It is free and will stay free.
>
> Two things I'd like to check with you before I publish it:
>
> 1. Your Terms of Use bar automated access and derivative use. I read the extension as an aid to a person using your site by hand, with every edit started by that person's click, but I'd rather ask than assume. Are you comfortable with it, including the optional paint button?
> 2. It reads the plan from `window.dra` on the page, which I know isn't a supported interface and can change at any time. If there's a steadier way to read the current block assignment and to draw a highlight layer, I'd gladly use it.
>
> Happy to send a build or a short screen recording.
>
> Thanks,
> TODO

## Open decisions

- **Data host domain.** R2 behind a custom domain; the spec rules out `r2.dev`.
- **Mini-map tiles.** The fallback mini-map uses `tile.openstreetmap.org` by default (overridable through the `miniMapTiles` setting). OpenStreetMap's tile servers are not meant for distributed apps at scale and need visible attribution. Before publishing, either move to a tile provider you have an account with or drop the basemap and draw the blocks alone. The privacy policy above discloses the current behavior and must change with it.
- **Listing visibility.** Public or unlisted; either way store installs update on their own, which matters when a DRA change breaks the page hook.
