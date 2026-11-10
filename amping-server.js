#!/usr/bin/env node
/*
  AMPING Mesh - Raspberry Pi Command Center Server
  =================================================
  Runs on the Raspberry Pi 4 (the "brain"). One process does everything:

   1. WEB APP + API   Serves "raspberrypi-index final.html" and every /api/* endpoint the
                      app calls (accounts, messages, SOS, settings, login, ...) with a
                      permanent on-disk database, so responders that join the Pi's own
                      WiFi (or plug into its network) get instant, complete data with
                      NO internet.
   2. FIREBASE MIRROR While the Pi has internet it streams Firebase Realtime Database
                      (meshaccounts, emergencies, messages, settings, meshInfrastructure)
                      in real time and saves everything locally - including every new
                      registration from "Registration Final.html" the second it is
                      submitted.  When internet returns after an outage, anything that
                      happened offline (new SOS, chat, approvals) is pushed back up.
   3. LORA BRIDGE     Talks to Heltec 1 over USB (JSON-lines, see heltec1-pi-bridge.c):
                      field-node chat / SOS arrive here, login queries are answered from
                      the Pi's account database, red alerts and SOS status changes are
                      broadcast back out to the field.
   4. CAPTIVE PORTAL  Any hijacked domain (phones' "is there internet?" probes) is
                      redirected to the app, so devices pop up the login page by themselves.

  Zero runtime dependencies except the optional "serialport" package (only needed for the
  Heltec 1 USB link).  Node 16+.

  Run:    sudo node amping-server.js            (or use the systemd service from install.sh)
  Config: config.json next to this file and/or environment variables (see README.md).
*/
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const { MapService } = require('./map-service.js');
const BUILD = '2026-10-31a';   // shown by /api/status and sudo amping-doctor - tells which version is really running

// =====================================================================================
// CONFIG
// =====================================================================================
const FB_TECH2FORMS = 'https://tech2forms-default-rtdb.firebaseio.com';
const FB_TECH2FORMS_KEY = 'AIzaSyDsK7mAo-lEV1gWmRNYF4eJ8EJDi2I2FrU';
const FB_OLD_MESH = 'https://mesh-project-amping-default-rtdb.asia-southeast1.firebasedatabase.app';
function loadConfig(overrides) {
  const base = {
    PORT: 80,
    GPS_EXEMPT_LOCAL: true,                // the Pi's own screen (localhost) is not gated
    REQUIRE_GPS: true,                    // users must share an accurate GPS position before using the app
    HTTPS_PORT: 0,                         // 443 = also serve https:// (self-signed) so phones allow GPS; see README
    TLS_DIR: '',                           // default: <DATA_DIR>/tls  (key.pem + cert.pem)
    HOST: '0.0.0.0',
    AP_IP: '192.168.20.1',                 // the Pi's own WiFi address (captive-portal target)
    DATA_DIR: path.join(__dirname, 'data'),
    APP_DIR: path.join(__dirname, 'app'),  // index.html + vendor/ live here
    // Since 2026-10-27 the Pi mirrors the tech2forms database (the same one Registration Final.html writes to). It signs
    // in with its own identity (DATA_DIR/firebase-identity.json); the tech2forms Realtime Database rules name its uid.
    FIREBASE_URL: FB_TECH2FORMS,
    FIREBASE_AUTH: '',                     // optional database secret / access token (instead of the Pi's own sign-in)
    FIREBASE_API_KEY: null,                // tech2forms web key (default only for the real tech2forms URL - never for tests)
    FIREBASE_REFERER: 'https://tech2forms.com/',   // that key only answers requests from tech2forms.com
    FIREBASE_SIGNUP_URL: 'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
    FIREBASE_TOKEN_URL: 'https://securetoken.googleapis.com/v1/token',
    // accounts registered before 2026-10-24 stay in the old mesh-project-amping database: the Pi reads them too and
    // writes their changes (approval, role ...) back there (default only with the real tech2forms URL)
    FIREBASE_OLD_URL: null,
    FIREBASE_SYNC: true,
    FIREBASE_PUSH: true,                   // push offline changes back up when online
    // false (default): phones that open the app FROM THE PI do not talk to Firebase themselves - the Pi is their one way
    // to the cloud and uploads their chat too (tech2forms only lets the Pi in). true = the old way (browsers upload).
    APP_FIREBASE_DIRECT: false,
    SERIAL_ENABLED: true,
    // every approved account goes to the field node in the background, so a whole class can log in there at once
    // without the radio (field node firmware 2026-10-28b). false = only staff and accounts that logged in there.
    FIELD_ACCOUNT_BOOK: true,
    // SOS and chat cross the radio without what the other side rebuilds exactly (firmware 2026-10-28c, see RF_TYPES).
    // false = always the whole record (both directions; the field node follows within seconds)
    RADIO_SHORT_FORM: true,
    SERIAL_PORT: 'auto',                   // 'auto' or e.g. /dev/ttyUSB0
    SERIAL_BAUD: 115200,
    OLLAMA_URL: 'http://127.0.0.1:11434',  // optional offline AI (Ollama) for the "AI Guide" tab
    MAP_DIR: path.join(__dirname, 'map'),  // offline vector map + routing data (see tools/build-offline-map.js)
    MAX_MESSAGES: 1500,
    LOG_LEVEL: 'info'
  };
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { /* optional */ }
  const cfg = Object.assign({}, base, file, overrides || {});
  for (const k of Object.keys(base)) {
    if (process.env['AMPING_' + k] !== undefined && !(overrides && k in overrides)) {
      const v = process.env['AMPING_' + k];
      cfg[k] = typeof base[k] === 'boolean' ? /^(1|true|yes|on)$/i.test(v)
             : typeof base[k] === 'number' ? Number(v) : v;
    }
  }
  const real = String(cfg.FIREBASE_URL).replace(/\/$/, '') === FB_TECH2FORMS;
  if (cfg.FIREBASE_API_KEY == null) cfg.FIREBASE_API_KEY = real ? FB_TECH2FORMS_KEY : '';
  if (cfg.FIREBASE_OLD_URL == null) cfg.FIREBASE_OLD_URL = real ? FB_OLD_MESH : '';
  return cfg;
}

// =====================================================================================
// LOGGING
// =====================================================================================
const LOG_RING = [];
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let LOG_MIN = 1;
function log(level, ...args) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' [' + level.toUpperCase() + '] ' +
    args.map(a => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(' ');
  LOG_RING.push(line);
  if (LOG_RING.length > 300) LOG_RING.shift();
  if (LEVELS[level] >= LOG_MIN) (level === 'error' ? console.error : console.log)(line);
}

// =====================================================================================
// SMALL HELPERS
// =====================================================================================
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === undefined || v === null) ? '' : String(v);

// Radio-safe text: LoRa chunking slices raw bytes, so keep everything plain ASCII.
function ascii(s, max) {
  let t = str(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
  return max ? t.slice(0, max) : t;
}

function safeName(id) { return str(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120); }

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Extract every top-level {...} from text (same idea as the web app's extractJSONObjects).
function extractJSONObjects(text) {
  const out = []; let start = 0, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!esc && c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0) { try { out.push(JSON.parse(text.substring(start, i + 1))); } catch (e) { /* skip */ } } }
    }
    esc = (c === '\\' && !esc);
  }
  return out;
}

function setDeep(target, parts, value) {
  let o = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  if (value === null || value === undefined) delete o[parts[parts.length - 1]];
  else o[parts[parts.length - 1]] = value;
}

// =====================================================================================
// FIELD MAPPINGS (compact LoRa/app packets <-> the verbose shape Firebase + the app use)
// =====================================================================================
const SEV_MAP = { C: 'CRITICAL', U: 'URGENT', S: 'STANDARD' };
const RISK_MAP = { S: 'SEVERE', H: 'HIGH', M: 'MODERATE', L: 'LOW' };
const DMG_MAP = { T: 'Totally Damaged', P: 'Partially Damaged', N: 'Not Applicable' };
const EM_COMPACT_TO_VERBOSE = {
  uid: 'userId', b: 'barangay', ty: 'type', st: 'status', n: 'name', ad: 'address', cn: 'contact', p: 'purok',
  tm: 'time', ds: 'description', dt: 'dispatchedTime', ct: 'completedTime', xt: 'cancelledTime', bt: 'binnedTime',
  at: 'archivedTime', et: 'escalatedTime', er: 'escalationReason', dr: 'declineReason'
};
const STATUS_RANK = {
  pending: 1, escalated_pending: 1, dispatched: 2, escalated_dispatched: 2,
  completed: 3, escalated_completed: 3, cancelled: 3, escalated_cancelled: 3, binned: 4, archived: 5
};
const rankOf = (s) => STATUS_RANK[str(s).toLowerCase()] || 0;

// Accepts compact (LoRa / app packet) or verbose (Firebase) keys and returns the verbose shape.
// Does NOT invent defaults, so it is safe for partial patches too.
function emergencyFromAny(c) {
  const e = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'isChk' || v === undefined) continue;
    if (k in EM_COMPACT_TO_VERBOSE) { if (c[EM_COMPACT_TO_VERBOSE[k]] === undefined) e[EM_COMPACT_TO_VERBOSE[k]] = v; }
    else if (k === 'sev') { if (c.severity === undefined) e.severity = SEV_MAP[v] || v; }
    else if (k === 'rr') { if (c.riskRate === undefined) e.riskRate = RISK_MAP[v] || v; }
    else if (k === 'dmg') { if (c.damageStatus === undefined) e.damageStatus = DMG_MAP[v] || v; }
    else if (k === 'fp') { if (c.isForcedPriority === undefined) e.isForcedPriority = !!v; }
    else if (k === 'mp') { if (c.manualPin === undefined) e.manualPin = !!v; }
    else e[k] = v;
  }
  if (e.id === undefined || e.id === null || e.id === '') return null;
  e.id = String(e.id);
  return e;
}

// The three emergency accounts the app ships with, so login always works on a fresh Pi. They are the teams' own
// accounts: whatever the cloud copy says, they keep their role, and a blank name / login / PIN in a cloud or
// edited copy never wipes theirs (an emptied cloud record once turned "Ambulance Team" into a plain user and took
// its responder menu away). A real new PIN, barangay or status from an admin still applies.
const BUILTIN_ACCOUNTS = [
  { id: 'admin_1', username: 'Super Admin', loginUsername: 'admin', pin: '1234', role: 'superadmin', status: 'approved', barangay: 'Ampayon', purok: 'Purok 1', contact: '09000000001' },
  { id: 'resp_1', username: 'Ambulance Team', loginUsername: 'ambulance', pin: '1234', role: 'ambulance', status: 'approved', barangay: 'Ampayon', purok: 'Purok 1', contact: '09000000002' },
  { id: 'resp_2', username: 'Rescue Team', loginUsername: 'rescue', pin: '1234', role: 'rescue', status: 'approved', barangay: 'Ampayon', purok: 'Purok 1', contact: '09000000003' }
];
const BUILTIN_BY_ID = new Map(BUILTIN_ACCOUNTS.map(d => [d.id, d]));
function keepBuiltin(a) {
  const d = BUILTIN_BY_ID.get(String(a && a.id)); if (!d) return a;
  const out = Object.assign({}, a);
  for (const k of ['username', 'loginUsername', 'pin', 'barangay', 'purok', 'contact', 'status']) if (out[k] === undefined || out[k] === null || String(out[k]).trim() === '') out[k] = d[k];
  out.role = d.role;
  return out;
}

function accountToCompact(a) {
  const o = { i: str(a.id), n: ascii(a.username, 32), l: ascii(a.loginUsername, 24), p: ascii(a.pin, 12),
    r: ascii(a.role || 'user', 12), st: ascii(a.status || 'pending', 10), b: ascii(a.barangay, 36),
    pk: ascii(a.purok, 16), c: ascii(a.contact, 16) };
  return o;
}

// =====================================================================================
// SHORT RADIO FORM (field node firmware / Pi BUILD 2026-10-28c) - the same rules as radioPack / radioUnpack in
// heltec2-remote-node.c. An SOS or chat message crosses the radio without the parts the other side rebuilds exactly;
// "z" lists them, "y" is the request type as a code:
//   SOS   n name, c contact (cn), b barangay, p purok = the account's own value, cut like the app (20 / 15 / 20 / 15)
//         a address = "Registered Address" (the app's default),  s status = "pending"
//         t / T time = the request id (ms) in Manila time, "MM/DD/YYYY hh:mm AM" (T: U+202F before AM/PM, newer phones)
//   chat  n name (20), r role (12) = the account's (private chat: sid, request chat: u);  t / T time = ts as "hh:mm AM"
// A value is only left out when it is exactly what the rule gives back. The field node checks its own short packet
// against the original before sending; the Pi only sends short records to a field node that reads them (firmware
// 2026-10-28c, seen in its BOOK_STATE) and leaves account values in unless the node holds that exact account.
// =====================================================================================
const RF_TYPES = { A: 'Ambulance', R: 'Rescue', E: 'Evacuation', G: 'Relief Goods', HF: 'Hazard: Fire/Sm', HE: 'Hazard: Electri', HW: 'Hazard: Flood', HQ: 'Hazard: Earthqu', HL: 'Hazard: Landsli', HO: 'Hazard: Other' };
const RF_TYPE_CODE = Object.fromEntries(Object.entries(RF_TYPES).map(([k, v]) => [v, k]));
const RF_DEFAULT_ADDRESS = 'Registered Address';
const RF_FW = '2026-10-28c';
const pad2 = (n) => String(n).padStart(2, '0');
function rfMs(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 1e12 && v < 1e13 ? v : 0; }
function rfClock(ms, narrow) {
  const d = new Date(ms + 8 * 3600000), h = d.getUTCHours();
  return pad2(h % 12 || 12) + ':' + pad2(d.getUTCMinutes()) + (narrow ? ' ' : ' ') + (h < 12 ? 'AM' : 'PM');
}
function rfDateClock(ms, narrow) {
  const d = new Date(ms + 8 * 3600000);
  return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) + '/' + d.getUTCFullYear() + ' ' + rfClock(ms, narrow);
}
const rfIsSos = (o) => o.uid !== undefined || o.ty !== undefined || o.y !== undefined;
function rfAccountId(o) {
  if (rfIsSos(o)) return str(o.uid);
  return o.c === 'p' ? str(o.sid) : o.c === 'emc' ? str(o.u) : '';
}
const rfCut = (v, n) => str(v).slice(0, n);
// rule value of one left-out field, or undefined when it cannot be rebuilt (acc = the account in compact form)
function rfRule(o, L, acc, sos) {
  if (sos) {
    if (L === 'n') return acc && acc.n ? rfCut(acc.n, 20) : undefined;
    if (L === 'c') return acc && acc.c ? rfCut(acc.c, 15) : undefined;
    if (L === 'b') return acc && acc.b ? rfCut(acc.b, 20) : undefined;
    if (L === 'p') return acc && acc.pk ? rfCut(acc.pk, 15) : undefined;
    if (L === 'a') return RF_DEFAULT_ADDRESS;
    if (L === 't' || L === 'T') return rfMs(o.id) ? rfDateClock(o.id, L === 'T') : undefined;
    if (L === 's') return 'pending';
    return undefined;
  }
  if (L === 'n') return acc && acc.n ? rfCut(acc.n, 20) : undefined;
  if (L === 'r') return acc && acc.r ? rfCut(acc.r, 12) : undefined;
  if (L === 't' || L === 'T') return rfMs(o.ts) ? rfClock(o.ts, L === 'T') : undefined;
  return undefined;
}
const RF_SOS_KEYS = { n: 'n', c: 'cn', b: 'b', p: 'p', a: 'ad', t: 'tm', T: 'tm', s: 'st' };
const RF_CHAT_KEYS = { n: 'n', r: 'r', t: 'tm', T: 'tm' };
// short record -> whole record. accountOf(id) gives the account in compact form (or null). missing: the letters that
// could not be rebuilt (the record then simply lacks them - logged by the caller)
function radioUnpack(o, accountOf) {
  if (!isObj(o) || (o.z === undefined && o.y === undefined)) return { rec: o, short: false, missing: '' };
  const out = Object.assign({}, o);
  delete out.z; delete out.y;
  if (o.y !== undefined) out.ty = RF_TYPES[o.y] !== undefined ? RF_TYPES[o.y] : str(o.y);
  const sos = rfIsSos(o), keys = sos ? RF_SOS_KEYS : RF_CHAT_KEYS;
  const aid = rfAccountId(o), acc = aid ? accountOf(aid) : null;
  let missing = '';
  for (const L of str(o.z)) {
    const key = keys[L]; if (!key) { missing += L; continue; }
    const v = rfRule(o, L, acc, sos);
    if (v === undefined) missing += L; else out[key] = v;
  }
  return { rec: out, short: true, missing };
}
// whole record -> short record (Pi -> field). accountOf(id) gives the account ONLY when the field node holds exactly
// that account (else null: its values stay in the packet)
function radioPack(o, accountOf) {
  if (!isObj(o) || o.z !== undefined || o.y !== undefined || o.action !== undefined) return o;
  const sos = rfIsSos(o), keys = sos ? RF_SOS_KEYS : RF_CHAT_KEYS;
  const aid = rfAccountId(o), acc = aid ? accountOf(aid) : null;
  const out = Object.assign({}, o);
  let z = '';
  for (const L of Object.keys(keys)) {
    const key = keys[L];
    if (typeof o[key] !== 'string' || out[key] === undefined) continue;
    if (L === 'T' && z.includes('t')) continue;
    if (!sos && L === 'r' && o.c !== 'emc') continue;
    const v = rfRule(o, L, acc, sos);
    if (v !== undefined && v === o[key]) { delete out[key]; z += L; }
  }
  if (sos && typeof o.ty === 'string' && RF_TYPE_CODE[o.ty]) { delete out.ty; out.y = RF_TYPE_CODE[o.ty]; }
  if (z) out.z = z;
  return z || out.y ? out : o;
}

