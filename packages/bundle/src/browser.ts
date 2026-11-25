import type { BundleFileRef, BundleSource, CountyGeometry, StateBundle } from '@zd/contracts';
import { cached, withPoints, type BundleReadOptions } from './cache';
import { decodeAttrs, decodeCounty, decodeManifest, decodeNames, decodeOutlines, decodePoints, decodeTowns, decodeWater, stateCode, type CountyOutlines } from './decode';

type Progress = (loaded: number, total: number) => void;
const STORE = 'files';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zd-bundle-cache', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readCache(database: IDBDatabase, key: string): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result instanceof ArrayBuffer ? request.result : undefined);
    request.onerror = () => reject(request.error);
  });
}

function writeCache(database: IDBDatabase, key: string, bytes: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(bytes, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function matches(bytes: ArrayBuffer, ref: BundleFileRef): Promise<boolean> {
  if (bytes.byteLength !== ref.bytes) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') === ref.sha256;
}

async function download(url: URL, size: number, progress?: Progress): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bundle fetch failed (${response.status}) for ${url}`);
  if (!progress || !response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let loaded = 0;
  try {
    progress(0, size);
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (loaded + result.value.byteLength > size) throw new Error(`Bundle exceeds declared size: ${url}`);
      bytes.set(result.value, loaded);
      loaded += result.value.byteLength;
      if (loaded < size) progress(loaded, size);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (loaded !== size) throw new Error(`Bundle is shorter than declared size: ${url}`);
  return bytes.buffer;
}

/** Loads bundles from <baseUrl>/<STATE>/manifest.json and caches verified gzip bytes. */
export class BrowserBundleSource implements BundleSource {
  private readonly baseUrl: URL;
  private readonly states = new Map<string, Promise<StateBundle>>();
  private readonly counties = new Map<string, Promise<CountyGeometry>>();
  private readonly pointLoads = new Map<string, Promise<Int32Array | undefined>>();
  private readonly outlineLoads = new Map<string, Promise<CountyOutlines>>();
  private database?: Promise<IDBDatabase | undefined>;
  private readonly options: Required<BundleReadOptions>;

  constructor(baseUrl: string | URL, options: BundleReadOptions = {}) {
    this.baseUrl = new URL(baseUrl, globalThis.location?.href);
    if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/';
    this.options = { points: options.points ?? 'with-state' };
  }

  /**
   * The points sidecar (BundleManifest.points) of a loaded state, read on first call and kept on
   * `bundle.points`; undefined when the manifest has none. Rejects on a bad file (the state itself
   * stays loaded). With `points: 'on-demand'` this is the only way the points are read.
   */
  loadPoints(bundle: StateBundle): Promise<Int32Array | undefined> {
    if (bundle.points) return Promise.resolve(bundle.points);
    const ref = bundle.manifest.points;
    if (!ref) return Promise.resolve(undefined);
    return cached(this.pointLoads, ref.file, async () => {
      const points = decodePoints(await this.loadFile(bundle.manifest.state, ref), bundle.n);
      bundle.points = points;
      return points;
    });
  }

  /**
   * The county outlines sidecar (BundleManifest.outlines) of a loaded state: one simplified outline
   * per county for drawing, read only when asked (loadState never reads it), verified by size and
   * SHA-256 and cached like the other files. Undefined when the manifest has none; rejects on a bad
   * file, and a later call tries again.
   */
  loadOutlines(bundle: StateBundle): Promise<CountyOutlines | undefined> {
    const ref = bundle.manifest.outlines;
    if (!ref) return Promise.resolve(undefined);
    return cached(this.outlineLoads, ref.file, async () =>
      decodeOutlines(await this.loadFile(bundle.manifest.state, ref), bundle.countyFips));
  }

  async loadState(state: string, onProgress?: Progress): Promise<StateBundle> {
    const code = stateCode(state);
    const existing = this.states.get(code);
    if (existing) {
      return existing.then((bundle) => {
        onProgress?.(bundle.manifest.attrs.bytes, bundle.manifest.attrs.bytes);
        return bundle;
      });
    }
    return cached(this.states, code, async () => {
      const url = this.url(code, 'manifest.json');
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Bundle manifest fetch failed (${response.status}) for ${code}`);
      const manifest = decodeManifest(await response.json(), code);
      const data = await this.loadFile(code, manifest.attrs, onProgress);
      const bundle = decodeAttrs(data, manifest);
      if (manifest.water) bundle.waterOnly = decodeWater(await this.loadFile(code, manifest.water), bundle.n);
      if (manifest.towns) bundle.townOf = decodeTowns(await this.loadFile(code, manifest.towns), bundle.n, manifest.towns.count);
      if (manifest.names) {
        bundle.names = decodeNames(await this.loadFile(code, manifest.names), bundle.countyFips.length, manifest.towns?.count ?? 0);
      }
      if (this.options.points === 'with-state') await withPoints(bundle, (b) => this.loadPoints(b));
      return bundle;
    });
  }

  async loadCounty(bundle: StateBundle, countyFips: string): Promise<CountyGeometry> {
    const ref = bundle.manifest.counties.find((county) => county.fips === countyFips);
    if (!ref) throw new Error(`Unknown county ${countyFips} in ${bundle.manifest.state}`);
    return cached(this.counties, ref.file, async () => {
      const data = await this.loadFile(bundle.manifest.state, ref);
      return decodeCounty(data, countyFips, ref.features);
    });
  }

  private url(state: string, filename: string): URL {
    return new URL(`${state}/${filename}`, this.baseUrl);
  }

  private async loadFile(state: string, ref: BundleFileRef, progress?: Progress): Promise<ArrayBuffer> {
    this.database ??= openDatabase().catch(() => undefined);
    const db = await this.database;
    let bytes = await (db && readCache(db, ref.file).catch(() => undefined));
    if (bytes && await matches(bytes, ref)) {
      progress?.(ref.bytes, ref.bytes);
    } else {
      bytes = await download(this.url(state, ref.file), ref.bytes, progress);
      if (!await matches(bytes, ref)) throw new Error(`Bundle hash or size mismatch: ${ref.file}`);
      if (db) await writeCache(db, ref.file, bytes).catch(() => undefined);
      progress?.(ref.bytes, ref.bytes);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
}
