/**
 * Plain-text diagnostics for the first runs on the real site, where the hook may meet names or
 * shapes the static recon got wrong (RECON.md). Shown in the panel page's own "Diagnostics" footer
 * (with a Copy button) and logged to the panel page's console. Built from local state only and
 * never sent anywhere: the extension makes no requests except for the data bundle.
 */
import type { PanelState, PopField } from '@zd/contracts';
import type { HookMapInfo, PaintAvailability, SelfCheck } from '../shared/protocol';

export interface DiagnosticsInput {
  extensionVersion: string;
  /** 'store' | 'test' | 'local' (which build this is). */
  build: string;
  panelHookVersion: string;
  /** HOOK_VERSION reported by the MAIN-world hook (should equal panelHookVersion). */
  hookVersion: string | null;
  dataBaseUrl: string;
  link: string;
  /** Which of tab -> content script -> page hook answered (see TabLink.stage). */
  linkDetail: string[];
  /** Last exception reported by the page hook. */
  hookError: string | null;
  connection: PanelState['connection'];
  source: 'live' | 'csv';
  mapMode: 'dra' | 'mini';
  check: SelfCheck | null;
  info: HookMapInfo | null;
  districtCount: number;
  target: number | null;
  featureCount: number | null;
  pendingShatter: string[];
  blockMappingStamp: string | null;
  bundle: { state: string; draDataVersion: string; censusVintage: string; precinctKind: string; blocks: number; precincts: number; counties: number; attrsFile: string } | null;
  popField: PopField;
  popCheck: {
    field: PopField;
    /** How the bundle column was chosen for DRA's dataset key. */
    fieldNote?: string;
    draTotal: number;
    bundleTotal: number;
    rows: Array<{ index: number; label: string; dra: number; bundle: number }>;
    unresolved: string[];
    unresolvedCount: number;
    unknownGeoids: number;
    unmappedBlocks: number;
  } | null;
  csv: { fileName: string; rows: number; missing: number; labels: number } | null;
  notice: string | null;
  solve: PanelState['solve'];
  /** "Paint the step for me": the hook's check, the remembered setting, what the panel shows, the last outcome. */
  paint?: { availability: PaintAvailability | null; setting: boolean; shown: PanelState['autoPaint'] | null; last: string | null };
  perf: Record<string, number>;
}

const n = (x: number) => x.toLocaleString('en-US');

