// LAN web control for Monoprice (and clone) multizone amplifiers that share
// the `?`/`<`/`#>` RS-232 protocol. The active model is selected by the MODEL
// env var (see PROFILES below; default monoprice-6 / MPR-6ZHMAUT).
// Runs on any host with the USB-serial adapter attached, serves a web UI,
// and exposes a small JSON API. All serial writes go through a paced queue
// so we never overrun the amp's 9600-baud link.
const path = require("path");
const fs = require("fs");
const net = require("net");
const express = require("express");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

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
// Every supported amp speaks the SAME `?`/`<`/`#>` protocol; only these
// hardware dimensions differ, so a model is pure data, not logic. Pick one
// with the MODEL env var. Default is monoprice-6 (the original MPR-6ZHMAUT) so
// existing deploys are unaffected.
//   zonesPerAmp  number of zones per unit; drives the 11-1N/21-2N/31-3N math
//   maxAmps      how many units can be linked
//   sources      number of inputs (protocol "ch" field max)
//   volMax/toneMax/balMax  inclusive upper bound of each 2-digit field
//   statusPrefix prefix of a status reply line ("#>")
//   eol          command line terminator ("\r")
//
// Only monoprice-6 has been tested on real hardware. The rest are built from
// documented specs (openHAB monopriceaudio binding + pyxantech) and are
// UNVERIFIED — community confirmation welcome. The 70V 31028 is intentionally
// absent: it uses a different command syntax (logic, not just data), like the
// Xantech family, so it is out of scope here.
const BASE_PROFILE = { baud: 9600, statusPrefix: "#>", volMax: 38, toneMax: 14, balMax: 20, eol: "\r" };
const PROFILES = {
  "monoprice-6":     { ...BASE_PROFILE, label: "Monoprice MPR-6ZHMAUT (10761), 6-zone", zonesPerAmp: 6, maxAmps: 3, sources: 6 },
  "monoprice-8":     { ...BASE_PROFILE, label: "Monoprice 44518, 8-zone",               zonesPerAmp: 8, maxAmps: 3, sources: 6 },
  "monoprice-4":     { ...BASE_PROFILE, label: "Monoprice 44519, 4-zone",               zonesPerAmp: 4, maxAmps: 3, sources: 6 },
  "monoprice-39261": { ...BASE_PROFILE, label: "Monoprice 39261 passive matrix, 6-zone", zonesPerAmp: 6, maxAmps: 3, sources: 6 },
  "dayton-dax66":    { ...BASE_PROFILE, label: "Dayton Audio DAX66, 6-zone",            zonesPerAmp: 6, maxAmps: 3, sources: 6 },
};
const MODEL = PROFILES[process.env.MODEL] ? process.env.MODEL : "monoprice-6";
if (process.env.MODEL && !PROFILES[process.env.MODEL]) {
  console.error(`[model] unknown MODEL "${process.env.MODEL}"; using ${MODEL}. Known: ${Object.keys(PROFILES).join(", ")}`);
}
const PROFILE = PROFILES[MODEL];
const EOL = PROFILE.eol;
console.log(`[model] ${MODEL} — ${PROFILE.label}`);

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
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("[config] save failed:", e.message);
  }
}
loadConfig();

// Attribute metadata: protocol field -> {min,max} and friendly name.
const ATTRS = {
  pr: { name: "power", min: 0, max: 1 },
  mu: { name: "mute", min: 0, max: 1 },
  dt: { name: "dnd", min: 0, max: 1 },
  vo: { name: "volume", min: 0, max: PROFILE.volMax },
  tr: { name: "treble", min: 0, max: PROFILE.toneMax },
  bs: { name: "bass", min: 0, max: PROFILE.toneMax },
  bl: { name: "balance", min: 0, max: PROFILE.balMax },
  ch: { name: "source", min: 1, max: PROFILE.sources },
  pa: { name: "pa", min: 0, max: 1 },
};

function zoneIds() {
  const ids = [];
  for (let amp = 1; amp <= AMP_COUNT; amp++)
    for (let z = 1; z <= PROFILE.zonesPerAmp; z++) ids.push(`${amp}${z}`);
  return ids;
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
const SOCKET_RE = /^(?:socket|tcp):\/\/(\[[^\]]+\]|[^:/]+):(\d+)\/?$/i;
const isNetworkDevice = SOCKET_RE.test(DEVICE);

let port = null;
let socketOpen = false; // tracks readiness for the net.Socket transport
let connecting = false; // gate so the reconnect interval doesn't stack opens
let writeQueue = [];
let draining = false;

function portReady() {
  return !!port && (isNetworkDevice ? socketOpen : port.isOpen);
}

function enqueue(cmd) {
  writeQueue.push(cmd);
  drain();
}

