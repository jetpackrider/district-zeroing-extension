# State bundle format, version 1

A bundle lives at `<root>/<STATE>/manifest.json`, where `<STATE>` is the uppercase USPS code. Each referenced name is relative to the manifest directory. County files can be fetched independently.

## Manifest and integrity

The manifest is UTF-8 JSON with the fields of `BundleManifest` in [packages/contracts/src/bundle.ts](../packages/contracts/src/bundle.ts). It also carries a `sources` object with URL or local filename and SHA-256 for each build input. Readers can ignore unfamiliar fields. `format` is 1. `counties` is ordered by ascending five-digit county FIPS.

Each file record provides `file`, `bytes`, and a lowercase hexadecimal `sha256`. Length and hash refer to the **compressed bytes**. The same hash appears in the filename. Filenames are `attrs.<sha256>.bin.gz` and `<countyFips>.<sha256>.topo.json.gz`, plus the optional sidecars `water.<sha256>.bin.gz`, `towns.<sha256>.bin.gz`, `points.<sha256>.bin.gz`, `names.<sha256>.json.gz` and `outlines.<sha256>.json.gz` described at the end. County records also include `fips` and `features`. The manifest is plain text.

## Attributes

Gunzip the file once. The preamble begins at byte 0.

| Byte offset | Field |
| --- | --- |
| 0 | Four literal ASCII bytes `ZDB1` |
| 4 | Unsigned little-endian 32-bit byte length of the JSON header |
| 8 | Header as UTF-8 JSON, exactly the declared number of bytes |

The header contains `n` blocks, `m` directed adjacency entries, `countyFips` (the manifest county order), and `precinctIds` (sorted distinct geographic precinct keys). County FIPS and precinct keys are strings. Each array begins at the next multiple of its element width, measured from byte 0. All alignment bytes are zero. The first array therefore begins at the next multiple of 8 after the JSON. The last array ends at end of file.

All numeric arrays are little-endian. Signed integers use two's complement.

| Order | Width and type | Count | Stored value |
| --- | --- | --- | --- |
| 1 | Uint64 | `n` | Numeric block GEOID differences. First entry is the first GEOID. Prefix-sum from zero and left-pad each decimal result to 15 digits. |
| 2 | Int32 | `n` | Census population (`D20F`). |
| 3 | Int32 | `n` | Prisoner-adjusted population minus Census population. Add to array 2 to recover `D20FA`. Where DRA has no adjusted series, the differences are zero. Adjusted results can be negative. |
| 4 | Uint16 | `n` | Zero-based index into `countyFips`. |
| 5 | Uint32 | `n` | Zero-based index into `precinctIds`. The extension can replace this array with live precinct membership. |
| 6 | Uint32 | `n` | CSR row lengths. Set `offsets[0] = 0` and `offsets[i+1] = offsets[i] + lengths[i]`. `offsets[n] = m`. |
| 7 | Int32 | `m` | For each row `i`, each entry is target index minus `i`. The recovered target indices are strictly ascending within the row. |
| 8 | Uint16 | `m` | Length in meters for the corresponding edge in array 7. |
| 9 | Uint32 | `n` | Length in meters of the block boundary unshared with another in-state block. |
| 10 | IEEE-754 Float32 | `n` | Polygon area in square meters, including land and water. |

Block order is ascending numeric GEOID. Multi-part blocks use a single block index. Both directions of an edge use the same length. Measured lengths use EPSG:5070 and round to nearest meter, ties to even. Positive shared lengths round up to at least 1 and saturate at 65,535. Added non-rook connections use 0 and do not reduce exterior length. DRA's public graph names non-rook links at precinct level. The writer chooses the closest blocks in each pair, with ties broken by block index. The DRA `OUT_OF_STATE` graph sentinel has no in-state block index. Precinct IDs keep their published spelling, including hyphens, periods, and slashes in IDs such as `1100102-005`, `010130014.1`, and `481770004/6`.

## County geometry

