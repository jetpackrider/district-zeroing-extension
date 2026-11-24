# Publishing

Where publishing stands. The text and images to paste into the Chrome Web Store are in [STORE_SUBMISSION.md](STORE_SUBMISSION.md); the privacy policy is [PRIVACY.md](../PRIVACY.md).

## Decided

- **Name:** Zero Deviation. Dave's Redistricting is named in the summary and description, with a "not affiliated" line.
- **Data host:** GitHub Pages, from the [zero-deviation-data](https://github.com/jetpackrider/zero-deviation-data) repo, at `https://jetpackrider.github.io/zero-deviation-data/v1`. It is the store build's default; `ZD_DATA_URL` overrides it at build time. To republish after a pipeline run: `uv run publish_pages.py <checkout of that repo>` in `pipeline/`, then commit and push there. `HOSTED=1 npx playwright test zz-hosted-data zz-store-build` in `apps/extension` checks the host and the store build against it.
- **Mini-map tiles:** none by default. The fallback mini-map draws blocks on a plain background, so the extension contacts no third party. A basemap is opt-in through the `miniMapTiles` setting.
- **First listing:** unlisted, non-trader account, "Paint steps for me" included (off by default).
- **Code license:** PolyForm Noncommercial 1.0.0. Data: CC BY-SA 4.0.

## Still open

1. **DRA has not been asked.** Their Terms of Use bar automated access and derivative use. The extension paints only when the user turns that option on and clicks for each step, but it is their call. The draft below is ready to send; the listing stays unlisted until this is settled.
2. **Live checks.** `RECON.md` lists the checks to run on davesredistricting.org; so far the extension has been used by hand on New York maps only.
3. **GitHub Pages limits.** Pages is meant for sites under 1 GB with about 100 GB of traffic a month. The data is 586 MB in all; a first use downloads up to 12 MB and at most 47 MB for a whole state, so this holds for a few thousand first-time downloads a month. Past that, move the files to object storage (`pipeline/upload_r2.py` targets Cloudflare R2) and change the build's default URL.
4. **Other stores.** Edge, Opera and Firefox builds are not prepared. Firefox would need `data_collection_permissions` declared as none.

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
