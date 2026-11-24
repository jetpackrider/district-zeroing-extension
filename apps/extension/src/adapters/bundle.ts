/**
 * Adapter: @zd/bundle (browser reader with IndexedDB cache, GEOID index, EngineGraph builder).
 */
import type { BundleSource, EngineGraph, PopField, StateBundle } from '@zd/contracts';
import { BrowserBundleSource, geoidIndex as realGeoidIndex, toEngineGraph as realToEngineGraph } from '@zd/bundle';

export function createBundleSource(baseUrl: string): BundleSource {
  return new BrowserBundleSource(baseUrl);
}

/** Sorted-position lookup; -1 when the GEOID is not in the bundle. */
export function geoidIndex(bundle: StateBundle, geoid: string): number {
  return realGeoidIndex(bundle, geoid);
}

export function toEngineGraph(bundle: StateBundle, field: PopField, precinctOf?: Uint32Array): EngineGraph {
  return realToEngineGraph(bundle, field, precinctOf);
}
