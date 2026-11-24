import type { PopTargets } from './engine';

/** SPEC.md "Targets": q = floor(P / k); a zeroed district holds q or q + 1; DRA shows deviation against round(P / k). */
export function computeTargets(totalPop: number, numDistricts: number): PopTargets {
  const q = Math.floor(totalPop / numDistricts);
  return {
    totalPop,
    numDistricts,
    q,
    remainder: totalPop - q * numDistricts,
    draTarget: Math.round(totalPop / numDistricts),
  };
}

/** True when a district population counts as zero deviation. */
export function isZeroed(pop: number, targets: PopTargets): boolean {
  return pop === targets.q || (targets.remainder > 0 && pop === targets.q + 1);
}
