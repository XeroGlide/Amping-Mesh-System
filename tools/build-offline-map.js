'use strict';
/*
  Step 2 of the offline-map build: turn OpenStreetMap data into the Pi's offline map
     map/tiles.pack + map/tiles.idx.bin    vector map tiles (roads, buildings, water, land, places, POIs)
     map/graph.bin  + map/graph.meta.json  road network for offline turn-by-turn routing
     map/search.json                       offline place / street / POI search index
     map/meta.json                         area, zoom levels, statistics
  Two sources:
     node tools/build-offline-map.js
         the Overpass download in tools/cache (tools/fetch-osm.js) - the original Butuan workflow
     node --max-old-space-size=12000 tools/build-offline-map.js --pbf ../map-build/philippines-latest.osm.pbf --area mindanao
         a Geofabrik extract cut to an area (tools/map-build/areas.js) - all of Mindanao, about 20-40 minutes,
         needs a PC with 16 GB of memory (the Pi only reads the result)
  Options: --out <dir> (default ../map, or MAP_OUT)   env MAP_CACHE = Overpass cache folder
  No internet needed for this step. Data (c) OpenStreetMap contributors, ODbL.
*/
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { fromPbf, fromCache, HW_CLASS } = require('./map-build/dataset.js');
const { areaOf } = require('./map-build/areas.js');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PBF = arg('pbf', null);
const CACHE = process.env.MAP_CACHE || path.join(__dirname, 'cache');
const OUT = path.resolve(arg('out', process.env.MAP_OUT || path.join(__dirname, '..', 'map')));
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const secs = () => ((Date.now() - T0) / 1000).toFixed(0) + 's';

const ds = PBF ? fromPbf(PBF, areaOf(arg('area', 'mindanao'))) : fromCache(CACHE);
const BBOX = ds.bbox;
const inBox = ds.inBox;

const TILE = 256, EXT = 4096, K = EXT / TILE, BUF = 4;            // BUF = clip buffer in pixels
// an area map (all of Mindanao) also gets zooms 6-7, so the whole island fits a phone screen
const GROUPS = { b: { min: ds.area && ds.area.poly ? 6 : 8, max: 14 }, d: { min: 10, max: 17 } };
const CHZ = 9;                                                      // tiles are cut one zoom-9 square (~78 km) at a time

// ------------------------------------------------------------------ helpers
function worldPx(lon, lat, z) {
  const n = TILE * Math.pow(2, z);
  const s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function dp(points, tol) {           // Douglas-Peucker (iterative)
  const n = points.length; if (n <= 2) return points;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let maxD = 0, idx = -1;
    const [ax, ay] = points[a], [bx, by] = points[b]; const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]; let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else { let t = ((px - ax) * dx + (py - ay) * dy) / len2; t = Math.max(0, Math.min(1, t)); d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}
// Liang-Barsky segment clip to rect; returns [x0,y0,x1,y1] or null
function clipSeg(x0, y0, x1, y1, xmin, ymin, xmax, ymax) {
  let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy], q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }
    else { const r = q[i] / p[i]; if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}
function clipPoly(pts, xmin, ymin, xmax, ymax) {     // Sutherland-Hodgman
  let out = pts;
  const edges = [
    [(p) => p[0] >= xmin, (a, b) => { const t = (xmin - a[0]) / (b[0] - a[0]); return [xmin, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= xmax, (a, b) => { const t = (xmax - a[0]) / (b[0] - a[0]); return [xmax, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= ymin, (a, b) => { const t = (ymin - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), ymin]; }],
    [(p) => p[1] <= ymax, (a, b) => { const t = (ymax - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), ymax]; }]
  ];
  for (const [inside, inter] of edges) {
    const inp = out; out = [];
    if (!inp.length) break;
    let prev = inp[inp.length - 1];
    for (const cur of inp) {
      if (inside(cur)) { if (!inside(prev)) out.push(inter(prev, cur)); out.push(cur); }
      else if (inside(prev)) out.push(inter(prev, cur));
      prev = cur;
    }
  }
  return out;
}
function encodeDelta(local) {        // [[x,y],...] -> flat delta ints
  const out = []; let px = 0, py = 0;
  for (let i = 0; i < local.length; i++) {
    const x = Math.round(local[i][0]), y = Math.round(local[i][1]);
    out.push(i === 0 ? x : x - px, i === 0 ? y : y - py); px = x; py = y;
  }
  return out;
}
const polyArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); };
const nTiles = (z) => Math.pow(2, z);
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };

