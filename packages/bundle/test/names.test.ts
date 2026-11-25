import { describe, expect, it } from 'vitest';
import { decodeManifest, decodeNames } from '../src/index';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const hash = 'a'.repeat(64);
const baseManifest = {
  format: 1,
  state: 'NY',
  stateFips: '36',
  censusVintage: '2020',
  draDataVersion: 'v08',
  precinctKind: 'vtd',
  attribution: 'test',
  attrs: { file: `attrs.${hash}.bin.gz`, sha256: hash, bytes: 10 },
  counties: [{ fips: '36001', features: 1, file: `36001.${hash}.topo.json.gz`, sha256: hash, bytes: 10 }],
};

describe('region names', () => {
  it('preserves index order, Unicode and duplicate town names', () => {
    const names = { counties: ['Doña Ana County', 'Bernalillo County'], towns: ['', 'Union town', 'Union town'] };
    expect(decodeNames(encode(names), 2, 2)).toEqual(names);
    expect(decodeNames(encode({ counties: names.counties, towns: [''] }), 2, 0).towns).toEqual(['']);
  });

  it.each([
    { counties: [], towns: ['', 'Hudson city'] },
    { counties: ['Columbia County', 'Albany County'], towns: ['', 'Hudson city'] },
    { counties: ['Columbia County'], towns: [''] },
    { counties: ['Columbia County'], towns: ['', 'Hudson city', 'Albany city'] },
    { counties: ['Columbia County'], towns: ['None', 'Hudson city'] },
    { counties: ['Columbia County'], towns: ['', ' '] },
    { counties: ['Columbia County'], towns: ['', 1] },
    { counties: [''], towns: ['', 'Hudson city'] },
  ])('rejects names that do not match the bundle: %j', (names) => {
    expect(() => decodeNames(encode(names), 1, 1)).toThrow('Invalid county or town names');
  });

  it('validates the optional names entry in the manifest', () => {
    const valid = { file: `names.${hash}.json.gz`, sha256: hash, bytes: 42 };
    expect(decodeManifest({ ...baseManifest, names: valid }, 'NY').names).toEqual(valid);
    expect(decodeManifest(baseManifest, 'NY').names).toBeUndefined();
    expect(() => decodeManifest({ ...baseManifest, names: { ...valid, file: `names.${hash}.bin.gz` } }, 'NY')).toThrow(/manifest/);
    expect(() => decodeManifest({ ...baseManifest, names: { ...valid, file: `points.${hash}.json.gz` } }, 'NY')).toThrow(/manifest/);
    expect(() => decodeManifest({ ...baseManifest, names: { ...valid, bytes: 0 } }, 'NY')).toThrow(/manifest/);
  });
});
