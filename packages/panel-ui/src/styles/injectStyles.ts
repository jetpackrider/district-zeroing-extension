import panelCss from './panel.css?inline';

const STYLE_ID = 'zd-panel-ui-styles';

/**
 * Ensures the @zd/panel-ui stylesheet is injected once into the target document
 * or ShadowRoot. Allows the extension shell to import <Panel /> or mountPanel()
 * without requiring a separate CSS import step.
 */
export function ensurePanelStyles(target?: Node | null): void {
  if (typeof document === 'undefined') return;

  const root = target?.getRootNode?.();
  if (root && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
    if (root.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = panelCss;
    root.appendChild(style);
    return;
  }

  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = panelCss;
  document.head.appendChild(style);
}
