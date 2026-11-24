import { solveDistrict } from '../src/index';
import { Model } from '../src/model';
import { borderRing } from '../src/search';
import { verifySolution } from '../src/verify';
import { synthetic } from './synthetic';

const deviations = [37, 487, 1237, 4800, 4999];
const rows = [];
let failed = false;
for (const deviation of deviations) {
  const request = synthetic(deviation);
  const start = performance.now();
  const result = solveDistrict(request);
  const ms = performance.now() - start;
  const verifyStart = performance.now();
  for (const solution of result.solutions) {
    const check = verifySolution(request.graph, request.assignment, request.targets, solution, {
      districts: [request.district], neighborTolerance: 0,
    });
    if (!check.ok) throw new Error(`D=${deviation}: ${check.error}`);
  }
  const verifyMs = performance.now() - verifyStart;
  if (result.solutions.length < 5 || new Set(result.solutions.map(s => s.id)).size !== result.solutions.length ||
      ms + verifyMs >= 1000) failed = true;
  const model = new Model(request.graph, request.assignment);
  const candidates = [3, 6, 10].map(depth => {
    const blocks = new Set<number>();
    for (const neighbor of [2, 3]) {
      const { ring } = borderRing(model, { from: 1, to: neighbor, limit: deviation }, depth);
      for (let b = 0; b < ring.length; b++) if (ring[b]) blocks.add(b);
    }
    return blocks.size;
  });
  rows.push({
    D: deviation, '3 hops': candidates[0], '6 hops': candidates[1], '10 hops': candidates[2],
    Verified: result.solutions.length, 'Solve ms': ms.toFixed(1), 'Verify ms': verifyMs.toFixed(1),
    'Total ms': (ms + verifyMs).toFixed(1),
  });
  if (rows.length === 1) {
    let blocks = 0, empty = 0, cuts = 0;
    const components = new Set<number>();
    for (let b = 0; b < request.graph.n; b++) if (request.assignment[b] === 1) {
      blocks++;
      if (!request.graph.pop[b]) empty++;
      cuts += model.articulation[b];
      components.add(model.component[b]);
    }
    console.log(`Node ${process.version} · target district has ${blocks.toLocaleString('en-US')} blocks, ` +
      `${(100 * empty / blocks).toFixed(1)}% empty, ${components.size} components and ${cuts} articulation blocks`);
  }
}
console.table(rows);
if (failed) process.exitCode = 1;
