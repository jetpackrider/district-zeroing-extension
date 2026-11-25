import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { BundleFileRef, BundleSource, CountyGeometry, StateBundle } from '@zd/contracts';
import { cached, withPoints, type BundleReadOptions } from './cache';
import { decodeAttrs, decodeCounty, decodeManifest, decodeNames, decodeOutlines, decodePoints, decodeTowns, decodeWater, stateCode, type CountyOutlines } from './decode';

const decompress = promisify(gunzip);

/** Loads bundles from <directory>/<STATE>/manifest.json. */
export class NodeBundleSource implements BundleSource {
  private readonly states = new Map<string, Promise<StateBundle>>();
  private readonly counties = new Map<string, Promise<CountyGeometry>>();
  private readonly pointLoads = new Map<string, Promise<Int32Array | undefined>>();
  private readonly outlineLoads = new Map<string, Promise<CountyOutlines>>();
  private readonly options: Required<BundleReadOptions>;

  constructor(private readonly directory: string, options: BundleReadOptions = {}) {
    this.options = { points: options.points ?? 'with-state' };
  }

  /** As BrowserBundleSource.loadPoints: the points sidecar of a loaded state, read once. */
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

  /** As BrowserBundleSource.loadOutlines: the county outlines sidecar, read on demand and once. */
  loadOutlines(bundle: StateBundle): Promise<CountyOutlines | undefined> {
    const ref = bundle.manifest.outlines;
    if (!ref) return Promise.resolve(undefined);
    return cached(this.outlineLoads, ref.file, async () =>
      decodeOutlines(await this.loadFile(bundle.manifest.state, ref), bundle.countyFips));
  }

  async loadState(state: string, onProgress?: (loaded: number, total: number) => void): Promise<StateBundle> {
    const code = stateCode(state);
    const bundle = await cached(this.states, code, async () => {
      const json = await readFile(join(this.directory, code, 'manifest.json'), 'utf-8');
      const manifest = decodeManifest(JSON.parse(json), code);
      const bundle = decodeAttrs(await this.loadFile(code, manifest.attrs), manifest);
      if (manifest.water) bundle.waterOnly = decodeWater(await this.loadFile(code, manifest.water), bundle.n);
      if (manifest.towns) bundle.townOf = decodeTowns(await this.loadFile(code, manifest.towns), bundle.n, manifest.towns.count);
      if (manifest.names) {
        bundle.names = decodeNames(await this.loadFile(code, manifest.names), bundle.countyFips.length, manifest.towns?.count ?? 0);
      }
      if (this.options.points === 'with-state') await withPoints(bundle, (b) => this.loadPoints(b));
      return bundle;
    });
    onProgress?.(bundle.manifest.attrs.bytes, bundle.manifest.attrs.bytes);
    return bundle;
  }

  async loadCounty(bundle: StateBundle, countyFips: string): Promise<CountyGeometry> {
    const ref = bundle.manifest.counties.find((county) => county.fips === countyFips);
    if (!ref) throw new Error(`Unknown county ${countyFips} in ${bundle.manifest.state}`);
    return cached(this.counties, ref.file, async () =>
      decodeCounty(await this.loadFile(bundle.manifest.state, ref), countyFips, ref.features));
  }

  private async loadFile(state: string, ref: BundleFileRef): Promise<ArrayBuffer> {
    const packed = await readFile(join(this.directory, state, ref.file));
    if (packed.byteLength !== ref.bytes || createHash('sha256').update(packed).digest('hex') !== ref.sha256) {
      throw new Error(`Bundle hash or size mismatch: ${ref.file}`);
    }
    const raw = await decompress(packed);
    return Uint8Array.from(raw).buffer;
  }
}
