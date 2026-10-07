'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/*
 * V1e-2 (ADR 0033 SS7, SD-10): per-machine panel preferences. One JSON file,
 * `<machineDir>/panel-prefs.json`, beside the resolved config.toml -- never inside the vault,
 * never the vault's own config, and never routed through src/config's own config-file writer.
 * `machinedir.resolveMachineDir`'s result is the only input this module ever takes for "where":
 * this file never looks up a config path of its own, and never falls back to any other default
 * location.
 *
 * V1e-3 (ADR 0033 addendum, SD-20): each view choice and each pane placement is now remembered
 * PER VIEWPORT CLASS (wide, laptop, phone), 21 keys total. The file holds only the choices a
 * person actually made (sparse): a value equal to its own default is indistinguishable from
 * "never chosen", so a full-object write (V1e-2's own behaviour) would freeze today's defaults
 * into the file forever, and a future default change would never reach an existing user. A
 * one-time migration reads a legacy single-value key (from before this slice) and, only when its
 * value differs from ITS OWN legacy default, backfills the three per-class keys that the file
 * doesn't already own explicitly.
 *
 * Read is always safe: a missing, oversized, malformed, non-object or symlinked file all fall
 * back to defaults() rather than throwing (FR-12's "corrupt or unknown content falls back to
 * defaults"). explicitOf()/normalise() re-validate every key by exact schema membership every
 * time, so a hand-edited file (or a prototype-pollution attempt via "__proto__") can only ever
 * produce a subset of the frozen defaults shape, never an unknown key or an out-of-range value.
 */

const PREFS_FILE = 'panel-prefs.json';
const PREFS_MAX_BYTES = 4096;

// The three viewport classes NV.viewportClass (assets/admin/nav.js) names -- this file's own
// independently-typed mirror (drift-tested, test/admin-v1e2-model.test.js), same pattern as
// PREF_SCHEMA/NV.VIEWS already are.
const VIEWPORTS = Object.freeze(['wide', 'laptop', 'phone']);

// [key, allowedValues, default]. Frozen: every consumer (the HTTP handler, the browser's NV
// namespace via its own independently-typed drift-tested mirror) reads this table, never a copy.
//
// Owner decision (2026-09-30, Part 10 of the V1e-3/4/6 architect run): laptop and phone default
// to "below the content", overriding the Architect's own drawer/sheet default. Wide keeps
// "overlay" (there is no below option at wide -- ov1 docks there). Drawer and sheet stay
// available as options; the choice is still remembered per screen size.
const PREF_SCHEMA = Object.freeze(
  [
    ['view.overview.wide', ['ov1', 'ov2', 'ov3'], 'ov1'],
    ['view.overview.laptop', ['ov1', 'ov2', 'ov3'], 'ov1'],
    ['view.overview.phone', ['ov1', 'ov2', 'ov3'], 'ov1'],
    ['view.title.wide', ['tt1', 'tt2', 'tt3'], 'tt1'],
    ['view.title.laptop', ['tt1', 'tt2', 'tt3'], 'tt1'],
    ['view.title.phone', ['tt1', 'tt2', 'tt3'], 'tt1'],
    ['view.images.wide', ['im1', 'im2', 'im3'], 'im1'],
    ['view.images.laptop', ['im1', 'im2', 'im3'], 'im1'],
    ['view.images.phone', ['im1', 'im2', 'im3'], 'im1'],
    ['view.vocab.wide', ['vo1', 'vo2', 'vo3'], 'vo1'],
    ['view.vocab.laptop', ['vo1', 'vo2', 'vo3'], 'vo1'],
    ['view.vocab.phone', ['vo1', 'vo2', 'vo3'], 'vo1'],
    ['view.vault-config.wide', ['vc1', 'vc2', 'vc3'], 'vc1'],
    ['view.vault-config.laptop', ['vc1', 'vc2', 'vc3'], 'vc1'],
    ['view.vault-config.phone', ['vc1', 'vc2', 'vc3'], 'vc1'],
    ['pane.place.laptop', ['overlay', 'below'], 'below'],
    ['pane.place.phone', ['overlay', 'below'], 'below'],
    ['pane.hidden', [false, true], false],
    ['rail.hidden', [false, true], false],
    ['ov2.follow', [true, false], true],
    ['preview.device', ['desktop', 'phone'], 'desktop'],
  ].map((entry) => Object.freeze([entry[0], Object.freeze(entry[1].slice()), entry[2]])),
);

// [legacyKey, screenId, legacyDefault]. One entry per V1e-2 single-value key this slice replaces.
// screenId is the fragment used to build each per-class key ('view.' + screenId + '.' + vp).
const LEGACY_VIEW_KEYS = Object.freeze(
  [
    ['view.overview', 'overview', 'ov1'],
    ['view.title', 'title', 'tt1'],
    ['view.images', 'images', 'im1'],
    ['view.vocab', 'vocab', 'vo1'],
    ['view.vault-config', 'vault-config', 'vc1'],
  ].map((e) => Object.freeze(e)),
);

const REASON_UNREADABLE = "This computer's saved panel layout choices could not be read, so the defaults are shown.";

function defaults() {
  const d = {};
  for (const [key, , def] of PREF_SCHEMA) d[key] = def;
  return d;
}

function schemaEntry(key) {
  // Exact array search (never an object/property lookup): PREF_SCHEMA is a frozen array of
  // [key, ...] tuples, so a key of "constructor" or "__proto__" can never resolve to anything but
  // "not found" here.
  for (const entry of PREF_SCHEMA) {
    if (entry[0] === key) return entry;
  }
  return null;
}

/**
 * A fresh, schema-ordered object holding every schema key that `obj` owns AS AN OWN PROPERTY
 * (never inherited -- what makes a literal "__proto__" entry in a hand-edited file inert) with an
 * exact-member allowed value, PLUS the SD-20 one-time migration: for each legacy single-value key
 * `obj` owns validly, whose value differs from that legacy key's OWN default (a value equal to
 * the default can never be told apart from "never chosen" -- V1e-2 wrote every key), every one of
 * that screen's three per-class keys that `obj` doesn't already own explicitly is backfilled with
 * the legacy value. An explicit per-class key already present always wins over migration.
 *
 * @param {unknown} obj
 * @returns {Record<string, string|boolean>}
 */
function explicitOf(obj) {
  const src = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const result = {};

  for (const [key, allowed] of PREF_SCHEMA) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const value = src[key];
    if (allowed.includes(value)) result[key] = value;
  }

  for (const [legacyKey, screenId, legacyDefault] of LEGACY_VIEW_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, legacyKey)) continue;
    const legacyValue = src[legacyKey];
    const wideEntry = schemaEntry('view.' + screenId + '.wide');
    if (!wideEntry) continue;
    const allowedForScreen = wideEntry[1];
    if (!allowedForScreen.includes(legacyValue)) continue;
    if (legacyValue === legacyDefault) continue; // indistinguishable from "never chosen"
    for (const vp of VIEWPORTS) {
      const perClassKey = 'view.' + screenId + '.' + vp;
      if (!Object.prototype.hasOwnProperty.call(result, perClassKey)) {
        result[perClassKey] = legacyValue;
      }
    }
  }

  // Re-order to schema order: JS object key order is insertion order, and the migration pass
  // above inserts per-class keys as it walks LEGACY_VIEW_KEYS, which does not itself guarantee
  // PREF_SCHEMA order relative to keys already set by the direct pass. This walk is the single
  // source of truth for output order, independent of insertion history.
  const ordered = {};
  for (const [key] of PREF_SCHEMA) {
    if (Object.prototype.hasOwnProperty.call(result, key)) ordered[key] = result[key];
  }
  return ordered;
}