// alert + chat-broadcast settings for the field nodes (kept small: one LoRa broadcast)
function fieldSettings(st, cfg) {
  const on = {}; for (const [b, v] of Object.entries(st.barangayBroadcast || {})) if (v) on[ascii(b, 24)] = true;
  const out = { redAlertActive: !!st.redAlertActive, redAlertHazard: ascii(st.redAlertHazard, 40), redAlertAction: ascii(st.redAlertAction, 60), globalBroadcast: !!st.globalBroadcast, rf: cfg && cfg.RADIO_SHORT_FORM === false ? 0 : 1 };   // rf: reads the short radio form
  if (Object.keys(on).length && JSON.stringify(on).length < 300) out.barangayBroadcast = on;
  return out;
}

function emergencyToCompact(e) {
  return {
    id: /^[0-9]{1,15}$/.test(String(e.id)) ? Number(e.id) : e.id, uid: ascii(e.userId, 32), b: ascii(e.barangay, 20), ty: ascii(e.type, 15), st: ascii(e.status, 20),
    n: ascii(e.name, 20), ad: ascii(e.address, 30), cn: ascii(e.contact, 15), p: ascii(e.purok, 15),
    lat: Number(e.lat) ? Number(Number(e.lat).toFixed(5)) : 0, lon: Number(e.lon) ? Number(Number(e.lon).toFixed(5)) : 0,
    tm: ascii(e.time, 24), ds: ascii(e.description, 30),
    ...(e.severity ? { sev: ascii(e.severity, 1).toUpperCase() } : {}), ...(e.riskRate ? { rr: ascii(e.riskRate, 1).toUpperCase() } : {}),
    ...(e.isForcedPriority ? { fp: 1 } : {}),              // triage (Critical / Urgent / Standard, forced priority) shows in the field too
    ...(e.manualPin ? { mp: 1 } : {}),                      // the requester put the pin on the map by hand
    ...(e.o !== undefined && e.o !== null && e.o !== '' && isFinite(Number(e.o)) ? { o: Math.round(Number(e.o)) } : {})   // sender's clock offset: exact "total time"
  };
}

const chanOf = (m) => {
  const c = m.c || m.channel;
  if (c === 'c' || c === 'com') return 'community';
  if (c === 'o' || c === 'off') return 'official';
  if (c === 'p' || c === 'pri') return 'private';
  if (c === 'emc') return 'emergency_chat';
  return c || 'community';
};

// "o" = how far the sender's phone clock is from the network clock (see tools/client/chat-fix.js): it must
// travel with the message, or the receiving phone cannot tell how long the message took.
function messageToCompact(m) {
  const ch = chanOf(m);
  const id = ascii(String(m.id || m.i || '').replace(/^[a-z]+_/, ''), 8);
  const tail = { tm: ascii(m.time || m.tm, 24), ts: Number(m.timestamp || m.ts) || Date.now() };
  if (m.o !== undefined && m.o !== null && Number.isFinite(Number(m.o))) tail.o = Math.round(Number(m.o));
  const text = ascii(m.text || m.x || m.txt, 60);
  if (ch === 'private') return Object.assign({ i: id, sid: ascii(m.senderId || m.sid, 32), rid: ascii(m.receiverId || m.rid, 32),
    n: ascii(m.senderName || m.sender || m.n || 'U', 20), c: 'p', x: text }, tail);
  if (ch === 'emergency_chat') return Object.assign({ i: id, cv: ascii(m.convId || m.cv || m.emId, 15), u: ascii(m.userId || m.u, 32),
    n: ascii(m.sender || m.n || m.senderName || 'U', 20), r: ascii(m.role || m.r || 'user', 12), c: 'emc', x: text }, tail);
  return Object.assign({
    i: ascii(String(m.id || m.i || '').replace(/^[a-z]+_/, ''), 8),
    u: ascii(m.userId || m.u || m.senderId, 14), n: ascii(m.sender || m.n || m.senderName || 'U', 20),
    r: ascii(m.role || m.r || 'user', 12), b: ascii(m.barangay || m.b || m.senderBarangay, 10),
    p: ascii(m.purok || m.p, 8), tb: ascii(m.targetBrgy || m.tb || 'GLOBAL', 10), t: ascii(m.target || m.t || 'ALL', 8),
    c: ch === 'official' ? 'o' : 'c', x: text }, tail);
}

function messageToVerbose(m) {
  if (m.text !== undefined || m.sender !== undefined) return m;   // already verbose (came from Firebase)
  const ch = chanOf(m);
  const ts = Number(m.ts || m.timestamp) || Date.now();
  const v = { id: str(m.id || m.i), userId: m.u || m.userId || '', sender: m.n || m.sender || 'User', role: m.r || m.role || 'user',
    barangay: m.b || '', purok: m.p || '', targetBrgy: m.tb || 'GLOBAL', target: m.t || 'ALL', channel: ch, text: m.x || m.text || '',
    time: m.tm || m.time || '', timestamp: ts, isGps: !!m.ig, isDeleted: !!m.dl };
  if (ch === 'private') { v.senderId = m.sid || m.senderId || ''; v.receiverId = m.rid || m.receiverId || ''; v.senderName = v.sender; if (m.cv) v.convId = m.cv; }
  if (ch === 'emergency_chat' && (m.cv || m.convId)) v.convId = m.cv || m.convId;
  if (m.o !== undefined) v.o = m.o;
  return v;
}

// =====================================================================================
// STORE  (permanent JSON files, debounced atomic writes, cached gzip'd API views)
// =====================================================================================
class Store extends EventEmitter {
  constructor(dir, cfg) {
    super();
    this.dir = dir; this.cfg = cfg;
    fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
    this.accounts = new Map();     // id -> account (idPhoto removed, kept in photos/)
    this.emergencies = new Map();  // id -> verbose emergency
    this.messages = new Map();     // id -> message (compact or verbose, exactly as the app posts it)
    this.settings = {};
    this.infra = {};
    this.meta = {
      dirty: { accounts: [], emergencies: [], messages: [], settings: false, infra: false },
      tombstones: { accounts: [], emergencies: [] },
      emVia: {},          // emergency id -> 'lora'
      fieldSeen: [],      // account ids that logged in through a field node
      counters: { loraMsgIn: 0, loraSosIn: 0, loraLogins: 0 },
      graveyard: [],      // account ids deleted on purpose - stale browser caches must not bring them back
      acctSrc: {},        // account id -> 'new' (tech2forms) | 'old' (the old mesh database) - where its changes go
      book: {}            // account id -> sig: what the field node confirmed it has in its account book (2026-10-28b)
    };
    this.protectedIds = new Set();
    this.views = {};
    this._saveTimers = {};
    this._load();
  }

  _file(n) { return path.join(this.dir, n + '.json'); }
  _read(n, fallback) {
    try { return JSON.parse(fs.readFileSync(this._file(n), 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') {
        log('error', 'could not read ' + n + '.json (' + e.message + ') - trying backup');
        try { return JSON.parse(fs.readFileSync(this._file(n) + '.bak', 'utf8')); } catch (e2) { /* fall through */ }
      }
      return fallback;
    }
  }
  _load() {
    for (const a of this._read('accounts', [])) if (a && a.id) this.accounts.set(String(a.id), a);
    for (const e of this._read('emergencies', [])) if (e && e.id) this.emergencies.set(String(e.id), e);
    for (const m of this._read('messages', [])) { const id = str(m.id || m.i); if (id) this.messages.set(id, m); }
    this.settings = this._read('settings', {});
    this.infra = this._read('infra', {});
    const meta = this._read('meta', null);
    if (meta) {
      this.meta = Object.assign(this.meta, meta);
      this.meta.dirty = Object.assign({ accounts: [], emergencies: [], messages: [], settings: false, infra: false }, meta.dirty);
      this.meta.tombstones = Object.assign({ accounts: [], emergencies: [] }, meta.tombstones);
      this.meta.counters = Object.assign({ loraMsgIn: 0, loraSosIn: 0, loraLogins: 0 }, meta.counters);
      if (!Array.isArray(this.meta.graveyard)) this.meta.graveyard = [];
      if (!isObj(this.meta.acctSrc)) this.meta.acctSrc = {};
      if (!isObj(this.meta.book)) this.meta.book = {};
    }
    this._seedDefaults();
  }

  // Same three emergency accounts the app ships with, so login always works on a fresh Pi.
  _seedDefaults() {
    for (const d of BUILTIN_ACCOUNTS) {
      this.protectedIds.add(d.id);
      const cur = this.accounts.get(d.id);
      if (!cur) { if (!this.meta.tombstones.accounts.includes(d.id)) this.accounts.set(d.id, Object.assign({}, d)); continue; }
      const fixed = keepBuiltin(cur);                // repairs a copy saved before (e.g. emptied by the cloud)
      if (JSON.stringify(fixed) !== JSON.stringify(cur)) { this.accounts.set(d.id, fixed); this.scheduleSave('accounts'); }
    }
  }

  scheduleSave(name) {
    if (this._saveTimers[name]) return;
    this._saveTimers[name] = setTimeout(() => { this._saveTimers[name] = null; this.saveNow(name); }, 700);
  }
  saveNow(name) {
    try {
      let data;
      if (name === 'accounts') data = [...this.accounts.values()];
      else if (name === 'emergencies') data = [...this.emergencies.values()];
      else if (name === 'messages') data = [...this.messages.values()];
      else if (name === 'settings') data = this.settings;
      else if (name === 'infra') data = this.infra;
      else if (name === 'meta') data = this.meta;
      const f = this._file(name);
      try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch (e) { /* best effort */ }
      atomicWrite(f, JSON.stringify(data));
    } catch (e) { log('error', 'save ' + name + ' failed: ' + e.message); }
  }
  flushAll() {
    for (const n of ['accounts', 'emergencies', 'messages', 'settings', 'infra', 'meta']) {
      if (this._saveTimers[n]) { clearTimeout(this._saveTimers[n]); this._saveTimers[n] = null; }
      this.saveNow(n);
    }
  }
  touch(name) { delete this.views[name]; this.scheduleSave(name); this.emit('changed', name); }

  // ---- dirty (needs push to Firebase) tracking ----
  markDirty(kind, id) {
    const arr = this.meta.dirty[kind];
    if (!arr.includes(id)) arr.push(id);
    this.scheduleSave('meta');
    this.emit('dirty');
  }
  clearDirty(kind, id) {
    const arr = this.meta.dirty[kind]; const i = arr.indexOf(id);
    if (i >= 0) { arr.splice(i, 1); this.scheduleSave('meta'); }
  }

  // ---- photos ----
  photoFile(id) { return path.join(this.dir, 'photos', safeName(id) + '.txt'); }
  hasPhoto(id) { try { return fs.statSync(this.photoFile(id)).size > 0; } catch (e) { return false; } }
  getPhoto(id) { try { return fs.readFileSync(this.photoFile(id), 'utf8'); } catch (e) { return ''; } }
  setPhoto(id, data) { try { atomicWrite(this.photoFile(id), data); return true; } catch (e) { log('error', 'photo save failed: ' + e.message); return false; } }

  // ---- ACCOUNTS ----
  // Insert/update. Returns 'new' | 'changed' | 'same'.
  upsertAccount(raw, opts) {
    opts = opts || {};
    if (!isObj(raw)) return 'same';
    const a = Object.assign({}, raw);
    if (!a.id) { if (opts.key) a.id = opts.key; else if (a.loginUsername) a.id = a.loginUsername; else return 'same'; }
    a.id = String(a.id);
    if (opts.fromFirebase) {
      const gi = this.meta.graveyard.indexOf(a.id);
      if (gi >= 0) { this.meta.graveyard.splice(gi, 1); this.scheduleSave('meta'); }
    } else if (this.meta.tombstones.accounts.includes(a.id) || this.meta.graveyard.includes(a.id)) return 'same';
    delete a.hasIdPhoto;
    if (typeof a.idPhoto === 'string' && a.idPhoto.length > 32) {
      if (this.getPhoto(a.id) !== a.idPhoto) this.setPhoto(a.id, a.idPhoto);
    }
    delete a.idPhoto;
    const old = this.accounts.get(a.id);
    let result = 'new';
    if (old) {
      let merged = opts.replace ? a : Object.assign({}, old, a);
      if (this.protectedIds.has(a.id)) merged = keepBuiltin(merged);
      result = JSON.stringify(merged) === JSON.stringify(old) ? 'same' : 'changed';
      if (result === 'same') return 'same';
      this.accounts.set(a.id, merged);
    } else this.accounts.set(a.id, this.protectedIds.has(a.id) ? keepBuiltin(a) : a);
    this.touch('accounts');
    if (opts.dirty) this.markDirty('accounts', a.id);
    this.emit('account', this.accounts.get(a.id), old, result);
    return result;
  }
  removeAccount(id, opts) {
    opts = opts || {};
    id = String(id);
    if (!this.accounts.has(id)) return false;
    if (this.protectedIds.has(id) && !opts.force) return false;
    const old = this.accounts.get(id);
    this.accounts.delete(id);
    try { fs.unlinkSync(this.photoFile(id)); } catch (e) { /* none */ }
    this.clearDirty('accounts', id);
    if (!this.meta.graveyard.includes(id)) { this.meta.graveyard.push(id); if (this.meta.graveyard.length > 5000) this.meta.graveyard.shift(); }
    if (opts.tombstone && !this.meta.tombstones.accounts.includes(id)) { this.meta.tombstones.accounts.push(id); this.scheduleSave('meta'); this.emit('dirty'); }
    this.touch('accounts');
    this.emit('account-removed', old);
    return true;
  }
  publicAccount(a) {
    const o = Object.assign({}, a);
    delete o.idPhoto;
    if (this.hasPhoto(a.id)) o.hasIdPhoto = true;
    return o;
  }
  findAccountsByPrefix(prefix) {
    prefix = String(prefix);
    const exact = this.accounts.get(prefix);
    if (exact) return [exact];
    return [...this.accounts.values()].filter(a => String(a.id).startsWith(prefix));
  }

  // ---- EMERGENCIES ----
  upsertEmergency(raw, opts) {
    opts = opts || {};
    const incoming = emergencyFromAny(raw || {});
    if (!incoming) return 'same';
    if (this.meta.tombstones.emergencies.includes(incoming.id) && !opts.force) return 'same';
    const old = this.emergencies.get(incoming.id);
    let result = 'new', next = incoming;
    if (!old && !next.status) next.status = 'pending';
    if (old) {
      next = Object.assign({}, old, incoming);
      // never let a stale copy pull the status backwards
      if (!opts.authoritative && rankOf(old.status) > rankOf(incoming.status)) {
        next.status = old.status;
        for (const k of ['dispatchedTime', 'completedTime', 'cancelledTime', 'binnedTime', 'archivedTime', 'escalatedTime']) if (old[k] && !next[k]) next[k] = old[k];
      }
      if (old.photo && !next.photo) next.photo = old.photo;
      result = JSON.stringify(next) === JSON.stringify(old) ? 'same' : 'changed';
      if (result === 'same') return 'same';
    }
    this.emergencies.set(incoming.id, next);
    if (opts.via) { this.meta.emVia[incoming.id] = opts.via; this.scheduleSave('meta'); }
    this.touch('emergencies');
    if (opts.dirty) this.markDirty('emergencies', incoming.id);
    this.emit('emergency', next, old, result);
    return result;
  }
  removeEmergency(id, opts) {
    opts = opts || {};
    id = String(id);
    if (!this.emergencies.has(id)) return false;
    this.emergencies.delete(id);
    delete this.meta.emVia[id];
    this.clearDirty('emergencies', id);
    if (opts.tombstone && !this.meta.tombstones.emergencies.includes(id)) { this.meta.tombstones.emergencies.push(id); this.emit('dirty'); }
    this.scheduleSave('meta');
    this.touch('emergencies');
    return true;
  }
  findEmergency(idOrPrefix) {
    idOrPrefix = String(idOrPrefix);
    if (this.emergencies.has(idOrPrefix)) return this.emergencies.get(idOrPrefix);
    const cands = [...this.emergencies.values()].filter(e => String(e.id).startsWith(idOrPrefix) || idOrPrefix.startsWith(String(e.id)));
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
      // truncated ids can be ambiguous (older clients): take the most recently created
      cands.sort((a, b) => Number(b.id) - Number(a.id));
      log('warn', 'ambiguous SOS id prefix ' + idOrPrefix + ' matched ' + cands.length + ' - using newest');
      return cands[0];
    }
    return null;
  }

