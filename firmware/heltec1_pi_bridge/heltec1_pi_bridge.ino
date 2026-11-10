/*
  AMPING Mesh - Heltec 1: Raspberry Pi USB <-> LoRa Bridge
  =========================================================
  This board plugs into the Raspberry Pi over USB. It has no WiFi of its
  own - its only job is translating between:
    - USB Serial (a line-based JSON protocol the Pi's backend script speaks)
    - LoRa (the compact chunked wire format in mesh_protocol.h)

  It talks to Heltec 2 (and any future field nodes) purely over LoRa.

  Uses the SAME radio settings you already range-tested successfully with
  "heltec v4.c" (915MHz, BW125, SF10, CR5, private sync word). Do not change
  mesh_protocol.h without re-running that range test.

  ----------------------------------------------------------------------------
  USB SERIAL PROTOCOL (115200 baud, one compact JSON object per line, '\n'
  terminated). Serial is used for THIS PROTOCOL ONLY - no stray debug prints
  go to it, so the Pi's line parser never chokes. All status is either sent
  as a proper "log" line or shown on the OLED.

  Heltec 1 -> Pi (things the Pi's script should read() and act on):
    {"type":"hello","v":4,"fw":"2026-10-20c"}
        Sent once at boot / after a reset, so the Pi knows to resync state.
        v:4 = fast LoRa pieces (mesh_protocol.h); fw = firmware build (amping-doctor shows it).
        v:2+ means "I confirm every line you send me with an ack line" (below),
        which is how the Pi paces itself so this board's USB buffer never overflows.
        v:3 adds live positions ("pos" lines both ways, LoRa packet type 'P').
    {"type":"pos","data":{"p":[[h,lat*1e5,lon*1e5,acc,role,name,ageSec],...]}}
        Live positions of responders / requesters on a field node's WiFi.
    {"type":"ack","of":"<type of the Pi line just handled>","ok":true|false}
        Sent after EVERY line handled from the Pi (login_result, control, sync,
        ping). For login_result/control it is sent only after the radio work is
        finished (ok:false = the field node never ACKed).
    {"type":"msg","data":{...compact chat packet: i,u,n,r,b,p,tb,t,c,x,tm,ts}}
        A field node sent a community chat message.
    {"type":"sos","data":{...compact SOS packet: id,uid,b,ty,st,n,ad,cn,p,lat,lon,tm,ds,sev,rr}}
        A field node dispatched an SOS or hazard report.
    {"type":"login_query","qid":"<8 chars>","identifier":"...","pin":"..."}
        A field node's user is trying to log in and could not be verified
        locally. The Pi MUST look this up against its accounts and reply
        with a matching "login_result" line (see below). If nothing arrives
        within ~15s the field node gives up and shows a normal login error.
    {"type":"log","level":"info|warn|error","msg":"..."}
        Informational - safe to just print/log on the Pi side.
    {"type":"busy"}
        Every 10 s while a control / login answer is still being sent to the field
        (busy channel, retries - up to 75 s): "still alive, the ack comes later".

  Pi -> Heltec 1 (write these, one per line, newline terminated):
    {"type":"login_result","qid":"<same qid from the query>",
     "status":"APPROVED","user":{"i":..,"n":..,"l":..,"p":..,"r":..,"st":..,"b":..,"pk":..,"c":..}}
    {"type":"login_result","qid":"...","status":"DENIED"}
        Answers a pending login_query. Sent back out over LoRa to whichever
        field node asked (matched by qid on that end).
    {"type":"control","data":{"action":"RED_ALERT","global":true,"hazard":"...",
                               "act":"...","brgy":"...","ts":123}}
    {"type":"control","data":{"action":"STOP_ALERT","global":true,"brgy":"..."}}
    {"type":"control","data":{"action":"UPDATE_SOS","id":123,"st":"dispatched"}}
        Broadcast an action/control message out to field nodes (same shape
        the web app's message stream already uses for these).
    {"type":"sync","kind":"acc","data":{"i":..,"n":..,"l":..,"p":..,"r":..,"st":..,"b":..,"pk":..,"c":..}}
    {"type":"sync","kind":"msg","data":{"i":..,"u":..,"n":..,"r":..,"b":..,"p":..,"tb":..,"t":..,"c":..,"x":..,"tm":..,"ts":..}}
    {"type":"sync","kind":"set","data":{"redAlertActive":false}}
    {"type":"sync","kind":"eme","data":{"id":..,"uid":..,"b":..,"ty":..,"st":..,"n":..,"ad":..,"cn":..,"p":..,"lat":..,"lon":..,"tm":..,"ds":..}}
        Pushes ONE record into Heltec 1's small rolling cache. Heltec 1
        periodically re-broadcasts a few of these out over LoRa (round
        robin) so field nodes that were briefly out of range still catch up
        on accounts / chat history / red-alert settings / active
        emergencies. You only need to push a record when it changes - you
        do NOT need to resend "msg"/"eme" records that a field node itself
        just sent in (Heltec 1 already folds those into its own broadcast
        cache the moment it relays them). Use "sync" for state that
        originated on the Pi's own side (an admin broadcast, another field
        node's message arriving via a different Heltec 1, etc).
        "acc" / "msg" / "eme" records replace an older record with the same id
        (no duplicates), and an "eme" whose status is finished (completed,
        cancelled, ...) is broadcast a few more times so field nodes drop it,
        then it is the first to make room for new ones.
    {"type":"pos","data":{"p":[...]}}
        Live positions from the Pi side - acked at once, then sent out as ONE
        LoRa 'P' packet as soon as the channel is quiet (a newer one replaces it).
    {"type":"ping"}  ->  Heltec 1 replies {"type":"pong","v":3} (keepalive; v = same as hello)
  ----------------------------------------------------------------------------

  Libraries (Arduino IDE > Library Manager):
     RadioLib          by Jan Gromes
     Adafruit SSD1306  by Adafruit (also installs Adafruit GFX)
     ArduinoJson       by Benoit Blanchon  (version 7.x)

  !! Always screw on the LoRa antenna BEFORE powering the board. !!
*/

#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <WiFi.h>
#include <RadioLib.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>

#include "mesh_protocol.h"

// ============================ TYPES ============================
// All structs live up here, above the first function: the Arduino IDE puts its automatic
// function declarations above the first function, so any type used in a function's
// signature must already be known there.
struct Frame {
  bool   valid = false;
  char   type = 0;
  String id;          // chunk id ('D'/'M'/'S'/'C'/'R'), qid ('Q'), or acked id ('K')
  uint8_t idx = 0;
  uint8_t tot = 0;
  String dat;
  String identifier;  // only for 'Q'
  String pin;         // only for 'Q'
  bool raw = false;   // a fast piece / fast ACK (mesh_protocol.h)
  uint32_t mask = 0;  // fast ACK: the pieces the other side has
};

