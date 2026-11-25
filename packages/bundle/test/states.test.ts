import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NodeBundleSource } from '../src/node';

const root = fileURLToPath(new URL('../../../data/', import.meta.url));
const source = new NodeBundleSource(root);

describe('real Phase 8 bundles', () => {
  it('decodes Hawaii block-group membership and county geometry', async () => {
    const hi = await source.loadState('HI');
    expect(hi.manifest.precinctKind).toBe('bg');
    expect(hi.n).toBe(14732);
    expect(hi.precinctIds).toHaveLength(1083);
    expect(hi.geoids.every((id, i) => hi.precinctIds[hi.precinctOf[i]] === id.slice(0, 12))).toBe(true);
    expect(hi.pop.D20FA).toEqual(hi.pop.D20F);
    const county = await source.loadCounty(hi, '15001');
    expect(county.features.map(({ id }) => id).sort()).toEqual(hi.geoids.filter((id) => id.startsWith('15001')));
  });

  it('keeps the hyphen in DC precinct keys from the official release', async () => {
    const dc = await source.loadState('DC');
    expect(dc.manifest.draDataVersion).toBe('v06');
    expect(dc.manifest.precinctKind).toBe('vtd');
    expect(dc.n).toBe(6012);
    expect(dc.precinctIds).toHaveLength(143);
    expect(dc.geoids[0]).toBe('110010001011000');
    expect(dc.precinctIds[dc.precinctOf[0]]).toBe('1100102-005');
    expect(dc.pop.D20F.reduce((a, b) => a + b, 0)).toBe(689545);
    expect((await source.loadCounty(dc, '11001')).features).toHaveLength(dc.n);
  });

  it('loads every local statewide bundle and preserves punctuated precinct IDs', async () => {
    const states = (await readdir(root)).filter((state) =>
      /^[A-Z]{2}$/.test(state) && existsSync(join(root, state, 'manifest.json')));
    for (const state of states) {
      // Release each state cache before loading the next.
      const bundle = await new NodeBundleSource(root).loadState(state);
      expect(bundle.townOf).toHaveLength(bundle.n);
      expect(bundle.points).toHaveLength(2 * bundle.n);
      expect(bundle.names?.counties).toHaveLength(bundle.countyFips.length);
      expect(bundle.names?.towns).toHaveLength(bundle.manifest.towns!.count + 1);
      expect(bundle.names?.towns[0]).toBe('');
      if (state === 'NY') {
        expect(bundle.names?.counties[bundle.countyFips.indexOf('36103')]).toBe('Suffolk County');
        expect(bundle.names?.towns).toContain('Huntington town');
      }
      expect(bundle.manifest.towns!.count > 0).toBe(state !== 'HI');
      if (state === 'AL') expect(bundle.precinctIds).toContain('010130014.1');
      if (state === 'AR') expect(bundle.precinctIds).toContain('05081000W/R');
      if (state === 'TX') expect(bundle.precinctIds).toContain('481770004/6');
    }
  }, 60_000);
});
