// LAN web control for Monoprice (and clone) multizone amplifiers that share
// the `?`/`<`/`#>` RS-232 protocol. The active model is selected by the MODEL
// env var (see PROFILES below; default monoprice-6 / MPR-6ZHMAUT).
// Runs on any host with the USB-serial adapter attached, serves a web UI,
// and exposes a small JSON API. All serial writes go through a paced queue
// so we never overrun the amp's 9600-baud link.
const path = require("path");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const express = require("express");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
// Pure protocol/profile data + helpers (dependency-free, unit-tested in test/).
const { PROFILES, SOCKET_RE, zoneIdsFor, statusReFor, zoneReFor, attrsFor } = require("./lib/protocol");
const { validateConfigPatch } = require("./lib/validate");

// Load a local .env if present so `npm start` and the installed service honor
// it. Optional: if dotenv isn't installed yet, fall back to ambient env vars.
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch {}

// `node server.js --probe` lists candidate serial ports and exits (no server,
// no port opened). `--plain` prints just the paths, for setup.sh to consume.
if (process.argv.slice(2).includes("--probe")) {
  runProbe(process.argv.slice(2).includes("--plain")).then(
    () => process.exit(0),
    () => process.exit(1)
  );
  return;
}

const DEVICE = process.env.DEVICE || "/dev/cu.usbserial-210";

// ---- Model profiles ------------------------------------------------------
// PROFILES + protocol helpers live in ./lib/protocol (pure, dependency-free,
// unit-tested). Everything below derives from the MODEL-selected profile; the
// monoprice-6 default keeps existing deploys unaffected. Only monoprice-6 is
// hardware-tested — the rest are from documented specs (openHAB + pyxantech).
const MODEL = PROFILES[process.env.MODEL] ? process.env.MODEL : "monoprice-6";
if (process.env.MODEL && !PROFILES[process.env.MODEL]) {
  console.error(`[model] unknown MODEL "${process.env.MODEL}"; using ${MODEL}. Known: ${Object.keys(PROFILES).join(", ")}`);
}
const PROFILE = PROFILES[MODEL];
const EOL = PROFILE.eol;
console.log(`[model] ${MODEL} — ${PROFILE.label}`);
// The `<amp><zone>` protocol addresses are single-digit (e.g. 11..36), so a
// profile with 10+ zones/amp or 10+ amps can't be represented. Guard here so a
// future profile edit fails loudly instead of silently producing bad zone IDs.
if (PROFILE.zonesPerAmp > 9 || PROFILE.maxAmps > 9) {
  console.error(`[model] ${MODEL}: zonesPerAmp/maxAmps > 9 is not representable in the single-digit protocol; zone IDs would be wrong.`);
}

const BAUD = parseInt(process.env.BAUD || String(PROFILE.baud), 10);
const HTTP_PORT = parseInt(process.env.PORT || "8080", 10);
const AMP_COUNT = Math.min(PROFILE.maxAmps, Math.max(1, parseInt(process.env.AMP_COUNT || "1", 10)));
const POLL_MS = parseInt(process.env.POLL_MS || "5000", 10);
const CMD_GAP_MS = parseInt(process.env.CMD_GAP_MS || "120", 10);
// mDNS: advertise <MDNS_NAME>.local so the app is reachable by a friendly
// name without renaming the host. Set MDNS_NAME="" to disable.
const MDNS_NAME = process.env.MDNS_NAME === undefined ? "multizone" : process.env.MDNS_NAME;

// ---- Shared config (names, icons, presets) persisted on disk -------------
// Stored next to server.js so it survives restarts and code re-syncs. This
// is the single source of truth shared by every device on the LAN.
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
const DEFAULT_CONFIG = {
  title: "Amp Control",
  zoneNames: {},
  sourceNames: Array.from({ length: PROFILE.sources }, (_, i) => `Source ${i + 1}`),
  sourceIcons: ["music", "tv", "radio", "airplay", "bluetooth", "disc", "speaker", "podcast"].slice(0, PROFILE.sources),
  presets: [],
  activeScene: null,
  disabledZones: [],
  disabledSources: [],
  zoneIcons: {},
  settingsPin: "",
};
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

let config;
function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}
loadConfig();

