/** Audits every option the engine returns during planner runs against the BorderSolver contract. */
import type { BorderSolver, BorderSolveRequest } from '@zd/contracts';
import { planGroup } from '../src/index';
import { generateMap, piecesPerDistrict } from '../test/support/synth';
import { range } from '../test/support/check';
const enginePath = new URL('../../engine/src/index.ts', import.meta.url).href;
const { borderSolver } = (await import(/* @vite-ignore */ enginePath)) as { borderSolver: BorderSolver };
const bad: Record<string, number> = { options: 0, unsorted: 0, wrongSource: 0, locked: 0, notAccepted: 0, peopleField: 0, newPiece: 0, tooMany: 0, capacityNotInteger: 0, capacityOverPop: 0 };
const s: BorderSolver = {
  capacity: (r) => {
    const c = borderSolver.capacity(r);
    let pop = 0; for (let b = 0; b < r.graph.n; b++) if (r.assignment[b] === r.from) pop += r.graph.pop[b];
    if (c.tiers.some((t) => !Number.isInteger(t.people))) bad.capacityNotInteger++;
    if (c.tiers.reduce((x, t) => x + t.people, 0) > pop) bad.capacityOverPop++;
    return c;
  },
  solve(r) { return this.solveScored(r).map(option => option.transfer); },
  solveScored: (r: BorderSolveRequest) => {
    const out = borderSolver.solveScored(r);
    if (out.length > Math.min(8, r.maxOptions ?? 5)) bad.tooMany++;
    const k = Math.max(...Array.from(r.assignment));
    const before = piecesPerDistrict(r.graph, r.assignment, k);
    for (const { transfer: t } of out) {
      bad.options++;
      let sum = 0;
      for (let i = 0; i < t.blocks.length; i++) {
        const b = t.blocks[i];
        if (i && t.blocks[i - 1] >= b) bad.unsorted++;
        if (r.assignment[b] !== r.from) bad.wrongSource++;
        if (r.locked?.[b]) bad.locked++;
        sum += r.graph.pop[b];
      }
      if (!r.accept.includes(sum)) bad.notAccepted++;
      if (t.people !== sum) bad.peopleField++;
      const a = r.assignment.slice(); for (const b of t.blocks) a[b] = r.to;
      const after = piecesPerDistrict(r.graph, a, k);
      if (after[r.from] > before[r.from] || after[r.to] > before[r.to]) bad.newPiece++;
    }
    return out;
  },
};
for (const [seed, side, k, skew] of [[7, 90, 26, 0], [11, 90, 26, 0], [29, 90, 26, 0], [7, 60, 6, 0.3], [3, 120, 12, 0.1]] as const) {
  const map = generateMap({ seed, width: side, height: side, numDistricts: k, skew });
  const res = planGroup({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: range(k), solver: s });
  console.log(`seed=${seed} n=${map.graph.n} k=${k} skew=${skew} status=${res.status} plans=${res.solutions.length}`);
}
console.log(bad);
