/** Share concurrent loads and allow retries after a failed load. */
export function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = load().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

/** How a bundle source reads the optional points sidecar (BundleManifest.points). */
export interface BundleReadOptions {
  /**
   * 'with-state' (default): loadState reads it too, so StateBundle.points is there when the
   * manifest lists it. 'on-demand': loadState leaves it out and loadPoints reads it when asked, for
   * an app that needs block points only for some features (the extension's area) and should not
   * pay for them on every state load.
   */
  points?: 'with-state' | 'on-demand';
}

/**
 * loadState's part in reading the points sidecar: like the other sidecars it is optional, so a
 * points file that cannot be read (missing, wrong hash, bad contents) leaves `bundle.points` out
 * with a warning instead of failing the whole state, which is usable without it.
 */
export async function withPoints<B extends { manifest: { state: string } }>(bundle: B, load: (bundle: B) => Promise<unknown>): Promise<void> {
  try {
    await load(bundle);
  } catch (error) {
    console.warn(`[zd] ${bundle.manifest.state}: the block points file could not be read, so the state loads without it.`, error);
  }
}
