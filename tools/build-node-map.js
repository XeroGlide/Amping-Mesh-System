'use strict';
/*
  Builds the map file for a Heltec field node (Heltec 2) - and the bigger map built into the AMPING Android
  app - from the Pi's offline map (map/). The phone keeps it and draws the map + routes with no internet, no Pi.

    node tools/build-node-map.js                       -> ../firmware/heltec2_field_node/node-map.amp
    node tools/build-node-map.js --out file.amp --bbox S,W,N,E --dmax 16 --ovb 10 --ovd 10 --ovcls 2 --limit 4.75e6

  What goes in (defaults = Heltec 2, about 4.5 MB of flash):
    * DETAIL area --bbox (Butuan City and surroundings 8.80,125.40 .. 9.06,125.72): every tile up to zoom --dmax
      (closer zooms are drawn from it), the full road network (+ a 3 km --margin) and every searchable name.
    * OVERVIEW of the whole map (all of Mindanao when the Pi map is the Mindanao map): coast, sea, rivers, towns,
      boundaries up to zoom --ovb, main roads up to zoom --ovd, and the main roads for routing (--ovcls: 0 motorway,
      1 trunk, 2 primary, 3 secondary, 4 tertiary), thinned to a point every few hundred metres; towns,
      barangays, hospitals, police and fire stations for search.
    --ovb 0 = no overview (only the detail area, the old behaviour).
  The result must fit the node's storage (4.9 MB with the partitions.csv shipped in the sketch).

  File layout (.amp, what you upload on the node's admin page):
    "AMPUP001" | u32 metaLength | meta JSON | gzip(piece 0) gzip(piece 1) ...
    (bundle cut into 512 KB pieces; meta.parts = [[offset, length], ...] inside the data after the meta)
  bundle:
    "AMPNMAP1" | u32 headerLength | u32 0 | header JSON | pad to 8 | sections (each 8-aligned)
    header = { meta, tiles: { "g/z/x/y": [offset, length] }, sec: { tiles, graph, gmeta, search: [offset, length] } }
    tiles  = raw tile JSON blobs, graph = graph.bin format, gmeta = graph.meta.json, search = search.json
*/
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { parseGraphBin, readTileIndex } = require('../map-service.js');
const { cutGraph, packGraph } = require('./map-build/graph-thin.js');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const MAP = path.resolve(arg('map', path.join(__dirname, '..', 'map')));
const OUT = path.resolve(arg('out', path.join(__dirname, '..', '..', 'firmware', 'heltec2_field_node', 'node-map.amp')));
const BBOX = arg('bbox', '8.80,125.40,9.06,125.72').split(',').map(Number);
const DMAX = Number(arg('dmax', 16));
const MARGIN = Number(arg('margin', 0.03));       // degrees of extra road network around the area (~3.3 km)
const LIMIT = Number(arg('limit', 4.75e6));         // refuse to write a file the node cannot store (LittleFS 4.9 MB, upload keeps 16 KB free)
const OVB = Number(arg('ovb', 10)), OVD = Number(arg('ovd', 10)), OVCLS = Number(arg('ovcls', 2));
const OV_TOL = Number(arg('ovtol', 10)), OV_SEG = Number(arg('ovseg', 2500));     // thinning of overview roads (metres)
if (BBOX.length !== 4 || BBOX.some(v => !Number.isFinite(v)) || BBOX[0] >= BBOX[2] || BBOX[1] >= BBOX[3]) { console.error('bad --bbox (want S,W,N,E)'); process.exit(1); }
const [S, W, N, E] = BBOX;
const inDetail = (la, lo, m) => la >= S - m && la <= N + m && lo >= W - m && lo <= E + m;

const meta0 = JSON.parse(fs.readFileSync(path.join(MAP, 'meta.json'), 'utf8'));
const OVERVIEW = OVB > 0 && !!meta0.area;          // an overview only makes sense when the Pi map is bigger than the detail area
const idx = readTileIndex(MAP);
const fd = fs.openSync(path.join(MAP, 'tiles.pack'), 'r');
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };

