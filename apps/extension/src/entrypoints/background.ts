import { matchesHost, openPanelChain, type PanelHost } from '../shared/panel-host';

/**
 * Background service worker. Keeps no plan data (MV3 workers die after 30 s idle); it only
 *  - enables the side panel on davesredistricting.org tabs and disables it elsewhere,
 *  - opens the panel through the host chain when the toolbar button is clicked,
 *  - tracks which panel pages are alive (runtime ports), so no sidePanel.onClosed is needed.
 */

const PANEL_PATH = 'sidepanel.html';
const ALIVE_TIMEOUT_MS = 1500;

interface LivePanel {
  host: PanelHost;
  windowId?: number;
  tabId?: number;
}

export default defineBackground(() => {
  const patterns = __ZD_HOST_PATTERNS__;
  const live = new Map<chrome.runtime.Port, LivePanel>();
  const aliveWaiters: Array<{ host: PanelHost; resolve: (ok: boolean) => void }> = [];
  let forceHost: PanelHost | null = null;
  let simulateNoSidePanel = false;

  // Test-only overrides, cached so the action click stays inside its user gesture.
  const loadOverrides = () => {
    if (!__ZD_TEST__) return;
    chrome.storage.local.get(['zdForcePanelHost', 'zdSimulateNoSidePanel']).then((v) => {
      forceHost = (v.zdForcePanelHost as PanelHost) ?? null;
      simulateNoSidePanel = !!v.zdSimulateNoSidePanel;
    });
  };
  loadOverrides();
  chrome.storage.onChanged.addListener(loadOverrides);

  const sidePanel = (chrome as unknown as { sidePanel?: typeof chrome.sidePanel }).sidePanel;

  const updateTab = (tabId: number, url: string | undefined) => {
    if (!sidePanel?.setOptions) return;
    const enabled = matchesHost(url, patterns);
    sidePanel.setOptions({ tabId, path: `${PANEL_PATH}?host=sidepanel`, enabled }).catch(() => {});
  };

  // Disabled by default (every worker start, not only on install); enabled per DRA tab below.
  // We open it ourselves on action click so the fallback chain can run.
  sidePanel?.setOptions?.({ enabled: false }).catch(() => {});
  sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
  chrome.tabs.query({}).then((tabs) => tabs.forEach((t) => t.id !== undefined && updateTab(t.id, t.url)), () => {});
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url !== undefined || info.status === 'loading') updateTab(tabId, tab.url);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then((t) => updateTab(tabId, t.url), () => {});
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'zd-panel-life') return;
    port.onMessage.addListener((m: { host: PanelHost; windowId?: number; tabId?: number }) => {
      live.set(port, { host: m.host, windowId: m.windowId, tabId: m.tabId });
      for (let i = aliveWaiters.length - 1; i >= 0; i--) {
        if (aliveWaiters[i].host === m.host) {
          aliveWaiters[i].resolve(true);
          aliveWaiters.splice(i, 1);
        }
      }
    });
    port.onDisconnect.addListener(() => live.delete(port));
  });

  const isAlive = (host: PanelHost, pred: (p: LivePanel) => boolean) => [...live.values()].some((p) => p.host === host && pred(p));

  const waitAlive = (host: PanelHost, windowId?: number) =>
    new Promise<boolean>((resolve) => {
      if (isAlive(host, (p) => windowId === undefined || p.windowId === windowId)) return resolve(true);
      const w = { host, resolve };
      aliveWaiters.push(w);
      setTimeout(() => {
        const i = aliveWaiters.indexOf(w);
        if (i >= 0) {
          aliveWaiters.splice(i, 1);
          resolve(false);
        }
      }, ALIVE_TIMEOUT_MS);
    });

  const openPopout = async (tabId: number) => {
    const existing = [...live.values()].find((p) => p.host === 'popout' && p.tabId === tabId);
    if (existing?.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
    await chrome.windows.create({
      url: chrome.runtime.getURL(`${PANEL_PATH}?host=popout&tabId=${tabId}`),
      type: 'popup',
      width: 440,
      height: 820,
    });
  };

  const openPanel = (tab: chrome.tabs.Tab) => {
    const tabId = tab.id;
    if (tabId === undefined) return Promise.resolve('popout' as PanelHost);
    // sidePanel.open must be called synchronously inside the click's user gesture.
    const spOpen =
      sidePanel?.open && !simulateNoSidePanel && !forceHost
        ? (() => {
            const p = sidePanel.open({ tabId });
            return () => p;
          })()
        : undefined;
    const opr = (globalThis as unknown as { opr?: { sidebarAction?: { open?: () => Promise<void> } } }).opr;
    const operaOpen = opr?.sidebarAction?.open ? () => Promise.resolve(opr.sidebarAction!.open!()) : undefined;
    return openPanelChain({
      sidePanelOpen: spOpen,
      operaOpen,
      popout: () => openPopout(tabId),
      waitAlive: (h) => waitAlive(h, h === 'sidepanel' ? tab.windowId : undefined),
      force: forceHost,
      log: (s) => console.info('[zd] panel chain:', s),
    });
  };

  chrome.action.onClicked.addListener((tab) => {
    void openPanel(tab);
  });

  if (__ZD_TEST__) {
    (globalThis as unknown as Record<string, unknown>).__zdOpenPanel = async (tabId: number) => openPanel(await chrome.tabs.get(tabId));
    (globalThis as unknown as Record<string, unknown>).__zdLivePanels = () => [...live.values()];
  }
});
