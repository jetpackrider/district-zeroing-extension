import type {
  DeviationChange,
  DistrictRow,
  InteractionGraph,
  MapInfo,
  PanelState,
  SolutionCard,
  WalkthroughStep,
} from '@zd/contracts';

export const NY_MAP_INFO: MapInfo = {
  state: 'NY',
  planName: 'NY Congressional 2026 Draft',
  numDistricts: 26,
  popField: 'D20FA',
  totalPop: 20201249,
  target: 776971,
};

const DRA_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#e11d48',
  '#0ea5e9', '#a855f7', '#22c55e', '#eab308', '#d946ef', '#64748b',
  '#fb7185', '#2dd4bf', '#facc15', '#818cf8', '#34d399', '#fb923c',
  '#38bdf8', '#c084fc',
];

/**
 * 26-district NY-scale adjacency map (planar-ish corridor + metro cluster).
 * Deviations sum to +3 (since 20,201,249 = 26 * 776,971 + 3).
 */
const NY_26_SPEC: Array<{ index: number; dev: number; neighbors: number[] }> = [
  { index: 1, dev: 520, neighbors: [2, 3] },
  { index: 2, dev: 410, neighbors: [1, 3, 4] },
  { index: 3, dev: 310, neighbors: [1, 2, 4, 5] },
  { index: 4, dev: 410, neighbors: [2, 3, 5, 7] },
  { index: 5, dev: -680, neighbors: [3, 4, 6, 7] },
  { index: 6, dev: 185, neighbors: [5, 7, 8, 10] },
  { index: 7, dev: 0, neighbors: [4, 5, 6, 8, 9, 11] },
  { index: 8, dev: -340, neighbors: [6, 7, 9, 10] },
  { index: 9, dev: -205, neighbors: [7, 8, 11, 12] },
  { index: 10, dev: 260, neighbors: [6, 8, 12, 13] },
  { index: 11, dev: -205, neighbors: [7, 9, 12, 14] },
  { index: 12, dev: -380, neighbors: [9, 10, 11, 13, 14, 15] },
  { index: 13, dev: 412, neighbors: [10, 12, 15, 16] },
  { index: 14, dev: -145, neighbors: [11, 12, 15, 17] },
  { index: 15, dev: 95, neighbors: [12, 13, 14, 16, 17, 18] },
  { index: 16, dev: -275, neighbors: [13, 15, 18, 19] },
  { index: 17, dev: 320, neighbors: [14, 15, 18, 20] },
  { index: 18, dev: -190, neighbors: [15, 16, 17, 19, 20, 21] },
  { index: 19, dev: 155, neighbors: [16, 18, 21, 22] },
  { index: 20, dev: -85, neighbors: [17, 18, 21, 23] },
  { index: 21, dev: 240, neighbors: [18, 19, 20, 22, 23, 24] },
  { index: 22, dev: -310, neighbors: [19, 21, 24, 25] },
  { index: 23, dev: 140, neighbors: [20, 21, 24, 26] },
  { index: 24, dev: -225, neighbors: [21, 22, 23, 25, 26] },
  { index: 25, dev: -115, neighbors: [22, 24, 26] },
  { index: 26, dev: -294, neighbors: [23, 24, 25] },
];

export function makeNYDistricts(overrides?: Record<number, number>): DistrictRow[] {
  return NY_26_SPEC.map((spec) => {
    const dev = overrides?.[spec.index] ?? spec.dev;
    return {
      index: spec.index,
      label: String(spec.index),
      pop: NY_MAP_INFO.target + dev,
      deviation: dev,
      color: DRA_COLORS[(spec.index - 1) % DRA_COLORS.length],
      neighbors: [...spec.neighbors],
    };
  });
}