  // ---- MESSAGES ----
  upsertMessage(raw, opts) {
    opts = opts || {};
    if (!isObj(raw)) return 'same';
    const m = Object.assign({}, raw);
    let id = str(m.id || m.i);
    if (!id) { id = 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); m.id = id; }
    const old = this.messages.get(id);
    if (old) {
      const merged = Object.assign({}, old, m);
      if (JSON.stringify(merged) === JSON.stringify(old)) return 'same';
      this.messages.set(id, merged);
    } else {
      if (!m.ts && !m.timestamp) m.ts = Date.now();
      this.messages.set(id, m);
      // cap size
      if (this.messages.size > this.cfg.MAX_MESSAGES) {
        const arr = [...this.messages.entries()].sort((a, b) => (Number(a[1].ts || a[1].timestamp) || 0) - (Number(b[1].ts || b[1].timestamp) || 0));
        for (let i = 0; i < arr.length - this.cfg.MAX_MESSAGES; i++) this.messages.delete(arr[i][0]);
      }
    }
    this.touch('messages');
    if (opts.dirty) this.markDirty('messages', id);
    this.emit('message', this.messages.get(id), old, opts);
    return old ? 'changed' : 'new';
  }

  // ---- SETTINGS / INFRA ----
  mergeSettings(patch, opts) {
    opts = opts || {};
    if (!isObj(patch)) return false;
    const before = JSON.stringify(this.settings);
    const old = JSON.parse(before);
    this.settings = opts.replace ? Object.assign({}, patch) : Object.assign({}, this.settings, patch);
    if (JSON.stringify(this.settings) === before) return false;
    this.touch('settings');
    if (opts.dirty) { this.meta.dirty.settings = true; this.scheduleSave('meta'); this.emit('dirty'); }
    this.emit('settings', this.settings, old);
    return true;
  }
  setInfra(obj, opts) {
    opts = opts || {};
    if (!isObj(obj)) return false;
    if (JSON.stringify(obj) === JSON.stringify(this.infra)) return false;
    this.infra = obj;
    this.touch('infra');
    if (opts.dirty) { this.meta.dirty.infra = true; this.scheduleSave('meta'); this.emit('dirty'); }
    return true;
  }

  // ---- cached API views (built once per change, gzip'd once) ----
  view(name) {
    let v = this.views[name];
    if (v) return v;
    let obj;
    if (name === 'accounts') obj = [...this.accounts.values()].map(a => this.publicAccount(a));
    else if (name === 'emergencies') obj = [...this.emergencies.values()];
    else if (name === 'messages') {
      obj = [...this.messages.values()].sort((a, b) => (Number(a.ts || a.timestamp) || 0) - (Number(b.ts || b.timestamp) || 0));
      if (obj.length > 600) obj = obj.slice(-600);
    }
    else if (name === 'settings') obj = Object.keys(this.settings).length ? this.settings : { redAlertActive: false };
    else if (name === 'infra') obj = this.infra;
    else obj = {};
    const raw = Buffer.from(JSON.stringify(obj));
    v = { raw, gz: raw.length > 700 ? zlib.gzipSync(raw, { level: 6 }) : null };
    this.views[name] = v;
    return v;
  }
}

// =====================================================================================
// ACCOUNT LOGIN (identical matching rules to the web app's validateUser)
// =====================================================================================
function findLogin(store, identifier, pin) {
  const clean = str(identifier).toLowerCase().replace(/[\s\-_.]/g, '');
  const digits = str(identifier).replace(/[^0-9]/g, '');
  const phone = digits.length >= 10 ? digits.slice(-10) : digits;
  const pinS = str(pin).trim();
  let best = null, bestScore = 0;
  for (const u of store.accounts.values()) {
    const name = str(u.username || u.name).toLowerCase().replace(/[\s\-_.]/g, '');
    const sys = str(u.loginUsername).toLowerCase().replace(/[\s\-_.]/g, '');
    const cd = str(u.contact || u.phone).replace(/[^0-9]/g, '');
    const uPhone = cd.length >= 10 ? cd.slice(-10) : cd;
    const pinOk = str(u.pin || u.PIN || u.Pin || u.password).trim() === pinS;
    if (!pinOk) continue;
    let score = 0;
    if (sys && sys === clean) score = 3;
    else if (phone.length >= 7 && uPhone === phone) score = 2;
    else if (name && name === clean) score = 1;
    if (score > bestScore) { best = u; bestScore = score; }
  }
  return best;
}

// =====================================================================================
// CHUNK REASSEMBLY for the web app's {isChk,id,idx,tot,dat} POSTs
// =====================================================================================
class Chunker {
  constructor() { this.buf = new Map(); setInterval(() => this.sweep(), 30000).unref(); }
  // returns a parsed object when complete, else null. Non-chunk objects are returned as is.
  feed(scope, o) {
    if (!isObj(o)) return null;
    if (!o.isChk) return o;
    const key = scope + '|' + o.id;
    let e = this.buf.get(key);
    if (!e || e.tot !== o.tot) { e = { tot: Number(o.tot), parts: {}, at: Date.now() }; this.buf.set(key, e); }
    e.parts[o.idx] = str(o.dat);
    if (Object.keys(e.parts).length < e.tot) return null;
    let full = '';
    for (let i = 1; i <= e.tot; i++) { if (e.parts[i] === undefined) return null; full += e.parts[i]; }
    this.buf.delete(key);
    try { return JSON.parse(full); } catch (e2) { log('warn', 'bad reassembled JSON (' + scope + '): ' + full.slice(0, 80)); return null; }
  }
  sweep() { const cut = Date.now() - 180000; for (const [k, v] of this.buf) if (v.at < cut) this.buf.delete(k); }
}

// =====================================================================================
// ACTION / MESSAGE PROCESSING (one place that turns app packets into store changes)
// =====================================================================================
class Engine {
  constructor(store, cfg) { this.store = store; this.cfg = cfg; this.chunker = new Chunker(); this.recentSeen = new Map(); }

  // Handle whatever object the web app (or LoRa) posted. kind: 'msg' | 'sos' | 'update'
  handle(kind, o, via) {
    via = via || 'app';
    const s = this.store;
    if (!isObj(o)) return;
    if (o.action) return this.action(o, via);
    if (kind === 'update') return;            // update endpoint only understands actions
    if (kind === 'sos' || o.ty !== undefined || o.type !== undefined && o.lat !== undefined) {
      // older apps / field firmware cut the account id to 15 characters - put the full id back when it is unambiguous
      const uKey = o.uid !== undefined ? 'uid' : 'userId', uid = str(o[uKey]);
      if (uid.length >= 12 && !s.accounts.has(uid)) {
        const full = [...s.accounts.keys()].filter(k => k.startsWith(uid));
        if (full.length === 1) o = Object.assign({}, o, { [uKey]: full[0] });
      }
      const r = s.upsertEmergency(o, { dirty: true, via: via === 'lora' ? 'lora' : undefined });
      if (r !== 'same') log('info', 'SOS ' + r + ' [' + via + '] id=' + o.id + ' ' + str(o.ty || o.type) + ' ' + str(o.n || o.name));
      return;
    }
    // chat message
    const r = s.upsertMessage(o, { dirty: via === 'lora' || (via === 'app' && !this.cfg.APP_FIREBASE_DIRECT), via });
    if (r === 'new') log('debug', 'chat [' + via + '] ' + str(o.n || o.sender) + ': ' + str(o.x || o.text).slice(0, 40));
  }

  action(o, via) {
    const s = this.store;
    switch (o.action) {
      case 'UPDATE_SOS': {
        if (o.id === undefined) return;
        const key = 'us|' + o.id + '|' + o.st + '|' + (o.dt || o.ct || o.xt || o.bt || o.at || o.et || '');
        if (this._dup(key)) return;
        if (o.st === 'deleted') { const e = s.findEmergency(o.id); if (e) { s.removeEmergency(e.id, { tombstone: true }); log('info', 'SOS deleted ' + e.id); } return; }
        const e = s.findEmergency(o.id);
        if (!e) { log('warn', 'UPDATE_SOS for unknown SOS ' + o.id); return; }
        const patch = { id: e.id };
        if (o.st) patch.status = o.st;
        for (const [k, v] of Object.entries({ dt: 'dispatchedTime', ct: 'completedTime', xt: 'cancelledTime', bt: 'binnedTime', at: 'archivedTime', et: 'escalatedTime', er: 'escalationReason', dr: 'declineReason' }))
          if (o[k] !== undefined) patch[v] = o[k];
        if (o.dmg) patch.damageStatus = DMG_MAP[o.dmg] || o.dmg;
        s.upsertEmergency(patch, { dirty: true, authoritative: true });
        log('info', 'SOS ' + e.id + ' -> ' + o.st);
        return;
      }
      // the requester moved their request's pin to their exact spot (GPS was not exact) - mp:0 = back to GPS
      case 'MOVE_SOS': {
        const la = Number(o.lat), lo = Number(o.lon);
        if (o.id === undefined || !isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (!la && !lo)) return;
        if (this._dup('mv|' + o.id + '|' + la + '|' + lo + '|' + (o.mp ? 1 : 0))) return;
        const e = s.findEmergency(o.id); if (!e) { log('warn', 'MOVE_SOS for unknown SOS ' + o.id); return; }
        s.upsertEmergency({ id: e.id, lat: +la.toFixed(6), lon: +lo.toFixed(6), manualPin: !!o.mp, pinnedAt: o.mp ? (Number(o.ts) || Date.now()) : null }, { dirty: true, authoritative: true });
        log('info', 'SOS ' + e.id + ' pinned ' + (o.mp ? 'by hand' : 'back to GPS') + ' at ' + la.toFixed(5) + ',' + lo.toFixed(5));
        return;
      }
      case 'TRIAGE_UPDATE': {
        const e = s.findEmergency(o.id); if (!e) return;
        const patch = { id: e.id };
        if (o.fp !== undefined) patch.isForcedPriority = !!o.fp;
        if (o.sev) { patch.severity = SEV_MAP[o.sev] || o.sev; }
        s.upsertEmergency(patch, { dirty: true, authoritative: true });
        return;
      }
      case 'UPDATE_ACCOUNT': {
        if (o.id === undefined) return;
        const cands = s.findAccountsByPrefix(o.id);
        if (cands.length !== 1) { log('warn', 'UPDATE_ACCOUNT id "' + o.id + '" matched ' + cands.length + ' accounts - ignored (needs the full id)'); return; }
        const a = cands[0];
        if (o.st === 'deleted') { if (s.removeAccount(a.id, { tombstone: true })) log('info', 'account deleted ' + a.id); return; }
        const patch = { id: a.id };
        if (o.st) patch.status = o.st;
        if (o.r) patch.role = o.r;
        if (o.b) patch.barangay = o.b;
        s.upsertAccount(patch, { dirty: true });
        return;
      }
      case 'RED_ALERT': {
        const cur = s.settings;
        if (o.global) s.mergeSettings({ redAlertActive: true, redAlertHazard: o.hazard, redAlertAction: o.act, redAlertTimestamp: o.ts }, { dirty: true });
        else {
          const alerts = Object.assign({}, cur.barangayRedAlerts || {});
          alerts[o.brgy] = { active: true, targetPurok: o.purok, hazard: o.hazard, action: o.act, timestamp: o.ts };
          s.mergeSettings({ barangayRedAlerts: alerts }, { dirty: true });
        }
        return;
      }
      case 'STOP_ALERT': {
        if (o.global) s.mergeSettings({ redAlertActive: false, redAlertHazard: '', redAlertAction: '', barangayRedAlerts: {} }, { dirty: true });
        else {
          const alerts = Object.assign({}, s.settings.barangayRedAlerts || {});
          if (alerts[o.brgy]) alerts[o.brgy] = Object.assign({}, alerts[o.brgy], { active: false });
          s.mergeSettings({ barangayRedAlerts: alerts }, { dirty: true });
        }
        return;
      }
      default: return; // DIR_SYNC etc: nothing for the Pi to store
    }
  }

  _dup(key) {
    const now = Date.now();
    for (const [k, t] of this.recentSeen) if (now - t > 30000) this.recentSeen.delete(k);
    if (this.recentSeen.has(key)) return true;
    this.recentSeen.set(key, now);
    return false;
  }

  // POST body from the web app -> zero or more parsed objects (chunks reassembled).
  ingestBody(scope, kind, text, via) {
    let objs = [];
    const t = text.trim();
    try { const j = JSON.parse(t); objs = Array.isArray(j) ? j : [j]; } catch (e) { objs = extractJSONObjects(t); }
    let handled = 0;
    for (const o of objs) {
      const full = this.chunker.feed(scope, o);
      if (full) { this.handle(kind, full, via); handled++; }
    }
    return handled;
  }
}

// =====================================================================================
// LIVE POSITIONS  (response units for everybody, requesters' live position for responders)
//   Phones on the Pi's WiFi POST /api/pos; field-node phones arrive over LoRa ('pos' lines).
//   Kept in memory only (a position is worthless after a few minutes), never sent to Firebase.
// =====================================================================================
const RESP_ROLES = new Set(['ambulance', 'evacuation', 'rescue', 'relief']);
const STAFF_ROLES = new Set(['ambulance', 'evacuation', 'rescue', 'relief', 'admin', 'authority', 'superadmin']);
const ACTIVE_ST = new Set(['pending', 'dispatched', 'escalated_pending', 'escalated_dispatched']);
const ROLE_CODE = { ambulance: 'a', evacuation: 'e', rescue: 'r', relief: 'l', user: 'u', admin: 'd', authority: 't', superadmin: 's' };
const CODE_ROLE = Object.fromEntries(Object.entries(ROLE_CODE).map(([k, v]) => [v, k]));
const POS_TTL_MS = 30 * 60000;

