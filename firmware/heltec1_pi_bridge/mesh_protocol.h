/*
  AMPING Mesh - Shared LoRa Protocol
  ==================================
  Included by BOTH heltec1-pi-bridge.c and heltec2-remote-node.c so the two
  boards can never drift out of sync on pins, radio settings, or packet
  framing. If you change a value here, re-flash BOTH boards.

  Radio settings are copied verbatim from the range-test sketch you already
  proved works over the air ("heltec v4.c") - do not change these unless you
  re-run that range test with the new values first.

  ----------------------------------------------------------------------------
  WIRE FORMAT (over the LoRa air interface only)
  ----------------------------------------------------------------------------
  Every LoRa packet is ASCII text: 2-byte magic "AM", then a 1-character
  packet TYPE, then a compact JSON object. Keeping it text (not binary) makes
  it possible to debug on a Serial monitor / logic analyzer, same spirit as
  the range-test sketch's "RT" packets.

    AM<TYPE><json>

  TYPE 'D' - Data sync chunk (Pi -> field nodes, one-way, no ACK)
    Heltec 1 periodically rebroadcasts what the Pi knows (accounts,
    settings, active emergencies) in small rotating slices so a remote node
    that only occasionally has a clean radio link still ends up with a
    reasonably fresh local cache. Payload:
      {"i":"<chunk id, <=8 chars>","x":<1-based idx>,"t":<total chunks>,
       "d":"<slice of the JSON below, <=CHUNK_DATA_LEN chars>"}
    which reassembles to one of:
      {"k":"acc","i":..,"n":..,"l":..,"p":..,"r":..,"st":..,"b":..,"pk":..,"c":..}
      {"k":"set","redAlertActive":bool,"redAlertHazard":..,"redAlertAction":..}
      {"k":"eme","id":..,"uid":..,"b":..,"ty":..,"st":..,"n":..,"ad":..,"cn":..,
                 "p":..,"lat":..,"lon":..,"tm":..,"ds":..}
      {"k":"msg","i":..,"u":..,"n":..,"r":..,"b":..,"p":..,"tb":..,"t":..,"c":..,
                 "x":..,"tm":..,"ts":..}
    (field names match the compact keys already used by the web app - "acc"
    matches heltec-node.html's mapCompactAccount(), "msg" matches
    decodeCompactMsg() - so a remote node can hand them straight back out
    over HTTP with no re-keying. "msg" carries chat history OUT to the
    field, complementing 'M' below which carries new messages IN from it.)

  TYPE 'M' - Chat message chunk (field node -> Pi, ACKed)
  TYPE 'S' - SOS/hazard chunk    (field node -> Pi, ACKed)
  TYPE 'C' - Control/action chunk, e.g. RED_ALERT / STOP_ALERT / UPDATE_SOS
             (Pi -> field node, ACKed) - payload reassembles to whatever the
             big web app's "action" messages already look like, unchanged.
    All three share the same chunk envelope as 'D' above:
      {"i":"<chunk id>","x":<idx>,"t":<tot>,"d":"<slice>"}
    The reassembled JSON is passed straight through to the other side
    (Heltec 1 <-> Serial <-> Pi, or Heltec 2 <-> HTTP <-> browser) with only
    the envelope re-keyed between the LoRa-compact form above and the
    verbose {isChk:true,id,idx,tot,dat} form the web app / Pi JSON lines use.
    Heltec 1 also immediately folds every 'M'/'S' it relays from the field
    into its own 'D' broadcast cache (kind "msg" / "eme"), so other field
    nodes learn about it even before the Pi echoes anything back - the Pi's
    own "sync" pushes are for injecting state that originated on ITS side
    (e.g. a message sent by an admin on the main Pi web app).

  TYPE 'Q' - Login query (field node -> Pi, ACKed, not chunked - always small)
      {"q":"<query id, <=8 chars>","u":"<identifier, <=24 chars>",
       "p":"<pin, <=8 chars>"}

  TYPE 'R' - Login result chunk (Pi -> field node, ACKed)
    Same envelope as 'D'/'M'/'S'/'C', chunk id == the 'q' from the query it
    answers. Reassembles to:
      {"s":"APPROVED"|"DENIED","u":{...compact account, only if APPROVED...}}

  TYPE 'K' - ACK for one chunk (or for a 'Q' query, x is always 0)
      {"a":"<id being acked>","x":<idx being acked>}

  TYPE 'P' - Live positions (both directions, ONE packet, never chunked, no ACK -
             a lost one is simply replaced by the next, ~20 s later)
      {"p":[["<h>",<lat*1e5>,<lon*1e5>,<accuracy m>,"<role code>","<name>",<age s>], ...]}
      h = short id of the account (FNV-1a 32-bit of the account id, base 36 - see
      hashId() in live-units.js / amping-server.js). Role codes: a ambulance,
      e evacuation, r rescue, l relief, u resident with an open request,
      d admin, t authority, s superadmin.  At most 3 entries, packet <= 200 bytes.
      Field node -> Pi: responders + requesters using that node's WiFi.
      Pi -> field: responders + requesters on the Pi's WiFi.

  LISTEN-BEFORE-TALK: neither side starts an unsolicited transmission (broadcast /
  positions) until it has heard nothing for LBT_QUIET_MS - that leaves room for the
  other side's multi-chunk SOS / chat sends and their ACKs. Field nodes wait only
  FIELD_LBT_MS, so a request from the field always gets the channel first.
  CARRIER SENSE: a radio cannot hear while it transmits, and before, a board only
  noticed the other one AFTER a whole packet had arrived - so it often started
  talking in the middle of the other side's packet and both were lost. Both boards
  now also check the SX1262's "preamble detected" / "header valid" flags (airBusy())
  and never start sending while a packet is coming in.
  ACKS: 'D' broadcasts are acknowledged ONLY on their last piece, and only when the
  whole broadcast arrived; Heltec 1 broadcasts a fresh change up to 4 more times when
  no such ACK comes. Acknowledging
  every piece put the field node on the air while piece 2 was already being sent,
  so it never heard piece 2 and no broadcast longer than one piece (requests, chat,
  accounts) ever arrived in the field.

  All chunk payloads are capped at CHUNK_DATA_LEN (90) bytes of JSON per
  hop, same limit the browser already uses for its own HTTP-level chunking
  - LoRa is the scarce link, not USB serial or WiFi, so only the LoRa hop
  is ever fragmented this small.
  ----------------------------------------------------------------------------
*/
#pragma once

