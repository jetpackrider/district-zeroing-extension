/** Compare JSONL captures on identical assignments, with full-graph split and perimeter recounts. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { computeTargets, type EngineGraph, type Solution, type Transfer } from '@zd/contracts';
import { NodeBundleSource } from '../../bundle/src/node';
import { toEngineGraph } from '../../bundle/src/index';
import { landView, measureTransferShape } from '../../engine/src/index';
import { DEFAULT_WEIGHTS, planMetrics } from '../src/index';

interface Row {
  id: string;
  state: string;
  assignment: string;
  status: string;
  ms: number;
  solutions: Array<Pick<Solution, 'kind' | 'stats' | 'transfers'> & { verified: boolean }>;
}

interface ScoredMove {
  from: number;
  to: number;
  people: number;
  blocks: number;
  boundary: number;
  donor: number | null;
}

type Audit = Awaited<ReturnType<typeof audit>>;
const source = new NodeBundleSource(fileURLToPath(new URL('../../../data/', import.meta.url)));
const graphs = new Map<string, EngineGraph>();

async function audit(row: Row) {
  const field = row.id.includes('/D20FA/') ? 'D20FA' : 'D20F';
  const graphKey = `${row.state}/${field}`;
  let graph = graphs.get(graphKey);
  if (!graph) {
    graph = toEngineGraph(await source.loadState(row.state), field);
    graphs.set(graphKey, graph);
  }
  const bytes = Uint8Array.from(gunzipSync(Buffer.from(row.assignment, 'base64')));
  const assignment = new Uint16Array(bytes.buffer);
  const land = landView(graph) ?? graph;
  const k = assignment.reduce((max, d) => Math.max(max, d), 0);
  const targets = computeTargets(graph.pop.reduce((sum, p) => sum + p, 0), k);
  const plans = row.solutions.filter(s => s.verified).map(s => {
    const working = assignment.slice();
    const transfers: Transfer[] = s.transfers.map(t => ({ ...t, blocks: Uint32Array.from(Object.values(t.blocks)) }));
    const moves: ScoredMove[] = transfers.map(t => {
      const shape = measureTransferShape(land, working, t);
      for (const b of t.blocks) working[b] = t.to;
      return {
        from: t.from, to: t.to, people: t.people, blocks: t.blocks.length,
        boundary: shape.boundaryDeltaMPerPerson, donor: shape.donorBoundaryShare,
      };
    });
    const { stats } = planMetrics(graph, assignment, working, transfers, targets, DEFAULT_WEIGHTS, new Set());
    return { kind: s.kind, moves, stats };
  });
  return { ...row, plans };
}

async function load(path: string) {
  const rows: Row[] = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const audited = new Map<string, Audit>();
  for (const row of rows) {
    if (audited.has(row.id)) throw new Error(`Duplicate capture ID: ${row.id}`);
    audited.set(row.id, await audit(row));
  }
  return audited;
}

function scenario(row: Audit) {
  const [test, x, y, z, w] = row.id.split('/');
  if (test === 'sweep') return 'NY CD119 whole-map sweep';
  if (test === 'groups') return 'NY groups';
  if (test === 'fallback') return 'NY shifted target';
  if (test === 'water') return `NY water suite / ${z} / ${w}`;
  if (test === 'real') return x === 'NY' ? `NY ${z} whole map` : `${x} ${z}`;
  throw new Error(`Unknown scenario ${row.id}`);
}

function byScenario(audits: Map<string, Audit>) {
  const grouped = new Map<string, Audit[]>();
  for (const item of audits.values()) {
    if (item.id.startsWith('fallback/planner/')) continue;
    if (item.id.startsWith('fallback/direct/') && !item.plans.length && item.status !== 'already-zero') {
      const planner = audits.get(item.id.replace('/direct/', '/planner/'));
      if (planner) {
        const group = grouped.get(scenario(item)) ?? [];
        group.push({ ...item, ms: item.ms + planner.ms, plans: planner.plans });
        grouped.set(scenario(item), group);
        continue;
      }
    }
    const key = scenario(item);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  return grouped;
}

function quantiles(values: number[], digits = 0) {
  if (!values.length) return '—';
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p: number) => {
    const index = p * (sorted.length - 1);
    const lo = Math.floor(index);
    const value = sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
    return value.toFixed(digits);
  };
  return [0, 0.5, 0.9, 1].map(at).join(' / ');
}

function metrics(rows: Audit[]) {
  const plans = rows.flatMap(r => r.plans);
  const moves = plans.flatMap(s => s.moves);
  return [
    `${rows.filter(r => r.plans.length || r.status === 'already-zero' ||
      (r.id.startsWith('groups/cannot balance') && r.status === 'group-unbalanced')).length}/${rows.length}`,
    String(plans.length),
    quantiles(rows.map(r => r.ms / 1000), 3),
    quantiles(plans.map(s => s.stats.people)),
    quantiles(plans.map(s => s.stats.blocks)),
    quantiles(plans.map(s => s.stats.newPrecinctSplits)),
    quantiles(plans.map(s => s.stats.newTownSplits!)),
    quantiles(plans.map(s => s.stats.newCountySplits)),
    quantiles(plans.map(s => s.stats.perimeterDeltaM / 1000), 2),
    quantiles(moves.map(t => t.boundary), 1),
    quantiles(moves.flatMap(t => t.donor === null ? [] : [100 * t.donor]), 1),
  ];
}

function row(values: string[]) {
  console.log(`| ${values.join(' | ')} |`);
}

function tableHeader() {
  row(['Scenario', 'Version', 'Success', 'Options', 'Seconds', 'People', 'Blocks', 'Precinct splits',
    'Town splits', 'County increases', 'Perimeter km', 'Boundary m/person', 'Donor %']);
  row(Array(13).fill('---'));
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: tsx scripts/tuning-audit.ts BEFORE.ndjson AFTER.ndjson');
const before = await load(beforePath), after = await load(afterPath);
for (const id of before.keys()) {
  if (!after.has(id) && !id.startsWith('fallback/planner/')) throw new Error(`Missing comparison for ${id}`);
}
for (const [id, item] of after) {
  const old = before.get(id);
  if (!old && !id.startsWith('fallback/planner/')) throw new Error(`Missing baseline for ${id}`);
  if (old && old.assignment !== item.assignment) throw new Error(`Assignment differs for ${id}`);
}

console.log('Quantiles are minimum / median / p90 / maximum. Each option contributes plan metrics, and each transfer contributes shape metrics. Times are per original solve request. The infeasible group is counted as a success when rejected.\n');
const first = byScenario(before), second = byScenario(after);
tableHeader();
for (const [name, current] of second) {
  const old = first.get(name);
  if (!old) continue;
  row([name, 'Before', ...metrics(old)]);
  row([name, 'After', ...metrics(current)]);
}
console.log('\n### New York groups by case\n');
tableHeader();
for (const [id, current] of after) {
  if (!id.startsWith('groups/')) continue;
  row([id.slice('groups/'.length), 'Before', ...metrics([before.get(id)!])]);
  row([id.slice('groups/'.length), 'After', ...metrics([current])]);
}

console.log('\n### Whole-map split and spindle incidence\n');
row(['Scenario', 'Version', 'Precinct splits', 'Town splits', 'Plans with town splits', 'County increases',
  'Plans with county increases', 'Donor contact ≥80%', 'Transfers']);
row(Array(9).fill('---'));
for (const [name, current] of second) {
  const old = first.get(name);
  if (!old || name.includes('/ one') || name.startsWith('NY shifted')) continue;
  for (const [label, sample] of [['Before', old], ['After', current]] as const) {
    const plans = sample.flatMap(r => r.plans), moves = plans.flatMap(p => p.moves);
    row([name, label, ...[
      plans.reduce((n, p) => n + p.stats.newPrecinctSplits, 0),
      plans.reduce((n, p) => n + p.stats.newTownSplits!, 0),
      plans.filter(p => p.stats.newTownSplits).length,
      plans.reduce((n, p) => n + p.stats.newCountySplits, 0),
      plans.filter(p => p.stats.newCountySplits).length,
      moves.filter(m => m.donor !== null && m.donor >= 0.8).length,
      moves.length,
    ].map(String)]);
  }
}

console.log('\n### Matched transfer examples on the same border and exact population\n');
const examples: Array<{ id: string; a: ScoredMove; b: ScoredMove }> = [];
for (const [id, current] of after) {
  if (!id.startsWith('sweep/') && !id.startsWith('real/')) continue;
  const old = before.get(id);
  for (const plan of current.plans) {
    const comparable = old?.plans.find(p => p.kind === plan.kind);
    if (!comparable) continue;
    for (const b of plan.moves) {
      const a = comparable.moves.find(t => t.from === b.from && t.to === b.to && t.people === b.people);
      if (a && a.donor !== null && b.donor !== null && a.donor !== b.donor) examples.push({ id, a, b });
    }
  }
}
examples.sort((x, y) => (y.a.donor! - y.b.donor!) - (x.a.donor! - x.b.donor!));
row(['Case', 'Pair', 'People', 'Blocks before → after', 'Boundary m/person before → after', 'Donor % before → after']);
row(Array(6).fill('---'));
const seen = new Set<string>();
for (const { id, a, b } of [...examples.slice(0, 10), ...examples.slice(-4).reverse()]) {
  const key = `${id}/${a.from}/${a.to}/${a.people}`;
  if (seen.has(key)) continue;
  seen.add(key);
  row([id, `${a.from} → ${a.to}`, String(a.people), `${a.blocks} → ${b.blocks}`,
    `${a.boundary.toFixed(1)} → ${b.boundary.toFixed(1)}`, `${(100 * a.donor!).toFixed(1)} → ${(100 * b.donor!).toFixed(1)}`]);
}