// Persistence is debounced + async so a burst of PUTs doesn't block the event
// loop on synchronous disk writes. A pending write is flushed synchronously on
// shutdown (see shutdown()) so the last change is never lost. Writes go to a
// temp file and are atomically renamed into place, so a crash mid-write can
// never leave a truncated/corrupt config.json (the app's only persistent state).
const CONFIG_TMP = CONFIG_PATH + ".tmp";
let saveTimer = null;
let savePending = false;
function saveConfig() {
  savePending = true;
  if (!saveTimer) saveTimer = setTimeout(flushConfig, 200);
}
function flushConfig() {
  saveTimer = null;
  if (!savePending) return;
  savePending = false;
  fs.writeFile(CONFIG_TMP, JSON.stringify(config, null, 2), (e) => {
    if (e) return console.error("[config] save failed:", e.message);
    fs.rename(CONFIG_TMP, CONFIG_PATH, (e2) => { if (e2) console.error("[config] rename failed:", e2.message); });
  });
}
function flushConfigSync() {
  if (!savePending) return;
  savePending = false;
  try {
    fs.writeFileSync(CONFIG_TMP, JSON.stringify(config, null, 2));
    fs.renameSync(CONFIG_TMP, CONFIG_PATH);
  } catch (e) { console.error("[config] final save failed:", e.message); }
}

// Settable attribute metadata for the active profile (protocol code -> meta).
const ATTRS = attrsFor(PROFILE);

function zoneIds() {
  return zoneIdsFor(PROFILE, AMP_COUNT);
}

// ---- Serial layer --------------------------------------------------------
const state = {
  connected: false,
  lastError: null,
  lastRx: 0,
  zones: {}, // "11" -> {zone,pa,pr,mu,dt,vo,tr,bs,bl,ch,ls}
};

// DEVICE may be a serial path (/dev/ttyUSB0, /dev/cu.usbserial-*) or a
// serial-over-IP bridge URL (socket://host:port, also tcp://). node-serialport
// has no native socket transport, but a net.Socket is a duplex stream just like
// a SerialPort, so the parser pipe and write queue below are transport-agnostic.
const isNetworkDevice = SOCKET_RE.test(DEVICE);

let port = null;
let serialOpen = false; // readiness for the SerialPort transport
let socketOpen = false; // readiness for the net.Socket transport
let connecting = false; // gate so the reconnect interval doesn't stack opens
let writeQueue = [];
let draining = false;

// A single readiness flag per transport (rather than trusting port.isOpen)
// means an `error` event that leaves the handle half-open still reads as "not
// ready", so the reconnect interval takes over instead of polling a dead link.
function portReady() {
  return !!port && (isNetworkDevice ? socketOpen : serialOpen);
}

let drainGen = 0; // bumped to invalidate an in-flight drain loop

// On disconnect, drop anything still queued (a queued volume/source change is
// stale by the time the link returns) AND release the drain lock. This is
// important: a paced write's flush callback may never fire once the handle is
// destroyed, which would otherwise leave `draining` stuck true and silently
// wedge the queue forever — even after reconnect. Bumping drainGen also makes
// any late callback from the old loop a no-op instead of a second live loop.
function clearQueue() {
  writeQueue = [];
  draining = false;
  drainGen++;
}

function enqueue(cmd) {
  writeQueue.push(cmd);
  drain();
}

function drain() {
  if (draining) return;
  draining = true;
  const gen = ++drainGen;
  const step = () => {
    if (gen !== drainGen) return; // superseded (disconnect/reset); stop quietly
    const cmd = writeQueue.shift();
    if (!cmd || !portReady()) {
      draining = false;
      return;
    }
    const buf = Buffer.from(cmd + EOL, "latin1");
    // Pace by waiting until each command flushes: SerialPort.drain() vs the
    // net.Socket write callback. Same effect, different stream API.
    if (isNetworkDevice) port.write(buf, () => setTimeout(step, CMD_GAP_MS));
    else { port.write(buf); port.drain(() => setTimeout(step, CMD_GAP_MS)); }
  };
  step();
}

// status line: <statusPrefix> + 11 two-digit fields
const STATUS_RE = statusReFor(PROFILE.statusPrefix);

function handleLine(line) {
  state.lastRx = Date.now();
  const clean = line.replace(/[\r\n]+/g, "");
  if (clean.startsWith("Command Error")) {
    state.lastError = "Amp returned: Command Error.";
    return;
  }
  const m = clean.match(STATUS_RE);
  if (!m) return;
  const z = m[1];
  state.zones[z] = {
    zone: z,
    pa: m[2], pr: m[3], mu: m[4], dt: m[5], vo: m[6],
    tr: m[7], bs: m[8], bl: m[9], ch: m[10], ls: m[11],
  };
}

// Both transports are duplex streams, so line parsing is identical.
function attachParser(stream) {
  stream.pipe(new ReadlineParser({ delimiter: "\n", encoding: "latin1" })).on("data", handleLine);
}

