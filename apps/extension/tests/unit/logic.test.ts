import { describe, expect, it } from 'vitest';
import { buildLiveMapping, decodeBitset, encodeBitset, featureMapToAssignment, isBlockId } from '../../src/panel/assignment';
import { labelIndexes, parseBlockCsv, stateFromGeoid } from '../../src/panel/csv';
import { detectUnsupported } from '../../src/panel/scope';
import { matchesHost, openPanelChain, patternToRegExp } from '../../src/shared/panel-host';
import type { HookDistrict, HookMapInfo } from '../../src/shared/protocol';

describe('DRA split-precinct bitset (ListToBitset)', () => {
  const list = Array.from({ length: 19 }, (_, i) => `36001000100${String(1000 + i)}`);
  it('round-trips and matches DRA bit order (LSB first)', () => {
    const members = [list[0], list[3], list[8], list[18]];
    const s = encodeBitset(list, members);
    // bytes: 0b00001001, 0b00000001, 0b00000100 -> base64
    expect(s).toBe(btoa(String.fromCharCode(9, 1, 4)));
    expect(decodeBitset(list, s)).toEqual(members);
  });
});

describe('featureMapToAssignment', () => {
  const geoids = ['360010001001000', '360010001001001', '360010001001002', '360010001001003', '360010001002000'];
  const idx = (g: string) => geoids.indexOf(g);
  const rev = { '36001000001': geoids.slice(0, 4), '36001000002': [geoids[4]] };
  const live = buildLiveMapping({ stamp: '1', rev }, geoids.length, idx, ['36001000001', '36001000002'], new Uint32Array(5));
  it('applies precincts, then B_ splits, then bare block edits', () => {
    const fm: Record<string, number> = {
      '36001000002': 2,
      [`B_36001000001_${encodeBitset(rev['36001000001'], [geoids[0], geoids[1]])}`]: 1,
      [`B_36001000001_${encodeBitset(rev['36001000001'], [geoids[2], geoids[3]])}`]: 2,
      [geoids[3]]: 3, // uncommitted block edit overrides
    };
    const r = featureMapToAssignment(fm, live, geoids.length, idx);
    expect(Array.from(r.assignment)).toEqual([1, 1, 2, 3, 2]);
    expect(r.unresolved).toEqual([]);
  });
  it('reports legacy vfeatures it cannot decode', () => {
    const r = featureMapToAssignment({ 'vfeature_36001000001_0_abc': 1 }, live, geoids.length, idx);
    expect(r.unresolved).toEqual(['vfeature_36001000001_0_abc']);
  });
  it('isBlockId follows DRA pc()', () => {
    expect(isBlockId('360010001001000')).toBe(true);
    expect(isBlockId('36001000001')).toBe(false);
    expect(isBlockId('B_36001000001_AA==')).toBe(false);
  });
  it('updated precincts extend the precinct list', () => {
    const l2 = buildLiveMapping({ stamp: '2', rev: { ...rev, NEWP: [geoids[0]] } }, geoids.length, idx, ['36001000001', '36001000002'], new Uint32Array(5));
    expect(l2.precinctIds).toContain('NEWP');
    expect(l2.precinctIds[l2.precinctOf[0]]).toBe('NEWP');
  });
});

describe('CSV fallback', () => {
  it('parses , and | with header and custom labels', () => {
    const p = parseBlockCsv('GEOID20,District\n360010001001000,North\n360010001001001|South\n360010001001002,North\n');
    expect(p.rows.length).toBe(3);
    expect(p.labels).toEqual(['North', 'South']);
    expect([...labelIndexes(p.labels)]).toEqual([['North', 1], ['South', 2]]);
    expect([...labelIndexes(['3', '1', '2'])]).toEqual([['3', 3], ['1', 1], ['2', 2]]);
    expect(stateFromGeoid('360010001001000')).toBe('NY');
  });
  it('reads a district of "0" as unassigned, so the real districts keep their numbers', () => {
    const p = parseBlockCsv('GEOID20,District\n360010001001000,1\n360010001001001,0\n360010001001002,2\n360010001001003,00\n');
    expect(p.rows.map((r) => r.geoid)).toEqual(['360010001001000', '360010001001002']);
    expect([...labelIndexes(p.labels)]).toEqual([['1', 1], ['2', 2]]);
  });
});