Each geometry object is a gzip-compressed UTF-8 [TopoJSON topology](https://github.com/topojson/topojson-specification). Its top-level `objects` has one `GeometryCollection`. Each item is a `Polygon` or `MultiPolygon` and has the 15-digit block GEOID in both its string `id` and `properties.GEOID20`. The collection contains exactly the county’s block GEOIDs. Feature order is immaterial.

The coordinate reference system is WGS84 longitude, latitude. The writer keeps shapes while simplifying at 7% with mapshaper and quantizes each county to 1,000,000 divisions. Arc coordinates are integer deltas. For each arc, start the cumulative x and y at zero, add each delta, then multiply by the corresponding axis in `transform.scale` and add `transform.translate`. A nonnegative reference indexes `arcs` directly. A negative reference `r` uses index `-r-1` and reverses the decoded arc. Join successive arcs in a ring without repeating their shared endpoint. Polygon `arcs` contains rings with the exterior ring first. A MultiPolygon adds an outer array of polygons. The TypeScript reader uses `topojson-client` to produce GeoJSON.

Tiling and simplification happen county by county. The unsimplified TIGER geometry supplies adjacency and lengths. The writer hashes segments in batches of up to 32,768 blocks within each county, then matches remaining segments across batches and county lines using the same statewide projected endpoint keys. New York retains its original aggregation order for byte-for-byte validation.

## Build and validate the states

Run from the repository root with Node, curl, uv, and Python 3.15 available.

```sh
npm ci --prefix pipeline
uv run --project pipeline --locked --python 3.15 python pipeline/build.py all
uv run --project pipeline --locked --python 3.15 python pipeline/build.py all --revalidate
npm ci --prefix packages/bundle
npm --prefix packages/bundle run typecheck
npm --prefix packages/bundle test
```

The `all` command builds and validates states serially. Supply state codes after `all` to run a subset, for example `all FL CA TX`. Resume with the same command. It skips previously validated states after checking their manifest, bundle file hashes and fixture hash against `pipeline/state-results.json`. Use `--revalidate` to rerun the strict checks. For a single state, use `build CA` to rebuild and `validate CA` to audit. The ledger records each state's status and timing. Detailed progress goes to `pipeline/build-all.log`.

Downloads go into `pipeline/cache/`. The source list includes the Census Bureau's January 2023 TABBLOCK20 and 2020 Block Assignment Files, DRA's [public precinct releases](https://github.com/dra2020/vtd_data/tree/adde69e33112bd2c271cafea1357bacf109a9454/2020_VTD), and the block ZIP linked by the [public block catalog](https://github.com/dra2020/block_data/tree/d0e617bd8607bd40be882c344f7b20500ace993b/2020_Geography). The writer reads both population columns from the block ZIP. It downloads only the cataloged block ZIP from the DRA data host and spaces successive requests four seconds apart. Provide a local block CSV or ZIP with `--dra-blocks /path/to/file` for single-state commands. The pinned reference is v08 for the states and v06 for DC.

CA, HI, OR and WV use 12-digit census block groups. Maine uses VTDs where present and county subdivisions for the remaining blocks. Hillsborough and Lee counties in Florida use the maximum-area intersection of each TIGER block with precincts from DRA's public v07 polygons. The v08 precinct populations and graph independently check those assignments.

The build writes a manifest last and saves `data/<STATE>/fixtures/cd119.csv` for each multi-district state. The fixture uses the Census Bureau's state-level 119th Congress block equivalency file when supplied and the national file otherwise. Blocks the Census Bureau marks `ZZ` remain unassigned in the fixture. Strict validation recomputes attributes from source inputs, checks block GEOIDs and totals, precinct IDs and sums, unmatched rook borders, the in-state DRA graph, fixture contents, and each compressed county file's integrity and feature GEOIDs. It reports counts and examples in `data/<STATE>/validation.json` and records the graph's published `OUT_OF_STATE` edges separately.

## Reading and serving the bundle

```ts
import { BrowserBundleSource, geoidIndex, toEngineGraph } from '@zd/bundle';
import { NodeBundleSource } from '@zd/bundle/node';

const local = new NodeBundleSource('/absolute/path/to/data');
const ny = await local.loadState('NY');
const block = geoidIndex(ny, '360010001001000');
const graph = toEngineGraph(ny, 'D20F');
const albany = await local.loadCounty(ny, '36001');

const browser = new BrowserBundleSource('https://bundles.example.org');
const browserNY = await browser.loadState('NY');
```

Browser code imports the browser source from the main entry point or `@zd/bundle/browser`. The browser source checks size and SHA-256 before gunzipping with `DecompressionStream`. It caches compressed verified files in IndexedDB under their versioned filenames. A new source instance revalidates the manifest over HTTP and can reuse cached objects. The application can declare `unlimitedStorage` for the extension's IndexedDB storage.

## R2 publishing

The uploader requires AWS CLI v2 with R2 credentials configured through the normal AWS credential chain. Provide a bucket and account ID as `ZD_R2_BUCKET` and `ZD_R2_ACCOUNT_ID`, or use `--bucket` and `--account-id`.

```sh
uv run --project pipeline --locked --python 3.15 python pipeline/upload_r2.py NY
```

It verifies the manifest references and local SHA-256 hashes, puts the manifest’s versioned objects under the `NY/` prefix with `Cache-Control: public, max-age=31536000, immutable`, and writes `NY/manifest.json` last with `Cache-Control: public, max-age=300, must-revalidate`. Conditional writes preserve existing versioned keys. Use `Content-Type: application/gzip` for compressed payloads and leave the HTTP `Content-Encoding` unset so the browser receives the original bytes. [R2 conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/)

Attach a custom domain to the R2 bucket and allow GET and HEAD from the extension's origin in the CORS policy. Configure the custom domain’s cache rules to honor origin cache durations and serve the data at the browser source base URL. [R2 CORS configuration](https://developers.cloudflare.com/r2/buckets/cors/)

## Water sidecar

`water.<sha256>.bin.gz`, referenced by the optional `water` entry of the manifest (same
`{file, sha256, bytes}` shape as `attrs`). Gunzipped, it is `n` bytes, one per block in GEOID
order: `1` where the block has no land (`ALAND20 == 0` in TABBLOCK20), else `0`.

The adjacency graph crosses open water through these blocks, because DRA does. The engine uses
the flags to prefer moves that hold together over land (`packages/engine/src/land.ts`). A bundle
without the entry still loads; the engine then treats every adjacency alike.

`pipeline/build.py build` writes it, `validate` checks it, and `build.py water [STATE ...]` adds
it to bundles built before it existed without rebuilding anything else.

## Town sidecar

The optional `towns` manifest entry uses the same `file`, `bytes`, and `sha256` fields as `attrs`.
It also gives `count`, the number of represented towns, and `kind`, the selected Census geography.
The gunzipped `towns.<sha256>.bin.gz` contains exactly `n` little-endian Uint32 indices in block
GEOID order. Index 0 means no town. The remaining indices run from 1 to `count` in ascending Census
geography-key order. The reader checks the compressed file against the manifest and validates the
decoded index range and count. Bundles without the entry still load.

- `county-subdivision` is used in CT, MA, ME, MI, MN, NH, NJ, NY, PA, RI, VT and WI. The Census classifies
  these minor civil divisions as general-purpose local governments. The file includes functioning
  subdivisions such as towns and NYC boroughs and represents independent incorporated cities by their
  statewide place ID across county lines. Statistical subdivisions and unorganized territory have index 0.
- `incorporated-place` is used in the other 38 states and DC. It follows Census place IDs for legal
  cities, towns and their equivalents. Census-designated places and blocks outside place boundaries
  have index 0. Hawaii has no Census-recognized incorporated places. DC has a single Washington entry.

Membership comes from the 2020 Census Block Assignment Files. The national 2020 Census Gazetteer
files supply the functional status of each place or subdivision. The manifest records the specific
inputs and their hashes. DRA's public splitting library takes geographic summaries as inputs and
does not prescribe municipal units. [Census geography documentation](https://www2.census.gov/programs-surveys/decennial/2020/technical-documentation/complete-tech-docs/demographic-and-housing-characteristics-file-and-demographic-profile/2020census-demographic-and-housing-characteristics-file-and-demographic-profile-techdoc.pdf)
· [Census Gazetteer](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2020.html)
· [DRA splitting library](https://github.com/dra2020/dra-analytics/blob/main/docs/splitting.md)

`build.py build` writes the sidecar and `build.py validate` checks it alongside geometry and the other
attributes. On existing bundles, `build.py towns [STATE ...]` writes the sidecar and updates the
manifest using the block order from the existing attributes. `build.py validate-towns [STATE ...]`
independently recomputes the sidecar and checks its manifest and hash without reading geometry.
Both commands cover all 51 bundles when passed no state codes.

## Names sidecar

The optional `names` manifest entry references `names.<sha256>.json.gz` using the same file
record as `attrs`. The gunzipped UTF-8 JSON object contains `counties` and `towns` string arrays.
`counties[i]` names county index `i` in the attributes header's `countyFips` order.
`towns[t]` names town index `t` from the towns sidecar. It has `manifest.towns.count + 1`
entries, with `towns[0] = ""` for blocks outside towns. With no towns, the array is `[""]`.
All other names are non-empty. Duplicate town names can occur and keep their separate indexes.

County names come from the 2020 Census county gazetteer's `NAME` column (the full name including
the legal designation, for example “Suffolk County”). Town labels come from the same place or
county-subdivision gazetteer records and index assignment as the towns sidecar.

`build.py build` writes the file and `build.py validate` recomputes and checks it. On existing
bundles, `build.py names [STATE ...]` adds the file and its manifest entry.
`build.py validate-names [STATE ...]` verifies the names and their index order without loading
geometry. Both commands cover all 51 bundles when passed no state codes.

## Points sidecar

`points.<sha256>.bin.gz`, referenced by the optional `points` entry of the manifest (same
`{file, sha256, bytes}` shape as `attrs`). Gunzipped, it is exactly `8 * n` bytes: `2 * n`
little-endian signed Int32 values in block GEOID order, longitude then latitude for each block
(`lon0, lat0, lon1, lat1, ...`), in millionths of a degree. Block `i`'s point is at
`points[2i] / 1e6, points[2i + 1] / 1e6`.

The point is the block's Census internal point, `INTPTLON20` / `INTPTLAT20` in TABBLOCK20. The
Census places it inside the block polygon (at the centroid when that is inside, otherwise at another
interior point). The published seven-decimal values are rounded exactly, half to even, to six
decimals (about 11 cm). Coordinates are NAD83 like the TIGER polygons, which differs from WGS84 by
a meter or two at most. Alaska's Aleutian blocks west of the antimeridian have positive longitudes.

The extension tests these points against an area the user marks on DRA's map, to tell which blocks
are inside without loading block shapes. The reader (`decodePoints` in `packages/bundle`) checks the
compressed file against the manifest, the exact length, and that every value is a real longitude
(within ±180,000,000) or latitude (within ±90,000,000), and sets `StateBundle.points`. Bundles
without the entry still load; the bundle then has no `points`. Like the other sidecars the file is
optional, so one that cannot be read (wrong hash, bad contents) does not fail the state: it loads
without `points`, with a warning. By default `loadState` reads the file with the state; a reader made
with `{ points: 'on-demand' }` leaves it to `loadPoints(bundle)`. The extension reads it on demand,
when an area first needs it, so a state with no area loads exactly as before.

`pipeline/build.py build` writes it and `validate` checks it. On existing bundles,
`build.py points [STATE ...]` adds it (block order from the existing attributes, which must match
TIGER's sorted GEOIDs) and names it in the manifest once its checks pass, and
`build.py validate-points [STATE ...]` checks it without writing. Both cover all 51 bundles when
passed no state codes and read only the cached TABBLOCK20 ZIPs and the bundle. The checks: the
manifest entry, size and SHA-256; the exact length; every value equal to the TIGER internal point;
every point inside its county's bounding box from the county geometry file, widened by 0.02°; and,
for a fixed sample of 2,000 blocks per state, the point inside the block's unsimplified TIGER
polygon (allowing only the rounding) and inside its simplified polygon in the county geometry file
for at least 90% of the sample, with none more than 2 km away. Simplification shaves thin and coastal
blocks, so across the 51 states up to 5.5% of sampled points lie just outside the simplified shape,
at most 1.2 km away (Alaska); a wrong block order, swapped axes or wrong units put nearly all of them
far outside. The 51 files total 46.3 MiB compressed, about 6 bytes per block (New York 1.7 MB, Texas
4.0 MB).

## Outlines sidecar

`outlines.<sha256>.json.gz`, referenced by the optional `outlines` entry of the manifest (same
`{file, sha256, bytes}` shape as `attrs`). Gunzipped, it is a compact UTF-8 GeoJSON
`FeatureCollection` in WGS84 longitude/latitude with exactly one feature per county, in county
index order: `features[i]` has `id: i` (a number, the index in the attributes header's `countyFips`)
and `properties: {"fips": countyFips[i]}`, and its geometry is a `Polygon` or `MultiPolygon`.
Coordinates have at most five decimals (about 1 m). Ring winding is not specified (map renderers
accept either).

It is for drawing counties and groups of counties (the county cluster finder) on DRA's map without
loading every county's block geometry. Each outline is the county's land blocks (ALAND20 > 0)
dissolved into one shape. Holes in that land that no other county's land reaches into, which are
lakes and ponds of water-only blocks, are filled; a hole that is another county (an independent
city inside a Virginia county) stays open. Water-only blocks outside the land (open sea, the Great
Lakes, a river along a county line) are not part of any outline, so a river county line shows as a
narrow gap. The whole state is then simplified in one mapshaper dataset with Douglas-Peucker at
50 m on the sphere, so a border two counties share is one arc, simplified and rounded once, and the
two outlines keep identical edges there. The tolerance doubles (100 m, then 200 m) only when the
file would exceed 1,000,000 bytes compressed: Alaska's coast uses 100 m, every other state 50 m.
Rings that rounding makes touch or cross themselves are rebuilt and snapped to the same grid.
Outlines are for display; contiguity and populations come from the attributes, not from them.

The reader (`decodeOutlines` in `packages/bundle`) checks the feature count, each feature's `id`
and `fips` against the bundle's counties, the geometry type, closed rings of at least four
positions, and longitude/latitude ranges. Nothing reads the file with the state: `loadOutlines(bundle)`
on `BrowserBundleSource` or `NodeBundleSource` reads it when first asked, verifies size and SHA-256,
caches it (IndexedDB in the browser, under its versioned name, like the other files), and returns the
`CountyOutlines` collection, or `undefined` when the manifest has no entry. A failed read rejects and
the next call tries again; the state itself is unaffected.

`build.py build` writes it from the TIGER blocks it already holds and `build.py validate` rebuilds it
and requires the identical file. On existing bundles, `build.py outlines [STATE ...]` reads the cached
TABBLOCK20 ZIP (block order and water flags must match the bundle), writes the file and names it in
the manifest once its checks pass, and `build.py validate-outlines [STATE ...]` checks the file
without TIGER or mapshaper. Both cover all 51 bundles when passed no state codes. The checks: the
manifest entry, size and SHA-256; one feature per county with matching `id` and `fips`; valid,
non-empty polygons with five-decimal coordinates in range; each outline's area (EPSG:5070, as
`areaM2`) between the sum of its land blocks' `areaM2` and that plus its water-only blocks' area,
with 3% or 2 km² of slack for simplification; and neighbors overlapping by at most 1e-4 of the
state's area (the sum of the outline areas minus the area of their union). Across the 51 states the
worst county is 0.75% from its land area (Lexington city, Virginia), filled lakes add at most 1.9%
of a state's land area (Maine), and the largest overlap is 3e-9 of a state (Texas). The 51 files
total 9.2 MB compressed: Alaska 734 KB, Texas 664 KB (254 counties), Virginia 423 KB, New York
171 KB, the median about 150 KB.