// FNV-1a 32-bit of the account id (UTF-8), base 36 - same as hashId() in tools/client/live-units.js
function hashId(s) {
  const b = Buffer.from(str(s), 'utf8'); let h = 0x811c9dc5;
  for (const c of b) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

class Positions extends EventEmitter {
  constructor(store) {
    super();
    this.store = store; this.map = new Map(); this._idx = null; this.radioSentAt = new Map();
    store.on('changed', (n) => { if (n === 'accounts') this._idx = null; });
  }
  _hashIndex() {
    if (!this._idx) { this._idx = new Map(); for (const a of this.store.accounts.values()) this._idx.set(hashId(a.id), a); }
    return this._idx;
  }
  activeRequestOf(accountId) {
    let best = null;
    const id = str(accountId);
    for (const e of this.store.emergencies.values()) {
      const uid = str(e.userId);
      if (!(uid === id || (uid.length >= 12 && id.startsWith(uid))) || !ACTIVE_ST.has(str(e.status).toLowerCase())) continue;
      if (!best || Number(e.id) > Number(best.id)) best = e;
    }
    return best;
  }
  // from a phone on the Pi's own WiFi. Returns { ok, kind } or { ok:false, error }
  fromApp(o) {
    if (!isObj(o)) return { ok: false, error: 'bad body' };
    const a = this.store.accounts.get(str(o.id));
    if (!a || str(a.status) !== 'approved') return { ok: false, error: 'unknown or unapproved account' };
    const la = Number(o.la), lo = Number(o.lo), acc = Math.max(0, Number(o.a) || 0);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (!la && !lo)) return { ok: false, error: 'bad position' };
    const role = str(a.role || 'user');
    let kind = RESP_ROLES.has(role) ? 'unit' : '';
    let em = null;
    if (!kind) { em = this.activeRequestOf(a.id); if (em) kind = 'req'; }
    if (!kind) return { ok: false, error: 'only responders and people with an open request share their position' };
    const fixAge = Math.max(0, Math.min(600, Number(o.ag) || 0));                // seconds since the phone's GPS fix
    const e = { h: hashId(a.id), id: a.id, n: ascii(a.username || a.name || 'User', 24), r: role, la: +la.toFixed(6), lo: +lo.toFixed(6), a: Math.round(Math.min(acc, 9999)), at: Date.now() - fixAge * 1000, src: 'pi', kind, em: em ? em.id : undefined };
    this.map.set(e.h, e);
    this.emit('pos', e);
    return { ok: true, kind };
  }
  // from the field over LoRa: [[h, lat*1e5, lon*1e5, acc, roleCode, name, ageSec], ...]
  fromLora(list) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const p of list) {
      if (!Array.isArray(p) || p.length < 5) continue;
      const h = str(p[0]).slice(0, 8), la = Number(p[1]) / 1e5, lo = Number(p[2]) / 1e5;
      if (!h || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
      const acct = this._hashIndex().get(h);
      const role = acct ? str(acct.role || 'user') : (CODE_ROLE[p[4]] || 'user');
      const at = Date.now() - Math.max(0, Math.min(3600, Number(p[6]) || 0)) * 1000;
      const old = this.map.get(h);
      if (old && old.at > at) continue;                                   // we already have something newer
      const kind = RESP_ROLES.has(role) ? 'unit' : 'req';
      this.map.set(h, { h, id: acct ? acct.id : undefined, n: ascii(acct ? (acct.username || acct.name) : p[5], 24) || 'User', r: role, la: +la.toFixed(6), lo: +lo.toFixed(6), a: Math.round(Number(p[3]) || 0), at, src: 'lora', kind });
      n++;
    }
    return n;
  }
  prune() { const cut = Date.now() - POS_TTL_MS; for (const [k, e] of this.map) if (e.at < cut) this.map.delete(k); }
  // what /api/positions returns; requesters only for responders / admins
  view(role) {
    this.prune();
    const now = Date.now(), u = [], q = [];
    const out = (e) => ({ h: e.h, id: e.id, n: e.n, r: e.r, la: e.la, lo: e.lo, a: e.a, s: Math.round((now - e.at) / 1000), src: e.src });
    for (const e of this.map.values()) {
      if (e.kind === 'unit') u.push(out(e));
      else if (STAFF_ROLES.has(str(role))) {
        // only while the person still has an open request
        if (e.id && !this.activeRequestOf(e.id)) continue;
        q.push(out(e));
      }
    }
    u.sort((a, b) => a.s - b.s); q.sort((a, b) => a.s - b.s);
    return { ok: true, u, q };
  }
  // compact entries for one LoRa packet: positions that came in on the Pi side, changed or not re-sent for 60 s
  radioBatch(max) {
    this.prune();
    const now = Date.now(); const cands = [];
    for (const e of this.map.values()) {
      if (e.src !== 'pi' || now - e.at > 180000) continue;
      if (e.kind === 'req' && e.id && !this.activeRequestOf(e.id)) continue;
      const last = this.radioSentAt.get(e.h);
      if (last && last.at >= e.at && now - last.sent < 60000) continue;
      cands.push(e);
    }
    cands.sort((a, b) => (a.kind === b.kind ? b.at - a.at : a.kind === 'unit' ? -1 : 1));
    const batch = [];
    let size = 8;
    for (const e of cands) {
      const item = [e.h, Math.round(e.la * 1e5), Math.round(e.lo * 1e5), Math.min(999, e.a), ROLE_CODE[e.r] || 'u', ascii(e.n, 15), Math.round((now - e.at) / 1000)];
      const len = JSON.stringify(item).length + 1;
      if (batch.length >= (max || 3) || size + len > 190) break;
      batch.push(item); size += len; this.radioSentAt.set(e.h, { at: e.at, sent: now });
    }
    return batch;
  }
}

// =====================================================================================
// FIREBASE SIGN-IN  (the Pi's own identity in the tech2forms project)
// =====================================================================================
// tech2forms only answers signed-in requests. The Pi keeps ONE anonymous identity for good (uid + refresh token in
// DATA_DIR/firebase-identity.json - a copy shipped next to amping-server.js is taken over on the first start); the
// database rules name that uid. An ID token lasts an hour: it is renewed 5 minutes before it runs out, or at once
// when Firebase says it was revoked. A new identity is made only when there is none at all (its uid must then be
// added to the rules - /api/status and amping-doctor show it).
function httpForm(method, url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url); const lib = u.protocol === 'http:' ? http : https;
    const data = body === undefined ? null : Buffer.from(body);
    const req = lib.request(u, { method, headers: Object.assign({}, headers, data ? { 'Content-Length': data.length } : {}) }, (res) => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', (d) => { out += d; if (out.length > 65536) out = out.slice(0, 65536); });
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j, body: out }); });
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, json: null, body: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
class FirebaseAuth {
  constructor(cfg) {
    this.cfg = cfg; this.file = path.join(cfg.DATA_DIR, 'firebase-identity.json');
    this.id = null; this.token = ''; this.exp = 0; this.busy = null; this.lastError = '';
    try { this.id = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { /* none yet */ }
    if (!(this.id && this.id.uid && this.id.refreshToken) && this.enabled()) {
      try {
        const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase-identity.json'), 'utf8'));
        if (shipped && shipped.uid && shipped.refreshToken) { this.id = shipped; this._save(); }
      } catch (e) { this.id = null; }
    }
  }
  enabled() { return !this.cfg.FIREBASE_AUTH && !!this.cfg.FIREBASE_API_KEY; }
  get uid() { return (this.id && this.id.uid) || ''; }
  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.id, null, 2), { mode: 0o600 }); }
    catch (e) { log('warn', 'could not save the Firebase identity: ' + e.message); }
  }
  invalidate() { this.exp = 0; }
  // the value for "?auth=" ('' = none / not available right now)
  async get() {
    if (this.cfg.FIREBASE_AUTH) return this.cfg.FIREBASE_AUTH;
    if (!this.enabled()) return '';
    if (this.token && Date.now() < this.exp - 300000) return this.token;
    if (!this.busy) this.busy = this._fetch().finally(() => { this.busy = null; });
    return this.busy;
  }
  async _fetch() {
    const key = encodeURIComponent(this.cfg.FIREBASE_API_KEY);
    const hdr = { Referer: this.cfg.FIREBASE_REFERER };
    if (this.id && this.id.refreshToken) {
      const r = await httpForm('POST', this.cfg.FIREBASE_TOKEN_URL + '?key=' + key, Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, hdr),
        'grant_type=refresh_token&refresh_token=' + encodeURIComponent(this.id.refreshToken));
      if (r.status === 200 && r.json && r.json.id_token) {
        this.token = r.json.id_token; this.exp = Date.now() + (Number(r.json.expires_in) || 3600) * 1000; this.lastError = '';
        if (r.json.refresh_token && r.json.refresh_token !== this.id.refreshToken) { this.id.refreshToken = r.json.refresh_token; this._save(); }
        return this.token;
      }
      const why = (r.json && r.json.error && (r.json.error.message || r.json.error)) || ('HTTP ' + r.status + ' ' + r.body.slice(0, 80));
      if (String(why) !== this.lastError) log('warn', 'firebase sign-in failed: ' + why + (r.status === 0 ? ' (no internet?)' : ''));
      this.lastError = String(why);
      return '';
    }
    const r = await httpForm('POST', this.cfg.FIREBASE_SIGNUP_URL + '?key=' + key, Object.assign({ 'Content-Type': 'application/json' }, hdr), JSON.stringify({ returnSecureToken: true }));
    if (r.status === 200 && r.json && r.json.localId && r.json.refreshToken) {
      this.id = { uid: r.json.localId, refreshToken: r.json.refreshToken, createdAt: new Date().toISOString() }; this._save();
      this.token = r.json.idToken; this.exp = Date.now() + (Number(r.json.expiresIn) || 3600) * 1000; this.lastError = '';
      log('warn', 'firebase: NEW Pi identity ' + this.id.uid + ' - add this uid to the tech2forms Realtime Database rules (README)');
      return this.token;
    }
    const why = (r.json && r.json.error && (r.json.error.message || r.json.error)) || ('HTTP ' + r.status);
    if (String(why) !== this.lastError) log('warn', 'firebase sign-up failed: ' + why);
    this.lastError = String(why);
    return '';
  }
}

// =====================================================================================
// FIREBASE MIRROR  (SSE stream in, PATCH/DELETE out)
// =====================================================================================
class Firebase extends EventEmitter {
  constructor(store, cfg, auth) {
    super();
    this.store = store; this.cfg = cfg; this.auth = auth || new FirebaseAuth(cfg);
    this.base = cfg.FIREBASE_URL.replace(/\/$/, '');
    this.oldBase = String(cfg.FIREBASE_OLD_URL || '').replace(/\/$/, '');
    if (this.oldBase === this.base) this.oldBase = '';
    this.connected = {}; this.lastEventAt = {}; this.streams = {}; this.stopped = false;
    this.pushing = false; this.pushDisabledUntil = {}; this.pushErrors = 0;
    this.everSnapshot = {};
    this.nodes = {
      meshaccounts: { apply: (p, d, patch) => this._applyChildren('accounts', p, d, patch, this.oldBase ? 'new' : undefined) },
      emergencies: { apply: (p, d, patch) => this._applyChildren('emergencies', p, d, patch) },
      messages: { apply: (p, d, patch) => this._applyChildren('messages', p, d, patch) },
      settings: { apply: (p, d, patch) => this._applySettings(p, d, patch) },
      meshInfrastructure: { apply: (p, d, patch) => this._applyInfra(p, d, patch) }
    };
    // the accounts of the old database: read, and their own changes written back there
    if (this.oldBase) this.nodes['meshaccounts~old'] = { path: 'meshaccounts', old: true, apply: (p, d, patch) => this._applyChildren('accounts', p, d, patch, 'old') };
    store.on('dirty', () => this.schedulePush());
  }

  async authQs(old) {
    const t = old ? '' : await this.auth.get();
    return t ? '?auth=' + encodeURIComponent(t) : '';
  }

  start() {
    if (!this.cfg.FIREBASE_SYNC) { log('info', 'Firebase sync disabled'); return; }
    this._switchDatabase();
    for (const node of Object.keys(this.nodes)) this._stream(node, 0);
    this.pushTimer = setInterval(() => this.push(), 8000); this.pushTimer.unref();
    this.reconTimer = setInterval(() => { for (const n of Object.keys(this.streams)) if (this.connected[n] && Date.now() - (this.lastEventAt[n] || 0) > 90000) this._kill(n); }, 30000);
    this.reconTimer.unref();
  }
  stop() {
    this.stopped = true;
    for (const n of Object.keys(this.streams)) this._kill(n);
    clearInterval(this.pushTimer); clearInterval(this.reconTimer);
  }
  _kill(node) { try { this.streams[node] && this.streams[node].destroy(); } catch (e) { /* ignore */ } }
  isOnline() { return this.connected.meshaccounts === true; }