#include <Arduino.h>

// ============================ RADIO (proven via range test) ============================
#define LORA_FREQ    915.0
#define LORA_BW      125.0
#define LORA_SF      10
#define LORA_CR      5
// SX1262 output; the V4 front end adds about 11 dB (range test: 10 -> ~21 dBm, 14 -> ~25 dBm, 21 -> ~28 dBm).
// 14 since 2026-10-21: field test at 100 m lost the longer packets at 10.
#define LORA_POWER   14
#define LORA_SYNCWORD RADIOLIB_SX126X_SYNC_WORD_PRIVATE

// ---- Heltec WiFi LoRa 32 V4 pins (identical on both boards) ----
#define PIN_LORA_NSS   8
#define PIN_LORA_SCK   9
#define PIN_LORA_MOSI  10
#define PIN_LORA_MISO  11
#define PIN_LORA_RST   12
#define PIN_LORA_BUSY  13
#define PIN_LORA_DIO1  14
#define PIN_OLED_SDA   17
#define PIN_OLED_SCL   18
#define PIN_OLED_RST   21
#define PIN_VEXT       36
#define PIN_LED        35
#define PIN_BUTTON     0

#define PIN_FEM_POWER  7
#define PIN_FEM_CSD    2
#define PIN_GC1109_CPS 46
#define PIN_KCT_CTX    5

// ============================ PROTOCOL ============================
#define PKT_MAGIC0     'A'
#define PKT_MAGIC1     'M'

#define PKT_DATA_SYNC  'D'
#define PKT_MESSAGE    'M'
#define PKT_SOS        'S'
#define PKT_CONTROL    'C'
#define PKT_LOGIN_Q    'Q'
#define PKT_LOGIN_R    'R'
#define PKT_ACK        'K'
#define PKT_POS        'P'
// 'T' - the network clock (Pi -> field nodes, ONE small packet, no ACK): {"t":<Pi clock, ms, at the moment
//       the packet finishes arriving>}. Heltec 1 stamps it right before transmitting (Pi clock + airtime),
//       so every phone on every node can measure how long a chat message took. Sent about twice a minute.
#define PKT_TIME       'T'

