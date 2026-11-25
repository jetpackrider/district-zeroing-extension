/**
 * Isolated-world relay. Accepts exactly one MessagePort from the MAIN-world hook (the first
 * `zd-port` message, posted at document_start before any page script runs) and relays between
 * it and the panel's chrome.runtime Port (chrome.tabs.connect from the panel page).
 */
import { RELAY_READY_EVENT, RUNTIME_PORT_NAME, unwrap, wrap, type HookToPanel, type PanelToHook } from '../shared/protocol';

export function startRelay(): void {
  let hookPort: MessagePort | null = null;
  const panels = new Set<chrome.runtime.Port>();
  const queued: PanelToHook[] = [];
  const startedAt = performance.now();
  /** The relay's own status, so the panel can tell "no content script" from "no hook". */
  const status = (): HookToPanel => ({ t: 'relay', hookAttached: !!hookPort, readyState: document.readyState, ageMs: Math.round(performance.now() - startedAt) });
  const tell = (p: chrome.runtime.Port, m: HookToPanel) => {
    try {
      p.postMessage(wrap(m));
    } catch {
      panels.delete(p);
    }
  };

  const onWindowMessage = (ev: MessageEvent) => {
    if (ev.source !== window || hookPort) return;
    const msg = unwrap<{ t: string }>(ev.data);
    if (msg?.t !== 'zd-port' || !ev.ports?.[0]) return;
    hookPort = ev.ports[0];
    window.removeEventListener('message', onWindowMessage, true);
    hookPort.onmessage = (e) => {
      const m = unwrap<HookToPanel>(e.data);
      if (!m) return;
      for (const p of panels) {
        try {
          p.postMessage(wrap(m));
        } catch {
          panels.delete(p);
        }
      }
    };
    hookPort.start();
    for (const p of panels) tell(p, status());
    for (const q of queued.splice(0)) hookPort.postMessage(wrap(q));
  };
  window.addEventListener('message', onWindowMessage, true);
  // If the hook ran first and its offer was already delivered to nobody, ask it to offer again.
  // Synchronous, at document_start, so no page script can answer in its place.
  try {
    document.dispatchEvent(new Event(RELAY_READY_EVENT));
  } catch {
    /* */
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== RUNTIME_PORT_NAME) return;
    // Only our own extension pages can connect (no externally_connectable), so the sender is trusted.
    panels.add(port);
    tell(port, status());
    port.onDisconnect.addListener(() => {
      panels.delete(port);
      // The panel closed (or moved to another tab): nothing is left to explain the highlights on
      // DRA's map, so take them off, with the area and cluster outlines, and stop any drawing (its clicks would
      // otherwise go nowhere). A reopened panel puts the area back.
      if (panels.size === 0 && hookPort) {
        hookPort.postMessage(wrap<PanelToHook>({ t: 'clear-highlight' }));
        hookPort.postMessage(wrap<PanelToHook>({ t: 'area-draw-cancel' }));
        hookPort.postMessage(wrap<PanelToHook>({ t: 'area-show', ring: null }));
        hookPort.postMessage(wrap<PanelToHook>({ t: 'clusters-show', fc: null }));
      }
    });
    port.onMessage.addListener((data) => {
      const m = unwrap<PanelToHook>(data);
      if (!m) return;
      if (hookPort) hookPort.postMessage(wrap(m));
      else queued.push(m);
    });
  });
}
