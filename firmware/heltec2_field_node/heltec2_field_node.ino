/*
  AMPING Mesh - Heltec 2: Standalone Field Node (WiFi AP + secure web app + offline map)
  ======================================================================================
  This board carries no wired connection to anything. It creates its own WiFi hotspot,
  serves the AMPING field app to anyone who connects, and relays that app's chat / SOS /
  login / live-position traffic over LoRa to Heltec 1, which is plugged into the Raspberry Pi.

  NEW in 2026-11-03a - AS MANY PHONES AS THE BOARD CAN TAKE (only 2 phones got in with the AMPING Mesh app)
    Three limits, each smaller than the hotspot:
    * the app opened https://192.168.4.1, and secure connections need ~36 KB of RAM each: only 3 fit. The app
      (AMPING Mesh 1.5) now opens http://192.168.4.1 - plain connections cost a few hundred bytes, the plain server
      keeps 8 (the board's 16 sockets are the limit there, not memory). Browsers still get https (3 connections).
    * the core's DHCP server keeps only 8 phones and then forgets the oldest one while it is still connected, so two
      phones could end up with the same address. The node now runs its own (64 phones, see DHCP).
    * the hotspot takes 10 phones - the WiFi driver's own limit on this chip (read back from the driver at start and
      shown in /admin/status as maxPhones). Phones behind a WiFi repeater do not count against it: the repeater is
      one station, and they get addresses from the node's own DHCP server.
    /admin/status shows maxPhones, sockets and dhcp {own, bound, offers, acks, naks, ...}.

  2026-10-31a - SEVERAL PHONES AT ONCE (the one thing that kept failing in the student tests)
    The board has no PSRAM, so each secure connection holds ~36 KB of TLS buffers and only THREE fit; a fourth
    closes the least recently used one. Two things made one phone want all three, and the next phone's app page
    was then cut off halfway ("opening the node", then back to the start page):
    * the answers are now streamed out in 4 KB pieces (JsonOut). /api/bundle with a classroom's accounts is about
      40 KB and used to be built as one String first - that block is exactly what a new phone's connection needs
      for its own buffers, and without it the second person to log in could not get in at all.
    * a missing file is answered with a few bytes instead of a redirect to the app page (/favicon.ico used to make
      every phone download the whole 290 KB app a second time), and the app page carries an ETag, so opening the
      app again costs 150 bytes instead of 290 KB.
    * the page goes out in 8 KB pieces and a piece may take 25 s (a far phone behind a WiFi repeater shares the
      air with everybody), instead of one blocking send that was dropped after 10 s.
    * the plain http server may keep 5 connections: it carries every phone's "Sign in to network" check.
    The app page itself was changed to match (see tools/build-firmware.js and tools/client/node-one-connection.js):
    one request per phone, logos inside the page, and nothing starts until the page has arrived.

  Earlier
    * HTTPS (https://192.168.4.1, self-signed certificate in node_cert.h). Phones only share
      GPS with secure pages, so the app now gets an exact position. Plain http://192.168.4.1
      still answers (captive portal) and the app sends people to the secure address.
    * Offline map: the phone downloads the node's map file once (kept in the phone), then
      draws the map, finds routes and gives turn-by-turn directions with no internet.
      Upload the map file once at  https://192.168.4.1/admin  (file: node-map.amp).
    * Live positions: responders' units are shown to everybody, and responders see the live
      position of the person who asked for help (LoRa packet 'P', see mesh_protocol.h).
    * Requests list: active requests from the whole network are kept here so responders
      connected to this node can see and navigate to them.
    * Up to AP_MAX_CLIENTS phones at once (the ESP32 default was 4).

  Uses the SAME radio settings you range-tested with "heltec v4.c" - shared with Heltec 1
  via mesh_protocol.h. Do not change one board without the other.

  ----------------------------------------------------------------------------
  WHAT THIS BOARD SERVES (same handlers on http :80 and https :443)
    GET  /                    the app (LittleFS /index.html if uploaded, else built in)
    GET  /leaflet.js /leaflet.css /amp-map.js      map engine (built in, gzip)
    GET  /map/meta.json       map file description (404 until a map is uploaded)
    GET  /map/part?i=N        piece N of the map (gzip)
    GET  /api/state?r=role    everything the app polls, in one reply
    GET  /api/accounts /api/messages /api/emergencies /api/positions /api/settings
    POST /api/login /api/lora_login, GET /api/lora_result
    POST /api/send_msg /api/send_sos   (browser already splits into <=90-byte pieces)
    POST /api/pos             my live position (responders, people with an open request)
    GET  /admin               upload the map / a replacement page (password ADMIN_PASSWORD)
    GET  /favicon.ico         204 No Content (never the app page)
    captive-portal probes and typed addresses -> 302 to http://192.168.4.1/
    any other missing FILE (.png .js .css ... , /api/, /map/) -> empty 404, a few bytes
  ----------------------------------------------------------------------------

  Libraries (Arduino IDE > Library Manager):
     RadioLib          by Jan Gromes
     Adafruit SSD1306  by Adafruit (also installs Adafruit GFX)
     ArduinoJson       by Benoit Blanchon  (version 7.x)
     (DNSServer, WiFi, LittleFS, esp_http_server / esp_https_server ship with the ESP32 core)

  Board: "Heltec WiFi LoRa 32(V3)" (or ESP32S3 Dev Module, Flash Size 8MB or 16MB).
  partitions.csv in this sketch folder is picked up automatically: 3.2 MB app + 4.6 MB storage.

  !! Always screw on the LoRa antenna BEFORE powering the board. !!
*/

#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <WiFi.h>
#include <DNSServer.h>
#include <LittleFS.h>
#include <RadioLib.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <esp_http_server.h>
#include <esp_https_server.h>
#include <esp_idf_version.h>
#include <esp_heap_caps.h>
#include <esp32-hal-psram.h>
#include <mbedtls/platform.h>
#include <Preferences.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <esp_wifi.h>      // the hotspot's station list (own DHCP server, see DHCP below)
#include <esp_netif.h>
#include <lwip/udp.h>
#include <lwip/ip.h>
#include <lwip/tcpip.h>

#include "mesh_protocol.h"
#include "node_assets.h"   // NODE_PAGE_GZ, LEAFLET_JS_GZ, LEAFLET_CSS_GZ, AMP_MAP_JS_GZ (generated by tools/build-heltec-html.js)
#include "node_cert.h"     // NODE_CERT_PEM, NODE_KEY_PEM (self-signed, for https://192.168.4.1)

// ============================ TYPES ============================
// All structs used in function signatures live up here, above the first function: the Arduino
// IDE puts its automatic function declarations there.
struct Frame {
  bool valid = false;
  char type = 0;
  String id;
  uint8_t idx = 0;
  uint8_t tot = 0;
  String dat;
  bool raw = false;       // a fast piece / fast ACK (mesh_protocol.h)
  uint32_t mask = 0;      // fast ACK: the pieces the other side has
  char flag = 0;          // fast ACK: 'P' the command center has it, '-' only Heltec 1 has it (2026-10-29a)
};

struct PosRec {
  bool used = false;
  char h[10] = {0};       // short account id (FNV-1a base36)
  int32_t la5 = 0, lo5 = 0;
  uint16_t acc = 0;
  char rc = 'u';          // role code (mesh_protocol.h)
  char name[16] = {0};
  uint32_t seenAt = 0;    // millis() of the fix
  bool local = false;     // came from a phone on THIS node's WiFi (relayed to the Pi)
  int32_t sentLa5 = 0, sentLo5 = 0; uint32_t sentAt = 0;  // last version sent over LoRa
  uint8_t sends = 0;      // times this version went out: a new / moved position goes out twice (a 'P' packet has no ACK)
};

// ============================ CONFIG ============================
#define AP_SSID         "AMPING-MESH-NODE-2"
// #define AP_PASSWORD "YOUR_WIFI_PASSWORD"   // uncomment (8-63 chars) to require a password to join
// The hotspot takes at most 10 phones. esp_wifi_types.h of core 2.0.17 says 15 for the ESP32-S3, but its WiFi driver
// holds the hotspot at 10: measured on this board 2026-11-03 - asked for 15, accepted without error, read back 10.
// startHotspot() asks for AP_MAX_CLIENTS, steps down if the driver refuses, and logs what it really runs with.
#define AP_MAX_CLIENTS  10
#define HTTP_SOCKETS    8                // plain http connections (the AMPING Mesh app) - see startWebServers()
#define HTTPS_SOCKETS   3                // secure connections (phones using a browser) - ~36 KB of RAM each
int apMaxReal = 0;                       // phones the WiFi driver really accepts (read back in setup)
int httpSockets = 0, httpsSockets = 0;   // as started
#define ADMIN_PASSWORD  "CHANGE_ME"   // set a real password before flashing

// ============================ HARDWARE ============================
SX1262 radio = new Module(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY, SPI);
Adafruit_SSD1306 display(128, 64, &Wire, PIN_OLED_RST);
bool femIsKCT = false;
bool loraOk = false;                     // false = the radio did not start: WiFi + the app still work, retried every 30 s
int lastLoraErr = 0;
uint32_t lastLoraRetryAt = 0;

// ============================ HEALTH ============================
// Why did this node start (crash / power dip / our own restart)? Free memory now and the lowest so far.
// Shown on the screen and at /admin, so a problem in the field can be told apart from a WiFi problem.
Preferences prefs;
uint32_t bootNo = 0, unexpectedRestarts = 0;
char lastStartWhy[28] = "power on";
uint32_t lowMemSince = 0, lastHealthAt = 0, lastApCheckAt = 0, lastHealthLogAt = 0;
size_t memFree = 0, memBig = 0;

volatile bool rxFlag = false;
void IRAM_ATTR onRadioIrq() { rxFlag = true; }

void femTx() { digitalWrite(femIsKCT ? PIN_KCT_CTX : PIN_GC1109_CPS, HIGH); }
void femRx() { digitalWrite(femIsKCT ? PIN_KCT_CTX : PIN_GC1109_CPS, LOW); }

uint32_t airBusySince = 0;
void startListening() {
  femRx();
  rxFlag = false;
  // the "preamble detected" flag on as well (not on DIO1): airBusy() reads it to know a packet is coming in right now
  radio.startReceive(RADIOLIB_SX126X_RX_TIMEOUT_INF, RADIOLIB_IRQ_RX_DEFAULT_FLAGS | (1UL << RADIOLIB_IRQ_PREAMBLE_DETECTED), RADIOLIB_IRQ_RX_DEFAULT_MASK, 0);
  airBusySince = 0;
}

// Carrier sense (loop() only): true while a packet is arriving. Before, the node only knew about a packet once it had
// fully arrived, so it often started sending in the middle of one from Heltec 1 - and both were lost.
bool airBusy() {
  if (!loraOk) return false;
  if (rxFlag) return true;                                   // a packet is waiting to be read
  uint32_t f = radio.getIrqFlags();
  if (f & RADIOLIB_SX126X_IRQ_HEADER_ERR) { startListening(); return false; }   // a damaged packet: over
  if (!(f & AIR_BUSY_FLAGS)) { airBusySince = 0; return false; }
  uint32_t now = millis();
  if (!airBusySince) airBusySince = now ? now : 1;   // (never "now | 1": that can be 1 ms in the future, and now - since wraps around)
  // a preamble that did not turn into a packet within 0.5 s (noise, another network's sync word) or a "packet" longer
  // than any of ours: listen afresh instead of waiting forever
  if (now - airBusySince > ((f & RADIOLIB_SX126X_IRQ_HEADER_VALID) ? 3000UL : 500UL)) { startListening(); return false; }
  return true;
}

// ============================ SHARED STATE LOCK ============================
// The two web servers run in their own tasks, the radio in loop(): every cache below is
// only touched while holding this lock. Radio transmissions happen OUTSIDE the lock.
SemaphoreHandle_t gLock;
struct Guard {
  Guard() { xSemaphoreTakeRecursive(gLock, portMAX_DELAY); }
  ~Guard() { xSemaphoreGiveRecursive(gLock); }
};
// (declared up here: the Arduino IDE puts its function prototypes before the first function)
struct LoginAsk { String clean, phone, pin, best; int bestScore = 0; };

// ============================ WEB / DNS ============================
httpd_handle_t httpServer = NULL;
httpd_handle_t httpsServer = NULL;
DNSServer dnsServer;
const byte DNS_PORT = 53;

// ============================ STATS ============================
volatile uint32_t loraRxCount = 0, loraTxCount = 0, httpReqCount = 0;
uint32_t lastPiHeardAt = 0;
uint32_t lastHeardAt = 0;   // any LoRa packet (listen-before-talk)
LinkQuality piLink;          // how well Heltec 1 is heard (mesh_protocol.h: short pieces on a weak link)
uint32_t holdTxUntil = 0;   // Heltec 1 is in the middle of a multi-piece send: stay quiet until then
bool holdingTx() { return (int32_t)(millis() - holdTxUntil) < 0; }

// ============================ NETWORK CLOCK ============================
// Chat shows "received in ...": for that every phone measures how far its own clock is from THIS clock
// (GET /api/ping). The clock is the Pi's, sent over LoRa in 'T' packets; until the first one arrives it is
// taken from the first phone that asks, so a node working alone still has one clock for all its phones.
// A 'T' packet handled late only ever makes the Pi's time look older - the newest-looking reading wins.
uint64_t upMs() { return (uint64_t)(esp_timer_get_time() / 1000); }
int64_t netClockBase = 0; uint8_t netClockSrc = 0;   // 0 none, 1 from a phone, 2 from the Pi
uint64_t netClockSetAt = 0;
uint64_t rxTimeValue = 0, rxTimeAt = 0;              // last 'T' packet (loop() only)
void netClockFromPi(uint64_t piNow, uint64_t at) {   // lock held
  if (!piNow) return;
  int64_t cand = (int64_t)piNow - (int64_t)at;
  int64_t diff = cand - netClockBase;
  if (netClockSrc != 2 || diff > 0 || diff < -5000 || upMs() - netClockSetAt > 300000ULL) {
    netClockBase = cand; netClockSrc = 2; netClockSetAt = upMs();
  }
}
uint64_t netNow() { return (uint64_t)(netClockBase + (int64_t)upMs()); }   // lock held
uint32_t lastDrawAt = 0;
int connectedClients = 0;
bool mapInstalled = false;

// ============================ IN-MEMORY CACHES ============================
#define ACC_CACHE_SIZE 120   // staff + every account that logged in on this node (was 40)
#define MSG_CACHE_SIZE 40
#define CTRL_CACHE_SIZE 10
#define EME_CACHE_SIZE 30
#define POS_CACHE_SIZE 24

String accCache[ACC_CACHE_SIZE]; String accIds[ACC_CACHE_SIZE]; int accCount = 0;
String msgCache[MSG_CACHE_SIZE]; String msgIds[MSG_CACHE_SIZE]; int msgCount = 0;
String ctrlCache[CTRL_CACHE_SIZE]; int ctrlCount = 0;

// Every change to what the phones see bumps dataVer: /api/bundle then answers "nothing changed" in a few
// bytes to a phone that is already up to date (the full app asks every 2 s).
volatile uint32_t dataVer = 1;
void touchData() { dataVer++; }

// Pushes a record in, replacing any existing entry with the same id; falls back to
// ring-buffer append if the id is new.
void cacheUpsert(String* cache, String* ids, int& count, const String& id, const String& json, int cap) {
  for (int i = 0; i < min(count, cap); i++) {
    if (ids[i] == id) { if (cache[i] != json) { cache[i] = json; touchData(); } return; }
  }
  int slot = count % cap;
  cache[slot] = json;
  ids[slot] = id;
  count++;
  touchData();
}

void ctrlPush(const String& json) {
  ctrlCache[ctrlCount % CTRL_CACHE_SIZE] = json;
  ctrlCount++;
  touchData();
}

// ---- requests (compact JSON as the app sends them: id,uid,b,ty,st,n,ad,cn,p,lat,lon,tm,ds,...)
// A closed request (completed / cancelled ...) is KEPT with its final status for 2 h, so every phone that
// showed it learns it was closed; it is the first to make room when the list is full.
struct EmeRec { String id; String json; uint32_t at = 0; bool finished = false; };
EmeRec emeCache[EME_CACHE_SIZE]; int emeCount = 0;

bool isFinishedStatus(const char* st) {
  String s = String(st ? st : ""); s.toLowerCase();
  return s.indexOf("complete") >= 0 || s.indexOf("cancel") >= 0 || s == "binned" || s == "archived" || s == "deleted";
}
String jsonIdOf(JsonDocument& doc, const char* key) {
  JsonVariant v = doc[key];
  if (v.isNull()) return "";
  if (v.is<const char*>()) return String(v.as<const char*>());
  String s; serializeJson(v, s); return s;
}
void emeRemoveAt(int i) {
  for (int k = i + 1; k < emeCount; k++) emeCache[k - 1] = emeCache[k];
  emeCount--;
  emeCache[emeCount] = EmeRec();
  touchData();
}
// the top-level "key":value pairs of a flat JSON object, exactly as written (so numbers are never re-formatted)
#define RF_MAX_PAIRS 40
int rfPairs(const String& js, int* ks, int* ve) {   // returns the pair count, -1 when it is not a plain object
  int n = 0, i = 0, L = js.length();
  while (i < L && isspace((unsigned char)js[i])) i++;
  if (i >= L || js[i] != '{') return -1;
  i++;
  for (;;) {
    while (i < L && isspace((unsigned char)js[i])) i++;
    if (i < L && js[i] == '}') return n;
    if (i >= L || js[i] != '"' || n >= RF_MAX_PAIRS) return -1;
    int k = i++;
    while (i < L && js[i] != '"') { if (js[i] == '\\') i++; i++; }
    if (i >= L) return -1;
    i++;
    while (i < L && isspace((unsigned char)js[i])) i++;
    if (i >= L || js[i] != ':') return -1;
    i++;
    while (i < L && isspace((unsigned char)js[i])) i++;
    if (i >= L) return -1;
    if (js[i] == '"') { i++; while (i < L && js[i] != '"') { if (js[i] == '\\') i++; i++; } if (i >= L) return -1; i++; }
    else if (js[i] == '{' || js[i] == '[') {
      int depth = 0; bool inStr = false;
      for (; i < L; i++) {
        char c = js[i];
        if (inStr) { if (c == '\\') i++; else if (c == '"') inStr = false; continue; }
        if (c == '"') inStr = true; else if (c == '{' || c == '[') depth++; else if (c == '}' || c == ']') { if (--depth == 0) { i++; break; } }
      }
      if (depth != 0) return -1;
    } else { while (i < L && js[i] != ',' && js[i] != '}' && !isspace((unsigned char)js[i])) i++; }
    ks[n] = k; ve[n] = i; n++;
    while (i < L && isspace((unsigned char)js[i])) i++;
    if (i < L && js[i] == ',') { i++; continue; }
    if (i < L && js[i] == '}') return n;
    return -1;
  }
}

// the key of the pair that starts at k (keys are plain names)
String jsonKeyAt(const String& js, int k) { int e = js.indexOf('"', k + 1); return e > k ? js.substring(k + 1, e) : ""; }
// Requests and chat are edited as TEXT: the named top-level fields are set (raw JSON value) or removed (raw ""), and
// every other value keeps the exact characters the phone / the Pi wrote. (Writing the whole record out again through
// the JSON library changed some numbers: 8.95339 came out as 8.953389.) ok = false when js is not a flat object.
String jsonEdit(const String& js, const char* const* keys, const String* raws, int n, bool& ok) {
  int ks[RF_MAX_PAIRS], ve[RF_MAX_PAIRS];
  int np = rfPairs(js, ks, ve);
  ok = np >= 0;
  if (!ok) return js;
  bool done[16] = { false };
  if (n > 16) n = 16;
  String out = "{";
  bool first = true;
  for (int i = 0; i < np; i++) {
    String key = jsonKeyAt(js, ks[i]);
    int hit = -1;
    for (int j = 0; j < n; j++) if (key == keys[j]) { hit = j; break; }
    String pair = js.substring(ks[i], ve[i]);
    if (hit >= 0) { done[hit] = true; if (!raws[hit].length()) continue; pair = "\"" + key + "\":" + raws[hit]; }
    if (!first) out += ",";
    out += pair; first = false;
  }
  for (int j = 0; j < n; j++) {
    if (done[j] || !raws[j].length()) continue;
    if (!first) out += ",";
    out += "\"" + String(keys[j]) + "\":" + raws[j]; first = false;
  }
  out += "}";
  return out;
}
String jsonQuote(const String& v) { JsonDocument d; d.set(v.c_str()); String o; serializeJson(d, o); return o; }
String jsonNum5(double v) {   // a coordinate rounded to 5 decimals, written exactly ("8.95339", not "8.953389")
  char b[32]; snprintf(b, sizeof(b), "%.5f", round(v * 1e5) / 1e5);
  String o = String(b);
  while (o.indexOf('.') >= 0 && (o.endsWith("0") || o.endsWith("."))) { bool dot = o.endsWith("."); o.remove(o.length() - 1); if (dot) break; }
  return o;
}

