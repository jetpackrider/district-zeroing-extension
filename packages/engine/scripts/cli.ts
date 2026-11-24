import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { computeTargets, type BundleSource, type EngineGraph, type PopField } from '@zd/contracts';
import { solveDistrict } from '../src/index';
import { verifySolution } from '../src/verify';
import { perturb, readAssignment } from './cli-input';

interface GraphFile {
  geoids: string[];
  graph: EngineGraph;
}

async function loadGraph(path: string, field: PopField): Promise<GraphFile> {
  const directory = (await stat(path)).isDirectory();
  if (directory || basename(path) === 'manifest.json') {
    const statePath = directory ? path : dirname(path);
    const loader = new URL('../../bundle/src/node.ts', import.meta.url);
    try {
      await stat(fileURLToPath(loader));
    } catch {
      throw new Error('The sibling packages/bundle Node loader is not available. Pass a JSON graph instead.');
    }
    const { NodeBundleSource } = await import(loader.href) as {
      NodeBundleSource: new (dataRoot: string) => BundleSource;
    };
    const { geoids, n, pop, countyOf, precinctOf, adjOffsets, adjTargets, adjLen, outerLen, areaM2 } =
      await new NodeBundleSource(dirname(statePath)).loadState(basename(statePath));
    return {
      geoids, graph: { n, pop: pop[field], countyOf, precinctOf, adjOffsets, adjTargets, adjLen, outerLen, areaM2 },
    };
  }
  const data = JSON.parse(await readFile(path, 'utf8'));
  const { geoids, graph: g } = data;
  const { n } = g;
  if (!Number.isSafeInteger(n) || n < 1 || geoids.length !== n ||
      [g.pop, g.countyOf, g.precinctOf, g.outerLen, g.areaM2].some(arr => arr.length !== n) ||
      g.adjOffsets.length !== n + 1 || g.adjTargets.length !== g.adjLen.length ||
      g.adjOffsets[n] !== g.adjTargets.length) {
    throw new Error('JSON graph arrays do not match the declared block and adjacency counts.');
  }
  return { geoids, graph: {
    n, pop: Int32Array.from(g.pop), countyOf: Uint16Array.from(g.countyOf),
    precinctOf: Uint32Array.from(g.precinctOf), outerLen: Uint32Array.from(g.outerLen),
    areaM2: Float32Array.from(g.areaM2), adjOffsets: Uint32Array.from(g.adjOffsets),
    adjTargets: Uint32Array.from(g.adjTargets), adjLen: Uint16Array.from(g.adjLen),
  } };
}

function integer(value: string, flag: string, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`Invalid ${flag}: ${value}`);
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' },
      perturb: { type: 'string', default: '0' },
      seed: { type: 'string', default: '16913' },
      tolerance: { type: 'string', default: '0' },
      options: { type: 'string', default: '5' },
      pop: { type: 'string', default: 'D20F' },
    },
  });
  if (values.help || positionals.length !== 3) {
    console.error('Usage: npm run cli -- <state directory | graph.json> <assignment.csv> <district> ' +
      '[--perturb N] [--seed N] [--tolerance N] [--options N] [--pop D20F|D20FA]');
    if (!values.help) process.exitCode = 1;
    return;
  }
  const [graphPath, csvPath, label] = positionals;
  if (values.pop !== 'D20F' && values.pop !== 'D20FA') throw new Error('Unknown population field.');
  const count = integer(values.perturb, '--perturb');
  const seed = integer(values.seed, '--seed', 0xffff_ffff);
  const neighborTolerance = integer(values.tolerance, '--tolerance');
  const maxOptions = integer(values.options, '--options', 8);
  if (maxOptions < 1) throw new Error('--options must be between 1 and 8.');
  const { graph, geoids } = await loadGraph(resolve(graphPath), values.pop);
  const parsed = readAssignment(await readFile(csvPath, 'utf8'), geoids);
  const district = parsed.districts.get(label) ??
    [...parsed.districts.values()].find(d => String(d) === label);
  if (district === undefined) throw new Error(`Unknown district ${label}.`);
  const { assignment, moved } = count ? perturb(graph, parsed.assignment, district, count, seed) :
    { assignment: parsed.assignment, moved: [] };
  const targets = computeTargets(graph.pop.reduce((sum, n) => sum + n, 0), parsed.numDistricts);
  const start = performance.now();
  const result = solveDistrict({ graph, assignment, targets, district, neighborTolerance, maxOptions });
  const solveMs = performance.now() - start;
  const verifyStart = performance.now();
  for (const solution of result.solutions) {
    const check = verifySolution(graph, assignment, targets, solution, { districts: [district], neighborTolerance });
    if (!check.ok) throw new Error(`Option ${solution.id} failed verification: ${check.error}`);
  }
  const verifyMs = performance.now() - verifyStart;
  const { status, message } = result;
  console.log(JSON.stringify({
    status, message, district, districtLabels: Object.fromEntries(parsed.districts), targets,
    perturbed: moved.map(block => geoids[block]), options: result.solutions.map(solution => ({
      ...solution, transfers: solution.transfers.map(transfer => ({
        ...transfer, blocks: Array.from(transfer.blocks, block => geoids[block]),
      })),
    })),
  }, null, 2));
  console.error(`${result.solutions.length} verified options · solve ${solveMs.toFixed(1)} ms · verify ${verifyMs.toFixed(1)} ms`);
  if (status === 'error' || status === 'needs-precinct-rework') process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
