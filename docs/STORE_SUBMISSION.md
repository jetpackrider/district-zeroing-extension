# Chrome Web Store submission sheet

Everything to paste into the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), in the order the dashboard asks for it. Images are in [`docs/store`](store).

## 1. Package

Build and zip from `apps/extension`:

```bash
npm run build && npx wxt zip
```

Upload `apps/extension/.output/zdextension-<version>-chrome.zip` with **Add new item**. The name, summary, icon and version come from the package.

## 2. Store listing

**Description**

```text
Getting the last few people out of a district in Dave's Redistricting means hunting along the border for blocks that add up to exactly the right number, without cutting anything off. Zero Deviation does the hunting.

Open a map on davesredistricting.org and open the side panel. Pick one district, a group of districts, or the whole map. The extension reads your plan as it is right now, including edits you have not committed, and offers ranked ways to reach zero. Each option says what it costs before you start: how many people and blocks move, how many steps there are to paint, and how many precincts, counties and towns get split.

Pick one and it walks you through it precinct by precinct, numbering the blocks on DRA's own map and ticking each one off as you paint it. If you prefer, an optional setting paints the current step for you when you click.

• Zero means zero: every district ends at the ideal population, or one person above it when the state does not divide evenly.
• Districts stay in one piece. Every suggestion is checked for contiguity on both sides.
• Land first: districts that touch on land never trade across water.
• Compact moves: blocks close to the border, never a chain of empty blocks reaching for distant population.
• Small numbers still work: where a border cannot move a few people one way, it trades in both directions.
• Lock finished districts and no suggestion touches them.
• You stay in control. Nothing on your map changes unless you paint it, or turn on "Paint steps for me" and click its button, one step per click.
• Your plan never leaves your browser.

Works on maps drawn on 2020 census shapes with single-member, equal-population districts, for all 50 states and DC.

Not affiliated with or endorsed by Dave's Redistricting.

Data: contains data adapted from Dave's Redistricting (github.com/dra2020), CC BY-SA 4.0. Census data is from the U.S. Census Bureau and is in the public domain.
```

| Field | Value |
|---|---|
| Category | Tools (under Productivity), or the closest the dashboard offers |
| Language | English |
| Store icon | comes from the package; `apps/extension/public/icon/128.png` if asked |
| Screenshots | `docs/store/screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png` (1280×800) |
| Small promo tile | `docs/store/promo-small.png` (440×280) |
| Marquee promo tile | `docs/store/promo-marquee.png` (1400×560), optional |
| Homepage URL | `https://github.com/jetpackrider/district-zeroing-extension` |
| Support URL | `https://github.com/jetpackrider/district-zeroing-extension/issues` |
| Mature content | No |

## 3. Privacy practices

**Single purpose**

```text
Helps people balance district populations in Dave's Redistricting: it finds which census blocks to move so districts reach zero population deviation, and guides the user through painting them.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `sidePanel` | The extension's whole interface is a side panel next to the map: the district list, the ranked options and the step-by-step walkthrough. |
| `storage` | Saves a few settings on the device: whether "Paint steps for me" is on, and which districts the user locked. |
| `unlimitedStorage` | Caches the public census data files for each state the user works on (up to 47 MB for the largest state) so they download once instead of on every use. |
| Host permission `https://davesredistricting.org/*` | Reads the district plan from the map the user has open and draws highlight layers on that map. With the optional "Paint steps for me" setting on, paints one walkthrough step per user click through the page's own paint tools. The extension runs on no other site. |

**Remote code:** No, I am not using remote code. (The extension downloads data files only: populations, block shapes and adjacency. No scripts.)

**Data usage:** tick none of the data types. The plan is read and processed on the device and is never transmitted. Tick all three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL**

```text
https://github.com/jetpackrider/district-zeroing-extension/blob/main/PRIVACY.md
```

## 4. Distribution

| Field | Value |
|---|---|
| Payments | Free of charge |
| Visibility | **Unlisted** (switch to Public later from the same page) |
| Regions | All regions |

## 5. Test instructions for the reviewer

Leave the username and password empty. The instructions field holds 500 characters:

```text
The extension has no login. It works on https://davesredistricting.org, which needs a free account.
1. Sign in there and open or create any congressional map on 2020 shapes.
2. Reload the tab once, then click the extension's toolbar button to open the side panel.
3. Choose "One district" or "Whole map" and click the button to find options.
4. Click "Walkthrough" on an option: the blocks to paint are highlighted on the map.
First use of a state downloads its data from jetpackrider.github.io.
```

## 6. Account

- Publisher display name: `jetpackrider` (it defaults to the account's email address and is shown on the listing).
- Trader declaration: **non-trader**.
- A contact email must be added and verified on the Settings page before anything can be published. It is displayed publicly with the item.

## After it is approved

Add the store link to the README's "Build it" section, and update `docs/PUBLISHING.md`.

# Opera add-ons

Upload `zdextension-<version>-opera.zip` (`npm run build:opera && npx wxt zip -b opera` in `apps/extension`) at [addons.opera.com/developer](https://addons.opera.com/developer/). Delete the `-sources.zip` that `wxt zip` also writes: it holds only `apps/extension`, not the whole project.

- **General (package):** category Productivity; tick "Hide the add-on from search results" for an unlisted release; leave auto-publishing off.
- **Version, General tab:** support URL and public source URL as for Chrome; moderator source URL `https://github.com/jetpackrider/district-zeroing-extension/tree/v<version>` (tag the release first); build instructions are the commands above plus the Node and npm versions used; license URL `.../blob/main/LICENSE`; privacy policy URL as for Chrome. A clean build from the tag reproduces the package file for file, which the moderators can check.
- **Translations tab:** the Chrome description, with "side panel" read as "sidebar"; changelog.
- **Media tab:** the three screenshots, and `docs/store/icon-64.png` (`node scripts/make-icons.mjs --opera`).
- **Submit changes** on the version's General tab sends it to the moderators. Nothing is saved until then.
