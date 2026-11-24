/**
 * EVERY DRA touchpoint lives in this file (SPEC "Risks": keep the hook code in one file).
 *
 * Runs in the page's MAIN world. Names below were confirmed statically against
 * draclient.bundle.js (Last-Modified 20 Nov 2026); see RECON.md for which still need a live check.
 *
 *   window.dra = { app, env: app.props.env, model: () => app.props.curModel, ... }   (set on DOMContentLoaded)
 *   model.fullBlockMap()            committed redistrict.blockMap() overlaid with sm.blockmap (uncommitted)
 *   model.districtOf(featureId)
 *   model.blockMapping              GETTER (not a method): a MultiBlockMapping with map(block), rev(precinct), forEachRev(cb), stamp
 *   model.datasetContext.primeDDS   e.g. "D20F"
 *   model.dataContext               { state, datasource, planType, nDistricts, equalPop, allowMMD, ... }
 *   model.totalStatePop()
 *   model.redistrict.safeDistrictProps()   [{ index, label, color, target, membersPer, ... }] + targetPop(model, i)
 *   model.derivedProps.aggregates   per-district aggregates; model.datasetGetter(agg, primeDDS)('Tot') = DRA's displayed pop
 *   model.sm                        shatter manager: shatterMap { [precinct]: { state } }, localBlockStamp, blockmap
 *   model.redistrict.blockStamp()   the stamps.blockmap counter
 *   env.clientSession.on('state', cb)
 *   env.theMap                      mapboxgl.Map (v2.11.0); fallback: trap window.mapboxgl.Map at document_start
 *
 * Painting (opt-in, one walkthrough step per user click; see "Painting a step" below and RECON.md):
 *   model.actionSetFeatureDistricts({ blockMap: { [featureId]: d }, filterLocked, coalesce, pushUndo })
 *                                   what DRA's map calls when the user paints a whole precinct
 *   model.undoredo.startComposite() / endComposite(), model.actionSetBlockDistricts({ blockMap: { [block]: d }, ... , counter }),
 *   model.actionSetRedistrictProps({ fixContiguity: true, counter })
 *                                   what DRA's own "paint city" does to assign individual blocks
 *   model.readonly, model.frozen, model.css.bInSession, model.districtLocked(i), model.sm, model.undoredo.cur
 */

import type { HookBlockMapping, HookCheckItem, HookDistrict, HookId, HookMapInfo, HookSeen, PaintAvailability, PaintResult, PaintStepRequest, SelfCheck } from '../shared/protocol';
import { decodeBitset, isBlockId } from '../panel/assignment';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const w = window as Any;

// ---------------------------------------------------------------------------
// Map constructor trap (fallback map handle). Must run at document_start, before
// mapbox-gl.js (a plain <script> that assigns window.mapboxgl) and DRA's bundle.
// ---------------------------------------------------------------------------

const trappedMaps: Any[] = [];
let trapInstalled = false;

function patchLib(lib: Any): void {
  if (!lib || typeof lib.Map !== 'function' || lib.Map.__zdPatched) return;
  const Orig = lib.Map;
  try {
    const Patched = class extends Orig {
      constructor(...args: Any[]) {
        super(...args);
        trappedMaps.push(this);
      }
    } as Any;
    Patched.__zdPatched = true;
    lib.Map = Patched;
  } catch {
    /* frozen namespace: leave it; env.theMap is the primary handle anyway */
  }
}

export function installMapConstructorTrap(globalName = 'mapboxgl'): void {
  if (trapInstalled) return;
  trapInstalled = true;
  const existing = w[globalName];
  if (existing) {
    patchLib(existing);
    return;
  }
  let value: Any;
  try {
    Object.defineProperty(w, globalName, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v) => {
        value = v;
        patchLib(v);
      },
    });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Accessors. Each throws a HookError naming the hook that failed.
// ---------------------------------------------------------------------------

export class HookError extends Error {
  constructor(public hook: HookId, detail: string) {
    super(`${hook}: ${detail}`);
  }
}

function fail(hook: HookId, detail: string): never {
  throw new HookError(hook, detail);
}

export function getDra(): Any {
  const dra = w.dra;
  if (!dra || typeof dra !== 'object') fail('window.dra', 'window.dra is not set');
  return dra;
}

/** True once DRA's app object exists (window.dra is assigned on DOMContentLoaded). */
export function draPresent(): boolean {
  return !!w.dra && typeof w.dra === 'object';
}

export function getModel(): Any {
  const dra = getDra();
  if (typeof dra.model !== 'function') fail('dra.model()', 'dra.model is not a function');
  const m = dra.model();
  if (!m) fail('dra.model()', 'no plan open (dra.model() returned nothing)');
  return m;
}

/** A plan is open and has its data context (state + datasource) loaded. */
export function planOpen(): boolean {
  try {
    const m = getModel();
    const dc = m.dataContext;
    return !!(dc && dc.state && dc.datasource);
  } catch {
    return false;
  }
}

