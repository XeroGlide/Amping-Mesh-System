/* AMPING: is the radio link between the field node and the command center working?
     * on a Heltec node (everyone): "not in contact with the command center" when the node has not heard the Pi side
       for 2 minutes - requests and messages are kept on the node and sent by themselves when the link is back
     * on the Pi (responders / admins): "no field node heard" when nothing came over the radio for 10 minutes, or
       "the LoRa bridge (Heltec 1) is not connected"
     * both: "weak radio signal" when the boards hear each other only faintly (firmware 2026-10-21a measures it) -
       requests still go through, in short pieces, but it takes longer and the boards should be placed better
   A thin bar under the header; it disappears by itself when the link is fine (and can be closed for 5 minutes). */
(function () {
  'use strict';
  var bar = null, closedUntil = 0;
  function me() { try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch (e) { return null; } }
  function show(text, tone) {
    if (!document.body) return;
    if (!text || Date.now() < closedUntil) { if (bar) bar.style.display = 'none'; return; }
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'ampLinkBar';
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(64px + env(safe-area-inset-top));z-index:2147482900;width:min(94%,520px);border-radius:12px;padding:8px 34px 8px 12px;font:12.5px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25)';
      var x = document.createElement('span'); x.textContent = '✕';
      x.style.cssText = 'position:absolute;right:10px;top:7px;cursor:pointer;font-weight:800;opacity:.7';
      x.onclick = function () { closedUntil = Date.now() + 5 * 60000; bar.style.display = 'none'; };
      bar.appendChild(document.createElement('div')); bar.appendChild(x);
      document.body.appendChild(bar);
    }
    bar.firstChild.innerHTML = text;
    bar.style.background = tone === 'bad' ? '#7f1d1d' : '#78350f'; bar.style.color = '#fff';
    bar.style.display = 'block';
  }
  function ago(s) { return s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; }

  function nodeCheck() {
    var u = me(); if (!u) return show('');
    var info = window.AMP_NODE_INFO; if (!info || typeof info.link !== 'number') return;
    if (info.link >= 0 && info.link <= 120) {
      if (info.sig && info.sig.q === 'weak') return show('📶 <b>Weak radio signal to the command center</b> (SNR ' + info.sig.sa + ' dB). Your requests and messages still go through but can take longer - this node keeps sending until the command center confirms.', 'warn');
      return show('');
    }
    show('📡 <b>Not in contact with the command center</b>' + (info.link > 0 ? ' (last heard ' + ago(info.link) + ' ago)' : '') +
      '. Requests and messages you send are kept on this node and go out by themselves when the link is back.', 'warn');
  }
  function piCheck() {
    var u = me(); if (!u || !u.role || u.role === 'user') return show('');
    fetch('/api/status?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s || !s.radio) return;
      // admins: no internet on the command center = new registrations and approvals do not sync (2026-10-28)
      var adm = u.role === 'admin' || u.role === 'superadmin';
      if (adm && s.firebase && s.firebase.enabled && !s.firebase.online && s.network && s.network.verdict !== 'online')
        return show('🌐 <b>The command center has no internet.</b> ' + String(s.network.why || '').replace(/[<>&]/g, '') + ' New registrations and changes sync by themselves once it is back.', 'warn');
      if (!s.radio.connected) return show('📡 <b>The LoRa bridge (Heltec 1) is not connected to this command center</b> - requests from the field nodes cannot arrive. Check its USB cable.', 'bad');
      var at = s.radio.fieldHeardAt !== undefined ? s.radio.fieldHeardAt : s.radio.lastLoraAt;   // newer Heltec 1 reports every field contact
      var last = at ? (Date.now() - at) / 1000 : -1;
      if (s.radio.fieldHeardAt !== undefined && last > 120) return show('📡 <b>No field node heard for ' + (last < 0 ? 'a while' : ago(last)) + '.</b> Requests made on a field node cannot arrive until the radio link is back.', 'warn');
      if (last < 0) return show('📡 <b>No field node has been heard yet</b> since the command center started.', 'warn');
      if (last > 600) return show('📡 <b>No field node heard for ' + ago(last) + '.</b> Requests made on a field node may not be arriving.', 'warn');
      var sg = s.radio.signal;
      if (sg && sg.q === 'weak' && sg.heardAt && Date.now() - sg.heardAt < 300000) return show('📶 <b>Weak radio signal from the field node</b> (SNR ' + sg.snrAvg + ' dB, RSSI ' + sg.rssi + ' dBm). Requests still arrive, but slower - place Heltec 1 high at a window, away from the Pi, antennas straight up.', 'warn');
      show('');
    }).catch(function () { /* the page is not on the Pi */ });
  }
  setInterval(function () { if (window.AMP_NODE) nodeCheck(); else piCheck(); }, 15000);
  setTimeout(function () { if (window.AMP_NODE) nodeCheck(); else piCheck(); }, 4000);
})();