describe('out-of-scope detection', () => {
  const base: HookMapInfo = { state: 'NY', datasource: '2020_VD', planType: 'congress', nDistricts: 2, equalPop: true, allowMMD: false, restriction: { rt: 'state', id: null, name: '' }, isMapCollection: false, isMultiState: false, popField: 'D20F', totalPop: 10, planName: '' };
  const ds: HookDistrict[] = [0, 1, 2].map((i) => ({ index: i, label: String(i), pop: 5, target: i ? 5 : 0, membersPer: 1 }));
  it('accepts a normal map and rejects each out-of-scope kind', () => {
    expect(detectUnsupported(base, ds)).toBeNull();
    expect(detectUnsupported({ ...base, datasource: '2010_VD' }, ds)?.kind).toBe('2010-shape');
    expect(detectUnsupported({ ...base, isMultiState: true }, ds)?.kind).toBe('multi-state');
    expect(detectUnsupported({ ...base, restriction: { rt: 'county', id: '1', name: 'X' } }, ds)?.kind).toBe('county-or-city');
    expect(detectUnsupported({ ...base, equalPop: false }, ds)?.kind).toBe('unequal-target');
    expect(detectUnsupported({ ...base, allowMMD: true }, ds.map((d) => ({ ...d, membersPer: d.index === 1 ? 2 : 1 })))?.kind).toBe('multi-member');
  });
});

describe('panel host chain', () => {
  const env = (o: Partial<Parameters<typeof openPanelChain>[0]>) => {
    const log: string[] = [];
    return { log, env: { popout: async () => void log.push('popout'), waitAlive: async () => true, ...o } };
  };
  it('uses chrome.sidePanel when it opens and a panel checks in', async () => {
    const { env: e } = env({ sidePanelOpen: async () => {} });
    expect(await openPanelChain(e)).toBe('sidepanel');
  });
  it('falls to Opera sidebar, then pop-out', async () => {
    const a = env({ sidePanelOpen: async () => Promise.reject(new Error('no')), operaOpen: async () => {} });
    expect(await openPanelChain(a.env)).toBe('opera-sidebar');
    const b = env({ sidePanelOpen: async () => Promise.reject(new Error('no')) });
    expect(await openPanelChain(b.env)).toBe('popout');
    expect(b.log).toEqual(['popout']);
  });
  it('a side panel that "opens" but never checks in (Opera bug) falls through', async () => {
    const c = env({ sidePanelOpen: async () => {}, waitAlive: async (h) => h !== 'sidepanel' });
    expect(await openPanelChain(c.env)).toBe('popout');
  });
  it('match patterns: DRA only; port ignored', () => {
    expect(matchesHost('https://davesredistricting.org/maps#plan', ['https://davesredistricting.org/*'])).toBe(true);
    expect(matchesHost('https://evil.example/davesredistricting.org/', ['https://davesredistricting.org/*'])).toBe(false);
    expect(patternToRegExp('http://localhost/*').test('http://localhost:5123/index.html')).toBe(true);
  });
});

import { buildSteps, tickWalkthrough, type StepContext, type WalkPlan } from '../../src/panel/walkthrough';
import type { Solution, WalkthroughState } from '@zd/contracts';

