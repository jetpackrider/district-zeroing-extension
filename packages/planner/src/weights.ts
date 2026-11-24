import type { CostWeights } from '@zd/contracts';

/**
 * Default cost weights. Mirrors the defaults packages/engine uses (src/model.ts) so plan
 * scores line up with single-border option scores. The contracts package has no shared
 * constant for these yet (requested in the planner report).
 */
export const DEFAULT_WEIGHTS: Readonly<CostWeights> = Object.freeze({
  newPrecinctSplit: 100,
  healedPrecinctSplit: -85,
  newCountySplit: 800,
  newTownSplit: 420,
  perStep: 240,
  perBlock: 0.06,
  perPopulatedBlock: 0.08,
  perimeterPerMeter: 0.006,
  neighborDeviation: 0.01,
});

export function resolveWeights(w?: Partial<CostWeights>): CostWeights {
  const out: CostWeights = { ...DEFAULT_WEIGHTS };
  if (w) {
    for (const k of Object.keys(out) as Array<keyof CostWeights>) {
      const v = w[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

/** Monotonic-ish clock that exists in Workers, browsers and Node without DOM/Node typings. */
export function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}