// ------------------------------------------------------------------ tile store (one chunk at a time) + pack writer
let tiles = new Map();     // 'g/z/x/y' -> tile object
let CUR = null;            // current chunk {cx, cy} at zoom CHZ, or null = no limit (the zoom-8 pass)
function rng(z) {          // tile range allowed now at zoom z: [x0, x1, y0, y1]
  if (!CUR || z < CHZ) return [0, nTiles(z) - 1, 0, nTiles(z) - 1];
  const s = 1 << (z - CHZ); return [CUR.cx * s, CUR.cx * s + s - 1, CUR.cy * s, CUR.cy * s + s - 1];
}
function tileOf(g, z, x, y) {
  const key = g + '/' + z + '/' + x + '/' + y;
  let t = tiles.get(key);
  if (!t) { t = { r: [], a: [], w: [], p: [], b: [], s: [], _s: new Map() }; tiles.set(key, t); }
  return t;
}
function strIdx(t, str) {
  if (!str) return -1;
  let i = t._s.get(str); if (i === undefined) { i = t.s.length; t.s.push(str); t._s.set(str, i); }
  return i;
}
const packFd = fs.openSync(path.join(OUT, 'tiles.pack.tmp'), 'w');
let packOff = 0;
const idxKey = [], idxOff = [], idxLen = [];
const keyNum = (g, z, x, y) => ((g === 'd' ? 1 : 0) * 32 + z) * 17179869184 + x * 131072 + y;      // 2^34, 2^17
let nT = 0, rawBytes = 0;
function flushTiles() {
  for (const [key, t] of tiles) {
    const obj = {};
    for (const k of ['r', 'a', 'w', 'p', 'b']) if (t[k].length) obj[k] = t[k];
    if (t.s.length) obj.s = t.s;
    if (!Object.keys(obj).length) continue;
    const raw = Buffer.from(JSON.stringify(obj)); rawBytes += raw.length;
    const gz = zlib.gzipSync(raw, { level: 9 });
    const [g, z, x, y] = key.split('/');
    fs.writeSync(packFd, gz); idxKey.push(keyNum(g, +z, +x, +y)); idxOff.push(packOff); idxLen.push(gz.length); packOff += gz.length; nT++;
  }
  tiles = new Map();
}

// add a polyline feature (world px at zoom z) to group/zoom tiles.  list = 'r' | 'w' | 'b'; head = leading fields
function addLine(g, z, pts, list, head, nameStr, tol) {
  pts = dp(pts, tol);
  if (pts.length < 2) return;
  const [rx0, rx1, ry0, ry1] = rng(z);
  const runs = new Map();     // tile key -> current run
  const finish = (tx, ty, run) => {
    if (run.length < 2) return;
    const t = tileOf(g, z, tx, ty);
    const local = run.map(([x, y]) => [(x - tx * TILE) * K, (y - ty * TILE) * K]);
    const entry = head.slice();
    if (nameStr !== undefined) entry.push(strIdx(t, nameStr));
    entry.push(encodeDelta(local));
    t[list].push(entry);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const tx0 = Math.max(rx0, Math.floor((Math.min(ax, bx) - BUF) / TILE)), tx1 = Math.min(rx1, Math.floor((Math.max(ax, bx) + BUF) / TILE));
    const ty0 = Math.max(ry0, Math.floor((Math.min(ay, by) - BUF) / TILE)), ty1 = Math.min(ry1, Math.floor((Math.max(ay, by) + BUF) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const c = clipSeg(ax, ay, bx, by, tx * TILE - BUF, ty * TILE - BUF, (tx + 1) * TILE + BUF, (ty + 1) * TILE + BUF);
      const key = tx + ',' + ty;
      if (!c) { const r = runs.get(key); if (r) { finish(tx, ty, r); runs.delete(key); } continue; }
      let r = runs.get(key);
      if (r && Math.abs(r[r.length - 1][0] - c[0]) < 1e-6 && Math.abs(r[r.length - 1][1] - c[1]) < 1e-6) r.push([c[2], c[3]]);
      else { if (r) finish(tx, ty, r); r = [[c[0], c[1]], [c[2], c[3]]]; runs.set(key, r); }
    }
  }
  for (const [key, r] of runs) { const [tx, ty] = key.split(',').map(Number); finish(tx, ty, r); }
}
// add a polygon (single ring, world px at zoom z) to tiles
function addPoly(g, z, pts, head, tol, minAreaPx) {
  if (pts.length > 3) pts = dp(pts, tol);
  if (pts.length < 3) return;
  if (minAreaPx && polyArea(pts) < minAreaPx) return;
  const [rx0, rx1, ry0, ry1] = rng(z);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  const tx0 = Math.max(rx0, Math.floor((minx - BUF) / TILE)), tx1 = Math.min(rx1, Math.floor((maxx + BUF) / TILE));
  const ty0 = Math.max(ry0, Math.floor((miny - BUF) / TILE)), ty1 = Math.min(ry1, Math.floor((maxy + BUF) / TILE));
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const xmin = tx * TILE - BUF, ymin = ty * TILE - BUF, xmax = (tx + 1) * TILE + BUF, ymax = (ty + 1) * TILE + BUF;
    let poly = pts;
    if (!(minx >= xmin && maxx <= xmax && miny >= ymin && maxy <= ymax)) { poly = clipPoly(pts, xmin, ymin, xmax, ymax); if (poly.length < 3) continue; }
    const local = poly.map(([x, y]) => [(x - tx * TILE) * K, (y - ty * TILE) * K]);
    tileOf(g, z, tx, ty).a.push(head.concat([encodeDelta(local)]));
  }
}
function addPoint(g, z, lon, lat, list, head, nameStr) {
  const [x, y] = worldPx(lon, lat, z); const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const [rx0, rx1, ry0, ry1] = rng(z);
  if (tx < rx0 || ty < ry0 || tx > rx1 || ty > ry1) return;
  const t = tileOf(g, z, tx, ty);
  t[list].push(head.concat([Math.round((x - tx * TILE) * K), Math.round((y - ty * TILE) * K), strIdx(t, nameStr)]));
}
const ptsOf = (geo, i, z) => { const out = []; for (let k = geo.OFF[i]; k < geo.OFF[i + 1]; k++) out.push(worldPx(geo.LON[k] / 1e7, geo.LAT[k] / 1e7, z)); return out; };