/**
 * defaults() overlaid with explicitOf(obj) -- the effective prefs object every reader sees.
 *
 * @param {unknown} obj
 * @returns {Record<string, string|boolean>}
 */
function normalise(obj) {
  return Object.assign(defaults(), explicitOf(obj));
}

function serialise(prefs) {
  const text = JSON.stringify(prefs, null, 2) + '\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PREFS_MAX_BYTES) {
    // Defensive only: PREF_SCHEMA's own fixed 21 entries, sparse, can never actually reach this.
    throw new Error(`panel-prefs.json would be ${bytes} bytes, over the ${PREFS_MAX_BYTES}-byte cap`);
  }
  return text;
}

/**
 * Never throws. Returns `{ ok: true, parsed }` for a readable, well-formed JSON object file, or
 * `{ ok: false, reason }` for every other case (an unavailable machine dir, a missing file, or an
 * unreadable/oversized/malformed/non-object/symlinked one). The single low-level read shared by
 * readPrefs() (which normalises the result) and writePref() (which needs the RAW parsed object,
 * per SD-20, not the already-defaulted one).
 *
 * @param {{ ok: true, dir: string, realDir: string } | { ok: false, reason: string }} machineDirResult
 * @returns {{ ok: true, parsed: object } | { ok: false, reason: string|null }}
 */
