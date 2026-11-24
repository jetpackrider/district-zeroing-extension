import { computeTargets, type EngineGraph } from '@zd/contracts';

import { seededRandom } from './random';

// Rook graph of a mosaic of irregular blocks. A deformation of the grid preserves
// planarity; deleted cells, narrowed channels and separating water keep its topology irregular.
export function synthetic(deviation: number, seed = 16913) {
  const random = seededRandom(seed);
  const width = 214, height = 308;
  const cells = new Int32Array(width * height).fill(-1);
  const points: Array<{ x: number; y: number }> = [];
  const labels: number[] = [];
  function add(x: number, y: number, district: number) {
    cells[y * width + x] = points.length;
    points.push({ x, y });
    labels.push(district);
  }
  for (let y = 0; y < height; y++) {
    const curve = Math.floor(4 * Math.sin(y / 9)) + Math.floor(2 * Math.cos(y / 4));
    for (let x = 0; x < width; x++) {
      // Inland holes, an offshore island, and a narrow, single-access peninsula.
      if ((x >= 84 && x < 94 && y >= 147 && y < 155) ||
          (x >= 142 && x < 149 && y >= 180 && y < 186) ||
          (x >= 33 && x < 40 && y >= 103 && y < 113 && !(y === 108 && x >= 36))) continue;
      const core = y >= 68 && y < 238 && x >= 40 + curve && x < 172 + curve;
      const island = x >= 133 && x < 138 && y >= 57 && y < 61;
      const peninsula = y === 108 && x >= 36 && x < 40;
      add(x, y, core || island || peninsula ? 1 : y < 153 ? 2 : 3);
    }
  }
  const n = points.length;
  const assignment = Uint16Array.from(labels);
  const pop = new Int32Array(n);
  const countyOf = new Uint16Array(n);
  const precinctOf = new Uint32Array(n);
  const adjOffsets = new Uint32Array(n + 1);
  const outerLen = new Uint32Array(n);
  const areaM2 = new Float32Array(n);
  const blockLengths = Uint16Array.from({ length: n }, () => 50 + Math.floor(random() * 190));
  const adjTargets: number[] = [];
  const adjLen: number[] = [];
  const zeroOrder: Array<{ b: number; key: number }> = [];
  const districts = [[], [], [], []] as number[][];
  const totals = [0, 0, 0, 0];

  for (let b = 0; b < n; b++) {
    const { x, y } = points[b];
    const d = assignment[b];
    if (d === 1) zeroOrder.push({ b, key: random() });
    else if (random() >= 0.4) pop[b] = population(random);
    countyOf[b] = Math.floor((x + y / 12) / 60);
    const band = Math.floor(y / 6);
    precinctOf[b] = band * 40 + Math.floor((x + 3 * (band % 2)) / 6);
    areaM2[b] = blockLengths[b] ** 2;
    for (const [dx, dy] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) {
      const xx = x + dx, yy = y + dy;
      const neighbor = xx < 0 || xx >= width || yy < 0 || yy >= height ? -1 : cells[yy * width + xx];
      if (neighbor < 0) {
        outerLen[b] += blockLengths[b];
      } else {
        adjTargets.push(neighbor);
        adjLen.push(Math.min(blockLengths[b], blockLengths[neighbor]));
      }
    }
    adjOffsets[b + 1] = adjTargets.length;
  }
  zeroOrder.sort((a, b) => a.key - b.key || a.b - b.b);
  for (const { b } of zeroOrder.slice(Math.round(zeroOrder.length * 0.4))) pop[b] = population(random);
  for (let b = 0; b < n; b++) {
    const d = assignment[b];
    totals[d] += pop[b];
    const { x, y } = points[b];
    // Population calibration is well away from the search ring and keeps each positive block small.
    const interior = d === 1 ? x > 60 && x < 150 && y > 88 && y < 218 : y < 44 || y > 263;
    if (pop[b] > 0 && interior) districts[d].push(b);
  }
  const q = totals[1];
  const goals = [0, q + deviation, q - Math.floor(deviation / 2), q - Math.ceil(deviation / 2)];
  for (let d = 1; d <= 3; d++) {
    let delta = goals[d] - totals[d];
    for (let i = 0; delta; i = (i + 1) % districts[d].length) {
      const block = districts[d][i];
      if (delta < 0 && pop[block] === 1) continue;
      const step = Math.sign(delta);
      pop[block] += step;
      delta -= step;
    }
  }
  const graph: EngineGraph = {
    n, pop, countyOf, precinctOf, adjOffsets, adjTargets: Uint32Array.from(adjTargets),
    adjLen: Uint16Array.from(adjLen), outerLen, areaM2,
  };
  return { graph, assignment, district: 1, targets: computeTargets(q * 3, 3) };
}

function population(random: () => number) {
  // Many small counts, with an occasional apartment block.
  return 1 + Math.floor(random() ** 2 * 50) + (random() < 0.025 ? Math.floor(random() * 100) : 0);
}