// ------------------------------------------------------------------ 1. roads: profile + routing graph
const CLS_MINZ = [10, 10, 10, 11, 12, 13, 15, 14, 16];
const no = (v) => v === 'no' || v === 'private' || v === 'false';
const yes = (v) => v === 'yes' || v === 'designated' || v === 'permissive' || v === 'true';
function wayProfile(tags) {
  const hw = tags.highway; const cls = HW_CLASS[hw];
  let car = cls <= 7 && hw !== 'pedestrian' && hw !== 'footway' && hw !== 'cycleway' && hw !== 'path' && hw !== 'steps';
  let privatePenalty = 0;
  const acc = tags.access, mv = tags.motor_vehicle, veh = tags.vehicle;
  if (car) {
    if (acc === 'no' || acc === 'private' || mv === 'no' || mv === 'private' || veh === 'no' || veh === 'private' || mv === 'agricultural' || mv === 'forestry') {
      if (yes(mv) || yes(veh)) { /* explicit allow */ } else if ((acc === 'private' || mv === 'private') && cls >= 5) { privatePenalty = 1; } else car = false;
    }
  }
  let foot = (hw !== 'motorway' && hw !== 'motorway_link') || yes(tags.foot);      // national highways (trunk) are walkable in the Philippines; expressways are not
  if (no(tags.foot) || ((acc === 'no' || acc === 'private') && !yes(tags.foot))) foot = false;
  let bike = cls <= 7 && hw !== 'motorway' && hw !== 'motorway_link' && hw !== 'steps' && hw !== 'pedestrian';
  if (hw === 'footway' || hw === 'path' || hw === 'pedestrian') bike = yes(tags.bicycle);
  if (hw === 'cycleway' || hw === 'bridleway') bike = hw === 'cycleway';
  if (no(tags.bicycle) || ((acc === 'no' || acc === 'private') && !yes(tags.bicycle))) bike = false;
  if (hw === 'cycleway') { car = false; foot = !no(tags.foot); }
  // oneway (car); bikes may go both ways if oneway:bicycle=no
  let ow = 0; const o = tags.oneway;
  if (o === 'yes' || o === 'true' || o === '1') ow = 1; else if (o === '-1' || o === 'reverse') ow = 2;
  else if (tags.junction === 'roundabout' || tags.junction === 'circular') ow = 1;
  else if ((hw === 'motorway' || hw === 'motorway_link') && o !== 'no') ow = 1;
  let owBike = ow; if (tags['oneway:bicycle'] === 'no' || tags.cycleway === 'opposite' || tags['cycleway:both'] === 'no') owBike = 0;
  let speed = 0; if (tags.maxspeed) { const m = String(tags.maxspeed).match(/^(\d+)/); if (m) speed = +m[1]; if (/mph/.test(tags.maxspeed)) speed = Math.round(speed * 1.609); }
  const unpaved = /^(unpaved|dirt|gravel|ground|mud|sand|earth|grass|fine_gravel|compacted|dirt\/sand)$/.test(tags.surface || '') || (hw === 'track' && !tags.surface);
  return { cls, car, foot, bike, privatePenalty, ow, owBike, speed, unpaved, round: tags.junction === 'roundabout' ? 1 : 0, bridge: tags.bridge && tags.bridge !== 'no' ? 1 : 0, tunnel: tags.tunnel && tags.tunnel !== 'no' ? 1 : 0, steps: hw === 'steps' ? 1 : 0 };
}
const R = ds.roads;
console.log(R.n + ' road pieces (' + secs() + ')');

const names = [], nameIdx = new Map();
const nm = (s) => { if (!s) return -1; let i = nameIdx.get(s); if (i === undefined) { i = names.length; names.push(s); nameIdx.set(s, i); } return i; };