struct CacheRec {
  String id;          // record id ("i" for acc/msg, "id" for eme) - a newer copy replaces the old one
  String json;
  uint32_t at = 0;    // millis() of the last update
  bool finished = false; // eme only: completed / cancelled / ... -> evicted first
  uint8_t sendsLeft = 0; // eme only: how many more times a finished one is broadcast
};

// ============================ HARDWARE ============================
SX1262 radio = new Module(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY, SPI);
Adafruit_SSD1306 display(128, 64, &Wire, PIN_OLED_RST);
bool femIsKCT = false;

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

// Carrier sense: true while a packet is arriving. Before, this board only knew about a field packet once it had fully
// arrived, so it often started a broadcast / control send in the middle of a field node's SOS piece - both were lost.
bool airBusy() {
  if (rxFlag) return true;                                   // a packet is waiting to be read
  uint32_t f = radio.getIrqFlags();
  if (f & RADIOLIB_SX126X_IRQ_HEADER_ERR) { startListening(); return false; }   // a damaged packet: over
  if (!(f & AIR_BUSY_FLAGS)) { airBusySince = 0; return false; }
  uint32_t now = millis();
  if (!airBusySince) airBusySince = now ? now : 1;   // (never "now | 1": that can be 1 ms in the future, and now - since wraps around)
  // a preamble that never became a packet (noise, another network) or a "packet" longer than any of ours: listen afresh
  if (now - airBusySince > ((f & RADIOLIB_SX126X_IRQ_HEADER_VALID) ? 3000UL : 500UL)) { startListening(); return false; }
  return true;
}

// ============================ STATS / STATUS (for the OLED) ============================
uint32_t lastFieldNodeHeardAt = 0;
LinkQuality fieldLink;   // how well the field node(s) are heard (mesh_protocol.h: short pieces on a weak link)
uint32_t lastAirAt = 0;       // the channel was last in use (any packet heard, even a damaged one) - listen-before-talk
uint32_t holdTxUntil = 0;     // a field node is in the middle of a multi-piece send, or an ACK is due: stay quiet
bool holdingTx() { return (int32_t)(millis() - holdTxUntil) < 0; }
void holdFor(uint32_t ms) { uint32_t until = millis() + ms; if ((int32_t)(until - holdTxUntil) > 0) holdTxUntil = until; }
uint32_t lastPiLineAt = 0;
// the Pi pings every 15 s and answers every line: 3 missed pings = it is not reading the port (service restarting,
// still booting, or the port taken by something else)
bool piAlive() { return lastPiLineAt && millis() - lastPiLineAt < 45000UL; }
uint32_t loraRxCount = 0, loraTxCount = 0, serialLineCount = 0;
uint32_t lastDrawAt = 0;

