/**
 * Our highlight layers on DRA's map (SPEC "Highlight layer rules").
 *
 * - One GeoJSON source and fill / line / label layers, every ID prefixed `zd-` (never `dra-`).
 * - Raised back to the top after DRA re-renders (DRA moves its own layers to the top on every render).
 * - Re-added on style.load (a basemap switch calls setStyle(..., {diff:false}) and drops every layer).
 * - Labels: a symbol layer when the style has glyphs and a text-font we know exists; else HTML labels.
 *
 * Works on any Mapbox GL v2 / MapLibre map object; it never touches DRA's own layers.
 */

import type { BBox, HighlightFC, HighlightStatus } from '../shared/protocol';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyMap = any;

export const ZD_SOURCE = 'zd-src';
export const ZD_FILL = 'zd-fill';
export const ZD_LINE = 'zd-line';
export const ZD_LABEL = 'zd-label';
const ALL_LAYERS = [ZD_FILL, ZD_LINE, ZD_LABEL];

const COLOR = [
  'match',
  ['get', 'role'],
  'remove', '#d7263d',
  'add', '#1b65d6',
  'erase', '#757575',
  'done', '#2fa84f',
  'precinct', '#ff9800',
  'border', '#9c27b0',
  /* preview */ '#ffb300',
];

const EMPTY: HighlightFC = { type: 'FeatureCollection', features: [] };

export class HighlightLayers {
  private map: AnyMap | null = null;
  private fc: HighlightFC = EMPTY;
  /** What `fc` shows, so an identical update is dropped (see setData). */
  private fcKey = '';
  /**
   * The data and source object last written with source.setData(), and the data the HTML labels
   * were last built from. ensure() runs on every poll tick to put back anything DRA removed; it
   * must not rewrite data that is already there, because every setData makes Mapbox place the
   * number labels again with a fade, which showed up live as flickering numbers.
   */
  private appliedFc: HighlightFC | null = null;
  private appliedSource: unknown = null;
  private labelsFc: HighlightFC | null = null;
  private rafPending = false;
  private labelDiv: HTMLDivElement | null = null;
  private labelMode: HighlightStatus['labelMode'] = 'none';
  private styleLoads = 0;
  private dataWrites = 0;
  private raises = 0;
  private readonly onStyleLoad = () => {
    this.styleLoads++;
    this.ensure();
  };
  private readonly onStyleData = () => this.scheduleRaise();
  private readonly onMove = () => this.positionHtmlLabels();

