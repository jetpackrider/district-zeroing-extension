import type { InteractionGraph } from '@zd/contracts';

export interface PositionedNode {
  district: number;
  deviation: number;
  x: number;
  y: number;
}

export interface PositionedEdge {
  a: number;
  b: number;
  cheapAtoB: number;
  cheapBtoA: number;
  maxAtoB: number;
  maxBtoA: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodeRadius: number;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
}

interface Vec2 {
  x: number;
  y: number;
}

/**
 * Deterministic graph layout for InteractionGraph when no geographic coordinates
 * are present in the contract. Handles single nodes, chains (e.g. A -> B -> C),
 * small groups, disconnected components, and 26+ district whole-map graphs.
 *
 * Uses deterministic BFS-ordered initialization, Fruchterman-Reingold force layout,
 * PCA horizontal alignment, and post-layout collision separation so nodes never
 * overlap and shared borders stay legible.
 */
export function computeGraphLayout(graph: InteractionGraph, baseWidth = 360): GraphLayout {
  const sortedNodes = [...graph.nodes].sort((a, b) => a.district - b.district);
  const count = sortedNodes.length;

  if (count === 0) {
    return { width: baseWidth, height: 120, nodeRadius: 18, nodes: [], edges: [] };
  }

  const width = count > 16 ? Math.max(baseWidth, 460) : baseWidth;
  const nodeRadius = count <= 5 ? 20 : count <= 10 ? 17 : count <= 16 ? 14 : 11.5;
  const height = count <= 4 ? 176 : count <= 8 ? 216 : count <= 16 ? 260 : 300;
  const padX = Math.max(nodeRadius + 18, 34);
  const padY = Math.max(nodeRadius + 16, 30);

  const idToIdx = new Map<number, number>();
  sortedNodes.forEach((n, idx) => idToIdx.set(n.district, idx));

  const adj: number[][] = Array.from({ length: count }, () => []);
  const validEdges = graph.edges.filter((e) => idToIdx.has(e.a) && idToIdx.has(e.b) && e.a !== e.b);
  for (const edge of validEdges) {
    const ia = idToIdx.get(edge.a)!;
    const ib = idToIdx.get(edge.b)!;
    if (!adj[ia].includes(ib)) adj[ia].push(ib);
    if (!adj[ib].includes(ia)) adj[ib].push(ia);
  }
  for (const list of adj) list.sort((a, b) => a - b);

  // Split into connected components in deterministic order
  const visited = new Uint8Array(count);
  const components: number[][] = [];
  for (let i = 0; i < count; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const queue = [i];
    visited[i] = 1;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const next of adj[cur]) {
        if (!visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    components.push(comp);
  }

  const rawPos: Vec2[] = Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  const compBoxes: Array<{ comp: number[]; minX: number; maxX: number; minY: number; maxY: number }> = [];

  for (const comp of components) {
    const localPos = alignHorizontalPCA(layoutComponent(comp, adj));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < comp.length; k++) {
      const p = localPos[k];
      rawPos[comp[k]] = p;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    compBoxes.push({ comp, minX, maxX, minY, maxY });
  }

  // Pack multiple components left-to-right with clean spacing
  if (compBoxes.length > 1) {
    let cursorX = 0;
    const gap = 1.6;
    for (const box of compBoxes) {
      const w = Math.max(0.8, box.maxX - box.minX);
      const midY = (box.minY + box.maxY) / 2;
      for (const idx of box.comp) {
        rawPos[idx] = {
          x: rawPos[idx].x - box.minX + cursorX,
          y: rawPos[idx].y - midY,
        };
      }
      cursorX += w + gap;
    }
  }

  // Normalize coordinates into [padX, width - padX] x [padY, height - padY]
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of rawPos) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const availW = Math.max(1, width - padX * 2);
  const availH = Math.max(1, height - padY * 2);

  const pixelPos: Vec2[] = rawPos.map((p) => {
    if (spanX < 1e-6 && spanY < 1e-6) {
      return { x: width / 2, y: height / 2 };
    }
    if (spanY < 1e-4) {
      return {
        x: padX + ((p.x - minX) / Math.max(1e-6, spanX)) * availW,
        y: height / 2,
      };
    }
    if (spanX < 1e-4) {
      return {
        x: width / 2,
        y: padY + ((p.y - minY) / Math.max(1e-6, spanY)) * availH,
      };
    }

    // Fill the canvas cleanly while bounding aspect distortion to <= 1.8x
    const fitX = availW / spanX;
    const fitY = availH / spanY;
    const baseScale = Math.min(fitX, fitY);
    const scaleX = Math.min(fitX, baseScale * 1.85);
    const scaleY = Math.min(fitY, baseScale * 1.85);
    const usedW = spanX * scaleX;
    const usedH = spanY * scaleY;
    const offX = padX + (availW - usedW) / 2;
    const offY = padY + (availH - usedH) / 2;
    return {
      x: offX + (p.x - minX) * scaleX,
      y: offY + (p.y - minY) * scaleY,
    };
  });

  // Deterministic collision separation pass so circles never overlap and edge pills have room
  const desiredGap = count <= 5 ? 44 : count <= 10 ? 28 : count <= 16 ? 16 : 10;
  const minDist = nodeRadius * 2 + desiredGap;
  resolveCollisions(pixelPos, minDist, padX, width - padX, padY, height - padY);

  const positionedNodes: PositionedNode[] = sortedNodes.map((node, i) => ({
    district: node.district,
    deviation: node.deviation,
    x: Math.round(pixelPos[i].x * 10) / 10,
    y: Math.round(pixelPos[i].y * 10) / 10,
  }));

  const posByDistrict = new Map<number, PositionedNode>();
  for (const n of positionedNodes) posByDistrict.set(n.district, n);

  const positionedEdges: PositionedEdge[] = validEdges.map((edge) => {
    const na = posByDistrict.get(edge.a)!;
    const nb = posByDistrict.get(edge.b)!;
    return {
      ...edge,
      x1: na.x,
      y1: na.y,
      x2: nb.x,
      y2: nb.y,
    };
  });

  return {
    width,
    height,
    nodeRadius,
    nodes: positionedNodes,
    edges: positionedEdges,
  };
}

