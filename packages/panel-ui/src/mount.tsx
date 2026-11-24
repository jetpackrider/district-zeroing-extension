import { createRoot } from 'react-dom/client';
import type { PanelController } from '@zd/contracts';
import type { PanelOptions } from './types';
import { Panel } from './components/Panel';
import { ensurePanelStyles } from './styles/injectStyles';

/**
 * Mounts the @zd/panel-ui side panel into a DOM container element.
 * Returns a cleanup function that unmounts the React tree.
 */
export function mountPanel(
  element: HTMLElement,
  controller: PanelController,
  options?: PanelOptions,
): () => void {
  ensurePanelStyles(element);
  const root = createRoot(element);
  root.render(
    <Panel
      controller={controller}
      renderMiniMap={options?.renderMiniMap}
      className={options?.className}
    />,
  );
  return () => {
    root.unmount();
  };
}
