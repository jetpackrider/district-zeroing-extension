/* Fake DRA app bundle (test fixture). Exposes window.dra with the shape SPEC.md / RECON.md describe,
 * a real MapLibre map, and window.fakeDra to simulate painting, committing, re-rendering and
 * basemap switches.
 *
 * URL options:
 *   ?plan=vt            the two-way-trade synthetic state (plan-vt.json; see fixture/generate.mjs)
 *   ?plan=real          New York's enacted congressional plan over the real bundle (plan-real-ny.json,
 *                       from fixture/gen-real.mjs): 288,819 blocks, precinct-level entries and
 *                       B_{precinct}_{bitset} splits, as DRA's fullBlockMap() holds them
 *   ?noplan=1           window.dra exists but no map is open (dra.model() returns undefined), like
 *                       DRA's map list; window.fakeDra.openPlan() opens it later
 *   ?nomap=1            no env.theMap and no window.mapboxgl (map handle missing -> mini-map fallback)
 *   ?break=<name>       break one hook: dra | fullBlockMap | blockMapping | aggregates | clientSession
 *   ?shapes=2010_VD     2010-shape map            ?restrict=county | city   county/city map
 *   ?mmd=1              multi-member districts    ?unequal=1   unequal targets
 *   ?multistate=1       multi-state map           ?pop=D20FA   prisoner-adjusted population
 *   ?drift=N            DRA's populations differ from the bundle by N people (data-mismatch)
 *   ?readonly=1         the map is read-only for this user (model.readonly)
 *   ?paintapi=missing   model.actionSetBlockDistricts is missing
 *   ?paintapi=arity     model.actionSetFeatureDistricts takes two arguments instead of one
 *
 * Paint actions (RECON.md "Painting: what DRA does"): actionSetFeatureDistricts, actionSetBlockDistricts,
 * actionSetRedistrictProps, recordUndoSetFeatureDistricts, districtLocked, actionUndo/actionRedo and an
 * undo history (model.undoredo) that follow draclient.bundle.js step by step, with the same argument
 * shapes, filters and undo records. Not simulated: DRA's server sync, and its contiguity fix-up
 * (`fixContiguity` is recorded and cleared, but non-contiguous splits are not re-split).
 *
 * Like DRA, district aggregates are cached and updated as blocks change (not recomputed on every read).
 */
