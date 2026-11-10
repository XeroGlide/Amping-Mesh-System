/* AMPING field node (Heltec 2): lets the FULL command-center app run on the node - no Firebase, no Pi needed.
   Part of /amp-node.js (with map-service.js, node-bundle.js, node-map-source.js), loaded before the app's own scripts.
     * the app's 2-second sync asked for 5 things (accounts, messages, settings, requests, map markers); here it is ONE
       small request (/api/bundle) - and "nothing changed" answers are a few bytes, so 10 phones do not load the node
     * live positions arrive inside that same request
     * the node's map file is saved into the phone once after login; a small banner shows the progress */
(function () {
  'use strict';
  window.AMP_NODE = true;
  window.AMP_LIVE_CFG = Object.assign({ external: true }, window.AMP_LIVE_CFG || {});
  function me() { try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch (e) { return null; } }

  // ------------------------------------------------------------------ one request per sync
  var ver = 0, parts = null, cur = null;
  function fetchBundle() {
    var u = me();
    return fetch('/api/bundle?v=' + ver + '&r=' + encodeURIComponent((u && u.role) || 'user') + '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return null;
        if (j.same && !parts) { ver = 0; return null; }            // lost our copy: ask for everything next time
        if (!j.same) { ver = j.v; parts = { accounts: j.a || [], messages: j.m || [], emergencies: j.e || [], settings: j.s || {}, infra: {} }; }
        window.AMP_NODE_INFO = j.node || null;
        if (j.p && window.AMP_LIVE && window.AMP_LIVE.ingest) { try { window.AMP_LIVE.ingest(j.p); } catch (e) { /* ignore */ } }
        return parts;
      })
      .catch(function () { return null; });
  }
  // The app asks for a sync every 2 seconds. The node answers one request at a time, so with a classroom of phones
  // that is the whole little server busy with "nothing changed". One real request every ~4 s is plenty here: what
  // the node is waiting for travels by radio and takes far longer than that. The offset is random per phone so a
  // dozen of them do not all knock at the same moment. Anything the person does calls ampNodeRefresh() (below),
  // so their own SOS or message still appears at once.
  var HOLD_MS = 3200 + Math.floor(Math.random() * 1600);
  /** the next pull asks the node again instead of re-using the last answer */
  window.ampNodeRefresh = function () { cur = null; };
  ['focus', 'online'].forEach(function (e) { window.addEventListener(e, window.ampNodeRefresh); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) window.ampNodeRefresh(); });
  // what the person just sent must come back on the very next sync, not up to 4 s later
  if (window.fetch) {
    var pass = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var u = String((typeof input === 'string' ? input : (input && input.url)) || '');
      var p = pass(input, init);
      if (/\/api\/(send_sos|send_msg|update_sos|pos|sync_settings)(\?|$)/.test(u)) p.then(window.ampNodeRefresh, function () { });
      return p;
    };
  }

  /** used by the app's syncPiDatabase() instead of fetch('/api/...'): same Response objects, one network request */
  window.ampNodePull = function (api) {
    if (!cur || Date.now() - cur.t > HOLD_MS) cur = { t: Date.now(), p: fetchBundle() };
    var key = String(api).replace(/^\/api\//, '').replace(/[?#].*$/, '');
    return cur.p.then(function (P) {
      if (!P || P[key] === undefined) return null;
      return new Response(JSON.stringify(P[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  };

  // ------------------------------------------------------------------ the node's map file, saved into the phone after login
  var chip = null;
  function showChip(S) {
    var t = '';
    var mapOpen = !!(document.getElementById('tab-rescue') && document.getElementById('tab-rescue').classList.contains('active'));
    if (S.status === 'downloading') t = S.fromApp ? '🗺️ Opening the map built into the app… ' + Math.round(S.progress * 100) + '%' : '⬇️ Saving the offline map to this phone… ' + Math.round(S.progress * 100) + '% (only once)';
    else if (S.status === 'preparing') t = '🗺️ Preparing the offline map…';
    else if (S.status === 'nomap' && mapOpen) t = '⚠️ This node has no map yet - the operator uploads node-map.amp at https://192.168.4.1/admin';
    else if (S.status === 'error' && mapOpen) t = '⚠️ Map download failed: ' + String(S.error || '').replace(/[<>&]/g, '') + ' <button onclick="AMPN.load()" style="margin-left:6px;border:0;border-radius:8px;padding:3px 10px;font-weight:800">Retry</button>';
    if (!t) { if (chip) chip.style.display = 'none'; return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(10px + env(safe-area-inset-top));z-index:2147483000;max-width:92%;background:rgba(15,23,42,.94);color:#fff;font:12.5px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.35);text-align:center';
      document.body.appendChild(chip);
    }
    chip.innerHTML = t; chip.style.display = 'block';
  }
  var started = false;
  setInterval(function () {
    if (!window.AMPN) return;
    if (!started && me()) { started = true; window.AMPN.onStatus(showChip); setTimeout(function () { window.AMPN.load(); }, 1500); }
    else if (started) showChip(window.AMPN.state);
  }, 3000);
})();
