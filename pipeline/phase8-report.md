# Phase 8 data and whole-map report

All 50 states and DC passed strict validation. The 51 bundles cover 8,132,968 blocks. There are 44 congressional fixtures and one Pennsylvania House fixture. Active compressed bundle files total 585.47 MiB. On-disk usage is 736.27 MiB for data and 10.38 GiB for the cache, which retains all 51 DRA block archives.

New York was revalidated without a rebuild. All 65 original hashes matched, including the manifest, attributes, 62 county files and CD119 fixture. Its validation report was refreshed.

The state table uses compressed attributes plus compressed county geometry for bundle size. It excludes manifests, audit JSON, and fixtures. Build time is elapsed wall time from the state process. The inputs were prefetched, so almost all builds used the local archive cache.

## State results

| State | Blocks | Precinct kind | Adjusted column | Validation | Bundle (MiB) | Build (s) |
| --- | ---: | --- | --- | --- | ---: | ---: |
| AK | 28,568 | VTD | No | Passed | 3.02 | 15.8 |
| AL | 185,976 | VTD | No | Passed | 13.89 | 40.7 |
| AR | 136,422 | VTD | No | Passed | 10.53 | 30.4 |
| AZ | 155,444 | VTD | No | Passed | 10.91 | 28.0 |
| CA | 519,723 | Block group | Yes | Passed | 35.70 | 91.0 |
| CO | 140,345 | VTD | Yes | Passed | 10.38 | 28.3 |
| CT | 49,926 | VTD | Yes | Passed | 3.66 | 13.9 |
| DC | 6,012 | VTD | No | Passed | 0.37 | 1.3 |
| DE | 20,198 | VTD | No | Passed | 1.40 | 4.1 |
| FL | 390,066 | VTD | No | Passed | 25.68 | 82.9 |
| GA | 232,717 | VTD | No | Passed | 17.50 | 47.3 |
| HI | 14,732 | Block group | No | Passed | 1.06 | 14.6 |
| IA | 175,199 | VTD | No | Passed | 11.44 | 28.6 |
| ID | 81,879 | VTD | No | Passed | 7.00 | 20.5 |
| IL | 369,978 | VTD | No | Passed | 23.47 | 54.3 |
| IN | 204,568 | VTD | No | Passed | 13.73 | 29.0 |
| KS | 172,529 | VTD | No | Passed | 11.15 | 26.7 |
| KY | 132,662 | VTD | No | Passed | 11.21 | 33.1 |
| LA | 142,874 | VTD | No | Passed | 10.41 | 38.7 |
| MA | 107,278 | VTD | No | Passed | 7.46 | 23.5 |
| MD | 83,827 | VTD | Yes | Passed | 6.16 | 18.2 |
| ME | 47,138 | VTD + subdivision | No | Passed | 4.02 | 15.2 |
| MI | 254,730 | VTD | No | Passed | 16.93 | 50.2 |
| MN | 198,705 | VTD | No | Passed | 13.92 | 48.9 |
| MO | 253,632 | VTD | No | Passed | 18.62 | 52.9 |
| MS | 112,241 | VTD | No | Passed | 8.92 | 20.2 |
| MT | 88,417 | VTD | Yes | Passed | 7.68 | 27.1 |
| NC | 236,638 | VTD | No | Passed | 18.09 | 43.4 |
| ND | 84,566 | VTD | No | Passed | 5.54 | 11.9 |
| NE | 119,103 | VTD | No | Passed | 7.55 | 14.7 |
| NH | 31,948 | VTD | No | Passed | 2.43 | 5.4 |
| NJ | 137,972 | VTD | Yes | Passed | 9.41 | 17.6 |
| NM | 107,215 | VTD | No | Passed | 8.14 | 22.8 |
| NV | 57,409 | VTD | Yes | Passed | 4.56 | 12.1 |
| NY | 288,819 | VTD | Yes | Passed | 20.26 | Reused |
| OH | 276,428 | VTD | No | Passed | 19.03 | 36.8 |
| OK | 180,154 | VTD | No | Passed | 12.05 | 25.1 |
| OR | 130,807 | Block group | No | Passed | 10.76 | 38.2 |
| PA | 336,985 | VTD | Yes | Passed | 23.90 | 65.2 |
| RI | 25,649 | VTD | No | Passed | 1.82 | 4.8 |
| SC | 146,844 | VTD | No | Passed | 10.96 | 25.8 |
| SD | 71,383 | VTD | No | Passed | 5.01 | 10.7 |
| TN | 179,717 | VTD | No | Passed | 14.40 | 36.7 |
| TX | 668,757 | VTD | No | Passed | 46.68 | 187.3 |
| UT | 71,207 | VTD | No | Passed | 5.98 | 20.1 |
| VA | 163,491 | VTD | Yes | Passed | 13.55 | 75.9 |
| VT | 24,611 | VTD | No | Passed | 2.12 | 6.7 |
| WA | 158,093 | VTD | Yes | Passed | 11.11 | 35.6 |
| WI | 203,059 | VTD | No | Passed | 14.76 | 37.2 |
| WV | 72,558 | Block group | No | Passed | 6.38 | 29.8 |
| WY | 53,769 | VTD | No | Passed | 4.75 | 23.5 |

