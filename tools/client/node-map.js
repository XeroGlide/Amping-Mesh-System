/* AMPING field node light page (/lite): its map screen. Needs node-map-source.js first (window.AMPN, AMP_MAP_SOURCE).
   Draws the requests this user may see, the user's own GPS dot, and (via live-units.js) the response units.
   The page supplies window.AMPN_HOOKS = { requests(): [verbose requests], user(): currentUser }. */
(function () {
  'use strict';
  var S = window.AMPN.state;
  // ------------------------------------------------------------------ the map screen
  var A = window.AMPN;
  var map = null, meMarker = null, reqLayer = null, follow = true, pinMarkers = [];
  var hooks = function () { return window.AMPN_HOOKS || {}; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var COLOR = function (t) { t = String(t || '').toLowerCase(); return t.indexOf('ambul') >= 0 ? '#2563eb' : t.indexOf('evac') >= 0 ? '#f97316' : t.indexOf('relief') >= 0 ? '#10b981' : t.indexOf('hazard') >= 0 ? '#eab308' : '#dc2626'; };
  function haversine(a, b) { var R = 6371008.8, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r; var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2); return 2 * R * Math.asin(Math.min(1, Math.sqrt(x))); }
  A.haversine = haversine;
  function myLL() { var G = window.AMP_GPS; if (G && Date.now() - G.ts < 120000) return [G.lat, G.lng]; return null; }

  function chip() {
    var c = document.getElementById('mapChip'); if (!c) return;
    var t = '';
    if (S.status === 'checking') t = '🗺️ Checking the map…';
    else if (S.status === 'preparing') t = '🗺️ Preparing the map…';
    else if (S.status === 'downloading') t = S.fromApp ? '🗺️ Opening the map built into the app… ' + Math.round(S.progress * 100) + '%' : '⬇️ Saving the map to this phone… ' + Math.round(S.progress * 100) + '% (only once)';
    else if (S.status === 'nomap') t = '⚠️ This node has no map yet. The operator must upload node-map.amp at https://192.168.4.1/admin';
    else if (S.status === 'error') t = '⚠️ Map download failed: ' + esc(S.error) + ' <button onclick="AMPN.load()" style="margin-left:6px;border:0;border-radius:8px;padding:4px 10px;font-weight:800">Retry</button>';
    c.innerHTML = t; c.style.display = t ? 'block' : 'none';
  }
  A.onStatus(chip);

  function create() {
    if (map || typeof L === 'undefined') return;
    var el = document.getElementById('googleMap'); if (!el || !el.clientHeight) return;
    var u = (hooks().user && hooks().user()) || {};
    var start = myLL() || ((parseFloat(u.lat) && parseFloat(u.lon)) ? [parseFloat(u.lat), parseFloat(u.lon)] : [8.9475, 125.5406]);
    map = L.map(el, { zoomControl: false, attributionControl: false, minZoom: 9, maxZoom: 19 }).setView(start, 15);
    window.googleMap = map;
    L.control.zoom({ position: 'topright' }).addTo(map);
    window.AMPING_addBaseMap(map, [[8.62, 125.15], [9.10, 125.80]]);
    reqLayer = L.layerGroup().addTo(map);
    map.on('dragstart', function () { follow = false; });
    updateMe();
    A.renderRequests();
    if (window.AMP_LIVE && window.AMP_LIVE.render) window.AMP_LIVE.render();
  }
  function updateMe() {
    if (!map) return;
    var ll = myLL(); if (!ll) return;
    if (window.AMP_MAP && window.AMP_MAP.navActive) { if (meMarker) { map.removeLayer(meMarker); meMarker = null; } return; }   // navigation draws its own dot
    var acc = (window.AMP_GPS && window.AMP_GPS.acc) || 0;
    if (!meMarker) {
      meMarker = L.marker(ll, { zIndexOffset: 9997, icon: L.divIcon({ className: 'amp-me', iconSize: [0, 0], html: '<div style="width:18px;height:18px;transform:translate(-9px,-9px);background:#4285F4;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 6px rgba(66,133,244,.22),0 0 8px rgba(0,0,0,.4)"></div>' }) }).addTo(map).bindPopup('You are here');
    } else { meMarker.setLatLng(ll); if (!map.hasLayer(meMarker)) meMarker.addTo(map); }
    meMarker.setPopupContent('You are here' + (acc ? ' (±' + Math.round(acc) + ' m)' : ''));
  }
  window.addEventListener('amp-gps', updateMe);

  A.open = function () {
    A.load();
    setTimeout(function () {                    // after the screen became visible (not rAF: it never fires in a background tab)
      create();
      if (map) { map.invalidateSize(true); updateMe(); if (follow && myLL() && !(window.AMP_MAP && window.AMP_MAP.navActive)) map.setView(myLL(), Math.max(map.getZoom(), 15), { animate: false }); }
    }, 30);
  };
  A.locate = function () { follow = true; var ll = myLL(); if (map && ll) map.setView(ll, 17); else if (!ll) alert('Waiting for your GPS position…'); };
  A.focus = function (lat, lon) { A.whenMap(function () { follow = false; map.setView([lat, lon], 17); }); };
  A.whenMap = function (fn) { if (map) return fn(map); var n = 0; (function wait() { if (map) return fn(map); if (++n > 100) return; create(); setTimeout(wait, 100); })(); };

  function pinIcon(em) {
    return L.divIcon({ className: 'amp-pin', iconSize: [32, 48], iconAnchor: [16, 48], popupAnchor: [0, -46], html:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="32" height="48"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24c0-6.6-5.4-12-12-12z" fill="' + COLOR(em.type) + '" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="#111827" stroke="#fff" stroke-width="1.5"/></svg>' });
  }
  var pinById = {};
  A.navigateId = function (id) { var p = pinById[id]; if (p) { if (map) map.closePopup(); A.navigate(p.em); } };
  A.renderRequests = function () {
    if (!map || !reqLayer) return;
    var list = (hooks().requests && hooks().requests()) || [];
    var seen = {};
    pinMarkers = [];
    list.forEach(function (em) {
      var la = parseFloat(em.lat), lo = parseFloat(em.lon); if (!isFinite(la) || !isFinite(lo) || (!la && !lo)) return;
      var live = window.AMP_LIVE && window.AMP_LIVE.requesterOf ? window.AMP_LIVE.requesterOf(em) : null;
      var help = window.AMP_LIVE && window.AMP_LIVE.helpFor ? window.AMP_LIVE.helpFor(em) : null;
      var html = '<div style="min-width:190px;font-family:system-ui,sans-serif"><div style="font-weight:800;color:' + COLOR(em.type) + '">' + esc(String(em.type || 'Request').toUpperCase()) + '</div>' +
        '<div style="font-weight:700">' + esc(em.name || '') + '</div><div style="font-size:12px;color:#475569">' + esc([em.purok, em.barangay].filter(Boolean).join(', ')) + (em.contact ? ' · ' + esc(em.contact) : '') + '</div>' +
        '<div style="font-size:12px;margin-top:2px">Status: <b>' + esc(em.status || 'pending') + '</b>' + (em.time ? ' · ' + esc(em.time) : '') + '</div>' +
        (live ? '<div style="font-size:12px;color:#b91c1c;margin-top:2px">📍 Live position shared ' + (window.AMP_LIVE.fmtAge(live.s || 0)) + '</div>' : '') +
        (help ? '<div style="font-size:12px;color:#1d4ed8;margin-top:2px">' + esc(help.unit.n) + (help.dist != null ? ' · ' + window.AMP_LIVE.fmtDist(help.dist) + ' away' : '') + '</div>' : '') +
        '<button onclick="AMPN.navigateId(' + esc(JSON.stringify(String(em.id))) + ')" style="margin-top:8px;width:100%;background:#1a73e8;color:#fff;border:0;border-radius:8px;padding:10px;font-weight:800">🧭 Route</button></div>';
      var key = String(em.id); seen[key] = 1;
      var p = pinById[key];
      if (!p) { p = pinById[key] = { m: L.marker([la, lo], { icon: pinIcon(em), zIndexOffset: 8000 }).bindPopup(html), html: html, type: em.type }; reqLayer.addLayer(p.m); }
      else {
        p.m.setLatLng([la, lo]);
        if (p.type !== em.type) { p.m.setIcon(pinIcon(em)); p.type = em.type; }
        if (p.html !== html) { p.m.setPopupContent(html); p.html = html; }
      }
      p.em = em; pinMarkers.push(p);
    });
    Object.keys(pinById).forEach(function (k) { if (!seen[k]) { reqLayer.removeLayer(pinById[k].m); delete pinById[k]; } });
  };
  window.renderRadarMap = function () { A.renderRequests(); };
  /** route to a request: to the person's live position when they share it, else to where they asked for help */
  A.navigate = function (em) {
    var live = window.AMP_LIVE && window.AMP_LIVE.requesterOf ? window.AMP_LIVE.requesterOf(em) : null;
    var la = live ? live.la : parseFloat(em.lat), lo = live ? live.lo : parseFloat(em.lon);
    if (typeof window.showScreen === 'function') window.showScreen('map');
    A.whenMap(function () { window.startLiveNavigation(la, lo, (em.type || 'Request') + ' - ' + (em.name || '')); });
  };
  A.show = function (em) {
    if (typeof window.showScreen === 'function') window.showScreen('map');
    A.whenMap(function () {
      follow = false; map.setView([parseFloat(em.lat), parseFloat(em.lon)], 17);
      A.renderRequests();
      var p = pinById[String(em.id)]; if (p) p.m.openPopup();
    });
  };
  window.addEventListener('amp-live', function () { if (map) A.renderRequests(); });
})();
