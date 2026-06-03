// LAN web control for the Monoprice MPR-6ZHMAUT multizone amplifier.
// Runs on any host with the USB-serial adapter attached, serves a web UI,
// and exposes a small JSON API. All serial writes go through a paced queue
// so we never overrun the amp's 9600-baud link.
const path = require("path");
const fs = require("fs");
const express = require("express");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const DEVICE = process.env.DEVICE || "/dev/cu.usbserial-210";
const BAUD = parseInt(process.env.BAUD || "9600", 10);
const HTTP_PORT = parseInt(process.env.PORT || "8080", 10);
const AMP_COUNT = Math.min(3, Math.max(1, parseInt(process.env.AMP_COUNT || "1", 10)));
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
  sourceNames: ["Source 1", "Source 2", "Source 3", "Source 4", "Source 5", "Source 6"],
  sourceIcons: ["music", "tv", "radio", "airplay", "bluetooth", "disc"],
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
  vo: { name: "volume", min: 0, max: 38 },
  tr: { name: "treble", min: 0, max: 14 },
  bs: { name: "bass", min: 0, max: 14 },
  bl: { name: "balance", min: 0, max: 20 },
  ch: { name: "source", min: 1, max: 6 },
  pa: { name: "pa", min: 0, max: 1 },
};

function zoneIds() {
  const ids = [];
  for (let amp = 1; amp <= AMP_COUNT; amp++)
    for (let z = 1; z <= 6; z++) ids.push(`${amp}${z}`);
  return ids;
}

// ---- Serial layer --------------------------------------------------------
const state = {
  connected: false,
  lastError: null,
  lastRx: 0,
  zones: {}, // "11" -> {zone,pa,pr,mu,dt,vo,tr,bs,bl,ch,ls}
};

let port = null;
let writeQueue = [];
let draining = false;

function enqueue(cmd) {
  writeQueue.push(cmd);
  drain();
}

function drain() {
  if (draining) return;
  draining = true;
  const step = () => {
    const cmd = writeQueue.shift();
    if (!cmd || !port || !port.isOpen) {
      draining = false;
      return;
    }
    port.write(Buffer.from(cmd + "\r", "latin1"));
    port.drain(() => setTimeout(step, CMD_GAP_MS));
  };
  step();
}

// status line: #> + 11 two-digit fields
const STATUS_RE = /#>(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/;

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
  port = new SerialPort(
    { path: DEVICE, baudRate: BAUD, dataBits: 8, parity: "none", stopBits: 1, rtscts: false, autoOpen: false },
    () => {}
  );
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n", encoding: "latin1" }));
  parser.on("data", handleLine);

  port.on("open", () => {
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
      state.connected = false;
      state.lastError = err.message;
      console.error("[serial] open failed:", err.message, "- retrying in 5s");
      setTimeout(openPort, 5000);
    }
  });
}

function pollAll() {
  for (let amp = 1; amp <= AMP_COUNT; amp++) enqueue(`?${amp}0`);
}

// Periodic refresh keeps the cache live and reconnects if the port died.
setInterval(() => {
  if (port && port.isOpen) pollAll();
  else if (!draining) openPort();
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
    baud: BAUD,
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

app.post("/api/zones/:zone", (req, res) => {
  const zone = req.params.zone;
  if (!/^[1-3][1-6]$/.test(zone)) return res.status(400).json({ error: "bad zone id" });
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
  return { ...rest, settingsPinSet: !!settingsPin };
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
