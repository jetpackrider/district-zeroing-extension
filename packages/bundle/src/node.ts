import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { BundleFileRef, BundleSource, CountyGeometry, StateBundle } from '@zd/contracts';
import { cached } from './cache';
import { decodeAttrs, decodeCounty, decodeManifest, decodeTowns, decodeWater, stateCode } from './decode';

const decompress = promisify(gunzip);

/** Loads bundles from <directory>/<STATE>/manifest.json. */
export class NodeBundleSource implements BundleSource {
  private readonly states = new Map<string, Promise<StateBundle>>();
  private readonly counties = new Map<string, Promise<CountyGeometry>>();

  constructor(private readonly directory: string) {}

  async loadState(state: string, onProgress?: (loaded: number, total: number) => void): Promise<StateBundle> {
    const code = stateCode(state);
    const bundle = await cached(this.states, code, async () => {
      const json = await readFile(join(this.directory, code, 'manifest.json'), 'utf-8');
      const manifest = decodeManifest(JSON.parse(json), code);
      const bundle = decodeAttrs(await this.loadFile(code, manifest.attrs), manifest);
      if (manifest.water) bundle.waterOnly = decodeWater(await this.loadFile(code, manifest.water), bundle.n);
      if (manifest.towns) bundle.townOf = decodeTowns(await this.loadFile(code, manifest.towns), bundle.n, manifest.towns.count);
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
