/**
 * County cluster outlines on DRA's map (PanelState.clusters, hovered): one GeoJSON source and
 * fill / line / label layers, ids prefixed `zd-cluster-`. Every county of the clustering is filled
 * lightly in its cluster's color and outlined; one label per cluster ("2 districts"). A hovered
 * cluster stands out and the rest are dimmed (ClusterFeatureProps.emph).
 *
 * Like the area layers (area.ts) they are put back after a basemap switch (style.load) and after
 * DRA re-renders, always directly under the area and highlight layers, so the area outline and the
 * numbered blocks stay on top. The data is written only when it changed; with nothing to show the
 * layers are taken off the map. Labels are a symbol layer when the style has glyphs and a font we
 * know exists, else HTML labels over the map (as highlight.ts does).
 */
import type { ClusterFC, ClusterLayerStatus } from '../shared/protocol';
import { ZD_AREA_CORNER, ZD_AREA_DRAFT, ZD_AREA_FILL, ZD_AREA_LINE } from './area';
import { ZD_FILL, ZD_LABEL, ZD_LINE } from './highlight';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyMap = any;

export const ZD_CLUSTER_SOURCE = 'zd-cluster-src';
export const ZD_CLUSTER_FILL = 'zd-cluster-fill';
export const ZD_CLUSTER_LINE = 'zd-cluster-line';
export const ZD_CLUSTER_LABEL = 'zd-cluster-label';
const CLUSTER_LAYERS = [ZD_CLUSTER_FILL, ZD_CLUSTER_LINE, ZD_CLUSTER_LABEL];
/** The layers that stay above ours: the area outline (area.ts), then the walkthrough highlights (highlight.ts). */
const ABOVE = [ZD_AREA_FILL, ZD_AREA_LINE, ZD_AREA_DRAFT, ZD_AREA_CORNER, ZD_FILL, ZD_LINE, ZD_LABEL];

const EMPTY: ClusterFC = { type: 'FeatureCollection', features: [] };

export class ClusterLayers {
  private map: AnyMap | null = null;
  private fc: ClusterFC = EMPTY;
  private appliedFc: ClusterFC | null = null;
  private appliedSource: unknown = null;
  private labelDiv: HTMLDivElement | null = null;
  private labelsFc: ClusterFC | null = null;
  private rafPending = false;
  private dataWrites = 0;

  private readonly onStyleLoad = () => this.ensure();
  private readonly onStyleData = () => this.scheduleRaise();
  private readonly onMove = () => this.positionHtmlLabels();

  constructor(private readonly getMap: () => AnyMap | null) {}

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

  /** The clustering to show; null = none. */
  setData(fc: ClusterFC | null) {
    this.fc = fc && fc.features.length ? fc : EMPTY;
    this.ensure();
  }

  private styleReady(m: AnyMap): boolean {
    try {
      return !!m.getStyle() && (typeof m.isStyleLoaded !== 'function' || m.isStyleLoaded() !== false);
    } catch {
      return false;
    }
  }

