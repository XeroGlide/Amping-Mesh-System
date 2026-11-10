/* AMPING chat: honest "received in" times + sent messages that stay on screen.
     * Two phones never agree on the time, so "received minus sent" from their own clocks is wrong by seconds or
       minutes. Every phone instead measures how far its clock is from the clock of the device it is connected to
       (Pi or Heltec node: GET /api/ping). The Heltec node follows the Pi's clock over LoRa, so the whole network
       shares ONE clock. A message carries the sender's distance to that clock ("o"); the receiver adds its own.
     * The time shown is: from the moment Send was pressed to the moment THIS phone got the message.
     * A message just sent stays on the sender's screen until the Pi / node list contains it (the 2-second sync
       used to wipe it for a moment, or for good when it was slow). */
(function () {
  'use strict';

  // ------------------------------------------------------------------ the network clock
  var off = 0, known = false, bestRtt = 1e9, bestAt = 0;
  function sample() {
    var t0 = Date.now(), p0 = (window.performance && performance.now) ? performance.now() : t0;
    return fetch('/api/ping?t=' + t0, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var rtt = ((window.performance && performance.now) ? performance.now() : Date.now()) - p0;
        if (!j || typeof j.t !== 'number' || !(j.t > 0) || rtt > 4000) return;
        var o = j.t - (t0 + rtt / 2);
        var stepped = known && Math.abs(o - off) > 1500 && rtt < 1500;      // a clock was set (theirs or ours)
        if (!known || stepped || rtt <= bestRtt * 1.25 + 5 || Date.now() - bestAt > 45000) {
          off = o; known = true; bestRtt = rtt; bestAt = Date.now();
          settle();
        }
      })
      .catch(function () { /* not reachable right now */ });
  }
  [0, 1500, 4000].forEach(function (d) { setTimeout(sample, d); });
  setInterval(function () { if (!document.hidden) sample(); }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sample(); });

  window.AMP_CLOCK = {
    known: function () { return known; },
    offset: function () { return known ? Math.round(off) : null; },
    now: function () { return Date.now() + (known ? off : 0); },
    resync: sample
  };
  /** spread into an outgoing chat packet: {o: <ms from this phone's clock to the network clock>} */
  window.ampO = function () { return known ? { o: Math.round(off) } : {}; };
  /** 8 characters (the LoRa chunk id limit): 6 of time + 2 random */
  window.ampMsgId = function () {
    var t = Date.now().toString(36);
    return t.slice(-6) + Math.random().toString(36).slice(2, 4).padEnd(2, '0');
  };

  // ------------------------------------------------------------------ "received in"
  var MAX_MS = 12 * 3600 * 1000;
  var firstSeen = {};      // id -> this phone's clock when the message first arrived here
  var waiting = {};        // id -> {ts, o}: arrived before our own clock offset was known
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage full */ } }
  function record(id, ts, o, seenAt) {
    var lat = (seenAt + off) - (ts + o);
    lsSet('rxLat_' + id, (lat > -2000 && lat < MAX_MS) ? String(Math.max(0, Math.round(lat))) : 'x');
  }
  function settle() { for (var id in waiting) { record(id, waiting[id].ts, waiting[id].o, firstSeen[id]); delete waiting[id]; } }

  /** called for every message in the list from the Pi / node; returns a timestamp that never changes */
  window.ampSeen = function (m) {
    var id = m.id || m.i, now = Date.now();
    var sent = Number(m.ts || m.timestamp) || 0;
    if (!id) return sent || now;
    if (!firstSeen[id]) firstSeen[id] = now;
    if (lsGet('rxLat_' + id) === null && !waiting[id]) {
      var o = (typeof m.o === 'number' && isFinite(m.o)) ? m.o : null;
      if (!sent || o === null) lsSet('rxLat_' + id, 'x');                  // sender's clock unknown: say nothing
      else if (known) record(id, sent, o, firstSeen[id]);
      else waiting[id] = { ts: sent, o: o };
    }
    return sent || firstSeen[id];
  };

  // SOS: the same exact method. The request carries "o" (the sender's distance to the network clock, patch
  // sos-net-clock); the time is from the moment SOS was pressed to the moment THIS phone first had it. (Before: the
  // two phones' own clocks - and a random 120-160 ms whenever that came out negative.)
  var isSos = function (id) { return String(id).indexOf('sos_') === 0; };
  var loadedAt = Date.now();
  window.markMessageReceived = function (id, ts, o) {
    if (!isSos(id)) return;
    var sent = Number(ts) || 0, now = Date.now();
    if (!firstSeen[id]) firstSeen[id] = now;
    if (lsGet('rxLat_' + id) !== null || waiting[id]) return;
    o = (o !== null && o !== undefined && o !== '' && isFinite(Number(o))) ? Number(o) : null;
    if (!sent || o === null) { lsSet('rxLat_' + id, 'x'); return; }           // an older phone sent it: no exact time
    // already waiting when this phone opened the app: "reached this phone" would only say when the app was opened
    if (now - loadedAt < 6000 && (sent + o) < (now + (known ? off : 0)) - 15000) { lsSet('rxLat_' + id, 'x'); return; }
    if (known) record(id, sent, o, firstSeen[id]); else waiting[id] = { ts: sent, o: o };
  };
  window.getRxLatency = function (id) {
    var v = lsGet('rxLat_' + id);
    return (v === null || v === 'x' || isNaN(parseInt(v, 10))) ? null : parseInt(v, 10);
  };
  /** responder card: "⏱ Total time 6.4 s · sent 3:52:10 PM · received 3:52:16 PM" (network clock); nothing if unknown */
  window.ampSosRxLabel = function (lat, em) {
    if (lat === null || lat === undefined || isNaN(lat)) return '';
    var o = Number(em && em.o), sent = Number(em && em.id) + (isFinite(o) ? o : 0);
    var hms = function (t) { try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); } catch (e) { return ''; } };
    var times = isFinite(sent) && sent > 0 ? ' <span style="font-weight:600;opacity:.85">· sent ' + hms(sent) + ' · received ' + hms(sent + lat) + '</span>' : '';
    return '<div style="display:inline-block;margin-top:5px;background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;border-radius:8px;padding:3px 8px;font-size:11px;font-weight:800;line-height:1.35;text-align:left">⏱ Total time ' + window.ampFormatMs(lat) + times + '</div>';
  };
  window.ampFormatMs = function (ms) {
    if (ms < 60000) return (Math.round(ms / 100) / 10).toFixed(1) + ' s';
    var s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
    return m + ' min ' + String(s % 60).padStart(2, '0') + ' s';
  };
  /** the bit after the clock time in a chat bubble; nothing when the time cannot be known exactly */
  window.ampRxLabel = function (lat) {
    if (lat === null || lat === undefined || isNaN(lat)) return '';
    return ' &bull; 📥 Received in ' + window.ampFormatMs(lat);
  };

  // ------------------------------------------------------------------ a sender this phone has no account for
  /** a stand-in contact made from that person's own messages, so the chat can be listed and opened */
  window.ampChatContact = function (id) {
    if (!id) return null;
    var list = []; try { list = allMessages || []; } catch (e) { /* not ready */ }
    for (var i = list.length - 1; i >= 0; i--) {
      var m = list[i];
      if (m && m.channel === 'private' && m.senderId === id) {
        return { id: id, username: m.sender || m.senderName || 'Mesh user', role: 'user', status: 'approved', barangay: 'Mesh user', purok: 'no profile on this phone' };
      }
    }
    return null;
  };

  // ------------------------------------------------------------------ request chat (resident <-> responders)
  // The open chat box was only redrawn when YOU sent something, so the other side's message stayed invisible
  // until then. It is now redrawn whenever the list from the Pi / node changes, and the chat buttons on a
  // request show how many messages are waiting.
  function emcMine(m) { try { return !!(currentUser && m.userId && String(currentUser.id) === String(m.userId)); } catch (e) { return false; } }
  function emcOpenId() { try { return (typeof activeEmChatId !== 'undefined' && activeEmChatId) ? String(activeEmChatId) : ''; } catch (e) { return ''; } }
  function emcList(id) {
    var list = []; try { list = allMessages || []; } catch (e) { /* not ready */ }
    return list.filter(function (m) { return m && m.channel === 'emergency_chat' && (String(m.convId) === id || String(m.emId) === id); });
  }
  function emcMarkRead(id) {
    var top = 0; emcList(id).forEach(function (m) { if (m.timestamp > top) top = m.timestamp; });
    if (top) lsSet('ampEmcRead_' + id, String(top));
  }
  function emcUnread(id) {
    var last = parseInt(lsGet('ampEmcRead_' + id) || '0', 10) || 0, n = 0;
    emcList(id).forEach(function (m) { if (!emcMine(m) && m.timestamp > last) n++; });
    return n;
  }
  function emcBadges() {
    var open = emcOpenId();
    var btns = document.querySelectorAll('button[onclick^="openEmergencyChat("]');
    for (var i = 0; i < btns.length; i++) {
      var mt = /openEmergencyChat\('?([^',)]+)/.exec(btns[i].getAttribute('onclick') || '');
      if (!mt) continue;
      var n = (mt[1] === open) ? 0 : emcUnread(mt[1]);
      var b = btns[i].querySelector('.amp-emc-badge');
      if (!n) { if (b) b.remove(); continue; }
      if (!b) {
        b = document.createElement('span'); b.className = 'amp-emc-badge';
        b.style.cssText = 'display:inline-block;margin-left:8px;background:#ef4444;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:800;vertical-align:middle';
        btns[i].appendChild(b);
      }
      if (b.textContent !== String(n) + ' new') b.textContent = n + ' new';
    }
  }
  window.ampEmcRefresh = function () {
    var open = emcOpenId();
    if (open) {
      try { if (typeof window.renderEmergencyChatBox === 'function') window.renderEmergencyChatBox(); } catch (e) { /* box not on screen */ }
      emcMarkRead(open);
    }
    emcBadges();
  };
  setInterval(function () { var open = emcOpenId(); if (open) emcMarkRead(open); emcBadges(); }, 1500);
  // the request lists are rebuilt every couple of seconds (which drops the badge): put it back right away
  var badgeSoon = false;
  function badgeLater() { if (badgeSoon) return; badgeSoon = true; setTimeout(function () { badgeSoon = false; emcBadges(); }, 40); }
  function watchLists() { try { new MutationObserver(badgeLater).observe(document.body, { childList: true, subtree: true }); } catch (e) { /* old browser: the timer above still works */ } }
  if (document.body) watchLists(); else document.addEventListener('DOMContentLoaded', watchLists);

  // ------------------------------------------------------------------ sent messages stay on screen
  var pending = {};
  window.ampSent = function (msg) { if (msg && msg.id) pending[msg.id] = { m: msg, at: Date.now() }; };
  window.ampKeepPending = function (list) {
    var have = {};
    for (var i = 0; i < list.length; i++) have[list[i].id] = 1;
    for (var id in pending) {
      if (have[id] || Date.now() - pending[id].at > 180000) delete pending[id];
      else list.push(pending[id].m);
    }
    return list;
  };
})();