  async _stream(node, attempt, urlOverride) {
    if (this.stopped) return;
    const def = this.nodes[node];
    const url = new URL(urlOverride || ((def.old ? this.oldBase : this.base) + '/' + (def.path || node) + '.json' + await this.authQs(def.old)));
    if (this.stopped) return;
    const lib = url.protocol === 'http:' ? http : https;
    let buf = '';
    const retry = () => {
      this.connected[node] = false;
      if (this.stopped) return;
      const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(attempt, 5)));
      setTimeout(() => this._stream(node, attempt + 1), delay).unref();
    };
    let done = false;
    const finish = (why) => { if (done) return; done = true; if (why) log('debug', 'firebase ' + node + ' stream ended: ' + why); retry(); };
    const req = lib.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); done = true;
        return this._stream(node, attempt, res.headers.location);
      }
      if (res.statusCode !== 200) {
        res.resume();
        if (attempt === 0 || attempt % 10 === 0) log('warn', 'firebase ' + node + ' HTTP ' + res.statusCode + (res.statusCode === 401 && !def.old ? ' - not allowed: are the tech2forms rules published with this Pi uid ' + this.auth.uid + '?' : ''));
        if (res.statusCode === 401 && !def.old) this.auth.invalidate();
        return finish('http ' + res.statusCode);
      }
      this.streams[node] = req;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          this._event(node, block);
        }
      });
      res.on('end', () => finish('end'));
      res.on('error', (e) => finish(e.message));
      res.on('close', () => finish('close'));
      attempt = 0;
    });
    req.setTimeout(120000, () => req.destroy(new Error('idle timeout')));
    req.on('error', (e) => {
      if (attempt === 0) log('info', 'firebase ' + node + ': offline (' + (e.code || e.message) + ') - using saved Pi data');
      finish(e.message);
    });
  }

  _event(node, block) {
    let ev = '', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    this.lastEventAt[node] = Date.now();
    if (ev === 'keep-alive') return;
    if (ev === 'cancel' || ev === 'auth_revoked') {
      if (ev === 'auth_revoked') this.auth.invalidate(); else log('warn', 'firebase ' + node + ' ' + ev);   // the token runs out every hour: a fresh one, quietly
      this._kill(node); return;
    }
    if (ev !== 'put' && ev !== 'patch') return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { log('warn', 'firebase ' + node + ': bad event JSON'); return; }
    if (!msg || typeof msg.path !== 'string') return;
    const isFirst = !this.connected[node];
    if (isFirst) { this.connected[node] = true; if (node === 'meshaccounts') log('info', 'firebase: ONLINE - streaming live data'); }
    try { this.nodes[node].apply(msg.path, msg.data, ev === 'patch', isFirst); }
    catch (e) { log('error', 'firebase apply ' + node + ': ' + (e.stack || e.message)); }
    if (isFirst) { this.everSnapshot[node] = Date.now(); this.schedulePush(); }
  }

  // ---- applying stream events to the store ----
  // src (accounts only, when there are two databases): 'new' = tech2forms, 'old' = the old mesh database. Each account
  // remembers where it lives (meta.acctSrc); a stream only ever removes or overwrites the accounts of its own database.
  _applyChildren(kind, p, data, isPatch, src) {
    const s = this.store;
    const parts = p.split('/').filter(Boolean);
    const dirty = new Set(s.meta.dirty[kind]);
    const tomb = s.meta.tombstones[kind] || [];
    const srcMap = s.meta.acctSrc;
    const mine = (id) => !src || (src === 'new' ? srcMap[id] === 'new' : srcMap[id] !== 'new');
    const upsert = (id, val, replace) => {
      if (val === null || val === undefined) {
        if (kind === 'accounts') { if (mine(id)) s.removeAccount(id, {}); }
        else if (kind === 'emergencies') s.removeEmergency(id, {});
        else if (kind === 'messages' && s.messages.has(id)) { s.messages.delete(id); s.touch('messages'); }
        return;
      }
      if (!isObj(val)) return;
      if (kind === 'accounts') {
        if (src && srcMap[id] !== src && !(src === 'old' && srcMap[id] === 'new')) { srcMap[id] = src; s.scheduleSave('meta'); }
        if (src === 'old' && srcMap[id] === 'new') return;   // (the same id in both: tech2forms wins)
        if (dirty.has(id)) return;                // our offline edit wins until pushed
        s.upsertAccount(Object.assign({}, val, { id: val.id || id }), { key: id, replace: !s.protectedIds.has(id), fromFirebase: true });   // built-in accounts are merged, never replaced by a partial cloud node
      } else if (kind === 'emergencies') {
        if (tomb.includes(id)) return;
        s.upsertEmergency(Object.assign({}, val, { id: val.id || id }), { authoritative: !dirty.has(id) });
      } else {
        s.upsertMessage(Object.assign({}, val, { id: val.id || id }), {});
      }
    };

    if (parts.length === 0) {
      // root: full snapshot (put) or multi-child merge (patch)
      if (!isObj(data) && data !== null) return;
      const tree = data || {};
      if (isPatch) { for (const [id, v] of Object.entries(tree)) upsert(id, v); return; }
      const seen = new Set(Object.keys(tree));
      for (const [id, v] of Object.entries(tree)) upsert(id, v);
      // things we hold that Firebase no longer has -> deleted upstream, unless we have unpushed local work
      const local = kind === 'accounts' ? [...s.accounts.keys()] : kind === 'emergencies' ? [...s.emergencies.keys()] : [...s.messages.keys()];
      let removed = 0;
      for (const id of local) {
        if (seen.has(id)) continue;
        if (dirty.has(id)) continue;
        if (kind === 'accounts' && s.protectedIds.has(id)) continue;
        if (kind === 'accounts' && !mine(id)) continue;      // lives in the other database
        if (kind === 'emergencies' && s.meta.emVia[id] === 'lora' && !this.everSnapshot.emergencies) continue;
        if (kind === 'messages' && !dirty.has(id)) {
          // messages the Pi holds that Firebase does not (e.g. private chats never pushed) are kept
          continue;
        }
        if (kind === 'accounts') s.removeAccount(id, {}); else if (kind === 'emergencies') s.removeEmergency(id, {});
        removed++;
      }
      // tombstones that Firebase has already dropped are done
      if (tomb.length) { s.meta.tombstones[kind] = tomb.filter(id => seen.has(id) || (kind === 'accounts' && !mine(id))); s.scheduleSave('meta'); }
      log('info', 'firebase ' + kind + (src === 'old' ? ' (old database)' : '') + ' snapshot: ' + seen.size + ' records' + (removed ? ' (' + removed + ' removed upstream)' : ''));
      return;
    }
    const id = parts[0];
    if (parts.length === 1) {
      if (isPatch && isObj(data)) { const cur = kind === 'accounts' ? s.accounts.get(id) : kind === 'emergencies' ? s.emergencies.get(id) : s.messages.get(id); upsert(id, Object.assign({}, cur || {}, data)); }
      else upsert(id, data);
      return;
    }
    // deeper path: a single field changed
    const cur = kind === 'accounts' ? s.accounts.get(id) : kind === 'emergencies' ? s.emergencies.get(id) : s.messages.get(id);
    if (!cur) return;
    if (kind === 'accounts' && parts[1] === 'idPhoto' && parts.length === 2) {
      if (typeof data === 'string') s.setPhoto(id, data); else { try { fs.unlinkSync(s.photoFile(id)); } catch (e) { /* none */ } }
      s.touch('accounts'); return;
    }
    if (dirty.has(id)) return;
    const copy = JSON.parse(JSON.stringify(cur));
    if (isPatch && isObj(data)) { for (const [k, v] of Object.entries(data)) setDeep(copy, parts.slice(1).concat(k), v); }
    else setDeep(copy, parts.slice(1), data);
    if (kind === 'accounts') s.upsertAccount(copy, { replace: true, fromFirebase: true });
    else if (kind === 'emergencies') s.upsertEmergency(copy, { authoritative: true });
    else s.upsertMessage(copy, {});
  }

  _applySettings(p, data, isPatch) {
    const s = this.store;
    const parts = p.split('/').filter(Boolean);
    if (s.meta.dirty.settings) return;   // unpushed local change wins
    if (parts.length === 0) {
      if (isObj(data)) { if (isPatch) s.mergeSettings(data, {}); else s.mergeSettings(data, { replace: true }); }
      else if (data === null && !isPatch) s.mergeSettings({}, { replace: true });
      return;
    }
    const copy = JSON.parse(JSON.stringify(s.settings));
    if (isPatch && isObj(data)) for (const [k, v] of Object.entries(data)) setDeep(copy, parts.concat(k), v);
    else setDeep(copy, parts, data);
    s.mergeSettings(copy, { replace: true });
  }

  _applyInfra(p, data, isPatch) {
    const s = this.store;
    if (s.meta.dirty.infra) return;
    const parts = p.split('/').filter(Boolean);
    if (parts.length === 0) {
      if (isObj(data)) { if (isPatch) s.setInfra(Object.assign({}, s.infra, data)); else s.setInfra(data); }
      else if (data === null && !isPatch) s.setInfra({});
      return;
    }
    const copy = JSON.parse(JSON.stringify(s.infra));
    if (isPatch && isObj(data)) for (const [k, v] of Object.entries(data)) setDeep(copy, parts.concat(k), v);
    else setDeep(copy, parts, data);
    s.setInfra(copy);
  }

  // ---- moving to another database (2026-10-27: mesh-project-amping -> tech2forms) ----
  // The first snapshot of a database removes what it does not have - so on the first start against a NEW database
  // everything the Pi holds is marked "to upload" first: requests, chat, settings and the map move up instead of being
  // wiped. Accounts are not moved: the old ones stay in the old database (read from there, changes written back there).
  _switchDatabase() {
    const s = this.store, m = s.meta;
    if (m.fbBase === this.base) return;
    const had = m.fbBase;
    m.fbBase = this.base;
    if (had === undefined && !s.emergencies.size && !s.messages.size) { s.scheduleSave('meta'); return; }   // a fresh Pi: nothing to move
    const add = (kind, ids) => { const set = new Set(m.dirty[kind]); for (const id of ids) set.add(id); m.dirty[kind] = [...set]; };
    add('emergencies', s.emergencies.keys());
    add('messages', [...s.messages.entries()].filter(([, v]) => chanOf(v) !== 'private').map(([k]) => k));
    if (Object.keys(s.settings || {}).length) m.dirty.settings = true;
    if (Object.keys(s.infra || {}).length) m.dirty.infra = true;
    m.tombstones.emergencies = [];
    m.fbSwitchedAt = Date.now();
    s.scheduleSave('meta');
    log('warn', 'firebase: new database ' + this.base + ' - uploading ' + s.emergencies.size + ' requests, ' + m.dirty.messages.length + ' messages, settings and map; old accounts stay in ' + (this.oldBase || had || 'the old database'));
  }

  // ---- pushing offline changes upstream ----
  schedulePush() { if (this._pt) return; this._pt = setTimeout(() => { this._pt = null; this.push(); }, 1500); this._pt.unref(); }

  async _req(method, p, body, old) {
    const qs = await this.authQs(old);
    return new Promise((resolve) => {
      const url = new URL((old ? this.oldBase : this.base) + '/' + p + '.json' + qs);
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.request(url, { method, headers: Object.assign({ Accept: 'application/json' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, (res) => {
        let out = ''; res.setEncoding('utf8');
        res.on('data', d => { out += d; if (out.length > 4096) out = out.slice(0, 4096); });
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      });
      req.setTimeout(20000, () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ status: 0, body: e.message }));
      if (data) req.write(data);
      req.end();
    });
  }

  async push() {
    if (!this.cfg.FIREBASE_SYNC || !this.cfg.FIREBASE_PUSH || this.pushing || this.stopped) return;
    if (!this.isOnline()) return;
    const s = this.store;
    const d = s.meta.dirty, t = s.meta.tombstones;
    const any = d.accounts.length || d.emergencies.length || d.messages.length || d.settings || d.infra || t.accounts.length || t.emergencies.length;
    if (!any) return;
    this.pushing = true;
    try {
      const guard = async (key, fn) => {
        if ((this.pushDisabledUntil[key] || 0) > Date.now()) return;
        const r = await fn();
        if (r === 'denied') { this.pushDisabledUntil[key] = Date.now() + 10 * 60000; log('warn', 'firebase push "' + key + '" denied by database rules - will retry in 10 min (changes stay saved on the Pi)'); }
      };
      const send = async (method, p, body, old) => {
        const r = await this._req(method, p, body, old);
        if (r.status === 401 && !old) this.auth.invalidate();
        if (r.status >= 200 && r.status < 300) return 'ok';
        if (r.status === 401 || r.status === 403) return 'denied';
        this.pushErrors++; log('debug', 'firebase push ' + method + ' ' + p + ' -> ' + r.status + ' ' + r.body.slice(0, 80));
        return 'fail';
      };
      // an account goes back to the database it came from; one the Pi made itself goes to tech2forms. Until the old
      // database has answered once (10 minutes at most) an account of unknown origin waits.
      const srcMap = s.meta.acctSrc;
      const oldKnown = !this.oldBase || this.everSnapshot['meshaccounts~old'] || (this.everSnapshot.meshaccounts && Date.now() - this.everSnapshot.meshaccounts > 600000);
      const toOld = (id) => !!this.oldBase && srcMap[id] === 'old';
      const ready = (id) => oldKnown || srcMap[id] === 'new' || srcMap[id] === 'old';
      await guard('accounts', async () => {
        for (const id of [...d.accounts]) {
          const a = s.accounts.get(id);
          if (!a) { s.clearDirty('accounts', id); continue; }
          if (!ready(id)) continue;
          const old = toOld(id);
          if (this.oldBase && !old && srcMap[id] !== 'new') { srcMap[id] = 'new'; s.scheduleSave('meta'); }
          const r = await send('PATCH', 'meshaccounts/' + encodeURIComponent(id), a, old);
          if (r === 'ok') s.clearDirty('accounts', id); else if (r === 'denied') return 'denied';
        }
        for (const id of [...t.accounts]) {
          if (!ready(id)) continue;
          const r = await send('DELETE', 'meshaccounts/' + encodeURIComponent(id), undefined, toOld(id));
          if (r === 'ok') { t.accounts.splice(t.accounts.indexOf(id), 1); s.scheduleSave('meta'); } else if (r === 'denied') return 'denied';
        }
      });
      await guard('emergencies', async () => {
        const MUTABLE = ['status', 'dispatchedTime', 'completedTime', 'cancelledTime', 'binnedTime', 'archivedTime', 'escalatedTime', 'escalationReason', 'declineReason', 'damageStatus', 'isForcedPriority', 'severity', 'riskRate', 'triageFact'];
        for (const id of [...d.emergencies]) {
          const e = s.emergencies.get(id);
          if (!e) { s.clearDirty('emergencies', id); continue; }
          // The app writes the FULL record itself whenever it has internet, and the radio copy is shortened - so never
          // overwrite an existing record with it: create it if Firebase has none, otherwise only update the changeable fields.
          const probe = await this._req('GET', 'emergencies/' + encodeURIComponent(id) + '/status');
          if (probe.status === 401 || probe.status === 403) return 'denied';
          if (probe.status < 200 || probe.status >= 300) continue;
          let r;
          if (probe.body.trim() === 'null') r = await send('PUT', 'emergencies/' + encodeURIComponent(id), e);
          else {
            const patch = {}; for (const k of MUTABLE) if (e[k] !== undefined) patch[k] = e[k];
            // a request moved by its owner (MOVE_SOS) carries its new position up too - else the old cloud copy comes back
            if (e.manualPin !== undefined) { patch.lat = e.lat; patch.lon = e.lon; patch.manualPin = !!e.manualPin; patch.pinnedAt = e.pinnedAt || null; }
            r = await send('PATCH', 'emergencies/' + encodeURIComponent(id), patch);
          }
          if (r === 'ok') s.clearDirty('emergencies', id); else if (r === 'denied') return 'denied';
        }
        for (const id of [...t.emergencies]) {
          const r = await send('DELETE', 'emergencies/' + encodeURIComponent(id));
          if (r === 'ok') { t.emergencies.splice(t.emergencies.indexOf(id), 1); s.scheduleSave('meta'); } else if (r === 'denied') return 'denied';
        }
      });
      await guard('messages', async () => {
        for (const id of [...d.messages]) {
          const m = s.messages.get(id);
          if (!m || chanOf(m) === 'private') { s.clearDirty('messages', id); continue; }
          const v = messageToVerbose(m);
          const r = await send('PUT', 'messages/' + encodeURIComponent(v.id || id), v);
          if (r === 'ok') s.clearDirty('messages', id); else if (r === 'denied') return 'denied';
        }
      });
      await guard('settings', async () => {
        if (!d.settings) return;
        const r = await send('PATCH', 'settings', s.settings);
        if (r === 'ok') { d.settings = false; s.scheduleSave('meta'); } else if (r === 'denied') return 'denied';
      });
      await guard('infra', async () => {
        if (!d.infra) return;
        const r = await send('PUT', 'meshInfrastructure', s.infra);
        if (r === 'ok') { d.infra = false; s.scheduleSave('meta'); } else if (r === 'denied') return 'denied';
      });
    } finally { this.pushing = false; }
  }
}

// =====================================================================================
// HELTEC 1 BRIDGE  (USB serial JSON lines <-> store)
// =====================================================================================
// account book batches to the field node (see Bridge.bookTick)
const BOOK_MAX = 600;                 // = BOOK_MAX in heltec2-remote-node.c
const BOOK_BATCH = 560, BOOK_BATCH_WEAK = 380;   // bytes of one batch (3 fast pieces / 5 short pieces)
const BOOK_GAP_MS = 2500, BOOK_GAP_WEAK_MS = 8000;
const BOOK_FW = '2026-10-28b';         // both boards need it: an older field node shows a BOOK batch (PINs!) to its phones,
                                       // an older Heltec 1 sends batches into the field's SOS (no "bg")

class Bridge extends EventEmitter {
  constructor(store, engine, cfg, deps) {
    super();
    this.store = store; this.engine = engine; this.cfg = cfg; this.deps = deps || {};
    this.transport = null; this.connected = false; this.helloSeen = false; this.fwAck = false;
    this.queue = []; this.inflight = null; this.lastRxAt = 0; this.lastLoraAt = 0; this.portName = '';
    this.stats = { rxMsg: 0, rxSos: 0, logins: 0, loginDenied: 0, tx: 0, acks: 0, ackTimeouts: 0 };
    this.stopped = false; this.rxBuf = '';
    // what the doctor shows when Heltec 1 does not connect
    this.diag = { portsSeen: [], scanAt: 0, openedAt: 0, openError: '', bytesIn: 0, linesIn: 0, lastText: '', lastLineAt: 0 };
    this._portFail = {};
    // the field node's firmware, from its BOOK_STATE - kept over restarts of the Pi (it reports only every 30 minutes)
    this._bookNode = isObj(store.meta.bookNode) && store.meta.bookNode.fw ? { fw: str(store.meta.bookNode.fw), at: Number(store.meta.bookNode.at) || 0 } : null;
    this._wire();
  }

  // ---- store -> radio ----
  _wire() {
    const s = this.store;
    s.on('settings', (now, old) => this.relaySettings(now, old));
    s.on('emergency', (e, old, result) => {
      if (!this.connected) return;
      const fromField = s.meta.emVia[e.id] === 'lora';
      if (fromField && old && old.status !== e.status) {
        const c = { action: 'UPDATE_SOS', id: e.id, st: ascii(e.status, 20) };
        if (e.damageStatus) c.dmg = e.damageStatus.charAt(0);
        this.enqueue('control', { type: 'control', data: c }, 1, 'us|' + e.id);
      }
      // keep the field nodes' request list current (responders on a field node see requests made on the Pi side,
      // and finished ones disappear). Field-made requests are already in Heltec 1's broadcast cache when new.
      const act = ACTIVE_ST.has(str(e.status).toLowerCase()), wasAct = !!old && ACTIVE_ST.has(str(old.status).toLowerCase());
      const moved = !!old && (Number(old.lat) !== Number(e.lat) || Number(old.lon) !== Number(e.lon));
      // triage set on the Pi (forced priority / severity) used to stay on the Pi
      const triaged = !!old && (!!old.isForcedPriority !== !!e.isForcedPriority || str(old.severity) !== str(e.severity));
      if ((act && (!old ? !fromField : (old.status !== e.status || moved || triaged))) || (!act && wasAct)) {
        this.enqueue('sync', { type: 'sync', kind: 'eme', data: this._pack(emergencyToCompact(e)) }, 2, 'eme|' + e.id);
      }
    });
    s.on('message', (m, old, opts) => {
      if (!this.connected || old) return;
      const via = opts && opts.via;
      if (via === 'lora') return;                       // Heltec 1 already re-broadcasts what it relays
      const ch = chanOf(m);
      if (ch !== 'community' && ch !== 'official' && ch !== 'private' && ch !== 'emergency_chat') return;   // private + request chat cross the radio too
      const ts = Number(m.timestamp || m.ts) || Date.now();
      if (Date.now() - ts > 15 * 60000) return;         // don't flood the radio with old history
      this.enqueue('sync', { type: 'sync', kind: 'msg', data: this._pack(messageToCompact(m)) }, 2, 'msg|' + str(m.id || m.i));
    });
    s.on('account', (a, old, result) => {
      if (!this.connected || !old) return;
      if (!s.meta.fieldSeen.includes(a.id)) return;
      if (old.status === a.status && old.role === a.role) return;
      this.enqueue('sync', { type: 'sync', kind: 'acc', data: accountToCompact(a) }, 2, 'acc|' + a.id);
    });
  }

  relaySettings(now, old) {
    if (!this.connected) return;
    const a = old || {};
    const wasActive = !!a.redAlertActive, isActive = !!now.redAlertActive;
    if (isActive && (!wasActive || a.redAlertTimestamp !== now.redAlertTimestamp || a.redAlertHazard !== now.redAlertHazard)) {
      this.enqueue('control', { type: 'control', data: { action: 'RED_ALERT', global: true, hazard: ascii(now.redAlertHazard, 40), act: ascii(now.redAlertAction, 60), ts: now.redAlertTimestamp || Date.now() } }, 1, 'ra|global');
    } else if (!isActive && wasActive) {
      this.enqueue('control', { type: 'control', data: { action: 'STOP_ALERT', global: true } }, 1, 'ra|global');
    }
    const cur = now.barangayRedAlerts || {}, prev = a.barangayRedAlerts || {};
    for (const b of Object.keys(cur)) {
      const c = cur[b] || {}, p = prev[b] || {};
      if (c.active && (!p.active || p.timestamp !== c.timestamp)) {
        this.enqueue('control', { type: 'control', data: { action: 'RED_ALERT', global: false, brgy: ascii(b, 24), purok: ascii(c.targetPurok, 12), hazard: ascii(c.hazard, 40), act: ascii(c.action, 60), ts: c.timestamp || Date.now() } }, 1, 'ra|' + b);
      } else if (!c.active && p.active) {
        this.enqueue('control', { type: 'control', data: { action: 'STOP_ALERT', global: false, brgy: ascii(b, 24) } }, 1, 'ra|' + b);
      }
    }
    this.enqueue('sync', { type: 'sync', kind: 'set', data: fieldSettings(now, this.cfg) }, 2, 'set');
  }

