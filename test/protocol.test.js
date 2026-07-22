// Unit tests for the pure protocol/profile helpers in server.js.
// Requiring server.js does NOT start the HTTP server or open the port (it's
// guarded by `require.main === module`). Run with `npm test` (node --test).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  PROFILES, SOCKET_RE,
  zoneIdsFor, statusReFor, zoneReFor, attrsFor,
} = require("../lib/protocol");

test("PROFILES: every profile has single-digit dimensions (protocol limit)", () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    assert.ok(p.zonesPerAmp >= 1 && p.zonesPerAmp <= 9, `${name} zonesPerAmp`);
    assert.ok(p.maxAmps >= 1 && p.maxAmps <= 9, `${name} maxAmps`);
    assert.ok(p.sources >= 1, `${name} sources`);
    assert.equal(p.eol, "\r");
    assert.equal(p.statusPrefix, "#>");
  }
});

test("zoneIdsFor: 6-zone across 3 amps -> 11..36", () => {
  const ids = zoneIdsFor(PROFILES["monoprice-6"], 3);
  assert.equal(ids.length, 18);
  assert.equal(ids[0], "11");
  assert.equal(ids[5], "16");
  assert.equal(ids[6], "21");
  assert.equal(ids.at(-1), "36");
});

test("zoneIdsFor: 8-zone one amp -> 11..18", () => {
  const ids = zoneIdsFor(PROFILES["monoprice-8"], 1);
  assert.deepEqual(ids, ["11", "12", "13", "14", "15", "16", "17", "18"]);
});

test("zoneIdsFor: 4-zone two amps -> 11..14, 21..24", () => {
  const ids = zoneIdsFor(PROFILES["monoprice-4"], 2);
  assert.deepEqual(ids, ["11", "12", "13", "14", "21", "22", "23", "24"]);
});

test("zoneReFor: validates within the configured amp/zone bounds", () => {
  const re = zoneReFor(1, 8); // 8-zone, one amp
  assert.ok(re.test("11"));
  assert.ok(re.test("18"));
  assert.ok(!re.test("19"));
  assert.ok(!re.test("21")); // amp 2 not configured
  assert.ok(!re.test("1"));
  assert.ok(!re.test("111"));

  const re4 = zoneReFor(2, 4);
  assert.ok(re4.test("24"));
  assert.ok(!re4.test("15")); // zone 5 out of range for 4-zone
});

test("statusReFor: parses an 11-field status line and captures the zone", () => {
  const re = statusReFor("#>");
  const line = "#>" + "18" + "00" + "01" + "00" + "00" + "15" + "07" + "07" + "10" + "03" + "00";
  const m = line.match(re);
  assert.ok(m, "should match");
  assert.equal(m.length - 1, 11, "11 capture groups");
  assert.equal(m[1], "18", "zone field");
  assert.equal(m[10], "03", "source (ch) field");
});

test("statusReFor: ignores a query echo / short line", () => {
  const re = statusReFor("#>");
  assert.equal("?10".match(re), null);
  assert.equal("#>1801".match(re), null); // too few fields
});

test("attrsFor: ranges follow the profile; pa/ls are not settable", () => {
  const a6 = attrsFor(PROFILES["monoprice-6"]);
  assert.equal(a6.vo.max, 38);
  assert.equal(a6.tr.max, 14);
  assert.equal(a6.bl.max, 20);
  assert.equal(a6.ch.max, 6);
  assert.equal(a6.ch.min, 1);
  assert.ok(!("pa" in a6), "pa is read-only status, not a settable attribute");
  assert.ok(!("ls" in a6));
});

test("SOCKET_RE: recognizes socket/tcp URLs and rejects serial paths", () => {
  assert.ok(SOCKET_RE.test("socket://192.168.1.50:4001"));
  assert.ok(SOCKET_RE.test("tcp://amp.local:5000"));
  assert.ok(SOCKET_RE.test("socket://[fe80::1]:4001"));
  assert.ok(!SOCKET_RE.test("/dev/ttyUSB0"));
  assert.ok(!SOCKET_RE.test("/dev/cu.usbserial-210"));
  assert.ok(!SOCKET_RE.test("socket://missing-port"));
});
