import type { BundleFileRef, BundleSource, CountyGeometry, StateBundle } from '@zd/contracts';
import { cached } from './cache';
import { decodeAttrs, decodeCounty, decodeManifest, decodeTowns, decodeWater, stateCode } from './decode';

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
  private database?: Promise<IDBDatabase | undefined>;

  constructor(baseUrl: string | URL) {
    this.baseUrl = new URL(baseUrl, globalThis.location?.href);
    if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/';
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
