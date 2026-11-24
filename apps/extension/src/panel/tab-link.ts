/**
 * The panel's link to the DRA tab: chrome.tabs.connect to the relay content script.
 * Side panel: follows the active tab of its window. Pop-out: a fixed tab (from ?tabId=).
 * Opera sidebar: the active tab of the last focused window.
 */
import { matchesHost, type PanelHost } from '../shared/panel-host';
import { RUNTIME_PORT_NAME, unwrap, wrap, type HookToPanel, type PanelToHook } from '../shared/protocol';

export type LinkStatus = { kind: 'no-tab' } | { kind: 'connecting'; tabId: number } | { kind: 'connected'; tabId: number };

export class TabLink {
  private port: chrome.runtime.Port | null = null;
  private tabId: number | null = null;
  private windowId: number | undefined;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  status: LinkStatus = { kind: 'no-tab' };
  /** Consecutive connection attempts to the current tab that ended without a single message. */
  failedAttempts = 0;
  /** chrome.runtime.lastError from the last such attempt. */
  lastConnectError: string | null = null;
  /** Last status the relay content script reported about itself (null = never heard from it). */
  relay: { hookAttached: boolean; readyState: string; ageMs: number } | null = null;
  /** Last 'alive' from the hook. */
  alive: { hookVersion: string; draPresent: boolean; planOpen: boolean; readyState: string; offers: number } | null = null;

  /** Which stage of tab -> relay -> hook the link has reached, for the notice and diagnostics. */
  stage(): 'no-tab' | 'no-content-script' | 'trying' | 'relay-only' | 'hook' {
    if (this.status.kind === 'no-tab') return 'no-tab';
    if (this.alive || this.status.kind === 'connected') return 'hook';
    if (this.relay) return this.relay.hookAttached ? 'trying' : 'relay-only';
    return this.failedAttempts >= 2 ? 'no-content-script' : 'trying';
  }

  constructor(
    private readonly host: PanelHost,
    private readonly fixedTabId: number | null,
    private readonly onMessage: (m: HookToPanel) => void,
    private readonly onStatus: (s: LinkStatus) => void,
  ) {}

  async start() {
    const win = await chrome.windows.getCurrent().catch(() => undefined);
    this.windowId = win?.id;
    // Tell the background we're alive (panel host chain check; no sidePanel.onClosed needed).
    try {
      const life = chrome.runtime.connect({ name: 'zd-panel-life' });
      life.postMessage({ host: this.host, windowId: this.windowId, tabId: this.fixedTabId ?? undefined });
    } catch {
      /* */
    }
    if (this.fixedTabId === null) {
      chrome.tabs.onActivated.addListener((info) => {
        if (this.host === 'sidepanel' && info.windowId !== this.windowId) return;
        void this.retarget();
      });
    }
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId === this.tabId && info.status === 'loading') this.resetStages();
      if (tabId === this.tabId && info.status === 'complete' && !this.port) void this.retarget();
      if (this.fixedTabId === null && info.url !== undefined) void this.retarget();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (tabId === this.tabId) {
        this.disconnect();
        this.setStatus({ kind: 'no-tab' });
      }
    });
    await this.retarget();
  }

  private setStatus(s: LinkStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private async findTab(): Promise<chrome.tabs.Tab | null> {
    if (this.fixedTabId !== null) return chrome.tabs.get(this.fixedTabId).catch(() => null);
    const q: chrome.tabs.QueryInfo = this.host === 'sidepanel' && this.windowId !== undefined ? { active: true, windowId: this.windowId } : { active: true, lastFocusedWindow: true };
    const [tab] = await chrome.tabs.query(q);
    return tab ?? null;
  }

  async retarget() {
    if (this.stopped) return;
    const tab = await this.findTab();
    if (!tab?.id || !matchesHost(tab.url, __ZD_HOST_PATTERNS__)) {
      this.disconnect();
      this.tabId = null;
      this.setStatus({ kind: 'no-tab' });
      return;
    }
    if (tab.id === this.tabId && this.port) return;
    this.disconnect();
    if (tab.id !== this.tabId) this.resetStages();
    this.tabId = tab.id;
    this.connect();
  }

  private resetStages() {
    this.failedAttempts = 0;
    this.lastConnectError = null;
    this.relay = null;
    this.alive = null;
  }

  private connect() {
    if (this.tabId === null) return;
    const tabId = this.tabId;
    this.setStatus({ kind: 'connecting', tabId });
    let port: chrome.runtime.Port;
    try {
      port = chrome.tabs.connect(tabId, { name: RUNTIME_PORT_NAME });
    } catch {
      this.scheduleRetry();
      return;
    }
    this.port = port;
    let gotAny = false;
    let heard = false;
    port.onMessage.addListener((data) => {
      const m = unwrap<HookToPanel>(data);
      if (!m) return;
      heard = true;
      this.failedAttempts = 0;
      if (m.t === 'relay') {
        // The relay speaking for itself: the content script is there, the hook may not be.
        this.relay = { hookAttached: m.hookAttached, readyState: m.readyState, ageMs: m.ageMs };
        this.onStatus(this.status);
        return;
      }
      if (m.t === 'alive') this.alive = { hookVersion: m.hookVersion, draPresent: m.draPresent, planOpen: m.planOpen, readyState: m.readyState, offers: m.offers };
      if (!gotAny) {
        gotAny = true;
        this.setStatus({ kind: 'connected', tabId });
      }
      this.onMessage(m);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? null;
      if (this.port === port) {
        this.port = null;
        if (!heard) {
          this.failedAttempts++;
          this.lastConnectError = err;
        }
        // The page went away (reload, navigation): whatever was attached is gone with it.
        this.relay = null;
        this.alive = null;
        this.setStatus({ kind: 'connecting', tabId });
        this.scheduleRetry();
      }
    });
    port.postMessage(wrap<PanelToHook>({ t: 'hello' }));
  }

  private scheduleRetry() {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.retarget();
    }, 1000);
  }

  private disconnect() {
    if (this.port) {
      const p = this.port;
      this.port = null;
      try {
        p.disconnect();
      } catch {
        /* */
      }
    }
  }

  send(msg: PanelToHook) {
    this.port?.postMessage(wrap(msg));
  }

  /** Reload the linked tab (the page hook only attaches when the page loads). */
  reloadTab() {
    if (this.tabId !== null) void chrome.tabs.reload(this.tabId);
  }

  reconnect() {
    this.disconnect();
    void this.retarget();
  }

  stop() {
    this.stopped = true;
    this.disconnect();
  }
}
