// Pure, dependency-free validation for PUT /api/config bodies. Shared by the
// server and exercised directly by unit tests. Goal: a malformed or oversized
// write can never be persisted (which would break every client until the file
// is hand-edited), and shapes the frontend relies on (e.g. preset.zones) are
// guaranteed present.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max = 100) => typeof v === "string" && v.length <= max;
const strArr = (v, maxLen = 64) => Array.isArray(v) && v.length <= maxLen && v.every((x) => str(x));
const strMap = (v, maxKeys = 64) =>
  isObj(v) && Object.keys(v).length <= maxKeys && Object.values(v).every((x) => str(x));

// A preset must carry a `zones` object (the frontend does Object.keys(p.zones));
// id/name are lenient (string if present) so legacy presets aren't rejected.
const isZoneMap = (v) => isObj(v) && Object.values(v).every(isObj);
const isPreset = (p) =>
  isObj(p) && isZoneMap(p.zones) &&
  (p.id === undefined || str(p.id, 64)) &&
  (p.name === undefined || str(p.name)) &&
  (p.icon === undefined || str(p.icon, 64));

const CONFIG_VALIDATORS = {
  title: (v) => str(v),
  zoneNames: strMap,
  sourceNames: strArr,
  sourceIcons: strArr,
  presets: (v) => Array.isArray(v) && v.length <= 100 && v.every(isPreset),
  activeScene: (v) => v === null || str(v, 64),
  disabledZones: strArr,
  disabledSources: (v) => Array.isArray(v) && v.length <= 64 && v.every((x) => Number.isInteger(x)),
  zoneIcons: strMap,
  settingsPin: (v) => str(v, 64),
};

// Validate the known keys present in `body`. Returns { ok:true } or
// { ok:false, key } naming the first offending key.
function validateConfigPatch(body, keys) {
  for (const k of keys) {
    if (k in body) {
      const check = CONFIG_VALIDATORS[k];
      if (!check || !check(body[k])) return { ok: false, key: k };
    }
  }
  return { ok: true };
}

module.exports = { CONFIG_VALIDATORS, validateConfigPatch };
