/**
 * County clusters ("county clustering", as in North Carolina's legislative maps): split a state
 * into groups of whole, contiguous counties, each holding close to a whole number of districts'
 * worth of people, so every group can be districted on its own without splitting a county at
 * the group's edge.
 *
 * packages/planner implements findCountyClusters; the extension runs it in the engine worker and
 * shows results in the panel (PanelState.clusters).
 */
import type { EngineGraph } from './engine';

export interface ClusterRequest {
  /** Uses pop, countyOf and the block adjacency (two counties touch when any of their blocks do). */
  graph: EngineGraph;
  /** Number of districts the whole state is to be split into. District size = state pop / this. */
  numDistricts: number;
  /**
   * Allowed deviation per district as a fraction (0.05 = ±5%). A cluster of k districts is valid
   * when its population P satisfies |P / k − size| ≤ tolerance · size, with size = state pop /
   * numDistricts.
   */
  tolerance: number;
  /** Most clusterings to return, best first. Default 5. */
  maxResults?: number;
  /** Give up searching after this long and return what was found, with exhaustive = false. Default 10 000. */
  timeLimitMs?: number;
  /** Counties (bundle county indexes) that must not be in any cluster with other counties; rarely used. Default none. */
  singletons?: number[];
}

export interface CountyCluster {
  /** Bundle county indexes, ascending. Contiguous through county adjacency. */
  counties: number[];
  /** Districts the cluster holds (k ≥ 1). */
  districts: number;
  pop: number;
  /** pop / districts − size, in people (signed). */
  deviation: number;
  /** deviation / size (signed fraction). */
  deviationPct: number;
}

export interface Clustering {
  /** Stable id for this clustering (hash of its clusters). */
  id: string;
  /** Clusters covering every county of the state exactly once, largest population first. */
  clusters: CountyCluster[];
  stats: {
    clusterCount: number;
    /** Clusters made of one county. */
    singleCounty: number;
    /** Largest |deviationPct| over all clusters. */
    maxAbsDeviationPct: number;
    /** Largest number of counties in one cluster. */
    largestClusterCounties: number;
  };
}

export interface ClusterResult {
  /** 'none' = no split into two or more valid clusters exists at this tolerance (the whole state as one cluster is always valid, so it is not listed), or none was found in time. */
  status: 'ok' | 'none' | 'error';
  /**
   * Best first: most clusters first (more, smaller clusters force fewer county splits at
   * cluster edges), then smallest maxAbsDeviationPct, then fewest counties in the largest cluster.
   */
  clusterings: Clustering[];
  /** True when the search proved the ranking (no better clustering exists). */
  exhaustive: boolean;
  /** Size of one district used, in people. */
  districtSize: number;
  message?: string;
  elapsedMs: number;
}
