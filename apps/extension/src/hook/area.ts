/**
 * The user's area on DRA's map (PanelState.area): its outline, and the drawing mode that makes one.
 *
 * Outline: one GeoJSON source and fill / line / corner layers, ids prefixed `zd-area-`, a dashed
 * teal outline with a very light fill (none of the walkthrough's colors). Like the highlight layers
 * (highlight.ts) they are put back after a basemap switch (style.load) and raised after DRA
 * re-renders, always directly under the highlight layers so the numbered blocks stay on top. The
 * data is written only when it changed. With nothing to show the layers are taken off the map.
 *
 * Drawing: a transparent overlay over the map takes every pointer event, so DRA never sees the
 * clicks (it would paint). Click adds a corner; double-click, clicking the first corner or Enter
 * finishes (at least 3 corners); Backspace takes the last corner back; Esc cancels. Dragging pans
 * the map (panBy) and the wheel zooms it around the pointer (easeTo), so the user can move around
 * while drawing. The overlay is re-attached if DRA re-renders its map container or replaces the
 * map; the corners are kept as longitude/latitude, so they survive any of that.
 */
import { AREA_MAP_FUNCTIONS } from '../dra/hooks';
import type { AreaRing, AreaStatus, PanelToHook } from '../shared/protocol';
import { ringSelfCrosses } from '../shared/ring';
import { ZD_FILL, ZD_LABEL, ZD_LINE } from './highlight';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyMap = any;

export const ZD_AREA_SOURCE = 'zd-area-src';
export const ZD_AREA_FILL = 'zd-area-fill';
export const ZD_AREA_LINE = 'zd-area-line';
export const ZD_AREA_DRAFT = 'zd-area-draft';
export const ZD_AREA_CORNER = 'zd-area-corner';
const AREA_LAYERS = [ZD_AREA_FILL, ZD_AREA_LINE, ZD_AREA_DRAFT, ZD_AREA_CORNER];
/** The walkthrough highlight layers (highlight.ts); ours go directly under them. */
const HIGHLIGHT_LAYERS = [ZD_FILL, ZD_LINE, ZD_LABEL];

/** Teal: not one of the walkthrough roles' colors (red, blue, grey, green, orange, purple, amber). */
const AREA_COLOR = '#00838f';

/** A click this close (px) to the first corner closes the outline. */
const CLOSE_PX = 10;
/** Two clicks this close in time (ms) and place (px) are a double-click. */
const DOUBLE_MS = 400;
const DOUBLE_PX = 8;
/** A press that moves further than this (px) is a drag (pan), not a click. */
const DRAG_PX = 4;
/**
 * What a press on the map produces. While drawing, none of it may reach DRA's map, which would
 * paint: the overlay takes them, and the guard (AreaLayers.guard) stops any that miss it.
 */
const PRESS_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend'];

type Feature = { type: 'Feature'; properties: Record<string, string | boolean>; geometry: { type: string; coordinates: unknown } };
type FC = { type: 'FeatureCollection'; features: Feature[] };
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

export interface AreaCallbacks {
  /** The user finished an outline (drawing mode is over). */
  drawn: (ring: AreaRing) => void;
  /** Drawing stopped on the page without an outline (Esc). */
  cancelled: () => void;
  picked: (reqId: number, point: [number, number] | null) => void;
}

export class AreaLayers {
  private map: AnyMap | null = null;
  /** The finished area (as the panel last sent it, or as just drawn). */
  private ring: AreaRing | null = null;
  private drawing = false;
  private pick: Extract<PanelToHook, { t: 'area-pick-start' }> | undefined;
  private corners: AreaRing = [];
  /** Where the pointer is while drawing (longitude, latitude), for the rubber-band edge. */
  private cursor: [number, number] | null = null;
  private nearFirst = false;
  private fc: FC = EMPTY;
  private appliedFc: FC | null = null;
  private appliedSource: unknown = null;
  private overlay: HTMLDivElement | null = null;
  private hint: HTMLDivElement | null = null;
  /** Watches the map container while drawing, to put the overlay back the moment DRA drops it. */
  private observer: MutationObserver | null = null;
  private observed: HTMLElement | null = null;
  /** The window-level guard is listening (from the start of drawing until the overlay is gone). */
  private guarding = false;
  /** The press in progress on the overlay (a click or a drag). */
  private press: { id: number; x0: number; y0: number; x: number; y: number; moved: boolean } | null = null;
  private lastClick: { x: number; y: number; t: number } | null = null;
  /** After finishing, the overlay stays a moment to swallow the rest of a double-click. */
  private closingTimer: ReturnType<typeof setTimeout> | null = null;
  private rafPending = false;
  private drawPending = false;
  private dataWrites = 0;
  private clicks = 0;
  private pans = 0;
  private zooms = 0;

