import type { Transfer } from '@zd/contracts';

/** FNV-1a over a string, base 36. */
export function fnv(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** FNV-1a over the districts and blocks of a list of transfers, hex. */
export function hashSolution(transfers: Transfer[]): string {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    h ^= x & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (x >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (x >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (x >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
  };
  for (const t of transfers) {
    mix(t.from); mix(t.to); mix(t.blocks.length);
    for (const b of t.blocks) mix(b);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
