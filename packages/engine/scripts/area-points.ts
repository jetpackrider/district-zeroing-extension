/**
 * Block points and area masks for the real-data area scripts (scripts/ny-area.ts here and in
 * packages/planner). An area there is a longitude / latitude box, the shape "Use map view" makes;
 * the extension tests each block's point against the ring the user drew, which for a box is the
 * same test.
 *
 * Points come from the bundle's `points` sidecar (the Census internal point of each block, see
 * BundleManifest.points) when the bundle has one. A bundle built before the sidecar existed has
 * none; then each block's point is the centroid of the largest polygon of its geometry, read
 * from the county geometry files. That point can fall outside a strongly concave block, which
 * makes no difference to a box test of this kind.
 */
import type { Assignment, EngineGraph, StateBundle } from '@zd/contracts';
import type { NodeBundleSource } from '../../bundle/src/node';

export interface BlockPoints {
  /** points[2b] = longitude, points[2b + 1] = latitude, in millionths of a degree. */
  points: Int32Array;
  /** Where they came from, for the report. */
  source: 'points sidecar' | 'block geometry centroids';
}

type Ring = number[][];

/** Signed area and centroid of a ring of [lon, lat] (shoelace). */
function ringCentroid(ring: Ring): { area: number; x: number; y: number } {
  let area = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j], [x1, y1] = ring[i];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    x += (x0 + x1) * cross;
    y += (y0 + y1) * cross;
  }
  if (area === 0) {
    // Degenerate: the vertex average.
    const n = ring.length || 1;
    return { area: 0, x: ring.reduce((s, p) => s + p[0], 0) / n, y: ring.reduce((s, p) => s + p[1], 0) / n };
  }
  return { area: area / 2, x: x / (3 * area), y: y / (3 * area) };
}

/** One point per block: the sidecar, or centroids from every county's geometry. */
export async function loadBlockPoints(source: NodeBundleSource, bundle: StateBundle): Promise<BlockPoints> {
  const sidecar = bundle.points;
  if (sidecar && sidecar.length === 2 * bundle.n) return { points: sidecar, source: 'points sidecar' };
  const index = new Map(bundle.geoids.map((geoid, b) => [geoid, b]));
  const points = new Int32Array(2 * bundle.n);
  for (const county of bundle.manifest.counties) {
    const geometry = await source.loadCounty(bundle, county.fips);
    for (const feature of geometry.features) {
      const b = index.get(feature.id);
      if (b === undefined) throw new Error(`Unknown block ${feature.id}`);
      const polygons = (feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates] : feature.geometry.coordinates) as Ring[][];
      let best = { area: -1, x: 0, y: 0 };
      for (const polygon of polygons) {
        const c = ringCentroid(polygon[0]);
        if (Math.abs(c.area) > best.area) best = { ...c, area: Math.abs(c.area) };
      }
      points[2 * b] = Math.round(best.x * 1e6);
      points[2 * b + 1] = Math.round(best.y * 1e6);
    }
  }
  return { points, source: 'block geometry centroids' };
}

/** A box in degrees. */
export interface Box { west: number; south: number; east: number; north: number }

/** inside[b] = 1 when the block's point lies in the box. */
export function boxMask(points: Int32Array, box: Box): Uint8Array {
  const n = points.length / 2;
  const inside = new Uint8Array(n);
  const w = box.west * 1e6, e = box.east * 1e6, s = box.south * 1e6, no = box.north * 1e6;
  for (let b = 0; b < n; b++) {
    const x = points[2 * b], y = points[2 * b + 1];
    if (x >= w && x <= e && y >= s && y <= no) inside[b] = 1;
  }
  return inside;
}

/**
 * A box around part of the border between districts `a` and `b`: the border blocks on both
 * sides, ordered along the border's longer extent, the middle `share` of them, and their bounding
 * box grown by `margin` (as a share of its size, at least ~1 km).
 */
export function borderBox(graph: EngineGraph, assignment: Assignment, points: Int32Array, a: number, b: number, share = 0.4, margin = 0.3): Box | null {
  const border: number[] = [];
  for (let x = 0; x < graph.n; x++) {
    const d = assignment[x];
    if (d !== a && d !== b) continue;
    for (let e = graph.adjOffsets[x]; e < graph.adjOffsets[x + 1]; e++) {
      const other = assignment[graph.adjTargets[e]];
      if (other !== d && (other === a || other === b)) { border.push(x); break; }
    }
  }
  if (!border.length) return null;
  const lon = (x: number) => points[2 * x] / 1e6, lat = (x: number) => points[2 * x + 1] / 1e6;
  const span = (f: (x: number) => number) => Math.max(...border.map(f)) - Math.min(...border.map(f));
  const along = span(lon) >= span(lat) ? lon : lat;
  border.sort((x, y) => along(x) - along(y) || x - y);
  const from = Math.floor(border.length * (0.5 - share / 2));
  const part = border.slice(from, Math.max(from + 1, Math.ceil(border.length * (0.5 + share / 2))));
  const box = {
    west: Math.min(...part.map(lon)), east: Math.max(...part.map(lon)),
    south: Math.min(...part.map(lat)), north: Math.max(...part.map(lat)),
  };
  const dx = Math.max(0.012, (box.east - box.west) * margin), dy = Math.max(0.009, (box.north - box.south) * margin);
  return { west: box.west - dx, east: box.east + dx, south: box.south - dy, north: box.north + dy };
}

/** A box of the given size in degrees centered on a block's point. */
export function boxAround(points: Int32Array, block: number, width: number, height: number): Box {
  const x = points[2 * block] / 1e6, y = points[2 * block + 1] / 1e6;
  return { west: x - width / 2, east: x + width / 2, south: y - height / 2, north: y + height / 2 };
}

/** Blocks and people inside a mask. */
export function maskSummary(graph: EngineGraph, inside: Uint8Array): string {
  let blocks = 0, people = 0;
  for (let b = 0; b < graph.n; b++) if (inside[b]) { blocks++; people += graph.pop[b]; }
  return `${blocks.toLocaleString('en-US')} blocks, ${people.toLocaleString('en-US')} people`;
}