void drawStatus() {
  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.print("PI BRIDGE");

  display.setTextSize(1);
  char line[32];

  uint32_t now = millis();
  bool fieldLinkUp = lastFieldNodeHeardAt && (now - lastFieldNodeHeardAt < 60000UL);
  bool piLinkUp = lastPiLineAt && (now - lastPiLineAt < 15000UL);

  snprintf(line, sizeof(line), "Field: %s", fieldLinkUp ? "LINKED" : "searching...");
  display.setCursor(0, 20);
  display.print(line);

  snprintf(line, sizeof(line), "Pi USB: %s", piLinkUp ? "ACTIVE" : "idle");
  display.setCursor(0, 31);
  display.print(line);

  snprintf(line, sizeof(line), "RX:%lu TX:%lu", (unsigned long)loraRxCount, (unsigned long)loraTxCount);
  display.setCursor(0, 42);
  display.print(line);

  if (fieldLink.heardAt && (now / 4000) % 2 == 0)   // signal of the last field packet: for placing the antennas
    snprintf(line, sizeof(line), "Sig %s %ddBm %.0fdB", fieldLink.word(), (int)fieldLink.rssi, fieldLink.snrAvg);
  else snprintf(line, sizeof(line), "SF%d  lines:%lu", LORA_SF, (unsigned long)serialLineCount);
  display.setCursor(0, 54);
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

// ============================ SERIAL (Pi) OUTPUT HELPERS ============================
// Heltec V3 boards reach USB through a USB-UART chip (= Serial). The Heltec V4's USB-C socket is
// wired to the ESP32-S3's own USB, which is "USBSerial" with the board setting "Heltec WiFi LoRa
// 32(V3)". Every line goes out on both (and is read from both), so the same firmware works on
// either board and either board setting. The Pi sees the V4 as /dev/ttyACM0.
#if ARDUINO_USB_MODE && !ARDUINO_USB_CDC_ON_BOOT
#define AMP_HAS_USBSERIAL 1
#endif

// ---- is the command center actually listening? (it pings every 15 s, and answers every line we send)
// A payload that arrives while it is not must NOT be confirmed as delivered to the field node, and must be kept here
// until the Pi is back (firmware 2026-10-29a - before, Heltec 1 confirmed every payload it reassembled and wrote the
// line into a serial port nobody was reading: requests made during a Pi restart were lost without a trace).
bool piAlive();
#define PI_HOLD 12
struct PiHold { bool used = false; char kind = 0; String json; uint32_t at = 0; };
PiHold piHold[PI_HOLD];
int piHeldCount() { int n = 0; for (int i = 0; i < PI_HOLD; i++) if (piHold[i].used) n++; return n; }

void piSend(const String& line) {
  Serial.print(line); Serial.print('\n');
#ifdef AMP_HAS_USBSERIAL
  USBSerial.print(line); USBSerial.print('\n');
#endif
}

// v4 = fast pieces (mesh_protocol.h); fw = the firmware build, shown by amping-doctor
// how well the field is heard, for the Pi's status page / doctor: ,"sig":{"q":"good","rs":-97,"sn":6.5,"sa":5.9,"ls":0}
String signalFields() {
  if (!fieldLink.heardAt) return "";
  char b[112];
  snprintf(b, sizeof(b), ",\"sig\":{\"q\":\"%s\",\"rs\":%d,\"sn\":%.1f,\"sa\":%.1f,\"ls\":%lu,\"ago\":%lu}", fieldLink.word(), (int)fieldLink.rssi,
           fieldLink.snr, fieldLink.snrAvg, (unsigned long)fieldLink.losses, (unsigned long)((millis() - fieldLink.heardAt) / 1000));
  return String(b);
}
void piHello() { piSend("{\"type\":\"hello\",\"v\":4,\"fw\":\"" FW_BUILD "\"}"); }

void piAck(const char* of, bool ok) {
  piSend(String("{\"type\":\"ack\",\"of\":\"") + of + "\",\"ok\":" + (ok ? "true" : "false") + "}");
}

void piLog(const char* level, const String& msg) {
  JsonDocument doc;
  doc["type"] = "log";
  doc["level"] = level;
  doc["msg"] = msg;
  String line; serializeJson(doc, line);
  piSend(line);
}

void piEmitReassembled(const char* kind, const String& fullJson) {
  // fullJson is already a JSON object (e.g. the compact msg/sos packet) -
  // splice it in as-is under "data" rather than re-encoding it twice.
  piSend(String("{\"type\":\"") + kind + "\",\"data\":" + fullJson + "}");
}

// a request / message that arrived while the Pi was not listening: keep it (requests first) and hand it over later
void piHoldPut(char kind, const String& fullJson) {
  for (int i = 0; i < PI_HOLD; i++) if (piHold[i].used && piHold[i].kind == kind && piHold[i].json == fullJson) return;
  int slot = -1;
  for (int i = 0; i < PI_HOLD; i++) if (!piHold[i].used) { slot = i; break; }
  if (slot < 0) {   // full: a chat message makes room before a request does, else the oldest
    for (int i = 0; i < PI_HOLD; i++) if (piHold[i].kind == 'm' && (slot < 0 || piHold[i].at < piHold[slot].at)) slot = i;
    if (slot < 0) { slot = 0; for (int i = 1; i < PI_HOLD; i++) if (piHold[i].at < piHold[slot].at) slot = i; }
  }
  piHold[slot].used = true; piHold[slot].kind = kind; piHold[slot].json = fullJson; piHold[slot].at = millis();
  piLog("warn", String("command center not listening - keeping this ") + (kind == 's' ? "request" : "message") + " (" + piHeldCount() + " waiting)");
}
// the Pi is answering again: hand over everything that was kept, requests first
void piHoldFlush() {
  for (int pass = 0; pass < 2; pass++) {
    char want = pass == 0 ? 's' : 'm';
    for (int i = 0; i < PI_HOLD; i++) {
      if (!piHold[i].used || piHold[i].kind != want) continue;
      piEmitReassembled(want == 's' ? "sos" : "msg", piHold[i].json);
      String json = piHold[i].json;
      piHold[i].used = false; piHold[i].json = "";
      foldAndEcho(want, json, "");            // now that the Pi has it, the field may hear its echo
    }
  }
}
// hand a reassembled payload to the Pi, or keep it. true = the Pi took it.
bool piDeliver(char kind, const String& fullJson) {
  if (!piAlive()) { piHoldPut(kind, fullJson); return false; }
  piEmitReassembled(kind == 's' ? "sos" : "msg", fullJson);
  return true;
}

void piLoginQuery(const String& qid, const String& identifier, const String& pin) {
  JsonDocument doc;
  doc["type"] = "login_query";
  doc["qid"] = qid;
  doc["identifier"] = identifier;
  doc["pin"] = pin;
  String line; serializeJson(doc, line);
  piSend(line);
}

// ============================ LORA LOW-LEVEL SEND ============================
void sendRaw(const String& packet) {
  femTx();
  radio.transmit((const uint8_t*)packet.c_str(), packet.length());
  loraTxCount++;
  startListening();
}

void sendAck(const String& id, uint8_t idx) {
  String pkt = "AM" + String((char)PKT_ACK) + "{\"a\":\"" + id + "\",\"x\":" + idx + "}";
  sendRaw(pkt);
}
void sendMaskAck(const String& id, uint32_t mask, char flag = 0) { sendRaw(maskAckPacket(id, mask, flag)); }
// the last fast ACK heard (sendChunkedReliable waits for it)
String lastMaskAckId; uint32_t lastMaskAck = 0, lastMaskAckAt = 0;

String jsonEscape(const String& in) {
  String out = in;
  out.replace("\\", "\\\\");
  out.replace("\"", "\\\"");
  return out;
}

// ============================ INCOMING FRAME DECODING ============================
// (struct Frame is defined near the top of the file)

Frame readIncomingFrame() {
  Frame f;
  rxFlag = false;
  lastAirAt = millis();                   // the channel was in use - even when the packet turns out damaged
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
  lastFieldNodeHeardAt = millis();
  fieldLink.heard(rssi, snr);

  f.type = (char)buf[2];
  if (len >= 4 && buf[3] == '#') {                 // fast piece / fast ACK
    if (f.type == PKT_ACK) {
      if (len < 16) return f;
      uint32_t m = 0;
      for (int i = 12; i < 16; i++) { int v = hexVal((char)buf[i]); if (v < 0) return f; m = (m << 4) | (uint32_t)v; }
      f.id = rawIdOf(buf); f.mask = m;
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
  if (deserializeJson(doc, (const char*)(buf + 3), len - 3)) return f; // framed but malformed body

  switch (f.type) {
    case PKT_POS:
      f.dat = String((const char*)(buf + 3)); // passed to the Pi as-is
      break;
    case PKT_ACK:
      f.id = String((const char*)(doc["a"] | ""));
      f.idx = doc["x"] | 0;
      break;
    case PKT_LOGIN_Q:
      f.id = String((const char*)(doc["q"] | ""));
      f.identifier = String((const char*)(doc["u"] | ""));
      f.pin = String((const char*)(doc["p"] | ""));
      break;
    default: // 'D','M','S','C','R' - all share the chunk envelope
      f.id = String((const char*)(doc["i"] | ""));
      f.idx = doc["x"] | 0;
      f.tot = doc["t"] | 0;
      f.dat = String((const char*)(doc["d"] | ""));
      break;
  }
  f.valid = true;
  return f;
}

// ============================ ROLLING BROADCAST CACHE ============================
// Small ring buffers the Pi feeds via "sync" lines (plus whatever Heltec 1
// relays from the field itself); rebroadcast one entry every
// BROADCAST_INTERVAL_MS, round robin, so field nodes that were briefly out
// of range still catch up without flooding the shared half-duplex link.
#define CACHE_SIZE 16
// (struct CacheRec is defined near the top of the file)
CacheRec accCache[CACHE_SIZE];
CacheRec msgCache[CACHE_SIZE];
CacheRec emeCache[CACHE_SIZE];
String setCache = "{}";
int accCount = 0, msgCount = 0, emeCount = 0;
int accCursor = 0, msgCursor = 0, emeCursor = 0;

// records the Pi just changed go out before the round robin continues
#define URGENT_SIZE 16
String urgentIds[URGENT_SIZE]; char urgentKind[URGENT_SIZE]; int urgentCount = 0;
void urgentTriesReset(char kind, const String& id);
// isRetry: a broadcast nobody confirmed - it never pushes a fresh change out of a full list (it is simply skipped;
// the record still goes out in the round robin)
void pushUrgent(char kind, const String& id, bool isRetry = false) {
  for (int i = 0; i < urgentCount; i++) if (urgentKind[i] == kind && urgentIds[i] == id) return;
  if (urgentCount >= URGENT_SIZE && isRetry) return;
  if (isRetry) {             // a retry is the oldest news: it goes first
    for (int i = urgentCount; i > 0; i--) { urgentIds[i] = urgentIds[i - 1]; urgentKind[i] = urgentKind[i - 1]; }
    urgentIds[0] = id; urgentKind[0] = kind; urgentCount++;
    return;
  }
  if (urgentCount >= URGENT_SIZE) { for (int i = 1; i < URGENT_SIZE; i++) { urgentIds[i - 1] = urgentIds[i]; urgentKind[i - 1] = urgentKind[i]; } urgentCount--; }
  urgentIds[urgentCount] = id; urgentKind[urgentCount] = kind; urgentCount++;
}

// A change the Pi just made (or the echo of a field request) is broadcast again when no field node confirmed it - the
// field node ACKs a broadcast's last piece only when the whole broadcast arrived. Up to URGENT_RETRIES more times.
#define URGENT_RETRIES 4
String bcAwaitId; uint32_t bcAwaitUntil = 0; char bcAwaitKind = 0; String bcAwaitRec;
// a fresh change that did not get through whole is sent again with the SAME id: the field node keeps the pieces it has
// and answers with them, so only the missing pieces go again (before: all pieces under a new id - on a weak link the
// pieces that had arrived were thrown away every time and a long message almost never got through)
#define BC_RESENDS 8
uint8_t bcResends = 0;
#define URGENT_RETRY_SLOTS 8
String retryIds[URGENT_RETRY_SLOTS]; char retryKind[URGENT_RETRY_SLOTS] = {0}; uint8_t retryLeft[URGENT_RETRY_SLOTS] = {0};
int retrySlot(char kind, const String& id) {
  for (int i = 0; i < URGENT_RETRY_SLOTS; i++) if (retryKind[i] == kind && retryIds[i] == id) return i;
  return -1;
}
// a NEW change: two more tries if it is not confirmed
void urgentTriesReset(char kind, const String& id) {
  int s = retrySlot(kind, id);
  if (s < 0) { s = 0; for (int i = 1; i < URGENT_RETRY_SLOTS; i++) if (retryLeft[i] < retryLeft[s]) s = i; }
  retryKind[s] = kind; retryIds[s] = id; retryLeft[s] = URGENT_RETRIES;
}

bool isFinishedStatus(const char* st) {
  String s = String(st ? st : ""); s.toLowerCase();
  return s.indexOf("complete") >= 0 || s.indexOf("cancel") >= 0 || s == "binned" || s == "archived" || s == "deleted";
}

// id of a record as text (numbers and strings alike)
String recordId(JsonDocument& doc, const char* key) {
  JsonVariant v = doc[key];
  if (v.isNull()) return "";
  if (v.is<const char*>()) return String(v.as<const char*>());
  String s; serializeJson(v, s); return s;
}

// Insert or replace by id. Returns the slot used.
int cacheUpsert(CacheRec* cache, int& count, const String& id, const String& json, bool finished) {
  int slot = -1;
  if (id.length()) for (int i = 0; i < count; i++) if (cache[i].id == id) { slot = i; break; }
  if (slot < 0) {
    if (count < CACHE_SIZE) slot = count++;
    else {                                       // full: drop a finished one first, else the oldest
      int oldest = 0;
      for (int i = 0; i < count; i++) {
        if (cache[i].finished && cache[i].sendsLeft == 0) { oldest = i; break; }
        if (cache[i].at < cache[oldest].at) oldest = i;
      }
      slot = oldest;
    }
  }
  cache[slot].id = id; cache[slot].json = json; cache[slot].at = millis();
  cache[slot].finished = finished; cache[slot].sendsLeft = finished ? 3 : 0;
  return slot;
}

void cachePushAcc(const String& json) {
  JsonDocument d; if (deserializeJson(d, json)) return;
  cacheUpsert(accCache, accCount, recordId(d, "i"), json, false);
}
void cachePushMsg(const String& json) {
  JsonDocument d; if (deserializeJson(d, json)) return;
  cacheUpsert(msgCache, msgCount, recordId(d, "i"), json, false);
}
String cachePushEme(const String& json) {
  JsonDocument d; if (deserializeJson(d, json)) return "";
  String id = recordId(d, "id");
  cacheUpsert(emeCache, emeCount, id, json, isFinishedStatus(d["st"] | "pending"));
  return id;
}

// Separate reassembler per incoming type - message and SOS chunk ids come
// straight from the browser (not this firmware), so nothing guarantees
// they can never coincide; keeping the tables apart means it wouldn't
// matter if they did.
ChunkReassembler msgReassembler;
ChunkReassembler sosReassembler;

// which record each recent field send carried (chunk id -> 'e'/'m' + record id), so a repeat can be echoed again
#define DONE_KEEP 8
String doneChunk[DONE_KEEP], doneRec[DONE_KEEP]; char doneKind[DONE_KEEP] = {0}; int doneNext = 0;
void rememberDone(const String& chunkId, char kind, const String& recId) {
  doneChunk[doneNext] = chunkId; doneRec[doneNext] = recId; doneKind[doneNext] = kind; doneNext = (doneNext + 1) % DONE_KEEP;
}

// A payload the command center HAS: fold it into the broadcast cache and send it out in the next slot. Other field
// nodes see it at once, and the sender takes that echo as proof it arrived. Never for a payload we are only holding -
// the echo would tell the sender "delivered" while the Pi has never seen it (firmware 2026-10-29a).
void foldAndEcho(char kind, const String& json, const String& chunkId) {
  if (kind == 'm') {
    if (json.indexOf("\"action\"") >= 0) return;          // dispatch / alerts are not chat: the Pi answers them itself
    cachePushMsg(json);
    JsonDocument d;
    if (!deserializeJson(d, json)) {
      String mid = recordId(d, "i");
      if (mid.length()) { pushUrgent('m', mid); urgentTriesReset('m', mid); if (chunkId.length()) rememberDone(chunkId, 'm', mid); }
    }
    return;
  }
  String eid = cachePushEme(json);
  if (eid.length()) { pushUrgent('e', eid); urgentTriesReset('e', eid); if (chunkId.length()) rememberDone(chunkId, 'e', eid); }
}


// ============================ FRAME DISPATCH (shared by loop() and any blocking wait) ============================
// Handles every frame type fully - reassembly, forwarding to the Pi,
// ACKing, folding into the broadcast cache. Returns true if this frame was
// the ACK the caller was specifically waiting on (id+idx match), so a
// blocking sender can tell "done" from "just background traffic".
bool dispatchFrame(const Frame& f, char waitType, const String& waitId, uint8_t waitIdx) {
  if (!f.valid) return false;

  if (f.type == PKT_ACK) {
    if (f.raw) { lastMaskAckId = f.id; lastMaskAck = f.mask; lastMaskAckAt = millis(); }   // for sendChunkedReliable
    if (bcAwaitId.length() && f.id == bcAwaitId) broadcastAnswer(f.raw, f.mask);
    return (waitType == PKT_ACK || waitType == PKT_LOGIN_Q) && f.id == waitId && f.idx == waitIdx;
  }

  if (f.type == PKT_LOGIN_Q) {
    sendAck(f.id, 0);
    piLoginQuery(f.id, f.identifier, f.pin);
    return false;
  }

  if (f.type == PKT_MESSAGE || f.type == PKT_SOS) {
    if (!f.raw) sendAck(f.id, f.idx);            // old pieces: an ACK for every piece
    if (f.idx < f.tot) holdFor(NEXT_PIECE_MS);   // more pieces follow right away: keep quiet
    ChunkReassembler& reassembler = (f.type == PKT_MESSAGE) ? msgReassembler : sosReassembler;
    String full = reassembler.feed(f.id.c_str(), f.idx, f.tot, f.dat);
    bool dup = !full.length() && reassembler.lastWasDuplicate;
    // fast pieces: ONE answer - after the last piece of the burst, or as soon as the payload is complete (a resent piece)
    // the flag tells the field node whether the command center itself has it (2026-10-29a): on '-' the node keeps
    // sending it again, so a request is never dropped because only the radio confirmed it
    if (f.raw && (f.idx >= f.tot || full.length() || dup)) sendMaskAck(f.id, reassembler.maskFor(f.id.c_str()), piAlive() ? ACK_FLAG_PI_OK : ACK_FLAG_PI_DOWN);
    if (dup && f.idx >= f.tot) {
      // the field node sent it again: it never heard our echo (that echo is its proof of delivery) - echo it once more.
      // It already went to the Pi the first time.
      for (int i = 0; i < DONE_KEEP; i++) if (doneChunk[i] == f.id && doneKind[i]) { pushUrgent(doneKind[i], doneRec[i]); urgentTriesReset(doneKind[i], doneRec[i]); }
      return false;
    }
    if (full.length()) {
      // the echo (and with it the sender's proof of delivery) only once the command center really has it
      if (piDeliver(f.type == PKT_MESSAGE ? 'm' : 's', full)) foldAndEcho(f.type == PKT_MESSAGE ? 'm' : 's', full, f.id);
    }
    return false;
  }

  if (f.type == PKT_POS) {               // live positions from a field node -> Pi (no ACK)
    if (f.dat.length()) piEmitReassembled("pos", f.dat);
    return false;
  }

  // 'D', 'C', 'R' are Pi -> field directions; Heltec 1 never expects to
  // RECEIVE them, only send them. Ignore silently if one shows up (e.g. a
  // stray reflection) rather than mis-handling it.
  return false;
}

// While a send to the field takes long (busy channel, retries) the Pi hears nothing from this board - after 45 s it
// thinks the USB link died and reconnects (its queue is lost). A small "busy" line every 10 s tells it we are alive.
uint32_t lastBusyLineAt = 0;
void keepPiAlive() {
  if (millis() - lastBusyLineAt < 10000UL) return;
  lastBusyLineAt = millis();
  piSend("{\"type\":\"busy\"}");
}

// Waits (up to maxMs) until nobody is talking: no packet coming in, no field node in the middle of a multi-piece send,
// and the channel quiet for quietMs. Every packet that arrives meanwhile is handled (SOS pieces get their ACK).
bool waitAirClear(uint32_t quietMs, uint32_t maxMs) {   // true = the channel is clear, false = still busy after maxMs
  uint32_t start = millis();
  while (millis() - start < maxMs) {
    keepPiAlive();
    if (rxFlag) { Frame f = readIncomingFrame(); dispatchFrame(f, (char)0, "", 0); continue; }
    if (!airBusy() && !holdingTx() && millis() - lastAirAt >= quietMs) return true;
    delay(2);
  }
  return false;
}

// a background send (the Pi's account book, "bg":true on a control line - firmware 2026-10-28b): it waits until the
// field's own window is over (the field always talks first) and is never forced into a busy channel - when the
// channel does not clear in 15 s it is handed back to the Pi (ack ok:false), which sends it again later
bool reliableBg = false;
#define BG_CLEAR_MAX_MS 15000

// Sends a chunked payload with per-chunk ACK + retry, WITHOUT ever
// dropping unrelated traffic that arrives while waiting - every frame that
// comes in during the wait is still fully processed via dispatchFrame().
#define RELIABLE_TRIES 8
bool sendChunkedReliable(char type, const String& id, const String& fullJson) {
  size_t pieceLen = pieceLenFor(fullJson.length(), fieldLink.weak());
  uint8_t total = rawTotalFor(fullJson.length(), pieceLen);
  if (total > 16) { piLog("error", "payload too large to chunk over LoRa"); return false; }
  // fast pieces: the whole payload in ONE burst, then ONE answer from the field node listing the pieces it has;
  // only missing pieces go again. No answer at all: the last piece again (the node answers it with what it has).
  uint32_t full = fullMaskOf(total), todo = full;
  uint32_t startedAt = millis();
  lastBusyLineAt = millis();
  bool answered = false;
  for (int attempt = 0; attempt < RELIABLE_TRIES && millis() - startedAt < 75000UL; attempt++) {
    // listen before talk; right after the node asked for missing pieces it is listening - send at once
    // first try: 300 ms of quiet (before any field node may start, 350 ms); a retry: after the field's window
    // (mesh_protocol.h LBT_QUIET_MS), so the two radios never pick the same moment
    if (!answered && reliableBg) {
      if (!waitAirClear((uint32_t)random(LBT_QUIET_MS, LBT_QUIET_MS + 500), BG_CLEAR_MAX_MS)) { piLog("info", "channel busy - background send postponed"); return false; }
    } else if (!answered) waitAirClear(attempt ? (uint32_t)random(LBT_QUIET_MS, LBT_QUIET_MS + 500) : 300UL, 6000);
    answered = false;
    for (uint8_t idx = 1; idx <= total; idx++) {
      if (!(todo & (1UL << (idx - 1)))) continue;
      sendRaw(rawPiece(type, id, idx, total, fullJson, pieceLen));
      delay(30);   // let the RF front end settle between back-to-back pieces
    }
    uint32_t waitStart = millis();
    lastMaskAckId = "";
    while (millis() - waitStart < ACK_TIMEOUT_MS) {
      keepPiAlive();
      if (rxFlag) {
        Frame f = readIncomingFrame();
        dispatchFrame(f, (char)0, "", 0);
        if (f.valid && f.raw && f.type == PKT_ACK && f.id == id) { answered = true; break; }
      } else {
        delay(1); // yield so the ESP32 idle/watchdog tasks still get CPU time
      }
    }
    if (answered) {
      uint32_t missing = full & ~lastMaskAck;
      if (!missing) return true;
      todo = missing;
    } else {
      todo = 1UL << (total - 1);
    }
    fieldLink.lost();
    // pieces keep getting lost: from the third try on, short pieces, all of them (same id - the node starts over)
    if (attempt >= 1 && pieceLen > CHUNK_RAW_WEAK && pieceLenFor(fullJson.length(), true) == CHUNK_RAW_WEAK) {
      pieceLen = CHUNK_RAW_WEAK; total = rawTotalFor(fullJson.length(), pieceLen); full = fullMaskOf(total); todo = full;
    }
  }
  piLog("warn", "no ACK for outgoing payload, giving up on it");
  return false;
}

void processLoraRx() {
  if (!rxFlag) return;
  Frame f = readIncomingFrame();
  dispatchFrame(f, (char)0, "", 0); // not waiting on anything specific right now
}

// A broadcast starts at most BROADCAST_GAP_MS after the previous one FINISHED, and only
// when the field has been quiet for LBT_QUIET_MS (listen-before-talk) - so a field node
// that is in the middle of sending a multi-chunk SOS gets the channel to itself.
#define BROADCAST_GAP_MS 800      // after anything the Pi just changed (urgent): a dispatch / reply goes out at once
#define ROUND_ROBIN_GAP_MS 6000   // between repeats of the old records: leaves the channel free for the field most of the time
#define ROUND_ROBIN_GAP_WEAK_MS 15000   // ... on a weak link: every piece takes longer to get through, the field needs more room
uint32_t lastBroadcastDoneAt = 0;
int broadcastPhase = 0; // cycles: acc, msg, set, eme

bool channelQuiet() {
  return !holdingTx() && (lastAirAt == 0 || millis() - lastAirAt >= LBT_QUIET_MS) && !airBusy();
}

// A broadcast goes out piece by piece from loop() (it used to be sent in one blocking burst, deaf to the field the whole
// time). Between pieces the board keeps reading the radio and the Pi; if a field node starts talking, the rest of the
// broadcast waits until the field is done (the node keeps the pieces it has for 2 minutes).
struct Broadcast { bool active = false; char type = PKT_DATA_SYNC; String id; String json; uint8_t idx = 0, total = 0; uint16_t pieceLen = CHUNK_RAW_LEN; uint32_t todo = 0; bool needQuiet = false; uint32_t lastEndAt = 0, startedAt = 0; char awaitKind = 0; String awaitRec; } bc;
void broadcastStart(const String& payload) {
  char id[CHUNK_ID_LEN]; makeChunkId(id);
  int len = payload.length();
  bc.pieceLen = pieceLenFor(len, fieldLink.weak());   // fast pieces (mesh_protocol.h): up to 200 bytes each (80 on a weak link)
  bc.total = rawTotalFor(len, bc.pieceLen);
  if (bc.total > 16) { piLog("error", "payload too large to chunk over LoRa"); return; }
  bc.active = true; bc.id = String(id); bc.json = payload; bc.idx = 1; bc.todo = fullMaskOf(bc.total); bc.needQuiet = false; bc.lastEndAt = 0; bc.startedAt = millis(); bc.awaitKind = 0; bc.awaitRec = "";
  bcResends = 0;
}
void broadcastStep() {
  if (!bc.active) return;
  if (millis() - bc.startedAt > 60000UL) { bc.active = false; lastBroadcastDoneAt = millis(); return; }   // could not finish: give up
  if (bc.lastEndAt) {
    if (millis() - bc.lastEndAt < 60) return;                                     // let the RF front end settle
    bool fieldSpoke = (int32_t)(lastAirAt - bc.lastEndAt) > 0;                     // the field talked in between: wait for quiet
    if (holdingTx() || airBusy() || (fieldSpoke && millis() - lastAirAt < LBT_QUIET_MS)) return;
  }
  if (bc.needQuiet) { if (!channelQuiet()) return; bc.needQuiet = false; }   // a resend after no answer: listen before talk
  if (!bc.todo) bc.todo = 1UL << (bc.total - 1);
  bc.idx = 1; while (!(bc.todo & (1UL << (bc.idx - 1)))) bc.idx++;
  bc.todo &= ~(1UL << (bc.idx - 1));
  sendRaw(rawPiece(bc.type, bc.id, bc.idx, bc.total, bc.json, bc.pieceLen));
  bc.lastEndAt = millis();
  if (!bc.todo) {
    bc.active = false; lastBroadcastDoneAt = millis();
    holdFor(ACK_WAIT_MS);                         // the field node ACKs the last piece: room for it
    if (bc.awaitKind) { bcAwaitId = bc.id; bcAwaitKind = bc.awaitKind; bcAwaitRec = bc.awaitRec; bcAwaitUntil = millis() + ACK_WAIT_MS + 400; }
  }
}

// a field node answered the fresh change we wait for (bcAwaitId)
void broadcastAnswer(bool raw, uint32_t mask) {
  uint32_t full = fullMaskOf(bc.total);
  if (!raw || bc.id != bcAwaitId || (mask & full) == full) {   // it got the whole broadcast: no more tries
    int s = retrySlot(bcAwaitKind, bcAwaitRec); if (s >= 0) retryLeft[s] = 0;
    bcAwaitId = "";
  } else if (bcResends < BC_RESENDS) {                         // it has some pieces: the missing ones, at once (it listens)
    bcResends++; fieldLink.lost();
    bc.todo = full & ~mask; bc.active = true; bc.needQuiet = false; bc.lastEndAt = 0; bc.startedAt = millis();
    bcAwaitId = "";
  }
}

// a finished emergency is announced a few times, then only kept until its slot is needed
bool emeSendable(int i) { return !emeCache[i].finished || emeCache[i].sendsLeft > 0; }
String emePayload(int i) {
  if (emeCache[i].finished && emeCache[i].sendsLeft > 0) emeCache[i].sendsLeft--;
  return "{\"k\":\"eme\"," + emeCache[i].json.substring(1);
}

// ---- the network clock: the Pi's clock, handed to the field nodes so chat can show "received in ..."
// The Pi puts its clock in every ping line. A line can sit in the serial buffer while a LoRa send is in
// progress, which only ever makes the Pi's time look OLDER - so the newest-looking reading is the right one.
#include <esp_timer.h>
uint64_t upMs() { return (uint64_t)(esp_timer_get_time() / 1000); }
int64_t piClockBase = 0; bool piClockKnown = false; uint64_t piClockSetAt = 0, lastTimeTxAt = 0;
void piClockLearn(uint64_t piNow) {
  if (!piNow) return;
  int64_t cand = (int64_t)piNow - (int64_t)upMs();
  int64_t diff = cand - piClockBase;
  if (!piClockKnown || diff > 0 || diff < -5000 || upMs() - piClockSetAt > 300000ULL) {
    piClockBase = cand; piClockKnown = true; piClockSetAt = upMs();
  }
}
#define TIME_TX_EVERY_MS 30000ULL
bool timeDue() { return piClockKnown && (lastTimeTxAt == 0 || upMs() - lastTimeTxAt >= TIME_TX_EVERY_MS); }
void sendTimePacket() {
  // AMT{"t":1790000000000} - written once to learn its length (= its airtime), then with the arrival time
  char pkt[48];
  snprintf(pkt, sizeof(pkt), "AM%c{\"t\":%llu}", (char)PKT_TIME, (unsigned long long)(piClockBase + (int64_t)upMs()));
  uint32_t airMs = (uint32_t)(radio.getTimeOnAir(strlen(pkt)) / 1000);
  snprintf(pkt, sizeof(pkt), "AM%c{\"t\":%llu}", (char)PKT_TIME, (unsigned long long)(piClockBase + (int64_t)upMs() + airMs));
  sendRaw(String(pkt));
  lastTimeTxAt = upMs();
}

void doBroadcastTick() {
  // something fresh is waiting (a chat, a request, a dispatch ...) while an old record is being repeated: the repeat
  // stops here (it comes round again later), the fresh one goes next
  if (bc.active && !bc.awaitKind && urgentCount > 0 && bc.lastEndAt) { bc.active = false; lastBroadcastDoneAt = 0; }
  if (bc.active) { broadcastStep(); return; }
  if (bcAwaitId.length() && (int32_t)(millis() - bcAwaitUntil) > 0 && bc.id == bcAwaitId && bcResends < BC_RESENDS) {
    // no answer at all: the LAST piece again, same id - the node answers it with the pieces it has
    bcResends++; fieldLink.lost();
    bc.todo = 1UL << (bc.total - 1); bc.active = true; bc.needQuiet = true; bc.lastEndAt = 0; bc.startedAt = millis();
    bcAwaitId = "";
    broadcastStep();
    return;
  }
  if (bcAwaitId.length() && (int32_t)(millis() - bcAwaitUntil) > 0) {   // still nothing: all of it under a new id (at most URGENT_RETRIES times)
    int s = retrySlot(bcAwaitKind, bcAwaitRec);
    if (s >= 0 && retryLeft[s] > 0) { retryLeft[s]--; pushUrgent(bcAwaitKind, bcAwaitRec, true); }
    bcAwaitId = "";
    fieldLink.lost();   // (the retry goes out in short pieces)
  }
  // still waiting for the field node's "got it all" for the last fresh change: the next broadcast waits (else it took
  // over the wait and the earlier change lost its retries)
  if (bcAwaitId.length()) return;
  uint32_t now = millis();
  if (now - lastBroadcastDoneAt < (urgentCount ? BROADCAST_GAP_MS : fieldLink.weak() ? ROUND_ROBIN_GAP_WEAK_MS : ROUND_ROBIN_GAP_MS)) return;
  if (!channelQuiet()) return;
  if (timeDue()) { sendTimePacket(); lastBroadcastDoneAt = millis(); return; }

  String payload; char uKind = 0; String uId;
  // 1) whatever the Pi just changed
  while (!payload.length() && urgentCount > 0) {
    char kind = urgentKind[0]; String id = urgentIds[0];
    for (int i = 1; i < urgentCount; i++) { urgentIds[i - 1] = urgentIds[i]; urgentKind[i - 1] = urgentKind[i]; }
    urgentCount--;
    if (kind == 'e') { for (int i = 0; i < emeCount; i++) if (emeCache[i].id == id) { payload = emePayload(i); break; } }
    else if (kind == 'm') { for (int i = 0; i < msgCount; i++) if (msgCache[i].id == id) { payload = "{\"k\":\"msg\"," + msgCache[i].json.substring(1); break; } }
    else if (kind == 'a') { for (int i = 0; i < accCount; i++) if (accCache[i].id == id) { payload = "{\"k\":\"acc\"," + accCache[i].json.substring(1); break; } }
    if (payload.length()) { uKind = kind; uId = id; }   // (remembered for the "nobody confirmed it" retry)
  }
  // 2) round robin over everything
  for (int tries = 0; tries < 4 && !payload.length(); tries++) {
    if (broadcastPhase == 0 && accCount > 0) {
      payload = "{\"k\":\"acc\"," + accCache[accCursor % accCount].json.substring(1);
      accCursor++;
    } else if (broadcastPhase == 1 && msgCount > 0) {
      payload = "{\"k\":\"msg\"," + msgCache[msgCursor % msgCount].json.substring(1);
      msgCursor++;
    } else if (broadcastPhase == 2 && setCache.length() > 2) {   // ("{}" before the Pi sent any: was sent as broken JSON)
      payload = "{\"k\":\"set\"," + setCache.substring(1);
    } else if (broadcastPhase == 3 && emeCount > 0) {
      for (int k = 0; k < emeCount && !payload.length(); k++) {
        int i = emeCursor % emeCount; emeCursor++;
        if (emeSendable(i)) payload = emePayload(i);
      }
    }
    broadcastPhase = (broadcastPhase + 1) % 4;
  }

  if (payload.length() < 3) { lastBroadcastDoneAt = millis(); return; } // nothing to say right now

  broadcastStart(payload);   // one piece per loop() turn; only the last piece is ACKed (when the node got it all)
  if (uKind && payload.indexOf("\"k\":\"set\"") < 0) { bc.awaitKind = uKind; bc.awaitRec = uId; }
  broadcastStep();
}

// live positions from the Pi side: ONE 'P' packet, kept until the channel is quiet (the newest replaces an older one
// that is still waiting). It used to wait at most 3 s and then go out anyway - often right into a field node's packet.
String pendingPos; uint32_t pendingPosAt = 0;
bool queuePositions(const String& json) {
  if (json.length() < 5 || json.length() > POS_PACKET_MAX) return false;
  pendingPos = json; pendingPosAt = millis();
  return true;
}
void positionsTick() {
  if (!pendingPos.length() || bc.active) return;
  if (millis() - pendingPosAt > 60000UL) { pendingPos = ""; return; }   // too old to be of use
  if (!channelQuiet()) return;
  sendRaw("AM" + String((char)PKT_POS) + pendingPos);
  pendingPos = "";
}

// ============================ SERIAL (Pi) INPUT ============================
String serialBuf, usbBuf;

void handlePiLine(const String& line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) { piAck("bad", false); return; }
  const char* type = doc["type"] | "";
  bool wasDown = !piAlive();
  lastPiLineAt = millis();
  serialLineCount++;
  if (wasDown && piHeldCount()) piHoldFlush();   // it is reading the port again: hand over what was kept

  if (strcmp(type, "login_result") == 0) {
    JsonDocument out;
    out["s"] = doc["status"] | "DENIED";
    if (doc["user"].is<JsonObject>()) out["u"] = doc["user"];
    String json; serializeJson(out, json);
    String qid = String((const char*)(doc["qid"] | ""));
    bool ok = qid.length() ? sendChunkedReliable(PKT_LOGIN_R, qid, json) : false;
    piAck("login_result", ok);
    return;
  }

  if (strcmp(type, "control") == 0) {
    String json; serializeJson(doc["data"].as<JsonObject>(), json);
    char id[CHUNK_ID_LEN]; makeChunkId(id);
    reliableBg = doc["bg"] | false;
    bool ok = sendChunkedReliable(PKT_CONTROL, String(id), json);
    reliableBg = false;
    piAck("control", ok);
    return;
  }

  if (strcmp(type, "sync") == 0) {
    const char* kind = doc["kind"] | "";
    // "bg": the Pi's resend of everything after a (re)connect - kept for the repeat cycle, but it must not hold up news
    bool bg = doc["bg"] | false;
    String json; serializeJson(doc["data"].as<JsonObject>(), json);
    if (strcmp(kind, "acc") == 0) {
      cachePushAcc(json);
      JsonDocument d; if (!bg && !deserializeJson(d, json)) { pushUrgent('a', recordId(d, "i")); urgentTriesReset('a', recordId(d, "i")); }
    }
    else if (strcmp(kind, "msg") == 0) {
      // a chat message typed on the Pi side goes out in the next slot - it used to wait for its turn in the
      // round robin, which is minutes when the lists are full
      cachePushMsg(json);
      JsonDocument d; if (!bg && !deserializeJson(d, json)) { pushUrgent('m', recordId(d, "i")); urgentTriesReset('m', recordId(d, "i")); }
    }
    else if (strcmp(kind, "eme") == 0) { String id = cachePushEme(json); if (id.length() && !bg) { pushUrgent('e', id); urgentTriesReset('e', id); } }
    else if (strcmp(kind, "set") == 0) setCache = json;
    piAck("sync", true);
    return;
  }

  if (strcmp(type, "pos") == 0) {
    String json; serializeJson(doc["data"].as<JsonObject>(), json);
    piAck("pos", queuePositions(json));
    return;
  }

  if (strcmp(type, "ping") == 0) {
    piClockLearn(doc["t"].as<uint64_t>());
    // the version too (the Pi may have missed the boot hello), and how many seconds ago a field node was heard
    // (-1 = never): field nodes ACK every broadcast, so a working link answers within seconds even when idle
    long fa = lastFieldNodeHeardAt ? (long)((millis() - lastFieldNodeHeardAt) / 1000) : -1;
    piSend(String("{\"type\":\"pong\",\"v\":4,\"fw\":\"" FW_BUILD "\",\"fa\":") + fa + ",\"held\":" + piHeldCount() + signalFields() + "}");
    return;
  }
}

void pollStream(Stream& in, String& buf) {
  while (in.available()) {
    char c = in.read();
    if (c == '\n') {
      buf.trim();
      if (buf.length()) handlePiLine(buf);
      buf = "";
    } else if (c != '\r') {
      buf += c;
      if (buf.length() > 2048) buf = ""; // guard against a runaway line
    }
  }
}

void pollSerial() {
  pollStream(Serial, serialBuf);
#ifdef AMP_HAS_USBSERIAL
  pollStream(USBSerial, usbBuf);
#endif
}

// ============================ SETUP / LOOP ============================
void setup() {
  Serial.setRxBufferSize(4096);   // must be set BEFORE begin(); the Pi may burst several lines while a LoRa send is in progress
  Serial.begin(115200);
#ifdef AMP_HAS_USBSERIAL
  USBSerial.setRxBufferSize(4096);
  USBSerial.begin(115200);
#endif
  WiFi.mode(WIFI_OFF);
  btStop();

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_VEXT, OUTPUT);
  digitalWrite(PIN_VEXT, LOW);
  delay(100);

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C, true, false);
  display.setTextColor(SSD1306_WHITE);
  showMessage("AMPING Mesh", "Heltec 1: PI BRIDGE", "Starting radio...");

  femIsKCT = femIsKCT_detect();
  femRx();

  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);
  int state = radio.begin(LORA_FREQ, LORA_BW, LORA_SF, LORA_CR, LORA_SYNCWORD, LORA_POWER, 8, 1.8, false);
  if (state != RADIOLIB_ERR_NONE) {
    char err[24];
    snprintf(err, sizeof(err), "error code %d", state);
    showMessage("LoRa init FAILED", err, "Check board / pins");
    while (true) delay(1000);
  }
  radio.setDio2AsRfSwitch(true);
  radio.setCurrentLimit(140);
  radio.setRxBoostedGainMode(true);   // ~2 dB better hearing (RadioLib's default is the power-saving gain)
  radio.setPacketReceivedAction(onRadioIrq);
  startListening();

  showMessage("AMPING Mesh", "Heltec 1: PI BRIDGE", "Ready.", femIsKCT ? "V4.3 KCT8103L" : "V4.2 GC1109");
  delay(1200);

  piHello();
  piLog("info", "Heltec 1 bridge online");
}

void loop() {
  pollSerial();
  processLoraRx();
  doBroadcastTick();
  positionsTick();

  if (millis() - lastDrawAt >= 500) {
    lastDrawAt = millis();
    drawStatus();
  }
}