  private readonly onStyleLoad = () => this.ensure();
  private readonly onStyleData = () => this.scheduleRaise();

  constructor(
    private readonly getMap: () => AnyMap | null,
    private readonly cb: AreaCallbacks,
  ) {}

  // --- map attachment -------------------------------------------------------------

  /** Re-acquire the map if DRA replaced it. Returns the current map or null. */
  private attach(): AnyMap | null {
    const m = this.getMap();
    if (m === this.map) return m;
    this.detach();
    this.map = m;
    if (m) {
      m.on('style.load', this.onStyleLoad);
      m.on('styledata', this.onStyleData);
      m.on('idle', this.onStyleData);
    }
    return m;
  }

  private detach() {
    const m = this.map;
    if (!m) return;
    try {
      m.off('style.load', this.onStyleLoad);
      m.off('styledata', this.onStyleData);
      m.off('idle', this.onStyleData);
    } catch {
      /* */
    }
    // The overlay belongs to the old map's container; ensure() mounts a new one on the new map.
    this.overlay?.remove();
    this.overlay = null;
    this.watchContainer(null);
    this.hint = null;
    this.press = null;
    this.appliedFc = null;
    this.appliedSource = null;
    this.map = null;
  }

  // --- what the panel asks for ----------------------------------------------------------

  /** The finished area to show; null = none. */
  setRing(ring: AreaRing | null) {
    const next = ring && ring.length >= 3 ? ring.map((p) => [p[0], p[1]] as [number, number]) : null;
    // The panel sends the ring again after every reconnect; only a different one is written.
    if (JSON.stringify(next) === JSON.stringify(this.ring)) return;
    this.ring = next;
    this.rebuild();
  }

  /** Starts drawing. Returns why it cannot, or null when it has started. */
  startDrawing(pick?: Extract<PanelToHook, { t: 'area-pick-start' }>): string | null {
    const m = this.attach();
    if (!m) return "There is no DRA map on this page to draw on.";
    const missing = AREA_MAP_FUNCTIONS.filter((f) => typeof m[f] !== 'function');
    if (missing.length) return `DRA's map lacks what drawing needs (${missing.join(', ')}).`;
    if (this.closingTimer) {
      clearTimeout(this.closingTimer);
      this.closingTimer = null;
      this.overlay?.remove();
      this.overlay = null;
    }
    this.drawing = true;
    this.pick = pick;
    this.corners = [];
    this.cursor = null;
    this.nearFirst = false;
    this.lastClick = null;
    this.press = null;
    window.addEventListener('keydown', this.onKey, true);
    this.setGuard(true);
    this.mountOverlay(m);
    this.updateHint();
    this.rebuild();
    return null;
  }

  /** Stops drawing (the panel's Cancel, or the panel went away). The finished area stays. */
  stopDrawing() {
    if (!this.drawing && !this.overlay) return;
    this.endDrawing(false);
  }

  /** The part of the map in view, as the ring of its four corners. */
  viewRing(): AreaRing | null {
    const m = this.attach();
    if (!m) return null;
    try {
      const c: HTMLCanvasElement = m.getCanvas();
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (w > 0 && h > 0 && typeof m.unproject === 'function') {
        return [
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
        ].map((p) => {
          const ll = m.unproject(p);
          return [ll.lng, ll.lat] as [number, number];
        });
      }
      const b = m.getBounds();
      return [
        [b.getWest(), b.getSouth()],
        [b.getEast(), b.getSouth()],
        [b.getEast(), b.getNorth()],
        [b.getWest(), b.getNorth()],
      ];
    } catch {
      return null;
    }
  }

  // --- drawing ------------------------------------------------------------------------

