/* AMPING: nothing a phone sends may be lost on the way to the node or the Pi (2026-10-28 student test).
   The app sends an SOS, a chat or an action as small pieces with fetch() and never looked at the answer. A field node
   (Heltec 2) holds only 3 secure connections at a time and closes the oldest when another phone connects, so with
   several phones (and an EAP110 repeater in between) a piece could be cut off: the request never arrived, while the
   sender's phone said "Request Dispatched".
   Now every piece goes into an outbox kept in the phone (it survives a reload) and is sent again until the node / Pi
   answers 200. A resent piece is harmless: both servers drop pieces they already have. A small bar shows when
   something is still on its way. */
(function () {
  'use strict';
  if (window.__ampReliableSend) return; window.__ampReliableSend = true;
  var KEY = 'ampOutbox', MAX_AGE = 6 * 3600000, TRY_MS = 9000;
  var RELIABLE = /\/api\/(send_sos|send_msg|update_sos)(\?|$)/;
  var origFetch = window.fetch.bind(window);
  var box = [], busy = false, timer = null, bar = null;

  function load() { try { box = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) { box = []; } box = box.filter(function (x) { return x && x.url && Date.now() - (x.at || 0) < MAX_AGE; }); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(box)); } catch (e) { /* storage full / blocked: kept in memory */ } }
  function sameOrigin(url) { try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; } }
  function isSos(x) { return /send_sos/.test(x.url); }

  function attempt(x) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, TRY_MS);
    x.tries = (x.tries || 0) + 1; x.last = Date.now();
    return origFetch(x.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: x.body, signal: ctl ? ctl.signal : undefined, cache: 'no-store' })
      .then(function (r) { clearTimeout(to); if (r.ok || r.status === 400 || r.status === 413) done(x); return r; },
            function (e) { clearTimeout(to); throw e; });
  }
  function done(x) { var i = box.indexOf(x); if (i >= 0) { box.splice(i, 1); save(); } show(); }
  function delayFor(x) { var t = x.tries || 0; return t < 3 ? 1500 : t < 6 ? 4000 : t < 12 ? 8000 : 20000; }

  function flush() {
    timer = null;
    if (busy) return;
    var now = Date.now(), due = box.filter(function (x) { return now - (x.last || 0) >= delayFor(x); });
    // requests (SOS) first, then the rest, in the order they were made
    due.sort(function (a, b) { return (isSos(b) - isSos(a)) || (a.at - b.at); });
    if (!due.length) { schedule(); return; }
    busy = true;
    var chain = Promise.resolve();
    due.slice(0, 6).forEach(function (x) { chain = chain.then(function () { return attempt(x).catch(function () { save(); }); }); });
    chain.then(function () { busy = false; show(); schedule(); });
  }
  function schedule() { if (timer || !box.length) return; timer = setTimeout(flush, 1500); }

  function show() {
    var n = box.length, sos = box.filter(isSos).length;
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'ampOutboxBar';
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(92px + env(safe-area-inset-bottom));z-index:2147482950;max-width:92%;border-radius:12px;padding:8px 14px;font:600 12.5px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;background:#78350f;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.25);text-align:center;display:none';
      document.body.appendChild(bar);
    }
    var old = box.filter(function (x) { return (x.tries || 0) >= 2; }).length;
    if (!n || !old) { bar.style.display = 'none'; return; }
    bar.textContent = (sos ? 'Your SOS is still being sent' : 'Your message is still being sent') + ' - keep the app open and stay on the AMPING WiFi. It goes out by itself.';
    bar.style.display = 'block';
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init && init.method) || (input && input.method) || 'GET';
    if (String(method).toUpperCase() === 'POST' && RELIABLE.test(url) && sameOrigin(url) && init && typeof init.body === 'string') {
      var x = { url: new URL(url, location.href).href, body: init.body, at: Date.now(), tries: 0 };
      box.push(x); save();
      return attempt(x).then(function (r) { schedule(); return r; }, function (e) { save(); schedule(); show(); throw e; });
    }
    return origFetch(input, init);
  };
  window.ampOutbox = { size: function () { return box.length; }, flush: flush };

  load();
  if (box.length) { setTimeout(flush, 1200); }
  window.addEventListener('online', function () { flush(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });
})();
