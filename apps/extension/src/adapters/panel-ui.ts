/**
 * Adapter: @zd/panel-ui (React 19 <Panel>). mountPanel(element, controller, { renderMiniMap }).
 */
import type { PanelController } from '@zd/contracts';
import { mountPanel as realMountPanel } from '@zd/panel-ui';

export type MiniMapRenderer = (container: HTMLElement) => (() => void) | void;

export function mountPanel(element: HTMLElement, controller: PanelController, options?: { renderMiniMap?: MiniMapRenderer }): () => void {
  return realMountPanel(element, controller, options);
}