  private endDrawing(keepOverlayBriefly: boolean) {
    this.drawing = false;
    this.pick = undefined;
    this.corners = [];
    this.cursor = null;
    this.nearFirst = false;
    this.press = null;
    this.lastClick = null;
    window.removeEventListener('keydown', this.onKey, true);
    if (this.closingTimer) clearTimeout(this.closingTimer);
    this.closingTimer = null;
    if (keepOverlayBriefly && this.overlay) {
      // The second click of a double-click (and its click / dblclick events) must not reach DRA.
      const el = this.overlay;
      el.style.cursor = 'default';
      this.hint?.remove();
      this.hint = null;
      this.closingTimer = setTimeout(() => {
        this.closingTimer = null;
        if (this.overlay === el && !this.drawing) {
          el.remove();
          this.overlay = null;
          this.watchContainer(null);
          this.setGuard(false);
        }
      }, DOUBLE_MS + 100);
    } else {
      this.overlay?.remove();
      this.overlay = null;
      this.hint = null;
      this.watchContainer(null);
      this.setGuard(false);
    }
    this.rebuild();
  }

  /**
   * DRA re-rendering its map pane drops the overlay. ensure() puts it back on the next poll tick
   * or map event, but a click in that gap (a few hundred ms, or as long as the poll is held up)
   * would reach DRA's map and paint. So while drawing, a MutationObserver on the map container
   * puts it back as soon as it goes (before the next input event is handled), and a capture
   * listener on the window stops any press on the map that does not land on the overlay (DRA
   * replaced the whole container, say) and mounts the overlay again.
   */
  private watchContainer(container: HTMLElement | null) {
    if (container === this.observed) return;
    this.observer?.disconnect();
    this.observed = container;
    if (!container || typeof MutationObserver !== 'function') return;
    this.observer ??= new MutationObserver(() => {
      if ((this.drawing || this.closingTimer) && this.map && !this.overlay?.isConnected) this.mountOverlay(this.map);
    });
    this.observer.observe(container, { childList: true });
  }

  private setGuard(on: boolean) {
    if (on === this.guarding) return;
    this.guarding = on;
    for (const type of PRESS_EVENTS) {
      if (on) window.addEventListener(type, this.guard, { capture: true, passive: false });
      else window.removeEventListener(type, this.guard, { capture: true });
    }
  }

  private readonly guard = (e: Event) => {
    if (!this.drawing && !this.closingTimer) return;
    const t = e.target as Node | null;
    if (!t || (this.overlay?.isConnected && this.overlay.contains(t))) return;
    const m = this.attach();
    let container: HTMLElement | null = null;
    try {
      container = m?.getContainer() ?? null;
    } catch {
      container = null;
    }
    if (!container || !(t instanceof Node) || !container.contains(t)) return;
    // A press on DRA's map that the overlay did not take: it must not reach DRA.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (m) this.mountOverlay(m);
  };

  private finish() {
    // Corners on top of the one before, or of the first (a click meant to close the outline), are
    // not corners: they would make a sliver, or a ring the panel refuses.
    this.corners = this.corners.filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    while (this.corners.length > 1 && this.onFirst(this.corners[this.corners.length - 1])) this.corners.pop();
    const ring = this.corners;
    if (ring.length < 3) {
      this.updateHint('An area needs at least 3 corners.');
      this.rebuild();
      return;
    }
    if (ringSelfCrosses(ring)) {
      // The map would fill a crossing outline differently from how its blocks are counted.
      this.updateHint('The outline crosses itself. Backspace removes the last corner.');
      return;
    }
    // Show it right away; the panel confirms with 'area-show'.
    this.ring = ring;
    this.endDrawing(true);
    this.cb.drawn(ring);
  }