describe('walkthrough with a two-way trade', () => {
  // 6 blocks: precinct 0 = blocks 0,1,2 (district 1); precinct 1 = blocks 3,4,5 (district 2).
  const geoids = ['a0', 'a1', 'a2', 'b3', 'b4', 'b5'];
  const ctx: StepContext = {
    geoids,
    pop: Int32Array.from([10, 12, 8, 5, 6, 7]),
    precinctOf: Uint32Array.from([0, 0, 0, 1, 1, 1]),
    precinctIds: ['P0', 'P1'],
    blocksOfPrecinct: (p) => (p === 0 ? [0, 1, 2] : [3, 4, 5]),
  };
  const base = Uint16Array.from([1, 1, 1, 2, 2, 2]);
  const sol = (transfers: Array<[number, number, number[]]>): Solution => ({
    id: 's',
    kind: 'fewest-splits',
    transfers: transfers.map(([from, to, blocks]) => ({ from, to, blocks: Uint32Array.from(blocks), people: blocks.reduce((s, b) => s + ctx.pop[b], 0) })),
    borderFlows: [],
    stats: {} as any,
    deviations: [],
  });

  it('keeps transfer order, numbers per step, and judges whole precincts on the map as earlier legs left it', () => {
    // Leg 1 moves all of P0 to 2 (whole precinct); leg 2 moves block 3 back to 1.
    const b = buildSteps(sol([[1, 2, [0, 1, 2]], [2, 1, [3]]]), base, ctx);
    expect(b.steps.map((s) => `${s.from}>${s.to}:${s.precinctId}:${s.wholePrecinct}`)).toEqual(['1>2:P0:true', '2>1:P1:false']);
    expect(b.duplicates).toEqual([]);
    // A later leg taking a precinct that an earlier leg completed is judged against the updated map.
    const c = buildSteps(sol([[2, 1, [3, 4]], [2, 1, [5]]]), base, ctx);
    expect(c.steps[1].wholePrecinct).toBe(false); // P1 isn't entirely in 2 any more when leg 2 runs
  });

  it('refuses a block that is planned to move twice (or is already owned by a finished step)', () => {
    expect(buildSteps(sol([[1, 2, [0]], [2, 1, [0]]]), base, ctx).duplicates).toEqual([0]);
    expect(buildSteps(sol([[1, 2, [1]]]), base, ctx, '', new Set([1])).duplicates).toEqual([1]);
  });

  it('first leg painted: no strays, moves on to the return leg; a jump back to a finished step stays put', () => {
    const b = buildSteps(sol([[1, 2, [0]], [2, 1, [3]]]), base, ctx);
    const plan: WalkPlan = { solutionId: 's', target: new Map([[0, 2], [3, 1]]), stepBlocks: b.stepBlocks, baseline: base, popsBefore: new Map(), districts: [1, 2] };
    let w: WalkthroughState = { solutionId: 's', steps: b.steps, current: 0, strayEdits: [], liveTicking: true, mapMode: 'dra' };
    const live = Uint16Array.from([2, 1, 1, 2, 2, 2]); // leg 1 painted
    w = tickWalkthrough(w, plan, live, new Set(), geoids);
    expect(w.steps.map((s) => s.status)).toEqual(['done', 'active']);
    expect(w.current).toBe(1);
    expect(w.strayEdits).toEqual([]);
    // User jumps back to step 0 (done): the next tick keeps it there.
    w = { ...w, current: 0 };
    w = tickWalkthrough(w, plan, live, new Set(), geoids);
    expect(w.current).toBe(0);
    // A block painted somewhere else is a stray; a planned block in the wrong district is too.
    const stray = Uint16Array.from([2, 2, 1, 1, 2, 2]);
    w = tickWalkthrough(w, plan, stray, new Set(), geoids);
    expect(w.strayEdits).toEqual([{ geoid: 'a1', fromDistrict: 1, toDistrict: 2 }]);
    // Painted but not committed: awaiting-commit, not done.
    const w2 = tickWalkthrough({ ...w, current: 1 }, plan, Uint16Array.from([2, 1, 1, 1, 2, 2]), new Set(['P1']), geoids);
    expect(w2.steps[1].status).toBe('awaiting-commit');
  });
});