function drain() {
  if (draining) return;
  draining = true;
  const step = () => {
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
const STATUS_RE = new RegExp(
  PROFILE.statusPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d{2})".repeat(11)
);

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

function openPort() {
  connecting = true;
  if (isNetworkDevice) openSocket();
  else openSerial();
}

function openSerial() {
  port = new SerialPort(
    { path: DEVICE, baudRate: BAUD, dataBits: 8, parity: "none", stopBits: 1, rtscts: false, autoOpen: false },
    () => {}
  );
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n", encoding: "latin1" }));
  parser.on("data", handleLine);

  port.on("open", () => {
    connecting = false;
    state.connected = true;
    state.lastError = null;
    console.log(`[serial] open ${DEVICE} @ ${BAUD}`);
    try { port.set({ dtr: true, rts: true }, () => {}); } catch {}
    pollAll();
  });
  port.on("close", () => { state.connected = false; console.log("[serial] closed"); });
  port.on("error", (e) => {
    state.connected = false;
    state.lastError = e.message;
    console.error("[serial] error:", e.message);
  });

  port.open((err) => {
    if (err) {
      connecting = false;
      state.connected = false;
      state.lastError = err.message;
      console.error("[serial] open failed:", err.message, "- retrying in 5s");
      setTimeout(openPort, 5000);
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
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n", encoding: "latin1" }));
  parser.on("data", handleLine);

  port.on("connect", () => {
    connecting = false;
    socketOpen = true;
    state.connected = true;
    state.lastError = null;
    console.log(`[serial] connected ${DEVICE}`);
    pollAll();
  });
  port.on("close", () => { socketOpen = false; state.connected = false; console.log("[serial] socket closed"); });
  port.on("error", (e) => {
    connecting = false;
    socketOpen = false;
    state.connected = false;
    state.lastError = e.message;
    console.error("[serial] socket error:", e.message, "- will retry");
    try { port.destroy(); } catch {}
  });

  port.connect(tcpPort, host);
}

function pollAll() {
  for (let amp = 1; amp <= AMP_COUNT; amp++) enqueue(`?${amp}0`);
}

// Periodic refresh keeps the cache live and reconnects if the port died.
setInterval(() => {
  if (portReady()) pollAll();
  else if (!draining && !connecting) openPort();
}, POLL_MS);

// ---- HTTP API ------------------------------------------------------------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
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

const ZONE_RE = new RegExp(`^[1-${AMP_COUNT}][1-${PROFILE.zonesPerAmp}]$`);
app.post("/api/zones/:zone", (req, res) => {
  const zone = req.params.zone;
  if (!ZONE_RE.test(zone)) return res.status(400).json({ error: "bad zone id" });
  const applied = [];
  for (const [key, rawVal] of Object.entries(req.body || {})) {
    const code = ATTRS[key] ? key : NAME_TO_CODE[key];
    if (!code || code === "pa") continue;
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

// Send source of zone 1 to all zones on an amp (PA mode), or query.
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

function pinOk(req) {
  return !config.settingsPin || req.get("X-Settings-Pin") === config.settingsPin;
}

app.get("/api/config", (req, res) => res.json(publicConfig()));

// Verify a PIN without changing anything; used to unlock Settings client-side.
app.post("/api/unlock", (req, res) => {
  const pin = req.body && req.body.pin;
  res.json({ ok: !!config.settingsPin && pin === config.settingsPin });
});

app.put("/api/config", (req, res) => {
  const body = req.body || {};
  const changesProtected = PROTECTED.some(
    (k) => k in body && JSON.stringify(body[k]) !== JSON.stringify(config[k])
  );
  if (changesProtected && !pinOk(req)) {
    return res.status(403).json({ error: "settings are PIN-protected" });
  }
  for (const k of CONFIG_KEYS) if (k in body) config[k] = body[k];
  saveConfig();
  res.json(publicConfig());
});

app.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`[http] amp-control on http://0.0.0.0:${HTTP_PORT}`);
  openPort();
  advertiseMdns();
});

// ---- mDNS advertising ----------------------------------------------------
// Publishes an _http._tcp service whose host is <MDNS_NAME>.local, which
// makes the browser-resolvable A record for that name. Best-effort only:
// any failure here must never affect serial control.
function advertiseMdns() {
  if (!MDNS_NAME) return;
  try {
    const { Bonjour } = require("bonjour-service");
    const bonjour = new Bonjour();
    bonjour.publish({
      name: "Amp Control",
      type: "http",
      port: HTTP_PORT,
      host: `${MDNS_NAME}.local`,
    });
    console.log(`[mdns] advertising http://${MDNS_NAME}.local:${HTTP_PORT}`);
    const shutdown = () => { try { bonjour.unpublishAll(() => bonjour.destroy()); } catch {} };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (e) {
    console.error("[mdns] disabled:", e.message);
  }
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