// ---- routing graph. Shape points that only bend the road are thinned (Douglas-Peucker, 1 m) so all of Mindanao
// fits the Pi's memory; every junction, way end and turn-restriction node stays, and no segment is longer than 120 m.
console.log('building routing graph ...');
const SIMPL_TOL = 1.0, MAX_SEG = 120;
const viaIds = new Set();
for (const r of ds.restrictions) for (const m of (r.members || [])) if (m.role === 'via' && m.type === 'node') viaIds.add(m.ref);
const graphWay = new Int8Array(R.n);                       // 1 = this piece is part of the routing graph
const profiles = new Array(R.n);
for (let i = 0; i < R.n; i++) {
  const t = R.tags[i]; if (t.area === 'yes') continue;
  const p = wayProfile(t); profiles[i] = p;
  if (p.car || p.foot || p.bike || p.privatePenalty) graphWay[i] = 1;
}
const useCount = new Map();                                // node id -> uses (way ends count twice)
for (let i = 0; i < R.n; i++) {
  if (!graphWay[i]) continue;
  const a = R.OFF[i], b = R.OFF[i + 1];
  for (let k = a; k < b; k++) { const id = R.IDS[k]; useCount.set(id, (useCount.get(id) || 0) + (k === a || k === b - 1 ? 2 : 1)); }
}
const nodeIndex = new Map(); const nodeLat = [], nodeLon = [];
const idxOf = (k) => { const id = R.IDS[k]; let i = nodeIndex.get(id); if (i === undefined) { i = nodeLon.length; nodeIndex.set(id, i); nodeLon.push(R.LON[k] / 1e7); nodeLat.push(R.LAT[k] / 1e7); } return i; };
const wayMeta = { cls: [], flags: [], speed: [], name: [], ref: [] };
const eFrom = [], eTo = [], eLen = [], eWay = [], eMask = [];
let wayCount = 0, pointsIn = 0; const osmWay = new Map();
function keepPoints(a, b) {                               // indexes k in [a, b) to keep as graph nodes
  const must = [];
  for (let k = a; k < b; k++) { const id = R.IDS[k]; if (k === a || k === b - 1 || useCount.get(id) > 1 || viaIds.has(id)) must.push(k); }
  const keep = new Set(must);
  const cosl = Math.cos(R.LAT[a] / 1e7 * Math.PI / 180);
  const X = (k) => R.LON[k] / 1e7 * 111320 * cosl, Y = (k) => R.LAT[k] / 1e7 * 111320;
  for (let m = 0; m < must.length - 1; m++) {
    const stack = [[must[m], must[m + 1]]];
    while (stack.length) {
      const [s, e] = stack.pop(); if (e - s < 2) continue;
      const ax = X(s), ay = Y(s), dx = X(e) - ax, dy = Y(e) - ay, l2 = dx * dx + dy * dy;
      let md = -1, mi = -1;
      for (let k = s + 1; k < e; k++) {
        const px = X(k) - ax, py = Y(k) - ay; let t = l2 > 0 ? (px * dx + py * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - t * dx, py - t * dy); if (d > md) { md = d; mi = k; }
      }
      if (md > SIMPL_TOL || Math.sqrt(l2) > MAX_SEG) { if (md <= SIMPL_TOL) mi = (s + e) >> 1; keep.add(mi); stack.push([s, mi], [mi, e]); }
    }
  }
  return [...keep].sort((x, y) => x - y);
}
for (let i = 0; i < R.n; i++) {
  if (!graphWay[i]) continue;
  const t = R.tags[i], p = profiles[i];
  const a = R.OFF[i], b = R.OFF[i + 1]; if (b - a < 2) continue;
  const wi = wayCount++; osmWay.set(R.osm[i], wi);
  wayMeta.cls.push(p.cls);
  wayMeta.flags.push((p.round ? 1 : 0) | (p.unpaved ? 2 : 0) | (p.privatePenalty ? 4 : 0) | (p.bridge ? 8 : 0) | (p.steps ? 16 : 0) | (p.tunnel ? 32 : 0));
  wayMeta.speed.push(p.speed);
  wayMeta.name.push(nm(t.name)); wayMeta.ref.push(nm(t.ref));
  const carAny = p.car || p.privatePenalty;
  const fwd = (carAny && p.ow !== 2 ? 1 : 0) | (p.bike && p.owBike !== 2 ? 2 : 0) | (p.foot ? 4 : 0);
  const rev = (carAny && p.ow !== 1 ? 1 : 0) | (p.bike && p.owBike !== 1 ? 2 : 0) | (p.foot ? 4 : 0);
  pointsIn += b - a;
  const kept = keepPoints(a, b);
  for (let j = 0; j < kept.length - 1; j++) {
    const k0 = kept[j], k1 = kept[j + 1];
    if (R.IDS[k0] === R.IDS[k1]) continue;
    let len = 0; for (let k = k0; k < k1; k++) len += haversine(R.LAT[k] / 1e7, R.LON[k] / 1e7, R.LAT[k + 1] / 1e7, R.LON[k + 1] / 1e7);
    const u = idxOf(k0), v = idxOf(k1);
    if (fwd) { eFrom.push(u); eTo.push(v); eLen.push(len); eWay.push(wi); eMask.push(fwd); }
    if (rev) { eFrom.push(v); eTo.push(u); eLen.push(len); eWay.push(wi); eMask.push(rev); }
  }
}
const NN = nodeLon.length, NE = eFrom.length;
const order = new Uint32Array(NE); for (let i = 0; i < NE; i++) order[i] = i;
order.sort((a, b) => eFrom[a] - eFrom[b] || a - b);
const adj = new Uint32Array(NN + 1);
for (let i = 0; i < NE; i++) adj[eFrom[i] + 1]++;
for (let i = 0; i < NN; i++) adj[i + 1] += adj[i];
const gTo = new Uint32Array(NE), gLen = new Float32Array(NE), gWay = new Uint32Array(NE), gMask = new Uint8Array(NE);
for (let k = 0; k < NE; k++) { const i = order[k]; gTo[k] = eTo[i]; gLen[k] = eLen[i]; gWay[k] = eWay[i]; gMask[k] = eMask[i]; }
const gLat = new Int32Array(NN), gLon = new Int32Array(NN);
for (let i = 0; i < NN; i++) { gLat[i] = Math.round(nodeLat[i] * 1e7); gLon[i] = Math.round(nodeLon[i] * 1e7); }

