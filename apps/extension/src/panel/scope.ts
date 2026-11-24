/**
 * Out-of-scope map detection (SPEC Phase 8): multi-member, unequal-target, county or city,
 * multi-state and 2010-shape maps get a clear message and no suggestions.
 */
import type { HookDistrict, HookMapInfo } from '../shared/protocol';

export interface UnsupportedReason {
  kind: 'multi-member' | 'unequal-target' | 'county-or-city' | 'multi-state' | '2010-shape' | 'map-collection' | 'community' | 'no-districts';
  text: string;
}

export function detectUnsupported(info: HookMapInfo, districts: HookDistrict[]): UnsupportedReason | null {
  if (info.isMapCollection) return { kind: 'map-collection', text: 'This is a map collection, not a single plan. Open one plan to balance it.' };
  if (info.isMultiState) return { kind: 'multi-state', text: 'Multi-state maps are not supported. Open a single-state plan.' };
  if (info.datasource !== '2020_VD') {
    return { kind: '2010-shape', text: `This map uses ${info.datasource || 'non-2020'} shapes. Block painting (and so zeroing) only works on 2020-shape maps.` };
  }
  if (info.restriction && info.restriction.rt && info.restriction.rt !== 'state') {
    const where = info.restriction.name ? ` (${info.restriction.name})` : '';
    return { kind: 'county-or-city', text: `This is a ${info.restriction.rt} map${where}. Only whole-state maps are supported.` };
  }
  if (info.planType === 'coi') return { kind: 'community', text: 'Community-of-interest maps have no population target.' };
  if (info.allowMMD && districts.some((d) => d.index > 0 && d.membersPer > 1)) {
    return { kind: 'multi-member', text: 'Multi-member districts are not supported: targets differ per district.' };
  }
  if (!info.equalPop) return { kind: 'unequal-target', text: 'This map has custom (unequal) district targets. Only equal-population maps are supported.' };
  const targets = new Set(districts.filter((d) => d.index > 0).map((d) => d.target));
  if (targets.size > 1) return { kind: 'unequal-target', text: 'Districts have different population targets. Only equal-population maps are supported.' };
  if (info.nDistricts < 2) return { kind: 'no-districts', text: 'This map has fewer than two districts.' };
  return null;
}
