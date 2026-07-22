// HTTP integration tests for the Express handlers. These need the runtime deps
// (express/serialport) installed, so they SKIP gracefully when node_modules is
// absent (e.g. on a dev box that authors but installs elsewhere) and run in CI
// after `npm ci`. No serial hardware required — the amp just reports no zones.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Isolate persistence to a temp file and silence mDNS before requiring the app.
const TMP_CONFIG = path.join(os.tmpdir(), `amp-test-config-${process.pid}.json`);
process.env.CONFIG_PATH = TMP_CONFIG;
process.env.MDNS_NAME = "";

let app = null, loadErr = null;
try { ({ app } = require("../server.js")); } catch (e) { loadErr = e.message; }
const skip = app ? false : `runtime deps not installed (${loadErr})`;

let server, base;
before(async () => {
  if (!app) return;
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP_CONFIG, { force: true }); } catch {}
  try { fs.rmSync(TMP_CONFIG + ".tmp", { force: true }); } catch {}
});

const put = (body, headers = {}) =>
  fetch(base + "/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("GET /api/health returns status + active model", { skip }, async () => {
  const r = await fetch(base + "/api/health");
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.model, "monoprice-6");
  assert.equal(h.zonesPerAmp, 6);
  assert.equal(typeof h.connected, "boolean");
});

test("GET /api/config never leaks the PIN and includes the profile", { skip }, async () => {
  const c = await (await fetch(base + "/api/config")).json();
  assert.ok(!("settingsPin" in c), "raw PIN must not be exposed");
  assert.equal(typeof c.settingsPinSet, "boolean");
  assert.equal(c.profile.sources, 6);
});

test("POST /api/zones/:zone rejects a bad zone id", { skip }, async () => {
  const r = await fetch(base + "/api/zones/99", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(r.status, 400);
});

test("PUT /api/config rejects a malformed body", { skip }, async () => {
  assert.equal((await put({ sourceNames: "nope" })).status, 400);
});

test("PUT /api/config accepts a valid title when no PIN is set", { skip }, async () => {
  const r = await put({ title: "Test Title" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).title, "Test Title");
});

test("POST /api/unlock returns ok:false when no PIN is set", { skip }, async () => {
  const r = await fetch(base + "/api/unlock", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1234" }),
  });
  assert.equal((await r.json()).ok, false);
});

test("malformed JSON returns a JSON 400 (error middleware)", { skip }, async () => {
  const r = await fetch(base + "/api/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: "{ not json",
  });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error, "should be a JSON error, not HTML");
});