function packArrays(list) {
  const header = []; let off = 0; const bufs = [];
  for (const [name, arr] of list) {
    const pad = (8 - (off % 8)) % 8; if (pad) { bufs.push(Buffer.alloc(pad)); off += pad; }
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    header.push({ name, type: arr.constructor.name, offset: off, length: arr.length }); bufs.push(b); off += b.length;
  }
  const hj = Buffer.from(JSON.stringify(header)); const hdrLen = Buffer.alloc(8); hdrLen.writeUInt32LE(hj.length, 0);
  const pad = (8 - ((8 + hj.length) % 8)) % 8;
  return Buffer.concat([hdrLen, hj, Buffer.alloc(pad), ...bufs]);
}
fs.writeFileSync(path.join(OUT, 'graph.bin'), packArrays([['lat', gLat], ['lon', gLon], ['adj', adj], ['to', gTo], ['len', gLen], ['way', gWay], ['mask', gMask]]));
console.log('  graph: ' + NN + ' nodes (from ' + pointsIn + ' road points), ' + NE + ' directed edges, ' + wayCount + ' ways (' + secs() + ')');
eFrom.length = eTo.length = eLen.length = eWay.length = eMask.length = 0;

// turn restrictions (no_left_turn, only_straight_on, no_u_turn ...) - from way, via node, to way
const restr = []; let nRestrSkipped = 0;
for (const r of ds.restrictions) {
  if (r.type !== 'relation' || !r.tags || !r.tags.restriction || !r.members) continue;
  const kind = /^no_/.test(r.tags.restriction) ? 0 : /^only_/.test(r.tags.restriction) ? 1 : -1; if (kind < 0) continue;
  if (/motorcar|motor_vehicle/.test(r.tags.except || '')) { nRestrSkipped++; continue; }
  const from = r.members.find(m => m.role === 'from' && m.type === 'way'), to = r.members.find(m => m.role === 'to' && m.type === 'way'), via = r.members.find(m => m.role === 'via' && m.type === 'node');
  if (!from || !to || !via) { nRestrSkipped++; continue; }
  const f = osmWay.get(from.ref), t = osmWay.get(to.ref), v = nodeIndex.get(via.ref);
  if (f === undefined || t === undefined || v === undefined) { nRestrSkipped++; continue; }
  restr.push([f, v, t, kind]);
}
console.log('  turn restrictions: ' + restr.length + ' applied' + (nRestrSkipped ? ', ' + nRestrSkipped + ' skipped (via-way / exempt / outside)' : ''));
fs.writeFileSync(path.join(OUT, 'graph.meta.json'), JSON.stringify({ cls: wayMeta.cls, flags: wayMeta.flags, speed: wayMeta.speed, name: wayMeta.name, ref: wayMeta.ref, names, restr }));
nodeIndex.clear(); useCount.clear();

