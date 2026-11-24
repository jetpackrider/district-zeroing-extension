/**
 * DRA's feature-level block map -> per-block Assignment aligned with the bundle's GEOID order.
 *
 * fullBlockMap() keys come in three shapes (confirmed in draclient.bundle.js):
 *   - a precinct ID                      -> every block in blockMapping.rev(precinct)
 *   - B_{precinct}_{bitset}              -> a split precinct; bitset is base64 bytes, bit i (LSB first)
 *                                          selects rev(precinct)[i] (DRA's ListToBitset)
 *   - a bare 15-digit block GEOID        -> an uncommitted block edit inside a shattered precinct
 *                                          (ShatterManager.blockmap); overrides the two above
 * Legacy `vfeature_{precinct}_{chunk}_{hash}` splits cannot be decoded from the ID alone and are
 * reported as unresolved.
 */

import type { HookBlockMapping } from '../shared/protocol';

export interface LiveMapping {
  stamp: string;
  /** precinct ID -> block indexes (bundle order) in DRA's rev() order. -1 for GEOIDs not in the bundle. */
  blocksOf: Map<string, Int32Array>;
  /** Live precinct index per block, into `precinctIds`. */
  precinctOf: Uint32Array;
  /** Bundle precinct IDs, extended with any precinct only the live mapping knows (updated precincts). */
  precinctIds: string[];
  /** Blocks the live mapping never mentions (keep the bundle's default precinct). */
  unmappedBlocks: number;
  /** GEOIDs in the live mapping that the bundle doesn't have. */
  unknownGeoids: number;
}

export function buildLiveMapping(
  mapping: HookBlockMapping,
  n: number,
  indexOf: (geoid: string) => number,
  bundlePrecinctIds: string[],
  bundlePrecinctOf: Uint32Array,
): LiveMapping {
  const precinctIds = bundlePrecinctIds.slice();
  const pidIndex = new Map<string, number>();
  precinctIds.forEach((p, i) => pidIndex.set(p, i));
  const precinctOf = new Uint32Array(n);
  const seen = new Uint8Array(n);
  const blocksOf = new Map<string, Int32Array>();
  let unknownGeoids = 0;
  for (const [pid, geoids] of Object.entries(mapping.rev)) {
    let pi = pidIndex.get(pid);
    if (pi === undefined) {
      pi = precinctIds.length;
      precinctIds.push(pid);
      pidIndex.set(pid, pi);
    }
    const arr = new Int32Array(geoids.length);
    for (let k = 0; k < geoids.length; k++) {
      const b = indexOf(geoids[k]);
      arr[k] = b;
      if (b < 0) {
        unknownGeoids++;
        continue;
      }
      precinctOf[b] = pi;
      seen[b] = 1;
    }
    blocksOf.set(pid, arr);
  }
  let unmappedBlocks = 0;
  for (let b = 0; b < n; b++) {
    if (!seen[b]) {
      unmappedBlocks++;
      precinctOf[b] = bundlePrecinctOf[b];
    }
  }
  return { stamp: mapping.stamp, blocksOf, precinctOf, precinctIds, unmappedBlocks, unknownGeoids };
}

/** DRA's ListToBitset.fromBitString: base64 -> bytes, bit i of byte floor(i/8) (LSB first) selects list[i]. */
export function decodeBitset<T>(list: ArrayLike<T>, bitset: string): T[] {
  const bin = atob(bitset);
  const out: T[] = [];
  for (let i = 0; i < bin.length; i++) {
    const byte = bin.charCodeAt(i);
    if (!byte) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (1 << bit)) {
        const k = 8 * i + bit;
        if (k < list.length) out.push(list[k]);
      }
    }
  }
  return out;
}

/** Inverse of decodeBitset (used by the fixture and tests). */
export function encodeBitset(list: readonly string[], members: readonly string[]): string {
  const index = new Map(list.map((g, i) => [g, i]));
  const bytes = new Uint8Array(Math.floor((list.length + 7) / 8));
  for (const g of members) {
    const i = index.get(g);
    if (i !== undefined) bytes[i >> 3] |= 1 << (i & 7);
  }
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** DRA's `pc()`: a bare block ID is at least 15 chars and not a vfeature / cfeature. */
export function isBlockId(id: string): boolean {
  return id.length >= 15 && !id.startsWith('B') && !id.startsWith('vfeature') && /^\d+$/.test(id);
}

const SPLIT_RE = /^B_([^_]*)_(.*)$/;

export interface AssignmentResult {
  assignment: Uint16Array;
  /** Feature IDs we could not turn into blocks (legacy vfeatures, unknown precincts). */
  unresolved: string[];
}

export function featureMapToAssignment(
  featureMap: Record<string, number>,
  live: LiveMapping,
  n: number,
  indexOf: (geoid: string) => number,
): AssignmentResult {
  const a = new Uint16Array(n);
  const unresolved: string[] = [];
  const splits: Array<[string, number]> = [];
  const blocks: Array<[string, number]> = [];
  // Pass 1: whole precincts.
  for (const id in featureMap) {
    const d = featureMap[id];
    if (id.startsWith('B_') || id.startsWith('vfeature')) {
      splits.push([id, d]);
      continue;
    }
    const members = live.blocksOf.get(id);
    if (members) {
      for (let k = 0; k < members.length; k++) if (members[k] >= 0) a[members[k]] = d;
    } else if (isBlockId(id)) {
      blocks.push([id, d]);
    } else {
      unresolved.push(id);
    }
  }
  // Pass 2: committed split precincts.
  for (const [id, d] of splits) {
    const m = SPLIT_RE.exec(id);
    const members = m ? live.blocksOf.get(m[1]) : undefined;
    if (!m || !members) {
      unresolved.push(id);
      continue;
    }
    for (const b of decodeBitset(members, m[2])) if (b >= 0) a[b] = d;
  }
  // Pass 3: uncommitted block edits override.
  for (const [id, d] of blocks) {
    const b = indexOf(id);
    if (b >= 0) a[b] = d;
    else unresolved.push(id);
  }
  return { assignment: a, unresolved };
}

/** Population per district (index 0 = unassigned). */
export function districtPops(pop: Int32Array, assignment: Uint16Array, k: number): number[] {
  const out = new Array<number>(k + 1).fill(0);
  for (let b = 0; b < assignment.length; b++) {
    const d = assignment[b];
    if (d <= k) out[d] += pop[b];
  }
  return out;
}
