/* AMPING field node (Heltec 2): the node map file inside the phone. Used by BOTH the full app the node serves
   (/amp-node.js) and the light page (/lite, /amp-map.js).
     * downloads the node's map file once (in pieces, so other phones are not blocked) and keeps it in the phone
     * (IndexedDB) - after that the map, search and routing work with no network at all
     * feeds offline-map.js through window.AMP_MAP_SOURCE (tiles, routes, search computed inside the phone)
   window.AMPN = { state, load(), onStatus(fn) } - the light page's map screen (node-map.js) adds its UI to it. */
(function () {
  'use strict';
  var NB = window.AmpNodeBundle;
  var S = { status: 'idle', progress: 0, error: '', bundle: null, loading: null };
  // Inside the AMPING Android app the map comes from the app itself (bigger, nothing to download, not stored twice)
  var APP = '';
  try { if (window.AmpingApp && typeof window.AmpingApp.mapVersion === 'function' && window.AmpingApp.mapVersion()) APP = '/__ampapp'; } catch (e) { APP = ''; }
  S.fromApp = !!APP;
  var listeners = [];
  function setStatus(st, extra) { S.status = st; if (st === 'error') S.error = extra || ''; listeners.forEach(function (f) { try { f(S); } catch (e) { /* ignore */ } }); }

  function whenReady() { return S.bundle ? Promise.resolve(S.bundle) : load(); }
  window.AMP_MAP_SOURCE = {
    meta: function () { return whenReady().then(function (b) { return b ? b.meta : null; }); },
    tile: function (g, z, x, y) { return S.bundle ? S.bundle.tile(g, z, x, y) : null; },
    route: function (from, to, mode) { return whenReady().then(function (b) { return b ? b.service.route(from[0], from[1], to[0], to[1], mode, null) : { ok: false, error: 'The map is not on this phone yet - open the Map tab while connected to the node.' }; }); },
    geocode: function (q, at) { return whenReady().then(function (b) { return { ok: true, results: b ? b.service.geocode(q, at[0], at[1], 12) : [] }; }); },
    nearest: function (type, at, mode) { return whenReady().then(function (b) { return b ? b.service.nearest(type, at[0], at[1], mode, null, 3) : { ok: false, results: [] }; }); }
  };

  // ------------------------------------------------------------------ phone-side cache (IndexedDB)
  function idb() {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('amping-node-map', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { res(null); };
        rq.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function idbGet(db, k) { return new Promise(function (res) { try { var r = db.transaction('kv', 'readonly').objectStore('kv').get(k); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; } catch (e) { res(null); } }); }
  function idbPut(db, k, v) { return new Promise(function (res) { try { var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = function () { res(true); }; t.onerror = t.onabort = function () { res(false); }; } catch (e) { res(false); } }); }

  function fetchPart(i, tries) {
    return fetch(APP + '/map/part?i=' + i, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .catch(function (e) { if (tries > 1) return new Promise(function (ok) { setTimeout(ok, 1500); }).then(function () { return fetchPart(i, tries - 1); }); throw e; });
  }

  function load() {
    if (S.bundle) return Promise.resolve(S.bundle);
    if (S.loading) return S.loading;
    S.loading = (async function () {
      setStatus('checking');
      var meta = await fetch(APP + '/map/meta.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      var db = APP ? null : await idb();
      var cached = db ? await idbGet(db, 'bundle') : null;
      var buf = null;
      if (cached && cached.buf && (!meta || cached.v === meta.nodeBuilt)) buf = cached.buf;
      else if (!meta || !meta.parts) { setStatus('nomap'); return null; }
      else {
        var raw = new Uint8Array(meta.rawSize), off = 0;
        S.progress = 0; setStatus('downloading');
        for (var i = 0; i < meta.parts.length; i++) {
          var part = new Uint8Array(await fetchPart(i, 4));
          if (off + part.length > raw.length) throw new Error('map pieces do not fit together - upload node-map.amp again');
          raw.set(part, off); off += part.length;
          S.progress = off / meta.rawSize; setStatus('downloading');
        }
        if (off !== meta.rawSize) throw new Error('map download incomplete (' + off + ' of ' + meta.rawSize + ' bytes)');
        buf = raw.buffer;
        if (db) { S.saved = await idbPut(db, 'bundle', { v: meta.nodeBuilt, buf: buf }); }
      }
      setStatus('preparing'); await new Promise(function (ok) { setTimeout(ok, 30); });   // let the page show it
      var b = NB.parse(buf);
      S.bundle = b; setStatus('ready');
      if (window.AMP_MAP && window.AMP_MAP.refresh) window.AMP_MAP.refresh();
      return b;
    })().catch(function (e) { setStatus('error', (e && e.message) || String(e)); return null; })
      .then(function (b) { S.loading = null; return b; });
    return S.loading;
  }

  window.AMPN = { state: S, load: load, onStatus: function (f) { listeners.push(f); f(S); } };
})();