// json = one compact request: inserts / replaces by id
void emeUpsert(const String& json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;
  // the app makes request ids as numbers; the Pi sends them as text - always hand the phones a number
  String idRaw;
  if (doc["id"].is<const char*>()) {
    const char* s = doc["id"].as<const char*>(); size_t L = strlen(s); bool digits = L > 0 && L <= 15;
    for (size_t i = 0; i < L && digits; i++) digits = isdigit((unsigned char)s[i]);
    if (digits) { doc["id"] = (uint64_t)strtoull(s, NULL, 10); idRaw = String(s); }
  }
  const char* const ek[2] = { "k", "id" };
  String ev[2] = { "", idRaw };
  bool ok;
  String clean = jsonEdit(json, ek, ev, idRaw.length() ? 2 : 1, ok);   // every other value exactly as written
  doc.remove("k");
  if (!ok) serializeJson(doc, clean);
  String id = jsonIdOf(doc, "id");
  if (!id.length()) return;
  bool finished = isFinishedStatus(doc["st"] | "pending");
  int slot = -1;
  for (int i = 0; i < emeCount; i++) if (emeCache[i].id == id) { slot = i; break; }
  if (slot < 0 && finished) return;                      // never seen it open here - nothing to tell the phones
  if (slot >= 0 && emeCache[slot].json == clean) { emeCache[slot].at = millis(); return; }
  if (slot < 0) {
    if (emeCount < EME_CACHE_SIZE) slot = emeCount++;
    else {                                               // full: a closed one goes first, else the oldest
      slot = 0;
      for (int i = 1; i < emeCount; i++) {
        bool fi = emeCache[i].finished, fs = emeCache[slot].finished;
        if ((fi && !fs) || (fi == fs && emeCache[i].at < emeCache[slot].at)) slot = i;
      }
    }
  }
  emeCache[slot].id = id; emeCache[slot].json = clean; emeCache[slot].at = millis(); emeCache[slot].finished = finished;
  touchData();
}
// new status for one request (UPDATE_SOS from the Pi or from a responder on this node; ids may be shortened)
void emeSetStatus(const String& idIn, const char* st) {
  if (!idIn.length()) return;
  for (int i = 0; i < emeCount; i++) {
    const String& id = emeCache[i].id;
    if (!(id == idIn || id.startsWith(idIn) || idIn.startsWith(id))) continue;
    JsonDocument doc;
    if (deserializeJson(doc, emeCache[i].json)) return;
    if (strcmp(doc["st"] | "", st) == 0) return;
    const char* const ek[1] = { "st" };
    String ev[1] = { jsonQuote(String(st)) };
    bool ok;
    String out = jsonEdit(emeCache[i].json, ek, ev, 1, ok);
    if (!ok) { doc["st"] = st; out = ""; serializeJson(doc, out); }
    emeCache[i].json = out; emeCache[i].at = millis(); emeCache[i].finished = isFinishedStatus(st);
    touchData();
    return;
  }
}
// MOVE_SOS: the requester put the pin on their exact spot (mp 1), or went back to GPS (mp 0)
void emeSetPos(const String& idIn, double la, double lo, bool manual) {
  if (!idIn.length() || (la == 0 && lo == 0) || la < -90 || la > 90 || lo < -180 || lo > 180) return;
  for (int i = 0; i < emeCount; i++) {
    const String& id = emeCache[i].id;
    if (!(id == idIn || id.startsWith(idIn) || idIn.startsWith(id))) continue;
    const char* const ek[3] = { "lat", "lon", "mp" };
    String ev[3] = { jsonNum5(la), jsonNum5(lo), manual ? "1" : "" };
    bool ok;
    String out = jsonEdit(emeCache[i].json, ek, ev, 3, ok);
    if (!ok) return;
    if (out == emeCache[i].json) return;
    emeCache[i].json = out; emeCache[i].at = millis();
    touchData();
    return;
  }
}
// TRIAGE_UPDATE: forced priority / severity
void emeSetTriage(const String& idIn, JsonVariant fp, const char* sev) {
  if (!idIn.length()) return;
  for (int i = 0; i < emeCount; i++) {
    const String& id = emeCache[i].id;
    if (!(id == idIn || id.startsWith(idIn) || idIn.startsWith(id))) continue;
    const char* ek[2]; String ev[2]; int n = 0;
    if (!fp.isNull()) { ek[n] = "fp"; ev[n] = fp.as<bool>() ? "1" : "0"; n++; }
    if (sev && sev[0]) { ek[n] = "sev"; ev[n] = jsonQuote(String(sev)); n++; }
    if (!n) return;
    bool ok;
    String out = jsonEdit(emeCache[i].json, ek, ev, n, ok);
    if (!ok) return;
    if (out != emeCache[i].json) { emeCache[i].json = out; emeCache[i].at = millis(); touchData(); }
    return;
  }
}
void emePrune() {   // closed ones after 2 h, open ones after 12 h without any update
  for (int i = emeCount - 1; i >= 0; i--) {
    uint32_t age = millis() - emeCache[i].at;
    if ((emeCache[i].finished && age > 2UL * 3600000UL) || age > 12UL * 3600000UL) emeRemoveAt(i);
  }
}

// ---- alert settings the phones read (/api/settings): from the Pi, and from admins on this node
String settingsJson = "{\"redAlertActive\":false}";
uint32_t lastAlertActionAt = 0;
void settingsMerge(JsonDocument& patch) {
  JsonDocument cur;
  if (deserializeJson(cur, settingsJson)) cur.to<JsonObject>();
  for (JsonPair kv : patch.as<JsonObject>()) cur[kv.key()] = kv.value();
  String out; serializeJson(cur, out);
  if (out.length() > 4000) return;                       // never let it grow without bound
  if (out != settingsJson) { settingsJson = out; touchData(); }
}

// a compact account {i,n,l,p,r,st,b,...}: new status / role / barangay (UPDATE_ACCOUNT)
void accApplyUpdate(const String& idIn, const char* st, const char* r, const char* b) {
  if (!idIn.length()) return;
  int n = min(accCount, ACC_CACHE_SIZE);
  for (int i = 0; i < n; i++) {
    if (!(accIds[i] == idIn || accIds[i].startsWith(idIn))) continue;
    JsonDocument doc;
    if (deserializeJson(doc, accCache[i])) return;
    if (st && st[0]) doc["st"] = st;
    if (r && r[0]) doc["r"] = r;
    if (b && b[0]) doc["b"] = b;
    String out; serializeJson(doc, out);
    if (out != accCache[i]) { accCache[i] = out; touchData(); }
    return;
  }
}

// Applies an action ({"action":...}) to what this node shows its phones - from the Pi (LoRa 'C') or from a
// phone on this node (a responder dispatches, an admin raises an alert ...). The phones apply it as well.
void applyAction(JsonDocument& a) {
  const char* act = a["action"] | "";
  String id = jsonIdOf(a, "id");
  if (!strcmp(act, "UPDATE_SOS")) emeSetStatus(id, a["st"] | "pending");
  else if (!strcmp(act, "TRIAGE_UPDATE")) emeSetTriage(id, a["fp"], a["sev"] | "");
  else if (!strcmp(act, "MOVE_SOS")) emeSetPos(id, a["lat"] | 0.0, a["lon"] | 0.0, (a["mp"] | 0) != 0);
  else if (!strcmp(act, "UPDATE_ACCOUNT")) accApplyUpdate(id, a["st"] | "", a["r"] | "", a["b"] | "");
  else if (!strcmp(act, "RED_ALERT") || !strcmp(act, "STOP_ALERT")) {
    bool on = !strcmp(act, "RED_ALERT");
    JsonDocument patch;
    if (a["global"] | false) {
      patch["redAlertActive"] = on;
      patch["redAlertHazard"] = on ? (a["hazard"] | "") : "";
      patch["redAlertAction"] = on ? (a["act"] | "") : "";
      if (on) patch["redAlertTimestamp"] = a["ts"];
      else patch["barangayRedAlerts"].to<JsonObject>();
    } else {
      const char* brgy = a["brgy"] | "";
      if (!brgy[0]) return;
      JsonDocument cur; deserializeJson(cur, settingsJson);
      JsonObject alerts = patch["barangayRedAlerts"].to<JsonObject>();
      for (JsonPair kv : cur["barangayRedAlerts"].as<JsonObject>()) alerts[kv.key()] = kv.value();
      JsonObject one = alerts[brgy].to<JsonObject>();
      one["active"] = on;
      if (on) { one["targetPurok"] = a["purok"] | "ALL"; one["hazard"] = a["hazard"] | ""; one["action"] = a["act"] | ""; one["timestamp"] = a["ts"]; }
    }
    settingsMerge(patch);
    lastAlertActionAt = millis();
  }
}

// ---- live positions (struct PosRec is defined near the top of the file)
PosRec posCache[POS_CACHE_SIZE];
uint32_t lastPosTxAt = 0;

char roleCode(const char* r) {
  if (!r) return 'u';
  if (!strcmp(r, "ambulance")) return 'a';
  if (!strcmp(r, "evacuation")) return 'e';
  if (!strcmp(r, "rescue")) return 'r';
  if (!strcmp(r, "relief")) return 'l';
  if (!strcmp(r, "admin")) return 'd';
  if (!strcmp(r, "authority")) return 't';
  if (!strcmp(r, "superadmin")) return 's';
  return 'u';
}
const char* roleName(char c) {
  switch (c) {
    case 'a': return "ambulance"; case 'e': return "evacuation"; case 'r': return "rescue"; case 'l': return "relief";
    case 'd': return "admin"; case 't': return "authority"; case 's': return "superadmin";
    default: return "user";
  }
}
bool isUnitCode(char c) { return c == 'a' || c == 'e' || c == 'r' || c == 'l'; }
bool isStaffRole(const String& r) {
  return r == "ambulance" || r == "evacuation" || r == "rescue" || r == "relief" || r == "admin" || r == "authority" || r == "superadmin";
}
PosRec* posSlot(const char* h) {
  int freeSlot = -1, oldest = 0;
  for (int i = 0; i < POS_CACHE_SIZE; i++) {
    if (posCache[i].used && !strncmp(posCache[i].h, h, sizeof(posCache[i].h))) return &posCache[i];
    if (!posCache[i].used && freeSlot < 0) freeSlot = i;
    if (posCache[i].seenAt < posCache[oldest].seenAt) oldest = i;
  }
  int s = freeSlot >= 0 ? freeSlot : oldest;
  posCache[s] = PosRec();
  posCache[s].used = true;
  strncpy(posCache[s].h, h, sizeof(posCache[s].h) - 1);
  return &posCache[s];
}
void posPrune() {
  for (int i = 0; i < POS_CACHE_SIZE; i++) if (posCache[i].used && millis() - posCache[i].seenAt > 30UL * 60000UL) posCache[i].used = false;
}
// metres between two 1e-5 degree points (good enough for "did it move")
float posDist(int32_t la1, int32_t lo1, int32_t la2, int32_t lo2) {
  float dy = (la2 - la1) * 1.1132f, dx = (lo2 - lo1) * 1.1132f * cosf(la1 * 1e-5f * 0.0174533f);
  return sqrtf(dx * dx + dy * dy);
}
// {"ok":true,"u":[...units...],"q":[...requesters, staff only...]}
String buildPositionsJson(const String& role) {
  posPrune();
  bool staff = isStaffRole(role);
  String u = "", q = "";
  uint32_t now = millis();
  for (int i = 0; i < POS_CACHE_SIZE; i++) {
    PosRec& p = posCache[i];
    if (!p.used) continue;
    bool unit = isUnitCode(p.rc);
    if (!unit && !staff) continue;
    JsonDocument d;
    d["h"] = p.h; d["n"] = p.name; d["r"] = roleName(p.rc);
    d["la"] = p.la5 / 100000.0; d["lo"] = p.lo5 / 100000.0; d["a"] = p.acc;
    d["s"] = (now - p.seenAt) / 1000; d["src"] = p.local ? "node" : "lora";
    String one; serializeJson(d, one);
    String& dst = unit ? u : q;
    if (dst.length()) dst += ",";
    dst += one;
  }
  return "{\"ok\":true,\"u\":[" + u + "],\"q\":[" + q + "]}";
}

// ============================ PENDING LOGINS (one per phone) ============================
// Each phone's LoRa login has its own slot and its own query id (q). Before 2026-10-28 there was ONE slot: when several
// students logged in at once, each new login overwrote the one before, and the answer went to whichever phone asked
// first. A far node (weak radio, EAP110 repeater) also needs more time: the question is sent again every 20 s and the
// answer is kept for 2.5 minutes.
#define LOGIN_SLOTS 24
#define LOGIN_WAIT_MS 150000UL
#define LOGIN_RESEND_MS 20000UL
struct PendingLogin {
  bool active = false;
  String qid, ident, pin;
  uint32_t startedAt = 0, lastSentAt = 0;
  bool resolved = false;
  String resultJson; // e.g. {"status":"APPROVED","user":{...FULL verbose keys...}}
};
PendingLogin logins[LOGIN_SLOTS];
// the slot of query id q, or -1 (an index, not a pointer: Arduino's generated prototypes come before this struct)
int loginSlotOf(const String& q) {   // lock held
  for (int i = 0; i < LOGIN_SLOTS; i++) if (logins[i].active && logins[i].qid == q) return i;
  return -1;
}
void loginsExpire() {   // lock held
  for (auto& l : logins) if (l.active && millis() - l.startedAt > LOGIN_WAIT_MS) { l.active = false; l.resultJson = ""; }
}

// ============================ OUTGOING LORA QUEUE + NON-BLOCKING SENDER ============================
// Web handlers only queue; loop() transmits (txTick), outside the lock.
struct OutgoingItem {
  char type;     // PKT_MESSAGE, PKT_SOS, or PKT_LOGIN_Q
  String id;
  String json;   // for Q this is "identifier\x1Fpin"
};
#define OUT_QUEUE_SIZE 8
OutgoingItem outQueue[OUT_QUEUE_SIZE];
int outHead = 0, outCount = 0;

bool enqueueOutgoing(char type, const String& id, const String& json) {
  if (outCount >= OUT_QUEUE_SIZE) return false;
  int slot = (outHead + outCount) % OUT_QUEUE_SIZE;
  outQueue[slot] = { type, id, json };
  outCount++;
  return true;
}

// One payload at a time. Its pieces go out in ONE burst (fast pieces, mesh_protocol.h); Heltec 1 answers once with the
// pieces it has, and only the missing ones go again. (Before: one piece, wait for its ACK, next piece ...)
struct TxState {
  bool active = false;
  char type = 0;
  String id;
  String fullJson;
  uint8_t totalChunks = 0;
  uint16_t pieceLen = CHUNK_RAW_LEN;   // short pieces on a weak link (mesh_protocol.h)
  uint32_t todo = 0;           // pieces still to send in this burst (bit 0 = piece 1)
  bool inBurst = false;        // a burst has started: the next pieces follow at once, no listen-before-talk
  bool waitingAck = false;     // the burst is out: waiting for Heltec 1's answer
  bool skipLbt = false;        // Heltec 1 just asked for missing pieces: it is listening, send at once
  uint8_t retryCount = 0;
  uint32_t lastSentAt = 0;     // end of the burst (the ACK timeout counts from there)
  uint16_t jitter = 0;         // random extra quiet time before a try, so two radios do not keep colliding
} tx;

// How many times one piece is tried before the payload is given up: a request (SOS) and an action (dispatch,
// pin ...) almost never - about two minutes of trying - chat a bit less. Requests and chat are also kept in
// upTrack below and sent again until Heltec 1 echoes them back.
uint8_t txLimit(char type) {
  if (type == PKT_SOS) return 60;
  if (type == PKT_MESSAGE) return 40;
  return MAX_RETRIES;
}

// ---- requests and chat that went up must be CONFIRMED: Heltec 1 echoes every one it received (its 'D' broadcast).
// Until that echo arrives, the payload is sent again every 40 s (at most 8 times) - nothing is silently lost when
// the channel was busy or the Pi side was out of range for a while.
struct PendingUp { bool used = false; char type = 0; String chunkId; String key; String json; uint32_t sentAt = 0; uint8_t sends = 0; };
#define PENDING_UP 10
PendingUp pendUp[PENDING_UP];
void upTrack(char type, const String& chunkId, const String& key, const String& json) {   // lock held
  if (!key.length()) return;
  int slot = -1;
  for (int i = 0; i < PENDING_UP; i++) if (pendUp[i].used && pendUp[i].key == key) { slot = i; break; }
  if (slot < 0) for (int i = 0; i < PENDING_UP; i++) if (!pendUp[i].used) { slot = i; break; }
  if (slot < 0) { slot = 0; for (int i = 1; i < PENDING_UP; i++) if (pendUp[i].sentAt < pendUp[slot].sentAt) slot = i; }
  pendUp[slot].used = true; pendUp[slot].type = type; pendUp[slot].chunkId = chunkId; pendUp[slot].key = key;
  pendUp[slot].json = json; pendUp[slot].sentAt = millis(); pendUp[slot].sends = 1;
}
void upConfirm(const String& key) {   // lock held
  if (!key.length()) return;
  for (int i = 0; i < PENDING_UP; i++) if (pendUp[i].used && pendUp[i].key == key) { pendUp[i].used = false; pendUp[i].json = ""; }
}
int upWaiting() { int n = 0; for (int i = 0; i < PENDING_UP; i++) if (pendUp[i].used) n++; return n; }

String jsonEscape(const String& in) {
  String out = in;
  out.replace("\\", "\\\\");
  out.replace("\"", "\\\"");
  return out;
}

// how well Heltec 1 (the command center) is heard: for the app's link bar, /admin and the screen
String signalJson() {
  if (!piLink.heardAt) return "null";
  char b[96];
  snprintf(b, sizeof(b), "{\"q\":\"%s\",\"rs\":%d,\"sn\":%.1f,\"sa\":%.1f,\"ls\":%lu}", piLink.word(), (int)piLink.rssi, piLink.snr, piLink.snrAvg, (unsigned long)piLink.losses);
  return String(b);
}

void sendRaw(const String& packet) {   // loop() only
  if (!loraOk) return;
  femTx();
  radio.transmit((const uint8_t*)packet.c_str(), packet.length());
  loraTxCount++;
  startListening();
}

void sendAck(const String& id, uint8_t idx) {
  sendRaw("AM" + String((char)PKT_ACK) + "{\"a\":\"" + id + "\",\"x\":" + idx + "}");
}

void sendMaskAck(const String& id, uint32_t mask) { sendRaw(maskAckPacket(id, mask)); }

void txStartIfIdle() {
  if (tx.active || outCount == 0) return;
  OutgoingItem item = outQueue[outHead];
  outHead = (outHead + 1) % OUT_QUEUE_SIZE;
  outCount--;

  tx.active = true;
  tx.type = item.type;
  tx.id = item.id;
  tx.fullJson = item.json;
  tx.retryCount = 0;
  tx.lastSentAt = 0;
  tx.inBurst = false; tx.waitingAck = false; tx.skipLbt = false; tx.jitter = 0;

  if (item.type == PKT_LOGIN_Q) {
    tx.totalChunks = 1; // Q is always a single flat packet, not chunk-sliced
  } else {
    tx.pieceLen = pieceLenFor(item.json.length(), piLink.weak());
    tx.totalChunks = rawTotalFor(item.json.length(), tx.pieceLen);
    if (tx.totalChunks > 16) { tx.active = false; return; } // refuse to send something this firmware can't chunk safely
  }
  tx.todo = fullMaskOf(tx.totalChunks);
}

String txPacket(uint8_t idx) {
  if (tx.type == PKT_LOGIN_Q) {
    int sep = tx.fullJson.indexOf('');
    String identifier = sep >= 0 ? tx.fullJson.substring(0, sep) : tx.fullJson;
    String pin = sep >= 0 ? tx.fullJson.substring(sep + 1) : "";
    return "AM" + String((char)PKT_LOGIN_Q) + "{\"q\":\"" + tx.id + "\",\"u\":\"" + jsonEscape(identifier) + "\",\"p\":\"" + jsonEscape(pin) + "\"}";
  }
  return rawPiece(tx.type, tx.id, idx, tx.totalChunks, tx.fullJson, tx.pieceLen);
}