  // Everything the field should know right after (re)connecting.
  // Everything the field should know right after (re)connecting. bg: Heltec 1 keeps these for its repeat cycle but
  // does not let them hold up fresh news (firmware 2026-10-20c; older firmware ignores the flag).
  resync() {
    const s = this.store;
    this.enqueue('sync', { type: 'sync', bg: true, kind: 'set', data: fieldSettings(s.settings, this.cfg) }, 2, 'set');
    const msgs = [...s.messages.values()].filter(m => ['community', 'official'].includes(chanOf(m)))
      .sort((a, b) => (Number(a.timestamp || a.ts) || 0) - (Number(b.timestamp || b.ts) || 0)).slice(-8);
    for (const m of msgs) this.enqueue('sync', { type: 'sync', bg: true, kind: 'msg', data: this._pack(messageToCompact(m)) }, 2, 'msg|' + str(m.id || m.i));
    const active = [...s.emergencies.values()].filter(e => ['pending', 'dispatched', 'escalated_pending', 'escalated_dispatched'].includes(str(e.status).toLowerCase())).slice(-8);
    for (const e of active) this.enqueue('sync', { type: 'sync', bg: true, kind: 'eme', data: this._pack(emergencyToCompact(e)) }, 2, 'eme|' + e.id);
    const staff = [...s.accounts.values()].filter(a => ['superadmin', 'admin', 'authority', 'ambulance', 'rescue', 'evacuation', 'relief'].includes(a.role) && a.status === 'approved').slice(0, 8);
    for (const a of staff) this.enqueue('sync', { type: 'sync', bg: true, kind: 'acc', data: accountToCompact(a) }, 2, 'acc|' + a.id);
    log('info', 'radio resync queued (' + this.queue.length + ' items)');
  }

  // ---- outgoing queue with firmware flow control ----
  enqueue(cls, obj, prio, dedupeKey, onAck) {
    if (!this.connected) return null;
    if (dedupeKey) { const i = this.queue.findIndex(q => q.key === dedupeKey); if (i >= 0) this.queue.splice(i, 1); }
    const item = { cls, obj, prio, key: dedupeKey, at: Date.now(), onAck };
    this.queue.push(item);
    this.queue.sort((a, b) => a.prio - b.prio || a.at - b.at);
    while (this.queue.length > 150) { const i = this.queue.map(q => q.prio).lastIndexOf(2); this.queue.splice(i >= 0 ? i : this.queue.length - 1, 1); }
    this.pump();
    return item;
  }

  pump() {
    if (this.inflight || !this.connected || !this.queue.length) return;
    const item = this.queue.shift();
    let line;
    try { line = JSON.stringify(item.obj) + '\n'; } catch (e) { return this.pump(); }
    if (line.length > 1900) { log('warn', 'radio line too long, dropped: ' + item.cls); return this.pump(); }
    this.inflight = item;
    this.stats.tx++;
    try { this.transport.write(line); } catch (e) { log('warn', 'serial write failed: ' + e.message); this.inflight = null; return; }
    // control / login answers are sent to the field with retries (up to 75 s on a busy channel; the board says "busy" meanwhile)
    const wait = this.fwAck ? (item.cls === 'sync' ? 5000 : item.cls === 'pos' ? 8000 : 90000) : (item.cls === 'sync' ? 250 : 4500);
    clearTimeout(this._ackT);
    this._ackT = setTimeout(() => {
      if (this.inflight === item) {
        if (this.fwAck) { this.stats.ackTimeouts++; log('warn', 'Heltec 1 did not confirm ' + item.cls + ' in time'); }
        this.inflight = null;
        if (item.onAck) { try { item.onAck(false); } catch (e) { /* ignore */ } }
        this.pump();
      }
    }, wait);
  }

  _acked(o) {
    this.stats.acks++;
    clearTimeout(this._ackT);
    const item = this.inflight;
    this.inflight = null;
    if (item && item.onAck) { try { item.onAck(!(o && o.ok === false)); } catch (e) { /* ignore */ } }
    // ok:false = the field node never confirmed a control / login answer over the radio: try again (it was dropped before)
    if (o && o.ok === false && item && (item.cls === 'control' || item.cls === 'login') && (item.tries || 0) < 2) {
      this.stats.radioRetries = (this.stats.radioRetries || 0) + 1;
      log('info', 'field node did not confirm ' + item.cls + ' - sending it again');
      const again = Object.assign({}, item, { tries: (item.tries || 0) + 1, at: Date.now() });
      if (!again.key || !this.queue.some(q => q.key === again.key)) { this.queue.unshift(again); }
      setTimeout(() => this.pump(), 1500 + Math.floor(Math.random() * 1500));
      return;
    }
    setTimeout(() => this.pump(), 40);
  }

  // ---- lines from Heltec 1 ----
  onData(chunk) {
    this.diag.bytesIn += chunk.length;
    // a letter like ñ is two bytes and the USB serial port can split them over two reads - decode across reads
    if (!this.rxDec) this.rxDec = new StringDecoder('utf8');
    this.rxBuf += typeof chunk === 'string' ? chunk : this.rxDec.write(chunk);
    if (this.rxBuf.length > 20000) this.rxBuf = this.rxBuf.slice(-4000);
    let i;
    while ((i = this.rxBuf.indexOf('\n')) >= 0) {
      const line = this.rxBuf.slice(0, i).trim(); this.rxBuf = this.rxBuf.slice(i + 1);
      if (line) { this.diag.linesIn++; this.diag.lastLineAt = Date.now(); this.diag.lastText = line.slice(0, 120); }
      if (line[0] === '{') this.onLine(line);
    }
  }

  onLine(line) {
    let o; try { o = JSON.parse(line); } catch (e) { return; }
    if (!isObj(o)) return;
    this.lastRxAt = Date.now();
    const s = this.store;
    switch (o.type) {
      case 'hello':
        this.helloSeen = true; this.fwVer = o.v | 0; this.fwAck = this.fwVer >= 2; this.connected = true; if (o.fw) this.fwBuild = str(o.fw);
        log('info', 'Heltec 1 online (' + (this.fwAck ? 'flow-controlled' : 'legacy pacing') + ' firmware v' + this.fwVer + ') on ' + this.portName);
        this.inflight = null; this.queue = [];
        setTimeout(() => this.resync(), 800);
        this.emit('hello');
        break;
      case 'pong':
        if (typeof o.fa === 'number') { this.fieldAgeS = o.fa; this.fieldAgeAt = Date.now(); }   // Heltec 1 heard a field node fa s ago (-1 never)
        // requests / messages Heltec 1 received while this Pi was not reading the port (service restart, boot):
        // it hands them over by itself, this is only to show it (firmware 2026-10-29a)
        if (typeof o.held === 'number') {
          if (o.held > 0 && o.held !== this.heldAtBridge) log('warn', 'Heltec 1 is holding ' + o.held + ' field payload(s) that arrived while this command center was not listening - it hands them over now');
          this.heldAtBridge = o.held;
        }
        if (o.fw) this.fwBuild = str(o.fw);
        // how well Heltec 1 hears the field (firmware 2026-10-21a): q good/fair/weak, rs RSSI dBm, sn SNR dB (sa average), ls lost pieces
        if (isObj(o.sig)) {
          const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
          this.signal = { q: str(o.sig.q), rssi: n(o.sig.rs), snr: n(o.sig.sn), snrAvg: n(o.sig.sa), lost: n(o.sig.ls), heardAt: Date.now() - (n(o.sig.ago) || 0) * 1000 };
        }
        // the board was already running when the Pi opened the port, so its boot "hello" was missed:
        // newer firmware puts its version in the pong - treat that as the hello
        if (!this.helloSeen && (o.v | 0) >= 2) return this.onLine(JSON.stringify({ type: 'hello', v: o.v | 0 }));
        this.connected = true; break;
      case 'ack': this._acked(o); break;
      case 'log': log(o.level === 'error' ? 'error' : o.level === 'warn' ? 'warn' : 'info', 'Heltec1: ' + str(o.msg)); break;
      case 'msg':
        if (isObj(o.data) && o.data.action === 'BOOK_STATE') { this.lastLoraAt = Date.now(); this.onBookState(o.data); break; }
        if (isObj(o.data) && !o.data.action) o.data = this._unpack(o.data, 'chat');
        if (isObj(o.data)) {
          this.lastLoraAt = Date.now(); this.stats.rxMsg++; s.meta.counters.loraMsgIn++;
          this.engine.handle('msg', o.data, 'lora');
          if (o.data.action) log('info', 'LoRa action ' + str(o.data.action) + (o.data.id !== undefined ? ' ' + str(o.data.id) : '') + (o.data.st ? ' -> ' + str(o.data.st) : '') + (o.data.brgy ? ' (' + str(o.data.brgy) + ')' : ''));
          else log('info', 'LoRa chat from ' + str(o.data.n) + ': ' + str(o.data.x).slice(0, 50));
        }
        break;
      case 'sos':
        if (isObj(o.data)) o.data = this._unpack(o.data, 'SOS');
        if (isObj(o.data)) {
          this.lastLoraAt = Date.now(); this.stats.rxSos++; s.meta.counters.loraSosIn++;
          this.engine.handle('sos', o.data, 'lora');
          log('info', 'LoRa SOS ' + str(o.data.ty) + ' from ' + str(o.data.n) + ' (' + str(o.data.b) + ')');
        }
        break;
      case 'login_query': this.onLoginQuery(o); break;
      case 'pos':
        if (isObj(o.data) && this.deps.positions) {
          this.lastLoraAt = Date.now(); this.stats.rxPos = (this.stats.rxPos || 0) + 1;
          const n = this.deps.positions.fromLora(o.data.p);
          log('debug', 'LoRa positions: ' + n);
        }
        break;
      default: break;
    }
  }

  // every 20 s: send the positions that changed on the Pi side out to the field (firmware v3+ only)
  pumpPositions() {
    if (!this.connected || (this.fwVer | 0) < 3 || !this.deps.positions) return;
    if (this.queue.some(q => q.cls === 'pos') || (this.inflight && this.inflight.cls === 'pos')) return;
    const batch = this.deps.positions.radioBatch(3);
    if (batch.length) this.enqueue('pos', { type: 'pos', data: { p: batch } }, 1, 'pos');
  }