function openPort() {
  connecting = true;
  if (isNetworkDevice) openSocket();
  else openSerial();
}

function openSerial() {
  serialOpen = false;
  port = new SerialPort(
    { path: DEVICE, baudRate: BAUD, dataBits: 8, parity: "none", stopBits: 1, rtscts: false, autoOpen: false },
    () => {}
  );
  attachParser(port);

  port.on("open", () => {
    connecting = false;
    serialOpen = true;
    state.connected = true;
    state.lastError = null;
    console.log(`[serial] open ${DEVICE} @ ${BAUD}`);
    try { port.set({ dtr: true, rts: true }, () => {}); } catch {}
    pollAll();
  });
  port.on("close", () => { serialOpen = false; state.connected = false; clearQueue(); console.log("[serial] closed"); });
  port.on("error", (e) => {
    serialOpen = false;
    connecting = false;
    state.connected = false;
    state.lastError = e.message;
    clearQueue();
    console.error("[serial] error:", e.message, "- will retry");
  });

  // Reconnection is handled by the periodic interval (gated by `connecting`),
  // so a failed open just needs to release the gate.
  port.open((err) => {
    if (err) {
      connecting = false;
      serialOpen = false;
      state.connected = false;
      state.lastError = err.message;
      console.error("[serial] open failed:", err.message, "- will retry");
    }
  });
}

// Serial-over-IP: connect a raw TCP socket to a ser2net / USR-TCP232 bridge.
// Reconnection is handled by the periodic interval (gated by `connecting`).
function openSocket() {
  const m = DEVICE.match(SOCKET_RE);
  const host = m[1].replace(/^\[|\]$/g, ""); // strip [...] for IPv6 literals
  const tcpPort = parseInt(m[2], 10);
  socketOpen = false;
  port = new net.Socket();
  attachParser(port);

  port.on("connect", () => {
    connecting = false;
    socketOpen = true;
    state.connected = true;
    state.lastError = null;
    console.log(`[serial] connected ${DEVICE}`);
    pollAll();
  });
  port.on("close", () => { socketOpen = false; state.connected = false; clearQueue(); console.log("[serial] socket closed"); });
  port.on("error", (e) => {
    connecting = false;
    socketOpen = false;
    state.connected = false;
    state.lastError = e.message;
    clearQueue();
    console.error("[serial] socket error:", e.message, "- will retry");
    try { port.destroy(); } catch {}
  });

  port.connect(tcpPort, host);
}

function pollAll() {
  for (let amp = 1; amp <= AMP_COUNT; amp++) enqueue(`?${amp}0`);
}

// ---- HTTP API ------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));
// No CORS: the UI is served from this same origin, so it never needs cross-
// origin access. Advertising `Access-Control-Allow-Origin: *` would instead let
// any web page the user visits script the amp through their browser.
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    connected: state.connected,
    device: DEVICE,
    transport: isNetworkDevice ? "tcp" : "serial",
    baud: BAUD,
    model: MODEL,
    modelLabel: PROFILE.label,
    zonesPerAmp: PROFILE.zonesPerAmp,
    sources: PROFILE.sources,
    ampCount: AMP_COUNT,
    lastError: state.lastError,
    secondsSinceRx: state.lastRx ? Math.round((Date.now() - state.lastRx) / 1000) : null,
    zonesKnown: Object.keys(state.zones).length,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get("/api/zones", (req, res) => {
  const order = zoneIds();
  res.json(order.filter((z) => state.zones[z]).map((z) => state.zones[z]));
});

app.get("/api/zones/:zone", (req, res) => {
  const z = state.zones[req.params.zone];
  if (!z) return res.status(404).json({ error: "zone unknown (not polled yet)" });
  res.json(z);
});

// POST /api/zones/:zone  body: { power:0|1, volume:0-38, source:1-6, mute:0|1, ... }
// Accepts friendly names or raw 2-letter codes.
const NAME_TO_CODE = Object.fromEntries(
  Object.entries(ATTRS).map(([code, m]) => [m.name, code])
);

const ZONE_RE = zoneReFor(AMP_COUNT, PROFILE.zonesPerAmp);
app.post("/api/zones/:zone", (req, res) => {
  const zone = req.params.zone;
  if (!ZONE_RE.test(zone)) return res.status(400).json({ error: "bad zone id" });
  const applied = [];
  for (const [key, rawVal] of Object.entries(req.body || {})) {
    const code = ATTRS[key] ? key : NAME_TO_CODE[key];
    if (!code) continue;
    const meta = ATTRS[code];
    let v = parseInt(rawVal, 10);
    if (Number.isNaN(v)) continue;
    v = Math.max(meta.min, Math.min(meta.max, v));
    const vv = String(v).padStart(2, "0");
    enqueue(`<${zone}${code.toUpperCase()}${vv}`);
    applied.push({ [meta.name]: v });
  }
  // refresh this zone shortly after applying
  enqueue(`?${zone}`);
  res.json({ zone, applied });
});