// pieces keep getting lost (the third try of a payload in long pieces): it is cut again into short pieces and sent
// whole - same id; Heltec 1 starts over when the number of pieces changes (mesh_protocol.h ChunkReassembler)
bool txRecutShort() {   // lock held
  if (tx.type == PKT_LOGIN_Q || tx.retryCount < 2 || tx.pieceLen <= CHUNK_RAW_WEAK) return false;
  if (pieceLenFor(tx.fullJson.length(), true) != CHUNK_RAW_WEAK) return false;
  tx.pieceLen = CHUNK_RAW_WEAK;
  tx.totalChunks = rawTotalFor(tx.fullJson.length(), tx.pieceLen);
  tx.todo = fullMaskOf(tx.totalChunks);
  return true;
}

void txTick() {
  String pkt;
  bool first;
  {
    Guard g;
    txStartIfIdle();
    if (!tx.active) return;
    if (tx.waitingAck) {
      if (millis() - tx.lastSentAt < ACK_TIMEOUT_MS) return;    // still waiting for Heltec 1's answer
      tx.retryCount++;                                           // no answer: try again
      tx.waitingAck = false;
      tx.jitter = (uint16_t)random(30, FIELD_JITTER_MS);   // a random moment, but always before Heltec 1's window (mesh_protocol.h)
      piLink.lost();
      if (tx.retryCount >= txLimit(tx.type)) { tx.active = false; return; }   // requests / chat are sent again by upTick
      // only the LAST piece again: Heltec 1 answers it with the pieces it has (all of them sent again only if it has none)
      if (!txRecutShort()) tx.todo = tx.type == PKT_LOGIN_Q ? 1 : (1UL << (tx.totalChunks - 1));
    }
    first = !tx.inBurst;
    // listen before talk (before a burst only): never start while a packet is coming in, while Heltec 1 is in the
    // middle of a multi-piece send, or right after the channel was in use
    if (first && !tx.skipLbt && (holdingTx() || millis() - lastHeardAt < FIELD_LBT_MS + tx.jitter)) return;
  }
  if (first && !tx.skipLbt && airBusy()) return;                 // reads the radio: outside the lock, loop() only
  {
    Guard g;
    if (!tx.active || tx.waitingAck || !tx.todo) return;
    uint8_t idx = 1; while (!(tx.todo & (1UL << (idx - 1)))) idx++;
    tx.todo &= ~(1UL << (idx - 1));
    tx.inBurst = tx.todo != 0;
    tx.skipLbt = false;
    pkt = txPacket(idx);
  }
  sendRaw(pkt);
  Guard g;
  if (!tx.inBurst) { tx.waitingAck = true; tx.lastSentAt = millis(); }   // the ACK timeout counts from the END of the burst
}

// a fast ACK (AMK#): Heltec 1 has the pieces in `mask` - done, or send only the missing ones right away
void txHandleMaskAck(const String& ackedId, uint32_t mask, char flag) {
  if (!tx.active || tx.type == PKT_LOGIN_Q || tx.id != ackedId) return;
  uint32_t missing = fullMaskOf(tx.totalChunks) & ~mask;
  if (!missing) {
    // Heltec 1 has the WHOLE request / message. It counts as DELIVERED only when Heltec 1 also says the command
    // center is listening ('P', firmware 2026-10-29a): the radio alone is not proof that the Pi stored it. On '-'
    // (or no flag at all, from older firmware) the payload stays in upTrack and is sent again until it is confirmed.
    if ((tx.type == PKT_SOS || tx.type == PKT_MESSAGE) && flag == ACK_FLAG_PI_OK)
      for (int i = 0; i < PENDING_UP; i++) if (pendUp[i].used && pendUp[i].chunkId == tx.id) { pendUp[i].used = false; pendUp[i].json = ""; }
    tx.active = false; tx.jitter = 0; return;
  }
  if (tx.inBurst) return;                                      // (an answer to an earlier burst - this one is still going)
  tx.retryCount++;
  piLink.lost();
  if (tx.retryCount >= txLimit(tx.type)) { tx.active = false; return; }
  if (!txRecutShort()) tx.todo = missing;
  tx.waitingAck = false; tx.skipLbt = true; tx.jitter = 0;
}

// an old-style ACK ({"a":id,"x":idx}): only the login query still uses it
void txHandleAck(const String& ackedId, uint8_t ackedIdx) {
  if (!tx.active || tx.id != ackedId || tx.type != PKT_LOGIN_Q || ackedIdx != 0) return;
  tx.active = false;
}

void enqueueLoginQuery(const String& qid, const String& identifier, const String& pin) {
  enqueueOutgoing(PKT_LOGIN_Q, qid, identifier + "\x1F" + pin);
}

// ---- live positions out: one 'P' packet at most every 15 s, only with something new to say
String buildPosPacket() {
  if (millis() - lastPosTxAt < 15000) return "";
  uint32_t now = millis();
  int pick[3]; int n = 0;
  // pass 0: moved >= 10 m / never sent; pass 1: unchanged but not sent for 60 s (keep-alive)
  for (int pass = 0; pass < 2 && n < 3; pass++) {
    for (int unitFirst = 1; unitFirst >= 0 && n < 3; unitFirst--) {
      for (int i = 0; i < POS_CACHE_SIZE && n < 3; i++) {
        PosRec& p = posCache[i];
        if (!p.used || !p.local || now - p.seenAt > 180000UL) continue;
        if (isUnitCode(p.rc) != (unitFirst == 1)) continue;
        bool dup = false; for (int k = 0; k < n; k++) if (pick[k] == i) dup = true;
        if (dup) continue;
        bool moved = p.sentAt == 0 || posDist(p.sentLa5, p.sentLo5, p.la5, p.lo5) >= 10.0f;
        if (moved) p.sends = 0;
        bool changed = moved || p.sends < 2;          // the second copy goes 15 s after the first
        bool stale = p.sentAt != 0 && now - p.sentAt >= 60000UL;
        if (pass == 0 ? changed : stale) pick[n++] = i;
      }
    }
  }
  if (!n) return "";
  String body = "{\"p\":[";
  int used = 0;
  for (int k = 0; k < n; k++) {
    PosRec& p = posCache[pick[k]];
    JsonDocument d; JsonArray a = d.to<JsonArray>();
    a.add(p.h); a.add(p.la5); a.add(p.lo5); a.add(min((int)p.acc, 999)); a.add(String(p.rc)); a.add(p.name); a.add((now - p.seenAt) / 1000);
    String one; serializeJson(d, one);
    if (body.length() + one.length() + 3 > POS_PACKET_MAX) break;
    if (used) body += ",";
    body += one; used++;
    p.sentLa5 = p.la5; p.sentLo5 = p.lo5; p.sentAt = now; if (p.sends < 255) p.sends++;
  }
  if (!used) return "";
  body += "]}";
  lastPosTxAt = now;
  return "AM" + String((char)PKT_POS) + body;
}

// ============================ INCOMING FRAME HANDLING ============================
// (struct Frame is defined near the top of the file)

Frame readIncomingFrame() {   // loop() only
  Frame f;
  rxFlag = false;
  lastHeardAt = millis();                 // the channel was in use - even when the packet turns out damaged
  size_t len = radio.getPacketLength();
  if (len == 0 || len > MAX_LORA_PACKET) { startListening(); return f; }

  uint8_t buf[MAX_LORA_PACKET + 1];
  int state = radio.readData(buf, len);
  float rssi = radio.getRSSI(), snr = radio.getSNR();   // of this packet: read before the radio listens again
  startListening();
  if (state != RADIOLIB_ERR_NONE) return f;
  if (len < 3 || buf[0] != PKT_MAGIC0 || buf[1] != PKT_MAGIC1) return f;
  buf[len] = 0;

  loraRxCount++;
  lastPiHeardAt = millis();
  piLink.heard(rssi, snr);
  uint64_t gotAt = upMs();

  f.type = (char)buf[2];
  if (len >= 4 && buf[3] == '#') {                 // fast piece / fast ACK
    if (f.type == PKT_ACK) {
      if (len < 16) return f;
      uint32_t m = 0;
      for (int i = 12; i < 16; i++) { int v = hexVal((char)buf[i]); if (v < 0) return f; m = (m << 4) | (uint32_t)v; }
      f.id = rawIdOf(buf); f.mask = m;
      if (len >= 17) f.flag = (char)buf[16];   // 'P' / '-' (older Heltec 1 sends none)
    } else {
      if (len < RAW_HDR_LEN) return f;
      int a = hexVal((char)buf[12]), b = hexVal((char)buf[13]);
      if (a < 0 || b < 0 || a > b) return f;
      f.id = rawIdOf(buf); f.idx = a + 1; f.tot = b + 1; f.dat = String((const char*)(buf + RAW_HDR_LEN));
    }
    f.raw = true; f.valid = true;
    return f;
  }
  JsonDocument doc;
  if (deserializeJson(doc, (const char*)(buf + 3), len - 3)) return f;
  if (f.type == PKT_TIME) { rxTimeValue = doc["t"].as<uint64_t>(); rxTimeAt = gotAt; }

  if (f.type == PKT_ACK) {
    f.id = String((const char*)(doc["a"] | ""));
    f.idx = doc["x"] | 0;
  } else if (f.type == PKT_POS) {
    f.dat = String((const char*)(buf + 3));
  } else {
    f.id = String((const char*)(doc["i"] | ""));
    f.idx = doc["x"] | 0;
    f.tot = doc["t"] | 0;
    f.dat = String((const char*)(doc["d"] | ""));
  }
  f.valid = true;
  return f;
}

// compact account {i,n,l,p,r,st,b,pk,c} -> verbose shape used by /api/login and /api/lora_result
String compactAccountToVerbose(const String& compactJson) {
  JsonDocument in;
  if (deserializeJson(in, compactJson)) return "{}";
  JsonDocument out;
  out["id"] = in["i"];
  out["username"] = in["n"];
  out["loginUsername"] = in["l"];
  out["pin"] = in["p"];
  out["role"] = in["r"];
  out["status"] = in["st"];
  out["barangay"] = in["b"];
  out["purok"] = in["pk"];
  out["contact"] = in["c"];
  String result;
  serializeJson(out, result);
  return result;
}

// ============================ ACCOUNT BOOK (firmware 2026-10-28b) ============================
// Every approved account, sent by the Pi in the background in small confirmed batches (control action BOOK) - so a
// whole class logging in at the same moment is answered HERE, at once, without asking the Pi over the radio (that
// takes ~3 s of airtime per login: 100 at once could never finish). Kept in flash (/book.txt, one account a line:
// id TAB sig TAB compact json) so a restart keeps it. It is NOT in the phones' account list (it holds the PINs):
// only the login handlers read it. The node reports how many it has (BOOK_STATE) after start-up and every 30 min;
// the Pi sends the whole book again when that does not match what it sent.
#define BOOK_MAX 600
SemaphoreHandle_t bookLock;
struct BookGuard {
  BookGuard() { xSemaphoreTakeRecursive(bookLock, portMAX_DELAY); }
  ~BookGuard() { xSemaphoreGiveRecursive(bookLock); }
};
bool bookFsOk = false;
int bookN = 0; uint32_t bookSum = 0;          // how many accounts, and the sum of their sigs (what BOOK_STATE reports)
#define BOOK_PENDING 4
String bookPending[BOOK_PENDING]; int bookPendingN = 0;   // BOOK payloads heard (lock held), written in loop()
uint32_t bookStateAt = 0; bool bookStateSent = false; uint16_t bookAsks = 0;   // how often this node asked the Pi for the book

// every line of the book file, in order; fn returns false to stop
void bookEach(bool (*fn)(const String& line, void* ctx), void* ctx) {
  if (!bookFsOk || !LittleFS.exists("/book.txt")) return;
  File f = LittleFS.open("/book.txt", "r");
  if (!f) return;
  String line; line.reserve(256);
  uint8_t buf[512];
  for (;;) {
    size_t n = f.read(buf, sizeof(buf));
    if (!n) break;
    for (size_t i = 0; i < n; i++) {
      if (buf[i] == '\n') { if (line.length() && !fn(line, ctx)) { f.close(); return; } line = ""; }
      else if (line.length() < 1024) line += (char)buf[i];
    }
  }
  f.close();
  if (line.length()) fn(line, ctx);
}
String bookField(const String& line, int which) {   // 0 id, 1 sig, 2 json
  int a = line.indexOf('\t'), b = a < 0 ? -1 : line.indexOf('\t', a + 1);
  if (b < 0) return "";
  return which == 0 ? line.substring(0, a) : which == 1 ? line.substring(a + 1, b) : line.substring(b + 1);
}
bool bookCountLine(const String& line, void* ctx) {
  (void)ctx;
  String sg = bookField(line, 1);
  if (!sg.length()) return true;
  bookN++; bookSum += (uint32_t)strtoul(sg.c_str(), nullptr, 16);
  return true;
}
void bookLoad() {   // setup(), after the storage is mounted
  BookGuard bg;
  if (!LittleFS.exists("/book.txt") && LittleFS.exists("/book.tmp")) LittleFS.rename("/book.tmp", "/book.txt");   // cut off mid-write
  if (LittleFS.exists("/book.tmp")) LittleFS.remove("/book.tmp");
  bookN = 0; bookSum = 0;
  bookEach(bookCountLine, nullptr);
}

// the same matching as the Pi (findLogin in amping-server.js): login name / user name without spaces, dashes, dots
// and underscores, or the contact number's last 10 digits; the PIN must match exactly. Best: login name 3, number 2, name 1.
String loginClean(const String& s) {
  String o; o.reserve(s.length());
  for (unsigned int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c == ' ' || c == '\t' || c == '-' || c == '_' || c == '.') continue; o += (char)tolower((unsigned char)c); }
  return o;
}
String loginPhone(const String& s) {
  String d; for (unsigned int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c >= '0' && c <= '9') d += c; }
  return d.length() >= 10 ? d.substring(d.length() - 10) : d;
}
void loginScore(void* qv, const String& compact) {   // qv: LoginAsk*
  LoginAsk& q = *(LoginAsk*)qv;
  JsonDocument acc;
  if (deserializeJson(acc, compact)) return;
  String upin = String((const char*)(acc["p"] | "")); upin.trim();
  if (upin != q.pin) return;
  String sys = loginClean(String((const char*)(acc["l"] | "")));
  String name = loginClean(String((const char*)(acc["n"] | "")));
  String uPhone = loginPhone(String((const char*)(acc["c"] | "")));
  int score = 0;
  if (sys.length() && sys == q.clean) score = 3;
  else if (q.phone.length() >= 7 && uPhone == q.phone) score = 2;
  else if (name.length() && name == q.clean) score = 1;
  if (score > q.bestScore) { q.bestScore = score; q.best = compact; }
}
bool bookFindLine(const String& line, void* ctx) {
  LoginAsk* q = (LoginAsk*)ctx;
  if (line.indexOf("\"p\":\"" + q->pin + "\"") < 0) return true;   // quick skip: another PIN
  loginScore(q, bookField(line, 2));
  return q->bestScore < 3;                                           // a login-name match cannot be beaten
}

// the account for this login, from what the node already has (its own list, then the book): compact json or "".
// Never a "wrong PIN" here - what the node does not find goes to the Pi as before.
String localLogin(const String& identifier, const String& pin) {
  LoginAsk q; q.clean = loginClean(identifier); q.phone = loginPhone(identifier); q.pin = pin; q.pin.trim();
  if (!q.clean.length() || !q.pin.length()) return "";
  {
    Guard g;
    int n = min(accCount, ACC_CACHE_SIZE);
    for (int i = 0; i < n; i++) loginScore(&q, accCache[i]);
  }
  if (q.bestScore < 3) { BookGuard bg; bookEach(bookFindLine, &q); }
  if (!q.best.length()) return "";
  JsonDocument acc;
  if (deserializeJson(acc, q.best)) return "";
  String st = String((const char*)(acc["st"] | "")); st.toLowerCase();
  if (st != "approved") return "";
  acc.remove("h");
  acc.remove("k");
  String out; serializeJson(acc, out);
  return out;
}

// logins the node answered itself (see hLoraLogin): q -> account id, for apps that still poll /api/lora_result
#define LOCAL_ANSWERS 128
struct LocalAnswer { String q, accId; uint32_t at = 0; };
LocalAnswer localAnswers[LOCAL_ANSWERS]; int localAnswerNext = 0;

bool bookIdLine(const String& line, void* ctx) {
  String* io = (String*)ctx;               // in: account id, out: its compact json
  if (bookField(line, 0) != *io) return true;
  *io = "" + bookField(line, 2);
  return false;
}
String localAccountById(const String& id) {   // compact json (approved accounts only) or ""
  String found;
  {
    Guard g;
    int n = min(accCount, ACC_CACHE_SIZE);
    for (int i = 0; i < n; i++) if (accIds[i] == id) { found = accCache[i]; break; }
  }
  if (!found.length()) {
    String io = id;
    { BookGuard bg; bookEach(bookIdLine, &io); }
    if (io.length() && io[0] == '') found = io.substring(1);
  }
  if (!found.length()) return "";
  JsonDocument acc;
  if (deserializeJson(acc, found)) return "";
  String st = String((const char*)(acc["st"] | "")); st.toLowerCase();
  if (st != "approved") return "";
  acc.remove("h"); acc.remove("k");
  String out; serializeJson(acc, out);
  return out;
}

// ============================ SHORT RADIO FORM (firmware 2026-10-28c) ============================
// An SOS or a chat message crosses the radio WITHOUT the parts the other side rebuilds exactly - fewer bytes, less
// airtime, fewer pieces to lose on a weak link (an SOS: ~320 -> ~140 bytes, 2 pieces -> 1). The same rules are in
// amping-server.js (radioPack / radioUnpack); "z" lists what was left out, "y" is the request type as a code:
//   SOS   n name, c contact (cn), b barangay, p purok  = the account's own value (book copy, same cut as the app)
//         a address = "Registered Address" (the app's default)
//         t / T time = the request id (ms) as the app writes it in Manila time, "MM/DD/YYYY hh:mm AM" (T: newer phones
//               put U+202F before AM/PM)
//         s status = "pending";  y type code (Ambulance A, Rescue R ...)
//   chat  n name, r role = the account's own value (private: sid, request chat: u);  t / T time = ts as "hh:mm AM"
// A value is only left out when it is EXACTLY what the rule gives back; and before a short packet goes out this node
// unpacks it again and compares it with the original - any difference and the full packet goes instead. Short packets
// are only sent once the Pi has said it reads them ("rf":1 in its settings broadcast).
#define RF_TYPES 10
const char* const RF_TY_LONG[RF_TYPES] = { "Ambulance", "Rescue", "Evacuation", "Relief Goods", "Hazard: Fire/Sm", "Hazard: Electri", "Hazard: Flood", "Hazard: Earthqu", "Hazard: Landsli", "Hazard: Other" };
const char* const RF_TY_CODE[RF_TYPES] = { "A", "R", "E", "G", "HF", "HE", "HW", "HQ", "HL", "HO" };
#define RF_DEFAULT_ADDRESS "Registered Address"
bool piUnpacks = false;
uint32_t rfPacked = 0, rfFull = 0, rfSaved = 0;   // statistics for /admin/status: short packets, full packets, bytes saved

String rfPad2(int v) { char b[4]; snprintf(b, sizeof(b), "%02d", v); return String(b); }
// Manila time (UTC+8, no daylight saving) of a millisecond timestamp, as the app writes it
String rfClock(uint64_t ms, bool narrow) {
  int64_t s = (int64_t)(ms / 1000ULL) + 8 * 3600;
  int sod = (int)(s % 86400), h = sod / 3600, mi = (sod % 3600) / 60;
  int h12 = h % 12 == 0 ? 12 : h % 12;
  return rfPad2(h12) + ":" + rfPad2(mi) + (narrow ? "\xE2\x80\xAF" : " ") + (h < 12 ? "AM" : "PM");
}
String rfDateClock(uint64_t ms, bool narrow) {
  int64_t days = (int64_t)(ms / 1000ULL + 8 * 3600) / 86400;   // civil date from days (H. Hinnant)
  days += 719468;
  int64_t era = days / 146097, doe = days - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  int d = (int)(doy - (153 * mp + 2) / 5 + 1), m = (int)(mp < 10 ? mp + 3 : mp - 9), y = (int)(yoe + era * 400 + (m <= 2 ? 1 : 0));
  return rfPad2(m) + "/" + rfPad2(d) + "/" + String(y) + " " + rfClock(ms, narrow);
}
uint64_t rfMs(JsonVariant v) {   // a millisecond timestamp (the app's ids and ts), 0 when it is not one
  if (v.is<uint64_t>()) { uint64_t x = v.as<uint64_t>(); return x >= 1000000000000ULL && x < 10000000000000ULL ? x : 0; }
  return 0;
}

