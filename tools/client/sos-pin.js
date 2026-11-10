/* AMPING: "Pin my exact location".
   GPS is not always exact (indoors, under roofs, cheap phones). A person with an open request can put the pin on their
   exact spot on the map; every responder's map, route line and request card follow at once.
     * the button shows on the map while the person has an open request (with the GPS accuracy on it)
     * right after an SOS whose position is not exact (worse than 50 m) the pin screen opens by itself
     * pin screen: the map moves under a fixed pin - drag the map, tap Confirm. "Use my GPS" goes back to GPS
     * the change travels as the action MOVE_SOS {id, lat, lon, mp} - the Pi, the Heltec node and the cloud copy
       all store it; responders get a short notice when a request was pinned by hand */
(function () {
  'use strict';
  var EXACT_M = 50;

  function me() { try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch (e) { return null; } }
  function list() { try { return (typeof activeEmergencies !== 'undefined' && activeEmergencies) || []; } catch (e) { return []; } }
  function getMap() { try { if (typeof googleMap !== 'undefined' && googleMap && googleMap.getCenter) return googleMap; } catch (e) { /* not yet */ } return null; }
  function isOpen(st) { st = String(st || 'pending').toLowerCase(); return st === 'pending' || st === 'dispatched' || st === 'escalated_pending' || st === 'escalated_dispatched'; }
  function mine() {
    var u = me(); if (!u) return [];
    return list().filter(function (e) { return e && isOpen(e.status) && (String(e.userId) === String(u.id) || (u.username && e.name === u.username)); });
  }
  function manual(e) { return !!(e && (e.mp || e.manualPin)); }
  function redraw() {
    try { if (typeof renderRadarMap === 'function') renderRadarMap(); } catch (e) { /* ignore */ }
    try { if (typeof renderResponderDashboards === 'function') renderResponderDashboards(); } catch (e) { /* ignore */ }
    try { if (window.AMP_LIVE) { window.AMP_LIVE.movePins && window.AMP_LIVE.movePins(); window.AMP_LIVE.updateLink && window.AMP_LIVE.updateLink(); } } catch (e) { /* ignore */ }
  }
  function toast(html, ms) {
    var t = document.getElementById('ampPinToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'ampPinToast';
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(84px + env(safe-area-inset-top));z-index:2147483100;max-width:92%;background:#0f172a;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35);text-align:center';
      document.body.appendChild(t);
    }
    t.innerHTML = html; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, ms || 4500);
  }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ------------------------------------------------------------------ apply a move (from anywhere)
  function setPos(e, lat, lon, mp) {
    e.lat = lat; e.lon = lon;
    if (mp) { e.mp = 1; e.manualPin = true; } else { delete e.mp; e.manualPin = false; }
  }
  function sameId(a, b) { a = String(a); b = String(b); return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0; }
  /** a MOVE_SOS action that came in with the messages (Heltec node) */
  window.ampMoveSos = function (o) {
    if (!o || o.id === undefined) return;
    var la = +o.lat, lo = +o.lon; if (!isFinite(la) || !isFinite(lo)) return;
    list().forEach(function (e) { if (sameId(e.id, o.id)) setPos(e, la, lo, !!o.mp); });
    redraw();
  };

  // ------------------------------------------------------------------ send my pin
  var seq = 0;
  function chunkPost(obj) {
    var json = JSON.stringify(obj), size = 90, tot = Math.ceil(json.length / size), cid = (Date.now().toString(36).slice(-5) + (++seq).toString(36) + Math.random().toString(36).slice(2, 4)).slice(0, 8);   // unique even within one millisecond
    for (var i = 0; i < tot; i++) (function (i) {
      var body = JSON.stringify({ isChk: true, id: cid, idx: i + 1, tot: tot, dat: json.substring(i * size, (i + 1) * size) });
      setTimeout(function () {
        ['/api/update_sos', '/api/send_msg'].forEach(function (p) { fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body }).catch(function () { /* offline: the cloud copy below still tries */ }); });
      }, i * 400);
    })(i);
  }
  window.ampPinSend = function (lat, lon, mp) {
    lat = +(+lat).toFixed(6); lon = +(+lon).toFixed(6);
    var mineList = mine(); if (!mineList.length) return 0;
    var saved = []; try { saved = JSON.parse(localStorage.getItem('mesh_my_sos_requests') || '[]'); } catch (e) { saved = []; }
    mineList.forEach(function (e) {
      setPos(e, lat, lon, mp);
      saved.forEach(function (s) { if (String(s.id) === String(e.id)) setPos(s, lat, lon, mp); });
      chunkPost({ action: 'MOVE_SOS', id: String(e.id), lat: lat, lon: lon, mp: mp ? 1 : 0, ts: Date.now() });
      try { if (typeof rtdb !== 'undefined' && rtdb && rtdb.ref) rtdb.ref('emergencies/' + e.id).update({ lat: lat, lon: lon, manualPin: !!mp, pinnedAt: mp ? Date.now() : null }).catch(function () { /* offline */ }); } catch (err) { /* no cloud */ }
    });
    try { localStorage.setItem('mesh_my_sos_requests', JSON.stringify(saved)); } catch (e) { /* storage full */ }
    redraw();
    try { window.dispatchEvent(new Event('amp-gps')); } catch (e) { /* ignore */ }   // the live dot responders see follows at once
    return mineList.length;
  };

  // ------------------------------------------------------------------ the pin screen
  var ui = null;
  try { var st = document.createElement('style'); st.textContent = 'body.amp-pinning #ampLiveChip{display:none!important}'; (document.head || document.documentElement).appendChild(st); } catch (e) { /* ignore */ }
  function buildUi(map) {
    var host = map.getContainer();
    if (ui && ui.host === host) return ui;
    var pin = document.createElement('div');
    pin.style.cssText = 'position:absolute;left:50%;top:50%;z-index:1200;pointer-events:none;display:none;transform:translate(-50%,-100%)';
    pin.innerHTML = '<svg width="44" height="62" viewBox="0 0 24 36"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24c0-6.6-5.4-12-12-12z" fill="#dc2626" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>' +
      '<div style="position:absolute;left:50%;bottom:-5px;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:rgba(0,0,0,.35)"></div>';
    var top = document.createElement('div');
    top.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);top:12px;z-index:1201;display:none;max-width:92%;background:#0f172a;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:9px 14px;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.35);text-align:center';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:14px;z-index:2147483050;display:none;gap:8px;flex-wrap:wrap;justify-content:center';
    bar.innerHTML = '<button data-a="ok" style="flex:2 1 180px;padding:14px;border:0;border-radius:14px;background:#16a34a;color:#fff;font:800 15px system-ui,sans-serif;box-shadow:0 6px 16px rgba(0,0,0,.3)">✅ Confirm my location here</button>' +
      '<button data-a="gps" style="flex:1 1 120px;padding:14px;border:0;border-radius:14px;background:#2563eb;color:#fff;font:700 14px system-ui,sans-serif;box-shadow:0 6px 16px rgba(0,0,0,.3)">🛰️ Use my GPS</button>' +
      '<button data-a="no" style="flex:1 1 90px;padding:14px;border:0;border-radius:14px;background:#475569;color:#fff;font:700 14px system-ui,sans-serif;box-shadow:0 6px 16px rgba(0,0,0,.3)">Cancel</button>';
    var fab = document.createElement('button');
    fab.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:2147483040;display:none;padding:11px 16px;border:0;border-radius:999px;background:#dc2626;color:#fff;font:800 13px system-ui,sans-serif;box-shadow:0 6px 16px rgba(0,0,0,.35);max-width:calc(100% - 140px);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    host.appendChild(pin); host.appendChild(top); document.body.appendChild(bar); document.body.appendChild(fab);
    ['click', 'dblclick', 'mousedown', 'touchstart', 'pointerdown', 'wheel'].forEach(function (ev) { [bar, fab].forEach(function (el) { el.addEventListener(ev, function (x) { x.stopPropagation(); }); }); });
    bar.addEventListener('click', function (x) {
      var a = x.target && x.target.getAttribute && x.target.getAttribute('data-a'); if (!a) return;
      if (a === 'ok') { var c = map.getCenter(); var n = window.ampPinSend(c.lat, c.lng, true); close(); toast(n ? '📍 Your exact location was sent to the responders.' : 'You have no open request to pin.'); }
      else if (a === 'gps') {
        var g = (window.AMP_LOC && window.AMP_LOC.best(60000)) || window.AMP_GPS;
        if (!g) { toast('No GPS position yet - please pin your location by hand.'); return; }
        window.ampPinSend(g.lat, g.lng, false); close(); toast('🛰️ Your request follows your GPS again (±' + Math.round(g.acc) + ' m).');
      }
      else close();
    });
    fab.addEventListener('click', function () { open(''); });
    ui = { host: host, pin: pin, top: top, bar: bar, fab: fab, map: map, active: false };
    return ui;
  }
  /** where the visible map ends at the bottom: above a fixed bar (tab bar) that covers it, else the map's own edge */
  function clearBottom(host) {
    var vh = window.innerHeight, r = host.getBoundingClientRect(), bottom = Math.min(vh, r.bottom);
    try {
      var x = Math.round(window.innerWidth / 2);
      var el = (document.elementsFromPoint ? document.elementsFromPoint(x, Math.min(vh, r.bottom) - 4) : [document.elementFromPoint(x, Math.min(vh, r.bottom) - 4)])
        .filter(function (e) { return e && !(ui && (ui.bar.contains(e) || ui.fab.contains(e))); })[0];   // never measure our own buttons
      while (el && el !== document.body && !host.contains(el)) {
        var cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'sticky') { bottom = Math.min(bottom, el.getBoundingClientRect().top); break; }
        el = el.parentElement;
      }
    } catch (e) { /* ignore */ }
    return Math.max(0, vh - bottom) + 12;
  }
  function placeBars() { if (!ui) return; var b = clearBottom(ui.host) + 'px'; ui.bar.style.bottom = b; ui.fab.style.bottom = b; }
  window.addEventListener('resize', function () { placeBars(); });
  function open(reason) {
    var map = getMap(); if (!map) return;
    buildUi(map);
    var em = mine()[0];
    var g = (window.AMP_LOC && window.AMP_LOC.best(60000)) || window.AMP_GPS;
    var start = em && manual(em) ? [em.lat, em.lon] : g ? [g.lat, g.lng] : em ? [em.lat, em.lon] : null;
    try { if (typeof switchTab === 'function') switchTab('tab-rescue'); } catch (e) { /* ignore */ }
    // set the view, and once more after the map's own redraw - unless the person has already moved the map
    var touched = false, onTouch = function () { touched = true; };
    ['pointerdown', 'touchstart', 'mousedown', 'wheel'].forEach(function (ev) { ui.host.addEventListener(ev, onTouch, { once: true, passive: true }); });
    var aim = function () {
      if (!ui.active || !start || touched) return;
      try { map.invalidateSize(); map.setView(start, Math.max(map.getZoom(), 18), { animate: false }); } catch (e) { /* ignore */ }
    };
    setTimeout(aim, 60); setTimeout(aim, 600);
    try { document.body.classList.add('amp-pinning'); } catch (e) { /* ignore */ }
    ui.active = true;
    ui.top.innerHTML = (reason ? reason + '<br>' : '') + 'Move the map until the <b style="color:#fca5a5">red pin</b> is on your exact spot, then tap <b>Confirm</b>.';
    ui.pin.style.display = 'block'; ui.top.style.display = 'block'; ui.bar.style.display = 'flex'; ui.fab.style.display = 'none';
    placeBars(); setTimeout(placeBars, 650);
    ui.bar.querySelector('[data-a="gps"]').style.display = (em && manual(em)) ? '' : 'none';
  }
  function close() { if (!ui) return; ui.active = false; try { document.body.classList.remove('amp-pinning'); } catch (e) { /* ignore */ } ui.pin.style.display = 'none'; ui.top.style.display = 'none'; ui.bar.style.display = 'none'; tick(); }
  window.ampPinOpen = open;

  /** called right after an SOS: a position worse than 50 m opens the pin screen */
  window.ampAfterSos = function (acc) {
    if (acc != null && acc <= EXACT_M) return;
    setTimeout(function () {
      open(acc == null ? '📍 Your phone could not find your GPS position.' : '📍 Your GPS position is only accurate to about ' + Math.round(acc) + ' m.');
    }, 400);
  };

  /** after an SOS sent with a rough position: for 30 s, a clearly better GPS reading moves the request there
      (never over a pin placed by hand) */
  window.ampRefineSos = function (sent) {
    if (!sent) return;
    var sentAcc = sent.acc, sentAt = Date.now(), last = [sent.lat, sent.lng];
    function dist(a, b) { var r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), y = (b[0] - a[0]) * r; return Math.sqrt(x * x + y * y) * 6371008.8; }
    function check() {
      if (Date.now() - sentAt > 30000) { window.removeEventListener('amp-gps', check); return; }
      var b = window.AMP_LOC && window.AMP_LOC.best(10000); if (!b) return;
      if (!(b.acc <= EXACT_M && b.acc * 2 <= sentAcc)) return;
      var em = mine()[0]; if (!em || manual(em)) { window.removeEventListener('amp-gps', check); return; }
      if (dist(last, [b.lat, b.lng]) < 5) { sentAcc = b.acc; return; }
      sentAcc = b.acc; last = [b.lat, b.lng];
      window.ampPinSend(b.lat, b.lng, false);
      if (ui && ui.active) close();
      toast('🛰️ Your GPS found your exact position (±' + Math.round(b.acc) + ' m) - your request was updated.');
    }
    window.addEventListener('amp-gps', check);
  };

  // ------------------------------------------------------------------ the button + responders' notices
  var seen = {};
  function tick() {
    var map = getMap();
    if (map) {
      buildUi(map);
      var em = mine()[0];
      if (!ui.active) {
        var mapShown = (function () { var r = ui.host.getBoundingClientRect(); return r.width > 50 && r.height > 50 && ui.host.offsetParent !== null; })();
        if (em && mapShown) {
          placeBars();
          var g = window.AMP_GPS;
          ui.fab.innerHTML = manual(em) ? '📍 Location pinned by hand · change' : '📍 Pin my exact location' + (g ? ' <span style="font-weight:600;opacity:.85">(GPS ±' + Math.round(g.acc) + ' m)</span>' : '');
          ui.fab.style.display = 'block';
        } else ui.fab.style.display = 'none';
      }
    }
    // responders / admins: say when a request was pinned by hand (once per new pin)
    var u = me(), staff = u && u.role && u.role !== 'user';
    list().forEach(function (e) {
      if (!e || e.id === undefined) return;
      var key = String(e.id), sig = manual(e) ? (+e.lat).toFixed(5) + ',' + (+e.lon).toFixed(5) : '';
      if (seen[key] === undefined) { seen[key] = sig; return; }
      if (sig && seen[key] !== sig && staff && isOpen(e.status)) {
        toast('📍 <b>' + esc(e.name || 'A resident') + '</b> pinned their exact location - the map is updated.', 6000);
        redraw();
      }
      seen[key] = sig;
    });
  }
  setInterval(tick, 1500);
})();
