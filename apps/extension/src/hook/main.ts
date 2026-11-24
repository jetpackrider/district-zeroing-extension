/**
 * MAIN-world side of the bridge. Started at document_start, before any DRA code runs:
 *  1. traps the mapboxgl.Map constructor (fallback map handle),
 *  2. creates a private MessageChannel and hands one end to the isolated relay,
 *  3. waits for window.dra and an open plan, self-checks every hook, then streams snapshots.
 *
 * Nothing on the page can reach our end of the channel: it lives in this closure.
 */

import * as dra from '../dra/hooks';
import { HighlightLayers } from './highlight';
import { HOOK_VERSION, RELAY_READY_EVENT, unwrap, wrap, type HookPerf, type HookSnapshot, type HookToPanel, type PanelToHook, type SelfCheck } from '../shared/protocol';

const POLL_MS = 300;
/**
 * Once every required hook has passed, the full self-check is re-run only this often (and after any
 * read fails). It used to run on every tick; at New York scale that cost ~16 ms per 300 ms tick on
 * DRA's main thread (it touches every feature of fullBlockMap()).
 */
const RECHECK_MS = 10_000;
/** After DRA appears, how long a failing required hook may stay failing before we report it. */
const DEFAULT_GRACE_MS = 20_000;
/** Test builds let the fixture shorten the grace period (data-zd-grace-ms on <html>). */
const graceMs = () => (__ZD_TEST__ && Number(document.documentElement.dataset.zdGraceMs)) || DEFAULT_GRACE_MS;