// overview tiles are slimmed: sea / land / lakes, coast + rivers, town names, main roads; simplified to ~1.5 px
const OV_LITE = arg('ovlite', '1') !== '0';
const OV_PX = 1.5 * 16;                               // tile units per screen pixel = extent 4096 / 256
function decodeFlat(f) { const out = []; let x = 0, y = 0; for (let i = 0; i < f.length; i += 2) { x += f[i]; y += f[i + 1]; out.push([x, y]); } return out; }
function encodeFlat(p) { const out = []; let px = 0, py = 0; p.forEach(([x, y], i) => { out.push(i ? x - px : x, i ? y - py : y); px = x; py = y; }); return out; }
function dpPx(pts, tol) {
  const n = pts.length; if (n <= 2) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1; const [ax, ay] = pts[a], [bx, by] = pts[b]; const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) { let t = l2 ? ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy); if (d > md) { md = d; mi = i; } }
    if (md > tol && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((p, i) => keep[i]);
}
function slim(raw, g, z) {
  const j = JSON.parse(raw); const o = {};
  const re = (list, keepType, minPts) => (list || []).filter(e => keepType(e)).map(e => { const p = dpPx(decodeFlat(e[e.length - 1]), OV_PX); return p.length >= minPts ? e.slice(0, -1).concat([encodeFlat(p)]) : null; }).filter(Boolean);
  if (g === 'b') {
    const a = re(j.a, e => e[0] === 30 || e[0] === 10, 3); if (a.length) o.a = a;
    // the land fill already draws the coast; rivers and town boundaries only from zoom 10
    const w = re(j.w, e => e[0] === 0 && z >= 10, 2); if (w.length) o.w = w;
    const b = re(j.b, e => e[0] === 2 && z >= 10, 2); if (b.length) o.b = b;
    if (j.p && j.p.length) { o.p = j.p.filter(p => p[0] <= 3 || p[0] === 8); }
  } else {
    const r = re(j.r, e => e[0] <= OVCLS, 2); if (r.length) o.r = r;
  }
  if (o.p && o.p.length && j.s) o.s = j.s; else delete o.p;
  return Object.keys(o).length ? Buffer.from(JSON.stringify(o)) : null;
}

// ---------------------------------------------------------------- tiles
const tileIdx = {}; const tileBufs = []; let tOff = 0, nTiles = 0, nOv = 0;
const entries = []; idx.forEach((k, off, len) => entries.push([k, off, len]));
entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
for (const [k, off, len] of entries) {
  const [g, zs, xs, ys] = k.split('/'); const z = +zs, x = +xs, y = +ys;
  const detail = !(g === 'd' && z > DMAX) && !(x < lon2x(W, z) || x > lon2x(E, z) || y < lat2y(N, z) || y > lat2y(S, z));
  const overview = OVERVIEW && ((g === 'b' && z <= OVB) || (g === 'd' && z <= OVD));
  if (!detail && !overview) continue;
  const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off);
  let raw = zlib.gunzipSync(b);
  if (!detail && OV_LITE) { raw = slim(raw, g, z); if (!raw) continue; }
  tileIdx[k] = [tOff, raw.length]; tileBufs.push(raw); tOff += raw.length; nTiles++; if (!detail) nOv++;
}
fs.closeSync(fd);

