/*
  AMPING offline map service - needs NO internet.
    * serves the vector map tiles from map/tiles.pack (Pi only)
    * routes (A*) over the OpenStreetMap road network with one-ways, roundabouts, access rules,
      and avoids the blocked roads / floodwaters that the Super Admin marks on the map
    * turn-by-turn instructions
    * offline search (places, barangays, streets, hospitals, police, fire stations, shelters ...)
  The same file runs on the Pi (Node: new MapService(dir).load()) and inside the phone's browser on a
  Heltec field node (MapService.fromParts(...) with data unpacked from the node map bundle).
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AmpMapService = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const MODE_BIT = { car: 1, bike: 2, foot: 4 };
const CAR_KPH = [80, 60, 50, 40, 35, 28, 15, 15, 8];
const VMAX = { car: 100 / 3.6, bike: 6.0, foot: 1.8 };
const CLASS_LABEL = ['motorway', 'highway', 'main road', 'road', 'road', 'road', 'service road', 'track', 'path'];
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

const R2D = 180 / Math.PI;
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
const angDiff = (a, b) => { let d = (b - a + 540) % 360 - 180; return d; };   // signed, -180..180 (right = +)

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v; const topK = k[0], topV = v[0]; const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lastK) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lastK; v[i] = lastV;
    }
    return [topK, topV];
  }
  peekKey() { return this.k[0]; }
}

// tiles.idx.bin: "AMPTIDX1" u32 count u32 0 | f64 keys (sorted) | u32 offsets | u32 lengths
//   key = ((group d ? 1 : 0) * 32 + z) * 2^34 + x * 2^17 + y        (older maps: tiles.idx.json {"g/z/x/y": [off, len]})
const tileKey = (g, z, x, y) => ((g === 'd' ? 1 : 0) * 32 + z) * 17179869184 + x * 131072 + y;
function tileKeyParts(k) { const y = k % 131072, r = (k - y) / 131072, x = r % 131072, gz = (r - x) / 131072; return [gz >= 32 ? 'd' : 'b', gz % 32, x, y]; }
function parseTileIndex(ab) {
  const u8 = new Uint8Array(ab);
  if (String.fromCharCode.apply(null, u8.subarray(0, 8)) !== 'AMPTIDX1') throw new Error('not a tile index');
  const n = new DataView(ab).getUint32(8, true);
  const keys = new Float64Array(ab, 16, n), off = new Uint32Array(ab, 16 + 8 * n, n), len = new Uint32Array(ab, 16 + 12 * n, n);
  const find = (k) => { let lo = 0, hi = n - 1; while (lo <= hi) { const m = (lo + hi) >>> 1, v = keys[m]; if (v === k) return m; if (v < k) lo = m + 1; else hi = m - 1; } return -1; };
  return {
    count: n, keys, off, len,
    get(g, z, x, y) { const i = find(tileKey(g, z, x, y)); return i < 0 ? null : [off[i], len[i]]; },
    forEach(fn) { for (let i = 0; i < n; i++) { const p = tileKeyParts(keys[i]); fn(p[0] + '/' + p[1] + '/' + p[2] + '/' + p[3], off[i], len[i]); } }
  };
}
function readTileIndex(dir) {
  const fs = require('fs'), path = require('path');
  const bin = path.join(dir, 'tiles.idx.bin');
  if (fs.existsSync(bin)) { const raw = fs.readFileSync(bin); return parseTileIndex(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)); }
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'tiles.idx.json'), 'utf8'));
  return { count: Object.keys(j).length, get(g, z, x, y) { return j[g + '/' + z + '/' + x + '/' + y] || null; }, forEach(fn) { for (const k of Object.keys(j)) fn(k, j[k][0], j[k][1]); } };
}

// graph.bin layout: u32 headerLen, u32 0, header JSON [{name,type,offset,length}], pad to 8, typed arrays
function parseGraphBin(ab) {
  const hdrLen = new DataView(ab).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, hdrLen)));
  const base = 8 + hdrLen + ((8 - ((8 + hdrLen) % 8)) % 8);
  const T = { Int32Array, Uint32Array, Float32Array, Uint8Array };
  const g = {};
  for (const h of header) g[h.name] = new T[h.type](ab, base + h.offset, h.length);
  return g;
}

class MapService {
  constructor(dir) {
    this.dir = dir; this.ok = false; this.meta = null; this.idx = null; this.fd = null; this.graph = null; this.search = [];
    this._tileCache = new Map();
  }

  load() {
    const fs = require('fs'), path = require('path');
    try {
      this.meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8'));
    } catch (e) { return false; }
    try {
      this.idx = readTileIndex(this.dir);
      this.fd = fs.openSync(path.join(this.dir, 'tiles.pack'), 'r');
    } catch (e) { this.idx = null; }
    try {
      const raw = fs.readFileSync(path.join(this.dir, 'graph.bin'));
      this._setGraph(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length),      // aligned copy
        JSON.parse(fs.readFileSync(path.join(this.dir, 'graph.meta.json'), 'utf8')));
    } catch (e) { this.graph = null; this.loadError = e.message; }
    try { this._setSearch(JSON.parse(fs.readFileSync(path.join(this.dir, 'search.json'), 'utf8'))); }
    catch (e) { this._setSearch([]); }
    this.ok = !!this.idx;
    return this.ok;
  }

  /** Browser / bundle use: parts = { meta, graphBin: ArrayBuffer, graphMeta: object, search: array } */
  static fromParts(parts) {
    const ms = new MapService(null);
    ms.meta = parts.meta || null;
    if (parts.graphBin && parts.graphMeta) { try { ms._setGraph(parts.graphBin, parts.graphMeta); } catch (e) { ms.graph = null; ms.loadError = e.message; } }
    ms._setSearch(parts.search || []);
    ms.ok = !!ms.meta;
    return ms;
  }
  _setSearch(list) { this.search = list; this._norm = list.map(s => this._n(s[0])); }

  close() { try { if (this.fd !== null) require('fs').closeSync(this.fd); } catch (e) { /* ignore */ } this.fd = null; }

  // ---------------------------------------------------------------- tiles (Pi only)
  tile(g, z, x, y) {
    if (!this.idx || this.fd === null) return null;
    const e = this.idx.get(g, z, x, y);
    if (!e) return null;
    const buf = Buffer.allocUnsafe(e[1]);
    require('fs').readSync(this.fd, buf, 0, e[1], e[0]);
    return buf;
  }

  // ---------------------------------------------------------------- graph
  _setGraph(ab, wm) {
    const g = parseGraphBin(ab);
    g.wcls = wm.cls; g.wflags = wm.flags; g.wspeed = wm.speed; g.wname = wm.name; g.wref = wm.ref; g.names = wm.names;
    g.N = g.lat.length; g.E = g.to.length;
    // per-way speed (m/s) and cost multiplier per mode
    const W = wm.cls.length;
    g.spd = { car: new Float32Array(W), bike: new Float32Array(W), foot: new Float32Array(W) };
    g.mul = { car: new Float32Array(W), bike: new Float32Array(W), foot: new Float32Array(W) };
    for (let w = 0; w < W; w++) {
      const cls = wm.cls[w], fl = wm.flags[w], ms = wm.speed[w];
      let car = CAR_KPH[cls]; if (ms) car = Math.min(ms, car * 1.25); if (fl & 2) car *= 0.7; car = Math.max(8, car);
      g.spd.car[w] = car / 3.6; g.mul.car[w] = (fl & 4) ? 4 : 1;
      let bike = cls <= 4 ? 18 : cls <= 6 ? 15 : 10; if (fl & 2) bike *= 0.7;
      g.spd.bike[w] = bike / 3.6; g.mul.bike[w] = 1;
      g.spd.foot[w] = ((fl & 16) ? 3 : 5) / 3.6; g.mul.foot[w] = 1;
    }
    // node grid (cells of ~275 m), packed in typed arrays: sorted cell keys -> run of node indexes
    const CELL = 0.0025; g.CELL = CELL;
    const nk = new Float64Array(g.N);
    for (let i = 0; i < g.N; i++) nk[i] = Math.floor(g.lat[i] / 1e7 / CELL) * 100000 + Math.floor(g.lon[i] / 1e7 / CELL);
    const sk = nk.slice().sort(); let nc = 0;
    for (let i = 0; i < sk.length; i++) if (i === 0 || sk[i] !== sk[i - 1]) sk[nc++] = sk[i];
    const cellKeys = sk.slice(0, nc), cellStart = new Uint32Array(nc + 1), cellNodes = new Uint32Array(g.N);
    const cellOf = (k) => { let lo = 0, hi = nc - 1; while (lo <= hi) { const m = (lo + hi) >>> 1, v = cellKeys[m]; if (v === k) return m; if (v < k) lo = m + 1; else hi = m - 1; } return -1; };
    const nodeCell = new Uint32Array(g.N);
    for (let i = 0; i < g.N; i++) { const c = cellOf(nk[i]); nodeCell[i] = c; cellStart[c + 1]++; }
    for (let c = 0; c < nc; c++) cellStart[c + 1] += cellStart[c];
    const fill = cellStart.slice(0, nc);
    for (let i = 0; i < g.N; i++) cellNodes[fill[nodeCell[i]]++] = i;
    g.cellKeys = cellKeys; g.cellStart = cellStart; g.cellNodes = cellNodes; g.cellOf = cellOf;
    // longest road segment: snapping looks this much further so a point beside a long straight segment finds it
    let maxSeg = 0; for (let e = 0; e < g.E; e++) if (g.len[e] > maxSeg) maxSeg = g.len[e];
    g.snapExtra = Math.min(300, maxSeg / 2);
    // connected road networks (union-find, ignoring direction): islands without a road link get different
    // numbers, so "no road to there" is answered at once instead of after searching the whole mainland
    const comp = new Int32Array(g.N); for (let i = 0; i < g.N; i++) comp[i] = i;
    const root = (x) => { while (comp[x] !== x) { comp[x] = comp[comp[x]]; x = comp[x]; } return x; };
    for (let n = 0; n < g.N; n++) for (let e = g.adj[n]; e < g.adj[n + 1]; e++) { const a = root(n), b = root(g.to[e]); if (a !== b) comp[a] = b; }
    for (let i = 0; i < g.N; i++) comp[i] = root(i);
    g.comp = comp;
    g.eCost = new Float64Array(g.E); g.eStamp = new Uint32Array(g.E); g.ePrev = new Int32Array(g.E);
    g.restr = new Map();                                   // via node -> [{from, to, kind}]   (kind 0 = no_*, 1 = only_*)
    for (const r of (wm.restr || [])) { let a = g.restr.get(r[1]); if (!a) { a = []; g.restr.set(r[1], a); } a.push({ from: r[0], to: r[2], kind: r[3] }); }
    g.blk = new Uint8Array(g.N); g.pen = new Uint8Array(g.N); g.run = 0;
    g.nodeLat = (i) => g.lat[i] / 1e7; g.nodeLon = (i) => g.lon[i] / 1e7;
    this.graph = g;
  }
  hasGraph() { return !!this.graph; }

  _nodesNear(lat, lon, rM) {
    const g = this.graph, CELL = g.CELL;
    const dLat = rM / 111320, dLon = rM / (111320 * Math.cos(lat * Math.PI / 180));
    const r0 = Math.floor((lat - dLat) / CELL), r1 = Math.floor((lat + dLat) / CELL), c0 = Math.floor((lon - dLon) / CELL), c1 = Math.floor((lon + dLon) / CELL);
    const out = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const ci = g.cellOf(r * 100000 + c); if (ci < 0) continue;
      for (let k = g.cellStart[ci]; k < g.cellStart[ci + 1]; k++) out.push(g.cellNodes[k]);
    }
    return out;
  }
  _fromOf(e) {                                    // the node an edge leaves from (binary search in adj)
    const adj = this.graph.adj; let lo = 0, hi = this.graph.N - 1;
    while (lo < hi) { const m = (lo + hi + 1) >>> 1; if (adj[m] <= e) lo = m; else hi = m - 1; }
    return lo;
  }

  // nearest usable road segment for a mode (k = return the k nearest different segments instead)
  snap(lat, lon, mode, k) {
    const g = this.graph, bit = MODE_BIT[mode];
    const cosl = Math.cos(lat * Math.PI / 180);
    // a phone / node map has only main roads outside its detailed area: look further for those
    const radii = this.meta && this.meta.detail ? [80, 250, 700, 2000, 6000, 15000, 40000] : [80, 250, 700, 2000, 6000];
    for (const R of radii) {
      const cand = this._nodesNear(lat, lon, R + (g.snapExtra || 0));
      let best = null; const list = k ? [] : null;
      for (const n of cand) {
        const nlat = g.lat[n] / 1e7, nlon = g.lon[n] / 1e7;
        for (let e = g.adj[n]; e < g.adj[n + 1]; e++) {
          if (!(g.mask[e] & bit)) continue;
          const m = g.to[e]; const mlat = g.lat[m] / 1e7, mlon = g.lon[m] / 1e7;
          // project P on segment n->m (local metric)
          const ax = 0, ay = 0, bx = (mlon - nlon) * 111320 * cosl, by = (mlat - nlat) * 111320;
          const px = (lon - nlon) * 111320 * cosl, py = (lat - nlat) * 111320;
          const len2 = bx * bx + by * by; let t = len2 > 0 ? ((px - ax) * bx + (py - ay) * by) / len2 : 0; t = Math.max(0, Math.min(1, t));
          const dx = px - (ax + t * bx), dy = py - (ay + t * by), d = Math.hypot(dx, dy);
          if (list) list.push({ d, n, m, e, t, len: g.len[e] });
          if (!best || d < best.d) best = { d, n, m, e, t, len: g.len[e] };
        }
      }
      if (best && best.d <= R && k) {
        list.sort((a, b) => a.d - b.d); const out = [], seen = new Set();
        for (const c of list) { const key = Math.min(c.n, c.m) + ',' + Math.max(c.n, c.m); if (seen.has(key)) continue; seen.add(key); out.push(this._snapDone(c, bit)); if (out.length >= k) break; }
        return out;
      }
      if (best && best.d <= R) return this._snapDone(best, bit);
    }
    return k ? [] : null;
  }
  _snapDone(best, bit) {
    const g = this.graph;
    // is the reverse direction usable? (find m -> n)
    let rev = -1;
    for (let e = g.adj[best.m]; e < g.adj[best.m + 1]; e++) if (g.to[e] === best.n && (g.mask[e] & bit) && g.way[e] === g.way[best.e]) { rev = e; break; }
    best.rev = rev;
    best.lat = g.lat[best.n] / 1e7 + (g.lat[best.m] / 1e7 - g.lat[best.n] / 1e7) * best.t;
    best.lon = g.lon[best.n] / 1e7 + (g.lon[best.m] / 1e7 - g.lon[best.n] / 1e7) * best.t;
    return best;
  }

  _edgeCost(e, mode) { const g = this.graph, w = g.way[e]; return g.len[e] / g.spd[mode][w] * g.mul[mode][w]; }

  // mark nodes blocked / penalised from the Super Admin's map markers
  _applyAvoid(infra, mode) {
    const g = this.graph; const touched = [];
    if (!infra) return touched;
    const mark = (arr, n) => { if (!arr[n]) { arr[n] = 1; touched.push([arr, n]); } };
    const inCircle = (lat, lon, rM, fn) => { for (const n of this._nodesNear(lat, lon, rM + 30)) if (haversine(lat, lon, g.lat[n] / 1e7, g.lon[n] / 1e7) <= rM) fn(n); };
    const pip = (lat, lon, poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const yi = poly[i].lat, xi = poly[i].lng, yj = poly[j].lat, xj = poly[j].lng; if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside; } return inside; };
    const shape = (o, fn) => {
      if (!o) return;
      if (Array.isArray(o.path) && o.path.length >= 2) {
        const pts = o.path.filter(p => p && p.lat !== undefined && (p.lng !== undefined));
        const clat = pts.reduce((s, p) => s + p.lat, 0) / pts.length, clon = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
        const rad = Math.max(...pts.map(p => haversine(clat, clon, p.lat, p.lng))) + 20;
        for (const n of this._nodesNear(clat, clon, rad)) {
          const la = g.lat[n] / 1e7, lo = g.lon[n] / 1e7;
          if ((pts.length >= 3 && pip(la, lo, pts)) || pts.some(p => haversine(la, lo, p.lat, p.lng) <= 20)) fn(n);
        }
      } else if (o.lat !== undefined && o.lng !== undefined) inCircle(+o.lat, +o.lng, Math.max(15, +o.radius || 60), fn);
    };
    const br = infra.blockedRoads || {}, fl = infra.floodwaters || {};
    if (mode !== 'foot') for (const k of Object.keys(br)) shape(br[k], (n) => mark(g.blk, n));
    for (const k of Object.keys(fl)) shape(fl[k], (n) => mark(mode === 'foot' ? g.pen : g.blk, n));
    return touched;
  }

  // ---------------------------------------------------------------- routing
  route(fromLat, fromLon, toLat, toLon, mode, infra, opts) {
    opts = opts || {};
    if (!this.graph) return { ok: false, error: 'Road network is not installed on this Pi (map/graph.bin missing).' };
    mode = MODE_BIT[mode] ? mode : 'car';
    const g = this.graph, bit = MODE_BIT[mode];
    let s = this.snap(fromLat, fromLon, mode), d = this.snap(toLat, toLon, mode);
    if (!s) return { ok: false, error: 'Your position is outside the offline map area.' };
    if (!d) return { ok: false, error: 'The destination is outside the offline map area.' };
    if (g.comp[s.n] !== g.comp[d.n]) {
      // nearest roads are not connected (an island, or a stray road piece): use the nearest road at either end
      // that is on the same network as the other end
      const ss = this.snap(fromLat, fromLon, mode, 8), dd = this.snap(toLat, toLon, mode, 8);
      const d2 = dd.find(c => g.comp[c.n] === g.comp[s.n]), s2 = ss.find(c => g.comp[c.n] === g.comp[d.n]);
      if (d2 && (!s2 || d2.d - d.d <= s2.d - s.d)) d = d2; else if (s2) s = s2;
      else return { ok: false, island: true, error: 'There is no road from here to the destination on the offline map - it is on another island or road network (a boat / ferry is needed).' };
    }

    let touched = [];
    const run = (avoid) => {
      if (avoid) touched = this._applyAvoid(infra, mode);
      try {
        // long trips: small roads (residential, service, tracks, paths) only near the start and the end -
        // keeps a cross-Mindanao route fast on the Pi and in a phone. No route that way -> search everything.
        const hier = haversine(s.lat, s.lon, d.lat, d.lon) > 40000 ? { near: 15000 } : null;
        let r = this._astar(s, d, mode, bit, hier); if (!r && hier) r = this._astar(s, d, mode, bit, null);
        if (r && avoid && r.nodes.some(n => g.blk[n])) r.blockedHit = true; return r;
      }
      finally { for (const [arr, n] of touched) arr[n] = 0; touched = []; }
    };
    let res = run(!opts.noAvoid);
    let crossesBlocked = !!(res && res.blockedHit);
    if (!res && !opts.noAvoid && infra) { res = run(false); if (res) crossesBlocked = true; }
    // a phone / node map holds only the main roads outside its detailed area: the nearest road may be a one-way
    // piece whose way in is not on that map - then try the next nearest roads at both ends
    if (!res && this.meta && this.meta.detail) {
      const ss = this.snap(fromLat, fromLon, mode, 3), dd = this.snap(toLat, toLon, mode, 6), s0 = s, d0 = d;
      search: for (const s2 of ss) for (const d2 of dd) {
        if (s2.e === s0.e && d2.e === d0.e) continue;
        s = s2; d = d2; res = run(!opts.noAvoid); if (!res && !opts.noAvoid && infra) { res = run(false); if (res) crossesBlocked = true; }
        if (res) break search;
      }
    }
    if (!res) return { ok: false, error: 'No ' + (mode === 'car' ? 'drivable' : mode === 'bike' ? 'bikeable' : 'walkable') + ' route was found between these points on the offline map.' };
    const out = this._describe(res, s, d, fromLat, fromLon, toLat, toLon, mode);
    out.ok = true; out.mode = mode;
    if (crossesBlocked) out.warning = 'No route avoids the blocked / flooded areas marked on the map - this route passes through one. Proceed with caution.';
    else if (this.meta && this.meta.detail && Math.max(out.offRoad.start, out.offRoad.end) > 1000) {
      const km = (m) => (m / 1000).toFixed(1) + ' km';
      out.warning = 'The map on this phone has only the main roads here: ' + (out.offRoad.end > 1000 ? 'the route ends ' + km(out.offRoad.end) + ' (straight line) before the destination.' : 'the route starts ' + km(out.offRoad.start) + ' from you, on the nearest main road.') + ' Ask locally for the last part.';
    }
    return out;
  }

  // is the turn eIn -> eOut allowed?  (OSM turn restrictions; applied to motor vehicles)
  _turnOk(eIn, eOut) {
    const g = this.graph; const v = g.to[eIn]; const list = g.restr.get(v); if (!list) return true;
    const wIn = g.way[eIn], wOut = g.way[eOut];
    for (const r of list) {
      if (r.from !== wIn) continue;
      if (r.kind === 0) {
        if (r.from === r.to) { if (wOut === wIn && g.to[eOut] === this._fromOf(eIn)) return false; }   // no_u_turn
        else if (wOut === r.to) return false;
      } else if (wOut !== r.to) return false;                                                    // only_*
    }
    return true;
  }

  // A* over directed edges (so turn restrictions are exact). Returns null if no route.
  _astar(s, d, mode, bit, hier) {
    const gg = this.graph, cs = Math.cos(s.lat * Math.PI / 180), near2 = hier ? (hier.near / 111320) ** 2 : 0;
    const far = (n) => { const la = gg.lat[n] / 1e7, lo = gg.lon[n] / 1e7; const a1 = la - s.lat, b1 = (lo - s.lon) * cs, a2 = la - d.lat, b2 = (lo - d.lon) * cs; return a1 * a1 + b1 * b1 > near2 && a2 * a2 + b2 * b2 > near2; };
    const g = this.graph; const run = ++g.run; if (g.run > 4e9) { g.eStamp.fill(0); g.run = 1; }
    const useRestr = bit === 1 && g.restr.size > 0;
    const vmax = VMAX[mode]; const dlat = d.lat, dlon = d.lon; const cosl = Math.cos(dlat * Math.PI / 180);
    const h = (n) => { const dy = (g.lat[n] / 1e7 - dlat) * 111320, dx = (g.lon[n] / 1e7 - dlon) * 111320 * cosl; return Math.sqrt(dx * dx + dy * dy) / vmax; };
    const heap = new MinHeap();
    const seed = (e, cost) => { if (g.eStamp[e] !== run || cost < g.eCost[e]) { g.eStamp[e] = run; g.eCost[e] = cost; g.ePrev[e] = -1; heap.push(cost + h(g.to[e]), e); } };
    // start: standing on segment n-m; leaving towards m along s.e, or towards n along s.rev
    seed(s.e, this._edgeCost(s.e, mode) * (1 - s.t));
    if (s.rev >= 0) seed(s.rev, this._edgeCost(s.rev, mode) * s.t);
    // goal: reach d.n and drive d.e to the point, or reach d.m and drive d.rev to the point
    const goal = new Map(); goal.set(d.n, { arc: d.e, cost: this._edgeCost(d.e, mode) * d.t });
    if (d.rev >= 0) goal.set(d.m, { arc: d.rev, cost: this._edgeCost(d.rev, mode) * (1 - d.t) });
    let best = Infinity, bestEdge = -1;
    // same undirected segment: drive straight along it
    let direct = null;
    if ((s.n === d.n && s.m === d.m) || (s.n === d.m && s.m === d.n)) {
      const t1 = s.t, t2 = (s.n === d.n) ? d.t : 1 - d.t;
      if (t2 >= t1) direct = { cost: this._edgeCost(s.e, mode) * (t2 - t1) };
      else if (s.rev >= 0) direct = { cost: this._edgeCost(s.rev, mode) * (t1 - t2) };
    }
    let pops = 0;
    while (heap.size) {
      const [f, e] = heap.pop();
      if (f >= best) break;
      const v = g.to[e], gc = g.eCost[e];
      if (f > gc + h(v) + 1e-6) continue;                      // stale entry
      if (++pops > 4000000) break;
      const gl = goal.get(v);
      if (gl !== undefined && (!useRestr || this._turnOk(e, gl.arc))) { const tot = gc + gl.cost; if (tot < best) { best = tot; bestEdge = e; } }
      for (let e2 = g.adj[v]; e2 < g.adj[v + 1]; e2++) {
        if (!(g.mask[e2] & bit)) continue;
        const m = g.to[e2]; if (g.blk[m]) continue;
        if (hier && g.wcls[g.way[e2]] >= 5 && far(m)) continue;
        if (useRestr && !this._turnOk(e, e2)) continue;
        const base = this._edgeCost(e2, mode); let c = gc + base; if (g.pen[m] || g.pen[v]) c += base * 3;
        if (g.eStamp[e2] !== run || c < g.eCost[e2]) { g.eStamp[e2] = run; g.eCost[e2] = c; g.ePrev[e2] = e; heap.push(c + h(m), e2); }
      }
    }
    if (direct && direct.cost <= best) return { direct, cost: direct.cost, nodes: [], edges: [] };
    if (bestEdge < 0) return null;
    const chain = []; for (let e = bestEdge; e !== -1; e = g.ePrev[e]) chain.push(e);
    chain.reverse();
    return { cost: best, nodes: chain.map(e => g.to[e]), edges: chain.slice(1) };
  }

  // turn the node path into geometry + instructions
  _describe(res, s, d, fromLat, fromLon, toLat, toLon, mode) {
    const g = this.graph, bit = MODE_BIT[mode];
    const P = [];           // [lat, lon]
    const segWay = [];      // way index of the segment ENDING at P[i]  (segWay[0] unused)
    const segLen = [];
    const push = (lat, lon, way) => { P.push([lat, lon]); segWay.push(way); };
    const wayOfS = g.way[s.e], wayOfD = g.way[d.e];

    if (res.direct) {
      push(s.lat, s.lon, wayOfS); push(d.lat, d.lon, wayOfS);
    } else {
      push(s.lat, s.lon, wayOfS);
      const first = res.nodes[0];
      push(g.lat[first] / 1e7, g.lon[first] / 1e7, wayOfS);
      for (let i = 0; i < res.edges.length; i++) { const n = res.nodes[i + 1]; push(g.lat[n] / 1e7, g.lon[n] / 1e7, g.way[res.edges[i]]); }
      push(d.lat, d.lon, wayOfD);
    }
    // remove zero-length points
    const Q = [], QW = [];
    for (let i = 0; i < P.length; i++) { if (i > 0 && haversine(P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]) < 0.05) continue; Q.push(P[i]); QW.push(segWay[i]); }
    if (Q.length < 2) { Q.push(Q[0]); QW.push(QW[0]); }
    // cumulative distance
    const cum = [0]; for (let i = 1; i < Q.length; i++) cum.push(cum[i - 1] + haversine(Q[i - 1][0], Q[i - 1][1], Q[i][0], Q[i][1]));
    const total = cum[cum.length - 1];

    // degree of a graph node for this mode (distinct usable neighbours)
    const degAt = (lat, lon) => {                       // find nearest graph node to (lat,lon) within 2 m and count neighbours
      let bestN = -1, bd = 3;
      for (const n of this._nodesNear(lat, lon, 4)) { const dd = haversine(lat, lon, g.lat[n] / 1e7, g.lon[n] / 1e7); if (dd < bd) { bd = dd; bestN = n; } }
      if (bestN < 0) return { deg: 0, roundExits: 0 };
      const nb = new Set(); let nonRound = 0;
      for (let e = g.adj[bestN]; e < g.adj[bestN + 1]; e++) if (g.mask[e] & bit) { nb.add(g.to[e]); if (!(g.wflags[g.way[e]] & 1)) nonRound++; }
      // incoming-only edges (one-ways towards this node) also count as a street here
      return { deg: nb.size, nonRound, node: bestN };
    };
    const wayName = (w) => {
      const n = g.wname[w] >= 0 ? g.names[g.wname[w]] : ''; const r = g.wref[w] >= 0 ? g.names[g.wref[w]] : '';
      return n || r || '';
    };
    const wayLabel = (w) => wayName(w) || (g.wflags[w] & 1 ? '' : g.wcls[w] === 7 ? 'the track' : g.wcls[w] === 8 ? 'the path' : g.wcls[w] === 6 ? 'the service road' : '');
    const isRound = (w) => !!(g.wflags[w] & 1);
    const sameRoad = (a, b) => a === b || (wayName(a) && wayName(a) === wayName(b));

    const steps = [];
    const bearAt = (i, forward) => {            // bearing using a point >= 12 m away from vertex i
      let j = i, acc = 0;
      if (forward) { while (j < Q.length - 1 && acc < 12) { j++; acc = cum[j] - cum[i]; } return bearing(Q[i][0], Q[i][1], Q[j][0], Q[j][1]); }
      while (j > 0 && acc < 12) { j--; acc = cum[i] - cum[j]; } return bearing(Q[j][0], Q[j][1], Q[i][0], Q[i][1]);
    };
    const mk = (type, mod, i, name, extra) => steps.push(Object.assign({ type, mod, i, name, lat: Q[i][0], lon: Q[i][1], at: cum[i], text: '' }, extra || {}));

    // depart
    const b0 = bearAt(0, true), dir0 = COMPASS[Math.round(b0 / 45) % 8];
    mk('depart', '', 0, wayName(QW[1]), { heading: dir0 });
    let rndExits = 0, inRound = false, roundStartI = -1;
    for (let i = 1; i < Q.length - 1; i++) {
      const wIn = QW[i], wOut = QW[i + 1];
      const nowRound = isRound(wOut), wasRound = isRound(wIn);
      const info = degAt(Q[i][0], Q[i][1]);
      if (nowRound && !wasRound) { inRound = true; rndExits = 0; roundStartI = i; continue; }
      if (inRound) {
        if (info.nonRound > 0 && nowRound) rndExits++;                              // passing an exit
        if (wasRound && !nowRound) {                                               // leaving = the exit we take
          rndExits++;
          mk('roundabout', '', roundStartI, wayLabel(wOut), { exit: rndExits, exitName: wayName(wOut), at: cum[roundStartI], lat: Q[roundStartI][0], lon: Q[roundStartI][1] });
          steps[steps.length - 1].leaveAt = cum[i];
          inRound = false;
        }
        continue;
      }
      const turn = angDiff(bearAt(i, false), bearAt(i, true));
      const abs = Math.abs(turn);
      const changed = !sameRoad(wIn, wOut);
      const junction = info.deg >= 3;
      if (abs >= 25 && junction) {
        const mod = abs > 170 ? 'uturn' : abs >= 130 ? 'sharp ' + (turn > 0 ? 'right' : 'left') : abs >= 60 ? (turn > 0 ? 'right' : 'left') : 'slight ' + (turn > 0 ? 'right' : 'left');
        mk('turn', mod, i, wayLabel(wOut));
      } else if (abs >= 45 && changed) {
        mk('turn', abs >= 60 ? (turn > 0 ? 'right' : 'left') : 'slight ' + (turn > 0 ? 'right' : 'left'), i, wayLabel(wOut));
      } else if (changed && junction && wayName(wOut)) {
        mk('continue', 'straight', i, wayLabel(wOut));
      }
    }
    mk('arrive', '', Q.length - 1, '');

    // distances / texts
    for (let k = 0; k < steps.length; k++) {
      const st = steps[k], nxt = steps[k + 1];
      const endAt = nxt ? nxt.at : total;
      const from = st.type === 'roundabout' && st.leaveAt !== undefined ? st.leaveAt : st.at;
      st.dist = Math.max(0, Math.round(endAt - from));
      if (st.type === 'depart') st.text = 'Head ' + st.heading + (st.name ? ' on ' + st.name : '');
      else if (st.type === 'turn') st.text = (st.mod === 'uturn' ? 'Make a U-turn' : 'Turn ' + st.mod) + (st.name ? ' onto ' + st.name : '');
      else if (st.type === 'continue') st.text = st.name ? 'Continue onto ' + st.name : 'Continue straight';
      else if (st.type === 'roundabout') st.text = 'At the roundabout, take the ' + (ORD[st.exit] || st.exit + 'th') + ' exit' + (st.exitName ? ' onto ' + st.exitName : '');
      else st.text = 'You have arrived at your destination';
    }
    // merge duplicate consecutive "continue" and drop useless zero-length turn spam
    const merged = [];
    for (const st of steps) { const p = merged[merged.length - 1]; if (p && st.type === 'continue' && p.type === 'continue' && p.name === st.name) { p.dist += st.dist; continue; } merged.push(st); }

    // time
    let dur = res.cost;
    // geometry (simplified but keeping every maneuver vertex)
    const keep = new Set([0, Q.length - 1]); for (const st of merged) keep.add(st.i);
    const stack = [[0, Q.length - 1]]; const cosl = Math.cos(Q[0][0] * Math.PI / 180);
    const xy = (p) => [p[1] * 111320 * cosl, p[0] * 111320];
    const XY = Q.map(xy);
    const tol = 1.5; const flag = new Uint8Array(Q.length); flag[0] = flag[Q.length - 1] = 1; for (const k of keep) flag[k] = 1;
    // Douglas-Peucker between mandatory points
    const mand = [...keep].sort((a, b) => a - b);
    for (let m = 0; m < mand.length - 1; m++) stack.push([mand[m], mand[m + 1]]);
    stack.shift();
    while (stack.length) {
      const [a, b] = stack.pop(); let md = 0, mi = -1; const [ax, ay] = XY[a], [bx, by] = XY[b]; const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) { const [px, py] = XY[i]; let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); const dd = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); if (dd > md) { md = dd; mi = i; } }
      if (md > tol && mi > 0) { flag[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    const remap = new Map(); const geom = [];
    for (let i = 0; i < Q.length; i++) if (flag[i]) { remap.set(i, geom.length); geom.push([+Q[i][0].toFixed(6), +Q[i][1].toFixed(6)]); }
    const outSteps = merged.map(st => ({ type: st.type, mod: st.mod, text: st.text, name: st.name, dist: st.dist, i: remap.get(st.i), lat: +st.lat.toFixed(6), lon: +st.lon.toFixed(6), exit: st.exit }));
    const offStart = Math.round(haversine(fromLat, fromLon, s.lat, s.lon)), offEnd = Math.round(haversine(toLat, toLon, d.lat, d.lon));
    const walkSpeed = 1.3;
    dur += (offStart + offEnd) / walkSpeed * (mode === 'foot' ? 0.9 : 1);
    return {
      distance: Math.round(total + offStart + offEnd), roadDistance: Math.round(total), duration: Math.round(dur),
      geometry: geom, steps: outSteps,
      snappedFrom: [+s.lat.toFixed(6), +s.lon.toFixed(6)], snappedTo: [+d.lat.toFixed(6), +d.lon.toFixed(6)],
      offRoad: { start: offStart, end: offEnd }
    };
  }

  // ---------------------------------------------------------------- search
  _n(t) { return String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  geocode(q, lat, lon, limit) {
    limit = limit || 12;
    const nq = this._n(q); if (!nq) return [];
    const toks = nq.split(' ');
    const res = [];
    for (let i = 0; i < this.search.length; i++) {
      const nn = this._norm[i]; let ok = true;
      for (const t of toks) if (nn.indexOf(t) < 0) { ok = false; break; }
      if (!ok) continue;
      let score = nn === nq ? 100 : nn.startsWith(nq) ? 80 : (' ' + nn).indexOf(' ' + nq) >= 0 ? 60 : 40;
      const s = this.search[i];
      score += s[1] === 'barangay' ? 8 : s[1] === 'place' ? (s[2] === 1 ? 26 : s[2] === 2 ? 16 : 6) : s[1] === 'poi' ? 5 : 0;   // cities and towns first
      let dist = null;
      if (lat !== undefined && lat !== null && !Number.isNaN(lat)) { dist = haversine(lat, lon, s[3], s[4]); score -= Math.min(20, dist / 5000); }
      res.push({ name: s[0], kind: s[1], sub: s[2], lat: s[3], lon: s[4], dist: dist === null ? undefined : Math.round(dist), score });
    }
    res.sort((a, b) => b.score - a.score);
    return res.slice(0, limit);
  }

  nearest(type, lat, lon, mode, infra, k) {
    const subs = { hospital: [1], clinic: [2], medical: [1, 2], pharmacy: [3], police: [4], fire: [5], school: [6, 7], evac: [9, 6, 7, 8], shelter: [9], townhall: [8], fuel: [12] }[type];
    if (!subs) return { ok: false, error: 'unknown place type' };
    const list = [];
    for (const s of this.search) if (s[1] === 'poi' && subs.includes(s[2])) list.push({ name: s[0], sub: s[2], lat: s[3], lon: s[4], line: haversine(lat, lon, s[3], s[4]) });
    list.sort((a, b) => a.line - b.line);
    // prefer the first-listed (most relevant) subtype when it is not much farther
    const cands = list.slice(0, Math.max(3, (k || 3) + 2));
    const out = [];
    for (const c of cands) {
      const r = this.route(lat, lon, c.lat, c.lon, mode, infra);
      out.push({ name: c.name, sub: c.sub, lat: c.lat, lon: c.lon, straight: Math.round(c.line), ok: r.ok, distance: r.ok ? r.distance : undefined, duration: r.ok ? r.duration : undefined, error: r.ok ? undefined : r.error, route: r.ok ? r : undefined });
    }
    out.sort((a, b) => (a.ok === b.ok ? (a.duration || 1e12) - (b.duration || 1e12) : a.ok ? -1 : 1));
    const top = out.slice(0, k || 3);
    return { ok: top.length > 0, results: top.map((o, i) => (i === 0 ? o : Object.assign({}, o, { route: undefined }))) };
  }
}

return { MapService, haversine, parseGraphBin, parseTileIndex, readTileIndex, tileKey, tileKeyParts };
}));
