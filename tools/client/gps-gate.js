/* AMPING GPS gate - the app needs the phone's location, but must never keep the user waiting for it.
   The screen is only blocked for things the user has to DO: answer the permission question, un-block location,
   switch the phone's Location on, open the secure page. Waiting for the satellites is not one of them: the app
   opens at once with the phone's estimated position (the last / network one, there within a second) and the exact
   GPS position replaces it in the background. A small note says so until the position is exact.
   Shared by the Pi web app and the Heltec node page (ES5, no dependencies).
   Config comes from window.AMP_CFG = { requireGps, https, httpsPort, insecureSkip }. */
(function () {
  'use strict';
  var cfg = window.AMP_CFG || {};

  // ==================================================================== the position engine (always on)
  // ONE place that knows where the phone is. Fed by the browser's GPS (a watch that runs from the first second, so
  // a position is ready long before anybody presses SOS) and, inside the AMPING Mesh app, by the phone's own
  // satellite receiver through window.AMP_NATIVE_FIX - faster and more exact than what the web view reports.
  //   AMP_LOC.best(ms)  the most exact reading of the last ms
  //   AMP_LOC.get({want, wait})  resolves at once if a reading of 'want' metres or better is fresh, otherwise
  //                              waits up to 'wait' ms for one, then gives the best it has (or null)
  var LOC = window.AMP_LOC = window.AMP_LOC || {};
  var ROUGH = 150, fixes = [];
  function fresh(ms) { var now = Date.now(); return fixes.filter(function (x) { return now - x.ts <= ms; }); }
  LOC.feed = function (lat, lng, acc, ageMs, src) {
    lat = +lat; lng = +lng; acc = +acc;
    if (!isFinite(lat) || !isFinite(lng) || !(acc > 0) || (!lat && !lng)) return;
    var ts = Date.now() - Math.max(0, +ageMs || 0);
    if (Date.now() - ts > 10 * 60000) return;                        // a reading from long ago says nothing
    fixes.push({ lat: lat, lng: lng, acc: acc, ts: ts, src: src || 'web' });
    fixes = fixes.filter(function (x) { return Date.now() - x.ts < 120000; }).slice(-60);
    var old = window.AMP_GPS;
    if (old && ts < old.ts) return;                                   // older than what we show
    // a rough reading never replaces a clearly better one from a moment ago
    if (old && ts - old.ts < 30000 && acc > ROUGH && acc > old.acc * 2) return;
    window.AMP_GPS = { lat: lat, lng: lng, acc: acc, ts: ts, approx: acc > ROUGH, src: src || 'web' };
    window.lastKnownUserPos = [lat, lng];
    try { window.dispatchEvent(new Event('amp-gps')); } catch (e) { /* ignore */ }
  };
  LOC.best = function (ms) {
    var list = fresh(ms || 20000), b = null;
    list.forEach(function (x) { if (!b || x.acc < b.acc || (x.acc === b.acc && x.ts > b.ts)) b = x; });
    return b;
  };
  LOC.get = function (o) {
    o = o || {}; var want = o.want || 25, wait = o.wait == null ? 6000 : o.wait;
    return new Promise(function (resolve) {
      var done = false, t = null;
      function finish(x) { if (done) return; done = true; clearTimeout(t); window.removeEventListener('amp-gps', check); resolve(x); }
      function check() { var b = LOC.best(15000); if (b && b.acc <= want) finish(b); }
      check(); if (done) return;
      window.addEventListener('amp-gps', check);
      // wake the satellite receiver up in case nothing is watching yet
      try { navigator.geolocation.getCurrentPosition(function (p) { LOC.feed(p.coords.latitude, p.coords.longitude, p.coords.accuracy, 0, 'web'); }, function () { /* the watch reports errors */ }, { enableHighAccuracy: true, timeout: Math.max(1000, wait), maximumAge: 0 }); } catch (e) { /* ignore */ }
      t = setTimeout(function () {
        var b = LOC.best(15000) || LOC.best(60000), g = window.AMP_GPS;
        finish(b || (g && Date.now() - g.ts < 300000 ? g : null));
      }, wait);
    });
  };
  // the AMPING Mesh app hands over the phone's own satellite / network fixes
  window.AMP_NATIVE_FIX = function (lat, lng, acc, ageMs, src) { LOC.native = true; LOC.feed(lat, lng, acc, ageMs, src || 'native'); };
  try { if (window.AmpingApp && typeof window.AmpingApp.startLocation === 'function') window.AmpingApp.startLocation(); } catch (e) { /* older app */ }
  try {
    if (navigator.geolocation && window.isSecureContext !== false) {
      navigator.geolocation.watchPosition(function (p) {
        var age = p.timestamp ? Date.now() - p.timestamp : 0; if (!(age >= 0 && age < 600000)) age = 0;
        LOC.feed(p.coords.latitude, p.coords.longitude, p.coords.accuracy, age, 'web');
      }, function () { /* the gate below explains problems */ }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    }
  } catch (e) { /* ignore */ }

  // ==================================================================== the gate (only where GPS is required)
  if (cfg.requireGps === false) return;
  var host = location.hostname;
  if (cfg.exemptLocal !== false && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) return;            // the Pi's own screen

  var ACC_OK = 150;               // metres: a fix at least this good counts as exact (coarser = "estimated")
  var ASK_MS = 4000;              // the permission question is given this long before the app opens anyway
  var G = window.AMP_GATE = { state: 'init', fix: null, approx: false };
  var ov = null, box = null, watchId = null, startedAt = 0, lastState = '';
  try { G.approx = sessionStorage.getItem('ampGpsApprox') === '1'; } catch (e) { /* ignore */ }

  var platform = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'other';
  var secure = window.isSecureContext !== false;

  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html !== undefined) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function build() {
    if (ov) return;
    ov = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483600;background:rgba(9,14,30,.97);color:#fff;display:none;overflow:auto;-webkit-overflow-scrolling:touch;font-family:system-ui,-apple-system,Segoe UI,sans-serif');
    ov.setAttribute('role', 'alertdialog'); ov.setAttribute('aria-live', 'assertive'); ov.id = 'ampGpsGate';
    box = el('div', 'max-width:440px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 22px 40px;text-align:center');
    ov.appendChild(box); document.body.appendChild(ov);
  }
  function show(state, title, icon, body, buttons) {
    build(); G.state = state; lastState = state;
    var h = '<div style="font-size:64px;line-height:1;margin:18px 0 10px">' + icon + '</div><h2 style="font-size:22px;margin:0 0 10px;font-weight:800">' + title + '</h2>' +
      '<div style="font-size:14.5px;line-height:1.5;opacity:.92;text-align:left;background:rgba(255,255,255,.06);border-radius:14px;padding:14px 16px;margin:14px 0">' + body + '</div>';
    box.innerHTML = h;
    (buttons || []).forEach(function (b) {
      var btn = el('button', 'display:block;width:100%;margin:10px 0 0;padding:15px;border:0;border-radius:14px;font-size:16px;font-weight:800;cursor:pointer;color:#fff;background:' + (b.secondary ? '#334155' : '#16a34a'), esc(b.label));
      btn.onclick = b.onclick; box.appendChild(btn);
    });
    ov.style.display = 'block';
    try { document.documentElement.style.overflow = 'hidden'; } catch (e) { /* ignore */ }
  }
  function hide() {
    if (!ov) return; ov.style.display = 'none'; G.state = 'ok'; lastState = 'ok';
    try { document.documentElement.style.overflow = ''; } catch (e) { /* ignore */ }
  }
  function steps(list) { return '<ol style="margin:8px 0 0;padding-left:20px">' + list.map(function (s) { return '<li style="margin:5px 0">' + s + '</li>'; }).join('') + '</ol>'; }

  // ---- screens
  function insecureScreen() {
    if (cfg.https) {
      var url = 'https://' + host + (cfg.httpsPort && cfg.httpsPort !== 443 ? ':' + cfg.httpsPort : '') + location.pathname + location.search;
      show('insecure', 'Secure connection needed for GPS', '🔒',
        'Phones only share their GPS with <b>secure (https)</b> pages. Tap the green button.<br><br>Your browser will warn that the connection is <b>not private</b> - this is normal here: it is the emergency network\'s own address, not the internet.' +
        steps(['Tap <b>Advanced</b> (or <b>Show details</b>)', 'Tap <b>Proceed / Continue to ' + esc(host) + '</b>', 'Log in again (only needed once), then tap <b>Allow</b> for location']),
        [{ label: '🔒 Open the secure page', onclick: function () { location.href = url; } }]);
      box.appendChild(el('div', 'font-size:12.5px;opacity:.7;margin-top:14px;line-height:1.4', 'Seeing this inside a “Sign in to network” pop-up? If the button does not work there, open <b>Chrome</b> (Android) or <b>Safari</b> (iPhone) and type <b>' + esc(url.replace(/^https:\/\//, '')) + '</b>'));
    } else {
      var b = [];
      if (cfg.insecureSkip) b.push({ label: 'Continue without GPS (uses my registered home)', secondary: true, onclick: function () { G.skipped = true; hide(); } });
      show('insecure', 'GPS cannot be used on this page', '📍',
        'This page is not on a secure (https) address, and browsers refuse to share GPS with such pages.' +
        (platform === 'android' ? '<br><br><b>One-time fix (Chrome on Android):</b>' + steps(['Open a new tab and go to <b>chrome://flags/#unsafely-treat-insecure-origin-as-secure</b>', 'Type <b>http://' + esc(host) + '</b> in the box and set it to <b>Enabled</b>', 'Tap <b>Relaunch</b>, then open this page again and tap <b>Allow</b> for location']) :
          '<br><br>Ask the operator to enable the secure (https) address, or use Chrome on Android with the flag <b>unsafely-treat-insecure-origin-as-secure</b>.'), b);
    }
  }
  var permState = '', askTimer = null;
  // help = the browser's question has not been answered after a few seconds (often it never appeared)
  function askingScreen(help) {
    var body = 'Your phone is asking for permission to use your location. Tap <b>Allow</b> (choose <b>precise</b> location if it asks).<br><br>Accurate location is how rescuers find you.';
    if (help) {
      body += '<br><br><b>No question appeared, or nothing happens?</b>' + (platform === 'ios' ?
        steps(['Tap <b>aA</b> (or the icon left of the address) > <b>Website Settings</b> > <b>Location</b> > <b>Allow</b>', 'Phone <b>Settings</b> > <b>Privacy &amp; Security</b> > <b>Location Services</b>: <b>On</b>, and <b>Safari Websites</b>: <b>While Using</b> + <b>Precise</b>', 'Come back and tap the green button']) :
        steps(['Tap the <b>icon left of the web address</b> (lock or crossed circle) > <b>Permissions</b> (or Site settings) > <b>Location</b> > <b>Allow</b>', 'Phone <b>Settings</b> > <b>Apps</b> > <b>Chrome</b> > <b>Permissions</b> > <b>Location</b> > <b>Allow only while using the app</b>, and turn on <b>Use precise location</b>', 'Make sure the phone\'s <b>Location</b> is on (swipe down from the top), then tap the green button']));
    }
    if (permState) body += '<div style="margin-top:10px;font-size:12px;opacity:.7">Browser location permission for this page: <b>' + esc(permState) + '</b></div>';
    show('asking', 'Allow location', '📍', body, [{ label: '📍 Share my location', onclick: function () { recheck(); } }]);
  }
  function deniedScreen() {
    var how = platform === 'ios' ?
      steps(['Open <b>Settings</b> > <b>Privacy &amp; Security</b> > <b>Location Services</b> and make sure it is <b>On</b>', 'Scroll to <b>Safari Websites</b> (or your browser) and choose <b>While Using the App</b>, turn on <b>Precise Location</b>', 'Come back here and tap the button below']) :
      steps(['Tap the <b>lock / settings icon</b> next to the web address', 'Tap <b>Permissions</b> (or Site settings) > <b>Location</b> > <b>Allow</b>', 'If asked, also allow <b>precise</b> location', 'Come back here and tap the button below']);
    show('denied', 'Location is blocked', '🚫', 'You blocked location for this page. The app cannot find you on the map or send rescuers to you without it.' + how,
      [{ label: '✅ I turned it on - try again', onclick: recheck }]);
  }
  function unavailableScreen() {
    var how = platform === 'ios' ? steps(['Open <b>Settings</b> > <b>Privacy &amp; Security</b> > <b>Location Services</b>', 'Turn <b>Location Services</b> <b>On</b>', 'Come back here and tap the button below']) :
      steps(['Swipe down from the top of the screen to open quick settings', 'Tap <b>Location</b> (GPS) so it turns <b>on</b> - in Settings choose <b>High accuracy</b> / <b>Use precise location</b>', 'Come back here and tap the button below']);
    show('unavailable', 'Turn on your phone\'s Location (GPS)', '📡', 'Your phone\'s location service is switched off or has no signal.' + how,
      [{ label: '✅ I turned it on - try again', onclick: recheck },
       // no signal is not the user's fault: the app stays usable (an SOS then goes out with the registered home address)
       { label: 'Use the app for now', secondary: true, onclick: function () { G.skipped = true; hide(); setNote('none'); } }]);
  }
  // ---- the small note shown instead of a blocking "finding your exact position" screen
  var note = null, noteKind = '', noteTimer = null;
  function setNote(kind, acc) {
    if (kind === noteKind) return;                      // say each thing once, for a few seconds
    noteKind = kind;
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
    if (!kind) { if (note) note.style.display = 'none'; return; }
    if (!note) {
      note = el('div', 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(92px + env(safe-area-inset-bottom));z-index:2147483000;max-width:92%;background:rgba(15,23,42,.92);color:#fff;font:12.5px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;padding:7px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.3);pointer-events:none;text-align:center;white-space:nowrap');
      note.id = 'ampGpsNote'; document.body.appendChild(note);
    }
    note.innerHTML = kind === 'none' ? '📍 Finding your location…' : '📍 Estimated location (±' + Math.round(acc) + ' m) · getting more exact…';
    note.style.display = 'block';
    noteTimer = setTimeout(function () { if (note) note.style.display = 'none'; }, 8000);
  }
  function unsupportedScreen() {
    show('unsupported', 'This browser cannot share location', '⚠️', 'Please open this page in <b>Chrome</b> (Android) or <b>Safari</b> (iPhone).', []);
  }

  // ---- GPS logic
  function accept(pos) {
    var c = pos.coords;
    hide();                                             // any position at all opens the app
    G.fix = pos;
    LOC.feed(c.latitude, c.longitude, c.accuracy, 0, 'web');
  }
  // every reading - browser or the app's own GPS - opens the app and updates the small note
  window.addEventListener('amp-gps', function () {
    var g = window.AMP_GPS; if (!g) return;
    if (!G.fix) G.fix = { coords: { latitude: g.lat, longitude: g.lng, accuracy: g.acc } };
    if (lastState !== 'ok' && lastState !== '') hide();
    setNote(g.acc > ACC_OK ? 'approx' : '', g.acc);
  });
  function onFix(pos) { accept(pos); }
  function onErr(e) {
    if (e && e.code === 1) return deniedScreen();
    if (e && e.code === 2) { if (G.fix || G.skipped) return; return unavailableScreen(); }   // lost signal after a fix: keep working
    // timeout: no position yet - the app opens anyway and the search goes on in the background
    if (lastState !== 'denied' && lastState !== 'unavailable' && permState !== 'prompt') { hide(); if (!window.AMP_GPS) setNote('none'); }
  }
  // the estimate: last known / network position - answers in well under a second on most phones
  function quickFix() {
    try { navigator.geolocation.getCurrentPosition(onFix, function () { /* the exact request reports errors */ }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }); } catch (e) { /* ignore */ }
  }
  function startWatch() {
    if (watchId !== null) { try { navigator.geolocation.clearWatch(watchId); } catch (e) { /* ignore */ } watchId = null; }
    watchId = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  function recheck() {
    if (!navigator.geolocation) return unsupportedScreen();
    if (!secure) return insecureScreen();
    startedAt = Date.now();
    if (permState === 'granted') hide();                 // already allowed: nothing to ask, straight into the app
    else if (lastState !== 'ok') askingScreen(false);
    clearTimeout(askTimer);
    askTimer = setTimeout(function () {
      if (lastState !== 'asking') return;
      if (permState === 'prompt') askingScreen(true);    // the question is really still open: show how to answer it
      else { hide(); if (!window.AMP_GPS) setNote('none'); }   // allowed (or the browser cannot say): open the app
    }, ASK_MS);
    quickFix();
    try { navigator.geolocation.getCurrentPosition(function (p) { onFix(p); startWatch(); }, function (e) { onErr(e); startWatch(); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }); }
    catch (e) { unavailableScreen(); }
  }
  G.recheck = recheck;
  // while blocked, quietly ask the phone again every 10 s (location may have been switched on meanwhile)
  function probe() {
    if ((lastState === 'ok' && window.AMP_GPS) || lastState === 'insecure' || lastState === 'unsupported' || document.hidden) return;   // open without a position yet: keep asking
    try { navigator.geolocation.getCurrentPosition(function (p) { onFix(p); startWatch(); }, onErr, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }); } catch (e) { /* ignore */ }
  }

  // ---- inside the AMPING Mesh app on a plain-http page (the field node, app 1.5+): the web view may not use GPS
  // there, but the app itself does (window.AMP_NATIVE_FIX). Only what the person has to DO blocks the screen: allow
  // the app's location permission, or switch the phone's Location on. The app reports both in AmpingApp.status().
  var NATIVE = !!(window.AmpingApp && typeof window.AmpingApp.status === 'function' && typeof window.AmpingApp.startLocation === 'function');
  function appState() { try { return JSON.parse(window.AmpingApp.status()) || {}; } catch (e) { return {}; } }
  function appCheck() {
    var st = appState();
    if (st.location === false) {
      if (lastState === 'app-perm') return;
      return show('app-perm', 'Allow location', '📍', 'The AMPING Mesh app needs your location so rescuers can find you.<br><br>Tap the green button and choose <b>Allow</b> (and <b>Precise</b> if it asks).',
        [{ label: '📍 Allow location', onclick: function () { try { window.AmpingApp.askLocation(); } catch (e) { /* ignore */ } } }]);
    }
    if (st.locationOn === false && !G.skipped) {
      if (lastState === 'app-off') return;
      return show('app-off', 'Turn on your phone\'s Location (GPS)', '📡', 'Your phone\'s Location is switched off, so rescuers cannot see where you are.',
        [{ label: '📡 Open Location settings', onclick: function () { try { window.AmpingApp.openLocationSettings(); } catch (e) { /* ignore */ } } },
         { label: 'Use the app for now', secondary: true, onclick: function () { G.skipped = true; hide(); setNote('none'); } }]);
    }
    if (lastState !== 'ok') {
      hide();
      try { window.AmpingApp.startLocation(); } catch (e) { /* ignore */ }
      if (!window.AMP_GPS) setNote('none');
    }
  }

  function init() {
    build();
    if (!secure && NATIVE) {
      appCheck();
      setInterval(appCheck, 3000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) appCheck(); });
      return;
    }
    if (!navigator.geolocation) return unsupportedScreen();
    if (!secure) return insecureScreen();
    // if the permission is already blocked we can say so right away instead of waiting for a failed request
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
          permState = p.state;
          if (p.state === 'denied') deniedScreen();
          else if (p.state === 'granted' && lastState === 'asking') { hide(); if (!window.AMP_GPS) setNote('none'); }
          p.onchange = function () { permState = p.state; if (p.state === 'granted' || p.state === 'prompt') recheck(); else deniedScreen(); };
        }).catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
    recheck();
    setInterval(probe, 10000);
    // a phone lying still may stop reporting fixes; ask again every 30 s so the shared position stays current
    setInterval(function () {
      if (lastState === 'ok' && window.AMP_GPS && Date.now() - window.AMP_GPS.ts > 30000) {
        try { navigator.geolocation.getCurrentPosition(onFix, function () { /* the watch reports errors */ }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }); } catch (e) { /* ignore */ }
      }
    }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && lastState !== 'ok') recheck(); });
    window.addEventListener('focus', function () { if (lastState !== 'ok') recheck(); });
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
