import { describe, expect, it } from 'vitest';
import { choiceTolerance, districtsTouched, restrictToChoice, sanitizeScope, solveDistrictMessage } from '../../src/worker/choice';

const sol = (id: string, flows: Array<[number, number]>) => ({
  id,
  transfers: flows.map(([from, to]) => ({ from, to, blocks: new Uint32Array([1]), people: 5 })),
  borderFlows: flows.map(([from, to]) => ({ from, to, people: 5 })),
});

describe('neighbor choice (Scope `with`)', () => {
  it('districtsTouched lists every giving and receiving district', () => {
    expect([...districtsTouched(sol('a', [[1, 2], [2, 3]]))].sort()).toEqual([1, 2, 3]);
  });

  it('restrictToChoice keeps only solutions between the district and the chosen neighbors, and reports the rest', () => {
    const sols = [sol('a', [[1, 2]]), sol('b', [[1, 2], [2, 1]]), sol('c', [[1, 2], [2, 3]]), sol('d', [[1, 4]])];
    const r = restrictToChoice(sols, 1, [2]);
    expect(r.kept.map((s) => s.id)).toEqual(['a', 'b']);
    expect(r.dropped).toBe(2);
    expect(r.outside).toEqual([3, 4]);
    // No choice = any neighbor: nothing dropped.
    expect(restrictToChoice(sols, 1, undefined).kept).toHaveLength(4);
    expect(restrictToChoice(sols, 1, []).dropped).toBe(0);
  });

  it('sanitizeScope drops duplicates, the district itself and non-neighbors; an empty choice becomes "any"', () => {
    const nbrs = (d: number) => (d === 1 ? [2, 3] : undefined);
    expect(sanitizeScope({ mode: 'one', district: 1, with: [3, 2, 3, 1] }, nbrs)).toEqual({ mode: 'one', district: 1, with: [2, 3] });
    expect(sanitizeScope({ mode: 'one', district: 1, with: [4] }, nbrs)).toEqual({ mode: 'one', district: 1 });
    expect(sanitizeScope({ mode: 'one', district: 1, with: [] }, nbrs)).toEqual({ mode: 'one', district: 1 });
    // Neighbors not known yet: keep the choice as given (minus the district itself).
    expect(sanitizeScope({ mode: 'one', district: 5, with: [7, 5] }, nbrs)).toEqual({ mode: 'one', district: 5, with: [7] });
    expect(sanitizeScope({ mode: 'all' }, nbrs)).toEqual({ mode: 'all' });
  });

  it('choiceTolerance lets any one chosen neighbor take the whole difference', () => {
    // District +34; chosen neighbors at -10 and +5. Taking all 34 leaves +24 or +39: both within the tolerance.
    const tol = choiceTolerance(34, [-10, 5]);
    expect(tol).toBeGreaterThanOrEqual(39);
    expect(choiceTolerance(-12, [0])).toBeGreaterThanOrEqual(12);
  });

  it('solveDistrictMessage says what was left out because it traded with districts the user did not pick', () => {
    const name = (d: number) => `District ${d}`;
    const base = { district: 2, chosen: [1], name };
    // Fallback plans all went through District 3: nothing shown, and why.
    const none = solveDistrictMessage({ ...base, shown: 0, status: 'needs-precinct-rework', fallback: false, dropped: { plans: 2, outside: [3], fallback: true } });
    expect(none).toBe('No way to zero District 2 trading only with District 1 was found. The multi-border planner found 2 plans, but they trade with District 3 too, which you did not pick, so nothing is shown. Pick District 3 as well, or choose "Any neighbor".');
    // Some shown, one dropped.
    const some = solveDistrictMessage({ ...base, shown: 1, status: 'ok', fallback: true, dropped: { plans: 1, outside: [3, 4], fallback: true } });
    expect(some).toMatch(/^No one-way move hits the number, so these plans trade with District 1 in both directions\./);
    expect(some).toMatch(/1 other plan also traded with District 3 and District 4, which you did not pick, so it is not shown\.$/);
    // Nothing found with a choice and nothing dropped.
    expect(solveDistrictMessage({ ...base, shown: 0, status: 'needs-precinct-rework', fallback: false, message: 'Out of reach.' })).toBe('No way to zero District 2 trading only with District 1 was found. Out of reach. Pick more neighbors, or choose "Any neighbor".');
    // No choice: today's wording.
    expect(solveDistrictMessage({ district: 2, chosen: [], name, shown: 1, status: 'ok', fallback: true })).toMatch(/through other neighbors/);
    expect(solveDistrictMessage({ district: 2, chosen: [], name, shown: 0, status: 'needs-precinct-rework', fallback: false, message: 'm' })).toBe('m');
  });
});
