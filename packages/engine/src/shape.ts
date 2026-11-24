import type { Assignment, EngineGraph, Transfer } from '@zd/contracts';

export interface TransferShape {
  /** Change in the length of the donor–recipient border, counted once, per person. */
  boundaryDeltaMPerPerson: number;
  /** Share of the chunk's donor/recipient contact that still faces the donor. */
  donorBoundaryShare: number | null;
}

/** Measure a transfer against the assignment immediately before that transfer. */
export function measureTransferShape(
  graph: EngineGraph, assignment: Assignment, { blocks, from, to, people }: Omit<Transfer, 'blocks'> & { blocks: readonly number[] | Uint32Array },
): TransferShape {
  const moved = new Set(blocks);
  let donor = 0;
  let recipient = 0;
  for (const block of blocks) {
    for (let edge = graph.adjOffsets[block]; edge < graph.adjOffsets[block + 1]; edge++) {
      const next = graph.adjTargets[edge];
      const district = assignment[next];
      if (district === to) recipient += graph.adjLen[edge];
      else if (district === from && !moved.has(next)) donor += graph.adjLen[edge];
    }
  }
  return {
    boundaryDeltaMPerPerson: (donor - recipient) / Math.max(1, people),
    donorBoundaryShare: donor + recipient ? donor / (donor + recipient) : null,
  };
}

/**
 * Extra meters charged only when choosing prefixes. A positive perimeter delta
 * on a tiny transfer is a stronger signal than the same delta on a large one.
 * The cap keeps the penalty below a split on the default weights.
 */
export function shapePruneMeters(perimeter: number, people: number): number {
  return Math.min(4500, Math.max(0, perimeter) * 18 / Math.max(1, people));
}

/** A frontier block's support from the recipient and already selected blocks. */
export function growthRank(support: number, shared: number, hop: number): number {
  return (shared ? support / shared : 0) - (hop - 1) * 0.06;
}

/** For the fallback growth variants, calculate attachment from the current selected prefix. */
export function blockGrowthRank(
  graph: EngineGraph, assignment: Assignment, included: Uint8Array,
  block: number, from: number, to: number, hop: number,
): number {
  let support = 0;
  let shared = 0;
  for (let edge = graph.adjOffsets[block]; edge < graph.adjOffsets[block + 1]; edge++) {
    const neighbor = graph.adjTargets[edge];
    const district = assignment[neighbor];
    if (district === from || district === to) shared += graph.adjLen[edge];
    if (district === to || included[neighbor] === 2) support += graph.adjLen[edge];
  }
  return growthRank(support, shared, hop);
}