// ------------------------------------------------------------------ 2. POIs, places, search index
const POI_TYPE = { hospital: 1, clinic: 2, doctors: 2, pharmacy: 3, police: 4, fire_station: 5, school: 6, kindergarten: 6, college: 7, university: 7, townhall: 8, courthouse: 8, shelter: 9, community_centre: 9, place_of_worship: 10, marketplace: 11, fuel: 12, bank: 13 };
const POI_MINZ = { 1: 11, 2: 14, 3: 15, 4: 12, 5: 12, 6: 14, 7: 13, 8: 13, 9: 14, 10: 15, 11: 15, 12: 15, 13: 16, 14: 12, 15: 15, 16: 13, 17: 15 };
const PLACE_TYPE = { city: 1, town: 2, village: 3, suburb: 4, neighbourhood: 5, hamlet: 6, locality: 7, island: 8 };
const PLACE_MINZ = { 1: 7, 2: 9, 3: 11, 4: 11, 5: 13, 6: 13, 7: 14, 8: 10 };
const search = [];        // [name, kind, subtype, lat, lon]
const points = [];        // [group, minZ, maxZ, lon, lat, head, name]
const seenPoi = new Set();
let nPoi = 0, nPlace = 0;
for (const e of ds.pois) {
  const t = e.tags || {}; const lat = e.lat, lon = e.lon;
  if (lat === undefined || !inBox(lat, lon)) continue;
  const name = t.name || t['name:en'] || t.official_name || '';
  if (t.place && PLACE_TYPE[t.place]) {
    if (!name) continue; const pt = PLACE_TYPE[t.place];
    points.push(['b', Math.max(GROUPS.b.min, PLACE_MINZ[pt]), 14, lon, lat, [pt], name]);
    search.push([name, 'place', pt, +lat.toFixed(6), +lon.toFixed(6)]); nPlace++; continue;
  }
  let pt = POI_TYPE[t.amenity];
  if (!pt && t.healthcare) pt = 2;
  if (!pt && t.emergency && !/^(fire_hydrant|defibrillator|phone|water_tank|siren|assembly_point)$/.test(t.emergency)) pt = 16;
  if (t.emergency === 'assembly_point') pt = 9;
  if (!pt && (t.aeroway === 'aerodrome' || t.aeroway === 'helipad')) pt = 14;
  if (!pt && t.highway === 'bus_station') pt = 17;
  if (!pt && (t.tourism === 'hotel' || t.tourism === 'museum' || t.tourism === 'attraction')) pt = 15;
  if (!pt && (t.man_made === 'lighthouse' || t.man_made === 'water_tower')) pt = 15;
  if (!pt) continue;
  if (!name && ![1, 4, 5, 14].includes(pt)) continue;
  const key = pt + '|' + name + '|' + lat.toFixed(4) + '|' + lon.toFixed(4); if (seenPoi.has(key)) continue; seenPoi.add(key);
  points.push(['d', Math.max(GROUPS.d.min, POI_MINZ[pt]), GROUPS.d.max, lon, lat, [pt], name]);
  if (name) search.push([name, 'poi', pt, +lat.toFixed(6), +lon.toFixed(6)]);
  nPoi++;
}
for (const l of ds.labels) {
  if (l.level >= 10) points.push(['b', 13, 14, l.lon, l.lat, [9], l.name]);
  search.push([l.name, l.level >= 10 ? 'barangay' : 'place', l.level >= 10 ? 4 : 2, +l.lat.toFixed(6), +l.lon.toFixed(6)]);
}
console.log('  ' + nPoi + ' POIs, ' + nPlace + ' named places, ' + ds.labels.length + ' boundary names');
// street names: one entry per name per ~5 km (a "Rizal Street" in every town stays findable)
const byName = new Map();
for (let i = 0; i < R.n; i++) {
  const t = R.tags[i]; if (!t.name || HW_CLASS[t.highway] > 6) continue;
  const a = R.OFF[i], b = R.OFF[i + 1]; if (b - a < 2) continue;
  const mid = a + ((b - a) >> 1); const mlat = R.LAT[mid] / 1e7, mlon = R.LON[mid] / 1e7;
  if (!inBox(mlat, mlon)) continue;
  const key = t.name + '|' + Math.floor(mlat / 0.05) + ',' + Math.floor(mlon / 0.05);
  const prev = byName.get(key);
  if (!prev || b - a > prev.n) byName.set(key, { name: t.name, n: b - a, lat: mlat, lon: mlon, cls: HW_CLASS[t.highway] });
}
for (const v of byName.values()) search.push([v.name, 'road', v.cls, +v.lat.toFixed(6), +v.lon.toFixed(6)]);
fs.writeFileSync(path.join(OUT, 'search.json'), JSON.stringify(search));
console.log('  search index: ' + search.length + ' entries (' + byName.size + ' streets) (' + secs() + ')');

// ------------------------------------------------------------------ 3. land from the coastline (the sea gets its colour)
// Closed coastline rings = land. Only when the area is a polygon drawn through the sea (a PBF area), never for the
// Overpass box (it cuts the coast open). The client paints the area blue, then land on top (meta.land = true).
let landRings = [];
if (ds.area && ds.area.poly) {
  const coast = []; for (let i = 0; i < ds.lines.n; i++) if (ds.lines.CODE[i] === 3) coast.push(ds.lines.ll(i));
  const { assembleRingsFast } = require('./map-build/rings.js');
  const res = assembleRingsFast(coast);
  landRings = res.rings;
  const km2 = (ring) => { let a = 0; const c = Math.cos(ring[0][1] * Math.PI / 180); for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * c + ring[i][0] * c) * (ring[j][1] - ring[i][1]); return Math.abs(a / 2) * 111.32 * 111.32; };
  const areas = landRings.map(km2).sort((a, b) => b - a);
  console.log('  coastline: ' + coast.length + ' lines -> ' + landRings.length + ' land rings (largest ' + Math.round(areas[0] || 0) + ' km2), ' + res.open + ' pieces left open');
  if (!areas.length || areas[0] < 1000) { console.log('  (no large closed coastline - the sea will not be coloured)'); landRings = []; }
}

