/**
 * Panel host chain (SPEC "Browser support"):
 *   1. chrome.sidePanel, if it exists and actually opens,
 *   2. Opera's own sidebar (sidebar_action / opr.sidebarAction),
 *   3. a pop-out window running the same panel page (also Arc).
 *
 * "Actually opens" is checked by waiting for the panel page to report itself alive over a
 * runtime port; we never depend on sidePanel.close() (Chrome 141+) or onClosed (142+).
 */

export type PanelHost = 'sidepanel' | 'opera-sidebar' | 'popout';

export interface PanelChainEnv {
  /** chrome.sidePanel.open bound to the tab, or undefined when the API is missing. */
  sidePanelOpen?: () => Promise<void>;
  /** opr.sidebarAction.open (if Opera exposes one), or undefined. */
  operaOpen?: () => Promise<void>;
  popout: () => Promise<void>;
  /** Resolves true when a panel page of this host checks in within the timeout. */
  waitAlive: (host: PanelHost) => Promise<boolean>;
  /** Test override: skip straight to one host. */
  force?: PanelHost | null;
  log?: (s: string) => void;
}

export async function openPanelChain(env: PanelChainEnv): Promise<PanelHost> {
  const log = env.log ?? (() => {});
  const tryHost = async (host: PanelHost, open?: () => Promise<void>) => {
    if (!open) return false;
    try {
      await open();
    } catch (e) {
      log(`${host} open failed: ${String(e)}`);
      return false;
    }
    const alive = await env.waitAlive(host);
    if (!alive) log(`${host} opened but no panel page checked in`);
    return alive;
  };
  if (env.force === 'popout') {
    await env.popout();
    return 'popout';
  }
  if (env.force !== 'opera-sidebar' && (await tryHost('sidepanel', env.sidePanelOpen))) return 'sidepanel';
  if (await tryHost('opera-sidebar', env.operaOpen)) return 'opera-sidebar';
  await env.popout();
  return 'popout';
}

export function matchesHost(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  return patterns.some((p) => patternToRegExp(p).test(url));
}

/** Chrome match pattern -> RegExp. Port is ignored when the pattern names none (Chrome's rule). */
export function patternToRegExp(pattern: string): RegExp {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return /$^/;
  const [, scheme, host, path] = m;
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const schemeRe = scheme === '*' ? 'https?' : scheme;
  const hostRe = host.startsWith('*.') ? `(?:[^/:]+\\.)?${esc(host.slice(2))}` : esc(host);
  const pathRe = esc(path).replace(/\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`);
}
