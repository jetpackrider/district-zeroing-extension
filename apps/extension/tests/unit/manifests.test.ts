import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../');
const out = (dir: string) => join(root, dir, 'manifest.json');
const read = (dir: string) => JSON.parse(readFileSync(out(dir), 'utf8'));

/** SPEC "Permissions and store policy": exactly these, DRA host only. */
function expectSpecPermissions(m: any) {
  expect(m.permissions.slice().sort()).toEqual(['sidePanel', 'storage', 'unlimitedStorage']);
  expect(m.host_permissions).toEqual(['https://davesredistricting.org/*']);
  expect(m.optional_permissions).toBeUndefined();
  expect(m.optional_host_permissions).toBeUndefined();
  expect(m.externally_connectable).toBeUndefined();
  for (const cs of m.content_scripts) expect(cs.matches).toEqual(['https://davesredistricting.org/*']);
}

describe('shipped manifests (run `npm run build && npm run build:opera` first)', () => {
  it.skipIf(!existsSync(out('.output/chrome-mv3')))('chrome: exactly the spec permissions, DRA host only', () => {
    const m = read('.output/chrome-mv3');
    expectSpecPermissions(m);
    const main = m.content_scripts.find((c: any) => c.world === 'MAIN');
    expect(main.run_at).toBe('document_start');
    expect(m.side_panel.default_path).toBe('sidepanel.html');
    expect(m.web_accessible_resources).toBeUndefined();
    expect(m.name).toBe('Zero Deviation');
  });
  it.skipIf(!existsSync(out('.output/opera-mv3')))('opera: sidebar_action plus side_panel, same permissions', () => {
    const m = read('.output/opera-mv3');
    expect(m.sidebar_action.default_panel).toMatch(/^sidepanel\.html/);
    expectSpecPermissions(m);
  });
});

describe('local build (run `npm run build:local` first)', () => {
  const dir = 'local/chrome-mv3';
  it.skipIf(!existsSync(out(dir)))('same permissions as the store build; nothing extra to read the embedded data', () => {
    const m = read(dir);
    expectSpecPermissions(m);
    // Extension pages fetch the extension's own files without web_accessible_resources.
    expect(m.web_accessible_resources).toBeUndefined();
    expect(m.name).toMatch(/local build/);
  });
  it.skipIf(!existsSync(out(dir)))('embeds exactly the files each state manifest names', () => {
    const dataDir = join(root, dir, 'data');
    const states = readdirSync(dataDir);
    expect(states.length).toBeGreaterThan(0);
    for (const st of states) {
      const manifest = JSON.parse(readFileSync(join(dataDir, st, 'manifest.json'), 'utf8'));
      expect(manifest.state).toBe(st);
      const optional = [manifest.water, manifest.towns, manifest.points, manifest.names, manifest.outlines].filter(Boolean);
      const want = ['manifest.json', manifest.attrs.file, ...optional.map((r: any) => r.file), ...manifest.counties.map((c: any) => c.file)].sort();
      expect(readdirSync(join(dataDir, st)).sort()).toEqual(want);
      for (const ref of [manifest.attrs, ...optional, ...manifest.counties]) {
        expect(readFileSync(join(dataDir, st, ref.file)).byteLength).toBe(ref.bytes);
      }
    }
  });
  it.skipIf(!existsSync(out(dir)))('embeds the county outlines sidecar of each state that has one', () => {
    const dataDir = join(root, dir, 'data');
    for (const st of readdirSync(dataDir)) {
      const source = JSON.parse(readFileSync(join(root, '../../data', st, 'manifest.json'), 'utf8'));
      const manifest = JSON.parse(readFileSync(join(dataDir, st, 'manifest.json'), 'utf8'));
      expect(manifest.outlines).toEqual(source.outlines);
      if (!source.outlines) continue;
      expect(manifest.outlines.file).toMatch(/^outlines\.[a-f0-9]{64}\.json\.gz$/);
      expect(readFileSync(join(dataDir, st, manifest.outlines.file)).byteLength).toBe(manifest.outlines.bytes);
    }
  });
});