  // ---- short radio form (see RF_TYPES) ----
  _unpack(d, what) {
    if (d.z === undefined && d.y === undefined) return d;
    const r = radioUnpack(d, (id) => { const a = this.store.accounts.get(id); return a ? accountToCompact(a) : null; });
    this.stats.shortIn = (this.stats.shortIn || 0) + 1;
    if (r.missing) log('warn', 'short radio ' + what + ' ' + str(d.id || d.i) + ': could not rebuild "' + r.missing + '" (account ' + rfAccountId(d) + ' not on this Pi)');
    return r.rec;
  }
  _pack(o) {
    const nf = this._bookNode;
    if (this.cfg.RADIO_SHORT_FORM === false || !nf || !nf.fw || nf.fw < RF_FW) return o;                     // the field node does not read the short form
    const conf = this.store.meta.book || {};
    const out = radioPack(o, (id) => {
      const a = this.store.accounts.get(id); if (!a) return null;
      const c = accountToCompact(a);
      return conf[id] && conf[id] === crypto.createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 8) ? c : null;   // the node holds exactly this
    });
    if (out !== o) this.stats.shortOut = (this.stats.shortOut || 0) + 1;
    return out;
  }

  // ---- the field node's account book (firmware 2026-10-28b) ----
  // Every approved account goes to the field node in small batches (control action BOOK, which Heltec 1 confirms
  // only when the field node got it whole), so a whole class logging in on the field node at the same moment is
  // answered by the node itself instead of one radio question per student (~3 s of airtime each). Only while the
  // radio queue is empty and a field node is in contact, with a pause after every batch so the field keeps the channel
  // for requests. meta.book = what the node confirmed (id -> sig); its BOOK_STATE report (start-up, every 30 min)
  // tells when it lost the book (re-flashed, storage erased): then everything is sent again.
  _bookWant() {
    const want = new Map();
    for (const a of this.store.accounts.values()) {
      if (!a || !a.id || str(a.status).toLowerCase() !== 'approved') continue;
      const c = accountToCompact(a);
      if (!c.i || !c.p) continue;
      c.h = crypto.createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 8);
      want.set(c.i, c);
      if (want.size >= BOOK_MAX) break;
    }
    return want;
  }
  // why the book is not being sent (null = it is, or nothing to send)
  _bookBlocked() {
    if (this.cfg.FIELD_ACCOUNT_BOOK === false) return 'switched off (FIELD_ACCOUNT_BOOK)';
    if (!this.fwBuild || this.fwBuild < BOOK_FW) return 'Heltec 1 needs firmware ' + BOOK_FW + ' or newer (has ' + (this.fwBuild || 'unknown') + ')';
    if (!this._bookNode || !this._bookNode.fw) return 'waiting for the field node to report its firmware (' + BOOK_FW + ' or newer sends it a minute after start-up)';
    if (this._bookNode.fw < BOOK_FW) return 'the field node needs firmware ' + BOOK_FW + ' or newer (has ' + this._bookNode.fw + ')';
    return null;
  }
  bookStatus() {
    const conf = this.store.meta.book || {};
    const want = this._bookWant();
    let have = 0; for (const [id, c] of want) if (conf[id] === c.h) have++;
    const blocked = this.connected ? this._bookBlocked() : 'Heltec 1 not connected';
    return Object.assign({ accounts: want.size, onNode: have, nodeReported: this._bookNode || null, sending: !!this._bookBusy() }, blocked ? { blocked } : {});
  }
  _bookBusy() { const it = this._bookItem; return !!it && (this.inflight === it || this.queue.includes(it)); }
  bookTick() {
    if (this._bookBlocked()) return;
    if (!this.connected || !this.fwAck || this.inflight || this.queue.length || this._bookBusy()) return;
    const weak = !!(this.signal && this.signal.q === 'weak' && Date.now() - this.signal.heardAt < 300000);
    // a field node must be in contact (Heltec 1 heard one in the last 3 minutes)
    if (!(typeof this.fieldAgeS === 'number' && this.fieldAgeS >= 0 && this.fieldAgeS < 180 && Date.now() - this.fieldAgeAt < 60000)) return;
    const gap = this._bookFails ? Math.min(120000, 15000 * this._bookFails) : (weak ? BOOK_GAP_WEAK_MS : BOOK_GAP_MS);
    if (Date.now() - (this._bookDoneAt || 0) < gap) return;
    if (this.lastLoraAt && Date.now() - this.lastLoraAt < 5000) return;     // the field is talking: let it finish
    const s = this.store, conf = s.meta.book;
    const want = this._bookWant();
    const add = [], del = [];
    for (const [id, c] of want) if (conf[id] !== c.h) add.push(c);
    for (const id of Object.keys(conf)) if (!want.has(id)) del.push(id);
    if (!add.length && !del.length && !this._bookReset) return;
    // one batch: short enough that a dispatch never waits long behind it (~3 pieces; 5 short pieces on a weak link)
    const limit = weak ? BOOK_BATCH_WEAK : BOOK_BATCH;
    const batch = { action: 'BOOK' };
    if (this._bookReset) batch.r = 1;
    const a = [], x = [];
    const size = () => JSON.stringify(Object.assign({}, batch, a.length ? { a } : {}, x.length ? { x } : {})).length;
    for (const c of add) { a.push(c); if (a.length > 1 && size() > limit) { a.pop(); break; } }
    for (const id of del) { if (a.length + x.length >= 12) break; x.push(id); if (size() > limit) { x.pop(); break; } }
    if (a.length) batch.a = a;
    if (x.length) batch.x = x;
    const reset = !!batch.r;
    // bg: Heltec 1 (firmware 2026-10-28b) lets the field talk first and never forces a batch into a busy channel
    this._bookItem = this.enqueue('book', { type: 'control', bg: true, data: batch }, 3, 'book', (ok) => {
      this._bookDoneAt = Date.now();
      if (!ok) { this._bookFails = Math.min(8, (this._bookFails || 0) + 1); log('info', 'account book: field node did not confirm a batch - trying again later'); return; }
      this._bookFails = 0;
      if (reset) { s.meta.book = {}; this._bookReset = false; }
      const cf = s.meta.book;
      for (const c of a) cf[c.i] = c.h;
      for (const id of x) delete cf[id];
      s.scheduleSave('meta');
      const st = this.bookStatus();
      if (st.onNode === st.accounts) log('info', 'account book: all ' + st.accounts + ' accounts are on the field node');
    });
  }
  onBookState(d) {
    const nodeN = Number(d.n) | 0, nodeH = parseInt(str(d.h), 16) >>> 0;
    this._bookNode = { n: nodeN, at: Date.now(), fw: str(d.fw) };
    if (!isObj(this.store.meta.bookNode) || this.store.meta.bookNode.fw !== this._bookNode.fw) { this.store.meta.bookNode = { fw: this._bookNode.fw, at: this._bookNode.at }; this.store.scheduleSave('meta'); }
    if (this._bookBusy() || Date.now() - (this._bookDoneAt || 0) < 30000) return;   // a batch is on its way: counts move
    const conf = this.store.meta.book;
    let n = 0, h = 0;
    for (const v of Object.values(conf)) { n++; h = (h + (parseInt(v, 16) >>> 0)) >>> 0; }
    if (n === nodeN && h === nodeH) return;
    log('info', 'account book: the field node has ' + nodeN + ' accounts, ' + n + ' were confirmed - sending the whole book again');
    this.store.meta.book = {}; this._bookReset = true; this._bookFails = 0;
    this.store.scheduleSave('meta');
  }

  onLoginQuery(o) {
    const s = this.store;
    this.lastLoraAt = Date.now(); this.stats.logins++; s.meta.counters.loraLogins++;
    const u = findLogin(s, o.identifier, o.pin);
    if (u) {
      if (!s.meta.fieldSeen.includes(u.id)) { s.meta.fieldSeen.push(u.id); s.scheduleSave('meta'); }
      log('info', 'LoRa login APPROVED: ' + str(u.loginUsername || u.username) + ' (' + str(u.role) + ')');
      this.enqueue('login', { type: 'login_result', qid: str(o.qid), status: 'APPROVED', user: accountToCompact(u) }, 0);
    } else {
      this.stats.loginDenied++;
      log('info', 'LoRa login DENIED for "' + ascii(o.identifier, 20) + '"');
      this.enqueue('login', { type: 'login_result', qid: str(o.qid), status: 'DENIED' }, 0);
    }
  }

  // ---- transport lifecycle ----
  start() {
    if (!this.cfg.SERIAL_ENABLED && !this.deps.transportFactory) { log('info', 'Heltec 1 serial link disabled'); return; }
    this.stopped = false;              // start again after a stop (the Pi's own restart path, and the tests)
    this._connectLoop();
    this._ping = setInterval(() => { if (this.connected && !this.inflight) { try { this.transport.write('{"type":"ping","t":' + Date.now() + '}\n'); } catch (e) { /* ignore */ } } if (this.connected && Date.now() - this.lastRxAt > 45000) { log('warn', 'Heltec 1 silent for 45s - reconnecting'); this._drop(); } }, 15000);
    this._ping.unref();
    this._posT = setInterval(() => this.pumpPositions(), this.cfg.POS_RADIO_MS || 20000);
    this._posT.unref();
    this._bookT = setInterval(() => this.bookTick(), 1000);
    this._bookT.unref();
  }
  stop() { this.stopped = true; clearInterval(this._ping); clearInterval(this._posT); clearInterval(this._bookT); clearTimeout(this._ackT); this._drop(); }

  _drop() {
    const t = this.transport; this.transport = null; this.connected = false; this.helloSeen = false; this.inflight = null; this.queue = [];
    if (t) { try { t.removeAllListeners('data'); t.removeAllListeners('close'); t.removeAllListeners('error'); t.close && t.close(); } catch (e) { /* ignore */ } }
  }

  async _connectLoop() {
    while (!this.stopped) {
      try {
        if (!this.transport) {
          const t = this.deps.transportFactory ? await this.deps.transportFactory() : await this._openReal();
          if (t) this._attach(t);
        }
      } catch (e) { log('debug', 'serial connect: ' + e.message); }
      await new Promise(r => setTimeout(r, this.transport ? 4000 : 5000));
      if (this.transport && !this.connected && Date.now() - (this._attachedAt || 0) > 15000) { log('warn', 'no answer from Heltec 1 on ' + this.portName + ' - retrying'); this._portFail[this.portName] = Date.now(); this._drop(); }
    }
  }

  _attach(t) {
    this.transport = t; this._attachedAt = Date.now(); this.rxBuf = ''; this.rxDec = new StringDecoder('utf8'); this.diag.openedAt = Date.now(); this.diag.openError = '';
    t.on('data', (d) => this.onData(d));
    t.on('close', () => { if (this.transport === t) { log('warn', 'Heltec 1 USB disconnected'); this._drop(); } });
    t.on('error', (e) => { log('warn', 'serial error: ' + e.message); });
    // poke it: fresh boot answers with hello by itself, an already-running board answers the ping
    setTimeout(() => { try { if (this.transport === t) t.write('{"type":"ping","t":' + Date.now() + '}\n'); } catch (e) { /* ignore */ } }, 1500);
    setTimeout(() => { try { if (this.transport === t && !this.helloSeen) t.write('{"type":"ping","t":' + Date.now() + '}\n'); } catch (e) { /* ignore */ } }, 4000);
  }

  async _openReal() {
    let SP;
    try { SP = require('serialport'); } catch (e) {
      if (!this._warnedNoSP) { this._warnedNoSP = true; log('warn', 'serialport module not installed - LoRa link off (run: npm install)'); }
      return null;
    }
    const { SerialPort } = SP;
    let candidates = [];
    if (this.cfg.SERIAL_PORT && this.cfg.SERIAL_PORT !== 'auto') candidates = [this.cfg.SERIAL_PORT];
    else {
      // SerialPort.list() reads udev; on some systems (e.g. Raspberry Pi OS trixie) it returns nothing even
      // though /dev/ttyACM0 exists - so also look in /dev directly
      let list = [];
      try { list = await SerialPort.list(); } catch (e) { log('debug', 'serial list: ' + e.message); }
      const vend = { '10c4': 0, '303a': 0, '1a86': 1, '0403': 1 };
      const vendorOf = {}; for (const p of list) vendorOf[p.path] = str(p.vendorId).toLowerCase();
      const found = new Set(list.map(p => p.path).filter(p => /ttyUSB|ttyACM|^COM\d+/i.test(p)));
      if (process.platform === 'linux') { try { for (const n of fs.readdirSync('/dev')) if (/^tty(ACM|USB)\d+$/.test(n)) found.add('/dev/' + n); } catch (e) { /* ignore */ } }
      candidates = [...found].sort((a, b) => ((vend[vendorOf[a]] ?? (/ACM/.test(a) ? 2 : 5)) - (vend[vendorOf[b]] ?? (/ACM/.test(b) ? 2 : 5))) || a.localeCompare(b));
    }
    this.diag.portsSeen = candidates.slice(); this.diag.scanAt = Date.now();
    this._portFail = this._portFail || {};
    candidates.sort((a, b) => (this._portFail[a] || 0) - (this._portFail[b] || 0));
    if (!candidates.length) { if (!this._warnedNoPort) { this._warnedNoPort = true; log('warn', 'no USB serial device found - plug Heltec 1 into the Pi'); } return null; }
    this._warnedNoPort = false;
    for (const p of candidates) {
      const t = await new Promise((resolve) => {
        const port = new SerialPort({ path: p, baudRate: this.cfg.SERIAL_BAUD, autoOpen: false });
        port.open((err) => {
          if (err) {
            const k = p + '|' + err.message;   // say it once a minute, not every 5 s
            this.diag.openError = p + ': ' + err.message;
            if (!this._openErr || this._openErr.k !== k || Date.now() - this._openErr.t > 60000) { this._openErr = { k, t: Date.now() }; log('warn', 'Heltec 1 port ' + p + ' cannot be opened: ' + err.message + (/permission/i.test(err.message) ? ' (run install.sh again - it installs the port permission rule)' : '')); }
            return resolve(null);
          }
          resolve(port);
        });
      });
      if (!t) continue;
      this.portName = p;
      return t;
    }
    return null;
  }

  status() {
    // fieldHeardAt: when Heltec 1 last heard ANY field node (null = it never has, undefined = older firmware that does not say)
    let fieldHeardAt;
    if (typeof this.fieldAgeS === 'number' && this.fieldAgeAt && Date.now() - this.fieldAgeAt < 120000) fieldHeardAt = this.fieldAgeS < 0 ? null : this.fieldAgeAt - this.fieldAgeS * 1000;
    return { connected: this.connected, port: this.portName, firmwareVersion: this.fwVer | 0, firmwareBuild: this.fwBuild || "", firmwareAck: this.fwAck, queue: this.queue.length, lastLoraAt: this.lastLoraAt, fieldHeardAt, signal: this.signal || null, book: this.bookStatus(), heldAtBridge: this.heldAtBridge || 0, stats: this.stats, diag: this.diag };
  }
}

// =====================================================================================
// HTTP SERVER
// =====================================================================================
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const FIREBASE_SDK_RE = /https:\/\/www\.gstatic\.com\/firebasejs\/9\.23\.0\/([a-z0-9-]+\.js)/g;
const OLLAMA_RE = /http:\/\/127\.0\.0\.1:11434\/api\/generate/g;

