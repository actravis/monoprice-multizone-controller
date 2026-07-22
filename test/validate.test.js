// Unit tests for the config-body validators (pure, no dependencies).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfigPatch } = require("../lib/validate");

const KEYS = [
  "title", "zoneNames", "sourceNames", "sourceIcons", "presets",
  "activeScene", "disabledZones", "disabledSources", "zoneIcons", "settingsPin",
];
const ok = (body) => validateConfigPatch(body, KEYS).ok;

test("accepts a well-formed patch", () => {
  assert.ok(ok({
    title: "Home Audio",
    zoneNames: { "11": "Kitchen" },
    sourceNames: ["Sonos", "Apple TV"],
    sourceIcons: ["music", "tv"],
    presets: [{ id: "s1", name: "Movie", icon: "film", zones: { "12": { power: 1, volume: 20 } } }],
    activeScene: "s1",
    disabledZones: ["13"],
    disabledSources: [4, 5],
    zoneIcons: { "11": "utensils" },
    settingsPin: "1234",
  }));
});

test("accepts a partial patch (only known keys present)", () => {
  assert.ok(ok({ title: "x" }));
  assert.ok(ok({}));
});

test("rejects wrong types", () => {
  assert.ok(!ok({ sourceNames: "not-an-array" }));
  assert.ok(!ok({ zoneNames: ["should", "be", "object"] }));
  assert.ok(!ok({ title: 123 }));
  assert.ok(!ok({ disabledSources: ["0"] })); // must be integers
  assert.ok(!ok({ activeScene: 5 }));
});

test("activeScene may be null", () => {
  assert.ok(ok({ activeScene: null }));
});

test("rejects a preset missing its zones object (would crash the client)", () => {
  assert.ok(!ok({ presets: [{ id: "s1", name: "Bad" }] }));
  assert.ok(!ok({ presets: [{ zones: "nope" }] }));
  assert.ok(ok({ presets: [{ zones: {} }] })); // empty zones is fine
});

test("enforces size caps", () => {
  assert.ok(!ok({ title: "x".repeat(101) }));
  assert.ok(!ok({ settingsPin: "9".repeat(65) }));
  assert.ok(!ok({ sourceNames: Array(65).fill("s") }));
  assert.ok(!ok({ presets: Array(101).fill({ zones: {} }) }));
});

test("reports the offending key", () => {
  const r = validateConfigPatch({ title: "ok", sourceNames: 5 }, KEYS);
  assert.equal(r.ok, false);
  assert.equal(r.key, "sourceNames");
});

test("ignores unknown keys (only validates CONFIG_KEYS)", () => {
  // model/profile are echoed back by the API but not persisted; a client that
  // sends them back must not trip validation.
  assert.ok(validateConfigPatch({ model: "monoprice-6", profile: {}, title: "ok" }, KEYS).ok);
});
