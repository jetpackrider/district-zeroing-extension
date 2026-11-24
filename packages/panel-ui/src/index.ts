export { Panel } from './components/Panel';
export { mountPanel } from './mount';
export { MockController } from './mock/MockController';
export { SCENARIOS, SCENARIO_LIST } from './mock/scenarios';
export type { ScenarioDefinition, ScenarioId } from './mock/scenarios';
export { computeGraphLayout } from './layout/graphLayout';
export type { GraphLayout, PositionedEdge, PositionedNode } from './layout/graphLayout';
export type {
  ConnectionStatus,
  DeviationChange,
  DistrictRow,
  GroupFeasibility,
  InteractionGraph,
  MapInfo,
  MiniMapRenderer,
  PanelAction,
  PanelController,
  PanelOptions,
  PanelProps,
  PanelState,
  PopField,
  Scope,
  SolutionCard,
  SolutionKind,
  SolutionStats,
  WalkthroughBlock,
  WalkthroughState,
  WalkthroughStep,
} from './types';