// the account the short form is built from: the account book first (what the Pi confirmed), else this node's own list
String rfAccount(const String& id) {
  if (!id.length()) return "";
  String io = id;
  { BookGuard bg; bookEach(bookIdLine, &io); }
  if (io.length() && io[0] == '\x01') return io.substring(1);
  Guard g;
  int n = min(accCount, ACC_CACHE_SIZE);
  for (int i = 0; i < n; i++) if (accIds[i] == id) return accCache[i];
  return "";
}
// the account's value as the packet carries it: non-empty, cut to the app's length ("" = no rule)
String rfAccField(JsonDocument& acc, const char* key, unsigned int cut) {
  String v = String((const char*)(acc[key] | ""));
  if (v.length() > cut) v = v.substring(0, cut);
  return v;
}
bool rfIsSos(JsonDocument& d) { return !d["uid"].isNull() || !d["ty"].isNull() || !d["y"].isNull(); }
String rfAccountIdOf(JsonDocument& d) {
  if (rfIsSos(d)) return String((const char*)(d["uid"] | ""));
  String c = String((const char*)(d["c"] | ""));
  if (c == "p") return String((const char*)(d["sid"] | ""));
  if (c == "emc") return String((const char*)(d["u"] | ""));
  return "";
}

// fills in what a short packet left out. local = this node's own copy of the same record ("" when none): its values
// are the original ones and win. Returns the full record (or the input when it was not short).
String radioUnpack(const String& js, const String& local) {
  JsonDocument d;
  if (deserializeJson(d, js) || !d.is<JsonObject>()) return js;
  if (d["z"].isNull() && d["y"].isNull()) return js;
  JsonDocument loc; bool haveLocal = local.length() && !deserializeJson(loc, local) && loc.is<JsonObject>();
  String z = String((const char*)(d["z"] | ""));
  const char* ek[12]; String ev[12]; int n = 0;
  ek[n] = "z"; ev[n] = ""; n++;
  ek[n] = "y"; ev[n] = ""; n++;
  const char* y = d["y"] | "";
  if (y[0]) for (int i = 0; i < RF_TYPES; i++) if (!strcmp(y, RF_TY_CODE[i])) { ek[n] = "ty"; ev[n] = jsonQuote(RF_TY_LONG[i]); n++; break; }
  bool sos = rfIsSos(d);
  JsonDocument acc; bool haveAcc = false;
  String aid = rfAccountIdOf(d);
  if (aid.length()) { String a = rfAccount(aid); haveAcc = a.length() && !deserializeJson(acc, a); }
  for (unsigned int i = 0; i < z.length() && n < 12; i++) {
    char L = z[i];
    const char* key = sos ? (L == 'n' ? "n" : L == 'c' ? "cn" : L == 'b' ? "b" : L == 'p' ? "p" : L == 'a' ? "ad" : (L == 't' || L == 'T') ? "tm" : L == 's' ? "st" : "")
                          : (L == 'n' ? "n" : L == 'r' ? "r" : (L == 't' || L == 'T') ? "tm" : "");
    if (!key[0]) continue;
    String v; bool have = false;
    if (haveLocal && loc[key].is<const char*>()) { v = loc[key].as<const char*>(); have = true; }   // our own original wins
    else if (sos) {
      if (L == 'n' && haveAcc) v = rfAccField(acc, "n", 20);
      else if (L == 'c' && haveAcc) v = rfAccField(acc, "c", 15);
      else if (L == 'b' && haveAcc) v = rfAccField(acc, "b", 20);
      else if (L == 'p' && haveAcc) v = rfAccField(acc, "pk", 15);
      else if (L == 'a') v = RF_DEFAULT_ADDRESS;
      else if ((L == 't' || L == 'T') && rfMs(d["id"])) v = rfDateClock(rfMs(d["id"]), L == 'T');
      else if (L == 's') v = "pending";
    } else {
      if (L == 'n' && haveAcc) v = rfAccField(acc, "n", 20);
      else if (L == 'r' && haveAcc) v = rfAccField(acc, "r", 12);
      else if ((L == 't' || L == 'T') && rfMs(d["ts"])) v = rfClock(rfMs(d["ts"]), L == 'T');
    }
    if (have || v.length()) { ek[n] = key; ev[n] = jsonQuote(v); n++; }
  }
  bool ok;
  String out = jsonEdit(js, ek, ev, n, ok);
  return ok ? out : js;
}

// the same values? (each top-level value written out by the same library, so numbers compare exactly)
bool rfSameRecord(const String& a, const String& b) {
  JsonDocument x, y;
  if (deserializeJson(x, a) || deserializeJson(y, b) || !x.is<JsonObject>() || !y.is<JsonObject>()) return false;
  JsonObject ox = x.as<JsonObject>(), oy = y.as<JsonObject>();
  if (ox.size() != oy.size()) return false;
  for (JsonPair kv : ox) {
    if (oy[kv.key()].isNull() && !kv.value().isNull()) return false;
    String sa, sb; serializeJson(kv.value(), sa); serializeJson(oy[kv.key()], sb);
    if (sa != sb) return false;
  }
  return true;
}

// an SOS (kind 'S') or chat message ('M') from a phone of this node, as it goes on the radio
String radioPack(const String& full, char kind) {
  if (!piUnpacks || full.length() > 1500) return full;
  JsonDocument d;
  if (deserializeJson(d, full) || !d.is<JsonObject>()) return full;
  if (!d["z"].isNull() || !d["y"].isNull() || !d["action"].isNull() || !d["k"].isNull()) return full;
  int ks[RF_MAX_PAIRS], ve[RF_MAX_PAIRS];
  int np = rfPairs(full, ks, ve);
  if (np <= 0) return full;
  bool sos = kind == 'S';
  if (sos != rfIsSos(d)) return full;
  JsonDocument acc; bool haveAcc = false;
  String aid = rfAccountIdOf(d);
  if (aid.length()) { String a = rfAccount(aid); haveAcc = a.length() && !deserializeJson(acc, a); }
  String z, ycode;
  bool drop[RF_MAX_PAIRS];
  for (int i = 0; i < np; i++) drop[i] = false;
  for (int i = 0; i < np; i++) {
    int qe = full.indexOf('"', ks[i] + 1);
    String key = full.substring(ks[i] + 1, qe);
    JsonVariant v = d[key];
    if (!v.is<const char*>()) continue;
    String val = String(v.as<const char*>());
    char L = 0;
    if (sos) {
      if (key == "n" && haveAcc) { String r = rfAccField(acc, "n", 20); if (r.length() && r == val) L = 'n'; }
      else if (key == "cn" && haveAcc) { String r = rfAccField(acc, "c", 15); if (r.length() && r == val) L = 'c'; }
      else if (key == "b" && haveAcc) { String r = rfAccField(acc, "b", 20); if (r.length() && r == val) L = 'b'; }
      else if (key == "p" && haveAcc) { String r = rfAccField(acc, "pk", 15); if (r.length() && r == val) L = 'p'; }
      else if (key == "ad" && val == RF_DEFAULT_ADDRESS) L = 'a';
      else if (key == "tm" && rfMs(d["id"])) { if (val == rfDateClock(rfMs(d["id"]), false)) L = 't'; else if (val == rfDateClock(rfMs(d["id"]), true)) L = 'T'; }
      else if (key == "st" && val == "pending") L = 's';
      else if (key == "ty") { for (int t = 0; t < RF_TYPES; t++) if (val == RF_TY_LONG[t]) { ycode = RF_TY_CODE[t]; drop[i] = true; break; } }
    } else {
      if (key == "n" && haveAcc) { String r = rfAccField(acc, "n", 20); if (r.length() && r == val) L = 'n'; }
      else if (key == "r" && haveAcc && String((const char*)(d["c"] | "")) == "emc") { String r = rfAccField(acc, "r", 12); if (r.length() && r == val) L = 'r'; }
      else if (key == "tm" && rfMs(d["ts"])) { if (val == rfClock(rfMs(d["ts"]), false)) L = 't'; else if (val == rfClock(rfMs(d["ts"]), true)) L = 'T'; }
    }
    if (L) { drop[i] = true; z += L; }
  }
  if (!z.length() && !ycode.length()) return full;
  String out = "{";
  bool first = true;
  for (int i = 0; i < np; i++) {
    if (drop[i]) continue;
    if (!first) out += ",";
    out += full.substring(ks[i], ve[i]); first = false;
  }
  if (ycode.length()) { out += first ? "" : ","; out += "\"y\":\"" + ycode + "\""; first = false; }
  if (z.length()) { out += first ? "" : ","; out += "\"z\":\"" + z + "\""; }
  out += "}";
  // proof before it goes out: unpacked again (no local copy - only the rules) it must be the original
  if (out.length() >= full.length() || !rfSameRecord(radioUnpack(out, ""), full)) { rfFull++; return full; }
  rfPacked++; rfSaved += full.length() - out.length();
  return out;
}

// a BOOK batch from the Pi: {"action":"BOOK","r":1?,"a":[{compact account + "h": sig}],"x":["id",...]}
// r = start over (the Pi resends everything). The file is rewritten through /book.tmp.
struct BookApply { JsonArray add; JsonArray del; File* out; int n; uint32_t sum; };
bool bookCopyLine(const String& line, void* ctx) {
  BookApply* ap = (BookApply*)ctx;
  String id = bookField(line, 0), sg = bookField(line, 1);
  if (!id.length() || !sg.length()) return true;
  for (JsonVariant v : ap->add) if (id == String((const char*)(v["i"] | ""))) return true;   // replaced
  for (JsonVariant v : ap->del) if (id == String((const char*)(v | ""))) return true;        // removed
  if (ap->n >= BOOK_MAX) return false;
  ap->out->write((const uint8_t*)line.c_str(), line.length()); ap->out->write((uint8_t)'\n');
  ap->n++; ap->sum += (uint32_t)strtoul(sg.c_str(), nullptr, 16);
  return true;
}
void bookApply(const String& payload) {   // loop() only, main lock NOT held
  if (!bookFsOk) return;
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  BookGuard bg;
  File out = LittleFS.open("/book.tmp", "w");
  if (!out) return;
  BookApply ap; ap.add = doc["a"].as<JsonArray>(); ap.del = doc["x"].as<JsonArray>(); ap.out = &out; ap.n = 0; ap.sum = 0;
  if (!(doc["r"] | 0)) bookEach(bookCopyLine, &ap);
  for (JsonVariant v : ap.add) {
    if (ap.n >= BOOK_MAX) break;
    String id = String((const char*)(v["i"] | "")), sg = String((const char*)(v["h"] | ""));
    String st = String((const char*)(v["st"] | "")); st.toLowerCase();
    if (!id.length() || !sg.length() || st != "approved" || id.indexOf('\t') >= 0) continue;
    String js; serializeJson(v, js);
    String line = id + "\t" + sg + "\t" + js;
    out.write((const uint8_t*)line.c_str(), line.length()); out.write((uint8_t)'\n');
    ap.n++; ap.sum += (uint32_t)strtoul(sg.c_str(), nullptr, 16);
  }
  out.close();
  if (LittleFS.exists("/book.txt")) LittleFS.remove("/book.txt");
  if (!LittleFS.rename("/book.tmp", "/book.txt")) return;
  bookN = ap.n; bookSum = ap.sum;
}

void bookQueue(const String& payload) {   // lock held (radio handler)
  if (bookPendingN >= BOOK_PENDING) { for (int i = 1; i < BOOK_PENDING; i++) bookPending[i - 1] = bookPending[i]; bookPendingN--; }
  bookPending[bookPendingN++] = payload;
}

// One reassembler per incoming packet TYPE (ids are picked independently on each board).
ChunkReassembler dataReassembler;
bool lastDataComplete = false;
ChunkReassembler controlReassembler;
ChunkReassembler loginResultReassembler;

void dispatchIncomingFrame(const Frame& f) {   // called with the lock held
  if (!f.valid) return;

  if (f.type == PKT_ACK) {
    if (f.raw) txHandleMaskAck(f.id, f.mask, f.flag); else txHandleAck(f.id, f.idx);
    return;
  }

  if (f.type == PKT_TIME) { netClockFromPi(rxTimeValue, rxTimeAt); return; }

  if (f.type == PKT_POS) {      // positions from the Pi side
    JsonDocument doc;
    if (deserializeJson(doc, f.dat)) return;
    JsonArray arr = doc["p"].as<JsonArray>();
    for (JsonVariant pv : arr) {
      JsonArray p = pv.as<JsonArray>();
      if (p.isNull()) continue;
      const char* h = p[0] | "";
      if (!h[0] || strlen(h) > 8) continue;
      int32_t la5 = p[1] | 0, lo5 = p[2] | 0;
      if (!la5 && !lo5) continue;
      uint32_t age = p[6] | 0; if (age > 3600) age = 3600;
      uint32_t seenAt = millis() - age * 1000UL;
      PosRec* r = posSlot(h);
      if (r->seenAt && r->local && millis() - r->seenAt < age * 1000UL) continue;   // ours is newer
      r->la5 = la5; r->lo5 = lo5; r->acc = p[3] | 0;
      const char* rc = p[4] | "u"; r->rc = rc[0] ? rc[0] : 'u';
      strncpy(r->name, p[5] | "", sizeof(r->name) - 1); r->name[sizeof(r->name) - 1] = 0;
      r->seenAt = seenAt; r->local = false;
    }
    return;
  }

  if (f.type == PKT_DATA_SYNC) {
    String full = dataReassembler.feed(f.id.c_str(), f.idx, f.tot, f.dat);
    if (!full.length()) return;
    lastDataComplete = true;   // the whole broadcast arrived: its last piece gets our ACK (Heltec 1 resends when it does not)

    JsonDocument doc;
    if (deserializeJson(doc, full)) return;
    const char* kind = doc["k"] | "";

    if (strcmp(kind, "acc") == 0) {
      String id = String((const char*)(doc["i"] | ""));
      if (id.length()) cacheUpsert(accCache, accIds, accCount, id, full, ACC_CACHE_SIZE);
    } else if (strcmp(kind, "msg") == 0) {
      String id = String((const char*)(doc["i"] | ""));
      String local;
      if (id.length()) { int n = min(msgCount, MSG_CACHE_SIZE); for (int i = 0; i < n; i++) if (msgIds[i] == id) { local = msgCache[i]; break; } }
      const char* const ek[1] = { "k" }; String ev[1] = { "" }; bool ok;
      String rec = jsonEdit(radioUnpack(full, local), ek, ev, 1, ok);   // short radio form -> whole, without the broadcast's "k"
      if (id.length()) cacheUpsert(msgCache, msgIds, msgCount, id, ok ? rec : full, MSG_CACHE_SIZE);
      upConfirm("m" + id);   // our own message came back: it arrived
    } else if (strcmp(kind, "eme") == 0) {
      String eid = jsonIdOf(doc, "id"), local;
      for (int i = 0; i < emeCount && eid.length(); i++) if (emeCache[i].id == eid) { local = emeCache[i].json; break; }
      emeUpsert(radioUnpack(full, local));     // responders on this node see requests from the whole network
      upConfirm("s" + jsonIdOf(doc, "id"));
    } else if (strcmp(kind, "set") == 0) {
      piUnpacks = (doc["rf"] | 0) >= 1;    // the Pi reads the short radio form (Pi BUILD 2026-10-28c)
      // the Pi's alert settings, broadcast every few seconds. Right after an alert was raised / stopped the
      // broadcast copy can be a little older than the action itself - ignore it for a minute then.
      if (lastAlertActionAt && millis() - lastAlertActionAt < 60000UL) return;
      doc.remove("k");
      settingsMerge(doc);
    }
    return;
  }

  if (f.type == PKT_CONTROL) {
    String full = controlReassembler.feed(f.id.c_str(), f.idx, f.tot, f.dat);
    if (full.length()) {
      JsonDocument doc;
      if (deserializeJson(doc, full)) return;    // only valid JSON may reach the phones' poll replies
      if (!strcmp(doc["action"] | "", "BOOK")) { bookQueue(full); return; }   // accounts for logins: never to the phones
      ctrlPush(full);
      applyAction(doc);
    }
    return;
  }

  if (f.type == PKT_LOGIN_R) {
    String full = loginResultReassembler.feed(f.id.c_str(), f.idx, f.tot, f.dat);
    int li = full.length() ? loginSlotOf(f.id) : -1;
    PendingLogin* pl = li >= 0 ? &logins[li] : nullptr;
    if (full.length()) {
      JsonDocument doc;
      if (!deserializeJson(doc, full)) {
        const char* status = doc["s"] | "DENIED";
        JsonDocument out;
        out["status"] = status;
        if (doc["u"].is<JsonObject>()) {
          String compactUser; serializeJson(doc["u"], compactUser);
          JsonDocument verbose;
          deserializeJson(verbose, compactAccountToVerbose(compactUser));
          out["user"] = verbose;
          // keep the approved account on this node: the next login (this phone or another) needs no radio
          String uid = String((const char*)(doc["u"]["i"] | ""));
          if (uid.length() && strcmp(status, "APPROVED") == 0) cacheUpsert(accCache, accIds, accCount, uid, compactUser, ACC_CACHE_SIZE);
        }
        if (pl && !pl->resolved) {
          pl->resultJson = "";
          serializeJson(out, pl->resultJson);
          pl->resolved = true;
        }
      }
    }
    return;
  }
}

// C/R chunks get an ACK as soon as a chunk arrives (before reassembly) so Heltec 1 can move on to the next chunk.
// A 'D' broadcast is sent piece after piece WITHOUT waiting: it is acknowledged on its LAST piece only, and only when
// every piece arrived (Heltec 1 sends a fresh change again when that ACK does not come, and knows the field is in range). Acknowledging every piece put this node on the air while the next piece was
// already coming - it never heard it, so no broadcast of more than one piece (requests, chat) ever arrived here.
void processLoraRxWithAck() {
  if (!rxFlag) return;
  Frame f = readIncomingFrame();
  bool ackable = f.valid && (f.type == PKT_DATA_SYNC || f.type == PKT_CONTROL || f.type == PKT_LOGIN_R);
  bool last = f.idx >= f.tot;
  if (ackable && !f.raw && f.type != PKT_DATA_SYNC) sendAck(f.id, f.idx);   // old pieces: an ACK for every piece
  if (ackable && !last) holdTxUntil = millis() + NEXT_PIECE_MS;     // more pieces follow at once: do not talk into them
  bool ackData, ackFast = false; uint32_t mask = 0;
  {
    Guard g;
    lastDataComplete = false;
    dispatchIncomingFrame(f);
    ackData = ackable && f.type == PKT_DATA_SYNC && lastDataComplete && (last || f.raw);   // only a broadcast that arrived WHOLE
    if (ackable && f.raw && f.type == PKT_DATA_SYNC && last && !lastDataComplete) {
      // the last piece of a broadcast that is not whole here: Heltec 1 resends a fresh change with the same id, so tell
      // it which pieces are here - already complete (our ACK got lost): all of them; else only the missing ones come again
      if (dataReassembler.lastWasDuplicate) ackData = true;
      else { mask = dataReassembler.maskFor(f.id.c_str()); ackFast = mask != 0; }
    }
    if (ackable && f.raw && f.type != PKT_DATA_SYNC) {
      // fast pieces: ONE answer, after the last piece of the burst or as soon as the payload is complete
      mask = (f.type == PKT_CONTROL ? controlReassembler : loginResultReassembler).maskFor(f.id.c_str());
      ackFast = last || mask == 0xFFFFFFFFUL;
    }
  }
  if (ackData) { if (f.raw) sendMaskAck(f.id, 0xFFFF); else sendAck(f.id, f.idx); }
  if (ackFast) sendMaskAck(f.id, mask);
}

// (The account / message / request arrays used to be built here as one String. They are now streamed out in 4 KB
//  pieces by JsonOut below - see the note there - so nothing builds a 40 KB block of memory any more.)

// ============================ HTTP HELPERS ============================
esp_err_t sendBody(httpd_req_t* req, const char* type, const String& body, const char* status = "200 OK") {
  httpReqCount++;
  httpd_resp_set_status(req, status);
  httpd_resp_set_type(req, type);
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_send(req, body.c_str(), body.length());
}
esp_err_t sendJson(httpd_req_t* req, const String& body, const char* status = "200 OK") { return sendBody(req, "application/json", body, status); }

