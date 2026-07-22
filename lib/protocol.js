// Pure, dependency-free protocol + model-profile helpers.
//
// This module has NO external requires on purpose: server.js builds on it, and
// the unit tests exercise it directly without needing serialport/express or any
// native module installed. See test/protocol.test.js.
//
// Every supported amp speaks the SAME `?`/`<`/`#>` protocol; only the hardware
// dimensions below differ, so a model is pure data, not logic.
//   zonesPerAmp  zones per unit; drives the 11-1N/21-2N/31-3N addressing
//   maxAmps      how many units can be linked
//   sources      number of inputs (protocol "ch" field max)
//   volMax/toneMax/balMax  inclusive upper bound of each 2-digit field
//   statusPrefix prefix of a status reply line ("#>")
//   eol          command line terminator ("\r")
// NOTE: the <amp><zone> addresses are single-digit, so zonesPerAmp/maxAmps must
// each be <= 9. Only monoprice-6 is hardware-tested; the rest are from docs.
const BASE_PROFILE = { baud: 9600, statusPrefix: "#>", volMax: 38, toneMax: 14, balMax: 20, eol: "\r" };

const PROFILES = {
  "monoprice-6":     { ...BASE_PROFILE, label: "Monoprice MPR-6ZHMAUT (10761), 6-zone", zonesPerAmp: 6, maxAmps: 3, sources: 6 },
  "monoprice-8":     { ...BASE_PROFILE, label: "Monoprice 44518, 8-zone",               zonesPerAmp: 8, maxAmps: 3, sources: 6 },
  "monoprice-4":     { ...BASE_PROFILE, label: "Monoprice 44519, 4-zone",               zonesPerAmp: 4, maxAmps: 3, sources: 6 },
  "monoprice-39261": { ...BASE_PROFILE, label: "Monoprice 39261 passive matrix, 6-zone", zonesPerAmp: 6, maxAmps: 3, sources: 6 },
  "dayton-dax66":    { ...BASE_PROFILE, label: "Dayton Audio DAX66, 6-zone",            zonesPerAmp: 6, maxAmps: 3, sources: 6 },
};

// socket://host:port or tcp://host:port (serial-over-IP bridge); host may be an
// [IPv6] literal. Anything else is treated as a local serial device path.
const SOCKET_RE = /^(?:socket|tcp):\/\/(\[[^\]]+\]|[^:/]+):(\d+)\/?$/i;

// Zone IDs for `ampCount` linked units of `profile`, e.g. 11..16, 21..26, ...
function zoneIdsFor(profile, ampCount) {
  const ids = [];
  for (let amp = 1; amp <= ampCount; amp++)
    for (let z = 1; z <= profile.zonesPerAmp; z++) ids.push(`${amp}${z}`);
  return ids;
}

// Regex matching a status reply: <prefix> followed by 11 two-digit fields.
function statusReFor(prefix) {
  return new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d{2})".repeat(11));
}

// Regex validating a POSTed zone id against the configured amp/zone bounds.
function zoneReFor(ampCount, zonesPerAmp) {
  return new RegExp(`^[1-${ampCount}][1-${zonesPerAmp}]$`);
}

// Settable attribute metadata for a profile (protocol code -> {name,min,max}).
// `pa` (all-zones flag) and `ls` (keypad link) are read from status only, never
// set, so they are intentionally excluded here.
function attrsFor(profile) {
  return {
    pr: { name: "power", min: 0, max: 1 },
    mu: { name: "mute", min: 0, max: 1 },
    dt: { name: "dnd", min: 0, max: 1 },
    vo: { name: "volume", min: 0, max: profile.volMax },
    tr: { name: "treble", min: 0, max: profile.toneMax },
    bs: { name: "bass", min: 0, max: profile.toneMax },
    bl: { name: "balance", min: 0, max: profile.balMax },
    ch: { name: "source", min: 1, max: profile.sources },
  };
}

module.exports = { BASE_PROFILE, PROFILES, SOCKET_RE, zoneIdsFor, statusReFor, zoneReFor, attrsFor };