function createApp(cfgOverrides, deps) {
  const cfg = loadConfig(cfgOverrides);
  deps = deps || {};
  LOG_MIN = LEVELS[cfg.LOG_LEVEL] !== undefined ? LEVELS[cfg.LOG_LEVEL] : 1;
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });

  const store = new Store(cfg.DATA_DIR, cfg);
  const engine = new Engine(store, cfg);
  const fb = new Firebase(store, cfg);
  const positions = new Positions(store);
  // ---- instant updates: /api/wait?v=N answers the moment anything the app shows changes (a new SOS, chat, dispatch,
  // account ...), so phones on the Pi's WiFi do not wait for their next 2-second sync. A waiting request costs nothing.
  let dataVer = 1; const waiters = new Set();
  const wakeAll = () => { dataVer++; for (const w of [...waiters]) w(true); waiters.clear(); };
  let wakeT = null;
  store.on('changed', () => { if (!wakeT) wakeT = setTimeout(() => { wakeT = null; wakeAll(); }, 15); });   // several changes at once: one wake-up
  const bridge = new Bridge(store, engine, cfg, Object.assign({}, deps, { positions }));
  const startedAt = Date.now();
  const loginResults = new Map();   // client key -> {t, body}
  const htmlCache = { mtime: 0, raw: null, gz: null };
  const mapSvc = new MapService(cfg.MAP_DIR);
  mapSvc.load();
  const parseLL = (s) => { const m = String(s || '').split(','); const a = parseFloat(m[0]), b = parseFloat(m[1]); return (Number.isFinite(a) && Number.isFinite(b)) ? [a, b] : null; };

  // ---------------- the app page (with offline asset rewriting) ----------------
  function appHtml() {
    const file = path.join(cfg.APP_DIR, 'index.html');
    let st;
    try { st = fs.statSync(file); } catch (e) { return null; }
    if (htmlCache.raw && htmlCache.mtime === st.mtimeMs) return htmlCache;
    let html = fs.readFileSync(file, 'utf8');
    const vendor = path.join(cfg.APP_DIR, 'vendor');
    html = html.replace(FIREBASE_SDK_RE, (m, f) => fs.existsSync(path.join(vendor, 'firebase', f)) ? '/vendor/firebase/' + f : m);
    html = html.replace(/https:\/\/tech2forms\.com\/wp-content\/uploads\/2026\/08\/([A-Za-z0-9_.-]+\.png)/g, (m, f) => fs.existsSync(path.join(vendor, 'img', f)) ? '/vendor/img/' + f : m);
    html = html.replace(OLLAMA_RE, '/api/generate');
    const amp = { requireGps: !!cfg.REQUIRE_GPS, https: !!tlsServer, httpsPort: cfg.HTTPS_PORT || 443, insecureSkip: !tlsServer, exemptLocal: cfg.GPS_EXEMPT_LOCAL !== false, piCloud: !cfg.APP_FIREBASE_DIRECT };
    html = html.replace(/<head>/i, () => '<head><script>window.AMP_CFG=' + JSON.stringify(amp) + ';</script>');
    htmlCache.mtime = st.mtimeMs; htmlCache.raw = Buffer.from(html); htmlCache.gz = zlib.gzipSync(htmlCache.raw, { level: 6 });
    return htmlCache;
  }

  // ---------------- response helpers ----------------
  function send(req, res, status, body, headers, gz) {
    const h = Object.assign({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, headers || {});
    let out = body;
    if (!Buffer.isBuffer(out)) out = Buffer.from(out === undefined ? '' : out);
    if (gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { out = gz; h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
    h['Content-Length'] = out.length;
    res.writeHead(status, h);
    res.end(req.method === 'HEAD' ? undefined : out);
  }
  const sendJson = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
  const sendView = (req, res, name) => { const v = store.view(name); send(req, res, 200, v.raw, { 'Content-Type': 'application/json; charset=utf-8' }, v.gz); };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function clientKey(req) { return (req.socket.remoteAddress || '') ; }

  function ownHost(hostHeader) {
    const h = str(hostHeader).split(':')[0].toLowerCase();
    if (!h) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h === 'amping' || h === 'command-center' || h === os.hostname().toLowerCase()) return true;
    return false;
  }

  function serveFile(req, res, file, cacheSeconds) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { return send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
      const ext = path.extname(file).toLowerCase();
      const etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Cache-Control': cacheSeconds ? 'public, max-age=' + cacheSeconds : 'no-cache', 'Access-Control-Allow-Origin': '*' };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  function inside(base, target) { const rel = path.relative(base, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

  // ---------------- request router ----------------
  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }

    // Hijacked domains (captive-portal probes, or gstatic.com when DNS is redirected to the Pi)
    if (!ownHost(req.headers.host)) {
      if (p.startsWith('/firebasejs/')) {
        const f = path.join(cfg.APP_DIR, 'vendor', 'firebase', path.basename(p));
        if (fs.existsSync(f)) return serveFile(req, res, f, 86400);
      }
      res.writeHead(302, { Location: 'http://' + cfg.AP_IP + '/', 'Cache-Control': 'no-store', 'Content-Length': 0 });
      return res.end();
    }
    // Android/Windows/Apple probe paths on our own IP
    if (/^\/(generate_204|gen_204|hotspot-detect\.html|library\/test\/success\.html|connecttest\.txt|ncsi\.txt|redirect|canonical\.html|success\.txt)$/.test(p)) {
      res.writeHead(302, { Location: 'http://' + (req.headers.host || cfg.AP_IP) + '/', 'Cache-Control': 'no-store', 'Content-Length': 0 });
      return res.end();
    }

    // ---- API ----
    if (p.startsWith('/api/')) return api(req, res, p, url, method);

    // ---- JSON fallbacks the app also tries ----
    const alias = { '/accounts.json': 'accounts', '/messages.json': 'messages', '/settings.json': 'settings', '/emergencies.json': 'emergencies' }[p];
    if (alias) return sendView(req, res, alias);

    // ---- offline map ----
    if (p === '/map/meta.json') {
      if (!mapSvc.ok) return sendJson(req, res, 404, { ok: false, error: 'offline map not installed' });
      return send(req, res, 200, JSON.stringify(Object.assign({}, mapSvc.meta, { routing: mapSvc.hasGraph() })), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    }
    if (p.startsWith('/map/t/')) {
      const m = p.match(/^\/map\/t\/([bd])\/(\d+)\/(\d+)\/(\d+)$/);
      if (!m || !mapSvc.ok) { res.writeHead(m ? 404 : 400, { 'Content-Length': 0 }); return res.end(); }
      const blob = mapSvc.tile(m[1], +m[2], +m[3], +m[4]);
      const h = { 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' };
      if (!blob) { res.writeHead(204, h); return res.end(); }
      Object.assign(h, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': blob.length, ETag: '"' + mapSvc.meta.built + '"' });
      if (req.headers['if-none-match'] === h.ETag) { res.writeHead(304, h); return res.end(); }
      res.writeHead(200, h); return res.end(req.method === 'HEAD' ? undefined : blob);
    }

    if (p === '/status' || p === '/status/') return statusPage(req, res);
    if (p === '/healthz') return sendJson(req, res, 200, { ok: true });

    // ---- app ----
    if (p === '/' || p === '/index.html') {
      const h = appHtml();
      if (!h) return send(req, res, 500, 'app/index.html is missing. Copy "raspberrypi-index final.html" to ' + path.join(cfg.APP_DIR, 'index.html'), { 'Content-Type': 'text/plain' });
      return send(req, res, 200, h.raw, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, h.gz);
    }

    // ---- static ----
    let rel;
    try { rel = decodeURIComponent(p); } catch (e) { return send(req, res, 400, 'bad path'); }
    if (rel === '/leaflet.js' && !fs.existsSync(path.join(cfg.APP_DIR, 'leaflet.js'))) rel = '/vendor/leaflet.js';   // your own leaflet.js in app/ wins
    const file = path.join(cfg.APP_DIR, rel);
    if (!inside(cfg.APP_DIR, file)) return send(req, res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
    return serveFile(req, res, file, rel.startsWith('/vendor/') ? 86400 : 0);
  }

  async function api(req, res, p, url, method) {
    const endpoint = p.slice(5).replace(/\/$/, '');

    // ---------- reads ----------
    if (method === 'GET' || method === 'HEAD') {
      switch (endpoint) {
        case 'accounts': return sendView(req, res, 'accounts');
        case 'messages': return sendView(req, res, 'messages');
        case 'emergencies': return sendView(req, res, 'emergencies');
        case 'settings': return sendView(req, res, 'settings');
        case 'infra': return sendView(req, res, 'infra');
        case 'route': {
          const a = parseLL(url.searchParams.get('from')), b = parseLL(url.searchParams.get('to'));
          if (!a || !b) return sendJson(req, res, 400, { ok: false, error: 'need from=lat,lng&to=lat,lng' });
          const t0 = Date.now();
          const r = mapSvc.route(a[0], a[1], b[0], b[1], url.searchParams.get('mode') || 'car', store.infra, { noAvoid: url.searchParams.get('avoid') === '0' });
          r.ms = Date.now() - t0;
          return sendJson(req, res, r.ok ? 200 : 404, r);
        }
        case 'nearest': {
          const a = parseLL(url.searchParams.get('at'));
          if (!a) return sendJson(req, res, 400, { ok: false, error: 'need at=lat,lng&type=hospital|police|fire|evac|pharmacy|school' });
          return sendJson(req, res, 200, mapSvc.nearest(url.searchParams.get('type') || 'hospital', a[0], a[1], url.searchParams.get('mode') || 'car', store.infra, 3));
        }
        case 'geocode': {
          const a = parseLL(url.searchParams.get('at'));
          return sendJson(req, res, 200, { ok: true, results: mapSvc.geocode(url.searchParams.get('q') || '', a ? a[0] : undefined, a ? a[1] : undefined, 12) });
        }
        case 'status': return sendJson(req, res, 200, statusObj());
        case 'ping': return sendJson(req, res, 200, { ok: true, t: Date.now() });
        case 'wait': {
          const v = Number(url.searchParams.get('v')) || 0;
          if (v !== dataVer) return sendJson(req, res, 200, { v: dataVer, changed: true });
          let done = false;
          const answer = (changed) => { if (done) return; done = true; clearTimeout(t); waiters.delete(answer); try { sendJson(req, res, 200, { v: dataVer, changed }); } catch (e) { /* phone gone */ } };
          const t = setTimeout(() => answer(false), 25000);
          waiters.add(answer); req.on('close', () => { if (!done) { done = true; clearTimeout(t); waiters.delete(answer); } });
          return;
        }
        case 'positions': return sendJson(req, res, 200, positions.view(url.searchParams.get('r') || 'user'));
        case 'lora_result': {
          const r = loginResults.get(clientKey(req));
          if (r && Date.now() - r.t < 60000) return send(req, res, 200, r.body, { 'Content-Type': 'application/json; charset=utf-8' });
          return send(req, res, 200, '[]', { 'Content-Type': 'application/json; charset=utf-8' });
        }
        case 'account_photo': {
          const id = url.searchParams.get('id') || '';
          const photo = store.getPhoto(id);
          if (!photo) return sendJson(req, res, 404, { ok: false });
          return send(req, res, 200, JSON.stringify({ ok: true, id, idPhoto: photo }), { 'Content-Type': 'application/json; charset=utf-8' });
        }
        default: return sendJson(req, res, 404, { ok: false, error: 'unknown endpoint' });
      }
    }

    if (method !== 'POST') return sendJson(req, res, 405, { ok: false });

    // ---------- writes ----------
    let body;
    try { body = await readBody(req, 40 * 1024 * 1024); } catch (e) { return sendJson(req, res, 413, { ok: false, error: e.message }); }

    switch (endpoint) {
      case 'send_msg': engine.ingestBody('msg', 'msg', body, 'app'); return sendJson(req, res, 200, { ok: true });
      case 'send_sos': engine.ingestBody('sos', 'sos', body, 'app'); return sendJson(req, res, 200, { ok: true });
      case 'update_sos': engine.ingestBody('upd', 'update', body, 'app'); return sendJson(req, res, 200, { ok: true });
      case 'req_dir': return sendJson(req, res, 200, { ok: true, note: 'Directory is served from /api/accounts on the Pi.' });
      case 'pos': {
        let o; try { o = JSON.parse(body); } catch (e) { return sendJson(req, res, 400, { ok: false, error: 'bad json' }); }
        const r = positions.fromApp(o);
        return sendJson(req, res, r.ok ? 200 : 403, r);
      }

      case 'sync_accounts': {
        let arr;
        try { const j = JSON.parse(body); arr = Array.isArray(j) ? j : (isObj(j) ? (Array.isArray(j.accounts) ? j.accounts : Object.values(j)) : []); }
        catch (e) { return sendJson(req, res, 400, { ok: false, error: 'bad json' }); }
        let n = 0, ch = 0;
        for (const a of arr) {
          if (!isObj(a)) continue;
          const r = store.upsertAccount(a, { dirty: true });
          n++; if (r !== 'same') ch++;
        }
        // "dirty" only matters for records that really changed - upsert returned 'same' otherwise and nothing was marked
        return sendJson(req, res, 200, { ok: true, received: n, changed: ch });
      }

      case 'sync_settings': {
        let o; try { o = JSON.parse(body); } catch (e) { return sendJson(req, res, 400, { ok: false }); }
        const changed = store.mergeSettings(o, { dirty: true });
        return sendJson(req, res, 200, { ok: true, changed });
      }

      case 'infra': {
        let o; try { o = JSON.parse(body); } catch (e) { return sendJson(req, res, 400, { ok: false }); }
        const changed = store.setInfra(o, { dirty: true });
        return sendJson(req, res, 200, { ok: true, changed });
      }

      case 'login': {
        let o = {}; try { o = JSON.parse(body); } catch (e) { const l = extractJSONObjects(body); o = l[0] || {}; }
        const u = findLogin(store, o.identifier, o.pin);
        if (!u) return sendJson(req, res, 401, { ok: false, error: 'DENIED' });
        return send(req, res, 200, JSON.stringify({ ok: true, user: store.publicAccount(u) }), { 'Content-Type': 'application/json; charset=utf-8' });
      }

      case 'lora_login': {
        // The Pi already holds every account, so it answers instantly instead of waiting on radio.
        let o = {}; try { o = JSON.parse(body); } catch (e) { const l = extractJSONObjects(body); o = l[0] || {}; }
        const u = findLogin(store, o.identifier, o.pin);
        const result = u ? [{ status: 'APPROVED', user: store.publicAccount(u) }] : [{ status: 'DENIED' }];
        loginResults.set(clientKey(req), { t: Date.now(), body: JSON.stringify(result) });
        for (const [k, v] of loginResults) if (Date.now() - v.t > 120000) loginResults.delete(k);
        return sendJson(req, res, 200, { ok: true });
      }

      case 'generate': {
        // optional offline AI (Ollama) so phones can use the AI Guide too
        return proxyOllama(req, res, body);
      }

      default: return sendJson(req, res, 404, { ok: false, error: 'unknown endpoint' });
    }
  }

  function proxyOllama(req, res, body) {
    let u; try { u = new URL(cfg.OLLAMA_URL.replace(/\/$/, '') + '/api/generate'); } catch (e) { return sendJson(req, res, 503, { ok: false }); }
    const preq = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (pres) => {
      const chunks = []; pres.on('data', c => chunks.push(c));
      pres.on('end', () => send(req, res, pres.statusCode, Buffer.concat(chunks), { 'Content-Type': 'application/json; charset=utf-8' }));
    });
    preq.setTimeout(120000, () => preq.destroy(new Error('timeout')));
    preq.on('error', () => sendJson(req, res, 503, { ok: false, error: 'AI engine not running' }));
    preq.end(body);
  }

  // ---------------- status ----------------
  function statusObj() {
    const ifs = os.networkInterfaces(); const addrs = [];
    for (const [n, list] of Object.entries(ifs)) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(n + ' ' + a.address);
    const d = store.meta.dirty;
    return {
      build: BUILD, uptimeSec: Math.round((Date.now() - startedAt) / 1000), addresses: addrs,
      // written every 2 minutes by amping-netcheck (root): why there is / is no internet on the LAN cable, and what it fixed
      network: (() => { try { const n = JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, 'net-status.json'), 'utf8')); n.ageS = Math.round((Date.now() - n.at) / 1000); return n; } catch (e) { return null; } })(),
      counts: { accounts: store.accounts.size, emergencies: store.emergencies.size, messages: store.messages.size, idPhotos: (() => { try { return fs.readdirSync(path.join(cfg.DATA_DIR, 'photos')).length; } catch (e) { return 0; } })() },
      firebase: { enabled: cfg.FIREBASE_SYNC, online: fb.isOnline(), nodes: fb.connected, database: fb.base, oldAccountsDatabase: fb.oldBase || null, piUid: fb.auth.uid || null, signInError: fb.auth.lastError || null, pendingPush: { accounts: d.accounts.length, emergencies: d.emergencies.length, messages: d.messages.length, settings: d.settings, infra: d.infra }, pushErrors: fb.pushErrors },
      radio: bridge.status(),
      map: { installed: mapSvc.ok, routing: mapSvc.hasGraph(), built: mapSvc.meta && mapSvc.meta.built, counts: mapSvc.meta && mapSvc.meta.counts, area: (mapSvc.meta && mapSvc.meta.area && mapSvc.meta.area.name) || 'Butuan City', memMB: Math.round(process.memoryUsage().rss / 1048576) },
      loraCounters: store.meta.counters,
      livePositions: (() => { positions.prune(); let u = 0, q = 0; for (const e of positions.map.values()) (e.kind === 'unit' ? u++ : q++); return { units: u, requesters: q }; })(),
      pendingEmergencies: [...store.emergencies.values()].filter(e => rankOf(e.status) === 1).length
    };
  }

  function statusPage(req, res) {
    const s = statusObj();
    const esc = (t) => str(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const dot = (ok) => '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + (ok ? '#16a34a' : '#dc2626') + ';margin-right:8px"></span>';
    const html = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta http-equiv=refresh content=5><title>AMPING Command Center</title>' +
      '<style>body{font:15px system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:20px}.c{background:#1e293b;border-radius:12px;padding:14px 16px;margin:12px 0}.k{color:#94a3b8}pre{white-space:pre-wrap;font-size:12px;color:#94a3b8;margin:0}a{color:#38bdf8}</style><main>' +
      '<h1>AMPING Command Center - status</h1>' +
      '<div class=c>' + dot(true) + 'Web app &amp; API running &middot; up ' + s.uptimeSec + 's &middot; <a href="/">Open the app</a><div class=k>' + esc(s.addresses.join(' | ')) + '</div></div>' +
      '<div class=c>' + dot(s.firebase.online) + 'Firebase: ' + (s.firebase.online ? 'ONLINE (live mirror)' : 'offline (running from saved Pi data)') + '<div class=k>Not yet uploaded: ' + esc(JSON.stringify(s.firebase.pendingPush)) + '</div>' +
        (s.network ? '<div class=k>Internet (LAN ' + esc(s.network.iface) + ' ' + esc(s.network.ip || 'no address') + '): <b>' + esc(s.network.verdict) + '</b> - ' + esc(s.network.why) + (s.network.fixes && s.network.fixes.length ? '<br>Fixed: ' + esc(s.network.fixes.join('; ')) : '') + '</div>' : '') + '</div>' +
      '<div class=c>' + dot(s.radio.connected) + 'Heltec 1 (LoRa): ' + (s.radio.connected ? 'CONNECTED on ' + esc(s.radio.port) : 'not connected') + '<div class=k>from field - chat: ' + s.radio.stats.rxMsg + ', SOS: ' + s.radio.stats.rxSos + ', logins answered: ' + s.radio.stats.logins + ' (denied ' + s.radio.stats.loginDenied + ') &middot; last field contact: ' + (s.radio.lastLoraAt ? Math.round((Date.now() - s.radio.lastLoraAt) / 1000) + 's ago' : 'never') +
      (s.radio.signal ? '<br>signal from the field: <b>' + esc(s.radio.signal.q.toUpperCase()) + '</b> (RSSI ' + s.radio.signal.rssi + ' dBm, SNR ' + s.radio.signal.snrAvg + ' dB; lost pieces ' + s.radio.signal.lost + ')' : '') +
        (s.radio.heldAtBridge ? '<br><b>' + s.radio.heldAtBridge + ' request(s)/message(s) waiting in Heltec 1</b> (they arrived while this command center was not listening - being handed over now)' : '') +
        (s.radio.book ? '<br>accounts on the field node (for logins without the radio): <b>' + s.radio.book.onNode + ' of ' + s.radio.book.accounts + '</b>' + (s.radio.book.sending ? ' - sending' : '') + (s.radio.book.nodeReported && s.radio.book.nodeReported.n !== undefined ? ' (node says ' + s.radio.book.nodeReported.n + ')' : '') + (s.radio.book.blocked ? ' - waiting: ' + esc(s.radio.book.blocked) : '') : '') + '</div></div>' +
      '<div class=c>Saved on this Pi: <b>' + s.counts.accounts + '</b> accounts (' + s.counts.idPhotos + ' ID photos), <b>' + s.counts.emergencies + '</b> emergencies (' + s.pendingEmergencies + ' pending), <b>' + s.counts.messages + '</b> messages</div>' +
      '<div class=c><pre>' + esc(LOG_RING.slice(-25).join('\n')) + '</pre></div></main>';
    send(req, res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // ---------------- lifecycle ----------------
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      log('error', 'request ' + req.method + ' ' + req.url + ': ' + (e.stack || e.message));
      try { if (!res.headersSent) sendJson(req, res, 500, { ok: false, error: 'server error' }); else res.end(); } catch (e2) { /* ignore */ }
    });
  });
  const tune = (srv) => {
    srv.keepAliveTimeout = 65000; srv.headersTimeout = 70000; srv.requestTimeout = 0;
    srv.on('clientError', (err, sock) => { try { sock.destroy(); } catch (e) { /* ignore */ } });
  };
  tune(server);

  // optional HTTPS (self-signed certificate) - browsers only allow GPS on https:// or localhost
  let tlsServer = null;
  if (cfg.HTTPS_PORT) {
    const dir = cfg.TLS_DIR || path.join(cfg.DATA_DIR, 'tls');
    try {
      const opts = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
      tlsServer = https.createServer(opts, (req, res) => {
        route(req, res).catch((e) => {
          log('error', 'https request ' + req.method + ' ' + req.url + ': ' + (e.stack || e.message));
          try { if (!res.headersSent) sendJson(req, res, 500, { ok: false }); else res.end(); } catch (e2) { /* ignore */ }
        });
      });
      tune(tlsServer);
      tlsServer.on('tlsClientError', () => { /* browsers that refuse the self-signed cert just hang up - not an error */ });
    } catch (e) { log('warn', 'HTTPS disabled - no certificate in ' + dir + ' (' + e.code + ')'); }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.PORT, cfg.HOST, () => {
        const addr = server.address();
        if (tlsServer) tlsServer.listen(cfg.HTTPS_PORT, cfg.HOST, () => log('info', 'HTTPS also on port ' + tlsServer.address().port + ' (self-signed - GPS works on this address)'));
        if (tlsServer) tlsServer.on('error', (e) => log('warn', 'HTTPS server error: ' + e.message));
        log('info', 'AMPING Command Center (build ' + BUILD + ') listening on http://' + (cfg.HOST === '0.0.0.0' ? '<pi-ip>' : cfg.HOST) + ':' + addr.port + '  (data: ' + cfg.DATA_DIR + ')');
        log('info', 'loaded ' + store.accounts.size + ' accounts, ' + store.emergencies.size + ' emergencies, ' + store.messages.size + ' messages from disk');
        fb.start();
        bridge.start();
        log('info', mapSvc.ok ? 'offline map ready: ' + mapSvc.meta.counts.tiles + ' tiles' + (mapSvc.hasGraph() ? ', routing over ' + mapSvc.meta.counts.graphNodes + ' road nodes' : ' (no routing data)') : 'offline map NOT installed (run tools/fetch-osm.js + tools/build-offline-map.js)');
        resolve(addr.port);
      });
    });
  }
  function stop() {
    return new Promise((resolve) => {
      fb.stop(); bridge.stop(); mapSvc.close(); store.flushAll();
      server.close(() => resolve());
      if (tlsServer) { try { tlsServer.close(); if (tlsServer.closeAllConnections) tlsServer.closeAllConnections(); } catch (e) { /* ignore */ } }
      setTimeout(resolve, 500).unref();
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { cfg, store, engine, fb, bridge, positions, server, get tlsServer() { return tlsServer; }, start, stop, statusObj };
}

module.exports = { hashId, Positions, messageToVerbose, createApp, loadConfig, findLogin, accountToCompact, emergencyFromAny, emergencyToCompact, messageToCompact, radioPack, radioUnpack, rfClock, rfDateClock, extractJSONObjects, Store, Engine, Bridge, Firebase, FirebaseAuth };

if (require.main === module) {
  const app = createApp();
  app.start().catch((e) => {
    log('error', 'cannot start: ' + e.message + (e.code === 'EACCES' ? ' (port ' + app.cfg.PORT + ' needs root, or use the systemd service which grants it)' : e.code === 'EADDRINUSE' ? ' (another web server is using port ' + app.cfg.PORT + ')' : ''));
    process.exit(1);
  });
  const bye = () => { log('info', 'shutting down, saving data...'); app.stop().then(() => process.exit(0)); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  process.on('uncaughtException', (e) => { log('error', 'uncaught: ' + (e.stack || e.message)); });
  process.on('unhandledRejection', (e) => { log('error', 'unhandled rejection: ' + (e && e.stack || e)); });
}