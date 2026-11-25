import type { EngineGraph, PopField, StateBundle } from '@zd/contracts';

export { BrowserBundleSource } from './browser';
export type { BundleReadOptions } from './cache';
export { decodeAttrs, decodeCounty, decodeManifest, decodeNames, decodeOutlines, decodePoints } from './decode';
export type { CountyOutline, CountyOutlines } from './decode';

/** Return the sorted block index, or -1 for a GEOID outside the bundle. */
export function geoidIndex(bundle: StateBundle, geoid: string): number {
  let lo = 0;
  let hi = bundle.n;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (bundle.geoids[mid] < geoid) lo = mid + 1;
    else hi = mid;
  }
  return bundle.geoids[lo] === geoid ? lo : -1;
}

/** Share the bundle's arrays with the engine, replacing precinct membership when supplied. */
export function toEngineGraph(
  bundle: StateBundle,
  field: PopField,
  precinctOverride: Uint32Array = bundle.precinctOf,
): EngineGraph {
  if (precinctOverride.length !== bundle.n) throw new Error('Precinct override must include every block');
  const { n, countyOf, adjOffsets, adjTargets, adjLen, outerLen, areaM2 } = bundle;
  return { n, pop: bundle.pop[field], countyOf, precinctOf: precinctOverride,
    adjOffsets, adjTargets, adjLen, outerLen, areaM2,
    ...(bundle.waterOnly ? { water: bundle.waterOnly } : {}),
    ...(bundle.townOf ? { townOf: bundle.townOf } : {}) };
}