export function readFeatureMap(m: Any = getModel()): Record<string, number> {
  if (typeof m.fullBlockMap !== 'function') fail('model.fullBlockMap()', 'not a function');
  const fbm = m.fullBlockMap();
  if (!fbm || typeof fbm !== 'object') fail('model.fullBlockMap()', 'returned no object');
  // Copy into a plain object so it structured-clones cheaply and DRA's object is never touched.
  const out: Record<string, number> = {};
  for (const k in fbm) if (Object.prototype.hasOwnProperty.call(fbm, k)) out[k] = Number(fbm[k]) || 0;
  return out;
}

/**
 * Diff DRA's fullBlockMap() against `last` (the hook's own copy of what it sent), updating `last` in
 * place. Doesn't copy DRA's object; cost is one pass over its keys.
 */
export function diffFeatureMap(last: Record<string, number>, lastCount: number, m: Any = getModel()): { set: Record<string, number>; del: string[]; count: number } {
  if (typeof m.fullBlockMap !== 'function') fail('model.fullBlockMap()', 'not a function');
  const fbm = m.fullBlockMap();
  if (!fbm || typeof fbm !== 'object') fail('model.fullBlockMap()', 'returned no object');
  const set: Record<string, number> = {};
  const del: string[] = [];
  let seen = 0;
  let added = 0;
  for (const k in fbm) {
    if (!Object.prototype.hasOwnProperty.call(fbm, k)) continue;
    seen++;
    const v = Number(fbm[k]) || 0;
    const old = last[k];
    if (old !== v) {
      if (old === undefined) added++;
      set[k] = v;
      last[k] = v;
    }
  }
  // Keys that disappeared (a committed precinct replaced by B_ splits, an uncommitted block edit committed).
  let count = lastCount + added;
  if (count !== seen) {
    for (const k in last) {
      if (!Object.prototype.hasOwnProperty.call(fbm, k)) {
        del.push(k);
        delete last[k];
      }
    }
    count = seen;
  }
  return { set, del, count };
}

export function districtOf(featureId: string, m: Any = getModel()): number {
  if (typeof m.districtOf !== 'function') fail('model.districtOf()', 'not a function');
  return Number(m.districtOf(featureId)) || 0;
}

function blockMappingObj(m: Any): Any {
  const bm = m.blockMapping; // getter
  if (!bm) fail('model.blockMapping', 'model.blockMapping is empty (precinct data not loaded yet?)');
  if (typeof bm.map !== 'function' || typeof bm.rev !== 'function') fail('model.blockMapping', 'missing .map()/.rev()');
  return bm;
}

export function readBlockMappingStamp(m: Any = getModel()): string {
  try {
    const bm = m.blockMapping;
    return bm ? String(bm.stamp ?? 'nostamp') : 'none';
  } catch {
    return 'error';
  }
}

/** Reverse block mapping, precinct -> block GEOIDs in DRA's rev() order (sorted). */
export function readBlockMapping(m: Any = getModel()): HookBlockMapping {
  const bm = blockMappingObj(m);
  const rev: Record<string, string[]> = {};
  if (typeof bm.forEachRev === 'function') {
    bm.forEachRev((precinct: string, blocks: string[]) => {
      rev[precinct] = blocks.slice();
    });
  } else if (typeof bm.forEachBlock === 'function') {
    const seen = new Set<string>();
    bm.forEachBlock((block: string) => {
      const p = bm.map(block);
      if (p && !seen.has(p)) {
        seen.add(p);
        rev[p] = (bm.rev(p) ?? []).slice();
      }
    });
  } else {
    fail('model.blockMapping', 'no forEachRev()/forEachBlock() to enumerate precincts');
  }
  return { stamp: String(bm.stamp ?? 'nostamp'), rev };
}

export function readPopField(m: Any = getModel()): string {
  const dc = m.datasetContext;
  const key = dc?.primeDDS || (typeof m.primaryDatasetKeysActual === 'function' ? m.primaryDatasetKeysActual()?.CENSUS : '');
  if (!key) fail('model.datasetContext.primeDDS', 'primeDDS is empty');
  return String(key);
}

export function readInfo(m: Any = getModel()): HookMapInfo {
  const dc = m.dataContext;
  if (!dc || !dc.state) fail('model.dataContext', 'dataContext.state is empty');
  if (typeof m.totalStatePop !== 'function') fail('model.totalStatePop()', 'not a function');
  let restriction: HookMapInfo['restriction'] = null;
  try {
    if (typeof m.restrictionTyped === 'function') {
      const r = m.restrictionTyped();
      if (r) restriction = { rt: String(r.rt ?? 'state'), id: r.id ?? null, name: String(r.name ?? '') };
    }
  } catch {
    /* optional */
  }
  let planName: string | undefined;
  try {
    planName = m.derivedProps?.displayName || undefined;
  } catch {
    /* optional */
  }
  let isMapCollection = false;
  try {
    isMapCollection = !!m.isMapCollection;
  } catch {
    /* optional */
  }
  const state = String(dc.state);
  return {
    state,
    datasource: String(dc.datasource ?? ''),
    planType: String(dc.planType ?? 'other'),
    nDistricts: Number(dc.nDistricts) || 0,
    equalPop: dc.equalPop !== false,
    allowMMD: !!dc.allowMMD,
    restriction,
    isMapCollection,
    isMultiState: state.startsWith('+'), // DRA's MULTI_PREFIX
    popField: readPopField(m),
    totalPop: Number(m.totalStatePop()) || 0,
    planName,
  };
}

