import type { PanelController } from '@zd/contracts';

export type {
  ConnectionStatus,
  DeviationChange,
  DistrictRow,
  GroupFeasibility,
  InteractionGraph,
  MapInfo,
  PanelAction,
  PanelController,
  PanelState,
  PopField,
  Scope,
  SolutionCard,
  SolutionKind,
  SolutionStats,
  WalkthroughBlock,
  WalkthroughState,
  WalkthroughStep,
} from '@zd/contracts';

/**
 * Callback supplied by the extension shell to render a MapLibre mini-map inside
 * the panel when `state.mapMode === 'mini'` or `walkthrough.mapMode === 'mini'`.
 * Receives the container element and returns an optional cleanup function.
 */
export type MiniMapRenderer = (container: HTMLElement) => (() => void) | void;

export interface PanelOptions {
  /** Renderer for the mini-map slot when `state.mapMode === 'mini'` or `walkthrough.mapMode === 'mini'`. */
  renderMiniMap?: MiniMapRenderer;
  /** Optional extra CSS class on the panel root element. */
  className?: string;
}

export interface PanelProps extends PanelOptions {
  controller: PanelController;
}