// ---------------------------------------------------------------- answers built in small pieces (2026-10-31a)
// The account list alone is about 19 KB, the whole /api/bundle around 40 KB. Building that as one String needed
// ~50 KB of the ~200 KB of internal memory this board has, in ever bigger blocks, while three open secure
// connections were already holding ~36 KB each. A new phone's connection then found no 16 KB block left for its
// TLS buffers and was refused or dropped - the second person to log in could not get in. Now every answer goes out
// in ~4 KB pieces and never needs more than that, whatever the number of accounts.
struct JsonOut {
  httpd_req_t* req; String buf; bool started = false, failed = false;
  JsonOut(httpd_req_t* r) : req(r) { buf.reserve(4600); }
  void begin(const char* cache = "no-store") {
    httpReqCount++;
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", cache);
    started = true;
  }
  void add(const String& s) { buf += s; if (buf.length() >= 4096) flush(); }
  void add(const char* s) { buf += s; if (buf.length() >= 4096) flush(); }
  void flush() {
    if (failed || !buf.length()) { buf = ""; return; }
    if (httpd_resp_send_chunk(req, buf.c_str(), buf.length()) != ESP_OK) failed = true;
    buf = "";
  }
  esp_err_t done() {
    flush();
    if (failed) return ESP_FAIL;
    return httpd_resp_send_chunk(req, NULL, 0);
  }
  // The arrays below take the lock only while one record is copied out, never while a piece is pushed over WiFi:
  // a far phone can need seconds for it and the radio must not stand still for that long. A record is always
  // copied whole under the lock, so a change made by the radio task in between cannot cut one in half.
  // (These are methods, not plain functions: the Arduino IDE puts its prototypes above this struct.)
  void accounts() {
    add("[");
    bool first = true; String one; int n;
    { Guard g; n = min(accCount, ACC_CACHE_SIZE); }
    for (int i = 0; i < n; i++) {
      { Guard g; one = (i < min(accCount, ACC_CACHE_SIZE)) ? accCache[i] : String(""); }
      if (!one.length()) continue;
      if (!first) add(","); add(one); first = false;
    }
    add("]");
  }
  void messages() {
    add("[");
    bool first = true; String one; int n, c, start;
    { Guard g; n = min(msgCount, MSG_CACHE_SIZE); c = min(ctrlCount, CTRL_CACHE_SIZE); start = ctrlCount > CTRL_CACHE_SIZE ? ctrlCount % CTRL_CACHE_SIZE : 0; }
    for (int i = 0; i < n; i++) {
      { Guard g; one = (i < min(msgCount, MSG_CACHE_SIZE)) ? msgCache[i] : String(""); }
      if (!one.length()) continue;
      if (!first) add(","); add(one); first = false;
    }
    // actions oldest -> newest (the phones apply them in this order: a STOP_ALERT must come after its RED_ALERT)
    for (int j = 0; j < c; j++) {
      { Guard g; one = ctrlCache[(start + j) % CTRL_CACHE_SIZE]; }
      if (!one.length()) continue;
      if (!first) add(","); add(one); first = false;
    }
    add("]");
  }
  void emergencies() {
    add("[");
    bool first = true; String one; int n;
    { Guard g; emePrune(); n = emeCount; }
    for (int i = 0; i < n; i++) {
      { Guard g; one = (i < emeCount) ? emeCache[i].json : String(""); }
      if (!one.length()) continue;
      if (!first) add(","); add(one); first = false;
    }
    add("]");
  }
};

// a strong validator for the pages and scripts kept in flash: it changes only when the firmware does, so a phone
// that opens the app again is answered with 304 Not Modified (about 150 bytes) instead of the whole 290 KB page
bool noneMatch(httpd_req_t* req, const char* etag) {
  char have[64];
  if (httpd_req_get_hdr_value_str(req, "If-None-Match", have, sizeof(have)) != ESP_OK) return false;
  return strstr(have, etag) != NULL;
}
esp_err_t sendGzAsset(httpd_req_t* req, const char* type, const uint8_t* data, size_t len, const char* cache) {
  httpReqCount++;
  char etag[48];
  snprintf(etag, sizeof(etag), "\"" FW_BUILD "-%u\"", (unsigned)len);
  if (noneMatch(req, etag)) {
    httpd_resp_set_status(req, "304 Not Modified");
    httpd_resp_set_hdr(req, "ETag", etag);
    httpd_resp_set_hdr(req, "Cache-Control", cache);
    return httpd_resp_send(req, NULL, 0);
  }
  httpd_resp_set_type(req, type);
  httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
  httpd_resp_set_hdr(req, "Cache-Control", cache);
  httpd_resp_set_hdr(req, "ETag", etag);
  // in 8 KB pieces: one blocking send of 290 KB would hold the single web task (and so every other phone) for as
  // long as the slowest phone needs, and a stalled connection would be cut off in the middle of the page
  const size_t STEP = 8192;
  for (size_t at = 0; at < len; at += STEP) {
    size_t n = len - at < STEP ? len - at : STEP;
    if (httpd_resp_send_chunk(req, (const char*)data + at, n) != ESP_OK) return ESP_FAIL;   // straight from flash
  }
  return httpd_resp_send_chunk(req, NULL, 0);
}

esp_err_t redirectTo(httpd_req_t* req, const char* location) {
  httpReqCount++;
  httpd_resp_set_status(req, "302 Found");
  httpd_resp_set_hdr(req, "Location", location);
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_send(req, "", 0);
}

// streams a LittleFS file (byte range) in 4 KB pieces
esp_err_t sendFileRange(httpd_req_t* req, const char* path, size_t offset, size_t length, const char* type, bool gz) {
  httpReqCount++;
  File f = LittleFS.open(path, "r");
  if (!f) return sendJson(req, "{\"ok\":false,\"error\":\"not found\"}", "404 Not Found");
  if (length == 0) length = f.size() > offset ? f.size() - offset : 0;
  if (!f.seek(offset)) { f.close(); return sendJson(req, "{\"ok\":false}", "416 Range Not Satisfiable"); }
  httpd_resp_set_type(req, type);
  if (gz) httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
  uint8_t* buf = (uint8_t*)malloc(4096);
  if (!buf) { f.close(); return httpd_resp_send_500(req); }
  esp_err_t res = ESP_OK;
  size_t left = length;
  while (left > 0) {
    size_t n = f.read(buf, min((size_t)4096, left));
    if (n == 0) { res = ESP_FAIL; break; }
    if (httpd_resp_send_chunk(req, (const char*)buf, n) != ESP_OK) { res = ESP_FAIL; break; }
    left -= n;
  }
  free(buf);
  f.close();
  if (res == ESP_OK) res = httpd_resp_send_chunk(req, NULL, 0);
  return res;
}

bool readBody(httpd_req_t* req, String& out, size_t maxLen) {
  size_t total = req->content_len;
  if (total > maxLen) return false;
  out = "";
  out.reserve(total + 1);
  char buf[257];
  size_t got = 0;
  int timeouts = 0;
  while (got < total) {
    int r = httpd_req_recv(req, buf, min((size_t)256, total - got));
    if (r == HTTPD_SOCK_ERR_TIMEOUT) { if (++timeouts > 3) return false; continue; }
    if (r <= 0) return false;
    buf[r] = 0;
    out += buf;
    got += r;
  }
  return true;
}

String urlDecode(const String& s) {
  String o; o.reserve(s.length());
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '+') o += ' ';
    else if (c == '%' && i + 2 < s.length()) { char hx[3] = { s[i + 1], s[i + 2], 0 }; o += (char)strtol(hx, NULL, 16); i += 2; }
    else o += c;
  }
  return o;
}
String queryParam(httpd_req_t* req, const char* key) {
  char q[200], v[100];
  if (httpd_req_get_url_query_str(req, q, sizeof(q)) != ESP_OK) return "";
  if (httpd_query_key_value(q, key, v, sizeof(v)) != ESP_OK) return "";
  return urlDecode(String(v));
}

// ============================ HTTP HANDLERS: app + assets ============================
// "/" = the full command-center app (same as on the Pi, without Firebase); "/lite" = the small field page
esp_err_t hRoot(httpd_req_t* req) {
  if (LittleFS.exists("/index.html")) return sendFileRange(req, "/index.html", 0, 0, "text/html", false);
  return sendGzAsset(req, "text/html", NODE_APP_GZ, sizeof(NODE_APP_GZ), "no-cache");
}
esp_err_t hLite(httpd_req_t* req) { return sendGzAsset(req, "text/html", NODE_PAGE_GZ, sizeof(NODE_PAGE_GZ), "no-cache"); }
// the browser's notification worker (Android Chrome shows notifications only through one) - same file as the Pi's app/amp-sw.js
const char AMP_SW_JS[] PROGMEM = R"AMPSW(/* AMPING notification worker. Android Chrome can only show a notification through a service worker.
   It does nothing else: no caching, no fetch handling (the app always talks to the Pi / node live). */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow ? self.clients.openWindow('/') : null;
  }));
});)AMPSW";
esp_err_t hAmpSw(httpd_req_t* req) {
  httpd_resp_set_hdr(req, "Service-Worker-Allowed", "/");
  return sendBody(req, "application/javascript", String(AMP_SW_JS));
}
esp_err_t hAmpNodeJs(httpd_req_t* req) { return sendGzAsset(req, "application/javascript", AMP_NODE_JS_GZ, sizeof(AMP_NODE_JS_GZ), "no-cache"); }
esp_err_t hLogo(httpd_req_t* req) {
  const NodeLogo* lg = (const NodeLogo*)req->user_ctx;
  httpReqCount++;
  httpd_resp_set_type(req, "image/png");
  httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=86400");
  return httpd_resp_send(req, (const char*)lg->data, lg->len);
}
esp_err_t hLeafletJs(httpd_req_t* req) { return sendGzAsset(req, "application/javascript", LEAFLET_JS_GZ, sizeof(LEAFLET_JS_GZ), "public, max-age=86400"); }
esp_err_t hLeafletCss(httpd_req_t* req) { return sendGzAsset(req, "text/css", LEAFLET_CSS_GZ, sizeof(LEAFLET_CSS_GZ), "public, max-age=86400"); }
esp_err_t hAmpMapJs(httpd_req_t* req) { return sendGzAsset(req, "application/javascript", AMP_MAP_JS_GZ, sizeof(AMP_MAP_JS_GZ), "no-cache"); }

esp_err_t hMapMeta(httpd_req_t* req) {
  if (!LittleFS.exists("/map.json") || !LittleFS.exists("/map.bin")) return sendJson(req, "{\"ok\":false,\"error\":\"no map on this node\"}", "404 Not Found");
  return sendFileRange(req, "/map.json", 0, 0, "application/json", false);
}
// GET /map/part?i=N -> piece N of the map (each piece is its own gzip stream, the browser unpacks it)
esp_err_t hMapPart(httpd_req_t* req) {
  int idx = queryParam(req, "i").toInt();
  File mf = LittleFS.open("/map.json", "r");
  if (!mf) return sendJson(req, "{\"ok\":false}", "404 Not Found");
  JsonDocument filter; filter["parts"] = true;
  JsonDocument meta;
  DeserializationError err = deserializeJson(meta, mf, DeserializationOption::Filter(filter));
  mf.close();
  if (err) return sendJson(req, "{\"ok\":false}", "500 Internal Server Error");
  JsonArray parts = meta["parts"].as<JsonArray>();
  if (idx < 0 || idx >= (int)parts.size()) return sendJson(req, "{\"ok\":false}", "404 Not Found");
  size_t off = parts[idx][0] | 0, len = parts[idx][1] | 0;
  return sendFileRange(req, "/map.bin", off, len, "application/octet-stream", true);
}

// ============================ HTTP HANDLERS: API ============================
esp_err_t hAccounts(httpd_req_t* req) { JsonOut o(req); o.begin(); o.accounts(); return o.done(); }
esp_err_t hMessages(httpd_req_t* req) { JsonOut o(req); o.begin(); o.messages(); return o.done(); }
esp_err_t hEmergencies(httpd_req_t* req) { JsonOut o(req); o.begin(); o.emergencies(); return o.done(); }
esp_err_t hPositions(httpd_req_t* req) { String r = queryParam(req, "r"); String b; { Guard g; b = buildPositionsJson(r); } return sendJson(req, b); }
// GET /api/ping?t=<the phone's clock>: the network clock, for the chat's "received in ..." (see tools/client/chat-fix.js)
esp_err_t hPing(httpd_req_t* req) {
  uint64_t phone = strtoull(queryParam(req, "t").c_str(), NULL, 10);
  char b[96];
  {
    Guard g;
    if (netClockSrc == 0 && phone > 1000000000000ULL) { netClockBase = (int64_t)phone - (int64_t)upMs(); netClockSrc = 1; netClockSetAt = upMs(); }
    snprintf(b, sizeof(b), "{\"ok\":true,\"t\":%llu,\"src\":\"%s\"}", (unsigned long long)netNow(), netClockSrc == 2 ? "pi" : "node");
  }
  return sendJson(req, String(b));
}
esp_err_t hSettings(httpd_req_t* req) { String b; { Guard g; b = settingsJson; } return sendJson(req, b); }

// everything the app polls in one reply (fewer secure connections for the ESP32 to juggle)
esp_err_t hState(httpd_req_t* req) {
  String r = queryParam(req, "r");
  JsonOut o(req); o.begin();
  o.add("{\"m\":"); o.messages();
  o.add(",\"e\":"); o.emergencies();
  String pos; int linkAge;
  { Guard g; pos = buildPositionsJson(r); linkAge = lastPiHeardAt ? (int)((millis() - lastPiHeardAt) / 1000) : -1; }
  o.add(",\"p\":"); o.add(pos);
  o.add(",\"node\":{\"clients\":" + String(connectedClients) + ",\"link\":" + String(linkAge) + ",\"map\":" + (mapInstalled ? "true" : "false") + "}}");
  return o.done();
}

esp_err_t hLogin(httpd_req_t* req) {
  String body;
  if (!readBody(req, body, 1024)) return sendBody(req, "text/plain", "bad body", "400 Bad Request");
  JsonDocument doc;
  if (deserializeJson(doc, body)) return sendBody(req, "text/plain", "bad json", "400 Bad Request");
  String identifier = String((const char*)(doc["identifier"] | ""));
  String pin = String((const char*)(doc["pin"] | ""));
  if (!identifier.length() || !pin.length()) return sendBody(req, "text/plain", "missing fields", "400 Bad Request");
  String found = localLogin(identifier, pin);   // the node's own list, then the account book
  if (found.length()) return sendJson(req, "{\"user\":" + compactAccountToVerbose(found) + "}");
  return sendJson(req, "{}", "404 Not Found");
}

esp_err_t hLoraLogin(httpd_req_t* req) {
  String body;
  if (!readBody(req, body, 1024)) return sendBody(req, "text/plain", "bad body", "400 Bad Request");
  JsonDocument doc;
  if (deserializeJson(doc, body)) return sendBody(req, "text/plain", "bad json", "400 Bad Request");
  String identifier = String((const char*)(doc["identifier"] | ""));
  String pin = String((const char*)(doc["pin"] | ""));
  if (!identifier.length() || !pin.length()) return sendBody(req, "text/plain", "missing fields", "400 Bad Request");
  String local = localLogin(identifier, pin);
  String q;
  {
    Guard g;
    loginsExpire();
    if (local.length()) {
      // the node has this account (the Pi's account book): the answer is in this reply - no radio, no wait. It is
      // also kept (account id only) under its q for an app that still asks /api/lora_result; never in the radio slots
      char qid[CHUNK_ID_LEN];
      makeChunkId(qid);
      JsonDocument la; deserializeJson(la, local);
      LocalAnswer& a = localAnswers[localAnswerNext]; localAnswerNext = (localAnswerNext + 1) % LOCAL_ANSWERS;
      a.q = String(qid); a.accId = String((const char*)(la["i"] | "")); a.at = millis();
      String user = compactAccountToVerbose(local);
      return sendJson(req, "{\"ok\":true,\"q\":\"" + a.q + "\",\"waitS\":" + String(LOGIN_WAIT_MS / 1000) + ",\"local\":true,\"status\":\"APPROVED\",\"user\":" + user + "}");
    }
    // No contact with the command center: answer at once instead of letting the phone count down 150 s for nothing
    // (2026-10-29a). This account is not on this node, so only the Pi could approve it. Only when the absence is
    // certain: nothing heard for over 2 minutes, or nothing at all although this node has been running for 90 s.
    // Just after start-up the first broadcast may simply not have arrived yet - then the login is queued as usual
    // and goes out as soon as the link is there (loginsTick asks again every 20 s).
    int linkAge = lastPiHeardAt ? (int)((millis() - lastPiHeardAt) / 1000) : -1;
    if (linkAge > 120 || (linkAge < 0 && millis() > 90000UL))
      return sendJson(req, "{\"ok\":false,\"noLink\":true,\"linkS\":" + String(linkAge) + ",\"accounts\":" + String(bookN) + "}", "503 Service Unavailable");
    // the same phone asking again (button pressed twice) joins its waiting login instead of starting another
    for (auto& l : logins) if (l.active && !l.resolved && l.ident == identifier && l.pin == pin) { q = l.qid; break; }
    if (!q.length()) {
      PendingLogin* slot = nullptr;
      for (auto& l : logins) if (!l.active) { slot = &l; break; }
      if (!slot) { slot = &logins[0]; for (auto& l : logins) if (l.startedAt < slot->startedAt) slot = &l; }   // all busy: the oldest makes room
      char qid[CHUNK_ID_LEN];
      makeChunkId(qid);
      slot->active = true; slot->qid = String(qid); slot->ident = identifier; slot->pin = pin;
      slot->startedAt = slot->lastSentAt = millis(); slot->resolved = false; slot->resultJson = "";
      q = slot->qid;
      enqueueLoginQuery(q, identifier, pin);
    }
  }
  return sendJson(req, "{\"ok\":true,\"q\":\"" + q + "\",\"waitS\":" + String(LOGIN_WAIT_MS / 1000) + "}");
}

esp_err_t hLoraResult(httpd_req_t* req) {
  String q = queryParam(req, "q");
  String out = "[]";
  String localId;
  if (q.length()) {
    Guard g;
    for (auto& a : localAnswers) if (a.q.length() && a.q == q) { if (millis() - a.at < LOGIN_WAIT_MS) localId = a.accId; a.q = ""; a.accId = ""; break; }
  }
  if (localId.length()) {
    String c = localAccountById(localId);
    if (c.length()) return sendJson(req, "[{\"status\":\"APPROVED\",\"user\":" + compactAccountToVerbose(c) + "}]");
  }
  {
    Guard g;
    loginsExpire();
    PendingLogin* hit = nullptr;
    if (q.length()) { int i = loginSlotOf(q); if (i >= 0) hit = &logins[i]; }
    else {   // an older app without q
      for (int i = 0; i < LOGIN_SLOTS; i++) if (logins[i].active && logins[i].resolved) { hit = &logins[i]; break; }
    }
    if (hit && hit->resolved) { out = "[" + hit->resultJson + "]"; hit->active = false; hit->resultJson = ""; }
  }
  return sendJson(req, out);
}

// a login nobody answered yet: its question goes out again every 20 s (a far node loses packets), until 2.5 minutes
void loginsTick() {
  Guard g;
  loginsExpire();
  for (auto& l : logins) {
    if (!l.active || l.resolved || millis() - l.lastSentAt < LOGIN_RESEND_MS) continue;
    if (tx.active && tx.id == l.qid) { l.lastSentAt = millis(); continue; }   // being sent right now
    l.lastSentAt = millis();
    enqueueLoginQuery(l.qid, l.ident, l.pin);
  }
}

// One browser-side chunk of a chat / SOS submission; once complete it is relayed over LoRa
// AND kept here so other phones on this node see it on their next poll.
ChunkReassembler httpMsgReassembler;
ChunkReassembler httpSosReassembler;
ChunkReassembler httpUpdReassembler;

// The app sends every action twice (to /api/update_sos AND /api/send_msg): relay + apply each payload once.
struct RecentPayload { uint32_t hash = 0; uint32_t at = 0; };
RecentPayload recentPayloads[12]; int recentNext = 0;
uint32_t payloadHash(const String& s) { uint32_t h = 0x811c9dc5; for (unsigned i = 0; i < s.length(); i++) { h ^= (uint8_t)s[i]; h *= 0x01000193; } return h; }
bool seenRecently(const String& full) {
  uint32_t h = payloadHash(full);
  for (auto& r : recentPayloads) if (r.at && r.hash == h && millis() - r.at < 60000UL) return true;
  recentPayloads[recentNext].hash = h; recentPayloads[recentNext].at = millis(); recentNext = (recentNext + 1) % 12;
  return false;
}

// One complete payload from a phone (chat, action or SOS): show it on this node at once, and relay it to the Pi.
void acceptFromPhone(char kind, const String& id, const String& full) {
  if (seenRecently(full)) return;
  JsonDocument parsed;
  if (deserializeJson(parsed, full)) return;
  if (kind == 'S') { emeUpsert(full); String air = radioPack(full, 'S'); enqueueOutgoing(PKT_SOS, id, air); upTrack(PKT_SOS, id, "s" + jsonIdOf(parsed, "id"), air); return; }
  if (!parsed["action"].isNull()) {            // dispatch / complete / triage / account / red alert ...
    ctrlPush(full);
    applyAction(parsed);
    enqueueOutgoing(PKT_MESSAGE, id, full);      // the Pi's message handler understands actions
    return;
  }
  if (kind == 'U') return;                     // update_sos carries actions only
  cacheUpsert(msgCache, msgIds, msgCount, String((const char*)(parsed["i"] | id.c_str())), full, MSG_CACHE_SIZE);
  String air = radioPack(full, 'M');
  enqueueOutgoing(PKT_MESSAGE, id, air);
  upTrack(PKT_MESSAGE, id, "m" + String((const char*)(parsed["i"] | "")), air);
}