// ------------------------------------------------------------------ 4. features per chunk
const MARG = 0.012;                                 // degrees: the clip buffer at zoom 9
const chunks = new Map();                           // cx*4096+cy -> { r, bd, ln, po, bl, pt, lr }
const bucket = (cx, cy) => { const k = cx * 4096 + cy; let c = chunks.get(k); if (!c) { c = { cx, cy, r: [], bd: [], ln: [], po: [], bl: [], pt: [], lr: [] }; chunks.set(k, c); } return c; };
function bucketGeo(geo, list, filter) {
  for (let i = 0; i < geo.n; i++) {
    if (filter && !filter(i)) continue;
    const a = geo.OFF[i], b = geo.OFF[i + 1]; if (b - a < 2) continue;
    let S = 1e10, N = -1e10, W = 1e10, E = -1e10;
    for (let k = a; k < b; k++) { const la = geo.LAT[k], lo = geo.LON[k]; if (la < S) S = la; if (la > N) N = la; if (lo < W) W = lo; if (lo > E) E = lo; }
    const x0 = lon2x(W / 1e7 - MARG, CHZ), x1 = lon2x(E / 1e7 + MARG, CHZ), y0 = lat2y(N / 1e7 + MARG, CHZ), y1 = lat2y(S / 1e7 - MARG, CHZ);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) bucket(x, y)[list].push(i);
  }
}
bucketGeo(R, 'r', (i) => R.tags[i].area !== 'yes');
bucketGeo(ds.buildings, 'bd');
bucketGeo(ds.lines, 'ln');
bucketGeo(ds.polys, 'po');
bucketGeo(ds.blines, 'bl', (i) => true);
points.forEach((p, i) => bucket(lon2x(p[3], CHZ), lat2y(p[4], CHZ)).pt.push(i));
landRings.forEach((ring, i) => {
  let S = 90, N = -90, W = 180, E = -180; for (const [lo, la] of ring) { if (la < S) S = la; if (la > N) N = la; if (lo < W) W = lo; if (lo > E) E = lo; }
  for (let x = lon2x(W - MARG, CHZ); x <= lon2x(E + MARG, CHZ); x++) for (let y = lat2y(N + MARG, CHZ); y <= lat2y(S - MARG, CHZ); y++) bucket(x, y).lr.push(i);
});
console.log('  ' + chunks.size + ' map squares to cut (' + secs() + ')');

const roadTol = { 10: 0.7, 11: 0.6, 12: 0.5, 13: 0.5, 14: 0.4, 15: 0.35, 16: 0.3, 17: 0.25 };
const WT = ds.lines.CODE;
function cutLand(ring, zFrom, zTo) {                // land polygons by quadtree clipping (rings can have 100 000s of points)
  const Z = 14, base = ring.map(([lo, la]) => worldPx(lo, la, Z));
  const emit = (z, x, y, poly) => {
    const f = Math.pow(2, Z - z), tol = 0.6 * f;
    let p = poly.length > 8 ? dp(poly, tol) : poly; if (p.length < 3) return;
    const local = p.map(([px, py]) => [(px / f - x * TILE) * K, (py / f - y * TILE) * K]);
    tileOf('b', z, x, y).a.push([30, encodeDelta(local)]);
  };
  const clipTo = (poly, z, x, y) => { const f = Math.pow(2, Z - z), b = BUF * f; return clipPoly(poly, x * TILE * f - b, y * TILE * f - b, (x + 1) * TILE * f + b, (y + 1) * TILE * f + b); };
  const rec = (z, x, y, poly) => {
    emit(z, x, y, poly);
    if (z >= zTo) return;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const c = clipTo(poly, z + 1, 2 * x + dx, 2 * y + dy); if (c.length >= 3) rec(z + 1, 2 * x + dx, 2 * y + dy, c); }
  };
  const [rx0, rx1, ry0, ry1] = rng(zFrom);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [px, py] of base) { if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
  const f = Math.pow(2, Z - zFrom);
  for (let y = Math.max(ry0, Math.floor((miny / f - BUF) / TILE)); y <= Math.min(ry1, Math.floor((maxy / f + BUF) / TILE)); y++)
    for (let x = Math.max(rx0, Math.floor((minx / f - BUF) / TILE)); x <= Math.min(rx1, Math.floor((maxx / f + BUF) / TILE)); x++) {
      const c = clipTo(base, zFrom, x, y); if (c.length >= 3) { if (zFrom === zTo) emit(zFrom, x, y, c); else rec(zFrom, x, y, c); }
    }
}
// everything that goes into tiles, for one chunk (or the first pass: zooms up to 8, all features)
function cut(c, zlo, zhi) {
  const zr = (a, b) => { const out = []; for (let z = Math.max(a, zlo); z <= Math.min(b, zhi); z++) out.push(z); return out; };
  const each = (list, n, fn) => { if (list) for (const i of list) fn(i); else for (let i = 0; i < n; i++) fn(i); };
  // roads
  each(c && c.r, R.n, (i) => {
    const t = R.tags[i]; if (t.area === 'yes') return; const cls = HW_CLASS[t.highway];
    const p = profiles[i] || wayProfile(t);
    const flags = (p.ow === 1 || p.ow === 2 ? 1 : 0) | (t.bridge && t.bridge !== 'no' ? 2 : 0) | (t.tunnel && t.tunnel !== 'no' ? 4 : 0);
    const nameStr = t.name || (cls <= 2 ? t.ref : undefined) || '';
    for (const z of zr(Math.max(GROUPS.d.min, CLS_MINZ[cls]), GROUPS.d.max)) addLine('d', z, ptsOf(R, i, z), 'r', [cls, flags], z >= 14 ? nameStr : '', roadTol[z]);
  });
  // buildings
  each(c && c.bd, ds.buildings.n, (i) => { for (const z of zr(16, 17)) addPoly('d', z, ptsOf(ds.buildings, i, z), [20], z === 16 ? 0.35 : 0.2, z === 16 ? 3 : 1.5); });
  // coastline / waterways
  each(c && c.ln, ds.lines.n, (i) => {
    const wt = WT[i];
    // coast at every zoom; rivers from 9, canals from 11, streams / drains from 13 (zoomed out stays readable)
    for (const z of zr(GROUPS.b.min, 14)) if (wt === 3 || (wt === 0 && z >= 9) || (wt === 1 && z >= 11) || z >= 13) addLine('b', z, ptsOf(ds.lines, i, z), 'w', [wt], undefined, 0.6);
    for (const z of zr(15, 17)) addLine('d', z, ptsOf(ds.lines, i, z), 'w', [wt], undefined, 0.3);
  });
  // water / wetland / land-use areas
  each(c && c.po, ds.polys.n, (i) => {
    const code = ds.polys.CODE[i];
    const head = code >= 100 ? [code - 100] : [code], tol = code === 10 ? 0.6 : 0.8, minA = code === 10 ? 1.5 : 2;
    for (const z of zr(GROUPS.b.min, 14)) addPoly('b', z, ptsOf(ds.polys, i, z), head, tol, minA);
  });
  // land (from the coastline)
  each(c && c.lr, landRings.length, (i) => { if (zlo <= 14) cutLand(landRings[i], zlo, Math.min(14, zhi)); });
  // boundaries
  // boundaries: cities / municipalities from zoom 9, level 8-9 from 10, barangays from 12
  each(c && c.bl, ds.blines.n, (i) => { const lt = ds.blines.CODE[i]; for (const z of zr(GROUPS.b.min, 14)) if (z >= (lt === 2 ? 9 : lt === 1 ? 10 : 12)) addLine('b', z, ptsOf(ds.blines, i, z), 'b', [lt], undefined, 0.8); });
  // points
  each(c && c.pt, points.length, (i) => { const p = points[i]; for (const z of zr(p[1], p[2])) addPoint(p[0], z, p[3], p[4], 'p', p[5], p[6]); });
}