app.post("/api/poll", (req, res) => { pollAll(); res.json({ ok: true }); });

// ---- Shared config API ---------------------------------------------------
// The PIN itself is never sent to clients; we expose only whether one is set.
function publicConfig() {
  const { settingsPin, ...rest } = config;
  return {
    ...rest,
    settingsPinSet: !!settingsPin,
    model: MODEL,
    profile: {
      label: PROFILE.label,
      zonesPerAmp: PROFILE.zonesPerAmp,
      maxAmps: PROFILE.maxAmps,
      ampCount: AMP_COUNT,
      sources: PROFILE.sources,
      volMax: PROFILE.volMax,
      toneMax: PROFILE.toneMax,
      balMax: PROFILE.balMax,
    },
  };
}

// Keys that require the PIN to change once one is set. Operational keys
// (presets, activeScene) stay open so anyone on the LAN can apply scenes.
const PROTECTED = [
  "title", "zoneNames", "sourceNames", "sourceIcons",
  "zoneIcons", "disabledZones", "disabledSources", "settingsPin",
];

// (Body shape validation lives in ./lib/validate — validateConfigPatch.)

// PIN: constant-time compare, plus a small per-IP lockout so the verify
// endpoint can't be used as a fast brute-force oracle. (The PIN guards against
// accidental edits on a trusted LAN — it is not a substitute for network
// security; see the README.)
function pinMatches(input) {
  const stored = config.settingsPin;
  if (!stored) return false;
  const a = Buffer.from(String(input == null ? "" : input));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const failByIp = new Map(); // ip -> { count, until, ts }
const LOCK_AFTER = 5;
const LOCK_MS = 30000;
const FAIL_TTL_MS = 10 * 60 * 1000; // forget idle records after 10 min
function clientIp(req) { return req.ip || (req.socket && req.socket.remoteAddress) || "?"; }
// Drop stale entries so a stream of distinct client IPs can't grow the map
// without bound. Cheap (only runs on PIN activity, capped work per call).
function pruneFails(now) {
  for (const [ip, r] of failByIp) {
    if (r.until <= now && now - r.ts > FAIL_TTL_MS) failByIp.delete(ip);
  }
}
function pinLocked(req) {
  const r = failByIp.get(clientIp(req));
  return !!(r && r.until > Date.now());
}
function notePinResult(req, ok) {
  const ip = clientIp(req);
  const now = Date.now();
  pruneFails(now);
  if (ok) { failByIp.delete(ip); return; }
  const r = failByIp.get(ip) || { count: 0, until: 0, ts: now };
  r.count++;
  r.ts = now;
  if (r.count >= LOCK_AFTER) { r.until = now + LOCK_MS; r.count = 0; }
  failByIp.set(ip, r);
}
function pinOk(req) {
  return !config.settingsPin || pinMatches(req.get("X-Settings-Pin"));
}

app.get("/api/config", (req, res) => res.json(publicConfig()));

// Verify a PIN without changing anything; used to unlock Settings client-side.
app.post("/api/unlock", (req, res) => {
  if (pinLocked(req)) return res.status(429).json({ error: "too many attempts; try again shortly" });
  const ok = pinMatches(req.body && req.body.pin);
  notePinResult(req, ok);
  res.json({ ok });
});

app.put("/api/config", (req, res) => {
  const body = req.body || {};
  const valid = validateConfigPatch(body, CONFIG_KEYS);
  if (!valid.ok) return res.status(400).json({ error: `invalid value for ${valid.key}` });
  const changesProtected = PROTECTED.some(
    (k) => k in body && JSON.stringify(body[k]) !== JSON.stringify(config[k])
  );
  if (changesProtected && config.settingsPin) {
    if (pinLocked(req)) return res.status(429).json({ error: "too many attempts; try again shortly" });
    const ok = pinOk(req);
    notePinResult(req, ok);
    if (!ok) return res.status(403).json({ error: "settings are PIN-protected" });
  }
  for (const k of CONFIG_KEYS) if (k in body) config[k] = body[k];
  saveConfig();
  res.json(publicConfig());
});

// JSON error handler so malformed bodies / oversized payloads return JSON
// (not express's default HTML) with a sensible status.
app.use((err, req, res, next) => {
  if (!err) return next();
  const status = err.status || err.statusCode || 400;
  console.error("[http] request error:", err.message);
  res.status(status).json({ error: status === 413 ? "request body too large" : "bad request" });
});

// ---- mDNS advertising ----------------------------------------------------
// Publishes an _http._tcp service whose host is <MDNS_NAME>.local, which
// makes the browser-resolvable A record for that name. Best-effort only:
// any failure here must never affect serial control.
let bonjourInstance = null;
function advertiseMdns() {
  if (!MDNS_NAME) return;
  try {
    const { Bonjour } = require("bonjour-service");
    // The mDNS multicast socket can throw asynchronously (e.g. EADDRNOTAVAIL
    // during a network transition). By default bonjour-service rethrows that
    // from a socket callback, which is an UNCAUGHT exception that kills the
    // whole process — taking serial control down with it. Pass an errorCallback
    // so the transport error is logged and swallowed instead.
    bonjourInstance = new Bonjour(undefined, (err) => {
      console.error("[mdns] transport error (ignored):", err && err.message);
    });
    const service = bonjourInstance.publish({
      name: "Amp Control",
      type: "http",
      port: HTTP_PORT,
      host: `${MDNS_NAME}.local`,
    });
    if (service && service.on) service.on("error", (e) => console.error("[mdns] publish error (ignored):", e && e.message));
    console.log(`[mdns] advertising http://${MDNS_NAME}.local:${HTTP_PORT}`);
  } catch (e) {
    console.error("[mdns] disabled:", e.message);
  }
}

// ---- Graceful shutdown ---------------------------------------------------
// Flush any pending config write synchronously and tear down mDNS, then exit
// so launchd/systemd can restart cleanly.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  flushConfigSync();
  const done = () => process.exit(0);
  try {
    if (bonjourInstance) bonjourInstance.unpublishAll(() => { try { bonjourInstance.destroy(); } catch {} done(); });
    else done();
  } catch { done(); }
  setTimeout(done, 1500).unref(); // safety net if mDNS teardown hangs
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---- Startup (only when run directly, not when required by tests) --------
if (require.main === module) {
  // Periodic refresh keeps the cache live and reconnects if the port died.
  setInterval(() => {
    if (portReady()) pollAll();
    else if (!draining && !connecting) openPort();
  }, POLL_MS);

  app.listen(HTTP_PORT, "0.0.0.0", () => {
    console.log(`[http] amp-control on http://0.0.0.0:${HTTP_PORT}`);
    openPort();
    advertiseMdns();
  });
}

// ---- Port probe (--probe) ------------------------------------------------
// Lists serial ports, preferring likely USB-serial adapters, so setup.sh (or a
// human) can pick a DEVICE. `--plain` prints just the paths for scripting.
async function runProbe(plain) {
  let ports = [];
  try {
    ports = await SerialPort.list();
  } catch (e) {
    if (!plain) console.error("[probe] port list failed:", e.message);
  }
  // macOS: /dev/cu.usbserial-*, /dev/cu.usbmodem*; Linux/Pi: /dev/ttyUSB*,
  // /dev/ttyACM*, /dev/ttyAMA*. Fall back to all ports if nothing matches.
  const looksUsbSerial = (p) =>
    /usbserial|usbmodem|ttyUSB|ttyACM|ttyAMA|cu\.usb|tty\.usb/i.test(p.path || "");
  const candidates = ports.filter(looksUsbSerial);
  const list = candidates.length ? candidates : ports;

  if (plain) {
    for (const p of list) console.log(p.path);
    return;
  }

  if (!list.length) {
    console.log("No serial ports found. Is the USB-serial adapter plugged in?");
    console.log("Serial-over-IP still works without a local adapter, e.g.:");
    console.log("  DEVICE=socket://192.168.1.50:4001 npm start");
    return;
  }
  console.log(candidates.length ? "Likely amp serial ports:" : "Serial ports (no obvious USB-serial adapter):");
  list.forEach((p, i) => {
    console.log(`  [${i}] ${p.path}  vid=${p.vendorId || "?"} pid=${p.productId || "?"} mfg=${p.manufacturer || "?"}`);
  });
  console.log(`\nStart with one, e.g.:  DEVICE=${list[0].path} npm start`);
  console.log("Or a serial-over-IP bridge:  DEVICE=socket://192.168.1.50:4001 npm start");
}

// The Express app is exported for integration tests (test/api.test.js). Thanks
// to the require.main guard above, requiring this file does not start listening
// or open the serial port.
module.exports = { app };