  constructor(private readonly getMap: () => AnyMap | null) {}

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
      m.on('move', this.onMove);
      m.on('resize', this.onMove);
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
      m.off('move', this.onMove);
      m.off('resize', this.onMove);
    } catch {
      /* */
    }
    this.labelDiv?.remove();
    this.labelDiv = null;
    this.labelsFc = null;
    this.appliedFc = null;
    this.appliedSource = null;
    this.map = null;
  }

  setData(fc: HighlightFC) {
    // The panel may send the same picture again (a snapshot arrived, nothing visible changed).
    const key = JSON.stringify(fc.features.map((f) => [f.id ?? f.properties.geoid ?? '', f.properties.role, f.properties.label ?? '', f.geometry.type, f.geometry.type === 'Point' ? f.geometry.coordinates : 0]));
    if (key !== this.fcKey || fc.features.length !== this.fc.features.length) {
      this.fcKey = key;
      this.fc = fc;
    }
    this.ensure();
  }

  clear() {
    this.setData(EMPTY);
  }

  fit(bbox: BBox) {
    const m = this.attach();
    if (!m) return;
    try {
      m.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 80, maxZoom: 16, duration: 500 },
      );
    } catch {
      /* */
    }
  }

  private styleReady(m: AnyMap): boolean {
    try {
      return !!m.getStyle() && (typeof m.isStyleLoaded !== 'function' || m.isStyleLoaded() !== false);
    } catch {
      return false;
    }
  }

  /** Add (or refresh) the source and layers, then make sure they're on top. */
  ensure() {
    const m = this.attach();
    if (!m) return;
    if (!this.styleReady(m)) {
      // style.load will call us again.
      return;
    }
    try {
      const src = m.getSource(ZD_SOURCE);
      if (!src) {
        m.addSource(ZD_SOURCE, { type: 'geojson', data: this.fc });
        this.dataWrites++;
        this.appliedFc = this.fc;
        this.appliedSource = m.getSource(ZD_SOURCE);
      } else if (this.appliedFc !== this.fc || this.appliedSource !== src) {
        src.setData(this.fc);
        this.dataWrites++;
        this.appliedFc = this.fc;
        this.appliedSource = src;
      }
      if (!m.getLayer(ZD_FILL)) {
        m.addLayer({
          id: ZD_FILL,
          type: 'fill',
          source: ZD_SOURCE,
          filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!=', ['get', 'role'], 'precinct']],
          paint: { 'fill-color': COLOR, 'fill-opacity': 0.45 },
        });
      }
      if (!m.getLayer(ZD_LINE)) {
        m.addLayer({
          id: ZD_LINE,
          type: 'line',
          source: ZD_SOURCE,
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
          paint: {
            'line-color': COLOR,
            'line-width': ['match', ['get', 'role'], 'precinct', 3, 'border', 4, 1.5],
          },
        });
      }
      const font = this.knownTextFont(m);
      if (font) {
        this.labelMode = 'symbol';
        this.labelDiv?.remove();
        this.labelDiv = null;
        if (!m.getLayer(ZD_LABEL)) {
          m.addLayer({
            id: ZD_LABEL,
            type: 'symbol',
            source: ZD_SOURCE,
            filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'label']],
            layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 13, 'text-allow-overlap': true },
            paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 2 },
          });
        }
      } else {
        this.labelMode = 'html';
        if (this.labelsFc !== this.fc || (this.labelDiv && !this.labelDiv.isConnected) || (!this.labelDiv && this.fc.features.some((f) => f.geometry.type === 'Point' && f.properties.label))) {
          this.renderHtmlLabels(m);
          this.labelsFc = this.fc;
        } else this.positionHtmlLabels();
      }
    } catch (e) {
      console.warn('[zd] highlight ensure failed', e);
    }
    this.raise();
  }

  /** A text-font already used by the style, so its glyphs are known to exist. */
  private knownTextFont(m: AnyMap): string[] | null {
    try {
      const style = m.getStyle();
      if (!style?.glyphs) return null;
      for (const l of style.layers ?? []) {
        const f = l.layout?.['text-font'];
        if (Array.isArray(f) && f.every((x: unknown) => typeof x === 'string')) return f as string[];
      }
    } catch {
      /* */
    }
    return null;
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
      if (!m.getLayer?.(ZD_FILL) && this.styleReady(m)) this.ensure();
      else this.raise();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** Move our layers to the top if anything (DRA) was moved above them. */
  raise() {
    const m = this.map;
    if (!m) return;
    const ours = ALL_LAYERS.filter((id) => m.getLayer?.(id));
    if (!ours.length) return;
    const order = this.layerOrder(m);
    const tail = order.slice(order.length - ours.length);
    if (tail.join('|') === ours.join('|')) return;
    try {
      for (const id of ours) m.moveLayer(id);
      this.raises++;
    } catch {
      /* */
    }
  }

  // --- HTML labels -------------------------------------------------------------

  private renderHtmlLabels(m: AnyMap) {
    const pts = this.fc.features.filter((f) => f.geometry.type === 'Point' && f.properties.label);
    if (!pts.length) {
      this.labelDiv?.remove();
      this.labelDiv = null;
      return;
    }
    const container: HTMLElement = m.getContainer();
    if (!this.labelDiv || !this.labelDiv.isConnected) {
      this.labelDiv = document.createElement('div');
      this.labelDiv.className = 'zd-labels';
      this.labelDiv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden;';
      container.appendChild(this.labelDiv);
    }
    this.labelDiv.replaceChildren(
      ...pts.map((f) => {
        const el = document.createElement('div');
        el.className = 'zd-label';
        el.textContent = f.properties.label ?? '';
        const c = f.properties.role === 'done' ? '#2fa84f' : f.properties.role === 'remove' ? '#d7263d' : f.properties.role === 'erase' ? '#757575' : '#1b65d6';
        el.style.cssText = `position:absolute;transform:translate(-50%,-50%);font:bold 12px/1 system-ui,sans-serif;color:#fff;background:${c};border:1.5px solid #fff;border-radius:9px;padding:2px 5px;white-space:nowrap;`;
        (el as HTMLDivElement & { _ll?: unknown })._ll = (f.geometry as { coordinates: [number, number] }).coordinates;
        return el;
      }),
    );
    this.positionHtmlLabels();
  }

  private positionHtmlLabels() {
    const m = this.map;
    const div = this.labelDiv;
    if (!m || !div) return;
    for (const el of Array.from(div.children) as Array<HTMLElement & { _ll?: [number, number] }>) {
      if (!el._ll) continue;
      const p = m.project(el._ll);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }
  }

  status(): HighlightStatus {
    const m = this.attach();
    if (!m) {
      return { mapPresent: false, layers: [], onTop: false, featureCount: this.fc.features.length, rendered: 0, labelMode: this.labelMode, htmlLabels: 0, styleLoads: this.styleLoads, raises: this.raises, dataWrites: this.dataWrites };
    }
    const order = this.layerOrder(m);
    const ours = order.filter((id) => id.startsWith('zd-'));
    const tail = order.slice(order.length - ours.length);
    let featureCount = 0;
    try {
      // Mapbox GL v2 keeps the object in _data; MapLibre 5 wraps it ({ geojson }).
      const d = m.getSource(ZD_SOURCE)?._data;
      const fc = d?.features ? d : d?.geojson;
      featureCount = fc?.features?.length ?? 0;
    } catch {
      /* */
    }
    let rendered = 0;
    try {
      if (m.getSource(ZD_SOURCE)) rendered = m.querySourceFeatures(ZD_SOURCE).length;
    } catch {
      /* */
    }
    return {
      mapPresent: true,
      layers: ours,
      onTop: ours.length > 0 && tail.join('|') === ours.join('|'),
      featureCount,
      rendered,
      labelMode: this.labelMode,
      htmlLabels: this.labelDiv?.children.length ?? 0,
      styleLoads: this.styleLoads,
      raises: this.raises, dataWrites: this.dataWrites,
    };
  }
}
