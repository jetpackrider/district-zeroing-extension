import { readFile } from 'node:fs/promises';
import { computeTargets, type Assignment, type EngineGraph } from '@zd/contracts';
import { NodeBundleSource } from '../../bundle/src/node';
import { borderSolver, solveDistrict } from '../src/index';
import { populations } from '../src/model';
import { verifySolution } from '../src/verify';
import { perturb, readAssignment } from './cli-input';
import { seededRandom } from './random';
import { synthetic } from './synthetic';

/** Move seeded, populated border blocks OUT OF `district` into an adjacent neighbor without cutting `district`. */
function perturbUnder(
  graph: EngineGraph, assignment: Assignment, district: number, count: number, seed: number,
) {
  const after = assignment.slice();
  const { n, pop, adjOffsets, adjTargets } = graph;
  const random = seededRandom(seed);
  const candidates: Array<{ b: number; to: number; order: number }> = [];
  for (let b = 0; b < n; b++) {
    if (assignment[b] !== district || pop[b] <= 0) continue;
    const adjNeighbors: number[] = [];
    for (let edge = adjOffsets[b]; edge < adjOffsets[b + 1]; edge++) {
      const d = assignment[adjTargets[edge]];
      if (d && d !== district && !adjNeighbors.includes(d)) adjNeighbors.push(d);
    }
    if (!adjNeighbors.length) continue;
    adjNeighbors.sort((a, b) => a - b);
    const to = adjNeighbors[Math.floor(random() * adjNeighbors.length)];
    candidates.push({ b, to, order: random() });
  }
  candidates.sort((a, b) => a.order - b.order || a.b - b.b);
  const queue = new Uint32Array(n);
  const visited = new Uint32Array(n);
  let visit = 0;
  function safe(block: number) {
    const source = after[block];
    const neighbors = new Set<number>();
    for (let edge = adjOffsets[block]; edge < adjOffsets[block + 1]; edge++) {
      const next = adjTargets[edge];
      if (after[next] === source) neighbors.add(next);
    }
    if (neighbors.size <= 1) return true;
    const start = neighbors.values().next().value!;
    visited[block] = visited[start] = ++visit;
    queue[0] = start;
    neighbors.delete(start);
    let length = 1;
    for (let head = 0; head < length; head++) {
      const current = queue[head];
      for (let edge = adjOffsets[current]; edge < adjOffsets[current + 1]; edge++) {
        const next = adjTargets[edge];
        if (visited[next] === visit || after[next] !== source) continue;
        visited[next] = visit;
        if (neighbors.delete(next) && !neighbors.size) return true;
        queue[length++] = next;
      }
    }
    return false;
  }
  const moved: number[] = [];
  for (const { b, to } of candidates) {
    if (moved.length === count) break;
    if (!safe(b)) continue;
    // Also ensure block still touches `to`
    let touchesTo = false;
    for (let edge = adjOffsets[b]; edge < adjOffsets[b + 1]; edge++) {
      if (after[adjTargets[edge]] === to) { touchesTo = true; break; }
    }
    if (!touchesTo) continue;
    after[b] = to;
    moved.push(b);
  }
  return { assignment: after, moved };
}

function statsSummary(values: number[]) {
  if (!values.length) return { median: 0, p95: 0, max: 0, avg: 0 };
  const s = values.slice().sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length * 0.5)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s[s.length - 1],
    avg: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