(function () {
  const qs = new URLSearchParams(location.search);
  const opt = (k) => qs.get(k);
  const popField = opt('pop') === 'D20FA' ? 'D20FA' : 'D20F';
  // ?ddskey=<id>: DRA names the population dataset with an opaque id (seen on the real site:
  // "48eb784a-3b94-4005-b940-3cceeb5c92ba.ds") while the numbers behind it are still `popField`.
  const ddsKey = opt('ddskey') || popField;
  const listeners = {};
  const clientSession = {
    on(ev, cb) {
      (listeners[ev] ||= []).push(cb);
    },
    fire(ev, data) {
      (listeners[ev] || []).forEach((cb) => cb(data));
    },
  };
  const env = { clientSession, theMap: null };
  const app = { props: { env, curModel: null } };

  function setDra() {
    const dra = { app, env, model: () => app.props.curModel };
    if (opt('break') === 'dra') window.dra2 = dra;
    else window.dra = dra;
  }
  // Like DRA: window.dra is set on DOMContentLoaded; the model appears once the plan loads.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setDra);
  else setDra();

  const planUrl = opt('plan') === 'vt' ? '/plan-vt.json' : opt('plan') === 'real' ? '/plan-real-ny.json' : '/plan.json';
  const tFetch = performance.now();
  fetch(planUrl)
    .then((r) => r.json())
    .then((plan) => init(plan, performance.now() - tFetch));

  function init(plan, fetchMs) {
    const tInit = performance.now();
    // --- blocks, indexed -------------------------------------------------------------------
    const real = !plan.blocks;
    const geoids = real ? plan.geoids : plan.blocks.map((b) => b.geoid);
    const n = geoids.length;
    const popArr = Int32Array.from(real ? plan.pop : plan.blocks.map((b) => b.pop));
    const popAArr = Int32Array.from(real ? plan.popA : plan.blocks.map((b) => b.popA));
    const rings = real ? null : plan.blocks.map((b) => b.ring);
    const idx = new Map();
    for (let i = 0; i < n; i++) idx.set(geoids[i], i);
    /** precinct ID per block (mutable: "updated precincts"). */
    const precinctOfBlock = real ? plan.precinctOf.map((p) => plan.precinctIds[p]) : plan.blocks.map((b) => b.precinct);
    /** rev: precinct -> sorted block GEOIDs (DRA's blockMapping.rev()). */
    const rev = {};
    if (real) {
      for (let i = 0; i < n; i++) (rev[precinctOfBlock[i]] ||= []).push(geoids[i]); // geoids are sorted
    } else Object.assign(rev, JSON.parse(JSON.stringify(plan.rev)));
    const committed = { ...plan.featureMap }; // redistrict.blockMap()
    const sm = { shatterMap: {}, blockmap: {}, localBlockStamp: 0 };
    let blockStamp = 1;
    const drift = Number(opt('drift') || 0);
    const nDistricts = plan.nDistricts;

    class FakeMultiBlockMapping {
      constructor() {
        this.stamp = 1;
      }
      map(b) {
        const i = idx.get(b);
        return i === undefined ? undefined : precinctOfBlock[i];
      }
      rev(p) {
        return rev[p];
      }
      forEachRev(cb) {
        Object.keys(rev).forEach((p) => cb(p, rev[p]));
      }
      forEachBlock(cb) {
        geoids.forEach(cb);
      }
    }
    const mbm = new FakeMultiBlockMapping();

    function decodeBitset(list, s) {
      const bin = atob(s);
      const out = [];
      for (let i = 0; i < bin.length; i++) for (let k = 0; k < 8; k++) if (bin.charCodeAt(i) & (1 << k)) out.push(list[8 * i + k]);
      return out;
    }
    function encodeBitset(list, members) {
      const ix = new Map(list.map((g, i) => [g, i]));
      const bytes = new Uint8Array(Math.floor((list.length + 7) / 8));
      for (const g of members) {
        const i = ix.get(g);
        bytes[i >> 3] |= 1 << (i & 7);
      }
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    }
    function fullBlockMap() {
      const e = { ...committed };
      for (const k in sm.blockmap) e[k] = sm.blockmap[k];
      return e;
    }

    // --- district per block + cached aggregates (DRA keeps derived aggregates; it doesn't recount on read)
    const dist = new Uint16Array(n);
    const sumF = new Float64Array(nDistricts + 1);
    const sumA = new Float64Array(nDistricts + 1);
    function recomputeAll() {
      dist.fill(0);
      const fbm = fullBlockMap();
      const late = [];
      for (const id in fbm) {
        if (id.startsWith('B_')) late.push(id);
        else if (rev[id]) for (const g of rev[id]) dist[idx.get(g)] = fbm[id];
      }
      for (const id of late) {
        const [, p, bits] = /^B_([^_]*)_(.*)$/.exec(id);
        for (const g of decodeBitset(rev[p], bits)) dist[idx.get(g)] = fbm[id];
      }
      for (const id in sm.blockmap) {
        const i = idx.get(id);
        if (i !== undefined) dist[i] = sm.blockmap[id];
      }
      sumF.fill(0);
      sumA.fill(0);
      for (let i = 0; i < n; i++) {
        sumF[dist[i]] += popArr[i];
        sumA[dist[i]] += popAArr[i];
      }
    }
    function setDist(i, d) {
      const o = dist[i];
      if (o === d) return;
      sumF[o] -= popArr[i];
      sumA[o] -= popAArr[i];
      sumF[d] += popArr[i];
      sumA[d] += popAArr[i];
      dist[i] = d;
    }
    recomputeAll();
    const districtOfGeoid = (g) => dist[idx.get(g)] ?? 0;

    function aggregates() {
      const aggs = [];
      for (let d = 0; d <= nDistricts; d++) aggs.push({ D20F: { Tot: sumF[d] }, D20FA: { Tot: sumA[d] } });
      if (drift) {
        aggs[1].D20F.Tot += drift;
        aggs[1].D20FA.Tot += drift;
      }
      return aggs;
    }
    let totalF = 0;
    let totalA = 0;
    for (let i = 0; i < n; i++) {
      totalF += popArr[i];
      totalA += popAArr[i];
    }
    const totalPop = () => (popField === 'D20FA' ? totalA : totalF) + drift;
    const colors = ['#ffffff', '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0'];
    const locks = new Array(nDistricts + 1).fill(false);
    function districtProps() {
      const arr = [{ index: 0, label: '', color: '#fff', target: 0, membersPer: 1 }];
      for (let i = 1; i <= nDistricts; i++) arr.push({ index: i, label: String(i), color: colors[i % colors.length], target: 0, membersPer: opt('mmd') && i === 1 ? 2 : 1, lock: locks[i] });
      arr.targetPop = (m, i) => {
        if (!i) return 0;
        const base = Math.round(totalPop() / nDistricts);
        return opt('unequal') && i === 1 ? base + 500 : base;
      };
      return arr;
    }

    // --- DRA's undo history (draclient.bundle.js class dO, same logic) ----------------
    class UndoRedo {
      constructor(actions) {
        this.actions = actions;
        this.stack = [];
        this.cur = 0;
        this.bInUndo = false;
        this.counter = 1;
      }
      undoable() {
        return this.cur > 0;
      }
      redoable() {
        return this.cur < this.stack.length;
      }
      startComposite() {
        if (this.cur < this.stack.length) this.stack.splice(this.cur);
        this.composite = this.cur;
        this.counter++;
        return this.counter;
      }
      openComposite() {
        if (this.cur < this.stack.length) this.stack.splice(this.cur);
        if (this.cur) {
          const e = this.stack[this.cur - 1];
          if (!e.counter) e.counter = this.counter++;
          return e.counter;
        }
      }
      endComposite() {
        if (this.composite !== undefined) {
          if (this.composite < this.cur) {
            const e = this.stack[this.composite];
            e.counter = this.counter;
            for (let t = this.composite + 1; t < this.cur; t++) {
              e.undo.push(...this.stack[t].undo);
              e.redo.push(...this.stack[t].redo);
            }
            const t = this.cur - this.composite - 1;
            this.stack.splice(this.composite + 1, t);
            this.cur -= t;
          }
          delete this.composite;
        }
      }
      push(e, t) {
        if (this.bInUndo) return;
        if (this.cur < this.stack.length) this.stack.splice(this.cur);
        if (t && this.cur && this.stack[this.cur - 1].counter === t) {
          const top = this.stack[this.cur - 1];
          top.undo.push(...e.undo);
          top.redo.push(...e.redo);
        } else {
          e.counter = e.counter || t;
          this.stack.push(e);
          this.cur++;
        }
      }
      undo() {
        if (this.cur > 0) {
          const e = this.stack[this.cur - 1];
          this.bInUndo = true;
          for (let t = e.undo.length - 1; t >= 0; t--) this.actions.fire(e.undo[t].id, JSON.parse(JSON.stringify(e.undo[t].arg)));
          this.bInUndo = false;
          this.cur--;
        }
      }
      redo() {
        if (this.cur < this.stack.length) {
          const e = this.stack[this.cur];
          this.bInUndo = true;
          e.redo.forEach((x) => this.actions.fire(x.id, JSON.parse(JSON.stringify(x.arg))));
          this.bInUndo = false;
          this.cur++;
        }
      }
    }
    const SET_FEATURE_DISTRICTS = 'SetFeatureDistricts';
    const REDISTRICT_PROPS = 'SetRedistrictProps';
    const isVfeature = (k) => k.startsWith('B_') || k.startsWith('vfeature_');
    const isBlock = (k) => k.length >= 15 && !isVfeature(k) && /^\d+$/.test(k); // DRA's pc()
    const geoidOfV = (k) => (/^(?:B|vfeature)_([^_]*)_/.exec(k) || [])[1] || '';
    /** Committed vfeature keys of a precinct (DRA's sm.vfeatureByGeoid). */
    const vfeaturesOf = (pid) => Object.keys(committed).filter((k) => isVfeature(k) && geoidOfV(k) === pid);
    /** DRA's nd(): the blocks a B_ vfeature holds. */
    const blocksOfV = (k) => {
      const m = /^B_([^_]*)_(.*)$/.exec(k);
      return m && rev[m[1]] ? decodeBitset(rev[m[1]], m[2]) : null;
    };
    /** DRA's sd(): the feature ID for `blocks` of precinct `pid` (the precinct itself when it is all of it). */
    const featureIdFor = (pid, blocks) => (blocks.length === rev[pid].length ? pid : `B_${pid}_${encodeBitset(rev[pid], blocks)}`);
    const meta = { fixContiguity: false };
    let readonly = !!opt('readonly');
    /** Test switch: make the next paint action misbehave once ('extra' | 'wrong' | 'noop' | 'throw' | 'no-undo'). */
    let sabotage = null;
    const calls = [];

    /** Applies committed feature edits the way DRA's OT map does (0 = delete), then re-renders. */
    function applyFeatureEdits(n) {
      const touched = new Set();
      for (const k in n) {
        const p = rev[k] ? k : geoidOfV(k);
        if (p) touched.add(p);
        if (n[k] === 0 || n[k] > nDistricts) delete committed[k];
        else committed[k] = n[k];
      }
      for (const p of touched) {
        const d = new Map(rev[p].map((g) => [g, 0]));
        if (committed[p] !== undefined) for (const g of rev[p]) d.set(g, committed[p]);
        for (const k of vfeaturesOf(p)) for (const g of blocksOfV(k) || []) d.set(g, committed[k]);
        for (const [g, v] of d) if (sm.blockmap[g] === undefined) setDist(idx.get(g), v);
      }
      blockStamp++;
      clientSession.fire('state', {});
      rerender();
    }
    const dispatcher = {
      fire(id, arg) {
        if (id === SET_FEATURE_DISTRICTS) model.actionSetFeatureDistricts(arg);
        else if (id === REDISTRICT_PROPS) model.actionSetRedistrictProps({ ...arg, noundo: true });
      },
    };

    const model = {
      sessionID: `fixture-session-${plan.state}`,
      get readonly() {
        return readonly;
      },
      get frozen() {
        return false;
      },
      css: { bInSession: true, bReadOnly: false },
      dataComplete: true,
      undoredo: null,
      districtLocked(e) {
        return locks[e] || false;
      },
      actionToggleDistrictLock(e) {
        locks[e] = !locks[e];
        rerender();
      },
      filterDistricts(e) {
        const i = {};
        for (const r in e) {
          if (!Object.prototype.hasOwnProperty.call(e, r)) continue;
          const n = this.districtOf(r);
          if (!(this.districtLocked(n) || this.districtLocked(e[r]) || e[r] == n)) i[r] = e[r];
        }
        return Object.keys(i).length ? i : null;
      },
      filterNoChange(e) {
        const i = {};
        for (const r in e) if (Object.prototype.hasOwnProperty.call(e, r) && e[r] != this.districtOf(r)) i[r] = e[r];
        return Object.keys(i).length ? i : null;
      },
      coalesceDistrictVFeatures(e) {
        if (e == null) return null;
        const n = {};
        Object.keys(e).forEach((k) => {
          if (isVfeature(k)) (n[geoidOfV(k)] ||= []).push(k);
        });
        Object.keys(n).forEach((g) => {
          const s = e[n[g][0]];
          let all = true;
          vfeaturesOf(g).forEach((t) => {
            if (e[t] !== undefined ? e[t] !== s : this.districtOf(t) != s) all = false;
          });
          if (all && e[g] === undefined) {
            vfeaturesOf(g).forEach((t) => (e[t] = 0));
            e[g] = s;
          }
        });
        return Object.keys(e).length ? e : null;
      },
      recordUndoSetFeatureDistricts(e, t) {
        const i = {};
        for (const r in e) if (Object.prototype.hasOwnProperty.call(e, r)) i[r] = this.districtOf(r);
        this.undoredo.push({ undo: [{ id: SET_FEATURE_DISTRICTS, arg: { blockMap: JSON.parse(JSON.stringify(i)) } }], redo: [{ id: SET_FEATURE_DISTRICTS, arg: { blockMap: JSON.parse(JSON.stringify(e)) } }] }, t);
      },
      /** DRA: filters, coalesce, undo record, shatter-manager hand-off, then the committed edit (sent to DRA's server there). */
      actionSetFeatureDistricts(e) {
        calls.push({ fn: 'actionSetFeatureDistricts', arg: JSON.parse(JSON.stringify(e)), inUndo: this.undoredo.bInUndo });
        let n = e.blockMap;
        if (e.filterLocked) n = this.filterDistricts(n);
        else if (e.filterNoChange) n = this.filterNoChange(n);
        if (e.coalesce) n = this.coalesceDistrictVFeatures(n);
        if (n == null) return;
        const mode = this.undoredo.bInUndo ? null : sabotage;
        sabotage = null;
        if (mode === 'throw') throw new Error('fake DRA: paint failed (test)');
        if (mode === 'noop') return;
        if (mode === 'wrong') for (const k in n) if (n[k]) n[k] = (n[k] % nDistricts) + 1;
        if (mode === 'extra') {
          const pids = new Set(Object.keys(n).map((k) => (rev[k] ? k : geoidOfV(k))));
          const other = Object.keys(committed).find((k) => rev[k] && !pids.has(k) && committed[k] !== Object.values(n).find(Boolean));
          if (other) n[other] = Object.values(n).find(Boolean);
        }
        if (e.pushUndo && mode !== 'no-undo') this.recordUndoSetFeatureDistricts(n, e.counter);
        // sm.setFeatureDistricts + sm.filterOutFeatures: uncommitted block edits stay in the shatter manager.
        let local = false;
        Object.keys(n).forEach((t) => {
          if (sm.blockmap[t] !== undefined && sm.blockmap[t] != n[t]) {
            sm.blockmap[t] = n[t];
            local = true;
          }
        });
        if (local) sm.localBlockStamp++;
        Object.keys(sm.blockmap).forEach((t) => delete n[t]);
        Object.keys(n).forEach((t) => {
          if (isBlock(t)) delete n[t];
        });
        if (Object.keys(n).length && this.css.bInSession) applyFeatureEdits(n);
      },
      /** DRA: block-level assignment rewritten as precinct / B_ features per precinct, then actionSetFeatureDistricts. */
      actionSetBlockDistricts(e) {
        calls.push({ fn: 'actionSetBlockDistricts', arg: JSON.parse(JSON.stringify(e)) });
        const n = JSON.parse(JSON.stringify(e));
        const s = n.blockMap;
        n.blockMap = {};
        const o = n.blockMap;
        const a = this.blockMapping;
        const l = new Set();
        const c = new Set();
        Object.keys(s).forEach((g) => c.add(a.map(g)));
        const d = {};
        c.forEach((p) => {
          const t = vfeaturesOf(p);
          o[p] = 0;
          if (t.length)
            t.forEach((v) => {
              o[v] = 0;
              const bl = blocksOfV(v);
              const i = this.districtOf(v);
              const r = this.districtLocked(i);
              if (bl && bl.length)
                bl.forEach((g) => {
                  d[g] = i;
                  if (r) l.add(g);
                });
            });
          else {
            const i = this.districtOf(p);
            const r = this.districtLocked(i);
            (a.rev(p) || []).forEach((g) => {
              d[g] = i;
              if (r) l.add(g);
            });
          }
        });
        Object.keys(s).forEach((t) => {
          const i = s[t];
          if (!(e.filterLocked && (this.districtLocked(i) || l.has(t)))) d[t] = i;
        });
        n.filterLocked = false;
        n.coalesce = false;
        const byP = {};
        Object.keys(d).forEach((g) => {
          const p = a.map(g);
          const i = d[g];
          byP[p] ||= new Map();
          if (!byP[p].has(i)) byP[p].set(i, []);
          byP[p].get(i).push(g);
        });
        Object.keys(byP).forEach((p) => byP[p].forEach((blocks, i) => (o[featureIdFor(p, blocks)] = i)));
        this.actionSetFeatureDistricts(n);
      },
      /** DRA: only `fixContiguity` (and `noundo` / `counter`) are modelled here. */
      actionSetRedistrictProps(e) {
        calls.push({ fn: 'actionSetRedistrictProps', arg: JSON.parse(JSON.stringify(e)) });
        const undoable = !e.noundo;
        const counter = undoable ? e.counter || this.undoredo.startComposite() : 0;
        const old = { ...meta };
        for (const u in e) if (Object.prototype.hasOwnProperty.call(e, u) && u === 'fixContiguity') meta.fixContiguity = e.fixContiguity;
        if (undoable && old.fixContiguity !== meta.fixContiguity) this.undoredo.push({ undo: [{ id: REDISTRICT_PROPS, arg: old }], redo: [{ id: REDISTRICT_PROPS, arg: { ...meta } }] }, counter);
        // DRA's DFFixContiguity runs later, splits non-contiguous B_ features (not simulated) and clears the flag.
        if (meta.fixContiguity) setTimeout(() => this.actionSetRedistrictProps({ fixContiguity: false, noundo: true }), 150);
      },
      actionUndo() {
        this.undoredo.undo();
      },
      actionRedo() {
        this.undoredo.redo();
      },
      get dataContext() {
        return { state: opt('multistate') ? `+${plan.state}+NJ` : plan.state, datasource: opt('shapes') || '2020_VD', precincts: [], version: 'v08', planType: 'congress', nDistricts, equalPop: !opt('unequal'), allowMMD: !!opt('mmd') };
      },
      get datasetContext() {
        return { dsGroup: {}, dsMeta: {}, primeDDS: ddsKey, primeVDS: 'V20', primeEDS: 'E20' };
      },
      get blockMapping() {
        return opt('break') === 'blockMapping' ? null : mbm;
      },
      fullBlockMap,
      districtOf(id) {
        if (sm.blockmap[id] !== undefined) return sm.blockmap[id];
        return committed[id] ?? 0;
      },
      totalStatePop: totalPop,
      redistrict: {
        safeDistrictProps: districtProps,
        blockMap: () => committed,
        blockStamp: () => blockStamp,
      },
      get derivedProps() {
        return { redistrict: this.redistrict, sm, aggregates: opt('break') === 'aggregates' ? null : aggregates(), colors: colors.map((c) => ({ colorSolid: c })), displayName: real ? 'NY enacted (cd119, fixture)' : 'Fixture plan' };
      },
      datasetGetter(agg, key) {
        return (f) => agg[key === ddsKey ? popField : key][f];
      },
      sm,
      restrictionTyped() {
        const r = opt('restrict');
        return r ? { rt: r, id: '36901', name: 'Fixture County' } : { rt: 'state', id: null, name: '' };
      },
      isMapCollection: false,
    };
    if (opt('break') === 'fullBlockMap') {
      model.fullBlockMapV2 = model.fullBlockMap;
      delete model.fullBlockMap;
    }
    if (opt('break') === 'clientSession') delete clientSession.on;
    model.undoredo = new UndoRedo(dispatcher);
    if (opt('paintapi') === 'missing') delete model.actionSetBlockDistricts;
    if (opt('paintapi') === 'arity') {
      const real = model.actionSetFeatureDistricts;
      // Same words in its code, one more parameter: only the arity check can tell.
      model.actionSetFeatureDistricts = function (e, extra) {
        void extra; // blockMap filterLocked coalesce pushUndo recordUndoSetFeatureDistricts filterOutFeatures
        return real.call(this, e);
      };
    }

    // --- map ------------------------------------------------------------------
    const styleA = { version: 8, name: 'basemap-a', sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f6f1e7' } }] };
    const styleB = { version: 8, name: 'basemap-b', sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dfe9f1' } }, { id: 'water-ish', type: 'background', paint: { 'background-color': '#dfe9f1', 'background-opacity': 0.5 } }] };
    const Lib = window.mapboxgl || window.maplibregl;
    const map = new Lib.Map({ container: 'map', style: styleA, center: plan.center, zoom: real ? 9 : 11, attributionControl: false, fadeDuration: 0 });
    window.__fakeMap = map;
    if (!opt('nomap')) env.theMap = map;

    function blocksFC() {
      if (!rings) return { type: 'FeatureCollection', features: [] }; // real mode: no block geometry on the fake page
      return {
        type: 'FeatureCollection',
        features: geoids.map((g, i) => ({ type: 'Feature', properties: { geoid: g, district: dist[i], shattered: !!sm.shatterMap[precinctOfBlock[i]] }, geometry: { type: 'Polygon', coordinates: [rings[i]] } })),
      };
    }
    function addDraLayers() {
      if (!map.getSource('dra-blocks')) map.addSource('dra-blocks', { type: 'geojson', data: blocksFC() });
      if (!map.getLayer('dra-fill'))
        map.addLayer({ id: 'dra-fill', type: 'fill', source: 'dra-blocks', paint: { 'fill-color': ['match', ['get', 'district'], 1, colors[1], 2, colors[2], 3, colors[3], 4, colors[4], '#ccc'], 'fill-opacity': 0.35 } });
      if (!map.getLayer('dra-line')) map.addLayer({ id: 'dra-line', type: 'line', source: 'dra-blocks', paint: { 'line-color': ['case', ['get', 'shattered'], '#000', '#888'], 'line-width': ['case', ['get', 'shattered'], 1, 0.2] } });
    }
    let renders = 0;
    /** DRA re-renders and moves its own layers to the top. */
    function rerender() {
      renders++;
      const src = map.getSource('dra-blocks');
      if (src && rings) src.setData(blocksFC());
      for (const id of ['dra-fill', 'dra-line']) if (map.getLayer(id)) map.moveLayer(id);
      renderTable();
    }
    let ready = false;
    const noPlan = !!opt('noplan');
    function openPlan() {
      app.props.curModel = model; // the plan is now "open"
    }
    function closePlan() {
      app.props.curModel = null;
    }
    map.on('style.load', () => {
      addDraLayers();
      rerender();
      if (!ready) {
        ready = true;
        if (!noPlan) openPlan();
      }
    });
    /** DRA's basemap switch: drop every dra- layer, setStyle(diff:false), redraw on style.load. */
    let basemap = 'a';
    function switchBasemap() {
      for (const l of map.getStyle().layers) if (/^dra-/.test(l.id)) map.removeLayer(l.id);
      if (map.getSource('dra-blocks')) map.removeSource('dra-blocks');
      basemap = basemap === 'a' ? 'b' : 'a';
      map.setStyle(basemap === 'a' ? styleA : styleB, { diff: false });
    }

    function renderTable() {
      const t = document.getElementById('districts');
      if (!t) return;
      const aggs = aggregates();
      const dp = districtProps();
      t.innerHTML = aggs.map((a, i) => `<tr><td>${i ? dp[i].label : 'Un'}</td><td>${a[popField].Tot}</td><td>${i ? a[popField].Tot - dp.targetPop(model, i) : ''}</td></tr>`).join('');
      document.getElementById('status').textContent = `stamp ${blockStamp} / local ${sm.localBlockStamp} / shattered ${Object.keys(sm.shatterMap).join(',') || '-'} / renders ${renders}`;
    }

    // --- painting simulation (what the user does by hand in DRA) ---------------------
    const precinctOf = (g) => precinctOfBlock[idx.get(g)];
    function shatter(pid) {
      if (sm.shatterMap[pid]) return;
      sm.shatterMap[pid] = { geoid: pid, state: 'shattered' };
      for (const g of rev[pid]) sm.blockmap[g] = districtOfGeoid(g);
      sm.localBlockStamp++;
      rerender();
    }
    function paintBlock(g, d) {
      const pid = precinctOf(g);
      if (!sm.shatterMap[pid]) shatter(pid);
      sm.blockmap[g] = d;
      setDist(idx.get(g), d);
      sm.localBlockStamp++; // local only: no session event until commit
      rerender();
    }
    function dropCommitted(pid) {
      delete committed[pid];
      for (const k of Object.keys(committed)) if (k.startsWith(`B_${pid}_`)) delete committed[k];
    }
    function commit() {
      for (const pid of Object.keys(sm.shatterMap)) {
        const byD = new Map();
        for (const g of rev[pid]) {
          const d = sm.blockmap[g] ?? 0;
          if (!byD.has(d)) byD.set(d, []);
          byD.get(d).push(g);
          delete sm.blockmap[g];
        }
        dropCommitted(pid);
        if (byD.size === 1) committed[pid] = [...byD.keys()][0];
        else for (const [d, gs] of byD) committed[`B_${pid}_${encodeBitset(rev[pid], gs)}`] = d;
        delete sm.shatterMap[pid];
      }
      blockStamp++;
      sm.localBlockStamp++;
      clientSession.fire('state', {});
      rerender();
    }
    function paintPrecinct(pid, d) {
      dropCommitted(pid);
      committed[pid] = d;
      for (const g of rev[pid]) setDist(idx.get(g), d);
      blockStamp++;
      clientSession.fire('state', {});
      rerender();
    }
    /** "Updated precincts": move one block to a neighbouring precinct in the live mapping. */
    function updatePrecincts(g, toPid) {
      const from = precinctOf(g);
      rev[from] = rev[from].filter((x) => x !== g);
      rev[toPid] = [...rev[toPid], g].sort();
      precinctOfBlock[idx.get(g)] = toPid;
      recomputeAll();
      mbm.stamp++;
      clientSession.fire('state', {});
      rerender();
    }

    window.fakeDra = {
      /** Paint switches and readings for the paint tests. */
      setReadonly(v) {
        readonly = !!v;
        clientSession.fire('state', {});
        rerender();
      },
      lockDistrict(i, v = true) {
        locks[i] = !!v;
        rerender();
      },
      sabotageNextPaint(mode) {
        sabotage = mode;
      },
      undo: () => model.actionUndo(),
      redo: () => model.actionRedo(),
      undoDepth: () => model.undoredo.cur,
      paintCalls: () => JSON.parse(JSON.stringify(calls)),
      precincts: () => Object.keys(rev),
      committedKeysOf: (pid) => Object.keys(committed).filter((k) => k === pid || geoidOfV(k) === pid),
      fixContiguity: () => meta.fixContiguity,
      shatter,
      paintBlock,
      paintPrecinct,
      commit,
      rerender,
      switchBasemap,
      updatePrecincts,
      openPlan,
      closePlan,
      blocksOf: (pid) => rev[pid].slice(),
      precinctOf,
      districtOfBlock: districtOfGeoid,
      districtPops: () => aggregates().map((a) => a[popField].Tot),
      target: () => Math.round(totalPop() / nDistricts),
      /** Block-assignment CSV as DRA exports it (committed edits only, unassigned left out). */
      exportCsv() {
        const committedOnly = new Uint16Array(n);
        const late = [];
        for (const id in committed) {
          if (id.startsWith('B_')) late.push(id);
          else if (rev[id]) for (const g of rev[id]) committedOnly[idx.get(g)] = committed[id];
        }
        for (const id of late) {
          const [, p, bits] = /^B_([^_]*)_(.*)$/.exec(id);
          for (const g of decodeBitset(rev[p], bits)) committedOnly[idx.get(g)] = committed[id];
        }
        const lines = ['GEOID20,District'];
        for (let i = 0; i < n; i++) if (committedOnly[i]) lines.push(`${geoids[i]},${committedOnly[i]}`);
        return lines.join('\n');
      },
      layerIds: () => map.getStyle().layers.map((l) => l.id),
      renders: () => renders,
      basemap: () => basemap,
      ready: () => ready,
      stats: () => ({ blocks: n, precincts: Object.keys(rev).length, features: Object.keys(committed).length, fetchMs, initMs: performance.now() - tInit }),
      map,
    };
  }
})();