console.log('cutting tiles ...');
CUR = null; cut(null, GROUPS.b.min, 8); flushTiles();
let done = 0;
const keys = [...chunks.keys()].sort((a, b) => a - b);
for (const k of keys) {
  const c = chunks.get(k); CUR = { cx: c.cx, cy: c.cy };
  cut(c, CHZ, 17); flushTiles(); chunks.delete(k);
  done++; if (process.stdout.isTTY || done % 5 === 0 || done === keys.length) process.stdout.write('\r  ' + done + '/' + keys.length + ' squares, ' + nT + ' tiles, ' + (packOff / 1e6).toFixed(1) + ' MB  (' + secs() + ')   ');
}
process.stdout.write('\n');
fs.closeSync(packFd);

// ------------------------------------------------------------------ 5. tile index + meta
const perm = Array.from(idxKey.keys()).sort((a, b) => idxKey[a] - idxKey[b]);
const n = perm.length, head = Buffer.alloc(16); head.write('AMPTIDX1', 0, 'latin1'); head.writeUInt32LE(n, 8);
const kArr = new Float64Array(n), oArr = new Uint32Array(n), lArr = new Uint32Array(n);
perm.forEach((p, i) => { kArr[i] = idxKey[p]; oArr[i] = idxOff[p]; lArr[i] = idxLen[p]; });
for (let i = 1; i < n; i++) if (kArr[i] === kArr[i - 1]) throw new Error('duplicate tile ' + kArr[i]);
fs.writeFileSync(path.join(OUT, 'tiles.idx.bin.tmp'), Buffer.concat([head, Buffer.from(kArr.buffer), Buffer.from(oArr.buffer), Buffer.from(lArr.buffer)]));
const meta = {
  ok: true, built: new Date().toISOString(), bbox: BBOX, groups: GROUPS, tileSize: TILE, extent: EXT,
  area: ds.area && ds.area.id !== 'cache' ? { id: ds.area.id, name: ds.area.name, poly: ds.area.poly, center: ds.area.center } : undefined,
  land: landRings.length > 0,
  counts: { tiles: nT, roadWays: wayCount, graphNodes: NN, graphEdges: NE, buildings: ds.buildings.n, pois: nPoi, places: nPlace, searchEntries: search.length },
  attribution: '© OpenStreetMap contributors (ODbL)'
};
fs.writeFileSync(path.join(OUT, 'meta.json.tmp'), JSON.stringify(meta));
// swap the new files in together (a program that has the old map open - the Pi server, a test - blocks this on Windows)
try { fs.renameSync(path.join(OUT, 'tiles.pack.tmp'), path.join(OUT, 'tiles.pack')); }
catch (e) { console.error('Cannot replace ' + path.join(OUT, 'tiles.pack') + ' (' + e.code + '): close the program that uses this map folder and run again.'); process.exit(3); }
fs.renameSync(path.join(OUT, 'tiles.idx.bin.tmp'), path.join(OUT, 'tiles.idx.bin'));
fs.renameSync(path.join(OUT, 'meta.json.tmp'), path.join(OUT, 'meta.json'));
try { fs.unlinkSync(path.join(OUT, 'tiles.idx.json')); } catch (e) { /* not there */ }   // the old index format
console.log('done: ' + nT + ' tiles (' + (rawBytes / 1e6).toFixed(0) + ' MB unpacked), pack ' + (packOff / 1e6).toFixed(1) + ' MB  (' + secs() + ')');
for (const f of fs.readdirSync(OUT)) console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2) + ' MB');
