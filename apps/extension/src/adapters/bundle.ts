/**
 * Adapter: @zd/bundle (browser reader with IndexedDB cache, GEOID index, EngineGraph builder).
 */
import type { BundleSource, EngineGraph, PopField, StateBundle } from '@zd/contracts';
import { BrowserBundleSource, geoidIndex as realGeoidIndex, toEngineGraph as realToEngineGraph } from '@zd/bundle';

/**
 * The county outlines sidecar (BundleManifest.outlines): one feature per county, `id` = county
 * index. Looser than @zd/bundle's CountyOutlines (which the reader returns, checked) so the
 * drawing code tolerates a feature without an id.
 */
export interface CountyOutlines {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; id?: number | string; properties?: { fips?: string } & Record<string, unknown>; geometry: { type: string; coordinates: unknown } }>;
}

/**
 * The bundle reader, plus loadPoints: the block points (BundleManifest.points) are read only when
 * an area needs them, so a state loads as fast without an area as before areas existed, and a bad
 * points file never stops the state from loading. loadOutlines likewise reads the county outlines
 * (BundleManifest.outlines) only when county clusters are drawn; undefined when the state's data
 * has none.
 */
export type AppBundleSource = BundleSource & {
  loadPoints(bundle: StateBundle): Promise<Int32Array | undefined>;
  loadOutlines(bundle: StateBundle): Promise<CountyOutlines | undefined>;
};

export function createBundleSource(baseUrl: string): AppBundleSource {
  const source = new BrowserBundleSource(baseUrl, { points: 'on-demand' });
  return {
    loadState: (state, onProgress) => source.loadState(state, onProgress),
    loadCounty: (bundle, fips) => source.loadCounty(bundle, fips),
    loadPoints: (bundle) => source.loadPoints(bundle),
    // The bundle reader's own loader: read once, checked against the manifest's size and hash and
    // the bundle's counties, kept in IndexedDB; undefined when the manifest has no outlines.
    loadOutlines: (bundle) => source.loadOutlines(bundle),
  };
}

/** Sorted-position lookup; -1 when the GEOID is not in the bundle. */
export function geoidIndex(bundle: StateBundle, geoid: string): number {
  return realGeoidIndex(bundle, geoid);
}

export function toEngineGraph(bundle: StateBundle, field: PopField, precinctOf?: Uint32Array): EngineGraph {
  return realToEngineGraph(bundle, field, precinctOf);
}
