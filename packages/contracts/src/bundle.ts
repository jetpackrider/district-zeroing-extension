/**
 * Decoded per-state data bundle (SPEC.md "Data pipeline" / "Bundle format").
 *
 * The on-disk binary layout is owned by `pipeline/` (writer) and `packages/bundle`
 * (reader) and documented in docs/BUNDLE_FORMAT.md. Everything else in the repo
 * only sees these in-memory types.
 *
 * A block's index is its position in `geoids`, which is sorted ascending. Every
 * per-block array has length `n` and is indexed by that position.
 */

/** DRA population dataset keys: 2020 Census total, and prisoner-adjusted total. */
export type PopField = 'D20F' | 'D20FA';

export interface BundleFileRef {
  /** File name relative to the manifest, versioned (immutable). */
  file: string;
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  format: number;
  /** USPS code, e.g. "NY". */
  state: string;
  /** 2-digit state FIPS, e.g. "36". */
  stateFips: string;
  censusVintage: string;
  /** DRA data version the populations and precinct IDs were checked against, e.g. "v08". */
  draDataVersion: string;
  /** "vtd" for most states, "bg" for block-group states (CA, HI, OR, WV). */
  precinctKind: 'vtd' | 'bg';
  /** CC BY-SA 4.0 credit line for DRA data; shown in the About screen. */
  attribution: string;
  attrs: BundleFileRef;
  /** Optional sidecar: one byte per block, 1 where the block has no land (ALAND20 == 0). */
  water?: BundleFileRef;
  /**
   * Optional sidecar: the town each block belongs to (0 = none), plus how many towns there are
   * and which Census geography they come from in this state.
   */
  towns?: BundleFileRef & { count: number; kind: string };
  /**
   * Optional sidecar `points.<sha256>.bin.gz`: one point inside each block (the Census internal
   * point, INTPTLON20 / INTPTLAT20), as 2·n little-endian Int32 in block order: longitude then
   * latitude, in millionths of a degree. Lets the extension tell which blocks fall in an area the
   * user marks on the map without loading block shapes.
   */
  points?: BundleFileRef;
  /**
   * Optional sidecar `names.<sha256>.json.gz`: gzipped JSON { counties: string[], towns: string[] }.
   * counties[i] names county index i (same order as StateBundle.countyFips), e.g. "Suffolk
   * County"; towns[t] names town index t (towns[0] = "" for "in no town"), e.g. "Huntington town".
   * Census names (TIGER / gazetteer NAMELSAD). Lets the panel offer a county or town as an area.
   */
  names?: BundleFileRef;
  /**
   * Optional sidecar `outlines.<sha256>.json.gz`: gzipped GeoJSON FeatureCollection, one feature
   * per county (feature `id` = county index, properties.fips), the county's outline dissolved
   * from its blocks and simplified (~50 m tolerance) for drawing on the map. Small: drawing
   * county clusters must not need every county's block geometry.
   */
  outlines?: BundleFileRef;
  /** One geometry file per county, keyed by 5-digit county FIPS. */
  counties: Array<BundleFileRef & { fips: string; features: number }>;
}

export interface StateBundle {
  manifest: BundleManifest;
  /** Number of blocks. */
  n: number;
  /** 15-digit block GEOID20, sorted ascending. */
  geoids: string[];
  /** Both population columns. D20FA equals D20F where DRA has no adjusted data. */
  pop: Record<PopField, Int32Array>;
  /** 5-digit county FIPS per county index. */
  countyFips: string[];
  countyOf: Uint16Array;
  /**
   * DRA precinct IDs (as used by fullBlockMap / vtd_data) per precinct index, and
   * the bundle's default block→precinct membership. The live DRA blockMapping
   * overrides `precinctOf` when the user has "updated precincts" on.
   */
  precinctIds: string[];
  precinctOf: Uint32Array;
  /**
   * Rook adjacency in CSR form. Neighbors of block i are
   * adjTargets[adjOffsets[i] .. adjOffsets[i+1]). Symmetric. Includes water blocks
   * as zero-population nodes, DRA's manual links, and nearest-block bridges for
   * blocks with no rook neighbor. Corner-only contacts are excluded.
   */
  adjOffsets: Uint32Array;
  adjTargets: Uint32Array;
  /** Shared border length in meters, parallel to adjTargets. 0 for manual links and bridges. Saturates at 65535. */
  adjLen: Uint16Array;
  /** Meters of each block's boundary shared with no other block (state edge, coastline). */
  outerLen: Uint32Array;
  /** Block area in square meters (land + water). */
  areaM2: Float32Array;
  /**
   * 1 where the block is water only (no land area). Present when the manifest has a `water`
   * file. The adjacency graph deliberately crosses water through these blocks, because DRA
   * does; this is what lets the engine tell a land connection from a water one.
   */
  waterOnly?: Uint8Array;
  /** Town index per block, 1..manifest.towns.count; 0 = in no town. Present when the manifest has a `towns` file. */
  townOf?: Uint32Array;
  /**
   * A point inside each block: points[2i] = longitude, points[2i+1] = latitude, in millionths of a
   * degree. Present when the manifest has a `points` file.
   */
  points?: Int32Array;
  /** County and town names (see BundleManifest.names). Present when the manifest has a `names` file. */
  names?: { counties: string[]; towns: string[] };
}

/** Geometry for one county: GeoJSON polygons in WGS84 whose feature `id` and `properties.GEOID20` are the block GEOID. */
export interface CountyGeometry {
  countyFips: string;
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    properties: { GEOID20: string };
    geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  }>;
}

/** What the rest of the app asks of the bundle reader (implemented in packages/bundle). */
export interface BundleSource {
  /** Loads and caches the manifest + attrs for a state. Rejects if the state has no bundle. */
  loadState(state: string, onProgress?: (loaded: number, total: number) => void): Promise<StateBundle>;
  /** Loads and caches one county's block geometry. */
  loadCounty(bundle: StateBundle, countyFips: string): Promise<CountyGeometry>;
}