function readRawFile(machineDirResult) {
  if (!machineDirResult || machineDirResult.ok !== true) {
    return { ok: false, reason: (machineDirResult && machineDirResult.reason) || null };
  }

  const filePath = path.join(machineDirResult.dir, PREFS_FILE);

  let st;
  try {
    // lstat, never stat: a symlinked panel-prefs.json must never be treated as the real file.
    st = fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: null };
    return { ok: false, reason: REASON_UNREADABLE };
  }
  if (!st.isFile() || st.size > PREFS_MAX_BYTES) {
    return { ok: false, reason: REASON_UNREADABLE };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: REASON_UNREADABLE };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: REASON_UNREADABLE };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: REASON_UNREADABLE };
  }

  return { ok: true, parsed };
}

/**
 * Never throws.
 *
 * @param {{ ok: true, dir: string, realDir: string } | { ok: false, reason: string }} machineDirResult
 * @returns {{ prefs: Record<string, string|boolean>, persisted: boolean, reason: string|null }}
 */
function readPrefs(machineDirResult) {
  const r = readRawFile(machineDirResult);
  if (!r.ok) return { prefs: defaults(), persisted: false, reason: r.reason };
  return { prefs: normalise(r.parsed), persisted: true, reason: null };
}

function removeTempBestEffort(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // swallowed deliberately: the caller's own error (if any) already explains what went wrong.
  }
}

/**
 * Synchronous (no lock: one process never interleaves two synchronous writes). Reads the current
 * on-disk file's RAW parsed object (or {} if there is none / it can't be read), takes its
 * explicit (sparse, schema-valid) subset per explicitOf(), sets exactly the one key/value pair
 * the caller supplied, and writes THAT sparse object -- in schema order -- atomically: a `wx`
 * temp file beside the target, fsync, close, rename. On any failure, only its own temp is ever
 * removed.
 *
 * A legacy key is therefore never round-tripped back to disk: the first write after this slice
 * lands replaces it with the migrated per-class keys explicitOf() already produced.
 *
 * The caller (the HTTP handler) is responsible for validating `key`/`value` against PREF_SCHEMA
 * BEFORE calling this -- the returned, normalised effective object is a second, independent
 * safety net for what the CALLER sees, not the primary gate.
 *
 * @param {{ ok: true, dir: string, realDir: string }} machineDirResult
 * @param {string} key
 * @param {string|boolean} value
 * @returns {Record<string, string|boolean>} the full effective prefs object (defaults()
 *   overlaid with the newly-written sparse object)
 */
function writePref(machineDirResult, key, value) {
  const filePath = path.join(machineDirResult.dir, PREFS_FILE);
  const raw = readRawFile(machineDirResult);
  const currentSparse = explicitOf(raw.ok ? raw.parsed : {});
  const merged = Object.assign({}, currentSparse, { [key]: value });
  const sparse = {};
  for (const [k] of PREF_SCHEMA) {
    if (Object.prototype.hasOwnProperty.call(merged, k)) sparse[k] = merged[k];
  }
  const text = serialise(sparse);

  const tmpName = `.${PREFS_FILE}.scriptorium-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = path.join(machineDirResult.dir, tmpName);

  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the underlying error is what gets reported either way.
      }
    }
    removeTempBestEffort(tmp);
    throw err;
  }

  return normalise(sparse);
}

module.exports = {
  PREF_SCHEMA,
  PREFS_FILE,
  PREFS_MAX_BYTES,
  VIEWPORTS,
  LEGACY_VIEW_KEYS,
  defaults,
  explicitOf,
  normalise,
  readPrefs,
  writePref,
};
