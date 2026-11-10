/* AMPING field node: ONE connection per phone.

   The Heltec 2 serves the whole app from an ESP32-S3 with no PSRAM. Every secure connection holds about 36 KB of
   mbedTLS buffers, so the firmware can keep only THREE of them for ALL phones together, and it closes the least
   recently used one to make room for a new one (lru_purge_enable). esp_http_server also answers one request at a
   time - there is no second thread.

   A phone that asks for several things at once therefore takes the whole server for itself. Logging in is the worst
   moment: the login runs on XMLHttpRequest (/api/accounts, /api/lora_login, then /api/lora_result every 2 s) while
   the app's own sync runs on fetch (/api/bundle every 2 s) - two streams, two connections, on top of the page's own.
   With a second phone there are more connections wanted than the node has, and the purge cuts one off halfway:
   the first phone drops to "not connected" and the AMPING Mesh app shows "opening the node" and then goes back to
   its start page (student test 2026-10-31).

   This file puts every request to the node's own address in one queue - fetch and XMLHttpRequest together - so a
   phone uses one connection, re-used for every poll, and no answer is ever purged while it is still being sent.
   It is installed at the very top of <head>, above reliable-send.js, so the outbox's retries queue up as well.
   Requests to any other address are left alone, and a request that never answers frees the queue after 25 s. */
(function () {
  'use strict';
  if (window.__ampOneConn) return;
  window.__ampOneConn = true;
  var MAX_MS = 25000;                 // nothing may block the queue for longer than this
  var q = [], busy = false, served = 0;

  // Nothing starts until the page itself has arrived. The app page is the one big thing the node ever sends
  // (~290 KB), it is a plain navigation that cannot be queued, and the app's own scripts start running while it is
  // still coming in - so its first request would open a second connection and the phone would be holding two of
  // the node's three slots. With this gate a page load needs exactly one connection, however many phones arrive
  // at the same time. DOMContentLoaded means the page is fully in; the timer is only there in case it never fires.
  var open = false;
  function openGate() { if (open) return; open = true; pump(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', openGate);
    setTimeout(openGate, 20000);
  } else open = true;

  function mine(u) {
    if (u === undefined || u === null) return true;              // a relative request with no url: ours
    try { return new URL(String(u), location.href).origin === location.origin; } catch (e) { return false; }
  }
  function pump() {
    if (!open || busy || !q.length) return;
    busy = true;
    var start = q.shift(), freed = false, t = null;
    function free() {
      if (freed) return;
      freed = true; busy = false; served++;
      if (t) clearTimeout(t);
      setTimeout(pump, 0);            // one turn later: the browser has finished with the connection and re-uses it
    }
    t = setTimeout(free, MAX_MS);
    try { start(free); } catch (e) { free(); }
  }
  function enqueue(start) { q.push(start); pump(); }
  window.AMP_ONE_CONN = { waiting: function () { return q.length + (busy ? 1 : 0); }, served: function () { return served; } };

  // ------------------------------------------------------------------ fetch
  var native = window.fetch && window.fetch.bind(window);
  if (native) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (!mine(url)) return native(input, init);
      return new Promise(function (resolve, reject) {
        enqueue(function (free) {
          var p;
          try { p = native(input, init); } catch (e) { free(); reject(e); return; }
          p.then(function (r) {
            // the queue is freed when the ANSWER IS IN, not when its first bytes are: fetch() settles as soon as
            // the headers arrive, and starting the next request then would open a second connection while the node
            // is still pushing out this one. Reading a copy of the body costs nothing here (these answers are
            // small) and the caller still gets an untouched response.
            var go = function () { free(); };
            try { r.clone().arrayBuffer().then(go, go); } catch (e) { go(); }
            resolve(r);
          }, function (e) { free(); reject(e); });
        });
      });
    };
  }

  // ------------------------------------------------------------------ XMLHttpRequest (the login uses this one)
  var P = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (P && P.open && P.send) {
    var nopen = P.open, nsend = P.send;
    P.open = function (method, url) { this.__ampUrl = url; return nopen.apply(this, arguments); };
    P.send = function () {
      var self = this, args = arguments;
      if (!mine(this.__ampUrl)) return nsend.apply(self, args);
      // the queue only delays the start; xhr.timeout counts from send(), so the app's own time limit is unaffected
      enqueue(function (free) {
        try { self.addEventListener('loadend', free); } catch (e) { /* very old engine: the 25 s guard covers it */ }
        try { nsend.apply(self, args); } catch (e) { free(); throw e; }
      });
    };
  }
})();