// ---------------------------------------------------------------- road graph (detail area complete + main roads)
const graphRaw = fs.readFileSync(path.join(MAP, 'graph.bin'));
const g = parseGraphBin(graphRaw.buffer.slice(graphRaw.byteOffset, graphRaw.byteOffset + graphRaw.length));
const gm = JSON.parse(fs.readFileSync(path.join(MAP, 'graph.meta.json'), 'utf8'));
const nodeIn = (n) => inDetail(g.lat[n] / 1e7, g.lon[n] / 1e7, MARGIN);
const via = new Set((gm.restr || []).map(r => r[1]));
const keepE = new Uint8Array(g.to.length);
{
  const from = new Uint32Array(g.to.length); for (let n = 0; n < g.lat.length; n++) for (let e = g.adj[n]; e < g.adj[n + 1]; e++) from[e] = n;
  for (let e = 0; e < g.to.length; e++) if ((nodeIn(from[e]) && nodeIn(g.to[e])) || (OVERVIEW && gm.cls[g.way[e]] <= OVCLS)) keepE[e] = 1;
  if (OVERVIEW) bridgeGaps(g, from, keepE);
}
// The main roads alone have gaps (a town bypass tagged "secondary", a bridge tagged "tertiary" ...). Every piece
// of the kept network that is cut off from the biggest piece gets the shortest road connection back to it.
function bridgeGaps(g, from, keep) {
  const N0 = g.lat.length, E0 = g.to.length;
  const comp = new Int32Array(N0).fill(-1); const radj = new Uint32Array(N0 + 1);
  for (let e = 0; e < E0; e++) radj[g.to[e] + 1]++;
  for (let n = 0; n < N0; n++) radj[n + 1] += radj[n];
  const rin = new Uint32Array(E0); const fill = radj.slice(0, N0); for (let e = 0; e < E0; e++) rin[fill[g.to[e]]++] = e;
  const label = () => {
    comp.fill(-1); let nc = 0; const sizes = [];
    for (let s = 0; s < N0; s++) {
      if (comp[s] >= 0) continue; let used = false;
      for (let e = g.adj[s]; e < g.adj[s + 1]; e++) if (keep[e]) { used = true; break; }
      if (!used) for (let k = radj[s]; k < radj[s + 1]; k++) if (keep[rin[k]]) { used = true; break; }
      if (!used) continue;
      const st = [s]; comp[s] = nc; let size = 0;
      while (st.length) {
        const v = st.pop(); size++;
        for (let e = g.adj[v]; e < g.adj[v + 1]; e++) if (keep[e] && comp[g.to[e]] < 0) { comp[g.to[e]] = nc; st.push(g.to[e]); }
        for (let k = radj[v]; k < radj[v + 1]; k++) { const e = rin[k]; if (keep[e] && comp[from[e]] < 0) { comp[from[e]] = nc; st.push(from[e]); } }
      }
      sizes.push(size); nc++;
    }
    return sizes;
  };
  let sizes = label(); const main = sizes.indexOf(Math.max(...sizes)); let added = 0, joined = 0;
  const dist = new Float64Array(N0).fill(Infinity), prevE = new Int32Array(N0).fill(-1); const touched = [];
  for (let c = 0; c < sizes.length; c++) {
    if (c === main || sizes[c] < 5) continue;
    // multi-source Dijkstra (undirected, metres) from this piece until the main piece is reached (max 30 km)
    const heap = [[0, -1]]; heap.length = 0;
    const push = (d, n) => { heap.push([d, n]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= d) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (let n = 0; n < N0; n++) if (comp[n] === c) { dist[n] = 0; touched.push(n); push(0, n); }
    let hit = -1;
    while (heap.length) {
      const [d, v] = pop(); if (d > dist[v]) continue; if (d > 30000) break;
      if (comp[v] >= 0 && comp[v] !== c) { if (comp[v] === main || sizes[comp[v]] > sizes[c]) { hit = v; break; } }
      const relax = (e, u) => { const nd = d + g.len[e]; if (nd < dist[u]) { if (dist[u] === Infinity) touched.push(u); dist[u] = nd; prevE[u] = e; push(nd, u); } };
      for (let e = g.adj[v]; e < g.adj[v + 1]; e++) relax(e, g.to[e]);
      for (let k = radj[v]; k < radj[v + 1]; k++) relax(rin[k], from[rin[k]]);
    }
    if (hit >= 0) {
      for (let v = hit; prevE[v] >= 0 && dist[v] > 0;) {
        const e = prevE[v]; const a = from[e], b = g.to[e];
        for (let e2 = g.adj[a]; e2 < g.adj[a + 1]; e2++) if (g.to[e2] === b && !keep[e2]) { keep[e2] = 1; added++; }   // both directions, if they exist
        for (let e2 = g.adj[b]; e2 < g.adj[b + 1]; e2++) if (g.to[e2] === a && !keep[e2]) { keep[e2] = 1; added++; }
        v = a === v ? b : a;
      }
      joined++;
    }
    for (const n of touched) { dist[n] = Infinity; prevE[n] = -1; } touched.length = 0;
  }
  sizes = label();
  console.log('  main roads: ' + joined + ' gaps bridged with ' + added + ' road edges; ' + sizes.filter(s => s >= 5).length + ' separate road networks left (islands)');
}
const G = cutGraph(g,
  (e) => keepE[e] === 1,
  (n) => !nodeIn(n), OV_TOL, OV_SEG, via,
  (a, b) => a === b || (gm.cls[a] === gm.cls[b] && gm.flags[a] === gm.flags[b] && gm.speed[a] === gm.speed[b] && gm.name[a] === gm.name[b] && gm.ref[a] === gm.ref[b]));
// keep only the ways (names, classes) the cut graph still uses
const wayMap = new Map(); const wm = { cls: [], flags: [], speed: [], name: [], ref: [] }; const names = [], nameMap = new Map();
const nmIdx = (i) => { if (i < 0) return -1; let j = nameMap.get(i); if (j === undefined) { j = names.length; names.push(gm.names[i]); nameMap.set(i, j); } return j; };
for (let e = 0; e < G.E; e++) {
  const w = G.way[e]; let nw = wayMap.get(w);
  if (nw === undefined) { nw = wm.cls.length; wayMap.set(w, nw); wm.cls.push(gm.cls[w]); wm.flags.push(gm.flags[w]); wm.speed.push(gm.speed[w]); wm.name.push(nmIdx(gm.name[w])); wm.ref.push(nmIdx(gm.ref[w])); }
  G.way[e] = nw;
}
const restr = (gm.restr || []).filter(r => G.remap[r[1]] >= 0 && wayMap.has(r[0]) && wayMap.has(r[2])).map(r => [wayMap.get(r[0]), G.remap[r[1]], wayMap.get(r[2]), r[3]]);
const graphBin = packGraph(G);
const gmeta = Buffer.from(JSON.stringify(Object.assign(wm, { names, restr })));

// ---------------------------------------------------------------- search
const OV_POI = new Set([1, 4, 5, 14]);              // hospital, police, fire station, airport / helipad
const search = JSON.parse(fs.readFileSync(path.join(MAP, 'search.json'), 'utf8'))
  .filter(s => inDetail(s[3], s[4], MARGIN) || (OVERVIEW && ((s[1] === 'place' && [1, 2, 8].includes(s[2])) || s[1] === 'barangay' || (s[1] === 'poi' && OV_POI.has(s[2])))));
const searchBuf = Buffer.from(JSON.stringify(search));

// ---------------------------------------------------------------- bundle
const meta = {
  ok: true, built: meta0.built, nodeBuilt: new Date().toISOString(), bbox: OVERVIEW ? meta0.bbox : [S, W, N, E], detail: [S, W, N, E],
  groups: { b: meta0.groups.b, d: { min: meta0.groups.d.min, max: Math.min(DMAX, meta0.groups.d.max) } },
  area: OVERVIEW ? meta0.area : undefined, land: OVERVIEW ? !!meta0.land : false,
  tileSize: meta0.tileSize, extent: meta0.extent, routing: true, attribution: meta0.attribution,
  counts: { tiles: nTiles, overviewTiles: nOv, graphNodes: G.N, graphEdges: G.E, searchEntries: search.length, restrictions: restr.length }
};
const sections = []; const sec = {}; let dOff = 0;
for (const [name, buf] of [['tiles', Buffer.concat(tileBufs)], ['graph', graphBin], ['gmeta', gmeta], ['search', searchBuf]]) {
  const pad = (8 - (dOff % 8)) % 8; if (pad) { sections.push(Buffer.alloc(pad)); dOff += pad; }
  sec[name] = [dOff, buf.length]; sections.push(buf); dOff += buf.length;
}
const hj = Buffer.from(JSON.stringify({ meta, tiles: tileIdx, sec }));
const head = Buffer.alloc(16); head.write('AMPNMAP1', 0, 'latin1'); head.writeUInt32LE(hj.length, 8); head.writeUInt32LE(0, 12);
const hpad = (8 - ((16 + hj.length) % 8)) % 8;
const bundle = Buffer.concat([head, hj, Buffer.alloc(hpad), ...sections]);
// The node hands the map out in 512 KB pieces, each its own gzip stream: a phone fetches them one after
// another and the node's web server stays responsive for everybody else in between.
const PART = 512 * 1024;
const pieces = [], partIdx = []; let pOff = 0;
for (let i = 0; i < bundle.length; i += PART) {
  const gz = zlib.gzipSync(bundle.subarray(i, Math.min(bundle.length, i + PART)), { level: 9 });
  partIdx.push([pOff, gz.length]); pieces.push(gz); pOff += gz.length;
}
const gz = Buffer.concat(pieces);

const fileMeta = Object.assign({}, meta, { v: 1, gzSize: gz.length, rawSize: bundle.length, partRaw: PART, parts: partIdx });
const mj = Buffer.from(JSON.stringify(fileMeta));
const uh = Buffer.alloc(12); uh.write('AMPUP001', 0, 'latin1'); uh.writeUInt32LE(mj.length, 8);
const file = Buffer.concat([uh, mj, gz]);
const sizes = 'tiles ' + (tOff / 1e6).toFixed(2) + ' MB, graph ' + (graphBin.length / 1e6).toFixed(2) + ' MB, names ' + ((gmeta.length + searchBuf.length) / 1e6).toFixed(2) + ' MB (unpacked)';
if (file.length > LIMIT) { console.error('map file is ' + (file.length / 1e6).toFixed(2) + ' MB - larger than allowed (' + (LIMIT / 1e6).toFixed(1) + ' MB): ' + sizes + '. Use a smaller --bbox / --dmax 15 / --ovb 10 / --ovcls 2.'); process.exit(2); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, file);
console.log('node map: ' + nTiles + ' tiles (' + nOv + ' overview), ' + G.N + ' road nodes, ' + G.E + ' road edges, ' + search.length + ' places, ' + restr.length + ' turn restrictions');
console.log('  detail ' + [S, W, N, E].join(',') + ' to zoom ' + meta.groups.d.max + (OVERVIEW ? ', overview of ' + (meta0.area.name || 'the map') + ' to zoom ' + Math.max(OVB, OVD) + ', main roads class <= ' + OVCLS : ''));
console.log('  ' + sizes);
console.log('  ' + (bundle.length / 1e6).toFixed(2) + ' MB unpacked, file ' + (file.length / 1e6).toFixed(2) + ' MB -> ' + OUT);