#define LBT_QUIET_MS     900    // channel must have been quiet this long before an unsolicited send (Heltec 1)
// The two windows never overlap: a field node starts within FIELD_LBT_MS + FIELD_JITTER_MS (350-800 ms) of quiet,
// Heltec 1 never before LBT_QUIET_MS (900 ms) - so the two can never pick the same moment and collide.
#define FIELD_JITTER_MS  450
#define FIELD_LBT_MS     350    // a field node's own sends (SOS, chat, actions) wait only this long - the field goes first
#define ACK_WAIT_MS      800    // after a piece that will be ACKed: room for that ACK (~410 ms on the air) before anyone else talks
#define NEXT_PIECE_MS    1800   // after an ACKed / heard piece that is NOT the last: the next piece follows - nobody else talks
// SX1262 flags that mean "a packet is coming in right now" (startListening() enables the preamble flag)
#define AIR_BUSY_FLAGS   (RADIOLIB_SX126X_IRQ_PREAMBLE_DETECTED | RADIOLIB_SX126X_IRQ_HEADER_VALID)
#define POS_PACKET_MAX   200    // bytes of JSON in one 'P' packet

#define CHUNK_DATA_LEN   90     // matches the browser's own HTTP-level chunk size (and the old LoRa pieces)

// ---- FAST PIECES (firmware 2026-10-20c and newer) ----------------------------------------------------------------
// Before, every LoRa piece carried 90 characters wrapped in JSON ({"i":..,"x":..,"t":..,"d":"<escaped>"}: ~40 % extra
// bytes) and the sender waited for an ACK after EVERY piece. Now:
//   piece:  AM<type>#<id: 8 chars><piece-1: 1 hex char><total-1: 1 hex char><raw data, up to CHUNK_RAW_LEN bytes>
//   ACK:    AMK#<id: 8 chars><received pieces: 4 hex chars, bit 0 = piece 1>
// All pieces of a payload go out in one burst; the receiver answers ONCE (after the last piece, or as soon as the
// payload is complete) with the pieces it has, and only missing pieces are sent again. A request (SOS) is 2 pieces
// instead of 3 and needs 1 ACK instead of 3. Both boards still understand the old JSON pieces.
#define CHUNK_RAW_LEN    200
#define RAW_HDR_LEN      14     // "AM" + type + '#' + 8-char id + idx + tot
#define FW_BUILD         "2026-11-03a"

