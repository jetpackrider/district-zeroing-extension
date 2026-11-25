/**
 * CSV fallback (SPEC "Exports, the fallback path"): DRA's block assignment CSV.
 * Header GEOID20,District (skipped); ',' or '|' separators; custom district labels allowed;
 * unassigned blocks are left out; only committed edits are included. A row whose district is "0"
 * (a hand-made file marking unassigned blocks) is read as unassigned too, so it cannot shift the
 * numbering of the real districts.
 */

export interface ParsedCsv {
  rows: Array<{ geoid: string; label: string }>;
  /** District labels in first-seen order. */
  labels: string[];
  errors: string[];
}

export function parseBlockCsv(text: string): ParsedCsv {
  const rows: ParsedCsv['rows'] = [];
  const labels: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(/[,|]/).map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
    if (parts.length < 2) {
      errors.push(`line ${i + 1}: expected GEOID and district`);
      return;
    }
    const [geoid, label] = parts;
    if (!/^\d{15}$/.test(geoid)) {
      if (i === 0 || /geoid/i.test(geoid)) return; // header
      errors.push(`line ${i + 1}: bad GEOID ${geoid}`);
      return;
    }
    if (!label || /^0+$/.test(label)) return;
    rows.push({ geoid, label });
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  });
  return { rows, labels, errors };
}

/**
 * District label -> index. All-numeric labels map to themselves (DRA's default labels);
 * otherwise labels are numbered in natural sort order.
 */
export function labelIndexes(labels: string[]): Map<string, number> {
  const numeric = labels.every((l) => /^\d+$/.test(l) && Number(l) >= 1);
  const out = new Map<string, number>();
  if (numeric) {
    for (const l of labels) out.set(l, Number(l));
    return out;
  }
  const sorted = labels.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  sorted.forEach((l, i) => out.set(l, i + 1));
  return out;
}

const FIPS_TO_USPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY', '72': 'PR',
};

export function stateFromGeoid(geoid: string): string | null {
  return FIPS_TO_USPS[geoid.slice(0, 2)] ?? null;
}
