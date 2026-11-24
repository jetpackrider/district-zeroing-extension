/** Breaks down the engine solve calls of one whole-map run. npx tsx scripts/calls-engine.ts */
import type { BorderSolver } from '@zd/contracts';
import { planGroup } from '../src/index';
import { generateMap } from '../test/support/synth';
import { range } from '../test/support/check';
const enginePath = new URL('../../engine/src/index.ts', import.meta.url).href;
const { borderSolver } = (await import(/* @vite-ignore */ enginePath)) as { borderSolver: BorderSolver };
const map = generateMap({ seed: 7, width: 540, height: 540, numDistricts: 26, precinctSize: 4, countySize: 60 });
const c = { exact: 0, exactEmpty: 0, probe: 0, probeEmpty: 0, more: 0, msExact: 0, msEmpty: 0 };
const s: BorderSolver = {
  capacity: (r) => borderSolver.capacity(r),
  solve(r) { return this.solveScored(r).map(option => option.transfer); },
  solveScored: (r) => {
    const t = performance.now();
    const out = borderSolver.solveScored(r);
    const ms = performance.now() - t;
    if (r.accept.length > 1) { c.probe++; if (!out.length) c.probeEmpty++; }
    else if ((r.maxOptions ?? 5) > 1) c.more++;
    else { c.exact++; if (!out.length) { c.exactEmpty++; c.msEmpty += ms; } else c.msExact += ms; }
    return out;
  },
};
const res = planGroup({ graph: map.graph, assignment: map.assignment, targets: map.targets, districts: range(26), solver: s });
console.log(res.status, { ...c, msExact: Math.round(c.msExact), msEmpty: Math.round(c.msEmpty) }, 'borders per plan', res.solutions.map((x) => x.borderFlows.length));