export function buildInteractionForDistricts(
  districts: DistrictRow[],
  selectedIndexes: number[],
): InteractionGraph {
  const set = new Set(selectedIndexes);
  const nodes = districts
    .filter((d) => set.has(d.index))
    .map((d) => ({ district: d.index, deviation: d.deviation }));

  const edges: InteractionGraph['edges'] = [];
  const seen = new Set<string>();
  for (const d of districts) {
    if (!set.has(d.index) || !d.neighbors) continue;
    for (const nbr of d.neighbors) {
      if (!set.has(nbr)) continue;
      const a = Math.min(d.index, nbr);
      const b = Math.max(d.index, nbr);
      const key = `${a}-${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Deterministic realistic capacities per border
      const seed = (a * 31 + b * 17) % 10;
      const cheapAtoB = 180 + seed * 55;
      const cheapBtoA = 160 + ((seed + 3) % 10) * 50;
      edges.push({
        a,
        b,
        cheapAtoB,
        cheapBtoA,
        maxAtoB: cheapAtoB + 950 + seed * 120,
        maxBtoA: cheapBtoA + 900 + ((seed + 4) % 10) * 110,
      });
    }
  }
  return { nodes, edges };
}

export const SINGLE_DISTRICT_SOLUTIONS: SolutionCard[] = [
  {
    id: 'opt-1',
    kind: 'single',
    stats: {
      people: 412,
      blocks: 6,
      populatedBlocks: 5,
      newPrecinctSplits: 0,
      healedPrecinctSplits: 1,
      newCountySplits: 0,
      newTownSplits: 1,
      perimeterDeltaM: -184,
      districtsTouched: 2,
      cost: 18,
      steps: 2,
    },
    borderFlows: [{ from: 13, to: 12, people: 412 }],
    deviations: [
      { district: 13, before: 412, after: 0 },
      { district: 12, before: -380, after: 32 },
    ],
  },
  {
    id: 'opt-2',
    kind: 'single',
    stats: {
      people: 412,
      blocks: 9,
      populatedBlocks: 8,
      newPrecinctSplits: 1,
      healedPrecinctSplits: 0,
      newCountySplits: 0,
      perimeterDeltaM: -42,
      districtsTouched: 2,
      cost: 124,
      steps: 3,
    },
    borderFlows: [{ from: 13, to: 16, people: 412 }],
    deviations: [
      { district: 13, before: 412, after: 0 },
      { district: 16, before: -275, after: 137 },
    ],
  },
  {
    id: 'opt-3',
    kind: 'single',
    stats: {
      people: 411,
      blocks: 5,
      populatedBlocks: 5,
      newPrecinctSplits: 1,
      healedPrecinctSplits: 0,
      newCountySplits: 0,
      perimeterDeltaM: 138,
      districtsTouched: 2,
      cost: 162,
      steps: 2,
    },
    borderFlows: [{ from: 13, to: 12, people: 411 }],
    deviations: [
      { district: 13, before: 412, after: 1 },
      { district: 12, before: -380, after: 31 },
    ],
  },
  {
    id: 'opt-4',
    kind: 'single',
    stats: {
      people: 412,
      blocks: 14,
      populatedBlocks: 11,
      newPrecinctSplits: 2,
      healedPrecinctSplits: 0,
      newCountySplits: 1,
      perimeterDeltaM: 520,
      districtsTouched: 2,
      cost: 540,
      steps: 5,
      longReach: true,
    },
    borderFlows: [{ from: 13, to: 10, people: 412 }],
    deviations: [
      { district: 13, before: 412, after: 0 },
      { district: 10, before: 260, after: 672 },
    ],
  },
];

/**
 * Mock options for one district when the user picked which neighbors trade with it: one option per
 * picked neighbor taking (or giving) the whole difference, plus one split between the first two.
 */
export function makeChosenNeighborOptions(districts: DistrictRow[], district: number, withList: number[]): SolutionCard[] {
  const row = districts.find((d) => d.index === district);
  if (!row || withList.length === 0) return [];
  const people = Math.abs(row.deviation);
  const over = row.deviation > 0;
  const flow = (nbr: number, n: number) => (over ? { from: district, to: nbr, people: n } : { from: nbr, to: district, people: n });
  const devOf = (nbr: number) => districts.find((d) => d.index === nbr)?.deviation ?? 0;
  const stats = (blocks: number, steps: number, splits: number, touched: number, cost: number) => ({
    people, blocks, populatedBlocks: Math.max(1, blocks - 1), newPrecinctSplits: splits, healedPrecinctSplits: 0,
    newCountySplits: 0, perimeterDeltaM: -40 + blocks * 9, districtsTouched: touched, cost, steps,
  });
  // Unassigned (0) has no deviation, so it never gets a deviation row.
  const devRow = (nbr: number, after: number): DeviationChange[] =>
    nbr === 0 ? [] : [{ district: nbr, before: devOf(nbr), after }];
  const cards: SolutionCard[] = withList.map((nbr, i) => ({
    id: `opt-${district}-to-${nbr}`,
    kind: 'single',
    stats: stats(4 + i * 3 + (nbr % 3), 2 + i + (nbr % 2), i === 0 ? 0 : 1, 2, 20 + i * 90),
    borderFlows: [flow(nbr, people)],
    deviations: [{ district, before: row.deviation, after: 0 }, ...devRow(nbr, devOf(nbr) + row.deviation)],
  }));
  if (withList.length >= 2) {
    const [a, b] = withList;
    const first = Math.round(people * 0.6);
    const sign = over ? 1 : -1;
    cards.push({
      id: `opt-${district}-split-${a}-${b}`,
      kind: 'single',
      stats: stats(11, 5, 1, 3, 210),
      borderFlows: [flow(a, first), flow(b, people - first)],
      deviations: [
        { district, before: row.deviation, after: 0 },
        ...devRow(a, devOf(a) + sign * first),
        ...devRow(b, devOf(b) + sign * (people - first)),
      ].sort((x, y) => x.district - y.district),
    });
  }
  return cards;
}

/**
 * 4-district chain: 4 (+410) -> 7 (0) -> 9 (-205) and 7 -> 11 (-205).
 * District 4 does NOT touch 9 or 11; it must trade through middle District 7.
 */
export const GROUP_CHAIN_INTERACTION: InteractionGraph = {
  nodes: [
    { district: 4, deviation: 410 },
    { district: 7, deviation: 0 },
    { district: 9, deviation: -205 },
    { district: 11, deviation: -205 },
  ],
  edges: [
    { a: 4, b: 7, cheapAtoB: 480, cheapBtoA: 310, maxAtoB: 1850, maxBtoA: 1420 },
    { a: 7, b: 9, cheapAtoB: 260, cheapBtoA: 240, maxAtoB: 1220, maxBtoA: 1190 },
    { a: 7, b: 11, cheapAtoB: 290, cheapBtoA: 215, maxAtoB: 1380, maxBtoA: 1040 },
    { a: 9, b: 11, cheapAtoB: 150, cheapBtoA: 140, maxAtoB: 820, maxBtoA: 780 },
  ],
};

export const GROUP_CHAIN_SOLUTIONS: SolutionCard[] = [
  {
    id: 'plan-splits',
    kind: 'fewest-splits',
    stats: {
      people: 820,
      blocks: 14,
      populatedBlocks: 12,
      newPrecinctSplits: 1,
      healedPrecinctSplits: 1,
      newCountySplits: 0,
      perimeterDeltaM: -210,
      districtsTouched: 4,
      cost: 115,
      steps: 6,
    },
    borderFlows: [
      { from: 4, to: 7, people: 410 },
      { from: 7, to: 9, people: 205 },
      { from: 7, to: 11, people: 205 },
    ],
    deviations: [
      { district: 4, before: 410, after: 0 },
      { district: 7, before: 0, after: 0 },
      { district: 9, before: -205, after: 0 },
      { district: 11, before: -205, after: 0 },
    ],
  },
  {
    id: 'plan-blocks',
    kind: 'fewest-blocks',
    stats: {
      people: 820,
      blocks: 9,
      populatedBlocks: 9,
      newPrecinctSplits: 3,
      healedPrecinctSplits: 0,
      newCountySplits: 0,
      perimeterDeltaM: 88,
      districtsTouched: 4,
      cost: 326,
      steps: 5,
    },
    borderFlows: [
      { from: 4, to: 7, people: 410 },
      { from: 7, to: 9, people: 265 },
      { from: 9, to: 11, people: 60 },
      { from: 7, to: 11, people: 145 },
    ],
    deviations: [
      { district: 4, before: 410, after: 0 },
      { district: 7, before: 0, after: 0 },
      { district: 9, before: -205, after: 0 },
      { district: 11, before: -205, after: 0 },
    ],
  },
  {
    id: 'plan-districts',
    kind: 'fewest-districts',
    stats: {
      people: 820,
      blocks: 16,
      populatedBlocks: 13,
      newPrecinctSplits: 2,
      healedPrecinctSplits: 0,
      newCountySplits: 0,
      perimeterDeltaM: -65,
      districtsTouched: 4,
      cost: 240,
      steps: 7,
    },
    borderFlows: [
      { from: 4, to: 7, people: 410 },
      { from: 7, to: 9, people: 410 },
      { from: 9, to: 11, people: 205 },
    ],
    deviations: [
      { district: 4, before: 410, after: 0 },
      { district: 7, before: 0, after: 0 },
      { district: 9, before: -205, after: 0 },
      { district: 11, before: -205, after: 0 },
    ],
  },
];

function makeWholeMapSolutions(districts: DistrictRow[]): SolutionCard[] {
  const allDeviations: DeviationChange[] = districts.map((d, idx) => ({
    district: d.index,
    before: d.deviation,
    after: idx < 3 ? 1 : 0, // 3 remainder districts land at +1 (q+1), matching 20,201,249 mod 26 = 3
  }));

  const flowsSplits = [
    { from: 1, to: 3, people: 519 },
    { from: 2, to: 4, people: 409 },
    { from: 3, to: 5, people: 828 },
    { from: 4, to: 7, people: 819 },
    { from: 6, to: 5, people: 185 },
    { from: 7, to: 5, people: 333 },
    { from: 7, to: 8, people: 340 },
    { from: 7, to: 9, people: 146 },
    { from: 10, to: 12, people: 260 },
    { from: 13, to: 12, people: 412 },
    { from: 12, to: 9, people: 59 },
    { from: 12, to: 11, people: 205 },
    { from: 12, to: 14, people: 28 },
    { from: 15, to: 14, people: 95 },
    { from: 17, to: 14, people: 22 },
    { from: 17, to: 18, people: 298 },
    { from: 18, to: 16, people: 108 },
    { from: 19, to: 16, people: 167 },
    { from: 21, to: 20, people: 85 },
    { from: 21, to: 22, people: 155 },
    { from: 23, to: 26, people: 140 },
    { from: 24, to: 22, people: 155 },
  ];

  return [
    {
      id: 'whole-splits',
      kind: 'fewest-splits',
      stats: {
        people: 5568,
        blocks: 94,
        populatedBlocks: 81,
        newPrecinctSplits: 8,
        healedPrecinctSplits: 3,
        newCountySplits: 0,
        perimeterDeltaM: -1340,
        districtsTouched: 26,
        cost: 920,
        steps: 79,
      },
      borderFlows: flowsSplits,
      deviations: allDeviations,
    },
    {
      id: 'whole-blocks',
      kind: 'fewest-blocks',
      stats: {
        people: 5412,
        blocks: 68,
        populatedBlocks: 64,
        newPrecinctSplits: 15,
        healedPrecinctSplits: 1,
        newCountySplits: 1,
        perimeterDeltaM: 420,
        districtsTouched: 26,
        cost: 1680,
        steps: 64,
      },
      borderFlows: flowsSplits.slice(0, 18),
      deviations: allDeviations,
    },
    {
      id: 'whole-districts',
      kind: 'fewest-districts',
      stats: {
        people: 5890,
        blocks: 106,
        populatedBlocks: 92,
        newPrecinctSplits: 11,
        healedPrecinctSplits: 2,
        newCountySplits: 0,
        perimeterDeltaM: -480,
        districtsTouched: 25,
        cost: 1190,
        steps: 71,
      },
      borderFlows: flowsSplits.slice(0, 16),
      deviations: allDeviations,
    },
  ];
}

/**
 * 26-district NY plans containing realistic two-way border trades (e.g. 9 ⇄ 8: 25 and 23
 * for a net of 2; 15 ⇄ 14: 48 and 37 for a net of 11). Also demonstrates `solutionBadges`:
 * Plan 1 (`fewest-splits`) actually moves fewer blocks than Plan 2 (`fewest-blocks`).
 */
export function makeTwoWayWholeMapSolutions(districts: DistrictRow[]): SolutionCard[] {
  const allDeviations: DeviationChange[] = districts.map((d, idx) => ({
    district: d.index,
    before: d.deviation,
    after: idx < 3 ? 1 : 0,
  }));

  const flowsPlan1 = [
    { from: 9, to: 8, people: 25 },
    { from: 8, to: 9, people: 23 },
    { from: 15, to: 14, people: 48 },
    { from: 14, to: 15, people: 37 },
    { from: 1, to: 3, people: 519 },
    { from: 2, to: 4, people: 409 },
    { from: 3, to: 5, people: 828 },
    { from: 4, to: 7, people: 819 },
    { from: 6, to: 5, people: 185 },
    { from: 7, to: 8, people: 338 },
    { from: 10, to: 12, people: 260 },
    { from: 13, to: 12, people: 412 },
    { from: 12, to: 11, people: 205 },
    { from: 17, to: 18, people: 298 },
    { from: 19, to: 16, people: 167 },
    { from: 21, to: 22, people: 155 },
    { from: 23, to: 26, people: 140 },
  ];

  const flowsPlan2 = [
    { from: 9, to: 8, people: 31 },
    { from: 8, to: 9, people: 29 },
    { from: 1, to: 3, people: 519 },
    { from: 2, to: 4, people: 409 },
    { from: 3, to: 5, people: 828 },
    { from: 4, to: 7, people: 819 },
    { from: 7, to: 8, people: 338 },
    { from: 13, to: 12, people: 412 },
    { from: 15, to: 14, people: 95 },
    { from: 17, to: 18, people: 298 },
    { from: 21, to: 22, people: 155 },
    { from: 23, to: 26, people: 140 },
  ];

  return [
    {
      id: 'twoway-plan-1',
      kind: 'fewest-splits',
      stats: {
        people: 5624,
        blocks: 78,
        populatedBlocks: 71,
        newPrecinctSplits: 6,
        healedPrecinctSplits: 3,
        newCountySplits: 0,
        perimeterDeltaM: -1120,
        districtsTouched: 26,
        cost: 840,
        steps: 58,
      },
      borderFlows: flowsPlan1,
      deviations: allDeviations,
    },
    {
      id: 'twoway-plan-2',
      kind: 'fewest-blocks',
      stats: {
        people: 5710,
        blocks: 84,
        populatedBlocks: 79,
        newPrecinctSplits: 9,
        healedPrecinctSplits: 1,
        newCountySplits: 1,
        perimeterDeltaM: 290,
        districtsTouched: 26,
        cost: 1280,
        steps: 66,
      },
      borderFlows: flowsPlan2,
      deviations: allDeviations,
    },
    {
      id: 'twoway-plan-3',
      kind: 'fewest-districts',
      stats: {
        people: 5830,
        blocks: 92,
        populatedBlocks: 83,
        newPrecinctSplits: 8,
        healedPrecinctSplits: 2,
        newCountySplits: 0,
        perimeterDeltaM: -310,
        districtsTouched: 24,
        cost: 1090,
        steps: 61,
      },
      borderFlows: flowsPlan2.slice(0, 10),
      deviations: allDeviations,
    },
  ];
}

export const TWO_WAY_WALKTHROUGH_SOLUTION: SolutionCard = {
  id: 'twoway-9-8',
  kind: 'fewest-splits',
  stats: {
    people: 48,
    blocks: 7,
    populatedBlocks: 7,
    newPrecinctSplits: 0,
    healedPrecinctSplits: 1,
    newCountySplits: 0,
    perimeterDeltaM: -64,
    districtsTouched: 2,
    cost: 42,
    steps: 4,
  },
  borderFlows: [
    { from: 9, to: 8, people: 25 },
    { from: 8, to: 9, people: 23 },
  ],
  deviations: [
    { district: 9, before: 2, after: 0 },
    { district: 8, before: -2, after: 0 },
  ],
};

export function makeTwoWayWalkthroughSteps(): WalkthroughStep[] {
  return [
    {
      id: 'tw-step-1',
      from: 9,
      to: 8,
      precinctId: '36047-0812',
      wholePrecinct: false,
      status: 'active',
      blocks: [
        { geoid: '360470812001001', number: 1, people: 8, done: false },
        { geoid: '360470812001004', number: 2, people: 6, done: false },
      ],
    },
    {
      id: 'tw-step-2',
      from: 9,
      to: 8,
      precinctId: '36047-0815',
      wholePrecinct: false,
      status: 'pending',
      blocks: [
        { geoid: '360470815002003', number: 1, people: 11, done: false },
      ],
    },
    {
      id: 'tw-step-3',
      from: 8,
      to: 9,
      precinctId: '36047-0820',
      wholePrecinct: false,
      status: 'pending',
      blocks: [
        { geoid: '360470820001002', number: 1, people: 7, done: false },
        { geoid: '360470820001005', number: 2, people: 6, done: false },
      ],
    },
    {
      id: 'tw-step-4',
      from: 8,
      to: 9,
      precinctId: '36047-0824',
      wholePrecinct: false,
      status: 'pending',
      blocks: [
        { geoid: '360470824003001', number: 1, people: 5, done: false },
        { geoid: '360470824003004', number: 2, people: 5, done: false },
      ],
    },
  ];
}

export function makeChainWalkthroughSteps(): WalkthroughStep[] {
  return [
    {
      id: 'step-1',
      from: 4,
      to: 7,
      precinctId: '36059-0118',
      wholePrecinct: false,
      status: 'done',
      blocks: [
        { geoid: '360594068011002', number: 1, people: 72, done: true },
        { geoid: '360594068011005', number: 2, people: 68, done: true },
        { geoid: '360594068011008', number: 3, people: 55, done: true },
      ],
    },
    {
      id: 'step-2',
      from: 4,
      to: 7,
      precinctId: '36059-0124',
      wholePrecinct: false,
      status: 'active',
      blocks: [
        { geoid: '360594071022001', number: 1, people: 64, done: true },
        { geoid: '360594071022004', number: 2, people: 58, done: false },
        { geoid: '360594071022007', number: 3, people: 49, done: false },
        { geoid: '360594071022011', number: 4, people: 44, done: false },
      ],
    },
    {
      id: 'step-3',
      from: 7,
      to: 9,
      precinctId: '36047-0412',
      wholePrecinct: true,
      status: 'pending',
      blocks: [
        { geoid: '360470412001000', number: 1, people: 112, done: false },
        { geoid: '360470412001001', number: 2, people: 93, done: false },
      ],
    },
    {
      id: 'step-4',
      from: 7,
      to: 11,
      precinctId: '36047-0509',
      wholePrecinct: false,
      status: 'pending',
      blocks: [
        { geoid: '360470509002003', number: 1, people: 88, done: false },
        { geoid: '360470509002006', number: 2, people: 67, done: false },
        { geoid: '360470509002009', number: 3, people: 50, done: false },
      ],
    },
  ];
}

/**
 * A map still being drawn (Unassigned = district 0). Four districts; District 1 is +583 and its
 * only real neighbor, District 2, is locked, so the rest of its border is unassigned blocks.
 * District 4 is barely started. Deviations sum to −249,837: the people still unassigned.
 */
export const DRAWING_MAP_INFO: MapInfo = {
  state: 'NV',
  planName: 'NV Congressional (still drawing)',
  numDistricts: 4,
  popField: 'D20F',
  totalPop: 3108000,
  target: 777000,
};

const DRAWING_SPEC: Array<{ index: number; dev: number; neighbors: number[] }> = [
  { index: 1, dev: 583, neighbors: [0, 2] },
  { index: 2, dev: 0, neighbors: [0, 1, 3] },
  { index: 3, dev: -420, neighbors: [0, 2, 4] },
  { index: 4, dev: -250000, neighbors: [0, 3] },
];

export function makeDrawingDistricts(): DistrictRow[] {
  return DRAWING_SPEC.map((spec) => ({
    index: spec.index,
    label: String(spec.index),
    pop: DRAWING_MAP_INFO.target + spec.dev,
    deviation: spec.dev,
    color: DRA_COLORS[(spec.index - 1) % DRA_COLORS.length],
    neighbors: [...spec.neighbors],
  }));
}

/** People in unassigned blocks on the drawing map: everyone the four districts do not hold. */
export const DRAWING_UNASSIGNED_POP =
  DRAWING_MAP_INFO.totalPop - DRAWING_SPEC.reduce((sum, d) => sum + DRAWING_MAP_INFO.target + d.dev, 0);

/** District 1 gives its 583 to Unassigned: two ways to erase them. */
export const DRAWING_SINGLE_SOLUTIONS: SolutionCard[] = [
  {
    id: 'draw-opt-1',
    kind: 'single',
    stats: {
      people: 583, blocks: 5, populatedBlocks: 4, newPrecinctSplits: 1, healedPrecinctSplits: 0,
      newCountySplits: 0, perimeterDeltaM: -120, districtsTouched: 2, cost: 24, steps: 2,
    },
    borderFlows: [{ from: 1, to: 0, people: 583 }],
    deviations: [{ district: 1, before: 583, after: 0 }],
  },
  {
    id: 'draw-opt-2',
    kind: 'single',
    stats: {
      people: 583, blocks: 9, populatedBlocks: 7, newPrecinctSplits: 0, healedPrecinctSplits: 0,
      newCountySplits: 0, perimeterDeltaM: 40, districtsTouched: 2, cost: 61, steps: 3,
    },
    borderFlows: [{ from: 1, to: 0, people: 583 }],
    deviations: [{ district: 1, before: 583, after: 0 }],
  },
];

/** Districts 1 and 3 together: District 1 erases 583 people, District 3 paints in 420 unassigned people. */
export const DRAWING_PLAN_SOLUTION: SolutionCard = {
  id: 'draw-plan-1-3',
  kind: 'fewest-splits',
  stats: {
    people: 1003, blocks: 9, populatedBlocks: 8, newPrecinctSplits: 1, healedPrecinctSplits: 0,
    newCountySplits: 0, perimeterDeltaM: -60, districtsTouched: 3, cost: 70, steps: 3,
  },
  borderFlows: [
    { from: 1, to: 0, people: 583 },
    { from: 0, to: 3, people: 420 },
  ],
  deviations: [
    { district: 1, before: 583, after: 0 },
    { district: 3, before: -420, after: 0 },
  ],
};

/** Erase a shattered precinct's blocks, erase a whole precinct, then paint unassigned blocks into District 3. */
export function makeDrawingWalkthroughSteps(): WalkthroughStep[] {
  return [
    {
      id: 'draw-step-1',
      from: 1,
      to: 0,
      precinctId: '32003-0412',
      wholePrecinct: false,
      status: 'active',
      blocks: [
        { geoid: '320030412001001', number: 1, people: 160, done: false },
        { geoid: '320030412001004', number: 2, people: 133, done: false },
        { geoid: '320030412001007', number: 3, people: 90, done: false },
      ],
    },
    {
      id: 'draw-step-2',
      from: 1,
      to: 0,
      precinctId: '32003-0415',
      wholePrecinct: true,
      status: 'pending',
      blocks: [
        { geoid: '320030415002001', number: 1, people: 120, done: false },
        { geoid: '320030415002002', number: 2, people: 80, done: false },
      ],
    },
    {
      id: 'draw-step-3',
      from: 0,
      to: 3,
      precinctId: '32031-0120',
      wholePrecinct: false,
      status: 'pending',
      blocks: [
        { geoid: '320310120003002', number: 1, people: 250, done: false },
        { geoid: '320310120003005', number: 2, people: 170, done: false },
      ],
    },
  ];
}

export type ScenarioId =
  | 'live-single'
  | 'live-single-give-to'
  | 'live-single-take-from'
  | 'live-single-chosen-further'
  | 'live-group-chain'
  | 'live-group-infeasible'
  | 'live-whole-map-26'
  | 'live-twoway-26'
  | 'live-csv-switch'
  | 'live-drawing-unassigned'
  | 'live-finished-unassigned-adjacent'
  | 'mini-map-options'
  | 'walkthrough-live'
  | 'walkthrough-twoway'
  | 'walkthrough-unassigned'
  | 'walkthrough-awaiting-commit'
  | 'walkthrough-auto-paint'
  | 'walkthrough-auto-paint-twoway'
  | 'walkthrough-auto-paint-unavailable'
  | 'walkthrough-auto-paint-mismatch'
  | 'walkthrough-stray-edit'
  | 'walkthrough-mini-map'
  | 'walkthrough-final-check'
  | 'walkthrough-csv-final-check'
  | 'loading-data'
  | 'solving'
  | 'long-solve'
  | 'needs-precinct-rework'
  | 'group-unbalanced'
  | 'solve-error'
  | 'csv-mode'
  | 'no-plan'
  | 'no-tab'
  | 'connecting'
  | 'hook-failed'
  | 'unsupported-map'
  | 'data-mismatch';

export interface ScenarioDefinition {
  id: ScenarioId;
  category: 'Live & Scope' | 'Walkthrough' | 'Solver States' | 'Connection & Fallbacks';
  label: string;
  description: string;
  createState: () => PanelState;
}

export const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = {
  'live-single': {
    id: 'live-single',
    category: 'Live & Scope',
    label: 'Live: Single District (D13)',
    description: 'District 13 (+412 over) with 4 ranked zeroing options and neighbor effects.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts(),
      scope: { mode: 'one', district: 13 },
      solve: { status: 'done', elapsedMs: 38 },
      solutions: SINGLE_DISTRICT_SOLUTIONS,
    }),
  },

  'live-single-give-to': {
    id: 'live-single-give-to',
    category: 'Live & Scope',
    label: 'Live: D13 gives to 12 and 16 (chosen)',
    description: 'District 13 (+412 over) with the user\'s choice of neighbors: it gives only to District 12 and District 16.',
    createState: () => {
      const districts = makeNYDistricts();
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'one', district: 13, with: [12, 16] },
        solve: { status: 'done', elapsedMs: 31 },
        solutions: makeChosenNeighborOptions(districts, 13, [12, 16]),
      };
    },
  },

  'live-single-take-from': {
    id: 'live-single-take-from',
    category: 'Live & Scope',
    label: 'Live: D5 takes from 4 (chosen)',
    description: 'Under district: District 5 (−680) takes only from District 4 (+410), which ends at −270.',
    createState: () => {
      const districts = makeNYDistricts();
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'one', district: 5, with: [4] },
        solve: { status: 'done', elapsedMs: 27 },
        solutions: makeChosenNeighborOptions(districts, 5, [4]),
      };
    },
  },

  'live-single-chosen-further': {
    id: 'live-single-chosen-further',
    category: 'Live & Scope',
    label: 'Live: chosen neighbor ends further from zero',
    description: 'District 13 gives only to District 10, already +260 over: District 10 ends at +672, the user\'s call.',
    createState: () => {
      const districts = makeNYDistricts();
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'one', district: 13, with: [10] },
        solve: { status: 'idle' },
        solutions: [],
      };
    },
  },

  'live-group-chain': {
    id: 'live-group-chain',
    category: 'Live & Scope',
    label: 'Live: 4-District Chain (4→7→9,11)',
    description: 'Group of 4 where District 4 trades through middle District 7, with SVG interaction view and 3 plans.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts(),
      scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
      feasibility: { feasible: true, excess: 0, suggestAdd: [] },
      interaction: GROUP_CHAIN_INTERACTION,
      solve: { status: 'done', elapsedMs: 412 },
      solutions: GROUP_CHAIN_SOLUTIONS,
      hoveredSolutionId: 'plan-splits',
    }),
  },

  'live-group-infeasible': {
    id: 'live-group-infeasible',
    category: 'Live & Scope',
    label: 'Live: Infeasible Group (+1,240)',
    description: 'Districts 1, 2, 3 are +1,240 over with quick-add suggestions (District 5, District 8) and absorb toggle.',
    createState: () => {
      const districts = makeNYDistricts();
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'group', districts: [1, 2, 3], allowOutsideAbsorb: false },
        feasibility: { feasible: false, excess: 1240, suggestAdd: [5, 8] },
        interaction: buildInteractionForDistricts(districts, [1, 2, 3]),
        solve: { status: 'idle' },
        solutions: [],
      };
    },
  },

  'live-whole-map-26': {
    id: 'live-whole-map-26',
    category: 'Live & Scope',
    label: 'Live: Whole Map (26 Districts)',
    description: 'Full 26-district NY congressional map with 26-node interaction schematic and 3 plans.',
    createState: () => {
      const districts = makeNYDistricts();
      const allIdx = districts.map((d) => d.index);
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'all' },
        interaction: buildInteractionForDistricts(districts, allIdx),
        solve: { status: 'done', elapsedMs: 2480 },
        solutions: makeWholeMapSolutions(districts),
      };
    },
  },

  'live-twoway-26': {
    id: 'live-twoway-26',
    category: 'Live & Scope',
    label: 'Live: 26-District Two-Way Trades',
    description:
      '26-district NY plan with paired two-way trades (9 ⇄ 8: 25/23 net 2; 15 ⇄ 14: 48/37 net 11) and number-derived badges.',
    createState: () => {
      const districts = makeNYDistricts();
      const allIdx = districts.map((d) => d.index);
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'all' },
        interaction: buildInteractionForDistricts(districts, allIdx),
        solve: { status: 'done', elapsedMs: 3120 },
        solutions: makeTwoWayWholeMapSolutions(districts),
        hoveredSolutionId: 'twoway-plan-1',
      };
    },
  },

  'live-csv-switch': {
    id: 'live-csv-switch',
    category: 'Live & Scope',
    label: 'Live: Load CSV While Live',
    description:
      'Live DRA session with the compact Load CSV control in the header (or drop a CSV anywhere on the panel) to switch to CSV mode and back.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts(),
      scope: { mode: 'one', district: 13 },
      solve: { status: 'done', elapsedMs: 35 },
      solutions: SINGLE_DISTRICT_SOLUTIONS,
    }),
  },

  'live-drawing-unassigned': {
    id: 'live-drawing-unassigned',
    category: 'Live & Scope',
    label: 'Live: Map Being Drawn (Unassigned)',
    description:
      'District 1 (+583) touches only locked District 2 and unassigned blocks; "Any neighbor" gives to Unassigned while people are still unassigned.',
    createState: () => ({
      connection: 'live',
      map: DRAWING_MAP_INFO,
      districts: makeDrawingDistricts(),
      unassigned: { pop: DRAWING_UNASSIGNED_POP },
      scope: { mode: 'one', district: 1 },
      lockedDistricts: [2],
      solve: { status: 'done', elapsedMs: 22 },
      solutions: DRAWING_SINGLE_SOLUTIONS,
    }),
  },

  'live-finished-unassigned-adjacent': {
    id: 'live-finished-unassigned-adjacent',
    category: 'Live & Scope',
    label: 'Live: Finished Map, Empty Unassigned Blocks',
    description:
      'Every person is assigned, but District 1 still touches unassigned blocks with nobody in them: Unassigned is offered, used only when picked.',
    createState: () => {
      // District 4 drawn: the map holds everyone, so the deviations sum to 0.
      const districts = makeDrawingDistricts().map((d) =>
        d.index === 4 ? { ...d, pop: DRAWING_MAP_INFO.target - 163, deviation: -163 } : d,
      );
      return {
        connection: 'live',
        map: DRAWING_MAP_INFO,
        districts,
        scope: { mode: 'one', district: 1 },
        solve: { status: 'idle' },
        solutions: [],
      };
    },
  },

  'mini-map-options': {
    id: 'mini-map-options',
    category: 'Live & Scope',
    label: 'Live: Mini-Map Outside Walkthrough',
    description:
      'mapMode: "mini" outside a walkthrough — panel shows its mini-map preview slot while browsing borders and plans.',
    createState: () => ({
      connection: 'live',
      notice: {
        level: 'info',
        text: 'DRA map handle unavailable — previews render in the panel mini-map.',
      },
      map: NY_MAP_INFO,
      districts: makeNYDistricts(),
      scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
      feasibility: { feasible: true, excess: 0, suggestAdd: [] },
      interaction: GROUP_CHAIN_INTERACTION,
      solve: { status: 'done', elapsedMs: 412 },
      solutions: GROUP_CHAIN_SOLUTIONS,
      hoveredSolutionId: 'plan-splits',
      mapMode: 'mini',
    }),
  },

  'walkthrough-live': {
    id: 'walkthrough-live',
    category: 'Walkthrough',
    label: 'Walkthrough: Live Ticking',
    description: 'Multi-border walkthrough with live block ticks, shattered + whole-precinct steps, and live deviations.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts({ 4: 151, 7: 259, 9: -205, 11: -205 }),
      scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
      solve: { status: 'done', elapsedMs: 412 },
      solutions: GROUP_CHAIN_SOLUTIONS,
      walkthrough: {
        solutionId: 'plan-splits',
        steps: makeChainWalkthroughSteps(),
        current: 1,
        strayEdits: [],
        liveTicking: true,
        mapMode: 'dra',
      },
    }),
  },

  'walkthrough-twoway': {
    id: 'walkthrough-twoway',
    category: 'Walkthrough',
    label: 'Walkthrough: Two-Way Trade (9 ⇄ 8)',
    description:
      'Two-way border trade (9→8: 25, then 8→9: 23, net 2). Tick through Leg 1 to see the expected overshoot (−23 / +23) and Leg 2 to reach zero.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts({ 9: 2, 8: -2 }),
      scope: { mode: 'group', districts: [8, 9], allowOutsideAbsorb: false },
      solve: { status: 'done', elapsedMs: 145 },
      solutions: [TWO_WAY_WALKTHROUGH_SOLUTION],
      walkthrough: {
        solutionId: TWO_WAY_WALKTHROUGH_SOLUTION.id,
        steps: makeTwoWayWalkthroughSteps(),
        current: 0,
        strayEdits: [],
        liveTicking: true,
        mapMode: 'dra',
      },
    }),
  },

  'walkthrough-unassigned': {
    id: 'walkthrough-unassigned',
    category: 'Walkthrough',
    label: 'Walkthrough: Erase To Unassigned',
    description:
      'Map being drawn: District 1 erases blocks (shattered, then a whole precinct) and District 3 paints in unassigned blocks.',
    createState: () => ({
      connection: 'live',
      map: DRAWING_MAP_INFO,
      districts: makeDrawingDistricts(),
      unassigned: { pop: DRAWING_UNASSIGNED_POP },
      scope: { mode: 'group', districts: [1, 3], allowOutsideAbsorb: true },
      lockedDistricts: [2],
      solve: { status: 'done', elapsedMs: 54 },
      solutions: [DRAWING_PLAN_SOLUTION],
      autoPaint: { available: true, enabled: true },
      walkthrough: {
        solutionId: DRAWING_PLAN_SOLUTION.id,
        steps: makeDrawingWalkthroughSteps(),
        current: 0,
        strayEdits: [],
        liveTicking: true,
        mapMode: 'dra',
      },
    }),
  },

  'walkthrough-awaiting-commit': {
    id: 'walkthrough-awaiting-commit',
    category: 'Walkthrough',
    label: 'Walkthrough: Awaiting Commit',
    description: 'All blocks in the active precinct are painted; commit checkmark reminder is shown.',
    createState: () => {
      const steps = makeChainWalkthroughSteps();
      steps[1] = {
        ...steps[1],
        status: 'awaiting-commit',
        blocks: steps[1].blocks.map((b) => ({ ...b, done: true })),
      };
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts: makeNYDistricts({ 4: 0, 7: 410, 9: -205, 11: -205 }),
        scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
        solve: { status: 'done', elapsedMs: 412 },
        solutions: GROUP_CHAIN_SOLUTIONS,
        walkthrough: {
          solutionId: 'plan-splits',
          steps,
          current: 1,
          strayEdits: [],
          liveTicking: true,
          mapMode: 'dra',
        },
      };
    },
  },

  'walkthrough-auto-paint': {
    id: 'walkthrough-auto-paint',
    category: 'Walkthrough',
    label: 'Walkthrough: Paint Steps For Me (on)',
    description: 'The opt-in setting is on: the current step has a "Paint this step" button next to the by-hand instructions.',
    createState: () => ({
      ...SCENARIOS['walkthrough-live'].createState(),
      autoPaint: { available: true, enabled: true },
    }),
  },

  'walkthrough-auto-paint-twoway': {
    id: 'walkthrough-auto-paint-twoway',
    category: 'Walkthrough',
    label: 'Walkthrough: Paint For Me, Two-Way Trade',
    description: 'Painting is on during a two-way trade: Leg 2 cannot be painted until Leg 1 is finished.',
    createState: () => {
      const base = SCENARIOS['walkthrough-twoway'].createState();
      const steps = base.walkthrough!.steps;
      const leg2 = steps.findIndex((st) => st.from !== steps[0].from);
      return {
        ...base,
        autoPaint: { available: true, enabled: true },
        walkthrough: { ...base.walkthrough!, current: leg2 >= 0 ? leg2 : 0 },
      };
    },
  },

  'walkthrough-auto-paint-unavailable': {
    id: 'walkthrough-auto-paint-unavailable',
    category: 'Walkthrough',
    label: 'Walkthrough: Paint For Me Unavailable',
    description: 'The setting is shown but cannot be turned on, with the reason (here: a read-only map).',
    createState: () => ({
      ...SCENARIOS['walkthrough-live'].createState(),
      autoPaint: {
        available: false,
        enabled: false,
        reason: 'This map is read-only for you in DRA (a view-only link, a locked map, or DRA maintenance).',
      },
    }),
  },

  'walkthrough-auto-paint-mismatch': {
    id: 'walkthrough-auto-paint-mismatch',
    category: 'Walkthrough',
    label: 'Walkthrough: Paint Did Something Else',
    description: 'A paint did not do what was asked: painting is switched off and the panel says what differs and how to undo it.',
    createState: () => ({
      ...SCENARIOS['walkthrough-live'].createState(),
      notice: {
        level: 'error',
        text: "Painting step 2 did not do what was asked. DRA's edit differs from the step: 1 block(s) outside the step changed. DRA's own Undo (its Undo button, or Ctrl+Z in the DRA tab) takes this edit back in one step.",
      },
      autoPaint: {
        available: false,
        enabled: false,
        reason:
          "Painting step 2 did not do what was asked, so painting for you is now off. DRA's edit differs from the step: 1 block(s) outside the step changed. Block 360594071021003 (precinct 36059-071) changed from District 7 to District 9, but it is not part of this step. DRA's own Undo (its Undo button, or Ctrl+Z in the DRA tab) takes this edit back in one step.",
      },
    }),
  },

  'walkthrough-stray-edit': {
    id: 'walkthrough-stray-edit',
    category: 'Walkthrough',
    label: 'Walkthrough: Stray Edit Warning',
    description: 'Unexpected edits outside the active plan trigger the warning banner and Re-plan from here.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts({ 4: 175, 7: 235, 9: -205, 11: -205 }),
      scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
      solve: { status: 'done', elapsedMs: 412 },
      solutions: GROUP_CHAIN_SOLUTIONS,
      walkthrough: {
        solutionId: 'plan-splits',
        steps: makeChainWalkthroughSteps(),
        current: 1,
        strayEdits: [
          { geoid: '360594071022019', fromDistrict: 4, toDistrict: 5 },
          { geoid: '360594071022021', fromDistrict: 4, toDistrict: 5 },
        ],
        liveTicking: true,
        mapMode: 'dra',
      },
    }),
  },

  'walkthrough-mini-map': {
    id: 'walkthrough-mini-map',
    category: 'Walkthrough',
    label: 'Walkthrough: Mini-Map & Manual',
    description: 'Fallback when map handle is unavailable: mini-map slot mounted and liveTicking is false.',
    createState: () => ({
      connection: 'live',
      notice: {
        level: 'info',
        text: 'DRA map handle unavailable — showing panel mini-map fallback.',
      },
      map: NY_MAP_INFO,
      districts: makeNYDistricts({ 4: 151, 7: 259, 9: -205, 11: -205 }),
      scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
      solve: { status: 'done', elapsedMs: 412 },
      solutions: GROUP_CHAIN_SOLUTIONS,
      walkthrough: {
        solutionId: 'plan-splits',
        steps: makeChainWalkthroughSteps(),
        current: 2, // Whole-precinct step!
        strayEdits: [],
        liveTicking: false,
        mapMode: 'mini',
      },
    }),
  },

  'walkthrough-final-check': {
    id: 'walkthrough-final-check',
    category: 'Walkthrough',
    label: 'Walkthrough: Final Check Passed',
    description: 'All steps completed and confirmed against DRA totals.',
    createState: () => {
      const steps = makeChainWalkthroughSteps().map((s) => ({
        ...s,
        status: 'done' as const,
        blocks: s.blocks.map((b) => ({ ...b, done: true })),
      }));
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts: makeNYDistricts({ 4: 0, 7: 0, 9: 0, 11: 0 }),
        scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
        solve: { status: 'done', elapsedMs: 412 },
        solutions: GROUP_CHAIN_SOLUTIONS,
        walkthrough: {
          solutionId: 'plan-splits',
          steps,
          current: steps.length - 1,
          strayEdits: [],
          finalCheck: {
            ok: true,
            deviations: [
              { district: 4, before: 410, after: 0 },
              { district: 7, before: 0, after: 0 },
              { district: 9, before: -205, after: 0 },
              { district: 11, before: -205, after: 0 },
            ],
          },
          liveTicking: true,
          mapMode: 'dra',
        },
      };
    },
  },

  'walkthrough-csv-final-check': {
    id: 'walkthrough-csv-final-check',
    category: 'Walkthrough',
    label: 'Walkthrough: CSV Final Check (Unverified)',
    description: 'CSV-mode walkthrough finished with finalCheck.ok === null (expected result, not confirmed by DRA).',
    createState: () => {
      const steps = makeChainWalkthroughSteps().map((s) => ({
        ...s,
        status: 'done' as const,
        blocks: s.blocks.map((b) => ({ ...b, done: true })),
      }));
      return {
        connection: 'csv',
        map: { ...NY_MAP_INFO, sourceName: 'ny-2026-blocks.csv' },
        districts: makeNYDistricts(),
        scope: { mode: 'group', districts: [4, 7, 9, 11], allowOutsideAbsorb: false },
        solve: { status: 'done', elapsedMs: 412 },
        solutions: GROUP_CHAIN_SOLUTIONS,
        walkthrough: {
          solutionId: 'plan-splits',
          steps,
          current: steps.length - 1,
          strayEdits: [],
          finalCheck: {
            ok: null,
            deviations: [
              { district: 4, before: 410, after: 0 },
              { district: 7, before: 0, after: 0 },
              { district: 9, before: -205, after: 0 },
              { district: 11, before: -205, after: 0 },
            ],
          },
          liveTicking: false,
          mapMode: 'mini',
        },
        mapMode: 'mini',
      };
    },
  },

  'loading-data': {
    id: 'loading-data',
    category: 'Solver States',
    label: 'Solve: Loading Data (64%)',
    description: 'Downloading and decompressing NY state bundle (2.2 MB).',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts(),
      scope: { mode: 'one', district: 13 },
      solve: {
        status: 'loading-data',
        progress: 0.64,
        message: 'Downloading NY block graph (1.4 / 2.2 MB)…',
      },
      solutions: [],
    }),
  },

  solving: {
    id: 'solving',
    category: 'Solver States',
    label: 'Solve: Solving Whole Map (48%)',
    description: 'Multi-border whole-map realization in progress.',
    createState: () => {
      const districts = makeNYDistricts();
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'all' },
        interaction: buildInteractionForDistricts(districts, districts.map((d) => d.index)),
        solve: {
          status: 'solving',
          progress: 0.48,
          message: 'Realizing border 11 of 23 (District 13 → 12)…',
        },
        solutions: [],
      };
    },
  },

  'long-solve': {
    id: 'long-solve',
    category: 'Solver States',
    label: 'Solve: Cancel During Long Solve',
    description: 'Long whole-map solve in progress; click Cancel to dispatch cancel-solve and return to idle.',
    createState: () => {
      const districts = makeNYDistricts();
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'all' },
        interaction: buildInteractionForDistricts(districts, districts.map((d) => d.index)),
        solve: {
          status: 'solving',
          progress: 0.28,
          message: 'Realizing border 7 of 25 (searching two-way trade on 9 ⇄ 8)…',
        },
        solutions: [],
      };
    },
  },

  'needs-precinct-rework': {
    id: 'needs-precinct-rework',
    category: 'Solver States',
    label: 'Solve: Needs Precinct Rework',
    description: 'Deviation is too large for the 10-hop border ring.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts({ 13: 18420 }),
      scope: { mode: 'one', district: 13 },
      solve: {
        status: 'needs-precinct-rework',
        message: 'District 13 is +18,420 over. Move whole precincts in DRA before fine-tuning with blocks.',
        elapsedMs: 620,
      },
      solutions: [],
    }),
  },

  'group-unbalanced': {
    id: 'group-unbalanced',
    category: 'Solver States',
    label: 'Solve: Group Unbalanced',
    description: 'Group solve stopped because the selection has +1,240 net excess.',
    createState: () => {
      const districts = makeNYDistricts();
      return {
        connection: 'live',
        map: NY_MAP_INFO,
        districts,
        scope: { mode: 'group', districts: [1, 2, 3], allowOutsideAbsorb: false },
        feasibility: { feasible: false, excess: 1240, suggestAdd: [5, 8] },
        interaction: buildInteractionForDistricts(districts, [1, 2, 3]),
        solve: {
          status: 'group-unbalanced',
          message: 'This group is +1,240 over. Add District 5 or District 8, or allow outside neighbors to absorb.',
        },
        solutions: [],
      };
    },
  },

  'solve-error': {
    id: 'solve-error',
    category: 'Solver States',
    label: 'Solve: Error',
    description: 'Worker reported an unexpected error while solving.',
    createState: () => ({
      connection: 'live',
      map: NY_MAP_INFO,
      districts: makeNYDistricts(),
      scope: { mode: 'one', district: 13 },
      solve: {
        status: 'error',
        message: 'Could not download NY county geometry (network timeout).',
      },
      solutions: [],
    }),
  },

  'csv-mode': {
    id: 'csv-mode',
    category: 'Connection & Fallbacks',
    label: 'Connection: CSV Mode',
    description: 'Plan loaded from a dropped DRA block-assignment CSV with file name and Back to live tab button.',
    createState: () => ({
      connection: 'csv',
      notice: {
        level: 'info',
        text: 'Loaded 288,819 blocks from CSV. Live ticking is disabled.',
      },
      map: { ...NY_MAP_INFO, sourceName: 'ny-2026-blocks.csv' },
      districts: makeNYDistricts(),
      scope: { mode: 'one', district: 13 },
      solve: { status: 'done', elapsedMs: 44 },
      solutions: SINGLE_DISTRICT_SOLUTIONS,
    }),
  },

  'no-plan': {
    id: 'no-plan',
    category: 'Connection & Fallbacks',
    label: 'Connection: No Map Open (no-plan)',
    description: 'A davesredistricting.org tab is open (e.g. map list), but no map is open in it yet.',
    createState: () => ({
      connection: 'no-plan',
      districts: [],
      scope: { mode: 'one', district: 1 },
      solve: { status: 'idle' },
      solutions: [],
    }),
  },

  'no-tab': {
    id: 'no-tab',
    category: 'Connection & Fallbacks',
    label: 'Connection: No DRA Tab',
    description: 'No davesredistricting.org map tab active; CSV drop zone offered.',
    createState: () => ({
      connection: 'no-tab',
      districts: [],
      scope: { mode: 'one', district: 1 },
      solve: { status: 'idle' },
      solutions: [],
    }),
  },

  connecting: {
    id: 'connecting',
    category: 'Connection & Fallbacks',
    label: 'Connection: Connecting',
    description: 'Waiting for MAIN-world page hook handshake.',
    createState: () => ({
      connection: 'connecting',
      districts: [],
      scope: { mode: 'one', district: 1 },
      solve: { status: 'idle' },
      solutions: [],
    }),
  },

  'hook-failed': {
    id: 'hook-failed',
    category: 'Connection & Fallbacks',
    label: 'Connection: Hook Failed',
    description: 'Shows "DRA changed; update pending" and offers the CSV drop zone.',
    createState: () => ({
      connection: 'hook-failed',
      notice: {
        level: 'warn',
        text: 'Hook check failed: window.dra.model().fullBlockMap not found.',
      },
      districts: [],
      scope: { mode: 'one', district: 1 },
      solve: { status: 'idle' },
      solutions: [],
    }),
  },

  'unsupported-map': {
    id: 'unsupported-map',
    category: 'Connection & Fallbacks',
    label: 'Connection: Unsupported Map',
    description: 'Out-of-scope map (e.g. 2010 shapes or multi-member) disables suggestions.',
    createState: () => ({
      connection: 'unsupported-map',
      notice: {
        level: 'warn',
        text: 'This map uses 2010 Census shapes, which DRA does not support for block painting.',
      },
      map: {
        state: 'MD',
        planName: 'MD House Multi-Member 2010',
        numDistricts: 47,
        popField: 'D20FA',
        totalPop: 6177224,
        target: 131430,
      },
      districts: [],
      scope: { mode: 'one', district: 1 },
      solve: { status: 'idle' },
      solutions: [],
    }),
  },

  'data-mismatch': {
    id: 'data-mismatch',
    category: 'Connection & Fallbacks',
    label: 'Connection: Data Mismatch',
    description: 'Bundle populations disagree with DRA totals; suggestions disabled with read-only district list.',
    createState: () => ({
      connection: 'data-mismatch',
      notice: {
        level: 'error',
        text: 'District 13 differs by 14 people between DRA (v09) and cached bundle (v08).',
      },
      map: NY_MAP_INFO,
      districts: makeNYDistricts(),
      scope: { mode: 'one', district: 13 },
      solve: { status: 'idle' },
      solutions: [],
    }),
  },
};

export const SCENARIO_LIST: ScenarioDefinition[] = Object.values(SCENARIOS);
