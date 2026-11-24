/**
 * Builds highlight GeoJSON (blocks, numbered labels, precinct outlines, borders) from the bundle's
 * per-county geometry, and sends it to DRA's map (via the hook) or to the mini-map.
 */
import type { BundleSource, CountyGeometry, StateBundle } from '@zd/contracts';
import type { BBox, HighlightFC, HighlightFeatureProps } from '../shared/protocol';
import { bboxOf, labelPoint } from './walkthrough';

export interface HighlightItem {
  block: number;
  role: HighlightFeatureProps['role'];
  label?: string;
}

export interface HighlightSink {
  show(fc: HighlightFC, fit?: BBox): void;
  clear(): void;
  fit(bbox: BBox): void;
}

export class GeometryCache {
  private counties = new Map<string, Promise<Map<string, CountyGeometry['features'][number]>>>();
  constructor(private readonly source: BundleSource, private readonly bundle: StateBundle) {}

  private county(fips: string) {
    let p = this.counties.get(fips);
    if (!p) {
      p = this.source.loadCounty(this.bundle, fips).then((g) => new Map(g.features.map((f) => [String(f.id), f])));
      this.counties.set(fips, p);
      p.catch(() => this.counties.delete(fips));
    }
    return p;
  }

  async build(items: HighlightItem[], extra: HighlightFC['features'] = []): Promise<{ fc: HighlightFC; bbox: BBox | null }> {
    const fipsNeeded = new Set(items.map((i) => this.bundle.countyFips[this.bundle.countyOf[i.block]]));
    const maps = new Map<string, Map<string, CountyGeometry['features'][number]>>();
    await Promise.all([...fipsNeeded].map(async (f) => maps.set(f, await this.county(f))));
    const features: HighlightFC['features'] = [];
    const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const it of items) {
      const geoid = this.bundle.geoids[it.block];
      const f = maps.get(geoid.slice(0, 5))?.get(geoid);
      if (!f) continue;
      const geometry = f.geometry as { type: string; coordinates: unknown };
      bboxOf(geometry.coordinates, box);
      features.push({ type: 'Feature', id: geoid, properties: { role: it.role, geoid }, geometry });
      if (it.label) features.push({ type: 'Feature', properties: { role: it.role, label: it.label, geoid }, geometry: { type: 'Point', coordinates: labelPoint(geometry) } });
    }
    for (const f of extra) {
      bboxOf(f.geometry.coordinates, box);
      features.push(f);
    }
    return { fc: { type: 'FeatureCollection', features }, bbox: Number.isFinite(box[0]) ? box : null };
  }
}