esp_err_t handleUploadChunk(httpd_req_t* req, char kind) {
  String body;
  if (!readBody(req, body, 2048)) return sendBody(req, "text/plain", "bad body", "400 Bad Request");
  JsonDocument doc;
  if (deserializeJson(doc, body)) return sendBody(req, "text/plain", "bad json", "400 Bad Request");

  if (!(doc["isChk"] | false) && doc["idx"].isNull()) {
    // some actions are posted whole, not in chunks: {"action":"UPDATE_SOS","id":..,"st":..}
    if (!doc["action"].isNull() || !doc["ty"].isNull()) {
      String full; serializeJson(doc, full);
      if (full.length() <= 16 * CHUNK_DATA_LEN) {
        char cid[CHUNK_ID_LEN]; makeChunkId(cid);
        Guard g;
        acceptFromPhone(kind, String(cid), full);
      }
    }
    return sendBody(req, "text/plain", "ok");
  }

  String id = String((const char*)(doc["id"] | ""));
  uint8_t idx = doc["idx"] | 0;
  uint8_t tot = doc["tot"] | 0;
  String dat = String((const char*)(doc["dat"] | ""));
  if (id.length() && idx && tot) {
    Guard g;
    ChunkReassembler& reassembler = (kind == 'S') ? httpSosReassembler : (kind == 'U') ? httpUpdReassembler : httpMsgReassembler;
    String full = reassembler.feed(id.c_str(), idx, tot, dat);
    if (full.length()) acceptFromPhone(kind, id.substring(0, 8), full);
  }
  return sendBody(req, "text/plain", "ok");
}
esp_err_t hSendMsg(httpd_req_t* req) { return handleUploadChunk(req, 'M'); }
esp_err_t hSendSos(httpd_req_t* req) { return handleUploadChunk(req, 'S'); }
esp_err_t hUpdateSos(httpd_req_t* req) { return handleUploadChunk(req, 'U'); }

// GET /api/bundle?v=<last version>&r=<role>: everything the full app polls, in one reply; when nothing
// changed since version v only the live positions are sent (a few hundred bytes)
esp_err_t hBundle(httpd_req_t* req) {
  uint32_t v = (uint32_t)queryParam(req, "v").toInt();
  String r = queryParam(req, "r");
  String node, pos, settings;
  uint32_t ver;
  bool same;
  {
    Guard g;
    emePrune();
    ver = dataVer;
    same = (v && v == dataVer);
    int linkAge = lastPiHeardAt ? (int)((millis() - lastPiHeardAt) / 1000) : -1;
    node = "{\"clients\":" + String(connectedClients) + ",\"link\":" + String(linkAge) + ",\"map\":" + (mapInstalled ? "true" : "false") + ",\"sig\":" + signalJson() + ",\"fw\":\"" FW_BUILD "\"}";
    pos = buildPositionsJson(r);
    if (!same) settings = settingsJson;
  }
  JsonOut o(req); o.begin();
  if (same) {
    o.add("{\"v\":" + String(ver) + ",\"same\":true,\"p\":" + pos + ",\"node\":" + node + "}");
    return o.done();
  }
  // the full answer (about 40 KB with a classroom's worth of accounts) goes out in 4 KB pieces, so the board never
  // needs a big block of memory for it - that block is what a new phone's secure connection needs for its own
  // buffers, and when it was missing the next person simply could not get in (2026-10-31a)
  o.add("{\"v\":" + String(ver));
  o.add(",\"a\":"); o.accounts();
  o.add(",\"m\":"); o.messages();
  o.add(",\"e\":"); o.emergencies();
  o.add(",\"s\":"); o.add(settings);
  o.add(",\"p\":"); o.add(pos);
  o.add(",\"node\":"); o.add(node); o.add("}");
  return o.done();
}
// settings changed by an admin on this node (the app also sends the matching action through send_msg)
esp_err_t hSyncSettings(httpd_req_t* req) {
  String body;
  if (readBody(req, body, 4000)) {
    JsonDocument doc;
    if (!deserializeJson(doc, body) && doc.is<JsonObject>()) { Guard g; settingsMerge(doc); lastAlertActionAt = millis(); }
  }
  return sendJson(req, "{\"ok\":true}");
}
// the rest of the app's Pi-only calls: answered so the app never waits on them
esp_err_t hOkJson(httpd_req_t* req) { return sendJson(req, "{\"ok\":true,\"node\":true}"); }
esp_err_t hEmptyObj(httpd_req_t* req) { return sendJson(req, "{}"); }
esp_err_t hNoPhoto(httpd_req_t* req) { return sendJson(req, "{\"ok\":false,\"error\":\"ID photos are kept on the command center (Pi)\"}", "404 Not Found"); }
esp_err_t hNoAi(httpd_req_t* req) { return sendJson(req, "{\"ok\":false,\"error\":\"The AI guide runs on the command center (Pi) only\"}", "503 Service Unavailable"); }

// POST /api/pos {"h","n","r","la","lo","a"} - a responder, or someone with an open request
esp_err_t hPos(httpd_req_t* req) {
  String body;
  if (!readBody(req, body, 512)) return sendJson(req, "{\"ok\":false}", "400 Bad Request");
  JsonDocument doc;
  if (deserializeJson(doc, body)) return sendJson(req, "{\"ok\":false}", "400 Bad Request");
  const char* h = doc["h"] | "";
  double la = doc["la"] | 0.0, lo = doc["lo"] | 0.0;
  size_t hl = strlen(h);
  if (!hl || hl > 8 || (la == 0 && lo == 0) || la < -90 || la > 90 || lo < -180 || lo > 180) return sendJson(req, "{\"ok\":false,\"error\":\"bad position\"}", "400 Bad Request");
  for (size_t i = 0; i < hl; i++) if (!isalnum((unsigned char)h[i])) return sendJson(req, "{\"ok\":false}", "400 Bad Request");
  {
    Guard g;
    PosRec* r = posSlot(h);
    r->la5 = (int32_t)lround(la * 1e5); r->lo5 = (int32_t)lround(lo * 1e5);
    r->acc = (uint16_t)min(9999.0, max(0.0, (double)(doc["a"] | 0.0)));
    r->rc = roleCode(doc["r"] | "user");
    const char* n = doc["n"] | "User";
    size_t k = 0; for (size_t i = 0; n[i] && k < sizeof(r->name) - 1; i++) if ((unsigned char)n[i] >= 32 && (unsigned char)n[i] < 127 && n[i] != '"' && n[i] != '\\') r->name[k++] = n[i];
    r->name[k] = 0;
    uint32_t ag = doc["ag"] | 0; if (ag > 600) ag = 600;      // seconds since the phone's GPS fix
    r->seenAt = millis() - ag * 1000UL; r->local = true;
  }
  return sendJson(req, "{\"ok\":true}");
}

// ============================ HTTP HANDLERS: admin (map / page upload) ============================
const char ADMIN_PAGE[] PROGMEM = R"ADMINPAGE(<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AMPING node admin</title><style>body{font:15px system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0}main{max-width:560px;margin:0 auto;padding:18px}
.c{background:#1e293b;border-radius:12px;padding:14px 16px;margin:12px 0}input,button{font:inherit}input[type=password],input[type=file]{width:100%;margin:6px 0 10px;padding:9px;border-radius:8px;border:1px solid #334155;background:#0b1220;color:#e2e8f0;box-sizing:border-box}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-weight:700;margin:4px 6px 0 0}button.r{background:#b91c1c}.k{color:#94a3b8;font-size:13px}progress{width:100%;height:16px}</style></head><body><main>
<h2>AMPING field node - admin</h2><div class="c" id="st">Loading status...</div>
<div class="c"><b>Admin password</b><input type="password" id="pw" placeholder="ADMIN_PASSWORD in the firmware"></div>
<div class="c"><b>Offline map</b><div class="k">Choose <b>node-map.amp</b> (firmware/heltec2_field_node/node-map.amp). Takes about a minute.</div>
<input type="file" id="mapf" accept=".amp"><button onclick="up('map','mapf')">Upload map</button><button class="r" onclick="del('map')">Remove map</button></div>
<div class="c"><b>Replacement app page</b> (optional)<div class="k">Serve your own .html instead of the built-in app. Remove it to go back.</div>
<input type="file" id="pagef" accept=".html,.htm"><button onclick="up('page','pagef')">Upload page</button><button class="r" onclick="del('page')">Remove page</button></div>
<div class="c"><progress id="pg" max="100" value="0"></progress><div id="msg" class="k"></div></div>
<script>
function st(){fetch('/admin/status').then(function(r){return r.json()}).then(function(s){document.getElementById('st').innerHTML='Storage: <b>'+(s.fsUsed/1e6).toFixed(2)+' / '+(s.fsTotal/1e6).toFixed(2)+' MB</b> used<br>Map: <b>'+(s.map?('installed, built '+s.map.nodeBuilt+', area '+s.map.bbox.join(', ')):'not installed')+'</b><br>Replacement page: '+(s.page?'yes':'no')+'<br>Phones connected: '+s.clients+' &middot; LoRa link: '+(s.link<0?'never heard':s.link+' s ago')+'<br>Free memory: '+(s.heapFree/1024|0)+' KB'+(s.psramFree?' + PSRAM '+(s.psramFree/1024|0)+' KB':' (no PSRAM)')}).catch(function(){document.getElementById('st').textContent='status unavailable'})}
function k(){return encodeURIComponent(document.getElementById('pw').value)}
function up(what,id){var f=document.getElementById(id).files[0];if(!f){alert('Choose a file first');return}var x=new XMLHttpRequest();x.open('POST','/admin/upload?what='+what+'&key='+k());
x.upload.onprogress=function(e){if(e.lengthComputable)document.getElementById('pg').value=e.loaded/e.total*100};
x.onload=function(){document.getElementById('msg').textContent=x.status+' '+x.responseText;st()};x.onerror=function(){document.getElementById('msg').textContent='Upload failed (connection lost) - try again'};
document.getElementById('msg').textContent='Uploading '+(f.size/1e6).toFixed(2)+' MB...';x.send(f)}
function del(what){if(!confirm('Remove the '+what+'?'))return;fetch('/admin/delete?what='+what+'&key='+k(),{method:'POST'}).then(function(r){return r.text()}).then(function(t){document.getElementById('msg').textContent=t;st()})}
st();
</script></main></body></html>)ADMINPAGE";

esp_err_t hAdmin(httpd_req_t* req) {
  httpReqCount++;
  httpd_resp_set_type(req, "text/html");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_send(req, ADMIN_PAGE, strlen(ADMIN_PAGE));
}

// ============================ DHCP: the node's own address server ============================
// Every phone needs an address (192.168.4.x) before it can open anything. The ESP32 Arduino core 2.0.17 is compiled
// with CONFIG_LWIP_DHCPS_MAX_STATION_NUM 8: its address server keeps 8 phones, and with more its once-a-minute timer
// (dhcps_coarse_tmr) forgets the OLDEST phone while that phone still uses its address - the next phone to join can
// then be given the SAME address and both lose the connection. The hotspot itself takes AP_MAX_CLIENTS (10), and
// phones behind a WiFi repeater (the EAP110) need addresses too without counting as hotspot stations.
// This server remembers DH_TABLE phones, never hands out an address a phone still holds, and gives each phone the
// same address every time it comes back. It runs inside the network task (lwIP raw UDP), so it uses no socket.
// The part between the DHCP-CORE markers is plain C: test/fil/dhcp-test.js compiles it alone and checks it.
/*DHCP-CORE-BEGIN*/
#define DH_FIRST      2        // addresses handed out: 192.168.4.2 ...
#define DH_LAST       250      // ... 192.168.4.250
#define DH_TABLE      64       // phones remembered (each keeps its address): 10 on the hotspot + repeater + recent
#define DH_LEASE_S    7200     // 2 hours (the core's default too); phones renew after 1 hour
#define DH_OFFER_S    60       // an offer that is not taken is held this long
#define DH_DECLINE_S  600      // an address a phone found already in use is not handed out for 10 minutes
#define DH_EMPTY      0
#define DH_OFFERED    1
#define DH_BOUND      2
#define DH_BLOCKED    3
#define DH_STR2(x) #x
#define DH_STR(x) DH_STR2(x)
struct DhEntry { uint8_t mac[6]; uint8_t host; uint8_t state; uint32_t until; uint32_t seen; };
DhEntry dhT[DH_TABLE];
uint8_t dhNet[4] = { 192, 168, 4, 1 };          // the node's own address: server id, router and DNS (a /24 network)
uint8_t dhNext = DH_FIRST;                      // where the search for a new address starts (round robin)
bool (*dhAssocFn)(const uint8_t* mac) = 0;      // is this phone on the hotspot right now?
uint32_t dhOffers = 0, dhAcks = 0, dhNaks = 0, dhDrops = 0, dhEvicted = 0;

