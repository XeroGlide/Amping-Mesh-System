/* AMPING live positions - shared by the Pi web app and the Heltec field node page.
     * responders (ambulance / evacuation / rescue / relief) share their GPS position every few seconds;
       everybody sees the response units moving on the map
     * a resident with an open request shares their position too, so responders can find them;
       only responders and admins receive those positions (never other residents)
   The server side is /api/pos (POST) and /api/positions (GET) - on the Pi (amping-server.js) and on Heltec 2,
   which relays positions over LoRa in both directions.  Config: window.AMP_LIVE_CFG = { myActive(): [requests] }. */
(function () {
  'use strict';
  var CFG = window.AMP_LIVE_CFG || {};
  var RESP = { ambulance: 1, evacuation: 1, rescue: 1, relief: 1 };
  var STAFF = { ambulance: 1, evacuation: 1, rescue: 1, relief: 1, admin: 1, authority: 1, superadmin: 1 };
  var ICON = { ambulance: '🚑', evacuation: '🚤', rescue: '🛟', relief: '📦' };
  var COLOR = { ambulance: '#2563eb', evacuation: '#f97316', rescue: '#dc2626', relief: '#10b981' };
  var TEAM = { ambulance: 'Ambulance', evacuation: 'Evacuation', rescue: 'Rescue', relief: 'Relief' };
  var POLL_MS = CFG.pollMs || 4000, POST_EVERY_MS = 25000, POST_MOVE_M = 8;

  // FNV-1a 32-bit over the UTF-8 bytes of the account id, base 36 - the short id used on the radio link
  function hashId(s) {
    s = unescape(encodeURIComponent(String(s == null ? '' : s)));
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function haversine(a, b) { var R = 6371008.8, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r; var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2); return 2 * R * Math.asin(Math.min(1, Math.sqrt(x))); }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmtDist = function (m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.max(5, Math.round(m / 5) * 5) + ' m'; };
  var fmtAge = function (s) { s = Math.max(0, Math.round(s)); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
  function deptOf(type) { var t = String(type || '').toLowerCase(); return t.indexOf('ambul') >= 0 ? 'ambulance' : t.indexOf('evac') >= 0 ? 'evacuation' : t.indexOf('relief') >= 0 ? 'relief' : (t.indexOf('rescue') >= 0 || t.indexOf('hazard') >= 0) ? 'rescue' : ''; }
  function isActive(st) { st = String(st || 'pending').toLowerCase(); return st === 'pending' || st === 'dispatched' || st === 'escalated_pending' || st === 'escalated_dispatched'; }

  var LIVE = window.AMP_LIVE = { units: [], requesters: [], hash: hashId, deptOf: deptOf, fmtDist: fmtDist, fmtAge: fmtAge, lastOkAt: 0, at: 0 };

  function me() { if (window.AMP_CURRENT_USER) return window.AMP_CURRENT_USER; try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch (e) { return null; } }
  function myActive() {
    var u = me(); if (!u) return [];
    if (typeof CFG.myActive === 'function') { try { return (CFG.myActive() || []).filter(function (e) { return isActive(e.status); }); } catch (e) { return []; } }
    var list = []; try { list = (typeof activeEmergencies !== 'undefined' && activeEmergencies) || []; } catch (e) { list = []; }
    return list.filter(function (e) { return (String(e.userId) === String(u.id) || (u.username && e.name === u.username)) && isActive(e.status); });
  }
  // (window.googleMap can also be the <div id="googleMap"> element itself - only accept a real Leaflet map)
  function getMap() {
    var isMap = function (m) { return m && typeof m.addLayer === 'function' && typeof m.getContainer === 'function'; };
    try { if (typeof googleMap !== 'undefined' && isMap(googleMap)) return googleMap; } catch (e) { /* not declared yet */ }
    return isMap(window.googleMap) ? window.googleMap : null;
  }
  // a phone lying still may not report a new fix for a while; its last fix is still where it is (age is sent along)
  // The map's blue dot has its own GPS watch: whichever fix is newer is "where I am", so what is shared with
  // the responders is exactly what the phone shows.
  var myDot = null;
  function myPos() {
    var G = window.AMP_GPS, g = (G && Date.now() - G.ts < 120000) ? G : null;
    var d = (myDot && Date.now() - myDot.ts < 120000) ? myDot : null;
    if (g && d) return d.ts >= g.ts ? d : g;
    return g || d;
  }

  // ------------------------------------------------------------------ share my position
  var lastSent = null;
  function postTick() {
    var u = me(); if (!u || !u.id) return;
    var role = String(u.role || 'user');
    var sharing = RESP[role] ? 'unit' : myActive().length ? 'requester' : '';
    LIVE.sharing = sharing;
    if (!sharing) return;
    var p = myPos();
    if (sharing === 'requester') {
      var pinned = myActive().filter(function (e) { return e.mp || e.manualPin; })[0];
      if (pinned && isFinite(parseFloat(pinned.lat)) && isFinite(parseFloat(pinned.lon))) p = { lat: parseFloat(pinned.lat), lng: parseFloat(pinned.lon), acc: 5, ts: Date.now() };
    }
    if (!p || !(p.acc <= 300)) return;
    var now = Date.now();
    if (lastSent && now - lastSent.t < POST_EVERY_MS && haversine([lastSent.la, lastSent.lo], [p.lat, p.lng]) < POST_MOVE_M) return;
    lastSent = { t: now, la: p.lat, lo: p.lng };
    var body = JSON.stringify({ id: String(u.id), h: hashId(u.id), n: String(u.username || u.name || 'User').slice(0, 24), r: role, la: +p.lat.toFixed(6), lo: +p.lng.toFixed(6), a: Math.round(p.acc || 0), ag: Math.round((now - p.ts) / 1000) });
    // refused (e.g. the request has not reached the server yet) or failed -> try again on the next 5 s tick
    try { fetch('/api/pos', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, cache: 'no-store' }).then(function (r) { if (!r.ok) lastSent = null; }).catch(function () { lastSent = null; }); } catch (e) { lastSent = null; }
  }

  // ------------------------------------------------------------------ receive everybody's positions
  var busy = false;
  // the open requests this viewer can see (a resident's live position is only shown next to one of these)
  function visibleRequests() {
    if (typeof CFG.requests === 'function') { try { return CFG.requests() || []; } catch (e) { return []; } }
    var list = []; try { list = (typeof activeEmergencies !== 'undefined' && activeEmergencies) || []; } catch (e) { list = []; }
    return list.filter(function (e) { return isActive(e.status); });
  }
  function apply(j) {
    var u = me(); if (!u || !j) return;
    var mine = hashId(u.id);
    LIVE.units = (j.u || []).filter(function (x) { return x && x.h !== mine && RESP[x.r] && isFinite(x.la) && isFinite(x.lo); });
    var reqs = STAFF[u.role] ? visibleRequests() : [];
    LIVE.requesters = STAFF[u.role] ? (j.q || []).filter(function (x) { return x && x.h !== mine && isFinite(x.la) && isFinite(x.lo) && reqs.some(function (em) { return matches(x, em); }); }) : [];
    LIVE.lastOkAt = LIVE.at = Date.now();
    render();
    try { window.dispatchEvent(new CustomEvent('amp-live', { detail: LIVE })); } catch (e) { /* ignore */ }
  }
  /** the field node page gets positions inside its combined /api/state poll and hands them over here */
  LIVE.ingest = apply;
  function pollTick() {
    var u = me(); if (!u || busy || CFG.external) return;
    busy = true;
    fetch('/api/positions?r=' + encodeURIComponent(u.role || 'user') + '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { busy = false; apply(j); })
      .catch(function () { busy = false; });
  }

  /** nearest response unit of the department that handles this request type */
  LIVE.helpFor = function (em) {
    var d = deptOf(em && em.type); if (!d) return null;
    var at = (em && isFinite(parseFloat(em.lat)) && parseFloat(em.lat)) ? [parseFloat(em.lat), parseFloat(em.lon)] : null;
    var best = null;
    LIVE.units.forEach(function (x) {
      if (x.r !== d) return;
      var dist = at ? haversine(at, [x.la, x.lo]) : null;
      if (!best || (dist !== null && dist < best.dist)) best = { unit: x, dist: dist, age: (x.s || 0) + (Date.now() - LIVE.at) / 1000 };
    });
    return best;
  };
  /** live position of the person who sent this request (responders / admins only) */
  // is live position x the person who made request em?  (short id, else id cut short by an old app, else name - cut to 15 on the radio)
  function matches(x, em) {
    if (!x || !em) return false;
    var uid = String(em.userId != null ? em.userId : (em.uid || ''));
    if (uid && x.h === hashId(uid)) return true;
    if (uid.length >= 12 && x.id && String(x.id).indexOf(uid) === 0) return true;
    var nm = String(em.name || '').trim().toLowerCase(), rn = String(x.n || '').trim().toLowerCase();
    return !!(nm && rn && (rn === nm || (rn.length >= 12 && nm.indexOf(rn) === 0)));
  }
  LIVE.requesterOf = function (em) {
    if (!em) return null;
    for (var pass = 0; pass < 2; pass++) for (var i = 0; i < LIVE.requesters.length; i++) {
      var x = LIVE.requesters[i];
      if (pass === 0 ? x.h === hashId(em.userId != null ? em.userId : (em.uid || '')) : matches(x, em)) return x;
    }
    return null;
  };

  // Where a request's pin stands: on the person's live position while it is fresh - their own GPS for the person who
  // asked (so the pin sits on their blue dot), the shared live position for responders - else where it was sent from.
  LIVE.pinPos = function (em) {
    if (!em) return null;
    if (em.mp || em.manualPin) { var pl = parseFloat(em.lat), po = parseFloat(em.lon); if (isFinite(pl) && isFinite(po)) return [pl, po]; }   // pinned by hand
    var u = me(), g = window.AMP_GPS;
    if (u && em.userId != null && String(em.userId) === String(u.id)) {
      // my own request: the pin stands ON my blue dot, however long the phone has been lying still
      if (myDot && isFinite(myDot.lat) && isFinite(myDot.lng)) return [myDot.lat, myDot.lng];
      if (g && Date.now() - g.ts < 60000 && !g.approx && isFinite(g.lat) && isFinite(g.lng)) return [g.lat, g.lng];
    }
    var x = LIVE.requesterOf(em);
    if (x && isFinite(x.la) && isFinite(x.lo) && Date.now() - LIVE.at < 120000 && !(x.ag > 600)) return [x.la, x.lo];
    return null;
  };

  // ------------------------------------------------------------------ request pins follow the live position
  // The map places a pin when the request list changes; between those moments the person moves. Every pin is
  // remembered here and moved whenever my own GPS or the shared positions change.
  var pins = [];
  LIVE.trackPin = function (em, marker) { if (em && marker) pins.push({ em: em, m: marker }); };
  function movePins() {
    var map = getMap(); if (!map) return;
    pins = pins.filter(function (p) { return map.hasLayer(p.m); });          // the map threw the old ones away
    pins.forEach(function (p) {
      var ll = LIVE.pinPos(p.em); if (!ll) return;
      var at = p.m.getLatLng();
      if (Math.abs(at.lat - ll[0]) > 1e-7 || Math.abs(at.lng - ll[1]) > 1e-7) p.m.setLatLng(ll);
    });
  }
  LIVE.movePins = movePins;
  /** called by the map's blue-dot GPS watch with every fix */
  LIVE.onMyDot = function (pos) {
    if (!pos || !pos.coords) return;
    myDot = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: Date.now(), approx: false };
    movePins();
    updateLink();
  };

  // ------------------------------------------------------------------ the automatic blue line
  // Requester and responder both see the road route between them, drawn by itself the moment both positions are
  // known - no button. It follows the roads (the same offline route finder as the navigation) from the responder
  // to the requester, and is redrawn when either of them has moved 20 m or more.
  //   * a resident with an open request: from the nearest unit of the team that handles it, to themselves
  //   * a responder: from themselves to the nearest open request of their own team (one already dispatched first)
  // While turn-by-turn navigation is running it steps aside - the navigation draws its own line.
  var LINK_MOVE_M = 20, LINK_MAX_AGE_MS = 60000;
  var link = { layers: [], from: null, to: null, at: 0, busy: false, sig: '' };
  LIVE.link = null;                                    // {dist, time, straight, road} for whoever wants to show it
  function num(v) { v = parseFloat(v); return isFinite(v) ? v : null; }
  function emPos(em) { var p = LIVE.pinPos(em); if (p) return p; var la = num(em.lat), lo = num(em.lon != null ? em.lon : em.lng); return (la !== null && lo !== null && (la || lo)) ? [la, lo] : null; }
  function linkEnds() {
    var u = me(); if (!u) return null;
    var p = myPos(), here = p ? [p.lat, p.lng] : null;
    if (RESP[u.role]) {
      if (!here) return null;
      var best = null;
      visibleRequests().forEach(function (em) {
        if (deptOf(em.type) !== u.role) return;
        var at = emPos(em); if (!at) return;
        var sent = /dispatched/.test(String(em.status || '').toLowerCase()) ? 0 : 1, d = haversine(here, at);
        if (!best || sent < best.sent || (sent === best.sent && d < best.d)) best = { em: em, at: at, sent: sent, d: d };
      });
      return best ? { a: here, b: best.at, id: 'r' + best.em.id, name: String(best.em.name || 'the requester'), type: best.em.type } : null;
    }
    var mine = myActive(), out = null;
    mine.forEach(function (em) {
      if (out) return;
      var h = LIVE.helpFor(em); if (!h) return;
      var at = emPos(em) || here; if (!at) return;
      out = { a: [h.unit.la, h.unit.lo], b: at, id: 'q' + em.id + h.unit.h };
    });
    return out;
  }
  function clearLink() {
    link.layers.forEach(function (l) { try { l.remove(); } catch (e) { /* ignore */ } });
    link.layers = []; link.from = link.to = null; link.sig = ''; LIVE.link = null;
  }
  function drawLink(map, ends, r) {
    link.layers.forEach(function (l) { try { l.remove(); } catch (e) { /* ignore */ } });
    link.layers = [];
    var add = function (pts, o) { var l = L.polyline(pts, o).addTo(map); link.layers.push(l); return l; };
    var straight = haversine(ends.a, ends.b);
    if (r && r.ok && r.geometry && r.geometry.length > 1) {
      add(r.geometry, { color: '#0a2a66', weight: 9, opacity: .55, lineCap: 'round', lineJoin: 'round', interactive: false });
      add(r.geometry, { color: '#2f86ff', weight: 5.5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false });
      // the short walk between the road and each of the two people
      var g0 = r.snappedFrom || r.geometry[0], g1 = r.snappedTo || r.geometry[r.geometry.length - 1];
      if (haversine(ends.a, g0) > 8) add([ends.a, g0], { color: '#2f86ff', weight: 4, dashArray: '2 8', opacity: .9, interactive: false });
      if (haversine(g1, ends.b) > 8) add([g1, ends.b], { color: '#2f86ff', weight: 4, dashArray: '2 8', opacity: .9, interactive: false });
      LIVE.link = { road: true, dist: r.distance, time: r.duration, straight: straight, name: ends.name, type: ends.type };
    } else {
      // no road found between them (or the map is not on this phone yet): a straight dashed line still shows the way
      add([ends.a, ends.b], { color: '#2f86ff', weight: 5, dashArray: '10 10', opacity: .95, lineCap: 'round', interactive: false });
      LIVE.link = { road: false, dist: straight, time: null, straight: straight, name: ends.name, type: ends.type };
    }
  }
  function updateLink() {
    var map = getMap(); if (!map || typeof L === 'undefined') return;
    if (window.AMP_MAP && window.AMP_MAP.navActive) { if (link.layers.length) clearLink(); return; }
    var ends = linkEnds();
    if (!ends) { if (link.layers.length) clearLink(); return; }
    var now = Date.now();
    var fresh = link.sig === ends.id && link.from && haversine(link.from, ends.a) < LINK_MOVE_M && haversine(link.to, ends.b) < LINK_MOVE_M && now - link.at < LINK_MAX_AGE_MS;
    if (fresh) { link.layers.forEach(function (l) { if (!map.hasLayer(l)) l.addTo(map); }); return; }
    if (link.busy) return;
    var done = function (r) {
      link.busy = false;
      if (window.AMP_MAP && window.AMP_MAP.navActive) return;
      link.sig = ends.id; link.from = ends.a; link.to = ends.b; link.at = Date.now();
      drawLink(map, ends, r);
      try { renderChip(map); } catch (e) { /* ignore */ }
    };
    var find = window.AMP_MAP && window.AMP_MAP.fetchRoute;
    if (!find || haversine(ends.a, ends.b) < 25) return done(null);       // standing together: nothing to route
    link.busy = true;
    // the road route can take a moment (on a node the phone first has to open its saved map): show the
    // direction at once with a straight dashed line, the road line replaces it when it is ready
    if (!link.layers.length || link.sig !== ends.id) { drawLink(map, ends, null); link.sig = ends.id; try { renderChip(map); } catch (e) { /* ignore */ } }
    var t = setTimeout(function () { if (link.busy) done(null); }, 12000);   // never leave the map without a line
    Promise.resolve().then(function () { return find(ends.a, ends.b, 'car'); })
      .then(function (r) { clearTimeout(t); if (link.busy) done(r); })
      .catch(function () { clearTimeout(t); if (link.busy) done(null); });
  }
  LIVE.updateLink = updateLink;

  // ------------------------------------------------------------------ draw on the Leaflet map
  var layer = null, markers = {}, chip = null;
  function unitIcon(x, mine, age) {
    var col = COLOR[x.r] || '#334155', stale = age > 300;
    return L.divIcon({ className: 'amp-unit', iconSize: [0, 0], html:
      '<div style="transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;opacity:' + (stale ? .55 : 1) + '">' +
      '<div style="width:' + (mine ? 40 : 34) + 'px;height:' + (mine ? 40 : 34) + 'px;border-radius:50%;background:' + col + ';border:3px solid ' + (mine ? '#facc15' : '#fff') + ';box-shadow:0 2px 8px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-size:' + (mine ? 20 : 17) + 'px">' + (ICON[x.r] || '🚩') + '</div>' +
      '<div style="margin-top:2px;background:rgba(15,23,42,.88);color:#fff;font:700 10.5px system-ui,sans-serif;padding:2px 6px;border-radius:6px;white-space:nowrap">' + esc(x.n || TEAM[x.r]) + (mine ? ' · for your request' : '') + '</div></div>' });
  }
  function reqIcon(x) {
    return L.divIcon({ className: 'amp-req-live', iconSize: [0, 0], html:
      '<div style="transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center"><div style="width:18px;height:18px;border-radius:50%;background:#ef4444;border:3px solid #fff;box-shadow:0 0 0 6px rgba(239,68,68,.25),0 2px 6px rgba(0,0,0,.4)"></div>' +
      '<div style="margin-top:2px;background:#fff;color:#991b1b;font:700 10px system-ui,sans-serif;padding:1px 5px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)">' + esc(x.n || 'Requester') + ' (live)</div></div>' });
  }
  function render() {
    var map = getMap(); if (!map || typeof L === 'undefined') return;
    if (!layer) { layer = L.layerGroup().addTo(map); }
    else if (!map.hasLayer(layer)) layer.addTo(map);
    var mineDept = {}; myActive().forEach(function (e) { var d = deptOf(e.type); if (d) mineDept[d] = 1; });
    var seen = {}, extra = (Date.now() - LIVE.at) / 1000;
    LIVE.units.forEach(function (x) {
      var key = 'u' + x.h, age = (x.s || 0) + extra; seen[key] = 1;
      var mine = !!mineDept[x.r];
      var pop = '<b>' + (ICON[x.r] || '') + ' ' + esc(x.n || TEAM[x.r]) + '</b><br>' + esc(TEAM[x.r] || x.r) + ' team · updated ' + fmtAge(age) + (x.a ? ' · ±' + Math.round(x.a) + ' m' : '');
      var m = markers[key];
      if (!m) { m = markers[key] = L.marker([x.la, x.lo], { icon: unitIcon(x, mine, age), zIndexOffset: 9000 }).bindPopup(pop); layer.addLayer(m); }
      else { m.setLatLng([x.la, x.lo]); m.setIcon(unitIcon(x, mine, age)); m.setPopupContent(pop); }
    });
    LIVE.requesters.forEach(function (x) {
      var key = 'q' + x.h, age = (x.s || 0) + extra; seen[key] = 1;
      var pop = '<b>📍 ' + esc(x.n || 'Requester') + '</b><br>Live position of the person who asked for help · ' + fmtAge(age) + (x.a ? ' · ±' + Math.round(x.a) + ' m' : '') +
        '<br><button onclick="window.startLiveNavigation&&window.startLiveNavigation(' + x.la + ',' + x.lo + ',' + JSON.stringify(String(x.n || 'Requester')).replace(/"/g, '&quot;') + ')" style="margin-top:6px;background:#2f86ff;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-weight:800">🧭 Navigate</button>';
      var m = markers[key];
      if (!m) { m = markers[key] = L.marker([x.la, x.lo], { icon: reqIcon(x), zIndexOffset: 9500 }).bindPopup(pop); layer.addLayer(m); }
      else { m.setLatLng([x.la, x.lo]); m.setPopupContent(pop); }
    });
    Object.keys(markers).forEach(function (k) { if (!seen[k]) { layer.removeLayer(markers[k]); delete markers[k]; } });
    movePins();
    updateLink();
    renderChip(map);
  }
  // residents with an open request: "🚑 Ambulance Team · 1.2 km away · 20 s ago"
  function renderChip(map) {
    var u = me(); var act = (u && !STAFF[u.role]) ? myActive() : [];
    var lines = [], doneDept = {};
    act.forEach(function (e) {
      var d0 = deptOf(e.type); if (doneDept[d0]) return; doneDept[d0] = 1;     // one line per team
      var h = LIVE.helpFor(e);
      var K = LIVE.link, way = (K && K.road && lines.length === 0) ? ' · ' + fmtDist(K.dist) + ' by road' + (K.time ? ' (about ' + Math.max(1, Math.round(K.time / 60)) + ' min)' : '') : (h && h.dist !== null ? ' · ' + fmtDist(h.dist) + ' from you' : '');
      if (h) lines.push((ICON[h.unit.r] || '') + ' <b>' + esc(h.unit.n || TEAM[h.unit.r]) + '</b>' + way + ' · ' + fmtAge(h.age));
      else if (deptOf(e.type)) lines.push('⏳ No ' + TEAM[deptOf(e.type)] + ' unit is sharing its location yet');
    });
    // a responder: where the line on the map leads, and how far it is
    if (u && RESP[u.role] && LIVE.link && LIVE.link.name) {
      var K2 = LIVE.link;
      lines.push('🧭 To <b>' + esc(K2.name) + '</b> · ' + fmtDist(K2.dist) + (K2.road ? ' by road' + (K2.time ? ' (about ' + Math.max(1, Math.round(K2.time / 60)) + ' min)' : '') : ' in a straight line'));
    }
    var host = map.getContainer();
    if (!lines.length) { if (chip) chip.style.display = 'none'; return; }
    if (!chip || chip.parentNode !== host) {
      chip = document.createElement('div'); chip.id = 'ampLiveChip';
      chip.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);top:' + (CFG.chipTop || 64) + 'px;z-index:1000;max-width:92%;background:rgba(15,23,42,.92);color:#fff;font:12.5px/1.45 system-ui,sans-serif;padding:8px 12px;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:none;text-align:center';
      host.appendChild(chip);
    }
    chip.style.display = 'block';
    // staff also have the "There is 1 person requesting..." box up there: sit below it, not on it
    var top = CFG.chipTop || 64;
    try { var sb = document.getElementById('mapStatsBox'); if (sb && sb.offsetParent) top = Math.max(top, Math.round(sb.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 8)); } catch (e) { /* ignore */ }
    chip.style.top = top + 'px';
    chip.innerHTML ='<div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.7;margin-bottom:2px">' + ((u && RESP[u.role]) ? 'Route to the request' : 'Help for your request') + '</div>' + lines.join('<br>') +
      (LIVE.sharing === 'requester' ? '<div style="font-size:11px;opacity:.75;margin-top:3px">📍 Your live location is shared with responders until the request is closed</div>' : '');
  }
  LIVE.render = render;
  LIVE.focusUnits = function () { var map = getMap(); if (!map || !LIVE.units.length) return false; var b = L.latLngBounds(LIVE.units.map(function (x) { return [x.la, x.lo]; })); var p = myPos(); if (p) b.extend([p.lat, p.lng]); map.fitBounds(b.pad(0.2), { maxZoom: 16 }); return true; };

  setInterval(postTick, 5000);
  setInterval(pollTick, POLL_MS);
  setTimeout(function () { postTick(); pollTick(); }, 1500);
  window.addEventListener('amp-gps', postTick);
  window.addEventListener('amp-gps', function () { updateLink(); });
  setInterval(updateLink, 5000);
})();
