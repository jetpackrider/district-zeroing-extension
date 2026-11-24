import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeAttrs, decodeCounty, decodeManifest } from '@zd/bundle';

const dir = join(import.meta.dirname, '../../fixture/data/NY');
const buf = (f: string) => {
  const b = gunzipSync(readFileSync(join(dir, f)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!existsSync(join(dir, 'manifest.json')))('fixture bundle decodes with the real @zd/bundle reader', () => {
  it('attrs and counties', () => {
    const manifest = decodeManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), 'NY');
    const b = decodeAttrs(buf(manifest.attrs.file), manifest);
    expect(b.n).toBe(48 * 32);
    for (const c of manifest.counties) expect(decodeCounty(buf(c.file), c.fips, c.features).features.length).toBe(c.features);
  });
});
