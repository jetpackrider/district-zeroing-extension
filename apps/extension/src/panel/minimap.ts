/**
 * Fallback mini-map (SPEC "Fallbacks": no map handle). MapLibre with a street basemap, the same
 * numbered blocks, and the precinct ID shown in the step text.
 */
import maplibregl from 'maplibre-gl/dist/maplibre-gl-csp.js';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AreaRing, BBox, ClusterFC, HighlightFC } from '../shared/protocol';
import type { AreaSink, ClusterSink, HighlightSink } from './highlights';

let workerSet = false;

export interface MiniMapOptions {
  /** Raster tile URL template for the street basemap; '' for none (tests, offline). */
  tiles: string;
  attribution?: string;
}

const COLOR = ['match', ['get', 'role'], 'remove', '#d7263d', 'add', '#1b65d6', 'erase', '#757575', 'done', '#2fa84f', 'precinct', '#ff9800', 'border', '#9c27b0', '#ffb300'];

/** The area outline's color and look, as on DRA's map (src/hook/area.ts). */
const AREA_COLOR = '#00838f';

const ringFC = (ring: AreaRing | null) => ({
  type: 'FeatureCollection' as const,
  features: ring && ring.length >= 3 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] } }] : [],
});

export function createMiniMap(container: HTMLElement, opts: MiniMapOptions): { sink: HighlightSink; area: AreaSink; clusters: ClusterSink; destroy: () => void } {
  if (!workerSet) {
    (maplibregl as unknown as { setWorkerUrl: (u: string) => void }).setWorkerUrl(chrome.runtime.getURL('/maplibre-gl-csp-worker.js'));
    workerSet = true;
  }
  const el = document.createElement('div');
  el.className = 'zd-minimap';
  el.style.cssText = 'position:relative;width:100%;height:100%;min-height:260px;';
  container.appendChild(el);
  const sources: Record<string, unknown> = {
    zd: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    'zd-area': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    'zd-cluster': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  };
  const layers: unknown[] = [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0f2' } }];
  if (opts.tiles) {
    sources.osm = { type: 'raster', tiles: [opts.tiles], tileSize: 256, attribution: opts.attribution ?? '© OpenStreetMap contributors' };
    layers.push({ id: 'osm', type: 'raster', source: 'osm' });
  }
  layers.push(
    // County clusters (hovered in the panel), under the area and the highlights, as on DRA's map (src/hook/clusters.ts).
    { id: 'zd-cluster-fill', type: 'fill', source: 'zd-cluster', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['match', ['get', 'emph'], 2, 0.4, 1, 0.25, 0.06] } },
    { id: 'zd-cluster-line', type: 'line', source: 'zd-cluster', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': ['get', 'color'], 'line-width': ['match', ['get', 'emph'], 2, 3, 1, 1.25, 0.75], 'line-opacity': ['match', ['get', 'emph'], 0, 0.4, 1] } },
    // The user's area, under the highlights: dashed outline, very light fill.
    { id: 'zd-area-fill', type: 'fill', source: 'zd-area', paint: { 'fill-color': AREA_COLOR, 'fill-opacity': 0.07 } },
    { id: 'zd-area-line', type: 'line', source: 'zd-area', paint: { 'line-color': AREA_COLOR, 'line-width': 2, 'line-dasharray': [3, 2] } },
    { id: 'zd-fill', type: 'fill', source: 'zd', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!=', ['get', 'role'], 'precinct']], paint: { 'fill-color': COLOR, 'fill-opacity': 0.45 } },
    { id: 'zd-line', type: 'line', source: 'zd', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': COLOR, 'line-width': ['match', ['get', 'role'], 'precinct', 2.5, 1.5] } },
  );
  const map = new maplibregl.Map({
    container: el,
    style: { version: 8, sources, layers } as maplibregl.StyleSpecification,
    center: [-75, 42.9],
    zoom: 6,
    attributionControl: opts.tiles ? {} : false,
  });
  let labels: maplibregl.Marker[] = [];
  let pending: { fc: HighlightFC; fit?: BBox } | null = null;
  let loaded = false;
  let areaRing: AreaRing | null = null;
  let clusterFc: ClusterFC | null = null;
  let clusterLabels: maplibregl.Marker[] = [];
  const showClusters = (fc: ClusterFC | null) => {
    clusterFc = fc;
    if (!loaded) return;
    (map.getSource('zd-cluster') as maplibregl.GeoJSONSource).setData((fc ?? { type: 'FeatureCollection', features: [] }) as unknown as GeoJSON.FeatureCollection);
    clusterLabels.forEach((m) => m.remove());
    clusterLabels = (fc?.features ?? [])
      .filter((f) => f.geometry.type === 'Point' && f.properties.label)
      .map((f) => {
        const div = document.createElement('div');
        div.className = 'zd-mini-cluster-label';
        div.textContent = f.properties.label ?? '';
        div.style.cssText = `font:600 10px/1 system-ui,sans-serif;color:#fff;background:${f.properties.color};border:1.5px solid #fff;border-radius:7px;padding:2px 4px;${f.properties.emph === 0 ? 'opacity:0.45;' : ''}`;
        return new maplibregl.Marker({ element: div }).setLngLat(f.geometry.coordinates as [number, number]).addTo(map);
      });
  };
  const showArea = (ring: AreaRing | null) => {
    areaRing = ring;
    if (loaded) (map.getSource('zd-area') as maplibregl.GeoJSONSource).setData(ringFC(ring) as unknown as GeoJSON.FeatureCollection);
  };
  const apply = (fc: HighlightFC, fit?: BBox) => {
    if (!loaded) {
      pending = { fc, fit };
      return;
    }
    (map.getSource('zd') as maplibregl.GeoJSONSource).setData(fc as unknown as GeoJSON.FeatureCollection);
    labels.forEach((m) => m.remove());
    labels = fc.features
      .filter((f) => f.geometry.type === 'Point' && f.properties.label)
      .map((f) => {
        const div = document.createElement('div');
        div.className = 'zd-mini-label';
        div.textContent = f.properties.label ?? '';
        const c = f.properties.role === 'done' ? '#2fa84f' : f.properties.role === 'remove' ? '#d7263d' : f.properties.role === 'erase' ? '#757575' : '#1b65d6';
        div.style.cssText = `font:bold 11px/1 system-ui,sans-serif;color:#fff;background:${c};border:1.5px solid #fff;border-radius:8px;padding:2px 4px;`;
        return new maplibregl.Marker({ element: div }).setLngLat(f.geometry.coordinates as [number, number]).addTo(map);
      });
    if (fit) map.fitBounds([[fit[0], fit[1]], [fit[2], fit[3]]], { padding: 30, maxZoom: 16, duration: 0 });
  };
  map.on('load', () => {
    loaded = true;
    if (areaRing) showArea(areaRing);
    if (clusterFc) showClusters(clusterFc);
    if (pending) apply(pending.fc, pending.fit);
    pending = null;
  });
  (el as unknown as { __zdMap: unknown }).__zdMap = map;
  return {
    sink: {
      show: (fc, fit) => apply(fc, fit),
      clear: () => apply({ type: 'FeatureCollection', features: [] }),
      fit: (b) => loaded && map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 30, maxZoom: 16, duration: 0 }),
    },
    clusters: { show: showClusters },
    area: {
      show: showArea,
      // "Use map view" with the mini-map: the part of it in view, as the ring of its corners.
      view: () => {
        const c = map.getCanvas();
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (!(w > 0 && h > 0)) return null;
        return ([[0, 0], [w, 0], [w, h], [0, h]] as Array<[number, number]>).map((p) => {
          const ll = map.unproject(p);
          return [ll.lng, ll.lat] as [number, number];
        });
      },
    },
    destroy: () => {
      labels.forEach((m) => m.remove());
      clusterLabels.forEach((m) => m.remove());
      map.remove();
      el.remove();
    },
  };
}
