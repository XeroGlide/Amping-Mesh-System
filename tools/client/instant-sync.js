/* AMPING instant updates (command center only).
   The app syncs with the Pi every 2 s, so a new SOS / chat / dispatch waited up to 2 s on the phone after it had
   reached the Pi. Here ONE request stays open at the Pi (GET /api/wait?v=N); the Pi answers it the moment anything
   changes, the app syncs at once, and the next request opens. The normal 2-second sync keeps running as the backup.
   Not used on the Heltec field node (window.AMP_NODE): its small server cannot hold a waiting request per phone. */
(function () {
  'use strict';
  var ver = 0, backoff = 1000, running = false;
  function loop() {
    if (window.AMP_NODE) return;
    running = true;
    fetch('/api/wait?v=' + ver, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || typeof j.v !== 'number') throw new Error('bad reply');
        var changed = ver !== 0 && j.v !== ver;
        ver = j.v; backoff = 1000;
        if (changed && typeof window.syncPiDatabase === 'function') { try { window.syncPiDatabase(); } catch (e) { /* the app reports its own errors */ } }
        setTimeout(loop, 0);
      })
      .catch(function () { setTimeout(loop, backoff); backoff = Math.min(backoff * 2, 15000); });
  }
  function start() { if (!running && !window.AMP_NODE) loop(); }
  setTimeout(start, 1500);
  // a phone that slept: the open request is gone - start a fresh one (and catch up) right away
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { ver = 0; } });
})();