export function startHook(): void {
  if ((window as unknown as { __zdHookStarted?: boolean }).__zdHookStarted) return;
  Object.defineProperty(window, '__zdHookStarted', { value: true });

  try {
    dra.installMapConstructorTrap('mapboxgl');
  } catch {
    /* the trap is only a fallback map handle; never let it stop the bridge */
  }

  // The private channel(s) to the relay. Normally one. A second is offered, once, if the relay
  // announces itself after the first offer was posted (see RELAY_READY_EVENT): the first may have
  // been delivered before the relay was listening. The relay keeps whichever arrives first; the
  // other end is simply never answered.
  const ports: MessagePort[] = [];
  /**
   * Ports the relay has actually spoken on. Only these are written to: a port whose other end
   * nobody took would queue every snapshot forever.
   */
  const live = new Set<MessagePort>();
  const MAX_OFFERS = 2;
  let onPanelMessage: (ev: MessageEvent) => void = () => {};
  const offer = () => {
    if (ports.length >= MAX_OFFERS) return;
    const channel = new MessageChannel();
    const mine = channel.port1;
    mine.onmessage = (ev) => {
      live.add(mine);
      onPanelMessage(ev);
    };
    ports.push(mine);
    window.postMessage(wrap({ t: 'zd-port' }), location.origin === 'null' ? '*' : location.origin, [channel.port2]);
  };
  document.addEventListener(RELAY_READY_EVENT, offer, { once: true });
  offer();

  const highlight = new HighlightLayers(() => (dra.mapForcedMissing() ? null : dra.getMap()));
  const send = (msg: HookToPanel) => {
    for (const p of live) p.postMessage(wrap(msg));
  };
  /** An exception escaping the poll loop would otherwise vanish; report each distinct one once. */
  let lastThrown = '';
  const report = (where: string, e: unknown) => {
    const text = `${where}: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`.slice(0, 1500);
    if (text === lastThrown) return;
    lastThrown = text;
    try {
      send({ t: 'error', message: text });
    } catch {
      /* */
    }
  };

  let seq = 0;
  let lastSig = '';
  let lastCheck: SelfCheck | null = null;
  let lastCheckSent = '';
  let firstSeenDra = 0;
  let stateHooked = false;
  let pendingFlush = false;
  let checkedAt = -Infinity;
  const perf: HookPerf = { ticks: 0, tickAvgMs: 0, tickMaxMs: 0, readMs: 0, selfCheckMs: 0, mappingMs: 0 };
  let tickTotal = 0;
  const timedSelfCheck = (light = false) => {
    const t0 = performance.now();
    const c = dra.selfCheck(light && lastCheck?.ok ? { light: true, prevSeen: lastCheck.seen } : {});
    perf.selfCheckMs = performance.now() - t0;
    return c;
  };

  const sendCheck = (check: SelfCheck) => {
    const key = JSON.stringify(check.items.map((i) => [i.id, i.ok]));
    lastCheck = check;
    if (key === lastCheckSent) return;
    lastCheckSent = key;
    send({ t: 'self-check', check, hookVersion: HOOK_VERSION });
  };

  const fullSignature = (): string => {
    const m = dra.getModel();
    // District pops are part of the signature: DRA recomputes aggregates lazily after an edit.
    const pops = dra.readDistricts(m).map((d) => d.pop).join(',');
    return `${dra.readSignature(m)}|${pops}|${dra.readPendingShatter(m).join(',')}|${dra.paintSignature(m)}`;
  };

  /** Our copy of the feature map as last sent, and that snapshot's seq (deltas are against it). */
  let sentFeatures: Record<string, number> | null = null;
  let sentCount = 0;
  let sentSeq = 0;
  /** readSignature() when the features were last read: unchanged stamps = unchanged fullBlockMap(). */
  let featureSig = '';
  let featuresReadAt = 0;
  /** Even with unchanged stamps, really re-read the features this often (stamps are unverified live). */
  const FEATURE_RECHECK_MS = 2000;

  const sendSnapshot = (force = false) => {
    try {
      const m = dra.getModel();
      const sig = fullSignature();
      if (!force && sig === lastSig) return;
      lastSig = sig;
      const t0 = performance.now();
      const mySeq = ++seq;
      let features: Pick<HookSnapshot, 'featureMap' | 'featureDelta'>;
      const stamps = dra.readSignature(m);
      if (force || !sentFeatures) {
        sentFeatures = dra.readFeatureMap(m);
        sentCount = Object.keys(sentFeatures).length;
        featuresReadAt = performance.now();
        features = { featureMap: sentFeatures };
      } else if (stamps === featureSig && !stamps.includes('?') && performance.now() - featuresReadAt < FEATURE_RECHECK_MS) {
        // Only district pops changed (DRA recomputes aggregates lazily after an edit): same features.
        features = { featureDelta: { base: sentSeq, set: {}, del: [] } };
      } else {
        const d = dra.diffFeatureMap(sentFeatures, sentCount, m);
        sentCount = d.count;
        featuresReadAt = performance.now();
        features = { featureDelta: { base: sentSeq, set: d.set, del: d.del } };
      }
      featureSig = stamps;
      sentSeq = mySeq;
      const snap: HookSnapshot = {
        seq: mySeq,
        sig,
        info: dra.readInfo(m),
        districts: dra.readDistricts(m),
        ...features,
        blockMappingStamp: dra.readBlockMappingStamp(m),
        pendingShatter: dra.readPendingShatter(m),
        paint: dra.paintAvailability(m),
      };
      perf.readMs = performance.now() - t0;
      send({ t: 'snapshot', snap: { ...snap, hookPerf: { ...perf } } });
      perf.sendMs = performance.now() - t0 - perf.readMs; // structured clone (reported with the next snapshot)
    } catch (e) {
      // A hook broke mid-session: re-run the self-check so the panel learns which one.
      lastSig = '';
      sentFeatures = null;
      sendCheck(dra.selfCheck());
      if (!(e instanceof dra.HookError)) send({ t: 'error', message: String(e) });
    }
  };

  const tick = () => {
    const t0 = performance.now();
    try {
      tickInner();
    } catch (e) {
      report('poll', e);
    } finally {
      const ms = performance.now() - t0;
      perf.ticks++;
      tickTotal += ms;
      perf.tickTotalMs = tickTotal;
      perf.tickAvgMs = tickTotal / perf.ticks;
      if (ms > perf.tickMaxMs) perf.tickMaxMs = ms;
    }
  };

  const tickInner = () => {
    if (!dra.draPresent()) {
      if (document.readyState !== 'loading' && !firstSeenDra) {
        // DRA sets window.dra on DOMContentLoaded; if it's still missing well after that, report it.
        firstSeenDra = -performance.now();
      }
      if (firstSeenDra < 0 && performance.now() + firstSeenDra > graceMs()) sendCheck(timedSelfCheck());
      return;
    }
    if (firstSeenDra <= 0) firstSeenDra = performance.now();
    if (!stateHooked) stateHooked = dra.onStateEvent(() => flushSoon());
    if (!dra.planOpen()) {
      // No map open (home page, map list): report "no plan" without blaming the hooks.
      sendCheck({ ok: false, mapOk: false, items: [{ id: 'dra.model()', ok: false, required: true, detail: 'no plan open' }], firstFailure: 'dra.model()', seen: dra.readSeen() });
      return;
    }
    if (!lastCheck?.ok || performance.now() - checkedAt > RECHECK_MS) {
      const check = timedSelfCheck(true);
      checkedAt = performance.now();
      if (check.ok || performance.now() - firstSeenDra > graceMs()) sendCheck(check);
      if (!check.ok) {
        lastCheck = check; // keep re-checking every tick until it passes
        return;
      }
    }
    sendSnapshot();
    highlight.ensure();
  };

  const flushSoon = () => {
    if (pendingFlush) return;
    pendingFlush = true;
    setTimeout(() => {
      pendingFlush = false;
      if (lastCheck?.ok) sendSnapshot();
    }, 30);
  };

  onPanelMessage = (ev) => {
    const msg = unwrap<PanelToHook>(ev.data);
    if (!msg) return;
    try {
      handle(msg);
    } catch (e) {
      report(`on ${msg.t}`, e);
    }
  };
  /** One paint at a time, whatever the panel asks. */
  let painting = false;
  const handle = (msg: PanelToHook) => {
    switch (msg.t) {
      case 'hello':
        lastThrown = '';
        send({ t: 'alive', hookVersion: HOOK_VERSION, draPresent: dra.draPresent(), planOpen: dra.planOpen(), readyState: document.readyState, offers: ports.length });
        lastCheckSent = '';
        if (lastCheck) sendCheck(lastCheck);
        else tick();
        if (lastCheck?.ok) sendSnapshot(true);
        break;
      case 'request-snapshot':
        sendSnapshot(true);
        break;
      case 'run-self-check':
        lastCheckSent = '';
        sendCheck(dra.selfCheck());
        break;
      case 'request-block-mapping':
        try {
          const t0 = performance.now();
          const mapping = dra.readBlockMapping();
          send({ t: 'block-mapping', mapping });
          perf.mappingMs = performance.now() - t0; // read + structured clone onto the channel
        } catch (e) {
          send({ t: 'error', message: String(e) });
        }
        break;
      case 'highlight':
        highlight.setData(msg.fc);
        if (msg.fit) highlight.fit(msg.fit);
        break;
      case 'clear-highlight':
        highlight.clear();
        break;
      case 'fit':
        highlight.fit(msg.bbox);
        break;
      case 'probe-highlight':
        send({ t: 'highlight-status', status: highlight.status(), reqId: msg.reqId });
        break;
      case 'paint-step': {
        const { reqId, step } = msg;
        if (painting) {
          send({ t: 'paint-result', reqId, result: { status: 'refused', stepId: step.stepId, reason: 'Another step is still being painted.' } });
          break;
        }
        painting = true;
        dra
          .paintStep(step)
          .then((result) => send({ t: 'paint-result', reqId, result }))
          .catch((e) =>
            send({ t: 'paint-result', reqId, result: { status: 'mismatch', stepId: step.stepId, summary: 'The paint failed in an unexpected way, so the extension cannot tell what changed.', details: [String(e), "Check the precinct in DRA. If it changed, DRA's Undo takes the edit back."], changedSomething: true, undoRecorded: false } }),
          )
          .finally(() => {
            painting = false;
            if (lastCheck?.ok) sendSnapshot();
          });
        break;
      }
    }
  };

  setInterval(tick, POLL_MS);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(tick, 0));
}