  private mountOverlay(m: AnyMap) {
    let container: HTMLElement;
    try {
      container = m.getContainer();
    } catch {
      return;
    }
    if (!container) return;
    if (this.overlay && this.overlay.parentElement === container && this.overlay.isConnected) {
      if (this.drawing) this.watchContainer(container);
      return;
    }
    this.overlay?.remove();
    const el = document.createElement('div');
    el.className = 'zd-area-overlay';
    // Over the canvas and DRA's map controls, under nothing of ours that takes clicks.
    el.style.cssText = 'position:absolute;inset:0;z-index:4;cursor:crosshair;touch-action:none;user-select:none;background:transparent;';
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancelPress);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    // Everything else a pointer produces stops here too: none of it may reach DRA's map.
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend']) el.addEventListener(type, this.swallow, { passive: false });
    if (this.drawing) {
      const hint = document.createElement('div');
      hint.className = 'zd-area-hint';
      hint.style.cssText = `position:absolute;top:8px;left:50%;transform:translateX(-50%);max-width:calc(100% - 24px);pointer-events:none;font:12px/1.35 system-ui,sans-serif;color:#004d54;background:rgba(255,255,255,0.94);border:1px solid ${AREA_COLOR};border-radius:6px;padding:4px 8px;box-shadow:0 1px 3px rgba(0,0,0,0.2);`;
      el.appendChild(hint);
      this.hint = hint;
    }
    container.appendChild(el);
    this.overlay = el;
    if (this.drawing) this.watchContainer(container);
    this.updateHint();
  }

  private updateHint(problem?: string) {
    if (!this.hint) return;
    if (this.pick) {
      this.hint.textContent = `Click the map to pick a ${this.pick.kind}. Drag to pan, wheel to zoom. Esc cancels.`;
      return;
    }
    const n = this.corners.length;
    const how =
      n < 3
        ? `Drawing an area: click the map to add corners (${n} of at least 3). Drag to pan, wheel to zoom. Esc cancels.`
        : `${n} corners. Double-click, click the first corner or press Enter to finish. Backspace removes the last corner. Esc cancels.`;
    this.hint.textContent = problem ? `${problem} ${how}` : how;
  }

  /** The pointer position in the map's canvas pixels. */
  private point(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const m = this.map;
    const r = (m?.getCanvas?.() as HTMLElement | undefined)?.getBoundingClientRect() ?? this.overlay!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onDown = (e: PointerEvent) => {
    this.swallow(e);
    if (!this.drawing || e.button !== 0) return;
    try {
      this.overlay?.setPointerCapture(e.pointerId);
    } catch {
      /* */
    }
    const p = this.point(e);
    this.press = { id: e.pointerId, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false };
  };

  private readonly onMove = (e: PointerEvent) => {
    this.swallow(e);
    const m = this.map;
    if (!this.drawing || !m) return;
    const p = this.point(e);
    const press = this.press;
    if (press && press.id === e.pointerId) {
      if (!press.moved && Math.hypot(p.x - press.x0, p.y - press.y0) > DRAG_PX) press.moved = true;
      if (press.moved) {
        const dx = p.x - press.x;
        const dy = p.y - press.y;
        press.x = p.x;
        press.y = p.y;
        // Drag-to-pan, as the map would do it (unless DRA turned dragging off).
        if ((dx || dy) && m.dragPan?.isEnabled?.() !== false) {
          try {
            m.panBy([-dx, -dy], { duration: 0, animate: false });
          } catch {
            /* */
          }
        }
      }
      return;
    }
    if (this.pick) return;
    try {
      const ll = m.unproject([p.x, p.y]);
      this.cursor = [ll.lng, ll.lat];
      this.nearFirst = this.corners.length >= 3 && this.distToFirst(p) <= CLOSE_PX;
    } catch {
      this.cursor = null;
    }
    this.scheduleDraw();
  };

  private readonly onUp = (e: PointerEvent) => {
    this.swallow(e);
    const press = this.press;
    if (!press || press.id !== e.pointerId) return;
    this.press = null;
    try {
      this.overlay?.releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
    if (!this.drawing) return;
    if (press.moved) {
      this.pans++;
      return;
    }
    this.click(this.point(e));
  };

  private readonly onCancelPress = (e: PointerEvent) => {
    this.swallow(e);
    this.press = null;
  };

  private readonly onWheel = (e: WheelEvent) => {
    this.swallow(e);
    const m = this.map;
    if (!this.drawing || !m || m.scrollZoom?.isEnabled?.() === false) return;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 40;
    else if (e.deltaMode === 2) dy *= 800;
    const dz = Math.max(-1, Math.min(1, -dy / 300));
    if (!dz) return;
    const p = this.point(e);
    try {
      m.easeTo({ zoom: m.getZoom() + dz, around: m.unproject([p.x, p.y]), duration: 0, animate: false });
      this.zooms++;
    } catch {
      /* */
    }
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.drawing) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const pick = this.pick;
      this.endDrawing(false);
      if (pick) this.cb.picked(pick.reqId, null);
      else this.cb.cancelled();
    } else if (e.key === 'Enter' && !typing && !this.pick) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.finish();
    } else if (e.key === 'Backspace' && !typing && !this.pick) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.corners.pop();
      this.lastClick = null;
      this.updateHint();
      this.rebuild();
    }
  };

  /** A corner (longitude, latitude) within CLOSE_PX of the first corner on screen (not the first itself). */
  private onFirst(c: [number, number]): boolean {
    const m = this.map;
    if (!m || this.corners.length < 2 || c === this.corners[0]) return false;
    try {
      return this.distToFirst(m.project(c)) <= CLOSE_PX;
    } catch {
      return c[0] === this.corners[0][0] && c[1] === this.corners[0][1];
    }
  }

  private distToFirst(p: { x: number; y: number }): number {
    const m = this.map;
    if (!m || !this.corners.length) return Infinity;
    try {
      const f = m.project(this.corners[0]);
      return Math.hypot(f.x - p.x, f.y - p.y);
    } catch {
      return Infinity;
    }
  }

  private click(p: { x: number; y: number }) {
    const m = this.map;
    if (!m) return;
    this.clicks++;
    if (this.pick) {
      let ll: { lng: number; lat: number };
      try {
        ll = m.unproject([p.x, p.y]);
      } catch {
        return;
      }
      const { reqId } = this.pick;
      this.endDrawing(true);
      this.cb.picked(reqId, [ll.lng, ll.lat]);
      return;
    }
    const now = performance.now();
    const last = this.lastClick;
    if (last && now - last.t <= DOUBLE_MS && Math.hypot(p.x - last.x, p.y - last.y) <= DOUBLE_PX) {
      // Second click of a double-click: its first click already placed the last corner.
      this.lastClick = null;
      this.finish();
      return;
    }
    this.lastClick = { x: p.x, y: p.y, t: now };
    if (this.distToFirst(p) <= CLOSE_PX) {
      if (this.corners.length >= 3) this.finish();
      // Closing on the first corner too early: not a corner on top of it (a sliver), but a hint.
      else this.updateHint('An area needs at least 3 corners before it can be closed.');
      return;
    }
    try {
      const ll = m.unproject([p.x, p.y]);
      this.corners.push([ll.lng, ll.lat]);
    } catch {
      return;
    }
    this.updateHint();
    this.rebuild();
  }

  private scheduleDraw() {
    if (this.drawPending) return;
    this.drawPending = true;
    const run = () => {
      this.drawPending = false;
      this.rebuild();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  // --- layers -----------------------------------------------------------------------

  private buildFc(): FC {
    const features: Feature[] = [];
    if (this.ring) features.push({ type: 'Feature', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [[...this.ring, this.ring[0]]] } });
    if (this.drawing && this.corners.length) {
      const pts = this.cursor && !this.nearFirst ? [...this.corners, this.cursor] : [...this.corners];
      if (pts.length >= 3) features.push({ type: 'Feature', properties: { kind: 'draft' }, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
      if (pts.length >= 2) features.push({ type: 'Feature', properties: { kind: 'draft' }, geometry: { type: 'LineString', coordinates: this.nearFirst ? [...pts, pts[0]] : pts } });
      this.corners.forEach((c, i) => features.push({ type: 'Feature', properties: { kind: 'corner', first: i === 0, near: i === 0 && this.nearFirst }, geometry: { type: 'Point', coordinates: c } }));
    }
    return features.length ? { type: 'FeatureCollection', features } : EMPTY;
  }

  private rebuild() {
    this.fc = this.buildFc();
    this.ensure();
  }

  private styleReady(m: AnyMap): boolean {
    try {
      return !!m.getStyle() && (typeof m.isStyleLoaded !== 'function' || m.isStyleLoaded() !== false);
    } catch {
      return false;
    }
  }

  /** Put back the overlay (while drawing) and the layers, write changed data, and keep them in place. */
  ensure() {
    const m = this.attach();
    if (!m) return;
    if (this.drawing) this.mountOverlay(m);
    if (!this.styleReady(m)) return; // style.load calls us again
    try {
      if (!this.fc.features.length) {
        // Nothing to show: take our layers off (they would only sit there empty).
        for (const id of AREA_LAYERS) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(ZD_AREA_SOURCE)) m.removeSource(ZD_AREA_SOURCE);
        this.appliedFc = null;
        this.appliedSource = null;
        return;
      }
      const src = m.getSource(ZD_AREA_SOURCE);
      if (!src) {
        m.addSource(ZD_AREA_SOURCE, { type: 'geojson', data: this.fc });
        this.dataWrites++;
        this.appliedFc = this.fc;
        this.appliedSource = m.getSource(ZD_AREA_SOURCE);
      } else if (this.appliedFc !== this.fc || this.appliedSource !== src) {
        src.setData(this.fc);
        this.dataWrites++;
        this.appliedFc = this.fc;
        this.appliedSource = src;
      }
      const before = HIGHLIGHT_LAYERS.find((id) => m.getLayer(id));
      const add = (spec: object) => m.addLayer(spec, before);
      if (!m.getLayer(ZD_AREA_FILL)) {
        add({
          id: ZD_AREA_FILL,
          type: 'fill',
          source: ZD_AREA_SOURCE,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': AREA_COLOR, 'fill-opacity': ['match', ['get', 'kind'], 'area', 0.07, 0.04] },
        });
      }
      if (!m.getLayer(ZD_AREA_LINE)) {
        add({
          id: ZD_AREA_LINE,
          type: 'line',
          source: ZD_AREA_SOURCE,
          filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'area']],
          paint: { 'line-color': AREA_COLOR, 'line-width': 2, 'line-dasharray': [3, 2] },
        });
      }
      if (!m.getLayer(ZD_AREA_DRAFT)) {
        add({
          id: ZD_AREA_DRAFT,
          type: 'line',
          source: ZD_AREA_SOURCE,
          filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'draft']],
          paint: { 'line-color': AREA_COLOR, 'line-width': 2, 'line-dasharray': [1.5, 1.5] },
        });
      }
      if (!m.getLayer(ZD_AREA_CORNER)) {
        add({
          id: ZD_AREA_CORNER,
          type: 'circle',
          source: ZD_AREA_SOURCE,
          filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'corner']],
          paint: {
            'circle-radius': ['case', ['==', ['get', 'near'], true], 7, ['==', ['get', 'first'], true], 5, 4],
            'circle-color': '#ffffff',
            'circle-stroke-color': AREA_COLOR,
            'circle-stroke-width': 2,
          },
        });
      }
    } catch (e) {
      console.warn('[zd] area ensure failed', e);
    }
    this.raise();
  }

  private layerOrder(m: AnyMap): string[] {
    const order = m.style?._order;
    if (Array.isArray(order)) return order;
    try {
      return (m.getStyle()?.layers ?? []).map((l: { id: string }) => l.id);
    } catch {
      return [];
    }
  }

  private scheduleRaise() {
    if (this.rafPending) return;
    this.rafPending = true;
    const run = () => {
      this.rafPending = false;
      const m = this.map;
      if (!m) return;
      if (this.fc.features.length && !m.getLayer?.(ZD_AREA_FILL) && this.styleReady(m)) this.ensure();
      else this.raise();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /**
   * Keep the style's tail as [area layers, highlight layers]: anything DRA moved above ours goes
   * back under them. The highlight layers raise themselves to the very top (highlight.ts); when that
   * leaves DRA's layers between theirs and ours, both are moved here, area first.
   */
  private raise() {
    const m = this.map;
    if (!m) return;
    const ours = AREA_LAYERS.filter((id) => m.getLayer?.(id));
    if (!ours.length) return;
    const want = [...ours, ...HIGHLIGHT_LAYERS.filter((id) => m.getLayer?.(id))];
    const order = this.layerOrder(m);
    if (order.slice(order.length - want.length).join('|') === want.join('|')) return;
    try {
      for (const id of want) m.moveLayer(id);
    } catch {
      /* */
    }
  }

  status(): AreaStatus {
    const m = this.map ?? this.getMap();
    let featureCount = 0;
    let layers: string[] = [];
    if (m) {
      try {
        layers = this.layerOrder(m).filter((id) => AREA_LAYERS.includes(id));
        // Mapbox GL v2 keeps the object in _data; MapLibre 5 wraps it ({ geojson }).
        const d = m.getSource(ZD_AREA_SOURCE)?._data;
        const fc = d?.features ? d : d?.geojson;
        featureCount = fc?.features?.length ?? 0;
      } catch {
        /* */
      }
    }
    return {
      layers,
      ringCorners: this.ring?.length ?? 0,
      featureCount,
      drawing: this.drawing,
      corners: this.corners.length,
      overlay: !!this.overlay?.isConnected,
      dataWrites: this.dataWrites,
      clicks: this.clicks,
      pans: this.pans,
      zooms: this.zooms,
    };
  }
}
