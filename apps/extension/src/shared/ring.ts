/**
 * Shape checks on an area outline (a ring of [longitude, latitude], first point not repeated),
 * shared by the page hook (src/hook/area.ts, while the user draws) and the panel
 * (src/panel/area.ts cleanRing, for every ring it keeps). Pure functions; unit-tested in
 * tests/unit/area.test.ts.
 *
 * Why a crossing outline is refused: the panel counts a block inside by the even-odd rule
 * (pointInRing / insideMask), so a part the outline loops around twice (the middle of a star, the
 * overlap of a figure-eight) counts as outside, while the map fills the polygon with earcut, which
 * on a self-crossing ring fills something else. The light fill would then cover blocks the area
 * counts as outside and miss blocks it counts as inside. A simple outline means the same to both.
 */

type Point = readonly [number, number];

/** Sign of the turn a → b → c: 1 left, -1 right, 0 straight. */
function turn(a: Point, b: Point, c: Point): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** c on segment a–b, given the three are in a line. */
function within(a: Point, b: Point, c: Point): boolean {
  return Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
}

/** Segments p1–p2 and p3–p4 cross or touch. */
function segmentsMeet(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = turn(p3, p4, p1);
  const d2 = turn(p3, p4, p2);
  const d3 = turn(p1, p2, p3);
  const d4 = turn(p1, p2, p4);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && within(p3, p4, p1)) || (d2 === 0 && within(p3, p4, p2)) || (d3 === 0 && within(p1, p2, p3)) || (d4 === 0 && within(p1, p2, p4));
}

/**
 * True when two edges of the closed ring that are not next to each other cross or touch (a
 * figure-eight, a star drawn in one stroke, an edge running back over another). Edges next to
 * each other share a corner and are not compared. O(k²) in the corners: a drawn outline has a
 * handful, and cleanRing allows at most 2000.
 */
export function ringSelfCrosses(ring: readonly Point[]): boolean {
  const k = ring.length;
  if (k < 4) return false; // a triangle cannot cross itself
  for (let i = 0; i < k; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % k];
    for (let j = i + 2; j < k; j++) {
      if (i === 0 && j === k - 1) continue; // the closing edge is next to the first
      if (segmentsMeet(a, b, ring[j], ring[(j + 1) % k])) return true;
    }
  }
  return false;
}

/** The ring's area in square degrees (shoelace; positive whichever way it runs). */
export function ringArea(ring: readonly Point[]): number {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(twice) / 2;
}