/** District rows exactly as DRA's district table computes them. Index 0 is Unassigned. */
export function readDistricts(m: Any = getModel()): HookDistrict[] {
  const red = m.redistrict;
  if (!red || typeof red.safeDistrictProps !== 'function') fail('model.redistrict.safeDistrictProps()', 'not a function');
  const dp = red.safeDistrictProps();
  if (!dp || typeof dp.targetPop !== 'function') fail('model.redistrict.safeDistrictProps()', 'no targetPop()');
  const derived = m.derivedProps;
  const aggs = derived?.aggregates;
  if (!aggs || !aggs.length) fail('model.derivedProps.aggregates', 'aggregates not computed');
  if (typeof m.datasetGetter !== 'function') fail('model.datasetGetter()', 'not a function');
  const key = readPopField(m);
  const n = Number(m.dataContext?.nDistricts) || dp.length - 1;
  const colors = derived?.colors;
  const out: HookDistrict[] = [];
  for (let i = 0; i <= n; i++) {
    const agg = aggs[i];
    const pop = agg ? Number(m.datasetGetter(agg, key)('Tot')) || 0 : 0;
    const p = dp[i] ?? {};
    out.push({
      index: i,
      label: i === 0 ? 'Unassigned' : String(p.label || i),
      pop,
      target: i === 0 ? 0 : Number(dp.targetPop(m, i)) || 0,
      color: colors?.[i]?.colorSolid || p.color || undefined,
      membersPer: Number(p.membersPer) || 1,
    });
  }
  return out;
}

/** Precincts shattered for block painting whose edits are not yet committed with DRA's checkmark. */
export function readPendingShatter(m: Any = getModel()): string[] {
  const sm = m.sm;
  if (!sm || !sm.shatterMap) return [];
  const out: string[] = [];
  for (const k of Object.keys(sm.shatterMap)) {
    const st = sm.shatterMap[k]?.state;
    if (st === 'shattering' || st === 'shattered') out.push(k);
  }
  return out;
}

/** Cheap change signature: stamps.blockmap counter + local (uncommitted) block stamp + mapping stamp. */
export function readSignature(m: Any = getModel()): string {
  let blockStamp = '?';
  let local = '?';
  try {
    blockStamp = String(m.redistrict?.blockStamp?.() ?? '?');
  } catch {
    /* */
  }
  try {
    local = String(m.sm?.localBlockStamp ?? '?');
  } catch {
    /* */
  }
  return `${m.sessionID ?? ''}|${blockStamp}|${local}|${readBlockMappingStamp(m)}`;
}

/** Subscribe to DRA's session 'state' event. Returns false when the hook is unavailable (caller polls). */
export function onStateEvent(cb: () => void): boolean {
  try {
    const cs = getDra().env?.clientSession;
    if (!cs || typeof cs.on !== 'function') return false;
    cs.on('state', cb);
    return true;
  } catch {
    return false;
  }
}

function looksLikeMap(m: Any): boolean {
  return !!m && typeof m.addLayer === 'function' && typeof m.getStyle === 'function' && typeof m.on === 'function';
}