  ensure() {
    const m = this.attach();
    if (!m) return;
    if (!this.styleReady(m)) return; // style.load calls us again
    try {
      if (!this.fc.features.length) {
        for (const id of CLUSTER_LAYERS) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(ZD_CLUSTER_SOURCE)) m.removeSource(ZD_CLUSTER_SOURCE);
        this.appliedFc = null;
        this.appliedSource = null;
        this.labelDiv?.remove();
        this.labelDiv = null;
        this.labelsFc = null;
        return;
      }
      const src = m.getSource(ZD_CLUSTER_SOURCE);
      if (!src) {
        m.addSource(ZD_CLUSTER_SOURCE, { type: 'geojson', data: this.fc });
        this.dataWrites++;
        this.appliedFc = this.fc;
        this.appliedSource = m.getSource(ZD_CLUSTER_SOURCE);
      } else if (this.appliedFc !== this.fc || this.appliedSource !== src) {
        src.setData(this.fc);
        this.dataWrites++;
        this.appliedFc = this.fc;
        this.appliedSource = src;
      }
      const before = ABOVE.find((id) => m.getLayer(id));
      const add = (spec: object) => m.addLayer(spec, before);
      if (!m.getLayer(ZD_CLUSTER_FILL)) {
        add({
          id: ZD_CLUSTER_FILL,
          type: 'fill',
          source: ZD_CLUSTER_SOURCE,
          filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['match', ['get', 'emph'], 2, 0.4, 1, 0.25, 0.06] },
        });
      }
      if (!m.getLayer(ZD_CLUSTER_LINE)) {
        add({
          id: ZD_CLUSTER_LINE,
          type: 'line',
          source: ZD_CLUSTER_SOURCE,
          filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
          paint: { 'line-color': ['get', 'color'], 'line-width': ['match', ['get', 'emph'], 2, 3.5, 1, 1.5, 0.75], 'line-opacity': ['match', ['get', 'emph'], 0, 0.4, 1] },
        });
      }
      const font = this.knownTextFont(m);
      if (font) {
        this.labelDiv?.remove();
        this.labelDiv = null;
        this.labelsFc = null;
        if (!m.getLayer(ZD_CLUSTER_LABEL)) {
          add({
            id: ZD_CLUSTER_LABEL,
            type: 'symbol',
            source: ZD_CLUSTER_SOURCE,
            filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'label']],
            layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12, 'text-allow-overlap': true },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 2, 'text-opacity': ['match', ['get', 'emph'], 0, 0.45, 1] },
          });
        }
      } else if (this.labelsFc !== this.fc || (this.labelDiv && !this.labelDiv.isConnected)) {
        this.renderHtmlLabels(m);
        this.labelsFc = this.fc;
      } else this.positionHtmlLabels();
    } catch (e) {
      console.warn('[zd] cluster ensure failed', e);
    }
    this.raise();
  }

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
      if (this.fc.features.length && !m.getLayer?.(ZD_CLUSTER_FILL) && this.styleReady(m)) this.ensure();
      else this.raise();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** Keep the style's tail as [cluster layers, area layers, highlight layers] (see area.ts raise). */
  private raise() {
    const m = this.map;
    if (!m) return;
    const ours = CLUSTER_LAYERS.filter((id) => m.getLayer?.(id));
    if (!ours.length) return;
    const want = [...ours, ...ABOVE.filter((id) => m.getLayer?.(id))];
    const order = this.layerOrder(m);
    if (order.slice(order.length - want.length).join('|') === want.join('|')) return;
    try {
      for (const id of want) m.moveLayer(id);
    } catch {
      /* */
    }
  }

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
      this.labelDiv.className = 'zd-cluster-labels';
      // Under the walkthrough's HTML labels (z-index 5).
      this.labelDiv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;';
      container.appendChild(this.labelDiv);
    }
    this.labelDiv.replaceChildren(
      ...pts.map((f) => {
        const el = document.createElement('div');
        el.className = 'zd-cluster-label';
        el.textContent = f.properties.label ?? '';
        const dim = f.properties.emph === 0 ? 'opacity:0.45;' : '';
        el.style.cssText = `position:absolute;transform:translate(-50%,-50%);font:600 11px/1 system-ui,sans-serif;color:#fff;background:${f.properties.color};border:1.5px solid #fff;border-radius:8px;padding:2px 5px;white-space:nowrap;${dim}`;
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

  status(): ClusterLayerStatus {
    const m = this.map ?? this.getMap();
    let featureCount = 0;
    let layers: string[] = [];
    if (m) {
      try {
        layers = this.layerOrder(m).filter((id) => CLUSTER_LAYERS.includes(id));
        // Mapbox GL v2 keeps the object in _data; MapLibre 5 wraps it ({ geojson }).
        const d = m.getSource(ZD_CLUSTER_SOURCE)?._data;
        const fc = d?.features ? d : d?.geojson;
        featureCount = fc?.features?.length ?? 0;
      } catch {
        /* */
      }
    }
    return { layers, featureCount, htmlLabels: this.labelDiv?.isConnected ? this.labelDiv.children.length : 0, dataWrites: this.dataWrites };
  }
}