The state ledger is `pipeline/state-results.json`. Detailed validation reports are under `data/<STATE>/validation.json`.

## State-specific data

- The public data uses 12-digit block groups in California (25,607 precincts), Hawaii (1,083), Oregon (2,970), and West Virginia (1,639). Census BAFs for CA, HI, and OR lack a VTD member. West Virginia's BAF does have one, with 1,064 VTDs. DRA's West Virginia IDs, population sums, and graph match block groups.
- Maine has 199 Census VTDs covering 18,140 blocks. DRA uses 392 county subdivisions for the 28,998 blocks with an empty VTD assignment. The resulting 591 precinct IDs, populations, and in-state edges match DRA.
- Florida replaced 45 Census VTD IDs with 81 suffixed IDs across Hillsborough and Lee counties. The block-to-precinct overlay uses maximum polygon overlap with DRA's public v07 precinct shapes. The v07 and v08 precinct graphs are identical. Relative to the BAF, the overlay changed 2,097 block keys in Hillsborough and 2,435 in Lee, including 47 and two blocks that moved to a different parent VTD. V08 independently matched all 7,247 precinct IDs and population sums, and every in-state edge.
- DRA publishes an adjusted total in both block and precinct files for CA, CO, CT, MD, MT, NV, NJ, NY, PA, VA, and WA. Montana has the column and Delaware's public v08 files omit it. The static files establish column availability for CO, CT, and NY. Live map-type selection of the population field remains untested.
- DC uses public v06 demographics. Its public v06 and v07 graphs have identical keys and edges. DRA keys in the real bundles include hyphens, periods, and slashes.
- The Census 119th Congress BEF marks 81 Connecticut blocks, 72 Illinois blocks, and three New Hampshire blocks `ZZ` for unassigned. All have zero Census population and are left out of the fixture rows. [Census 119th Congress block equivalency files](https://www.census.gov/geographies/mapping-files/2025/dec/rdo/119-congressional-district-bef.html)

| State | D20F | D20FA | Blocks adjusted |
| --- | ---: | ---: | ---: |
| CA | 39,538,223 | 39,523,437 | 81,597 |
| CO | 5,773,714 | 5,773,714 | 9,980 |
| CT | 3,605,944 | 3,603,566 | 5,883 |
| MD | 6,177,224 | 6,175,403 | 9,684 |
| MT | 1,084,225 | 1,082,717 | 1,081 |
| NJ | 9,288,994 | 9,283,016 | 10,462 |
| NV | 3,104,614 | 3,104,614 | 3,963 |
| NY | 20,201,249 | 20,193,858 | 23,261 |
| PA | 13,002,700 | 13,002,700 | 21,173 |
| VA | 8,631,393 | 8,631,393 | 24,138 |
| WA | 7,705,281 | 7,705,281 | 9,743 |

## Large-state memory

The pipeline processes one state at a time. It projects blocks in bounded chunks, hashes unsimplified TIGER segments in county batches of at most 32,768 blocks, and reconciles unpaired segments across county and batch boundaries. The largest three builds used TIGER TABBLOCK20 polygons. A single heap-capped Mapshaper worker processed each county separately. The sum of the separately observed Python and child peaks is a conservative build bound.

| State | Python build peak (GiB) | Child build peak (GiB) | Build bound (GiB) | Python validation peak (GiB) |
| --- | ---: | ---: | ---: | ---: |
| CA | 1.60 | 0.54 | 2.14 | 1.48 |
| TX | 1.74 | 0.36 | 2.10 | 1.65 |
| FL | 1.12 | 0.31 | 1.43 | 1.24 |

The partitioned and original statewide hashing agreed on every rook pair, rounded shared length, and rounded exterior length for Maine and Rhode Island. The independent topology audit returned the same corner and missed-line counts as the prior implementation on Rhode Island and West Virginia.

## Whole-map checks

The benchmark used the existing New York perturbation helper with four populated border-block moves into each odd-numbered district and seed 1. Each plan was checked with the planner verifier and by applying the moves and counting the districts at an allowed target. The timing column covers the planner call itself.

| Scenario | Districts | Population | Verified plans | Planner time | Peak Node RSS |
| --- | ---: | --- | ---: | ---: | ---: |
| CA Congress | 52 | D20FA | 3 | 15.926 s | 354 MiB |
| TX Congress | 38 | D20F | 3 | 23.758 s | 414 MiB |
| FL Congress | 28 | D20F | 3 | 6.458 s | 406 MiB |
| PA Congress | 17 | D20F | 3 | 2.903 s | 354 MiB |
| HI Congress | 2 | D20F | 1 | 0.062 s | 109 MiB |
| ME Congress | 2 | D20F | 1 | 0.482 s | 186 MiB |
| RI Congress | 2 | D20F | 2 | 0.242 s | 131 MiB |
| PA 2022 House | 203 | D20FA | 0 | 76.200 s | 306 MiB |
| CA Congress, Census comparison | 52 | D20F | 3 | 342.074 s | 363 MiB |

Pennsylvania's 203-seat House was the largest single-member lower house with an enacted plan used here. New Hampshire's 400 seats include multi-member and floterial districts. For PA, the Census tabulation plan assigns the entirety of split Philadelphia block `421010257002008` to District 194. The House run took 77.9 seconds end to end. The perturbed map's largest deviation was 3,094. The planner exhausted its retries. Its closest reported attempt left District 61 at 26 people over the allowed range. [Pennsylvania Constitution](https://www.legis.state.pa.us/WU01/LI/LI/CT/HTM/00/00.HTM), [Census 2022 legislative BEFs](https://www.census.gov/geographies/mapping-files/2023/dec/rdo/2022-state-legislative-bef.html), [Census split-block listing](https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2023/2022-state-legislative-bef/2022_SLDL_BlockSplits.pdf)

Using raw Census counts for California raised the perturbed maximum deviation from 3,355 to 21,810. Both runs verified all 52 districts in all three returned plans.

## Reproduce

Run from the repository root.

```sh
npm ci --prefix pipeline
uv run --project pipeline --locked --python 3.15 python pipeline/build.py all
uv run --project pipeline --locked --python 3.15 python pipeline/build.py all --revalidate
npm ci --prefix packages/bundle
npm --prefix packages/bundle run typecheck
npm --prefix packages/bundle test
npm ci --prefix packages/engine
npm ci --prefix packages/planner
uv run --project pipeline --locked --python 3.15 python pipeline/state_house_fixture.py
sh packages/planner/scripts/phase8-real.sh CA TX FL PA HI ME RI
sh packages/planner/scripts/phase8-real.sh PA-house
sh packages/planner/scripts/phase8-real.sh CA-census
```

The resumable `all` command also accepts a list of state codes. For a single state's forced rebuild and independent audit, use `build STATE` and `validate STATE`. To force a rebuild of all existing state directories from cached inputs, run the following.

```sh
for state_dir in data/[A-Z][A-Z]
do
  uv run --project pipeline --locked --python 3.15 python pipeline/build.py build "${state_dir##*/}" || break
done
uv run --project pipeline --locked --python 3.15 python pipeline/build.py all --revalidate
```

There is no required contract or version-1 wire-format change. The contract comments could clarify that `vtd` covers Maine's VTD/county subdivision mix and that precinct IDs are opaque strings with published punctuation.

## Verification

I ran the independent validator for every state, checked all 51 validation reports and all 44 congressional fixture row counts, and ran the resumable command again. It found 51 already-validated bundles. The bundle package typecheck and all eight tests passed, including a read of all 51 attributes files through the TypeScript decoder and real county geometry tests for DC, Hawaii, and New York. The data build and validation log is `pipeline/build-all.log`. Benchmark output is in `pipeline/engine-real.log`, `pipeline/engine-ca-adjusted.log`, `pipeline/engine-tx.log`, and `pipeline/engine-fl.log`.

The Pennsylvania House case still returns no verified plan. Live DRA map-specific population selection and browser extension integration remain untested in this run.