async function main() {
  const mode = process.argv[2] ?? 'all';
  const state = await new NodeBundleSource('../../data').loadState('NY');
  const graph: EngineGraph = {
    n: state.n, pop: state.pop.D20F, countyOf: state.countyOf, precinctOf: state.precinctOf,
    adjOffsets: state.adjOffsets, adjTargets: state.adjTargets, adjLen: state.adjLen,
    outerLen: state.outerLen, areaM2: state.areaM2,
  };
  const parsed = readAssignment(await readFile('../../data/NY/fixtures/cd119.csv', 'utf8'), state.geoids);
  const totalPop = graph.pop.reduce((sum, n) => sum + n, 0);
  const targets = computeTargets(totalPop, parsed.numDistricts);

  if (mode === 'all' || mode === 'ny') {
    console.log('=== 1A. NY SWEEP (all 26 districts x over/under x counts [1,3,10] x seeds [16913,42,999]) ===');
    const counts = [1, 3, 10];
    const seeds = [16913, 42, 999];
    const hist = [0, 0, 0, 0, 0, 0];
    const times: number[] = [];
    let total = 0, alreadyZero = 0, verifyFails = 0;
    const failures: Array<Record<string, unknown>> = [];
    const shorts: Array<Record<string, unknown>> = [];
    const byDir: Record<string, { total: number; zero: number; short: number; full: number }> = {
      over: { total: 0, zero: 0, short: 0, full: 0 },
      under: { total: 0, zero: 0, short: 0, full: 0 },
    };
    const byCount: Record<number, { total: number; zero: number; short: number; full: number }> = {};
    for (const c of counts) byCount[c] = { total: 0, zero: 0, short: 0, full: 0 };

    for (let d = 1; d <= parsed.numDistricts; d++) {
      for (const dir of ['over', 'under'] as const) {
        for (const count of counts) {
          for (const seed of seeds) {
            const p = dir === 'over'
              ? perturb(graph, parsed.assignment, d, count, seed)
              : perturbUnder(graph, parsed.assignment, d, count, seed);
            if (p.moved.length !== count) continue;
            const pops = populations(graph, p.assignment);
            const dev = pops[d] - targets.draTarget;
            const t0 = performance.now();
            const res = solveDistrict({ graph, assignment: p.assignment, targets, district: d, maxOptions: 5 });
            const ms = performance.now() - t0;
            if (res.status === 'already-zero') { alreadyZero++; continue; }
            total++;
            times.push(ms);
            for (const sol of res.solutions) {
              const check = verifySolution(graph, p.assignment, targets, sol, { districts: [d], neighborTolerance: 0 });
              if (!check.ok) { verifyFails++; console.error('VERIFY FAIL', { d, dir, count, seed, error: check.error }); }
            }
            const k = Math.min(5, res.solutions.length);
            hist[k]++;
            byDir[dir].total++;
            byCount[count].total++;
            if (k === 0) {
              byDir[dir].zero++;
              byCount[count].zero++;
              failures.push({ d, dir, count, seed, dev, ms: Number(ms.toFixed(1)) });
            } else if (k < 5) {
              byDir[dir].short++;
              byCount[count].short++;
              shorts.push({ d, dir, count, seed, dev, got: k, ms: Number(ms.toFixed(1)) });
            } else {
              byDir[dir].full++;
              byCount[count].full++;
            }
          }
        }
      }
    }
    const ts = statsSummary(times);
    console.log({ total, alreadyZero, verifyFails, hist, byDir, byCount, ms: { median: +ts.median.toFixed(1), p95: +ts.p95.toFixed(1), max: +ts.max.toFixed(1), avg: +ts.avg.toFixed(1) } });
    console.log(`Failures (${failures.length}):`, failures.slice(0, 40));
    console.log(`Shorts sample (${shorts.length} total):`, shorts.slice(0, 30));
  }

  if (mode === 'all' || mode === 'synth') {
    console.log('\n=== 1B. SYNTHETIC SWEEP (14 deviations x 8 seeds = 112 cases) ===');
    const devs = [-4999, -4800, -1237, -487, -37, -5, -1, 1, 5, 37, 487, 1237, 4800, 4999];
    const seeds = [16913, 1, 2, 3, 4, 5, 42, 99];
    const hist = [0, 0, 0, 0, 0, 0];
    const times: number[] = [];
    const failures: Array<Record<string, unknown>> = [];
    const shorts: Array<Record<string, unknown>> = [];
    let verifyFails = 0;

    for (const dev of devs) {
      for (const seed of seeds) {
        const req = synthetic(dev, seed);
        const t0 = performance.now();
        const res = solveDistrict(req);
        const ms = performance.now() - t0;
        times.push(ms);
        for (const sol of res.solutions) {
          const check = verifySolution(req.graph, req.assignment, req.targets, sol, { districts: [req.district], neighborTolerance: 0 });
          if (!check.ok) { verifyFails++; console.error('VERIFY FAIL', { dev, seed, error: check.error }); }
        }
        const k = Math.min(5, res.solutions.length);
        hist[k]++;
        if (k === 0) failures.push({ dev, seed, ms: +ms.toFixed(1) });
        else if (k < 5) shorts.push({ dev, seed, got: k, ms: +ms.toFixed(1) });
      }
    }
    const ts = statsSummary(times);
    console.log({ total: devs.length * seeds.length, verifyFails, hist, ms: { median: +ts.median.toFixed(1), p95: +ts.p95.toFixed(1), max: +ts.max.toFixed(1), avg: +ts.avg.toFixed(1) } });
    console.log(`Failures (${failures.length}):`, failures);
    console.log(`Shorts (${shorts.length}):`, shorts);
  }

  if (mode === 'all' || mode === 'cap') {
    console.log('\n=== 2A. NY BORDER CAPACITY DELIVERABILITY (all directed borders in cd119) ===');
    const pairs = new Set<string>();
    for (let b = 0; b < graph.n; b++) {
      const a = parsed.assignment[b];
      if (!a) continue;
      for (let e = graph.adjOffsets[b]; e < graph.adjOffsets[b + 1]; e++) {
        const c = parsed.assignment[graph.adjTargets[e]];
        if (c && c !== a) pairs.add(`${a}:${c}`);
      }
    }
    const directed = [...pairs].map(s => s.split(':').map(Number) as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const tierStats: Record<string, { tested: number; failed: number }> = {
      'no-split': { tested: 0, failed: 0 },
      low: { tested: 0, failed: 0 },
      high: { tested: 0, failed: 0 },
    };
    const bucketStats: Record<string, { tested: number; failed: number }> = {
      small_1_50: { tested: 0, failed: 0 },
      mid: { tested: 0, failed: 0 },
      near_tier_end: { tested: 0, failed: 0 },
      exact_tier_end: { tested: 0, failed: 0 },
    };
    let bordersWithCap = 0, totalTested = 0, totalFailed = 0, capMsTotal = 0, solveMsTotal = 0;
    const sampleMisses: Array<Record<string, unknown>> = [];

    for (const [from, to] of directed) {
      const ct0 = performance.now();
      const curve = borderSolver.capacity({ graph, assignment: parsed.assignment, from, to });
      capMsTotal += performance.now() - ct0;
      const totalCap = curve.tiers.reduce((s, t) => s + t.people, 0);
      if (totalCap <= 0) continue;
      bordersWithCap++;

      // Build test points tagged by tier and bucket.
      // Cap interior solve tests at 2000 people on giant borders so the sweep stays fast,
      // while testing full range + near-endpoint on borders with totalCap <= 5000.
      const points = new Map<number, { tier: string; bucket: string }>();
      let cum = 0;
      for (const tier of curve.tiers) {
        const lo = cum + 1;
        const hi = cum + tier.people;
        const addPt = (v: number, bucket: string) => {
          if (v >= lo && v <= hi && !points.has(v)) points.set(v, { tier: tier.kind, bucket });
        };
        if (hi <= 5000) {
          addPt(hi, 'exact_tier_end');
          addPt(hi - 1, 'near_tier_end');
          addPt(hi - 2, 'near_tier_end');
          addPt(hi - 5, 'near_tier_end');
        }
        for (const s of [1, 2, 3, 5, 10, 20, 50, 100, 250, 500, 1000, 1500, 2000]) {
          addPt(s, s <= 50 ? 'small_1_50' : 'mid');
        }
        const capHi = Math.min(hi, 2000);
        if (capHi - lo > 4) {
          for (let j = 1; j <= 4; j++) {
            const v = lo + Math.floor((capHi - lo) * j / 5);
            addPt(v, v <= 50 ? 'small_1_50' : 'mid');
          }
        }
        cum = hi;
      }

      for (const [amount, meta] of points) {
        totalTested++;
        tierStats[meta.tier].tested++;
        bucketStats[meta.bucket].tested++;
        const st0 = performance.now();
        const res = borderSolver.solve({ graph, assignment: parsed.assignment, from, to, accept: [amount], maxOptions: 1 });
        solveMsTotal += performance.now() - st0;
        if (res.length === 0) {
          totalFailed++;
          tierStats[meta.tier].failed++;
          bucketStats[meta.bucket].failed++;
          if (sampleMisses.length < 30) {
            sampleMisses.push({ from, to, amount, totalCap, tier: meta.tier, bucket: meta.bucket, tiers: curve.tiers.map(t => `${t.kind}:${t.people}`) });
          }
        }
      }
    }
    console.log({
      directedBorders: directed.length, bordersWithCap, totalTested, totalFailed,
      failPct: +(100 * totalFailed / Math.max(1, totalTested)).toFixed(2),
      avgCapMs: +(capMsTotal / directed.length).toFixed(1),
      avgSolveMs: +(solveMsTotal / Math.max(1, totalTested)).toFixed(1),
      tierStats, bucketStats,
    });
    console.log('Sample capacity misses:', sampleMisses);

    console.log('\n=== 2B. SYNTHETIC BORDER CAPACITY DELIVERABILITY (exhaustive 1..200 + sampled to cap) ===');
    const sreq = synthetic(1237, 16913);
    const spairs: Array<[number, number]> = [[1, 2], [2, 1], [1, 3], [3, 1], [2, 3], [3, 2]];
    for (const [from, to] of spairs) {
      const curve = borderSolver.capacity({ graph: sreq.graph, assignment: sreq.assignment, from, to });
      const totalCap = curve.tiers.reduce((s, t) => s + t.people, 0);
      let tested = 0, failed = 0;
      const misses: number[] = [];
      const toTest = new Set<number>();
      for (let v = 1; v <= Math.min(totalCap, 100); v++) toTest.add(v);
      let cum = 0;
      for (const t of curve.tiers) {
        const lo = cum + 1, hi = cum + t.people;
        const capHi = Math.min(hi, 3000);
        if (hi <= 5000) {
          for (const v of [hi, hi - 1, hi - 2, hi - 5]) {
            if (v >= 1 && v <= totalCap) toTest.add(v);
          }
        }
        for (let j = 1; j <= 10; j++) {
          const v = lo + Math.floor((capHi - lo) * j / 11);
          if (v >= 1 && v <= capHi) toTest.add(v);
        }
        cum = hi;
      }
      for (const amount of [...toTest].sort((a, b) => a - b)) {
        tested++;
        const res = borderSolver.solve({ graph: sreq.graph, assignment: sreq.assignment, from, to, accept: [amount], maxOptions: 1 });
        if (!res.length) { failed++; if (misses.length < 15) misses.push(amount); }
      }
      console.log(`synth ${from}->${to}: totalCap=${totalCap} tiers=${JSON.stringify(curve.tiers.map(t => [t.kind, t.people]))} tested=${tested} failed=${failed} (${(100 * failed / Math.max(1, tested)).toFixed(1)}%) misses=${JSON.stringify(misses)}`);
    }

    console.log('\n=== 2C. PLANNER 26-DISTRICT GRID CAPACITY DELIVERABILITY (exhaustive 1..totalCap on small borders, sampled on larger) ===');
    const { generateMap } = await import('../../planner/test/support/synth');
    const pmap = generateMap({ seed: 7, width: 90, height: 90, numDistricts: 26, precinctSize: 4, countySize: 30 });
    const ppairs = new Set<string>();
    for (let b = 0; b < pmap.graph.n; b++) {
      const a = pmap.assignment[b]; if (!a) continue;
      for (let e = pmap.graph.adjOffsets[b]; e < pmap.graph.adjOffsets[b + 1]; e++) {
        const c = pmap.assignment[pmap.graph.adjTargets[e]];
        if (c && c !== a) ppairs.add(`${a}:${c}`);
      }
    }
    let pTested = 0, pFailed = 0, pBorders = 0;
    const pSampleMisses: Array<Record<string, unknown>> = [];
    for (const s of [...ppairs].sort()) {
      const [from, to] = s.split(':').map(Number);
      const curve = borderSolver.capacity({ graph: pmap.graph, assignment: pmap.assignment, from, to });
      const totalCap = curve.tiers.reduce((acc, t) => acc + t.people, 0);
      if (totalCap <= 0) continue;
      pBorders++;
      const toTest = new Set<number>();
      if (totalCap <= 120) {
        for (let v = 1; v <= totalCap; v++) toTest.add(v);
      } else {
        for (let v = 1; v <= 30; v++) toTest.add(v);
        let cum = 0;
        for (const t of curve.tiers) {
          const lo = cum + 1, hi = cum + t.people;
          for (const v of [hi, hi - 1, hi - 2, hi - 5, Math.floor((lo + hi) / 2)]) {
            if (v >= 1 && v <= totalCap) toTest.add(v);
          }
          for (let j = 1; j <= 8; j++) {
            const v = lo + Math.floor((hi - lo) * j / 9);
            if (v >= 1 && v <= totalCap) toTest.add(v);
          }
          cum = hi;
        }
      }
      for (const amount of toTest) {
        pTested++;
        const res = borderSolver.solve({ graph: pmap.graph, assignment: pmap.assignment, from, to, accept: [amount], maxOptions: 1 });
        if (!res.length) {
          pFailed++;
          if (pSampleMisses.length < 25) pSampleMisses.push({ from, to, amount, totalCap, tiers: curve.tiers.map(t => `${t.kind}:${t.people}`) });
        }
      }
    }
    console.log({ pBorders, pTested, pFailed, failPct: +(100 * pFailed / Math.max(1, pTested)).toFixed(2), pSampleMisses: pSampleMisses.slice(0, 15) });
  }
}

main();
