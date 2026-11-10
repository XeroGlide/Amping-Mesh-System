/* AMPING notifications - the same in the AMPING Mesh app (Android) and in any browser.
     * new private message to me, new message in a request chat I am part of, new official (LGU) broadcast
     * app on screen: a banner at the top (tap = open that chat) + a short buzz
     * app in the background: a real phone notification
         - AMPING Mesh app: Android's own notification (window.AmpingApp.notify)
         - browser: the service worker /amp-sw.js (Android Chrome cannot show one without it), else new Notification()
     * the SOS alarm (window.triggerUnifiedAlarm) uses the same path when the app is in the background
   Messages are noticed by watching the app's message list (allMessages), which the 2-second sync keeps current - also
   while the app is in the background (slower, see the patch "sync-in-background"). */
(function () {
  'use strict';
  var APP = function () { return window.AmpingApp && typeof window.AmpingApp.notify === 'function'; };
  function me() { try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch (e) { return null; } }
  function msgs() { try { return (typeof allMessages !== 'undefined' && allMessages) || []; } catch (e) { return []; } }
  function ems() { try { return (typeof activeEmergencies !== 'undefined' && activeEmergencies) || []; } catch (e) { return []; } }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function plain(s) { var d = document.createElement('div'); d.innerHTML = String(s == null ? '' : s); return (d.textContent || '').trim(); }

  // ------------------------------------------------------------------ the browser's notification service worker
  var swReg = null;
  try {
    if (!APP() && 'serviceWorker' in navigator && window.isSecureContext) {
      // On the field node the page load must not compete with anything: its server keeps three connections for all
      // phones together, so the worker is fetched only once the app is up and the first phones are quiet again.
      var reg = function () { navigator.serviceWorker.register('/amp-sw.js', { scope: '/' }).then(function (r) { swReg = r; }).catch(function () { /* the server has none */ }); };
      if (window.AMP_NODE) setTimeout(reg, 20000); else reg();
    }
  } catch (e) { /* ignore */ }
  // the browser asks for permission only after a tap (browsers refuse the question otherwise)
  function askOnce() {
    document.removeEventListener('click', askOnce, true);
    try { if (!APP() && 'Notification' in window && Notification.permission === 'default' && window.isSecureContext) Notification.requestPermission(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('click', askOnce, true);

  /** a phone / desktop notification (only used while the app is not on screen) */
  function systemNotify(title, body, tag, urgent) {
    if (APP()) { try { window.AmpingApp.notify(String(title), String(body), String(tag || 'amping'), !!urgent); return true; } catch (e) { return false; } }
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return false;
      var opts = { body: body, tag: tag || 'amping', renotify: true, requireInteraction: !!urgent, icon: '/vendor/img/767242790_2584290141989037_3631061154976649797_n.png', vibrate: urgent ? [800, 300, 800, 300, 800] : [200, 100, 200] };
      if (swReg && swReg.showNotification) { swReg.showNotification(title, opts); return true; }
      new Notification(title, opts); return true;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------------ the in-app banner
  var bar = null, barTimer = null;
  function banner(title, body, onTap) {
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'ampNotifyBar';
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(10px + env(safe-area-inset-top));z-index:2147483200;width:min(94%,460px);background:#0f172a;color:#fff;border-radius:14px;box-shadow:0 10px 28px rgba(0,0,0,.4);padding:10px 14px;font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;display:none';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<div style="font-weight:800;font-size:13.5px;margin-bottom:2px">' + esc(title) + '</div><div style="opacity:.9;max-height:3.9em;overflow:hidden">' + esc(body) + '</div><div style="font-size:11px;opacity:.6;margin-top:4px">Tap to open</div>';
    bar.onclick = function () { bar.style.display = 'none'; try { onTap && onTap(); } catch (e) { /* ignore */ } };
    bar.style.display = 'block';
    clearTimeout(barTimer); barTimer = setTimeout(function () { if (bar) bar.style.display = 'none'; }, 7000);
    try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([120, 60, 120]); } catch (e) { /* ignore */ }
  }

  /** one notification, shown the right way for where the person is */
  window.ampNotify = function (n) {
    if (!n) return;
    if (document.hidden) { if (systemNotify(n.title, n.body, n.tag, n.urgent)) return; }
    if (!n.urgent) banner(n.title, n.body, n.open);           // the SOS has its own siren + screen
  };

  // the SOS alarm: in the background it now reaches the phone in the app and in Android browsers too
  var origAlarm = window.triggerUnifiedAlarm;
  if (typeof origAlarm === 'function') {
    window.triggerUnifiedAlarm = function (title, body, isEmergency) {
      var r = origAlarm.apply(this, arguments);
      if (document.hidden && (APP() || swReg)) systemNotify(title, body, 'mesh-emergency-alert', !!isEmergency);
      return r;
    };
  }

  // ------------------------------------------------------------------ which new messages concern me
  var ROLE_DEPT = { ambulance: 'ambul', evacuation: 'evac', rescue: 'rescue', relief: 'relief' };
  function requestOf(id) { var out = null; ems().forEach(function (e) { if (e && String(e.id) === String(id)) out = e; }); return out; }
  function concernsMe(m, u) {
    if (!m || m.isDeleted) return null;
    var myId = String(u.id);
    if (m.channel === 'private') {
      if (String(m.receiverId || '') !== myId || String(m.senderId || '') === myId) return null;
      var open = (function () { try { return document.getElementById('activeChatWrapper') && document.getElementById('activeChatWrapper').style.display === 'flex' && typeof currentTargetUser !== 'undefined' && currentTargetUser && String(currentTargetUser.id) === String(m.senderId); } catch (e) { return false; } })();
      if (open && !document.hidden) return null;
      return { title: '💬 ' + (m.sender || m.senderName || 'New message'), body: plain(m.text) || (m.photo ? '📷 Photo' : 'New message'), tag: 'pm-' + m.senderId,
        open: function () { try { switchTab('tab-public'); window.startPrivateChat(m.senderId); } catch (e) { /* ignore */ } } };
    }
    if (m.channel === 'emergency_chat') {
      if (String(m.userId || '') === myId) return null;
      var em = requestOf(m.convId || m.emId); if (!em) return null;
      var mineReq = String(em.userId) === myId;
      var role = String(u.role || 'user'), staff = role === 'superadmin' || role === 'admin' || role === 'authority' ||
        (ROLE_DEPT[role] && String(em.type || '').toLowerCase().indexOf(ROLE_DEPT[role]) >= 0) || (role === 'rescue' && /hazard/i.test(em.type || ''));
      if (!mineReq && !staff) return null;
      var shown = (function () { try { return typeof activeEmChatId !== 'undefined' && activeEmChatId && String(activeEmChatId) === String(em.id); } catch (e) { return false; } })();
      if (shown && !document.hidden) return null;
      return { title: '🚨 ' + (em.type || 'Request') + ' chat · ' + (m.sender || 'Message'), body: plain(m.text) || 'New message', tag: 'emc-' + em.id,
        open: function () { try { window.openEmergencyChat(em.id, em.type); } catch (e) { /* ignore */ } } };
    }
    if (m.channel === 'official') {
      if (String(m.userId || '') === myId) return null;
      return { title: '📢 Official: ' + (m.sender || 'LGU'), body: plain(m.text) || 'New announcement', tag: 'official',
        open: function () { try { switchTab('tab-public'); if (window.switchChatView) window.switchChatView('official'); } catch (e) { /* ignore */ } } };
    }
    return null;
  }

  var seen = null, seenFor = '';
  function scan() {
    var u = me(); if (!u || !u.id) return;
    var list = msgs();
    if (seen === null || seenFor !== String(u.id)) {             // first look after login: what is there is old news
      if (!list.length) return;
      seen = {}; seenFor = String(u.id);
      list.forEach(function (m) { if (m && m.id) seen[m.id] = 1; });
      return;
    }
    var fresh = [];
    list.forEach(function (m) { if (m && m.id && !seen[m.id]) { seen[m.id] = 1; fresh.push(m); } });
    if (fresh.length > 30) return;                              // a big catch-up (reconnect): no flood of notices
    fresh.forEach(function (m) { var n = concernsMe(m, u); if (n) window.ampNotify(n); });
  }
  setInterval(scan, 1000);
  document.addEventListener('visibilitychange', scan);
})();