inline uint32_t fullMaskOf(uint8_t total) { return total >= 32 ? 0xFFFFFFFFUL : ((1UL << total) - 1); }
inline char hexDigit(uint8_t v) { return "0123456789abcdef"[v & 15]; }
inline int hexVal(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
inline uint8_t rawTotalFor(size_t len, size_t pieceLen = CHUNK_RAW_LEN) { size_t t = (len + pieceLen - 1) / pieceLen; return (uint8_t)(t < 1 ? 1 : t); }
// one fast piece (idx 1-based); the id is always 8 characters (padded)
inline String rawPiece(char type, const String& id, uint8_t idx, uint8_t total, const String& full, size_t pieceLen = CHUNK_RAW_LEN) {
  String p; p.reserve(RAW_HDR_LEN + CHUNK_RAW_LEN + 1);
  p += "AM"; p += type; p += '#';
  for (int i = 0; i < 8; i++) p += i < (int)id.length() ? id[i] : '_';
  p += hexDigit(idx - 1); p += hexDigit(total - 1);
  size_t from = (size_t)(idx - 1) * pieceLen, to = from + pieceLen;
  if (to > full.length()) to = full.length();
  if (from < to) p += full.substring(from, to);
  return p;
}
// flag (firmware 2026-10-29a, optional 17th character - older boards simply ignore it):
//   'P' = Heltec 1 has handed this payload to the command center (the Pi is answering on USB)
//   '-' = Heltec 1 has the payload but the Pi is NOT reachable right now - it is kept and handed over when the Pi is
//         back, and the sender must keep it too (a request may never be dropped because only the radio confirmed it)
#define ACK_FLAG_PI_OK   'P'
#define ACK_FLAG_PI_DOWN '-'
inline String maskAckPacket(const String& id, uint32_t mask, char flag = 0) {
  String p = "AMK#";
  for (int i = 0; i < 8; i++) p += i < (int)id.length() ? id[i] : '_';
  for (int s = 12; s >= 0; s -= 4) p += hexDigit((mask >> s) & 15);
  if (flag) p += flag;
  return p;
}
inline String rawIdOf(const uint8_t* buf) { char b[9]; memcpy(b, buf + 4, 8); b[8] = 0; String s(b); while (s.length() && s[s.length() - 1] == '_') s.remove(s.length() - 1); return s; }

// ---- WEAK LINK (2026-10-21) --------------------------------------------------------------------------------------
// At 100 m the 200-byte pieces (about 2 s on the air each) kept getting lost while short packets still came through:
// the longer a packet, the more likely one bad moment spoils it. Each board measures how well it hears the other side
// (SNR of every packet) and notices lost pieces; on a weak link payloads are cut into SHORT pieces (CHUNK_RAW_WEAK,
// about 0.8 s each) - only a short piece has to be sent again - and Heltec 1 repeats its old records less often, so
// the channel stays free for the field. The receiver just joins the pieces, whatever their size.
#define CHUNK_RAW_WEAK    80
#define LINK_WEAK_SNR     -5.0f      // SF10 still decodes at about -15 dB; below -5 dB long packets start to get lost
#define LINK_WEAK_HOLD_MS 300000UL   // a lost piece keeps the short pieces on for 5 minutes
struct LinkQuality {
  float rssi = 0, snr = 0, snrAvg = 0;
  uint32_t heardAt = 0, lossAt = 0, packets = 0, losses = 0;
  void heard(float r, float s) {
    rssi = r; snr = s;
    snrAvg = packets ? snrAvg * 0.7f + s * 0.3f : s;
    packets++;
    uint32_t m = millis(); heardAt = m ? m : 1;
  }
  void lost() { uint32_t m = millis(); lossAt = m ? m : 1; losses++; }
  bool weak() const {
    uint32_t now = millis();
    if (lossAt && now - lossAt < LINK_WEAK_HOLD_MS) return true;
    return heardAt && now - heardAt < 120000UL && snrAvg < LINK_WEAK_SNR;
  }
  // a word for the screens: "good" / "fair" / "weak" (and "-" before anything was heard)
  const char* word() const { return !heardAt ? "-" : weak() ? "weak" : snrAvg < 0 ? "fair" : "good"; }
};
// the piece size for a payload of `len` bytes (a payload too long for 16 short pieces keeps the normal size)
inline size_t pieceLenFor(size_t len, bool weak) {
  return weak && len > CHUNK_RAW_WEAK && len <= 16 * CHUNK_RAW_WEAK ? CHUNK_RAW_WEAK : CHUNK_RAW_LEN;
}

#define CHUNK_ID_LEN     9      // 8 chars + null
#define MAX_LORA_PACKET  220    // stay well under the SX1262's 255-byte hard cap

#define ACK_TIMEOUT_MS   1500   // generous for SF10; range test showed airtime is short
#define MAX_RETRIES      4

// ---------------------------------------------------------------- RF front end
// V4.2 uses GC1109, V4.3 uses KCT8103L - auto-detected the same way the
// range-test sketch does, so both roles behave correctly on either revision.
inline bool femIsKCT_detect() {
  pinMode(PIN_FEM_POWER, OUTPUT);
  digitalWrite(PIN_FEM_POWER, HIGH);
  delay(2);
  pinMode(PIN_FEM_CSD, INPUT);
  delay(2);
  bool isKct = digitalRead(PIN_FEM_CSD) == HIGH;
  pinMode(PIN_FEM_CSD, OUTPUT);
  digitalWrite(PIN_FEM_CSD, HIGH);
  pinMode(isKct ? PIN_KCT_CTX : PIN_GC1109_CPS, OUTPUT);
  return isKct;
}

// ============================ CHUNK REASSEMBLY (generic, C++ side) ============================
// Small fixed-size table of in-flight reassemblies - LoRa is slow enough
// that only a handful of chunked messages are ever "in the air" at once.
#define MAX_INFLIGHT_CHUNKS 6

struct ChunkSlot {
  bool     used = false;
  char     id[CHUNK_ID_LEN] = {0};
  uint8_t  total = 0;
  uint32_t haveMask = 0;          // bit i set => part i+1 received
  String   parts[16];             // up to 16 * 90 chars = 1440 char payload ceiling
  uint32_t firstSeenAt = 0;
};

class ChunkReassembler {
 public:
  // true when the last feed() was a piece of a payload that was already completed in the last 2 minutes (the sender
  // did not get our ACK / our echo and sent it again) - it is NOT handed out a second time
  bool lastWasDuplicate = false;

  // Feed one chunk in. Returns the fully reassembled JSON string once every
  // part has arrived, or "" if still incomplete / this chunk id already
  // finished earlier (duplicate). Also expires stale in-flight slots so a
  // lost final part can't wedge a slot forever.
  String feed(const char* id, uint8_t idx, uint8_t total, const String& data) {
    expireStale();
    lastWasDuplicate = false;
    if (total == 0 || total > 16 || idx == 0 || idx > total) return "";
    // a resent piece of a finished payload used to open a new slot that could never complete (only that piece came
    // again) - six of those and every new request was dropped
    if (recentlyDone(id)) { lastWasDuplicate = true; return ""; }

    int slot = findOrCreate(id, total);
    if (slot < 0) return "";

    uint32_t bit = 1UL << (idx - 1);
    if (!(slots_[slot].haveMask & bit)) {
      slots_[slot].haveMask |= bit;
      slots_[slot].parts[idx - 1] = data;
    }

    uint32_t fullMask = (total >= 32) ? 0xFFFFFFFFUL : ((1UL << total) - 1);
    if ((slots_[slot].haveMask & fullMask) != fullMask) return "";

    String full;
    for (uint8_t i = 0; i < total; i++) full += slots_[slot].parts[i];
    slots_[slot].used = false; // free the slot, reassembly complete
    for (uint8_t i = 0; i < total; i++) slots_[slot].parts[i] = "";
    markDone(id);
    return full;
  }

  // which pieces of payload `id` are here (bit 0 = piece 1): all bits once it was completed, 0 when unknown
  uint32_t maskFor(const char* id) {
    if (recentlyDone(id)) return 0xFFFFFFFFUL;
    for (auto& s : slots_) if (s.used && strncmp(s.id, id, CHUNK_ID_LEN - 1) == 0) return s.haveMask;
    return 0;
  }

 private:
  ChunkSlot slots_[MAX_INFLIGHT_CHUNKS];
  #define CHUNK_DONE_KEEP 8
  char doneIds_[CHUNK_DONE_KEEP][CHUNK_ID_LEN] = {{0}};
  uint32_t doneAt_[CHUNK_DONE_KEEP] = {0};
  uint8_t doneNext_ = 0;

  bool recentlyDone(const char* id) {
    for (int i = 0; i < CHUNK_DONE_KEEP; i++)
      if (doneAt_[i] && millis() - doneAt_[i] < 120000UL && strncmp(doneIds_[i], id, CHUNK_ID_LEN - 1) == 0) return true;
    return false;
  }
  void markDone(const char* id) {
    strncpy(doneIds_[doneNext_], id, CHUNK_ID_LEN - 1); doneIds_[doneNext_][CHUNK_ID_LEN - 1] = 0;
    uint32_t m = millis(); doneAt_[doneNext_] = m ? m : 1;   // (not "| 1": 1 ms in the future makes millis() - doneAt wrap around)
    doneNext_ = (doneNext_ + 1) % CHUNK_DONE_KEEP;
  }

  void expireStale() {
    uint32_t now = millis();
    for (auto& s : slots_) {
      // 2 minutes: a request sent piece by piece over a busy channel (with retries) can take well over 20 s
      if (s.used && (now - s.firstSeenAt) > 120000UL) s.used = false;
    }
  }

  int findOrCreate(const char* id, uint8_t total) {
    for (int i = 0; i < MAX_INFLIGHT_CHUNKS; i++) {
      if (!slots_[i].used || strncmp(slots_[i].id, id, CHUNK_ID_LEN - 1) != 0) continue;
      // the sender cut the payload again into shorter pieces (weak link): the pieces of the old cut do not fit
      if (slots_[i].total != total) {
        slots_[i].total = total; slots_[i].haveMask = 0;
        for (auto& p : slots_[i].parts) p = "";
      }
      return i;
    }
    int pick = -1;
    for (int i = 0; i < MAX_INFLIGHT_CHUNKS; i++) if (!slots_[i].used) { pick = i; break; }
    // table full (pieces of payloads that never completed): the oldest one makes room - before, the NEW payload was dropped
    if (pick < 0) { pick = 0; for (int i = 1; i < MAX_INFLIGHT_CHUNKS; i++) if (slots_[i].firstSeenAt < slots_[pick].firstSeenAt) pick = i; }
    slots_[pick].used = true;
    strncpy(slots_[pick].id, id, CHUNK_ID_LEN - 1);
    slots_[pick].id[CHUNK_ID_LEN - 1] = 0;
    slots_[pick].total = total;
    slots_[pick].haveMask = 0;
    slots_[pick].firstSeenAt = millis();
    for (auto& p : slots_[pick].parts) p = "";
    return pick;
  }
};

// Generates short, collision-resistant chunk ids from millis()+a counter.
inline void makeChunkId(char* out) {
  static uint16_t ctr = 0;
  ctr++;
  uint32_t v = (millis() & 0xFFFFF) ^ ((uint32_t)ctr << 20);
  const char* alphabet = "0123456789abcdefghijklmnopqrstuv";
  for (int i = 7; i >= 0; i--) { out[i] = alphabet[v & 31]; v >>= 5; }
  out[8] = 0;
}