/**
 * Rotates a component around its centroid so its principal axis (maximum variance)
 * runs left-to-right, and keeps the lowest-index node on the left half for stability.
 */
function alignHorizontalPCA(points: Vec2[]): Vec2[] {
  const m = points.length;
  if (m <= 2) return points;

  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= m;
  cy /= m;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  const rotated = points.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return {
      x: dx * cos - dy * sin,
      y: dx * sin + dy * cos,
    };
  });

  // Canonicalize left-to-right polarity: node 0 (smallest district index) sits on left half
  if (rotated[0].x > 0) {
    for (const p of rotated) {
      p.x = -p.x;
      p.y = -p.y;
    }
  }
  return rotated;
}

function resolveCollisions(
  points: Vec2[],
  minDist: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): void {
  const n = points.length;
  if (n <= 1) return;

  for (let iter = 0; iter < 65; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = points[j].x - points[i].x;
        let dy = points[j].y - points[i].y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        moved = true;
        if (dist < 1e-4) {
          dx = (i + j) % 2 === 0 ? 1 : -1;
          dy = (j - i) % 2 === 0 ? 0.5 : -0.5;
          dist = Math.hypot(dx, dy);
        }
        const push = (minDist - dist) * 0.45;
        const ux = (dx / dist) * push;
        const uy = (dy / dist) * push;
        points[i].x = clamp(points[i].x - ux, minX, maxX);
        points[i].y = clamp(points[i].y - uy, minY, maxY);
        points[j].x = clamp(points[j].x + ux, minX, maxX);
        points[j].y = clamp(points[j].y + uy, minY, maxY);
      }
    }
    if (!moved) break;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function layoutComponent(comp: number[], globalAdj: number[][]): Vec2[] {
  const m = comp.length;
  if (m === 1) return [{ x: 0, y: 0 }];
  if (m === 2) {
    return [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];
  }

  const localMap = new Map<number, number>();
  comp.forEach((gIdx, lIdx) => localMap.set(gIdx, lIdx));

  const localAdj: number[][] = Array.from({ length: m }, (_, lIdx) =>
    globalAdj[comp[lIdx]]
      .map((nbr) => localMap.get(nbr))
      .filter((v): v is number => v !== undefined),
  );

  // Detect a simple path (e.g. 4-node chain trading through middle district)
  const degreeOnes = localAdj
    .map((nbrs, idx) => (nbrs.length === 1 ? idx : -1))
    .filter((idx) => idx !== -1);
  const maxDegree = Math.max(...localAdj.map((nbrs) => nbrs.length));

  if (m <= 6 && degreeOnes.length === 2 && maxDegree === 2) {
    const order: number[] = [];
    const seen = new Uint8Array(m);
    let cur = degreeOnes[0];
    while (order.length < m) {
      order.push(cur);
      seen[cur] = 1;
      const next = localAdj[cur].find((n) => !seen[n]);
      if (next === undefined) break;
      cur = next;
    }
    const pos: Vec2[] = Array.from({ length: m }, () => ({ x: 0, y: 0 }));
    order.forEach((lIdx, step) => {
      const t = m > 1 ? step / (m - 1) : 0.5;
      const y = (step % 2 === 0 ? -0.18 : 0.18) * (m >= 4 ? 1 : 0.6);
      pos[lIdx] = { x: (t - 0.5) * (m - 1) * 1.4, y };
    });
    return pos;
  }

  // Deterministic BFS-layered initial placement from lowest-degree peripheral node
  let start = 0;
  for (let i = 1; i < m; i++) {
    if (localAdj[i].length < localAdj[start].length) start = i;
  }
  const depth = new Int32Array(m).fill(-1);
  const layers = new Map<number, number[]>();
  const q = [start];
  depth[start] = 0;
  while (q.length > 0) {
    const cur = q.shift()!;
    const d = depth[cur];
    const list = layers.get(d) ?? [];
    list.push(cur);
    layers.set(d, list);
    for (const next of localAdj[cur]) {
      if (depth[next] === -1) {
        depth[next] = d + 1;
        q.push(next);
      }
    }
  }

  const pos: Vec2[] = Array.from({ length: m }, () => ({ x: 0, y: 0 }));
  for (const [d, nodesInLayer] of layers.entries()) {
    const k = nodesInLayer.length;
    nodesInLayer.forEach((lIdx, idxInLayer) => {
      pos[lIdx] = {
        x: d * 1.4,
        y: (idxInLayer - (k - 1) / 2) * 1.35,
      };
    });
  }

  // Deterministic Fruchterman-Reingold force-directed refinement
  const idealDist = 1.3;
  const iterations = m <= 10 ? 150 : 220;
  const disp: Vec2[] = Array.from({ length: m }, () => ({ x: 0, y: 0 }));

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 0.34 * (1 - iter / iterations) + 0.01;
    for (let i = 0; i < m; i++) {
      disp[i].x = 0;
      disp[i].y = 0;
    }

    // Stronger pairwise repulsion to keep dense graphs open and uncrowded
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-4) {
          dx = ((i - j) % 3 === 0 ? 1 : -1) * 0.03;
          dy = ((i + j) % 2 === 0 ? 1 : -1) * 0.03;
          dist = Math.hypot(dx, dy);
        }
        const force = (idealDist * idealDist * 1.35) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }

    // Edge attraction
    for (let i = 0; i < m; i++) {
      for (const j of localAdj[i]) {
        if (j <= i) continue;
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const dist = Math.max(1e-4, Math.hypot(dx, dy));
        const force = (dist * dist) / (idealDist * 1.25);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x -= fx;
        disp[i].y -= fy;
        disp[j].x += fx;
        disp[j].y += fy;
      }
    }

    // Gentle gravity
    for (let i = 0; i < m; i++) {
      disp[i].x -= pos[i].x * 0.03;
      disp[i].y -= pos[i].y * 0.05;
    }

    for (let i = 0; i < m; i++) {
      const mag = Math.hypot(disp[i].x, disp[i].y);
      if (mag > 1e-6) {
        const step = Math.min(mag, temp);
        pos[i].x += (disp[i].x / mag) * step;
        pos[i].y += (disp[i].y / mag) * step;
      }
    }
  }

  return pos;
}