export function buildDiagnostics(d: DiagnosticsInput): string {
  const out: string[] = [];
  const line = (k: string, v: unknown) => out.push(`${k}: ${v}`);
  out.push('DRA Zero Deviation diagnostics (generated locally; nothing was sent anywhere)');
  line('extension', `${d.extensionVersion} (${d.build} build)`);
  line('hook protocol', d.hookVersion === null ? `panel ${d.panelHookVersion}, hook not heard from` : d.hookVersion === d.panelHookVersion ? d.hookVersion : `MISMATCH panel ${d.panelHookVersion} vs hook ${d.hookVersion}`);
  line('connection', `${d.connection} (source ${d.source}, link ${d.link}, highlights on ${d.mapMode === 'dra' ? "DRA's map" : 'the panel mini-map'})`);
  for (const l of d.linkDetail) out.push(`  ${l}`);
  if (d.hookError) line('page hook error', d.hookError);
  if (d.notice) line('notice', d.notice);

  out.push('', '[self-check]');
  if (!d.check) out.push('not received');
  else {
    line('result', d.check.ok ? 'all required hooks OK' : `FAILED at ${d.check.firstFailure}`);
    line('map handle', d.check.mapOk ? 'OK' : 'missing (mini-map fallback)');
    for (const i of d.check.items) out.push(`  ${i.ok ? 'ok  ' : 'FAIL'} ${i.id}${i.required ? '' : ' (optional)'}${i.detail ? ` - ${i.detail}` : ''}`);
    const s = d.check.seen;
    if (s) {
      line('mapboxgl.version', s.mapboxVersion ?? '(not found)');
      line('DRA bundle script', s.draBundle ?? '(not found)');
      line('map handle from', s.mapFrom ?? '?');
      line('dataContext', `datasource ${s.datasource ?? '?'}, version ${s.dataVersion ?? '?'}, planType ${s.planType ?? '?'}`);
      line('dataset field (primeDDS)', s.primeDDS ? `${s.primeDDS} via ${s.primeDDSFrom}` : '(not found)');
      if (s.draKeys) line('window.dra keys', s.draKeys.join(', ') || '(none)');
      if (s.modelKeys) line('model members', `${s.modelKeys.length}: ${s.modelKeys.join(', ')}`);
    }
  }

  out.push('', '[plan]');
  if (d.info) {
    const i = d.info;
    line('state', `${i.state}, ${i.nDistricts} districts, datasource ${i.datasource}, planType ${i.planType}`);
    line('population field read', i.popField);
    line('DRA total', n(i.totalPop));
    line('target read', d.target === null ? '?' : n(d.target));
    line('flags', `equalPop ${i.equalPop}, allowMMD ${i.allowMMD}, restriction ${i.restriction ? `${i.restriction.rt}${i.restriction.name ? ` (${i.restriction.name})` : ''}` : 'none'}, multiState ${i.isMultiState}, collection ${i.isMapCollection}`);
    line('features in fullBlockMap', d.featureCount === null ? '?' : n(d.featureCount));
    line('blockMapping stamp', d.blockMappingStamp ?? '?');
    line('uncommitted shattered precincts', d.pendingShatter.length ? d.pendingShatter.join(', ') : 'none');
  } else if (d.csv) {
    line('CSV', `${d.csv.fileName}: ${n(d.csv.rows)} rows, ${d.csv.labels} district labels, ${n(d.csv.missing)} GEOIDs not in the bundle`);
  } else out.push('no plan read');

  out.push('', '[data bundle]');
  line('base URL', d.dataBaseUrl);
  if (d.bundle) {
    const b = d.bundle;
    line('bundle', `${b.state}, DRA data version ${b.draDataVersion}, census ${b.censusVintage}, ${b.precinctKind}`);
    line('size', `${n(b.blocks)} blocks, ${n(b.precincts)} precincts, ${b.counties} counties (${b.attrsFile})`);
    line('population column used', d.popField);
  } else out.push('not loaded');

  out.push('', '[bundle vs DRA populations]');
  const p = d.popCheck;
  if (!p) out.push(d.source === 'csv' ? 'not applicable in CSV mode' : 'not checked yet (waiting for the plan, the block mapping, or a commit)');
  else {
    const bad = p.rows.filter((r) => r.dra !== r.bundle);
    line('field', p.field);
    if (p.fieldNote) line('chosen because', p.fieldNote);
    line('totals', `DRA ${n(p.draTotal)}, bundle ${n(p.bundleTotal)}${p.draTotal === p.bundleTotal ? '' : ` (diff ${n(p.bundleTotal - p.draTotal)})`}`);
    line('districts', bad.length ? `${bad.length} of ${p.rows.length} differ` : `all ${p.rows.length} match (incl. Unassigned)`);
    for (const r of bad.slice(0, 40)) out.push(`  ${r.index === 0 ? 'Unassigned' : `District ${r.label} (#${r.index})`}: DRA ${n(r.dra)}, bundle ${n(r.bundle)}, diff ${n(r.bundle - r.dra)}`);
    line('unresolved map features', p.unresolvedCount ? `${p.unresolvedCount} (e.g. ${p.unresolved.slice(0, 5).join(', ')})` : 'none');
    line('live blockMapping', `${n(p.unknownGeoids)} GEOIDs not in the bundle, ${n(p.unmappedBlocks)} bundle blocks not in DRA's mapping`);
  }

  out.push('', '[painting a step for you]');
  if (!d.paint) out.push('not reported');
  else {
    const a = d.paint.availability;
    line('setting', d.paint.setting ? 'on' : 'off');
    line('shown', d.paint.shown ? `${d.paint.shown.available ? 'available' : 'unavailable'}${d.paint.shown.enabled ? ', enabled' : ''}${d.paint.shown.busy ? ', busy' : ''}${d.paint.shown.reason ? ` - ${d.paint.shown.reason}` : ''}` : 'n/a');
    if (!a) out.push('hook check: not received');
    else {
      line('hook check', a.ok ? 'OK' : `unavailable - ${a.reason ?? '?'}`);
      for (const c of a.checks) out.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
    }
    line('last paint', d.paint.last ?? 'none this session');
  }

  out.push('', '[solver]');
  line('status', `${d.solve.status}${d.solve.message ? ` - ${d.solve.message}` : ''}${d.solve.elapsedMs !== undefined ? ` (${d.solve.elapsedMs} ms)` : ''}`);
  const f = (k: string) => (d.perf[k] ?? 0).toFixed(0);
  line(
    'timings ms',
    `bundle ${f('bundleMs')}, mapping ${f('mappingMs')}, graph ${f('graphMs')}, worker init ${f('engineInitMs')}, snapshot last/max ${f('lastSnapshotMs')}/${f('maxSnapshotMs')} over ${d.perf.snapshots ?? 0}, last solve ${f('lastSolveMs')} (engine ${f('lastSolveWorkerMs')}), last hover ${f('lastHoverMs')}`,
  );
  return out.join('\n');
}