bool dhAssoc(const uint8_t* mac) { return dhAssocFn ? dhAssocFn(mac) : false; }
int dhFindMac(const uint8_t* mac) {
  for (int i = 0; i < DH_TABLE; i++)
    if ((dhT[i].state == DH_OFFERED || dhT[i].state == DH_BOUND) && memcmp(dhT[i].mac, mac, 6) == 0) return i;
  return -1;
}
int dhFindHost(int host) {
  for (int i = 0; i < DH_TABLE; i++) if (dhT[i].state != DH_EMPTY && dhT[i].host == host) return i;
  return -1;
}
// may this entry's address go to somebody else? Only when its time is up AND the phone is not on the hotspot.
bool dhStale(int i, uint32_t now) {
  if (dhT[i].state == DH_EMPTY) return true;
  if ((int32_t)(now - dhT[i].until) < 0) return false;
  if (dhT[i].state == DH_BLOCKED) return true;
  return !dhAssoc(dhT[i].mac);
}
// 192.168.4.x -> x when x may be handed out, else 0
int dhHostOf(const uint8_t* ip) {
  if (ip[0] != dhNet[0] || ip[1] != dhNet[1] || ip[2] != dhNet[2]) return 0;
  if (ip[3] < DH_FIRST || ip[3] > DH_LAST || ip[3] == dhNet[3]) return 0;
  return ip[3];
}
// an address for a new phone: the one it asks for if nobody has it, else the next unused one, else the oldest stale one
int dhNewHost(uint32_t now, int prefer) {
  if (prefer && dhFindHost(prefer) < 0) return prefer;
  int span = DH_LAST - DH_FIRST + 1;
  for (int k = 0; k < span; k++) {
    int h = DH_FIRST + ((dhNext - DH_FIRST + k) % span);
    if (h == dhNet[3] || dhFindHost(h) >= 0) continue;
    dhNext = (uint8_t)(h + 1 > DH_LAST ? DH_FIRST : h + 1);
    return h;
  }
  int best = -1;
  for (int i = 0; i < DH_TABLE; i++) if (dhStale(i, now) && (best < 0 || (int32_t)(dhT[i].seen - dhT[best].seen) < 0)) best = i;
  return best < 0 ? 0 : dhT[best].host;
}
// a table row for this phone: its own, else an empty one, else the stale one seen longest ago (-1 = all in use)
int dhSlotFor(const uint8_t* mac, uint32_t now) {
  int i = dhFindMac(mac);
  if (i >= 0) return i;
  for (i = 0; i < DH_TABLE; i++) if (dhT[i].state == DH_EMPTY) return i;
  int best = -1;
  for (i = 0; i < DH_TABLE; i++) if (dhStale(i, now) && (best < 0 || (int32_t)(dhT[i].seen - dhT[best].seen) < 0)) best = i;
  if (best >= 0) dhEvicted++;
  return best;
}
// record mac -> host. The caller has checked that nobody else holds host (or only a stale entry does).
int dhPut(const uint8_t* mac, int host, int state, uint32_t until, uint32_t now) {
  int i = dhSlotFor(mac, now);
  if (i < 0) return -1;
  int j = dhFindHost(host);
  if (j >= 0 && j != i) dhT[j].state = DH_EMPTY;   // a stale holder of this address is forgotten
  memcpy(dhT[i].mac, mac, 6);
  dhT[i].host = (uint8_t)host; dhT[i].state = (uint8_t)state; dhT[i].until = until; dhT[i].seen = now;
  return i;
}
int dhOpt(uint8_t* out, int p, int code, int len, const uint8_t* v) {
  out[p] = (uint8_t)code; out[p + 1] = (uint8_t)len; memcpy(out + p + 2, v, len); return p + 2 + len;
}
int dhOpt32(uint8_t* out, int p, int code, uint32_t v) {
  uint8_t b[4] = { (uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v };
  return dhOpt(out, p, code, 4, b);
}
// One DHCP message in (in, len) -> the answer in out (room for 548 bytes). Returns its length, 0 = no answer.
int dhcpHandle(const uint8_t* in, int len, uint8_t* out, uint32_t now) {
  if (len < 240 || in[0] != 1 || in[1] != 1 || in[2] != 6) { dhDrops++; return 0; }
  if (in[236] != 99 || in[237] != 130 || in[238] != 83 || in[239] != 99) { dhDrops++; return 0; }
  const uint8_t* mac = in + 28;
  if (!(mac[0] | mac[1] | mac[2] | mac[3] | mac[4] | mac[5]) || (mac[0] & 1)) { dhDrops++; return 0; }
  int type = 0; bool hasReq = false, hasSrv = false; uint8_t reqIp[4] = { 0, 0, 0, 0 }, srv[4] = { 0, 0, 0, 0 };
  for (int p = 240; p < len;) {
    int o = in[p];
    if (o == 0) { p++; continue; }
    if (o == 255 || p + 1 >= len) break;
    int l = in[p + 1];
    if (p + 2 + l > len) break;
    const uint8_t* v = in + p + 2;
    if (o == 53 && l >= 1) type = v[0];
    else if (o == 50 && l == 4) { memcpy(reqIp, v, 4); hasReq = true; }
    else if (o == 54 && l == 4) { memcpy(srv, v, 4); hasSrv = true; }
    p += 2 + l;
  }
  if (!type) { dhDrops++; return 0; }               // plain BOOTP (no DHCP message type): not served
  const uint8_t* ci = in + 12;
  bool hasCi = (ci[0] | ci[1] | ci[2] | ci[3]) != 0;
  int me = dhFindMac(mac), host = 0, reply = 0;     // reply: 2 OFFER, 5 ACK, 6 NAK
  bool echoCi = false, lease = true;
  if (type == 1) {                                  // DISCOVER: the phone looks for an address
    if (me >= 0) host = dhT[me].host;
    else host = dhNewHost(now, hasReq ? dhHostOf(reqIp) : 0);
    if (!host) { dhDrops++; return 0; }
    bool bound = me >= 0 && dhT[me].state == DH_BOUND && (int32_t)(now - dhT[me].until) < 0;
    uint32_t until = bound ? dhT[me].until : now + DH_OFFER_S;
    if (dhPut(mac, host, bound ? DH_BOUND : DH_OFFERED, until, now) < 0) { dhDrops++; return 0; }
    reply = 2;
  } else if (type == 3) {                           // REQUEST: take an offer, come back with an old address, or renew
    if (hasSrv && memcmp(srv, dhNet, 4) != 0) {     // it took another server's offer
      if (me >= 0 && dhT[me].state == DH_OFFERED) dhT[me].state = DH_EMPTY;
      return 0;
    }
    const uint8_t* want = hasReq ? reqIp : (hasCi ? ci : 0);
    if (!want) { dhDrops++; return 0; }
    host = dhHostOf(want);
    if (hasSrv) reply = (host && me >= 0 && dhT[me].host == host) ? 5 : 6;
    else if (!host) reply = 6;                      // an address from another network (the phone's last WiFi)
    else { int o = dhFindHost(host); reply = (o < 0 || o == me || dhStale(o, now)) ? 5 : 6; }
    if (reply == 5 && dhPut(mac, host, DH_BOUND, now + DH_LEASE_S, now) < 0) reply = 6;
    echoCi = hasCi;
  } else if (type == 4) {                           // DECLINE: the phone found the address already in use
    if (me >= 0 && hasReq && dhT[me].host == dhHostOf(reqIp)) {
      memset(dhT[me].mac, 0, 6); dhT[me].state = DH_BLOCKED; dhT[me].until = now + DH_DECLINE_S;
    }
    return 0;
  } else if (type == 7) {                           // RELEASE: the address is free again (the phone keeps first claim)
    if (me >= 0 && hasCi && dhT[me].host == dhHostOf(ci)) { dhT[me].until = now; dhT[me].seen = now; }
    return 0;
  } else if (type == 8) {                           // INFORM: it has an address, wants the settings
    if (!hasCi) return 0;
    reply = 5; echoCi = true; lease = false; host = 0;
  } else return 0;

  memset(out, 0, 548);
  out[0] = 2; out[1] = 1; out[2] = 6;
  memcpy(out + 4, in + 4, 4);                       // xid
  memcpy(out + 10, in + 10, 2);                     // flags (the broadcast bit)
  if (echoCi) memcpy(out + 12, ci, 4);
  if (reply != 6 && host) { out[16] = dhNet[0]; out[17] = dhNet[1]; out[18] = dhNet[2]; out[19] = (uint8_t)host; }
  memcpy(out + 24, in + 24, 4);                     // giaddr
  memcpy(out + 28, in + 28, 16);                    // chaddr
  out[236] = 99; out[237] = 130; out[238] = 83; out[239] = 99;
  uint8_t t = (uint8_t)reply;
  int p = dhOpt(out, 240, 53, 1, &t);
  p = dhOpt(out, p, 54, 4, dhNet);
  if (reply != 6) {
    if (lease) { p = dhOpt32(out, p, 51, DH_LEASE_S); p = dhOpt32(out, p, 58, DH_LEASE_S / 2); p = dhOpt32(out, p, 59, DH_LEASE_S / 8 * 7); }
    const uint8_t mask[4] = { 255, 255, 255, 0 }, bc[4] = { dhNet[0], dhNet[1], dhNet[2], 255 };
    p = dhOpt(out, p, 1, 4, mask);
    p = dhOpt(out, p, 3, 4, dhNet);                 // router
    p = dhOpt(out, p, 6, 4, dhNet);                 // DNS: the node answers every name (sign-in-to-network page)
    p = dhOpt(out, p, 28, 4, bc);
  }
  out[p++] = 255;
  if (p < 300) p = 300;                             // the minimum BOOTP size some phones insist on
  if (reply == 2) dhOffers++; else if (reply == 5) dhAcks++; else dhNaks++;
  return p;
}
int dhBoundCount(uint32_t now) {
  int n = 0;
  for (int i = 0; i < DH_TABLE; i++) if (dhT[i].state == DH_BOUND && (int32_t)(now - dhT[i].until) < 0) n++;
  return n;
}
/*DHCP-CORE-END*/

udp_pcb* dhPcb = NULL;
volatile int dhState = 0;                         // 0 not started, 1 running, -1 could not start
uint32_t dhCoreStops = 0;                         // times the core's own server had come back and was stopped
int dhTries = 0;                                  // failed starts of ours
wifi_sta_list_t dhSta;                            // the hotspot's stations, read once per message
uint8_t dhIn[600], dhOut[548];
uint32_t dhNow() { return (uint32_t)(esp_timer_get_time() / 1000000LL); }
bool dhInStaList(const uint8_t* mac) {
  if (dhSta.num < 0) return true;                 // unknown: treat the phone as present (its address is kept)
  for (int i = 0; i < dhSta.num; i++) if (memcmp(dhSta.sta[i].mac, mac, 6) == 0) return true;
  return false;
}
void dhRecv(void* arg, struct udp_pcb* pcb, struct pbuf* p, const ip_addr_t* addr, u16_t port) {
  if (!p) return;
  int n = p->tot_len > sizeof(dhIn) ? (int)sizeof(dhIn) : (int)p->tot_len;
  pbuf_copy_partial(p, dhIn, (u16_t)n, 0);
  pbuf_free(p);
  if (esp_wifi_ap_get_sta_list(&dhSta) != ESP_OK) dhSta.num = -1;
  int r = dhcpHandle(dhIn, n, dhOut, dhNow());
  if (r <= 0) return;
  struct pbuf* q = pbuf_alloc(PBUF_TRANSPORT, (u16_t)r, PBUF_RAM);
  if (!q) return;
  pbuf_take(q, dhOut, (u16_t)r);
  ip_addr_t bc; IP_ADDR4(&bc, 255, 255, 255, 255);  // the phone has no address yet: answer to everybody (as the core does)
  struct netif* nif = ip_current_input_netif();
  if (nif) udp_sendto_if(pcb, q, &bc, 68, nif); else udp_sendto(pcb, q, &bc, 68);
  pbuf_free(q);
}
void dhStartCb(void* ctx) {                       // runs in the network task
  if (!dhPcb) {
    udp_pcb* u = udp_new();
    if (!u) { dhState = -1; return; }
    ip_set_option(u, SOF_BROADCAST);
    if (udp_bind(u, IP4_ADDR_ANY, 67) != ERR_OK) { udp_remove(u); dhState = -1; return; }
    udp_recv(u, dhRecv, NULL);
    dhPcb = u;
  }
  dhState = 1;
}
// Called after the hotspot starts and every 15 s: the core's server off, ours on. If ours cannot start, the core's
// server is switched back on, so phones always get an address (8 at most then, and the boot log says so).
void dhcpTakeOver() {
  esp_netif_t* ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  if (!ap) return;
  esp_netif_ip_info_t ii;
  if (esp_netif_get_ip_info(ap, &ii) == ESP_OK && ii.ip.addr) {
    uint32_t a = ii.ip.addr;                      // lwIP keeps it in network order: the first byte is the lowest
    dhNet[0] = a & 255; dhNet[1] = (a >> 8) & 255; dhNet[2] = (a >> 16) & 255; dhNet[3] = (a >> 24) & 255;
  }
  if (dhState == -1 && dhTries >= 3) return;      // gave up after 3 tries: the core's server stays on
  esp_netif_dhcp_status_t st;
  if (esp_netif_dhcps_get_status(ap, &st) == ESP_OK && st == ESP_NETIF_DHCP_STARTED) {
    esp_netif_dhcps_stop(ap);
    if (dhState == 1) { dhCoreStops++; bootLog("own DHCP: the core's address server had come back - stopped it"); }
  }
  if (dhState != 1) {
    dhState = 0;
    dhAssocFn = dhInStaList;
    if (tcpip_callback(dhStartCb, NULL) != ERR_OK) dhState = -1;
    for (int i = 0; i < 100 && dhState == 0; i++) delay(5);
    if (dhState == 1) bootLog("own DHCP running (" DH_STR(DH_TABLE) " phones, 192.168.4." DH_STR(DH_FIRST) "-" DH_STR(DH_LAST) ")");
  }
  if (dhState != 1) {
    dhTries++;
    esp_netif_dhcps_start(ap);
    bootLog("own DHCP could not start - the core's address server is on (8 phones at most)");
  }
}

esp_err_t hAdminStatus(httpd_req_t* req) {
  String mapMeta = "null";
  if (LittleFS.exists("/map.json")) {
    File f = LittleFS.open("/map.json", "r");
    JsonDocument filter; filter["nodeBuilt"] = true; filter["bbox"] = true; filter["gzSize"] = true;
    JsonDocument m;
    if (f && !deserializeJson(m, f, DeserializationOption::Filter(filter))) { mapMeta = ""; serializeJson(m, mapMeta); }
    if (f) f.close();
  }
  int linkAge = lastPiHeardAt ? (int)((millis() - lastPiHeardAt) / 1000) : -1;
  String b = "{\"fsTotal\":" + String((uint32_t)LittleFS.totalBytes()) + ",\"fsUsed\":" + String((uint32_t)LittleFS.usedBytes()) +
             ",\"map\":" + mapMeta + ",\"page\":" + (LittleFS.exists("/index.html") ? "true" : "false") +
             ",\"clients\":" + String(connectedClients) + ",\"link\":" + String(linkAge) +
             ",\"heapFree\":" + String((uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL)) + ",\"psramFree\":" + String((uint32_t)(psramFound() ? heap_caps_get_free_size(MALLOC_CAP_SPIRAM) : 0)) +
             ",\"heapMin\":" + String((uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)) + ",\"heapBiggest\":" + String((uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)) +
             ",\"starts\":" + String(bootNo) + ",\"unexpectedRestarts\":" + String(unexpectedRestarts) + ",\"lastStart\":\"" + String(lastStartWhy) + "\"" +
             ",\"uptimeS\":" + String(millis() / 1000) + ",\"lora\":" + (loraOk ? "true" : "false") + ",\"sig\":" + signalJson() +
             ",\"book\":" + String(bookN) + ",\"bookAsks\":" + String(bookAsks) + ",\"up\":" + String(upWaiting()) + ",\"short\":{\"on\":" + (piUnpacks ? "true" : "false") + ",\"packed\":" + String(rfPacked) + ",\"full\":" + String(rfFull) + ",\"bytesSaved\":" + String(rfSaved) + "}" +
             ",\"maxPhones\":" + String(apMaxReal) + ",\"sockets\":{\"http\":" + String(httpSockets) + ",\"https\":" + String(httpsSockets) + "}" +
             ",\"dhcp\":{\"own\":" + (dhState == 1 ? "true" : "false") + ",\"bound\":" + String(dhBoundCount(dhNow())) + ",\"offers\":" + String(dhOffers) +
             ",\"acks\":" + String(dhAcks) + ",\"naks\":" + String(dhNaks) + ",\"dropped\":" + String(dhDrops) + ",\"evicted\":" + String(dhEvicted) + ",\"coreStops\":" + String(dhCoreStops) + "}" +
             ",\"fw\":\"" FW_BUILD "\"}";
  return sendJson(req, b);
}

bool adminKeyOk(httpd_req_t* req) { return queryParam(req, "key") == ADMIN_PASSWORD; }

// reads exactly n bytes of the request body into dst
bool recvExact(httpd_req_t* req, uint8_t* dst, size_t n) {
  size_t got = 0; int timeouts = 0;
  while (got < n) {
    int r = httpd_req_recv(req, (char*)dst + got, n - got);
    if (r == HTTPD_SOCK_ERR_TIMEOUT) { if (++timeouts > 5) return false; continue; }
    if (r <= 0) return false;
    got += r;
  }
  return true;
}

// POST /admin/upload?what=map|page&key=...  (raw file as the request body)
esp_err_t hAdminUpload(httpd_req_t* req) {
  if (!adminKeyOk(req)) return sendBody(req, "text/plain", "Wrong admin password.", "403 Forbidden");
  String what = queryParam(req, "what");
  size_t total = req->content_len;
  uint8_t* buf = (uint8_t*)malloc(4096);
  if (!buf) return httpd_resp_send_500(req);
  esp_err_t result;

  if (what == "page") {
    if (total == 0 || total > 900000) { free(buf); return sendBody(req, "text/plain", "Page must be 1 byte - 900 KB.", "400 Bad Request"); }
    LittleFS.remove("/index.tmp");
    File f = LittleFS.open("/index.tmp", "w");
    size_t left = total; bool ok = !!f;
    while (ok && left) { size_t n = min((size_t)4096, left); ok = recvExact(req, buf, n) && f.write(buf, n) == n; left -= n; }
    if (f) f.close();
    if (ok) { LittleFS.remove("/index.html"); ok = LittleFS.rename("/index.tmp", "/index.html"); }
    else LittleFS.remove("/index.tmp");
    result = ok ? sendBody(req, "text/plain", "Page uploaded. Reload the app.") : sendBody(req, "text/plain", "Upload failed - try again.", "500 Internal Server Error");
    free(buf);
    return result;
  }

  if (what != "map") { free(buf); return sendBody(req, "text/plain", "what must be map or page", "400 Bad Request"); }
  // node-map.amp = "AMPUP001" | u32 metaLen | meta JSON | map data (gzip pieces)
  if (total < 32 || !recvExact(req, buf, 12) || memcmp(buf, "AMPUP001", 8) != 0) { free(buf); return sendBody(req, "text/plain", "This is not a node-map.amp file.", "400 Bad Request"); }
  uint32_t metaLen = buf[8] | (buf[9] << 8) | (buf[10] << 16) | ((uint32_t)buf[11] << 24);
  if (metaLen == 0 || metaLen > 16384 || 12 + metaLen > total) { free(buf); return sendBody(req, "text/plain", "Damaged map file (header).", "400 Bad Request"); }
  String meta; meta.reserve(metaLen + 1);
  size_t mleft = metaLen; bool ok = true;
  while (ok && mleft) { size_t n = min((size_t)4095, (size_t)mleft); ok = recvExact(req, buf, n); if (ok) { buf[n] = 0; meta += (const char*)buf; } mleft -= n; }
  JsonDocument filter; filter["gzSize"] = true; filter["parts"] = true;
  JsonDocument m;
  if (!ok || deserializeJson(m, meta, DeserializationOption::Filter(filter))) { free(buf); return sendBody(req, "text/plain", "Damaged map file (description).", "400 Bad Request"); }
  size_t dataLen = m["gzSize"] | 0;
  if (!dataLen || 12 + metaLen + dataLen != total || m["parts"].as<JsonArray>().size() == 0) { free(buf); return sendBody(req, "text/plain", "Map file size does not match - download/copy it again.", "400 Bad Request"); }

  // make room: the old map goes first (a phone that already has it keeps its own copy)
  { Guard g; mapInstalled = false; }
  LittleFS.remove("/map.bin"); LittleFS.remove("/map.json"); LittleFS.remove("/map.tmp");
  size_t freeBytes = LittleFS.totalBytes() - LittleFS.usedBytes();
  if (dataLen + 16384 > freeBytes) { free(buf); return sendBody(req, "text/plain", ("Not enough space: map needs " + String(dataLen / 1024) + " KB, free " + String(freeBytes / 1024) + " KB. Check partitions.csv / build a smaller map.").c_str(), "507 Insufficient Storage"); }
  File f = LittleFS.open("/map.tmp", "w");
  size_t left = dataLen; ok = !!f;
  while (ok && left) { size_t n = min((size_t)4096, left); ok = recvExact(req, buf, n) && f.write(buf, n) == n; left -= n; }
  if (f) f.close();
  free(buf);
  if (ok) {
    File mf = LittleFS.open("/map.json", "w");
    ok = mf && mf.print(meta) == meta.length();
    if (mf) mf.close();
    ok = ok && LittleFS.rename("/map.tmp", "/map.bin");
  }
  if (!ok) { LittleFS.remove("/map.tmp"); LittleFS.remove("/map.json"); return sendBody(req, "text/plain", "Writing the map failed - try again.", "500 Internal Server Error"); }
  { Guard g; mapInstalled = true; }
  return sendBody(req, "text/plain", "Map installed. Phones download it the next time they open the Map tab.");
}

esp_err_t hAdminDelete(httpd_req_t* req) {
  if (!adminKeyOk(req)) return sendBody(req, "text/plain", "Wrong admin password.", "403 Forbidden");
  String what = queryParam(req, "what");
  if (what == "page") { LittleFS.remove("/index.html"); return sendBody(req, "text/plain", "Replacement page removed - the built-in app is served again."); }
  if (what == "map") { { Guard g; mapInstalled = false; } LittleFS.remove("/map.bin"); LittleFS.remove("/map.json"); return sendBody(req, "text/plain", "Map removed."); }
  return sendBody(req, "text/plain", "what must be map or page", "400 Bad Request");
}

// ============================ HTTP HANDLERS: captive portal ============================
esp_err_t hProbe(httpd_req_t* req) { return redirectTo(req, "http://192.168.4.1/"); }
// A phone that types any address lands here (the node answers every DNS name), so a page request is sent to the
// app. A missing FILE must NOT be: /favicon.ico used to be answered with this redirect, and the browser then
// downloaded the whole 290 KB app page a second time as its icon - on a board that answers one request at a time
// and shares three connections between all the phones (2026-10-31a).
esp_err_t hNoIcon(httpd_req_t* req) {
  httpReqCount++;
  httpd_resp_set_status(req, "204 No Content");
  httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=86400");
  return httpd_resp_send(req, NULL, 0);
}
bool looksLikeFile(const char* uri) {
  if (strncmp(uri, "/api/", 5) == 0 || strncmp(uri, "/map/", 5) == 0 || strncmp(uri, "/.well-known/", 13) == 0) return true;
  const char* end = strpbrk(uri, "?#");            // req->uri carries the query string too
  if (!end) end = uri + strlen(uri);
  const char* dot = NULL;
  for (const char* p = uri; p < end; p++) if (*p == '.') dot = p;
  if (!dot) return false;
  char ext[12]; size_t n = 0;
  for (const char* p = dot; p < end && n < sizeof(ext) - 1; p++) ext[n++] = (*p >= 'A' && *p <= 'Z') ? (char)(*p + 32) : *p;
  ext[n] = 0;
  static const char* known[] = { ".ico", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".mjs",
                                 ".json", ".map", ".woff", ".woff2", ".ttf", ".mp3", ".wav", ".webmanifest" };
  for (const char* k : known) if (strcmp(ext, k) == 0) return true;
  return false;
}
esp_err_t hNotFound(httpd_req_t* req, httpd_err_code_t err) {
  if (looksLikeFile(req->uri)) {   // a few bytes, not a page: nothing is waiting for an app here
    httpReqCount++;
    httpd_resp_set_status(req, "404 Not Found");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_send(req, NULL, 0);
    return ESP_OK;
  }
  redirectTo(req, "/");
  return ESP_OK;
}

// ============================ SERVER SETUP ============================
// Every secure connection needs ~33 KB for its TLS buffers. When PSRAM is switched on in the board
// settings (ESP32S3 Dev Module -> PSRAM: QSPI PSRAM), TLS buffers go there and more phones fit at once.
void* tlsCalloc(size_t n, size_t size) {
  void* p = NULL;
  if (n * size >= 2048 && psramFound()) p = heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!p) p = heap_caps_calloc(n, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  return p;
}
void tlsFree(void* p) { heap_caps_free(p); }

void registerAll(httpd_handle_t h) {
  static const httpd_uri_t routes[] = {
    { "/",                  HTTP_GET,  hRoot,        NULL },
    { "/index.html",        HTTP_GET,  hRoot,        NULL },
    { "/lite",              HTTP_GET,  hLite,        NULL },
    { "/amp-node.js",       HTTP_GET,  hAmpNodeJs,   NULL },
    { "/amp-sw.js",         HTTP_GET,  hAmpSw,       NULL },
    { "/api/bundle",        HTTP_GET,  hBundle,      NULL },
    { "/api/infra",         HTTP_GET,  hEmptyObj,    NULL },
    { "/api/infra",         HTTP_POST, hOkJson,      NULL },
    { "/api/account_photo", HTTP_GET,  hNoPhoto,     NULL },
    { "/api/update_sos",    HTTP_POST, hUpdateSos,   NULL },
    { "/api/sync_settings", HTTP_POST, hSyncSettings, NULL },
    { "/api/sync_accounts", HTTP_POST, hOkJson,      NULL },
    { "/api/req_dir",       HTTP_POST, hOkJson,      NULL },
    { "/api/generate",      HTTP_POST, hNoAi,        NULL },
    { "/leaflet.js",        HTTP_GET,  hLeafletJs,   NULL },
    { "/leaflet.css",       HTTP_GET,  hLeafletCss,  NULL },
    { "/amp-map.js",        HTTP_GET,  hAmpMapJs,    NULL },
    { "/map/meta.json",     HTTP_GET,  hMapMeta,     NULL },
    { "/map/part",          HTTP_GET,  hMapPart,     NULL },
    { "/api/state",         HTTP_GET,  hState,       NULL },
    { "/api/accounts",      HTTP_GET,  hAccounts,    NULL },
    { "/api/messages",      HTTP_GET,  hMessages,    NULL },
    { "/api/emergencies",   HTTP_GET,  hEmergencies, NULL },
    { "/api/positions",     HTTP_GET,  hPositions,   NULL },
    { "/api/ping",          HTTP_GET,  hPing,        NULL },
    { "/api/settings",      HTTP_GET,  hSettings,    NULL },
    { "/api/lora_result",   HTTP_GET,  hLoraResult,  NULL },
    { "/api/login",         HTTP_POST, hLogin,       NULL },
    { "/api/lora_login",    HTTP_POST, hLoraLogin,   NULL },
    { "/api/send_msg",      HTTP_POST, hSendMsg,     NULL },
    { "/api/send_sos",      HTTP_POST, hSendSos,     NULL },
    { "/api/pos",           HTTP_POST, hPos,         NULL },
    { "/admin",             HTTP_GET,  hAdmin,       NULL },
    { "/admin/status",      HTTP_GET,  hAdminStatus, NULL },
    { "/admin/upload",      HTTP_POST, hAdminUpload, NULL },
    { "/admin/delete",      HTTP_POST, hAdminDelete, NULL },
    { "/generate_204",      HTTP_GET,  hProbe,       NULL },
    { "/gen_204",           HTTP_GET,  hProbe,       NULL },
    { "/hotspot-detect.html", HTTP_GET, hProbe,      NULL },
    { "/library/test/success.html", HTTP_GET, hProbe, NULL },
    { "/ncsi.txt",          HTTP_GET,  hProbe,       NULL },
    { "/connecttest.txt",   HTTP_GET,  hProbe,       NULL },
    { "/redirect",          HTTP_GET,  hProbe,       NULL },
    { "/canonical.html",    HTTP_GET,  hProbe,       NULL },
    { "/success.txt",       HTTP_GET,  hProbe,       NULL },
    { "/favicon.ico",       HTTP_GET,  hNoIcon,      NULL },
  };
  for (const httpd_uri_t& r : routes) httpd_register_uri_handler(h, &r);
  for (int i = 0; i < NODE_LOGO_COUNT; i++) {          // the app's logos, small copies
    httpd_uri_t u = { NODE_LOGOS[i].path, HTTP_GET, hLogo, (void*)&NODE_LOGOS[i] };
    httpd_register_uri_handler(h, &u);
  }
  httpd_register_err_handler(h, HTTPD_404_NOT_FOUND, hNotFound);
}

// Starts the hotspot with the most phones the WiFi driver accepts, from AP_MAX_CLIENTS down. A setting the driver
// refuses is not applied at all - the hotspot would then come up with whatever the WiFi kept in flash (on a new
// board: another name, 4 phones). The number it really took is read back into apMaxReal (shown in /admin/status).
int startHotspot() {
  int took = 0;
  for (int n = AP_MAX_CLIENTS; n >= 4 && !took; n--) {
#ifdef AP_PASSWORD
    if (WiFi.softAP(AP_SSID, AP_PASSWORD, 1, 0, n)) took = n;
#else
    if (WiFi.softAP(AP_SSID, NULL, 1, 0, n)) took = n;
#endif
  }
  wifi_config_t wc;
  if (esp_wifi_get_config(WIFI_IF_AP, &wc) == ESP_OK) apMaxReal = wc.ap.max_connection; else apMaxReal = took;
  char ml[80]; snprintf(ml, sizeof(ml), "hotspot: asked %d phones, driver took %d, running with %d", AP_MAX_CLIENTS, took, apMaxReal);
  bootLog(ml);
  return took;
}

bool startWebServers() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.ctrl_port = 32768;
  // Plain connections cost a few hundred bytes each, not 36 KB. Since 2026-11-03a the AMPING Mesh app talks to this
  // side (http://192.168.4.1), so it carries every app phone, plus every phone's "Sign in to network" check.
  // The whole board has CONFIG_LWIP_MAX_SOCKETS 16 (core 2.0.17): 2 listeners + 2 control ports + the DNS server = 5,
  // which leaves 11 for phones: 8 plain + 3 secure. (The DHCP server uses no socket.) A 9th plain connection closes
  // the least recently used one - an idle phone between two polls, which simply opens a new one (no TLS to redo).
  cfg.max_open_sockets = HTTP_SOCKETS;
  cfg.max_uri_handlers = 64;
  cfg.lru_purge_enable = true;
  cfg.stack_size = 8192;
  cfg.recv_wait_timeout = 10;
  // a far phone behind the EAP110 repeater shares the air with everybody: the page goes out in 8 KB pieces and a
  // piece may wait 25 s (the secure side has had this since 2026-10-31a)
  cfg.send_wait_timeout = 25;
  bool okHttp = httpd_start(&httpServer, &cfg) == ESP_OK;
  if (okHttp) { registerAll(httpServer); httpSockets = HTTP_SOCKETS; }

  httpd_ssl_config_t scfg = HTTPD_SSL_CONFIG_DEFAULT();
  scfg.httpd.ctrl_port = 32769;
  // each secure connection keeps two 16 KB buffers (~40 KB) - without PSRAM they all come out of the ~270 KB of
  // internal RAM the WiFi also needs, so at most 3 at a time; a new phone pushes out the least recently used one
  // (3 also with PSRAM: the memory would allow more, the board's 16 sockets do not - see the plain side above)
  scfg.httpd.max_open_sockets = HTTPS_SOCKETS;
  // (no session_tickets: this ESP32 core is built without server session tickets - turning them on stops https)
  scfg.httpd.max_uri_handlers = 64;
  scfg.httpd.lru_purge_enable = true;
  scfg.httpd.stack_size = 12288;
  // a connection that stops talking frees its slot after 5 s instead of 10 (2026-10-29b): with only 3 slots, a
  // phone's reachability check that opens the port and says nothing used to hold a slot for 10 seconds
  scfg.httpd.recv_wait_timeout = 5;
  // A far phone behind the EAP110 repeater shares the air with everybody else, so one piece of the page can wait a
  // long time for room. At 10 s the connection was dropped in the middle of the page and the AMPING Mesh app showed
  // "the field node did not answer" (2026-10-31a). The page now goes out in 8 KB pieces, so this waits per piece.
  scfg.httpd.send_wait_timeout = 25;
#if ESP_IDF_VERSION_MAJOR >= 5
  scfg.servercert = (const uint8_t*)NODE_CERT_PEM;
  scfg.servercert_len = sizeof(NODE_CERT_PEM);
#else
  scfg.cacert_pem = (const uint8_t*)NODE_CERT_PEM;
  scfg.cacert_len = sizeof(NODE_CERT_PEM);
#endif
  scfg.prvtkey_pem = (const uint8_t*)NODE_KEY_PEM;
  scfg.prvtkey_len = sizeof(NODE_KEY_PEM);
  scfg.port_secure = 443;
  bool okHttps = httpd_ssl_start(&httpsServer, &scfg) == ESP_OK;
  if (!okHttps) {                          // second try with fewer secure connections (less memory at start)
    bootLog("https start failed - retrying with 2 connections");
    httpsServer = NULL; scfg.httpd.max_open_sockets = 2;
    delay(200);
    okHttps = httpd_ssl_start(&httpsServer, &scfg) == ESP_OK;
  }
  if (okHttps) { registerAll(httpsServer); httpsSockets = scfg.httpd.max_open_sockets; }
  return okHttp && okHttps;
}

