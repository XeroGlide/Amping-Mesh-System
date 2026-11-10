/* AMPING offline map + turn-by-turn navigation.
   Source of the <script id="amping-offline-map"> block that tools/patch-app.js inserts into the Pi app; also part of
   the Heltec field node's /amp-map.js.  Data comes from the Pi over HTTP, unless the page sets
   window.AMP_MAP_SOURCE = { meta(), tile(g,z,x,y), route(from,to,mode), geocode(q,at), nearest(type,at,mode) }
   (the field node does: everything is computed inside the phone from the node's map file). */
(function () {
  'use strict';
  var SRC = window.AMP_MAP_SOURCE || null;
  var AMP = window.AMP_MAP = { meta: null, ready: false, manualOrigin: null };
  var metaPromise = null;
  function getMeta() {
    if (!metaPromise) {
      metaPromise = (SRC ? Promise.resolve().then(function () { return SRC.meta(); }) : fetch('/map/meta.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }))
        .catch(function () { return null; })
        .then(function (m) { AMP.meta = m; AMP.ready = !!m; if (!m) metaPromise = SRC ? null : metaPromise; return m; });
    }
    return metaPromise;
  }
  getMeta();
  /** call after the map data became available later (field node: download finished) */
  AMP.refresh = function () { metaPromise = null; tileCache.clear(); return getMeta().then(function (m) { (AMP.layers || []).forEach(function (l) { try { l.redraw(); } catch (e) { /* ignore */ } }); return m; }); };
  var curUser = function () { if (window.AMP_CURRENT_USER) return window.AMP_CURRENT_USER; try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch (e) { return null; } };
  var NO_LINK = SRC ? 'The map data is not ready on this phone yet.' : 'Cannot reach the command center. Check that you are connected to its WiFi.';

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmtDist = function (m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.max(0, Math.round(m / 5) * 5) + ' m'; };
  var fmtTime = function (s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); if (m === 60) { h++; m = 0; } return h ? h + ' h ' + m + ' min' : Math.max(1, m) + ' min'; };
  var haversine = function (a, b) { var R = 6371008.8, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r; var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2); return 2 * R * Math.asin(Math.min(1, Math.sqrt(x))); };

  /* =====================================================================
     1. VECTOR BASE MAP (tiles come from the Pi: /map/t/<group>/<z>/<x>/<y>)
     ===================================================================== */
  var LAND = { 0: '#c4e3ad', 1: '#eef1d6', 2: '#e9e3d8', 3: '#f2dcd6', 4: '#cdebc2', 5: '#cbd9c6', 6: '#d4e9c6', 7: '#f6eab9' };
  var WATER = '#9ccbee', WATER_LINE = '#7db6e0', BG = '#f3efe7', SEA = '#a9d3f0', OUTSIDE = '#dcdcd8';
  //            [casing, casingW@14, fill, fillW@14]
  var ROAD = [['#b4691f', 7, '#f4a94e', 5.5], ['#b4691f', 7, '#f7b95a', 5.5], ['#c4952c', 6.4, '#fcd670', 5], ['#c9ba7f', 5.6, '#fff0a0', 4.2], ['#b9b9b9', 4.6, '#ffffff', 3.4], ['#c8c8c8', 3.6, '#ffffff', 2.6], ['#cfcfcf', 2.4, '#fbfbfb', 1.6], ['#b79a6a', 1.8, '#c9a874', 1.2], ['#e8e8e8', 1.2, '#b8895a', 1]];
  var POI_ICON = { 1: '🏥', 2: '🩺', 3: '💊', 4: '🚓', 5: '🚒', 6: '🏫', 7: '🎓', 8: '🏛️', 9: '🏠', 10: '⛪', 11: '🛒', 12: '⛽', 13: '🏦', 14: '🚁', 15: '🏨', 16: '🚑', 17: '🚌' };
  var IMPORTANT_POI = { 1: 1, 4: 1, 5: 1, 14: 1 };

  var tileCache = new Map();
  function loadTile(g, z, x, y) {
    var grp = AMP.meta && AMP.meta.groups && AMP.meta.groups[g];
    if (!grp || z < grp.min) return Promise.resolve(null);
    var dz = Math.min(z, grp.max), s = Math.pow(2, z - dz), dx = Math.floor(x / s), dy = Math.floor(y / s);
    if (SRC && AMP.meta && AMP.meta.detail) {
      // phone / node map: full detail only around its home area, an overview elsewhere - a missing tile is
      // drawn from the nearest coarser tile that exists (zooming in outside the detail area stays readable)
      var fkey = 'f/' + g + '/' + dz + '/' + dx + '/' + dy, fh = tileCache.get(fkey);
      if (!fh) {
        fh = Promise.resolve().then(function () {
          for (var pz = dz; pz >= grp.min; pz--) {
            var q = Math.pow(2, dz - pz), d = SRC.tile(g, pz, Math.floor(dx / q), Math.floor(dy / q));
            if (d) return { data: d, pz: pz };
          }
          return { data: null, pz: dz };
        }).catch(function () { return { data: null, pz: dz }; });
        tileCache.set(fkey, fh);
        if (tileCache.size > 500) tileCache.delete(tileCache.keys().next().value);
      }
      return fh.then(function (r) {
        var s2 = Math.pow(2, z - r.pz), px = Math.floor(x / s2), py = Math.floor(y / s2);
        return { data: r.data, k: s2 / 16, tx: -(x - px * s2) * 256, ty: -(y - py * s2) * 256 };
      });
    }
    var key = g + '/' + dz + '/' + dx + '/' + dy;
    var hit = tileCache.get(key);
    if (!hit) {
      hit = SRC ? Promise.resolve().then(function () { return SRC.tile(g, dz, dx, dy); }).catch(function () { return null; })
        : fetch('/map/t/' + key + '?v=' + encodeURIComponent((AMP.meta && AMP.meta.built) || '')).then(function (r) { return r.status === 200 ? r.json() : null; }).catch(function () { return null; });
      tileCache.set(key, hit);
      if (tileCache.size > 500) tileCache.delete(tileCache.keys().next().value);
    }
    var k = s / 16;
    return hit.then(function (data) { return { data: data, k: k, tx: -(x - dx * s) * 256, ty: -(y - dy * s) * 256 }; });
  }

  function paint(canvas, dpr, z, x, y, B, D) {
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var area = AMP.meta && AMP.meta.land && AMP.meta.area && AMP.meta.area.poly;
    if (area) {
      // maps with land from the coastline (all of Mindanao): grey outside the map area, sea inside it,
      // land (type 30 polygons in the B tiles) painted on top below
      ctx.fillStyle = OUTSIDE; ctx.fillRect(0, 0, 256, 256);
      var n = 256 * Math.pow(2, z); ctx.beginPath();
      for (var ai = 0; ai < area.length; ai++) {
        var s = Math.sin(area[ai][0] * Math.PI / 180);
        var ax = (area[ai][1] + 180) / 360 * n - x * 256, ay = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - y * 256;
        if (ai === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
      }
      ctx.closePath(); ctx.fillStyle = SEA; ctx.fill();
    } else { ctx.fillStyle = BG; ctx.fillRect(0, 0, 256, 256); }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var zf = Math.max(0.45, Math.min(2.8, Math.pow(2, (z - 14) * 0.55)));

    function pathOf(tf, flat, close) {
      var X = 0, Y = 0, k = tf.k; ctx.beginPath();
      for (var i = 0; i < flat.length; i += 2) {
        X += flat[i]; Y += flat[i + 1];
        var px = X * k + tf.tx, py = Y * k + tf.ty;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      if (close) ctx.closePath();
    }
    function pts(tf, flat) { var out = [], X = 0, Y = 0; for (var i = 0; i < flat.length; i += 2) { X += flat[i]; Y += flat[i + 1]; out.push([X * tf.k + tf.tx, Y * tf.k + tf.ty]); } return out; }

    // ---- background polygons (land use, water)
    if (B && B.data && B.data.a) {
      var rank = function (t) { return t === 30 ? -1 : t === 10 ? 99 : t; };       // land first, water last
      var polys = B.data.a.slice().sort(function (p, q) { return rank(p[0]) - rank(q[0]); });
      for (var i = 0; i < polys.length; i++) {
        pathOf(B, polys[i][1], true); ctx.fillStyle = polys[i][0] === 30 ? BG : polys[i][0] === 10 ? WATER : (LAND[polys[i][0]] || '#eee'); ctx.fill();
      }
    }
    // ---- waterway lines + coast (both groups)
    [B, D].forEach(function (T) {
      if (!T || !T.data || !T.data.w) return;
      T.data.w.forEach(function (w) {
        var t = w[0]; ctx.strokeStyle = t === 3 ? '#4f97cf' : WATER_LINE;
        ctx.lineWidth = (t === 0 ? 5 : t === 1 ? 3 : t === 3 ? 2.2 : 1.6) * zf; pathOf(T, w[1], false); ctx.stroke();
      });
    });
    // ---- administrative boundaries
    if (B && B.data && B.data.b) {
      B.data.b.forEach(function (b) {
        ctx.setLineDash(b[0] === 0 ? [6, 5] : b[0] === 1 ? [10, 4, 2, 4] : [12, 4]);
        ctx.strokeStyle = b[0] === 0 ? 'rgba(120,100,150,.55)' : 'rgba(90,60,130,.75)'; ctx.lineWidth = b[0] === 0 ? 1 : 1.6; pathOf(B, b[1], false); ctx.stroke();
      });
      ctx.setLineDash([]);
    }
    // ---- buildings
    if (D && D.data && D.data.a && z >= 16) {
      ctx.fillStyle = '#dcd5cb'; ctx.strokeStyle = '#c3b9ad'; ctx.lineWidth = 0.7;
      D.data.a.forEach(function (a) { if (a[0] !== 20) return; pathOf(D, a[1], true); ctx.fill(); ctx.stroke(); });
    }
    // ---- roads: casings then fills, minor -> major
    var roads = (D && D.data && D.data.r) || [];
    if (roads.length) {
      var byCls = [[], [], [], [], [], [], [], [], []];
      roads.forEach(function (r) { if (byCls[r[0]] && Array.isArray(r[3])) byCls[r[0]].push(r); });
      var order = [8, 7, 6, 5, 4, 3, 2, 1, 0];
      [0, 1].forEach(function (pass) {
        order.forEach(function (c) {
          var st = ROAD[c], list = byCls[c]; if (!list.length) return;
          var w = (pass === 0 ? st[1] : st[3]) * zf; if (c >= 7 && z < 15) w *= 0.8;
          ctx.strokeStyle = pass === 0 ? st[0] : st[2]; ctx.lineWidth = Math.max(pass === 0 ? 1 : 0.6, w);
          ctx.setLineDash(c === 7 ? [5, 3] : c === 8 ? [2, 3] : []);
          list.forEach(function (r) { if (pass === 0 && (r[1] & 2)) { ctx.lineWidth = w + 1.5; } else ctx.lineWidth = Math.max(pass === 0 ? 1 : 0.6, w); pathOf(D, r[3], false); ctx.stroke(); });
        });
      });
      ctx.setLineDash([]);
    }
    // ---- road names (drawn along the road when it is long enough inside this tile)
    var placed = [];
    function free(x0, y0, x1, y1) { for (var q = 0; q < placed.length; q++) { var p = placed[q]; if (x0 < p[2] && x1 > p[0] && y0 < p[3] && y1 > p[1]) return false; } placed.push([x0, y0, x1, y1]); return true; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (D && D.data && z >= 15) {
      var sarr = D.data.s || [];
      ctx.font = '600 ' + (z >= 17 ? 12 : 11) + 'px system-ui, sans-serif';
      var seen = {};
      roads.forEach(function (r) {
        var name = r[2] >= 0 ? sarr[r[2]] : ''; if (!name || r[0] > 6 || seen[name]) return;
        var P = pts(D, r[3]); var cum = [0], i; for (i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
        var tw = ctx.measureText(name).width; if (cum[cum.length - 1] < tw + 24) return;
        var mid = cum[cum.length - 1] / 2; for (i = 1; i < cum.length && cum[i] < mid; i++) { }
        var a = P[i - 1], b = P[i], t = (mid - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        var cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t;
        if (cx < tw / 2 * 0.6 || cx > 256 - tw / 2 * 0.6 || cy < 8 || cy > 248) return;
        if (!free(cx - tw / 2, cy - 8, cx + tw / 2, cy + 8)) return;
        var ang = Math.atan2(b[1] - a[1], b[0] - a[0]); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.strokeText(name, 0, 0); ctx.fillStyle = '#3b3b3b'; ctx.fillText(name, 0, 0); ctx.restore();
        seen[name] = 1;
      });
    }
    // ---- POIs (icons + names)
    if (D && D.data && D.data.p) {
      var ds = D.data.s || [];
      D.data.p.forEach(function (p) {
        var px = p[1] * D.k + D.tx, py = p[2] * D.k + D.ty; if (px < -12 || px > 268 || py < -12 || py > 268) return;
        var big = z >= 16 || IMPORTANT_POI[p[0]], r = big ? 10 : 7;
        ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832); ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#8b8b8b'; ctx.stroke();
        ctx.font = (big ? 12 : 9) + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'; ctx.fillStyle = '#000';
        ctx.fillText(POI_ICON[p[0]] || '•', px, py + 1);
        var nm = p[3] >= 0 ? ds[p[3]] : '';
        if (nm && (z >= 16 || (IMPORTANT_POI[p[0]] && z >= 14))) {
          ctx.font = '600 10.5px system-ui, sans-serif'; var tw2 = ctx.measureText(nm).width; if (!free(px - tw2 / 2, py + r, px + tw2 / 2, py + r + 14)) return; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(nm, px, py + r + 8); ctx.fillStyle = '#2b2b2b'; ctx.fillText(nm, px, py + r + 8);
        }
      });
    }
    // ---- place names & barangays
    if (B && B.data && B.data.p) {
      var bs = B.data.s || [];
      B.data.p.forEach(function (p) {
        var px = p[1] * B.k + B.tx, py = p[2] * B.k + B.ty; if (px < 0 || px > 256 || py < 0 || py > 256) return;
        var nm = p[3] >= 0 ? bs[p[3]] : ''; if (!nm) return; var t = p[0];
        var size = t === 1 ? 17 : t === 2 ? 15 : t === 9 ? 10.5 : t <= 4 ? 12.5 : 11;
        ctx.font = (t === 9 ? 'italic 600 ' : '700 ') + size + 'px system-ui, sans-serif';
        if (t === 1 || t === 2) nm = nm.toUpperCase();
        var tw3 = ctx.measureText(nm).width;
        // a name is drawn only by the tile that holds its point: keep it whole inside that tile
        px = Math.max(tw3 / 2 + 2, Math.min(254 - tw3 / 2, px)); py = Math.max(size / 2 + 2, Math.min(254 - size / 2, py));
        if (!free(px - tw3 / 2, py - size / 2, px + tw3 / 2, py + size / 2)) return;
        ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(nm, px, py); ctx.fillStyle = t === 9 ? '#6b4f8f' : '#2a2a2a'; ctx.fillText(nm, px, py);
      });
    }
  }

  function makeLayer() {
    var VLayer = L.GridLayer.extend({
      options: { tileSize: 256, updateWhenIdle: false, keepBuffer: 2, zIndex: 2 },
      createTile: function (coords, done) {
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var canvas = document.createElement('canvas');
        canvas.width = 256 * dpr; canvas.height = 256 * dpr; canvas.style.width = '256px'; canvas.style.height = '256px';
        var z = coords.z, x = coords.x, y = coords.y;
        getMeta().then(function () {
          return Promise.all([loadTile('b', z, x, y), loadTile('d', z, x, y)]);
        }).then(function (r) { try { paint(canvas, dpr, z, x, y, r[0], r[1]); } catch (e) { console.warn('map tile', e); } done(null, canvas); })
          .catch(function () { done(null, canvas); });
        return canvas;
      }
    });
    return new VLayer();
  }

  function addCredit(map) {
    try {
      var c = map.getContainer(); if (c.querySelector('.amp-credit')) return;
      var d = document.createElement('div'); d.className = 'amp-credit';
      d.style.cssText = 'position:absolute;left:6px;bottom:2px;z-index:900;font:10px system-ui,sans-serif;color:#444;background:rgba(255,255,255,.7);padding:1px 5px;border-radius:4px;pointer-events:none';
      d.textContent = '© OpenStreetMap contributors · offline map'; c.appendChild(d);
    } catch (e) { /* ignore */ }
  }

  /** Adds the offline map to a Leaflet map. plain=true => picker map (no navigation UI). */
  window.AMPING_addBaseMap = function (map, bounds, plain) {
    var layer = makeLayer(); layer.addTo(map);
    (AMP.layers = AMP.layers || []).push(layer);
    getMeta().then(function (m) {
      if (!m) {                                    // map data not installed on this Pi -> old picture fallback
        if (!SRC) { try { map.removeLayer(layer); L.imageOverlay('butuan_map.webp', bounds, { opacity: 0.6, alt: 'Offline Butuan Map' }).addTo(map); } catch (e) { /* ignore */ } }
        return;
      }
      try { map.setMaxZoom(19); } catch (e) { /* ignore */ }
      // a big-area map (all of Mindanao): let people zoom out far enough to see all of it
      try { if (m.area && m.groups && m.groups.b && m.groups.b.min < map.getMinZoom()) map.setMinZoom(m.groups.b.min); } catch (e) { /* ignore */ }
      addCredit(map);
    });
    if (!plain) mountNavUI(map);
    return layer;
  };

  /* =====================================================================
     2. NAVIGATION (route from the Pi's offline road network)
     ===================================================================== */
  var NAV = { active: false, mode: null, dest: null, destLabel: '', route: null, cum: null, stepAlong: null, watchId: null, layers: [], destMarker: null, meMarker: null, lastPos: null, lastIdx: 0, off: 0, lastReroute: 0, spoken: {}, follow: true, muted: false, arrived: false, map: null };
  var ICON = { left: '⬅️', right: '➡️', 'slight left': '↖️', 'slight right': '↗️', 'sharp left': '↙️', 'sharp right': '↘️', straight: '⬆️', uturn: '↩️' };
  var iconOf = function (st) { return st.type === 'arrive' ? '🏁' : st.type === 'depart' ? '🚩' : st.type === 'roundabout' ? '🔄' : (ICON[st.mod] || '⬆️'); };
  try { NAV.muted = localStorage.getItem('ampNavMuted') === '1'; } catch (e) { /* ignore */ }
  var defaultMode = function () { try { var m = localStorage.getItem('ampNavMode'); if (m) return m; } catch (e) { /* ignore */ } var u = curUser(), r = (u && u.role) || 'user'; return r === 'user' ? 'foot' : 'car'; };
  var MODE_LABEL = { car: '🚗', bike: '🏍️', foot: '🚶' };

  function homePos() {
    try {
      var u = curUser();
      if (u) {
        var la = parseFloat(u.lat), lo = parseFloat(u.lng != null ? u.lng : u.lon);
        if (isFinite(la) && isFinite(lo) && la) return [la, lo];
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  /** best known position of the person holding the phone: live GPS > manual pin > last GPS (10 min) > registered home.
   *  Uses the app's position engine (gps-gate.js AMP_LOC: the browser's GPS AND, in the AMPING Mesh app, the phone's
   *  own receiver) and waits a few seconds for a fix. opts.noGuess (navigation): with no position at all it answers
   *  ll:null instead of the map centre - a route from the city centre looked real but was kilometres wrong. */
  function getOrigin(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var fix = function (b, src) { return { ll: [b.lat, b.lng], src: src, acc: b.acc }; };
      var G = window.AMP_GPS; if (G && Date.now() - G.ts < 45000) return resolve(fix(G, 'gps'));
      var insecure = !navigator.geolocation || window.isSecureContext === false;
      var fallback = function (why) {
        if (AMP.manualOrigin) return resolve({ ll: AMP.manualOrigin, src: 'manual', why: why });
        var g = window.AMP_GPS; if (g && Date.now() - g.ts < 10 * 60000) { var o = fix(g, 'last'); o.why = why; return resolve(o); }
        var lk = window.lastKnownUserPos;   // (a broken GPS can report 0,0 - that is in the sea off Africa, not a position)
        if (lk && isFinite(lk[0]) && isFinite(lk[1]) && (lk[0] || lk[1]) && Math.abs(lk[0]) <= 90) return resolve({ ll: lk, src: 'last', why: why });
        var h = homePos(); if (h) return resolve({ ll: h, src: 'home', why: why });
        if (opts.noGuess) return resolve({ ll: null, src: 'none', why: why });
        resolve({ ll: (typeof BASE_LAT !== 'undefined') ? [BASE_LAT, BASE_LON] : [8.9475, 125.5406], src: 'default', why: why });
      };
      var LOC = window.AMP_LOC;
      if (LOC && LOC.get) {
        LOC.get({ want: 100, wait: opts.wait == null ? 8000 : opts.wait }).then(function (b) {
          if (b && Date.now() - b.ts < 60000) resolve(fix(b, 'gps')); else fallback(insecure && !LOC.native ? 'insecure' : 'denied');
        });
        return;
      }
      if (insecure) return fallback('insecure');
      navigator.geolocation.getCurrentPosition(function (p) { resolve({ ll: [p.coords.latitude, p.coords.longitude], src: 'gps', acc: p.coords.accuracy }); },
        function () { fallback('denied'); }, { enableHighAccuracy: true, timeout: 7000, maximumAge: 15000 });
    });
  }
  function originNote(o) {
    if (o.src === 'gps') return '';
    var why = o.why === 'insecure' ? 'GPS is off on http:// pages. Open https://' + location.host + ' once (accept the warning) to use live GPS. ' : 'This phone is not giving its location (GPS). ';
    if (o.src === 'none') return why + 'Turn on Location in the phone settings (and allow it for this app), or long-press the map where you are and tap "I am here". The route appears as soon as your position is known.';
    return why + 'Routing from ' + (o.src === 'manual' ? 'the point you marked "I am here"' : o.src === 'home' ? 'your registered home' : 'your last known position') + ' - it is corrected by itself as soon as GPS works. Long-press the map to set "I am here".';
  }
  function waitingForPosition() {
    setBanner('📍', 'Where are you?', 'Waiting for this phone\'s location…', NAV.destLabel ? 'To: ' + esc(NAV.destLabel) : '');
    showWarn(NAV.gpsNote);
    try { NAV.map.setView(NAV.dest, Math.max(NAV.map.getZoom(), 15), { animate: false }); } catch (e) { /* ignore */ }
  }

  function clearNavLayers() {
    NAV.layers.forEach(function (l) { try { l.remove(); } catch (e) { /* ignore */ } }); NAV.layers = [];
  }
  function drawRoute(r, fit) {
    clearNavLayers();
    var map = NAV.map || (typeof googleMap !== 'undefined' ? googleMap : null); if (!map) return;
    var ll = r.geometry;
    var casing = L.polyline(ll, { color: '#0a2a66', weight: 11, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    var line = L.polyline(ll, { color: '#2f86ff', weight: 7, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    NAV.layers.push(casing, line);
    if (NAV.lastPos && r.snappedFrom) NAV.layers.push(L.polyline([NAV.lastPos, r.snappedFrom], { color: '#6b7280', weight: 4, dashArray: '2 8', opacity: .9 }).addTo(map));
    if (NAV.dest && r.snappedTo) NAV.layers.push(L.polyline([r.snappedTo, NAV.dest], { color: '#6b7280', weight: 4, dashArray: '2 8', opacity: .9 }).addTo(map));
    if (fit) { try { map.fitBounds(line.getBounds().pad(0.25), { animate: false, maxZoom: 17 }); } catch (e) { /* ignore */ } }
  }
  function prepareRoute(r) {
    NAV.route = r; NAV.lastIdx = 0; NAV.spoken = {};
    var cum = [0]; for (var i = 1; i < r.geometry.length; i++) cum.push(cum[i - 1] + haversine(r.geometry[i - 1], r.geometry[i]));
    NAV.cum = cum; NAV.stepAlong = r.steps.map(function (s) { return cum[s.i]; });
    NAV.total = cum[cum.length - 1];
  }
  function fetchRoute(from, to, mode) {
    if (SRC) return Promise.resolve().then(function () { return SRC.route(from, to, mode); }).catch(function (e) { return { ok: false, error: (e && e.message) || NO_LINK }; });
    return fetch('/api/route?from=' + from[0].toFixed(6) + ',' + from[1].toFixed(6) + '&to=' + to[0].toFixed(6) + ',' + to[1].toFixed(6) + '&mode=' + mode, { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad reply' }; }); })
      .catch(function () { return { ok: false, error: 'Cannot reach the command center. Check that you are connected to its WiFi.' }; });
  }

  AMP.fetchRoute = fetchRoute;   // also used by the automatic requester <-> responder line (live-units.js)

  // nearest point on the route; searches a window around the last match first
  function project(pos) {
    var g = NAV.route.geometry, cum = NAV.cum, best = null;
    var cosl = Math.cos(pos[0] * Math.PI / 180);
    function scan(a, b) {
      for (var i = a; i < b; i++) {
        var ax = g[i][1] * 111320 * cosl, ay = g[i][0] * 111320, bx = g[i + 1][1] * 111320 * cosl, by = g[i + 1][0] * 111320, px = pos[1] * 111320 * cosl, py = pos[0] * 111320;
        var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        var d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (!best || d < best.d) best = { d: d, i: i, along: cum[i] + t * (cum[i + 1] - cum[i]) };
      }
    }
    scan(Math.max(0, NAV.lastIdx - 3), Math.min(g.length - 1, NAV.lastIdx + 40));
    if (!best || best.d > 60) { best = null; scan(0, g.length - 1); }
    return best;
  }

  function speak(text) {
    if (NAV.muted || !('speechSynthesis' in window)) return;
    try { var u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 1.0; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch (e) { /* ignore */ }
  }

  function panel() { return document.getElementById('navControls'); }
  function setBanner(icon, dist, text, meta) {
    var p = panel(); if (!p) return;
    var a = p.querySelector('#ampNavIcon'), b = p.querySelector('#ampNavDist'), c = p.querySelector('#ampNavText'), d = p.querySelector('#ampNavMeta');
    if (a) a.textContent = icon; if (b) b.textContent = dist; if (c) c.textContent = text; if (d) d.innerHTML = meta;
  }
  function buildPanel() {
    var p = panel(); if (!p) return;
    p.style.maxWidth = '430px'; p.style.width = '94%'; p.style.textAlign = 'left';
    var modes = ['car', 'bike', 'foot'].map(function (m) { return '<button data-mode="' + m + '" style="flex:1;padding:9px 0;border:0;border-radius:10px;font-size:17px;cursor:pointer;background:' + (NAV.mode === m ? '#2f86ff' : '#334155') + ';color:#fff">' + MODE_LABEL[m] + '</button>'; }).join('');
    p.innerHTML = '<div style="background:#0f172a;color:#fff;border-radius:18px;padding:12px 14px;box-shadow:0 12px 30px rgba(0,0,0,.35);border:1px solid #1e293b">' +
      '<div style="display:flex;gap:12px;align-items:center"><div id="ampNavIcon" style="font-size:36px;width:46px;text-align:center">⏳</div>' +
      '<div style="flex:1;min-width:0"><div id="ampNavDist" style="font-size:24px;font-weight:800;line-height:1.1">…</div><div id="ampNavText" style="font-size:13.5px;line-height:1.3;opacity:.95;word-break:break-word">Finding the best route…</div></div></div>' +
      '<div id="ampNavMeta" style="margin-top:8px;font-size:12px;opacity:.85"></div>' +
      '<div id="ampNavWarn" style="display:none;margin-top:8px;background:#f59e0b;color:#1f1300;border-radius:10px;padding:7px 10px;font-size:12px;font-weight:700"></div>' +
      '<div style="display:flex;gap:6px;margin-top:10px">' + modes +
      '<button id="ampNavMute" style="width:44px;border:0;border-radius:10px;font-size:16px;cursor:pointer;background:#334155;color:#fff">' + (NAV.muted ? '🔇' : '🔊') + '</button>' +
      '<button id="ampNavList" style="width:44px;border:0;border-radius:10px;font-size:16px;cursor:pointer;background:#334155;color:#fff">☰</button></div>' +
      '<div id="ampNavSteps" style="display:none;margin-top:8px;max-height:32vh;overflow:auto;font-size:12.5px;border-top:1px solid #334155;padding-top:6px"></div>' +
      '<button id="ampNavExit" style="margin-top:10px;width:100%;background:#ef4444;color:#fff;border:0;padding:12px;border-radius:12px;font-weight:800;font-size:14px;cursor:pointer">EXIT NAVIGATION</button></div>';
    p.querySelectorAll('button[data-mode]').forEach(function (b) { b.onclick = function () { setMode(b.getAttribute('data-mode')); }; });
    p.querySelector('#ampNavMute').onclick = function () { NAV.muted = !NAV.muted; try { localStorage.setItem('ampNavMuted', NAV.muted ? '1' : '0'); } catch (e) { /* ignore */ } this.textContent = NAV.muted ? '🔇' : '🔊'; if (NAV.muted && window.speechSynthesis) window.speechSynthesis.cancel(); };
    p.querySelector('#ampNavList').onclick = function () { var s = p.querySelector('#ampNavSteps'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; };
    p.querySelector('#ampNavExit').onclick = function () { window.stopLiveNavigation(); };
  }
  function fillStepList() {
    var s = document.getElementById('ampNavSteps'); if (!s || !NAV.route) return;
    s.innerHTML = NAV.route.steps.map(function (st) { return '<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #1e293b"><span style="width:24px;text-align:center">' + iconOf(st) + '</span><span style="flex:1">' + esc(st.text) + '</span><span style="opacity:.7;white-space:nowrap">' + (st.type === 'arrive' ? '' : fmtDist(st.dist)) + '</span></div>'; }).join('');
  }
  function setMode(m) {
    NAV.mode = m; try { localStorage.setItem('ampNavMode', m); } catch (e) { /* ignore */ }
    var p = panel(); if (p) p.querySelectorAll('button[data-mode]').forEach(function (b) { b.style.background = b.getAttribute('data-mode') === m ? '#2f86ff' : '#334155'; });
    if (NAV.active && NAV.dest) reroute(true);
  }

  function showWarn(t) { var w = document.getElementById('ampNavWarn'); if (!w) return; w.style.display = t ? 'block' : 'none'; w.textContent = t || ''; }

  function applyRoute(r, fit) {
    prepareRoute(r); drawRoute(r, fit); fillStepList();
    showWarn(r.warning || (NAV.gpsNote || ''));
    updateProgress(NAV.lastPos || r.snappedFrom, true);
  }

  function reroute(fromUser) {
    if (!NAV.active || !NAV.dest) return;
    NAV.lastReroute = Date.now();
    setBanner('🔄', '', 'Recalculating the route…', '');
    getOrigin({ noGuess: true, wait: 3000 }).then(function (o) {
      NAV.originSrc = o.src; NAV.gpsNote = originNote(o);
      if (!o.ll) return { waiting: true };
      NAV.lastPos = o.ll;
      return fetchRoute(o.ll, NAV.dest, NAV.mode);
    }).then(function (r) {
      if (!NAV.active) return;
      if (r && r.waiting) { clearNavLayers(); waitingForPosition(); return; }
      if (!r.ok) { setBanner('⚠️', '', r.error || 'No route found', ''); return; }
      NAV.arrived = false; applyRoute(r, !!fromUser);
      if (!fromUser) speak('Route updated.');
    });
  }

  function updateProgress(pos, silent) {
    if (!NAV.active || !NAV.route || !pos) return;
    var pr = project(pos); if (!pr) return;
    NAV.lastIdx = pr.i;
    var remaining = Math.max(0, NAV.total - pr.along);
    var r = NAV.route;
    var frac = NAV.total > 0 ? remaining / NAV.total : 0;
    var remDist = remaining + (r.offRoad ? r.offRoad.end : 0);
    var remTime = (r.duration - (r.offRoad ? (r.offRoad.start + r.offRoad.end) / 1.3 : 0)) * frac + (r.offRoad ? r.offRoad.end / 1.3 : 0);
    var eta = new Date(Date.now() + remTime * 1000);
    var meta = '<b>' + fmtDist(remDist) + '</b> · ' + fmtTime(remTime) + ' · arrive ' + eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (NAV.destLabel ? ' · ' + esc(NAV.destLabel) : '');
    // next maneuver
    var k = 0; while (k < r.steps.length - 1 && NAV.stepAlong[k] <= pr.along + 6) k++;
    var st = r.steps[k], dTo = Math.max(0, NAV.stepAlong[k] - pr.along);
    var toDest = haversine(pos, NAV.dest);
    if (toDest < 30 || (k === r.steps.length - 1 && dTo < 15 && remDist < 40)) {
      if (!NAV.arrived) { NAV.arrived = true; setBanner('🏁', 'Arrived', 'You have arrived at your destination', ''); if (!silent) speak('You have arrived at your destination.'); }
      return;
    }
    NAV.arrived = false;
    var off = pr.d;
    // still at the start, off the road (inside a compound, a field ...): the dashed line leads to the road - that is
    // not "off route", and must not trigger a new route every few seconds
    if (r.offRoad && r.offRoad.start > 30 && pr.along < 15 && off <= r.offRoad.start + Math.max(30, (NAV.acc || 0))) {
      setBanner('🚶', fmtDist(off), 'Go to the road (dashed line), then: ' + st.text, meta);
      NAV.off = 0; return;
    }
    if (off > 40) { setBanner('⚠️', 'Off route', 'Returning to the route…', meta); }
    else setBanner(iconOf(st), st.type === 'arrive' ? fmtDist(dTo) : fmtDist(dTo), st.text, meta);
    if (!silent && off <= 40) {
      var band = dTo <= 40 ? 'n' : dTo <= 180 ? 'm' : dTo <= 450 ? 'f' : null;
      if (band) { var key = k + band; if (!NAV.spoken[key]) { NAV.spoken[key] = 1; speak(band === 'n' ? st.text + ' now' : 'In ' + (band === 'm' ? '200' : '500') + ' meters, ' + st.text); } }
    }
    // off-route detection
    if (off > Math.max(40, (NAV.acc || 0) * 1.3)) { NAV.off++; if (NAV.off >= 3 && Date.now() - NAV.lastReroute > 8000) { NAV.off = 0; reroute(false); } } else NAV.off = 0;
  }

  function onPosition(p) {
    var ll = [p.coords.latitude, p.coords.longitude]; NAV.lastPos = ll; NAV.acc = p.coords.accuracy;
    window.lastKnownUserPos = ll;
    // the route was made from a guess (last position, home, "I am here") or there was no position at all: the first
    // real fix replaces it at once - before, it took several "off route" fixes, or never happened
    if (NAV.active && NAV.originSrc !== 'gps' && p.coords.accuracy <= 300 && Date.now() - NAV.lastReroute > 2000) {
      NAV.originSrc = 'gps'; NAV.gpsNote = ''; reroute(true);
    }
    var map = NAV.map || googleMap;
    if (!NAV.meMarker) {
      var icon = L.divIcon({ className: 'blue-dot', html: '<div style="width:22px;height:22px;background:#10b981;border:3px solid #fff;border-radius:50%;box-shadow:0 0 10px rgba(0,0,0,.55);transform:translate(-11px,-11px)"></div>', iconSize: [0, 0] });
      NAV.meMarker = L.marker(ll, { icon: icon, zIndexOffset: 9999 }).addTo(map); window.rescuerMarker = NAV.meMarker;
    } else NAV.meMarker.setLatLng(ll);
    if (NAV.follow) { try { map.setView(ll, Math.max(map.getZoom(), 16), { animate: false }); } catch (e) { /* ignore */ } }
    updateProgress(ll, false);
  }

  window.startLiveNavigation = function (destLat, destLng, label) {
    destLat = parseFloat(destLat); destLng = parseFloat(destLng);
    if (typeof L === 'undefined') return;
    if (!isFinite(destLat) || !isFinite(destLng) || (!destLat && !destLng)) { alert('This request has no map location, so it cannot be navigated to.'); return; }
    var mapTab = document.getElementById('tab-rescue');
    if (mapTab && !mapTab.classList.contains('active') && typeof switchTab === 'function') switchTab('tab-rescue');
    if (typeof googleMap === 'undefined' || !googleMap) { requestAnimationFrame(function () { window.startLiveNavigation(destLat, destLng, label); }); return; }
    NAV.map = googleMap;
    // clean previous session (ours and the original straight-line one)
    if (NAV.active) stopInternal(true);
    try { if (typeof tacticalLine !== 'undefined' && tacticalLine) { tacticalLine.remove(); tacticalLine = null; } } catch (e) { /* ignore */ }
    try { if (typeof chatDestMarker !== 'undefined' && chatDestMarker) { chatDestMarker.remove(); chatDestMarker = null; } } catch (e) { /* ignore */ }
    NAV.active = true; AMP.navActive = true; NAV.dest = [destLat, destLng]; NAV.destLabel = label || ''; NAV.mode = NAV.mode || defaultMode(); NAV.follow = true; NAV.arrived = false; NAV.off = 0; NAV.gpsNote = '';
    var pin = L.divIcon({ className: 'target-pin', html: '<div style="font-size:34px;transform:translate(-17px,-34px)">📍</div>', iconSize: [0, 0] });
    NAV.destMarker = L.marker(NAV.dest, { icon: pin, zIndexOffset: 9998 }).addTo(googleMap); window.chatDestMarker = NAV.destMarker;
    var nc = panel(); if (nc) nc.classList.remove('hidden');
    var fb = document.getElementById('ampFindBtn'); if (fb) fb.style.display = 'none'; var fp = document.getElementById('ampFindPanel'); if (fp) fp.style.display = 'none';
    buildPanel();

    setBanner('📍', '', 'Finding your location…', '');
    getOrigin({ noGuess: true }).then(function (o) {
      NAV.originSrc = o.src; NAV.gpsNote = originNote(o);
      if (!o.ll) return { waiting: true };
      NAV.lastPos = o.ll;
      return fetchRoute(o.ll, NAV.dest, NAV.mode);
    }).then(function (r) {
      if (!NAV.active) return;
      if (r.waiting) { waitingForPosition(); startWatch(); return; }
      if (!r.ok) {
        setBanner('⚠️', '', r.error || 'No route found', '<span style="opacity:.8">Showing a straight line instead.</span>');
        if (NAV.lastPos) { NAV.layers.push(L.polyline([NAV.lastPos, NAV.dest], { color: '#1a73e8', weight: 6, opacity: .8, dashArray: '10 8' }).addTo(googleMap)); googleMap.fitBounds(L.latLngBounds([NAV.lastPos, NAV.dest]), { padding: [50, 50] }); }
        startWatch(); return;
      }
      applyRoute(r, true);
      speak(r.steps[0] ? r.steps[0].text + '. ' + fmtDist(r.distance) + ' to go.' : '');
      startWatch();
    });
  };

  // every fix of the app's position engine (browser GPS and, in the AMPING Mesh app, the phone's own receiver)
  function onEngineFix() {
    var g = window.AMP_GPS; if (!NAV.active || !g || Date.now() - g.ts > 30000) return;
    onPosition({ coords: { latitude: g.lat, longitude: g.lng, accuracy: g.acc } });
  }
  function startWatch() {
    if (!NAV.engineHooked) { NAV.engineHooked = true; window.addEventListener('amp-gps', onEngineFix); }
    try { if (!NAV.dragHooked) { NAV.dragHooked = true; NAV.map.on('dragstart', function () { NAV.follow = false; }); } } catch (e) { /* ignore */ }
    if (window.AMP_LOC && window.AMP_LOC.feed) return;    // the engine already watches the GPS for the whole app
    if (NAV.watchId !== null || !navigator.geolocation || window.isSecureContext === false) return;
    NAV.watchId = navigator.geolocation.watchPosition(onPosition, function (e) { console.warn('GPS', e && e.message); }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    window.activeWatchId = NAV.watchId;
  }

  function stopInternal(keepPanel) {
    NAV.active = false; AMP.navActive = false;
    if (NAV.watchId !== null) { try { navigator.geolocation.clearWatch(NAV.watchId); } catch (e) { /* ignore */ } NAV.watchId = null; }
    if (NAV.engineHooked) { NAV.engineHooked = false; window.removeEventListener('amp-gps', onEngineFix); }
    window.activeWatchId = null; NAV.originSrc = null;
    clearNavLayers();
    if (NAV.meMarker) { try { NAV.meMarker.remove(); } catch (e) { /* ignore */ } NAV.meMarker = null; window.rescuerMarker = null; }
    if (NAV.destMarker) { try { NAV.destMarker.remove(); } catch (e) { /* ignore */ } NAV.destMarker = null; window.chatDestMarker = null; }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    if (!keepPanel) { var p = panel(); if (p) p.classList.add('hidden'); var fb = document.getElementById('ampFindBtn'); if (fb) fb.style.display = 'flex'; }
  }
  window.stopLiveNavigation = function () {
    stopInternal(false);
    try { if (typeof tacticalLine !== 'undefined' && tacticalLine) { tacticalLine.remove(); tacticalLine = null; } } catch (e) { /* ignore */ }
    if (typeof renderRadarMap === 'function') renderRadarMap();
  };
  // the "locate me" button should also re-enable auto-follow
  var _center = window.centerMapOnUser;
  window.centerMapOnUser = function () { NAV.follow = true; if (NAV.active && NAV.lastPos && NAV.map) { NAV.map.setView(NAV.lastPos, 17); return; } if (typeof _center === 'function') return _center.apply(this, arguments); };

  /* =====================================================================
     3. FIND PLACES / NEAREST HOSPITAL ... + long-press "navigate here"
     ===================================================================== */
  function mountNavUI(map) {
    var host = document.getElementById('navControls'); host = host && host.parentElement; if (!host || document.getElementById('ampFindBtn')) { NAV.map = map; wireMap(map); return; }
    NAV.map = map;
    var btn = document.createElement('div'); btn.id = 'ampFindBtn';
    btn.style.cssText = 'position:absolute;bottom:calc(var(--mapp-nav-h,0px) + 86px + env(safe-area-inset-bottom));right:15px;width:48px;height:48px;background:#0f172a;border-radius:50%;box-shadow:0 4px 12px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:1001;cursor:pointer;font-size:22px;color:#fff';
    btn.title = 'Find a place / nearest hospital'; btn.textContent = '🧭';
    var pnl = document.createElement('div'); pnl.id = 'ampFindPanel';
    pnl.style.cssText = 'display:none;position:absolute;left:12px;right:12px;bottom:calc(var(--mapp-nav-h,0px) + 146px + env(safe-area-inset-bottom));margin-left:auto;max-width:400px;z-index:1001;background:#fff;border-radius:16px;box-shadow:0 12px 30px rgba(0,0,0,.3);padding:12px;color:#111;font-family:system-ui,sans-serif';
    var chips = [['hospital', '🏥 Hospital'], ['fire', '🚒 Fire'], ['police', '🚓 Police'], ['evac', '🏠 Evac center'], ['pharmacy', '💊 Pharmacy']].map(function (c) { return '<button data-near="' + c[0] + '" style="border:1px solid #cbd5e1;background:#f8fafc;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">' + c[1] + '</button>'; }).join('');
    pnl.innerHTML = '<div style="display:flex;gap:6px;margin-bottom:8px"><input id="ampFindInput" placeholder="Search street, barangay, hospital… or lat,lng" style="flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:9px 10px;font-size:14px;outline:none"><button id="ampFindClose" style="border:0;background:#e2e8f0;border-radius:10px;padding:0 12px;font-size:16px;cursor:pointer">✕</button></div>' +
      '<div style="display:flex;gap:6px;overflow-x:auto;margin-bottom:8px;-webkit-overflow-scrolling:touch">' + chips + '</div><div id="ampFindRes" style="max-height:34vh;overflow:auto;font-size:13px"></div>';
    host.appendChild(btn); host.appendChild(pnl);
    var input = pnl.querySelector('#ampFindInput'), res = pnl.querySelector('#ampFindRes');
    btn.onclick = function () { pnl.style.display = pnl.style.display === 'none' ? 'block' : 'none'; if (pnl.style.display === 'block') { input.focus(); } };
    pnl.querySelector('#ampFindClose').onclick = function () { pnl.style.display = 'none'; };
    var rowHtml = function (r, i) {
      var sub = [r.kind === 'poi' ? 'place' : r.kind, r.dist != null ? fmtDist(r.dist) + ' away' : '', r.duration != null ? fmtTime(r.duration) + ' by ' + (NAV.mode || defaultMode()) : ''].filter(Boolean).join(' · ');
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 2px;border-bottom:1px solid #eef2f7"><div style="flex:1;min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.name) + '</div><div style="font-size:11.5px;color:#64748b">' + esc(sub || (r.error ? r.error : '')) + '</div></div>' +
        '<button data-show="' + i + '" style="border:0;background:#e2e8f0;border-radius:8px;padding:7px 9px;cursor:pointer">👁</button><button data-go="' + i + '" style="border:0;background:#2f86ff;color:#fff;border-radius:8px;padding:7px 12px;font-weight:800;cursor:pointer">GO</button></div>';
    };
    var current = [];
    var render = function (list, msg) {
      current = list;
      res.innerHTML = list.length ? list.map(rowHtml).join('') : '<div style="padding:8px;color:#64748b">' + esc(msg || 'No results.') + '</div>';
      res.querySelectorAll('[data-go]').forEach(function (b) { b.onclick = function () { var r = current[+b.getAttribute('data-go')]; pnl.style.display = 'none'; window.startLiveNavigation(r.lat, r.lon, r.name); }; });
      res.querySelectorAll('[data-show]').forEach(function (b) { b.onclick = function () { var r = current[+b.getAttribute('data-show')]; NAV.follow = false; map.setView([r.lat, r.lon], 17); L.popup().setLatLng([r.lat, r.lon]).setContent('<b>' + esc(r.name) + '</b><br><button onclick="startLiveNavigation(' + r.lat + ',' + r.lon + ',' + JSON.stringify(r.name).replace(/"/g, '&quot;') + ')" style="margin-top:6px;background:#2f86ff;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-weight:800">🧭 Navigate</button>').openOn(map); pnl.style.display = 'none'; }; });
    };
    var timer = null;
    input.oninput = function () {
      clearTimeout(timer); var q = input.value.trim(); if (!q) { res.innerHTML = ''; return; }
      timer = setTimeout(function () {
        var m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (m) { render([{ name: 'Coordinates ' + (+m[1]).toFixed(5) + ', ' + (+m[2]).toFixed(5), kind: 'point', lat: +m[1], lon: +m[2] }]); return; }
        getOrigin({ wait: 1500 }).then(function (o) {   // search / nearest: never keep the user waiting
          if (SRC) return SRC.geocode(q, o.ll);
          return fetch('/api/geocode?q=' + encodeURIComponent(q) + '&at=' + o.ll[0] + ',' + o.ll[1], { cache: 'no-store' }).then(function (r) { return r.json(); });
        }).then(function (j) { render(j.results || [], 'Nothing found for "' + q + '".'); }).catch(function () { render([], NO_LINK); });
      }, 220);
    };
    pnl.querySelectorAll('[data-near]').forEach(function (b) {
      b.onclick = function () {
        res.innerHTML = '<div style="padding:8px;color:#64748b">Finding the nearest by road…</div>';
        getOrigin({ wait: 1500 }).then(function (o) {   // search / nearest: never keep the user waiting
          if (SRC) return SRC.nearest(b.getAttribute('data-near'), o.ll, NAV.mode || defaultMode());
          return fetch('/api/nearest?type=' + b.getAttribute('data-near') + '&at=' + o.ll[0] + ',' + o.ll[1] + '&mode=' + (NAV.mode || defaultMode()), { cache: 'no-store' }).then(function (r) { return r.json(); });
        }).then(function (j) { render((j.results || []).map(function (r) { return { name: r.name, kind: 'poi', lat: r.lat, lon: r.lon, dist: r.distance, duration: r.duration, error: r.error }; }), 'Nothing found.'); })
          .catch(function () { render([], NO_LINK); });
      };
    });
    wireMap(map);
  }

  function wireMap(map) {
    if (map.__ampWired) return; map.__ampWired = true;
    map.on('contextmenu', function (e) {
      var la = e.latlng.lat, lo = e.latlng.lng;
      var html = '<div style="min-width:170px;font-family:system-ui,sans-serif"><div style="font-size:11px;color:#64748b;margin-bottom:6px">' + la.toFixed(5) + ', ' + lo.toFixed(5) + '</div>' +
        '<button id="ampCtxGo" style="display:block;width:100%;margin-bottom:6px;background:#2f86ff;color:#fff;border:0;border-radius:8px;padding:8px;font-weight:800;cursor:pointer">🧭 Navigate here</button>' +
        '<button id="ampCtxMe" style="display:block;width:100%;background:#10b981;color:#fff;border:0;border-radius:8px;padding:8px;font-weight:800;cursor:pointer">📍 I am here</button></div>';
      var pop = L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
      setTimeout(function () {
        var g = document.getElementById('ampCtxGo'), m = document.getElementById('ampCtxMe');
        if (g) g.onclick = function () { map.closePopup(); window.startLiveNavigation(la, lo, 'Selected point'); };
        if (m) m.onclick = function () { AMP.manualOrigin = [la, lo]; map.closePopup(); if (NAV.active) { NAV.lastPos = [la, lo]; reroute(true); } else if (typeof toast === 'function') toast('Position set'); };
      }, 0);
    });
  }
})();