/** DRA's map: env.theMap, else the instance trapped from the mapboxgl.Map constructor. */
export function getMap(): Any | null {
  try {
    const m = w.dra?.env?.theMap;
    if (looksLikeMap(m)) return m;
  } catch {
    /* */
  }
  for (let i = trappedMaps.length - 1; i >= 0; i--) {
    const m = trappedMaps[i];
    try {
      if (looksLikeMap(m) && m.getContainer()?.isConnected) return m;
    } catch {
      /* */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Startup self-check: probes each hook and reports exactly which one failed.
// ---------------------------------------------------------------------------

/**
 * `light` (the periodic re-check once everything has passed): skip walking fullBlockMap() (every
 * snapshot read exercises it, and a failing read triggers a full check) and reuse `prevSeen`
 * instead of re-collecting the diagnostic names.
 */
export function selfCheck(opts: { light?: boolean; prevSeen?: HookSeen } = {}): SelfCheck {
  const items: HookCheckItem[] = [];
  const probe = (id: HookId, required: boolean, fn: () => unknown) => {
    try {
      const r = fn();
      items.push({ id, ok: true, required, detail: typeof r === 'string' ? r : undefined });
      return true;
    } catch (e) {
      items.push({ id, ok: false, required, detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  // Tests can force a hook to fail (fixture only; harmless on DRA where the key is never set).
  const forced: string[] = (() => {
    if (!__ZD_TEST__) return [];
    try {
      return JSON.parse(document.documentElement.dataset.zdForceHookFail ?? '[]');
    } catch {
      return [];
    }
  })();
  const p = (id: HookId, required: boolean, fn: () => unknown) =>
    probe(id, required, () => {
      if (forced.includes(id)) throw new Error('forced failure (test)');
      return fn();
    });

  let m: Any = null;
  if (p('window.dra', true, () => getDra()) && p('dra.model()', true, () => (m = getModel()))) {
    p('model.fullBlockMap()', true, () => {
      // Probe without copying (the snapshot copies; this runs on its own schedule).
      if (typeof m.fullBlockMap !== 'function') throw new Error('not a function');
      if (opts.light) return 'function';
      const fbm = m.fullBlockMap();
      if (!fbm || typeof fbm !== 'object') throw new Error('returned no object');
      let c = 0;
      for (const k in fbm) if (Object.prototype.hasOwnProperty.call(fbm, k)) c++;
      return `${c} features`;
    });
    p('model.districtOf()', false, () => {
      if (typeof m.districtOf !== 'function') throw new Error('not a function');
    });
    p('model.blockMapping', true, () => {
      const bm = blockMappingObj(m);
      if (typeof bm.forEachRev !== 'function' && typeof bm.forEachBlock !== 'function') throw new Error('cannot enumerate');
      return `stamp ${bm.stamp}`;
    });
    p('model.datasetContext.primeDDS', true, () => readPopField(m));
    p('model.dataContext', true, () => {
      const dc = m.dataContext;
      if (!dc?.state || !dc.datasource || !(Number(dc.nDistricts) >= 0)) throw new Error('missing state/datasource/nDistricts');
      return `${dc.state} ${dc.datasource} ${dc.nDistricts}`;
    });
    p('model.totalStatePop()', true, () => String(m.totalStatePop()));
    p('model.redistrict.safeDistrictProps()', true, () => {
      const dp = m.redistrict?.safeDistrictProps?.();
      if (!dp || typeof dp.targetPop !== 'function') throw new Error('no targetPop()');
    });
    p('model.derivedProps.aggregates', true, () => {
      const a = m.derivedProps?.aggregates;
      if (!a || !a.length) throw new Error('aggregates not computed');
    });
    p('model.datasetGetter()', true, () => {
      if (typeof m.datasetGetter !== 'function') throw new Error('not a function');
    });
    p('model.sm (shatter manager)', false, () => {
      if (!m.sm || typeof m.sm.shatterMap !== 'object') throw new Error('no sm.shatterMap');
    });
    p('model.redistrict.blockStamp()', false, () => String(m.redistrict.blockStamp()));
  }
  p('env.clientSession.on', false, () => {
    if (typeof getDra().env?.clientSession?.on !== 'function') throw new Error('not a function');
  });
  const mapOk = p('env.theMap', false, () => {
    const map = w.dra?.env?.theMap;
    if (looksLikeMap(map)) return 'env.theMap';
    if (getMap()) return 'trapped mapboxgl.Map instance';
    throw new Error('no map handle');
  });
  const firstFailure = items.find((i) => i.required && !i.ok)?.id;
  return { ok: !firstFailure, mapOk, items, firstFailure, seen: opts.light && opts.prevSeen ? opts.prevSeen : readSeen() };
}

/** Names and versions on DRA's page, for the panel's diagnostics. Never throws. */
export function readSeen(): HookSeen {
  const seen: HookSeen = {};
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* diagnostics only */
    }
  };
  safe(() => {
    const v = w.mapboxgl?.version;
    if (v) seen.mapboxVersion = String(v);
  });
  safe(() => {
    const el = [...document.scripts].find((s) => /draclient/i.test(s.src));
    if (el) seen.draBundle = new URL(el.src).pathname;
  });
  safe(() => {
    seen.draKeys = draPresent() ? Object.keys(w.dra).sort().slice(0, 80) : [];
  });
  safe(() => {
    const m = w.dra?.model?.();
    if (!m) return;
    const names = new Set<string>(Object.keys(m));
    let proto = Object.getPrototypeOf(m);
    for (let depth = 0; proto && proto !== Object.prototype && depth < 3; depth++, proto = Object.getPrototypeOf(proto)) {
      for (const k of Object.getOwnPropertyNames(proto)) if (k !== 'constructor') names.add(k);
    }
    seen.modelKeys = [...names].sort().slice(0, 300);
    safe(() => {
      const dc = m.dataContext;
      if (dc) {
        if (dc.version !== undefined) seen.dataVersion = String(dc.version);
        if (dc.datasource !== undefined) seen.datasource = String(dc.datasource);
        if (dc.planType !== undefined) seen.planType = String(dc.planType);
      }
    });
    safe(() => {
      const k = m.datasetContext?.primeDDS;
      if (k) {
        seen.primeDDS = String(k);
        seen.primeDDSFrom = 'datasetContext.primeDDS';
      } else if (typeof m.primaryDatasetKeysActual === 'function') {
        const c = m.primaryDatasetKeysActual()?.CENSUS;
        if (c) {
          seen.primeDDS = String(c);
          seen.primeDDSFrom = 'primaryDatasetKeysActual().CENSUS';
        }
      }
    });
  });
  safe(() => {
    seen.mapFrom = looksLikeMap(w.dra?.env?.theMap) ? 'env.theMap' : getMap() ? 'trapped mapboxgl.Map' : 'none';
  });
  return seen;
}

/** The fixture can force the map handle away (Phase 7 mini-map test). */
export function mapForcedMissing(): boolean {
  if (!__ZD_TEST__) return false;
  try {
    return JSON.parse(document.documentElement.dataset.zdForceHookFail ?? '[]').includes('env.theMap');
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Painting a step (opt-in). RECON.md "Painting: what DRA does" has the code this mirrors.
//
// Nothing here writes into DRA's data or talks to DRA's server: it calls the same model actions
// DRA's own UI calls, so DRA records the edit for its Undo, syncs it with its own code, and
// re-renders its own map. Everything is checked before and re-read after.
// ---------------------------------------------------------------------------

interface FnSpec {
  name: string;
  get: (m: Any) => unknown;
  /** Function.length as DRA's bundle declares it (minified `name(e){` = 1). */
  arity: number;
  /** Property names the function's source must mention (they survive minification). */
  mustContain: string[];
}

const PAINT_FNS: FnSpec[] = [
  { name: 'model.actionSetFeatureDistricts', get: (m) => m.actionSetFeatureDistricts, arity: 1, mustContain: ['blockMap', 'filterLocked', 'coalesce', 'pushUndo', 'recordUndoSetFeatureDistricts', 'filterOutFeatures'] },
  { name: 'model.actionSetBlockDistricts', get: (m) => m.actionSetBlockDistricts, arity: 1, mustContain: ['blockMap', 'blockMapping', 'filterLocked', 'districtLocked', 'actionSetFeatureDistricts'] },
  { name: 'model.actionSetRedistrictProps', get: (m) => m.actionSetRedistrictProps, arity: 1, mustContain: ['fixContiguity', 'counter', 'noundo'] },
  { name: 'model.recordUndoSetFeatureDistricts', get: (m) => m.recordUndoSetFeatureDistricts, arity: 2, mustContain: ['undoredo', 'districtOf'] },
  { name: 'model.districtLocked', get: (m) => m.districtLocked, arity: 1, mustContain: [] },
  { name: 'model.actionUndo', get: (m) => m.actionUndo, arity: 0, mustContain: ['undoredo'] },
  { name: 'model.undoredo.startComposite', get: (m) => m.undoredo?.startComposite, arity: 0, mustContain: ['composite', 'counter'] },
  { name: 'model.undoredo.endComposite', get: (m) => m.undoredo?.endComposite, arity: 0, mustContain: ['composite'] },
  { name: 'model.undoredo.push', get: (m) => m.undoredo?.push, arity: 2, mustContain: [] },
  { name: 'model.undoredo.undo', get: (m) => m.undoredo?.undo, arity: 0, mustContain: [] },
];

const apiCache = new WeakMap<object, { apiOk: boolean; checks: PaintAvailability['checks']; reason?: string }>();

/** Checks DRA's paint functions without calling any of them. Cached per model object. */
function checkPaintApi(m: Any): { apiOk: boolean; checks: PaintAvailability['checks']; reason?: string } {
  const cached = apiCache.get(m);
  if (cached) return cached;
  const checks: PaintAvailability['checks'] = [];
  for (const f of PAINT_FNS) {
    let fn: unknown;
    try {
      fn = f.get(m);
    } catch (e) {
      checks.push({ name: f.name, ok: false, detail: `reading it threw: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (typeof fn !== 'function') {
      checks.push({ name: f.name, ok: false, detail: fn === undefined ? 'missing' : `not a function (${typeof fn})` });
      continue;
    }
    if (fn.length !== f.arity) {
      checks.push({ name: f.name, ok: false, detail: `takes ${fn.length} argument(s), expected ${f.arity}` });
      continue;
    }
    let src = '';
    try {
      src = Function.prototype.toString.call(fn);
    } catch {
      /* native or proxied: treated as missing words below */
    }
    const missing = f.mustContain.filter((w) => !src.includes(w));
    checks.push(missing.length ? { name: f.name, ok: false, detail: `its code no longer mentions ${missing.join(', ')}` } : { name: f.name, ok: true });
  }
  const props: Array<[string, () => boolean]> = [
    ['model.readonly', () => typeof m.readonly === 'boolean'],
    ['model.undoredo.cur', () => typeof m.undoredo?.cur === 'number'],
    ['model.sm.shatterMap / sm.blockmap', () => !!m.sm && typeof m.sm.shatterMap === 'object' && typeof m.sm.blockmap === 'object'],
  ];
  for (const [name, ok] of props) {
    let good = false;
    try {
      good = ok();
    } catch {
      /* */
    }
    checks.push(good ? { name, ok: true } : { name, ok: false, detail: 'missing or not the expected type' });
  }
  const bad = checks.find((c) => !c.ok);
  const r = { apiOk: !bad, checks, reason: bad ? `DRA's paint functions are not what this extension expects (${bad.name}: ${bad.detail}).` : undefined };
  // Only cache a pass: a model still loading may grow css/undoredo later.
  if (r.apiOk) apiCache.set(m, r);
  return r;
}

/** Whether painting can be offered on the open map right now. Never throws, never calls DRA's actions. */
export function paintAvailability(m: Any = getModel()): PaintAvailability {
  const api = checkPaintApi(m);
  if (!api.apiOk) return { ok: false, apiOk: false, reason: api.reason, checks: api.checks };
  const no = (reason: string): PaintAvailability => ({ ok: false, apiOk: true, reason, checks: api.checks });
  try {
    if (m.readonly) return no('This map is read-only for you in DRA (a view-only link, a locked map, or DRA maintenance).');
    if (m.frozen) return no('This is a frozen revision of a map in DRA, which cannot be edited.');
    // css.bInSession is `clientEngine != null`; DRA's own actions only send an edit to its server when it is true.
    if (m.css?.bInSession !== true) return no("DRA is not connected to its server for this map, so an edit would not be saved.");
    if (m.isMapCollection) return no('This is a map collection, which DRA does not let you paint.');
  } catch (e) {
    return no(`Could not read whether the map is editable (${e instanceof Error ? e.message : String(e)}).`);
  }
  return { ok: true, apiOk: true, checks: api.checks };
}

/** Short availability string for the change signature (so a map turning read-only re-sends a snapshot). */
export function paintSignature(m: Any): string {
  try {
    const a = paintAvailability(m);
    return a.ok ? 'p1' : `p0:${a.reason ?? ''}`;
  } catch {
    return 'p?';
  }
}

const SPLIT_KEY = /^B_([^_]*)_(.*)$/;
const LEGACY_KEY = /^vfeature_([^_]*)_/;

/** Precinct a fullBlockMap() key belongs to (null when it cannot be told). */
function precinctOfKey(k: string, bm: Any): string | null {
  const s = SPLIT_KEY.exec(k);
  if (s) return s[1];
  const l = LEGACY_KEY.exec(k);
  if (l) return l[1];
  if (isBlockId(k)) {
    const p = bm.map(k);
    return p ? String(p) : null;
  }
  return k;
}

/** Keys of `fbm` that belong to precinct `p`: the precinct itself, its B_ / vfeature_ splits, bare blocks. */
function keysOfPrecinct(fbm: Record<string, number>, p: string, bm: Any): string[] {
  const out: string[] = [];
  const bPrefix = `B_${p}_`;
  const vPrefix = `vfeature_${p}_`;
  for (const k in fbm) {
    if (!Object.prototype.hasOwnProperty.call(fbm, k)) continue;
    if (k === p || k.startsWith(bPrefix) || k.startsWith(vPrefix)) out.push(k);
    else if (isBlockId(k) && bm.map(k) === p) out.push(k);
  }
  return out;
}

/** Block -> district inside one precinct, decoded the way src/panel/assignment.ts does for the whole map. */
function decodePrecinct(fbm: Record<string, number>, p: string, bm: Any): { blocks: Map<string, number>; unreadable: string[] } {
  const list: string[] = (bm.rev(p) ?? []).slice();
  const blocks = new Map<string, number>(list.map((g) => [g, 0]));
  const unreadable: string[] = [];
  const keys = keysOfPrecinct(fbm, p, bm);
  const whole = keys.filter((k) => k === p);
  const splits = keys.filter((k) => k.startsWith('B_') || k.startsWith('vfeature_'));
  const bare = keys.filter((k) => k !== p && isBlockId(k));
  for (const k of whole) for (const g of list) blocks.set(g, Number(fbm[k]) || 0);
  for (const k of splits) {
    const s = SPLIT_KEY.exec(k);
    if (!s) {
      unreadable.push(k);
      continue;
    }
    for (const g of decodeBitset(list, s[2])) blocks.set(g, Number(fbm[k]) || 0);
  }
  for (const k of bare) blocks.set(k, Number(fbm[k]) || 0);
  return { blocks, unreadable };
}

function districtLabel(m: Any, i: number): string {
  if (i === 0) return 'Unassigned';
  try {
    const l = m.redistrict?.safeDistrictProps?.()?.[i]?.label;
    return `District ${l || i}`;
  } catch {
    return `District ${i}`;
  }
}

/** Precincts shattered in DRA and not committed, and uncommitted block edits (ShatterManager). */
function uncommitted(m: Any): string[] {
  const sm = m.sm;
  const out = new Set<string>(Object.keys(sm?.shatterMap ?? {}));
  for (const k of Object.keys(sm?.blockmap ?? {})) {
    try {
      const p = m.blockMapping?.map(k);
      out.add(p ? String(p) : k);
    } catch {
      out.add(k);
    }
  }
  return [...out];
}

/** Every guard that must pass before a paint. Returns the reason to refuse, or null. Reads only. */
export function paintRefusal(step: PaintStepRequest, m: Any = getModel()): string | null {
  const avail = paintAvailability(m);
  if (!avail.ok) return avail.reason ?? 'Painting is not available on this map.';
  const n = Number(m.dataContext?.nDistricts) || 0;
  const okIndex = (i: number) => Number.isInteger(i) && i >= 1 && i <= n;
  if (!okIndex(step.from) || !okIndex(step.to) || step.from === step.to) return `The step's districts (${step.from} → ${step.to}) do not fit this map's ${n} districts.`;
  if (m.districtLocked(step.to)) return `${districtLabel(m, step.to)} is locked in DRA. Unlock it in DRA to paint into it.`;
  if (m.districtLocked(step.from)) return `${districtLabel(m, step.from)} is locked in DRA. Unlock it in DRA to paint out of it.`;
  const pending = uncommitted(m);
  if (pending.length) return `DRA has uncommitted block edits (precinct ${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', …' : ''}). Commit them with DRA's checkmark, or undo them, first.`;
  if (m.dataComplete === false) return 'DRA is still loading this map’s data. Try again in a moment.';
  const bm = blockMappingObj(m);
  const blocks = step.blocks;
  if (!blocks.length) return 'The step has no blocks.';
  if (new Set(blocks).size !== blocks.length) return 'The step lists a block twice.';
  const rev: string[] | undefined = bm.rev(step.precinctId);
  if (!rev?.length) return `DRA has no precinct ${step.precinctId} in its precinct data.`;
  for (const g of blocks) {
    const p = bm.map(g);
    if (p !== step.precinctId) return `Block ${g} is in precinct ${p ?? '(none)'} in DRA's precinct data, not ${step.precinctId}. Re-plan from here.`;
  }
  const fbm = m.fullBlockMap();
  const { blocks: now, unreadable } = decodePrecinct(fbm, step.precinctId, bm);
  if (unreadable.length) return `Precinct ${step.precinctId} is split in an older DRA format (${unreadable[0]}) that the extension cannot read, so it will not paint it.`;
  for (const g of blocks) {
    const d = now.get(g) ?? 0;
    if (d !== step.from) return `Block ${g} is now in ${districtLabel(m, d)}, not ${districtLabel(m, step.from)} as the plan expects. Re-plan from here, or paint it by hand.`;
  }
  if (step.wholePrecinct) {
    const want = new Set(blocks);
    if (rev.length !== want.size || rev.some((g) => !want.has(g))) return `This step was planned as the whole precinct ${step.precinctId}, but DRA's precinct now has different blocks. Re-plan from here.`;
    for (const g of rev) if ((now.get(g) ?? 0) !== step.from) return `Part of precinct ${step.precinctId} is no longer in ${districtLabel(m, step.from)}. Re-plan from here.`;
  }
  return null;
}

/**
 * What the extension calls for one step. Mirrors DRA exactly (RECON.md "Painting: what DRA does"):
 *  - whole precinct: the map's own precinct paint, `colorAt()`:
 *      fire(SetFeatureDistricts, { blockMap: { [id]: d }, filterLocked: true, coalesce: true, pushUndo: true })
 *  - blocks: DRA's own block-level paint, `actionPaintCity()`:
 *      c = undoredo.startComposite(); actionSetBlockDistricts({ filterLocked: true, blockMap, filterNoChange: true, pushUndo: true, counter: c });
 *      actionSetRedistrictProps({ fixContiguity: true, counter: c }); undoredo.endComposite()
 */
function callDra(step: PaintStepRequest, m: Any, fbm: Record<string, number>): void {
  if (step.wholePrecinct) {
    const blockMap: Record<string, number> = {};
    for (const k of keysOfPrecinct(fbm, step.precinctId, blockMappingObj(m))) blockMap[k] = step.to;
    const arg = { blockMap, filterLocked: true, coalesce: true, pushUndo: true };
    m.actionSetFeatureDistricts(arg);
    return;
  }
  const blockMap: Record<string, number> = {};
  for (const g of step.blocks) blockMap[g] = step.to;
  const ur = m.undoredo;
  const counter = ur.startComposite();
  const arg = { filterLocked: true, blockMap, filterNoChange: true, pushUndo: true, counter };
  try {
    m.actionSetBlockDistricts(arg);
    m.actionSetRedistrictProps({ fixContiguity: true, counter });
  } finally {
    ur.endComposite();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sameMap(a: Record<string, number>, b: Record<string, number>): boolean {
  let na = 0;
  for (const k in a) {
    na++;
    if (b[k] !== a[k]) return false;
  }
  return na === Object.keys(b).length;
}

/** Test builds only: the fixture can shorten the post-paint waits. */
const paintWaitScale = () => (__ZD_TEST__ && Number(document.documentElement.dataset.zdPaintWaitScale)) || 1;

/**
 * Paint one walkthrough step and verify it. The caller makes sure only one runs at a time.
 * Never calls DRA's undo: on any difference it reports and stops; DRA's own Undo takes it back.
 */
export async function paintStep(step: PaintStepRequest): Promise<PaintResult> {
  const t0 = performance.now();
  let m: Any;
  let bm: Any;
  let bmStamp: string;
  let before: Record<string, number>;
  let undoBefore: number;
  try {
    m = getModel();
    const refusal = paintRefusal(step, m);
    if (refusal) return { status: 'refused', stepId: step.stepId, reason: refusal };
    bm = blockMappingObj(m);
    bmStamp = readBlockMappingStamp(m);
    before = readFeatureMap(m);
    undoBefore = Number(m.undoredo.cur);
  } catch (e) {
    // Nothing has been called yet.
    return { status: 'refused', stepId: step.stepId, reason: `Could not check the map before painting (${e instanceof Error ? e.message : String(e)}).` };
  }
  try {
    return await paintAndVerify(step, m, bm, bmStamp, before, undoBefore, t0);
  } catch (e) {
    return {
      status: 'mismatch',
      stepId: step.stepId,
      summary: 'The extension could not re-read the plan after painting, so it cannot tell what changed.',
      details: [`Error: ${e instanceof Error ? e.message : String(e)}`, "Check the precinct in DRA. If it changed, DRA's Undo takes the edit back."],
      changedSomething: true,
      undoRecorded: false,
    };
  }
}

async function paintAndVerify(step: PaintStepRequest, m: Any, bm: Any, bmStamp: string, before: Record<string, number>, undoBefore: number, t0: number): Promise<PaintResult> {
  const details: string[] = [];
  let threw = false;
  try {
    callDra(step, m, before);
  } catch (e) {
    threw = true;
    details.push(`DRA raised an error while painting: ${e instanceof Error ? e.message : String(e)}`);
  }
  const undoAfterCall = Number(m.undoredo?.cur);

  // Wait for the edit to show in DRA's plan (it is applied synchronously in the bundle we read,
  // but nothing here relies on that), then for the plan to stop changing (DRA's contiguity fix
  // may re-split the precinct's features a moment later; the blocks stay where they are).
  const scale = paintWaitScale();
  const want = new Set(step.blocks);
  const stepDone = () => {
    const { blocks } = decodePrecinct(m.fullBlockMap(), step.precinctId, bm);
    for (const g of want) if (blocks.get(g) !== step.to) return false;
    return true;
  };
  for (let waited = 0; !threw && waited < 5000 * scale && !stepDone(); waited += 100) await sleep(100);
  let after = readFeatureMap(m);
  for (let settled = 0, waited = 0; waited < 3000 * scale && settled < 2; waited += 250) {
    await sleep(250 * scale);
    const next = readFeatureMap(m);
    settled = sameMap(next, after) ? settled + 1 : 0;
    after = next;
  }

  // Compare before and after, block by block, in every precinct whose features changed.
  const changedKeys: string[] = [];
  for (const k in before) if (after[k] !== before[k]) changedKeys.push(k);
  for (const k in after) if (!(k in before)) changedKeys.push(k);
  const touched = new Set<string>([step.precinctId]);
  const unknownKeys: string[] = [];
  for (const k of changedKeys) {
    const p = precinctOfKey(k, bm);
    if (p && bm.rev(p)) touched.add(p);
    else unknownKeys.push(k);
  }
  const notMoved: string[] = [];
  const wrong: string[] = [];
  const others: string[] = [];
  let moved = 0;
  let otherCount = 0;
  const MAX_PRECINCTS = 200;
  let pi = 0;
  for (const p of touched) {
    if (++pi > MAX_PRECINCTS) {
      others.push(`…and features in ${touched.size - MAX_PRECINCTS} more precincts changed`);
      break;
    }
    const b0 = decodePrecinct(before, p, bm);
    const b1 = decodePrecinct(after, p, bm);
    for (const k of b1.unreadable) if (!b0.unreadable.includes(k)) unknownKeys.push(k);
    for (const [g, d1] of b1.blocks) {
      const d0 = b0.blocks.get(g) ?? 0;
      if (want.has(g)) {
        if (d1 === step.to) moved++;
        else if (d1 === d0) notMoved.push(g);
        else wrong.push(`Block ${g} went to ${districtLabel(m, d1)} instead of ${districtLabel(m, step.to)}.`);
      } else if (d1 !== d0) {
        otherCount++;
        if (others.length < 6) others.push(`Block ${g} (precinct ${p}) changed from ${districtLabel(m, d0)} to ${districtLabel(m, d1)}, but it is not part of this step.`);
      }
    }
  }
  const undoNow = Number(m.undoredo?.cur);
  const changedSomething = changedKeys.length > 0;
  const undoRecorded = undoAfterCall === undoBefore + 1 || undoNow === undoBefore + 1;
  if (notMoved.length) details.push(`${notMoved.length} of the step's ${want.size} blocks did not move (e.g. ${notMoved.slice(0, 3).join(', ')}).`);
  details.push(...wrong.slice(0, 6));
  if (otherCount) details.push(...others, ...(otherCount > others.length ? [`${otherCount} blocks outside the step changed in all.`] : []));
  if (unknownKeys.length) details.push(`${unknownKeys.length} map feature(s) changed that the extension cannot read as blocks (e.g. ${unknownKeys[0]}).`);
  const pendingAfter = uncommitted(m);
  if (pendingAfter.length) details.push(`DRA now shows uncommitted edits in precinct ${pendingAfter.slice(0, 3).join(', ')}.`);
  if (changedSomething && !undoRecorded) details.push(`DRA's undo history moved by ${undoNow - undoBefore} step(s), not exactly 1, so DRA's Undo may not take this edit back in one go.`);
  // (The stamp, not object identity: model.blockMapping is a getter and may hand back a new wrapper.)
  if (readBlockMappingStamp(m) !== bmStamp) details.push("DRA's precinct data changed during the paint.");
  if (!changedSomething && !threw) details.push('Nothing changed in DRA.');

  if (!details.length) return { status: 'painted', stepId: step.stepId, blocksMoved: moved, featuresChanged: changedKeys.length, ms: Math.round(performance.now() - t0) };
  const summary = !changedSomething
    ? threw
      ? "DRA's paint function failed and nothing changed in DRA."
      : 'DRA did not apply the edit: nothing changed.'
    : `DRA's edit differs from the step: ${[notMoved.length ? `${notMoved.length} of ${want.size} blocks did not move` : '', wrong.length ? `${wrong.length} went to another district` : '', otherCount ? `${otherCount} block(s) outside the step changed` : '', unknownKeys.length ? `${unknownKeys.length} unreadable feature(s) changed` : ''].filter(Boolean).join(', ') || 'see the details'}.`;
  return { status: 'mismatch', stepId: step.stepId, summary, details, changedSomething, undoRecorded };
}