// ============================ SEED DEFAULT ACCOUNTS ============================
void seedDefaultAccounts() {
 const char* defaults[] = {
  "{\"i\":\"admin_1\",\"n\":\"Super Admin\",\"l\":\"admin\",\"p\":\"CHANGE_ME\",\"r\":\"superadmin\",\"st\":\"approved\",\"b\":\"Ampayon\",\"pk\":\"Purok 1\",\"c\":\"09000000001\"}",
  "{\"i\":\"resp_1\",\"n\":\"Ambulance Team\",\"l\":\"ambulance\",\"p\":\"CHANGE_ME\",\"r\":\"ambulance\",\"st\":\"approved\",\"b\":\"Ampayon\",\"pk\":\"Purok 1\",\"c\":\"09000000002\"}",
  "{\"i\":\"resp_2\",\"n\":\"Rescue Team\",\"l\":\"rescue\",\"p\":\"CHANGE_ME\",\"r\":\"rescue\",\"st\":\"approved\",\"b\":\"Ampayon\",\"pk\":\"Purok 1\",\"c\":\"09000000003\"}"
};
  const char* ids[] = { "admin_1", "resp_1", "resp_2" };
  for (int i = 0; i < 3; i++) cacheUpsert(accCache, accIds, accCount, ids[i], defaults[i], ACC_CACHE_SIZE);
}

// ============================ OLED STATUS ============================
void drawStatus() {
  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.print("FIELD NODE");

  display.setTextSize(1);
  char line[32];
  uint32_t now = millis();
  bool piLinkUp = lastPiHeardAt && (now - lastPiHeardAt < 60000UL);

  if (!loraOk) snprintf(line, sizeof(line), "LoRa FAILED (%d) retry", lastLoraErr);
  else if (piLinkUp) snprintf(line, sizeof(line), "Pi %s %ddBm %.0fdB", piLink.word(), (int)piLink.rssi, piLink.snrAvg);   // signal: for placing the antennas
  else snprintf(line, sizeof(line), "Pi link: searching...");
  display.setCursor(0, 20);
  display.print(line);

  snprintf(line, sizeof(line), "Phones:%d  Map:%s", connectedClients, mapInstalled ? "yes" : "NO");
  display.setCursor(0, 31);
  display.print(line);

  snprintf(line, sizeof(line), "RX:%lu TX:%lu WEB:%lu", (unsigned long)loraRxCount, (unsigned long)loraTxCount, (unsigned long)httpReqCount);
  display.setCursor(0, 42);
  display.print(line);

  // bottom line takes turns: address / free memory / why the node last started
  display.setCursor(0, 54);
  uint32_t slot = (now / 3000) % 3;
  if (slot == 1) snprintf(line, sizeof(line), "Mem %uk  low %uk", (unsigned)(memFree / 1024), (unsigned)(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL) / 1024));
  else if (slot == 2) snprintf(line, sizeof(line), "#%lu %s", (unsigned long)bootNo, lastStartWhy);
  else snprintf(line, sizeof(line), "%s", httpsServer ? "https://192.168.4.1" : "HTTPS FAILED - http");
  display.print(line);

  display.display();
}

void showMessage(const char* l1, const char* l2 = "", const char* l3 = "", const char* l4 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);  display.print(l1);
  display.setCursor(0, 16); display.print(l2);
  display.setCursor(0, 28); display.print(l3);
  display.setCursor(0, 40); display.print(l4);
  display.display();
}

// ============================ SETUP / LOOP ============================
// The Heltec V4's USB-C socket is the ESP32-S3's own USB ("USBSerial" with the V3 board setting);
// V3 boards use a USB-UART chip ("Serial"). Log to both so the Serial Monitor works on either.
#if ARDUINO_USB_MODE && !ARDUINO_USB_CDC_ON_BOOT
#define AMP_HAS_USBSERIAL 1
#endif
void bootLog(const char* step) {   // Serial Monitor (115200) shows how far the start got
  Serial.printf("[boot %lu ms] %s  (free RAM %u)\n", (unsigned long)millis(), step, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
#ifdef AMP_HAS_USBSERIAL
  USBSerial.printf("[boot %lu ms] %s  (free RAM %u)\n", (unsigned long)millis(), step, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
#endif
}

const char* resetReasonText(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:  return "power on";
    case ESP_RST_SW:       return "restart";
    case ESP_RST_PANIC:    return "CRASH";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      return "FROZE (watchdog)";
    case ESP_RST_BROWNOUT: return "POWER DIP";
    case ESP_RST_EXT:      return "reset button";
    default:               return "other";
  }
}

// a restart this program decides itself (memory too low): remember why, so the screen can say it after the start
void healthRestart(const char* why) {
  prefs.putString("why", why);
  bootLog(why);
  showMessage("Restarting...", why, "back in ~10 s");
  delay(800);
  ESP.restart();
}

// The radio is reset and started; up to 3 tries. If it still fails the node keeps going WITHOUT LoRa (the WiFi and
// the app work for the phones nearby) and loop() tries again every 30 s - it never stops dead.
bool initRadio() {
  for (int attempt = 1; attempt <= 3; attempt++) {
    int state = radio.begin(LORA_FREQ, LORA_BW, LORA_SF, LORA_CR, LORA_SYNCWORD, LORA_POWER, 8, 1.8, false);
    if (state == RADIOLIB_ERR_NONE) {
      radio.setDio2AsRfSwitch(true);
      radio.setCurrentLimit(140);
      radio.setRxBoostedGainMode(true);   // ~2 dB better hearing (RadioLib's default is the power-saving gain)
      radio.setPacketReceivedAction(onRadioIrq);
      startListening();
      lastLoraErr = 0;
      return true;
    }
    lastLoraErr = state;
    delay(300);
  }
  return false;
}

void setup() {
  Serial.begin(115200);
#ifdef AMP_HAS_USBSERIAL
  USBSerial.begin(115200);
#endif
  delay(300);
  bootLog("AMPING field node starting");
  {
    // count the starts and remember why this one happened (crash, power dip, our own low-memory restart ...)
    esp_reset_reason_t rr = esp_reset_reason();
    prefs.begin("amping", false);
    bootNo = prefs.getUInt("boots", 0) + 1; prefs.putUInt("boots", bootNo);
    unexpectedRestarts = prefs.getUInt("unexp", 0);
    if (rr == ESP_RST_PANIC || rr == ESP_RST_INT_WDT || rr == ESP_RST_TASK_WDT || rr == ESP_RST_WDT || rr == ESP_RST_BROWNOUT) prefs.putUInt("unexp", ++unexpectedRestarts);
    String own = prefs.getString("why", "");
    snprintf(lastStartWhy, sizeof(lastStartWhy), "%s", (rr == ESP_RST_SW && own.length()) ? own.c_str() : resetReasonText(rr));
    if (own.length()) prefs.putString("why", "");
    bootLog(lastStartWhy);
  }
  btStop();
  gLock = xSemaphoreCreateRecursiveMutex();
  bookLock = xSemaphoreCreateRecursiveMutex();

  // screen first, so every later step can show what it is doing
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_VEXT, OUTPUT);
  digitalWrite(PIN_VEXT, LOW);
  delay(100);
  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C, true, false)) bootLog("OLED not found");
  display.setTextColor(SSD1306_WHITE);
  showMessage("AMPING Mesh", "Heltec 2: FIELD NODE", "Starting radio...");
  bootLog("screen ok");

  // TLS buffers go to PSRAM when the board setting has it switched on, else internal RAM
  mbedtls_platform_set_calloc_free(tlsCalloc, tlsFree);
  bootLog(psramFound() ? "PSRAM available" : "no PSRAM (fine - fewer phones at once)");

  femIsKCT = femIsKCT_detect();
  femRx();

  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);
  loraOk = initRadio();
  if (!loraOk) {
    char err[24];
    snprintf(err, sizeof(err), "error code %d", lastLoraErr);
    bootLog("LoRa init FAILED - continuing with WiFi only, retry every 30 s");
    showMessage("LoRa init FAILED", err, "WiFi starts anyway,", "radio retried / 30 s");
    delay(2000);
  } else bootLog("radio ok");

  seedDefaultAccounts();

  showMessage("Preparing storage...", "(first start after", "flashing: up to 1 min)");
  bootLog("mounting storage");
  if (!LittleFS.begin(true)) {
    bootLog("storage FAILED");
    showMessage("LittleFS mount", "failed - continuing", "without map / uploads");
    delay(1500);
  } else {
    mapInstalled = LittleFS.exists("/map.bin") && LittleFS.exists("/map.json");
    LittleFS.remove("/map.tmp"); LittleFS.remove("/index.tmp");   // leftovers of an interrupted upload
    bookFsOk = true;
    bookLoad();
    bootLog((String("account book: ") + bookN + " accounts").c_str());
  }

  showMessage("Starting WiFi AP...", AP_SSID);
  WiFi.mode(WIFI_AP);
  startHotspot();
  IPAddress apIP = WiFi.softAPIP(); // normally 192.168.4.1
  bootLog("WiFi hotspot " AP_SSID " started");
  {
    char ml[64]; snprintf(ml, sizeof(ml), "hotspot takes %d phones at once", apMaxReal);
    bootLog(ml);
  }
  dhcpTakeOver();

  dnsServer.start(DNS_PORT, "*", apIP);

  showMessage("Starting web servers", "(secure https takes", "a few seconds)...");
  bool webOk = startWebServers();
  bootLog(webOk ? "web servers ok (http + https)" : "HTTPS FAILED - http only");

  showMessage("AMPING Mesh READY", AP_SSID, webOk ? "https://192.168.4.1" : "HTTPS FAILED (http ok)", femIsKCT ? "V4.3 KCT8103L" : "V4.2 GC1109");
  delay(1500);
}

// requests / chat not yet echoed back by Heltec 1: send again (see upTrack)
uint32_t lastUpTickAt = 0;
// BOOK batches heard from the Pi are written here (flash, outside the main lock); the book is reported to the Pi a
// minute after start-up and every 30 minutes, so it resends the book when this node lost or never had it
void bookTick() {
  String job;
  {
    Guard g;
    if (bookPendingN) { job = bookPending[0]; for (int i = 1; i < bookPendingN; i++) bookPending[i - 1] = bookPending[i]; bookPending[--bookPendingN] = ""; }
  }
  if (job.length()) { bookApply(job); return; }
  if (!bookFsOk || !lastPiHeardAt || millis() < 60000UL) return;
  // with no accounts yet (just flashed / storage erased) nobody can log in here without the radio: ask again every
  // 2 minutes until the Pi's first batch arrives, then settle to every 30 minutes
  if (bookStateSent && millis() - bookStateAt < (bookN ? 1800000UL : 120000UL)) return;
  Guard g;
  if (tx.active || outCount > OUT_QUEUE_SIZE - 3) return;
  char id[CHUNK_ID_LEN]; makeChunkId(id);
  char js[112];
  { BookGuard bg; snprintf(js, sizeof(js), "{\"action\":\"BOOK_STATE\",\"n\":%d,\"h\":\"%08lx\",\"fw\":\"" FW_BUILD "\"}", bookN, (unsigned long)bookSum); }
  if (enqueueOutgoing(PKT_MESSAGE, String(id), String(js))) { bookStateSent = true; bookStateAt = millis(); bookAsks++; }
}

// a request / message nobody confirmed is sent again after 40 s, then 80, 160, 320, 640 s (at most 8 times, about
// 35 minutes). The backoff is what keeps a slow channel from filling up with repeats and their echoes.
uint32_t upWaitMs(uint8_t sends) { uint32_t w = 40000UL << (sends > 5 ? 4 : (sends ? sends - 1 : 0)); return w; }
void upTick() {
  if (millis() - lastUpTickAt < 2000) return;
  lastUpTickAt = millis();
  Guard g;
  for (int i = 0; i < PENDING_UP; i++) {
    PendingUp& p = pendUp[i];
    if (!p.used || millis() - p.sentAt < upWaitMs(p.sends)) continue;
    if (p.sends >= 8) { p.used = false; p.json = ""; continue; }
    if (tx.active && tx.id == p.chunkId) { p.sentAt = millis(); continue; }   // still being sent right now
    if (enqueueOutgoing(p.type, p.chunkId, p.json)) { p.sentAt = millis(); p.sends++; }
  }
}

void loop() {
  dnsServer.processNextRequest();
  processLoraRxWithAck();
  txTick();
  upTick();
  loginsTick();
  bookTick();

  // live positions to the Pi: only when nothing else is being sent and the channel is quiet
  if (!rxFlag && millis() - lastHeardAt >= LBT_QUIET_MS && !holdingTx() && !airBusy()) {
    String pkt;
    {
      Guard g;
      if (!tx.active && outCount == 0) pkt = buildPosPacket();
    }
    if (pkt.length()) sendRaw(pkt);
  }

  connectedClients = WiFi.softAPgetStationNum();

  uint32_t nowMs = millis();
  if (!loraOk && nowMs - lastLoraRetryAt >= 30000UL) {
    lastLoraRetryAt = nowMs;
    loraOk = initRadio();
    bootLog(loraOk ? "radio ok (retry)" : "radio retry failed");
  }
  if (nowMs - lastHealthAt >= 1000UL) {
    lastHealthAt = nowMs;
    memFree = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    memBig = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    // memory so low that the WiFi cannot take in data and no phone can connect: before, only unplugging helped.
    // Now the node restarts by itself (about 10 s) when that lasts 20 s.
    if (memFree < 20000 || memBig < 6000) {
      if (!lowMemSince) lowMemSince = nowMs;
      else if (nowMs - lowMemSince >= 20000UL) healthRestart("low memory");
    } else lowMemSince = 0;
  }
  if (nowMs - lastApCheckAt >= 15000UL) {
    lastApCheckAt = nowMs;
    if (!(WiFi.getMode() & WIFI_MODE_AP) || WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) {   // hotspot gone: bring it back
      bootLog("WiFi hotspot was down - restarting it");
      WiFi.mode(WIFI_AP);
      startHotspot();
      dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
    }
    dhcpTakeOver();                     // our address server on, the core's off (it comes back with a restarted hotspot)
  }
  if (nowMs - lastHealthLogAt >= 30000UL) {
    lastHealthLogAt = nowMs;
    char hl[160];
    snprintf(hl, sizeof(hl), "health: phones %d, free %u, biggest %u, lowest %u, lora %s, dhcp %s bound %d offers %u acks %u naks %u",
             connectedClients, (unsigned)memFree, (unsigned)memBig, (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             loraOk ? "ok" : "FAILED", dhState == 1 ? "own" : "CORE", dhBoundCount(dhNow()), (unsigned)dhOffers, (unsigned)dhAcks, (unsigned)dhNaks);
    bootLog(hl);
  }

  if (millis() - lastDrawAt >= 700) {
    lastDrawAt = millis();
    drawStatus();
  }
  delay(1);
}
