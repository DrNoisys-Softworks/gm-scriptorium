'use strict';

const path = require('path');
const TOML = require('smol-toml');
const packfiles = require('../packfiles');
const { runSave } = require('./pack');
const { parsePackToml } = require('../../build/packtoml');
const { DEFAULT_LABELS, DEFAULT_VOCAB } = require('../../build/labels');
const { ConfigError } = require('../../util/errors');

/*
 * Phase 8 slice S4 (FR25, the S4 Engineering Brief's SD-1 through SD-6). Reuses S3's runSave
 * unchanged (SD-4): the panel's vocabulary editor is another `pack.toml` edit endpoint, with its
 * own shape validation (SD-2, validateVocabEdits) and its own pure edit step (SD-7 precedent,
 * editPackTomlVocab), following the same body -> writable -> fields -> lock -> read ->
 * existence/sha -> on-disk validation -> edit -> candidate validation -> dry run -> write order
 * runSave already enforces. Product validation (parity with `check`) comes for free from
 * parsePackToml -> parseVocab (src/build/labels.js), which this module never duplicates.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** SD-2: a "table" is a plain object -- never an array, Date, null, or other exotic object. */
function isTable(v) {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/** SD-6: a local literal, independent of labels.js's own (unexported) TIMELINE_KEYS, with a
 * drift test (test/admin-vocab.test.js, "T17"). labels.js itself is on the build path and stays
 * unedited by this slice. */
const TIMELINE_EDIT_KEYS = Object.freeze(['kinds', 'weights', 'session_token', 'segment_units', 'columns']);

/** Independent of DEFAULT_LABELS.js's own (unexported) LABEL_KEYS; derived once at load time
 * from the exported DEFAULT_LABELS object (the 17-name list itself is inherited, not re-typed,
 * so a future 18th label needs no edit here -- test/admin-vocab.test.js states the 17 names as
 * its own independent literal instead, per CLAUDE.md's testing standards). */
const LABEL_NAMES = Object.freeze(Object.keys(DEFAULT_LABELS));
const COLUMN_NAMES = Object.freeze(Object.keys(DEFAULT_VOCAB.columns));

/** SD-2: forbidden at any depth, in every table this endpoint accepts. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(message) {
  throw new ConfigError(`vocab edit: ${message}`);
}

/**
 * Walks `value` recursively (tables and arrays only) and throws the moment it finds an own key
 * named "__proto__", "constructor" or "prototype" -- at ANY depth, including inside a
 * [[timeline.kinds]] entry, which is the one place no other check in this file would otherwise
 * catch it (kind entries deliberately allow unrecognised keys, so the panel can echo them back
 * per FR20). Runs first, before any of the more specific per-table checks below, so a forbidden
 * key always gets this message rather than e.g. "unknown label".
 */
function checkForbidden(value) {
  if (Array.isArray(value)) {
    for (const item of value) checkForbidden(item);
    return;
  }
  if (isTable(value)) {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) fail(`the key "${k}" is not allowed`);
      checkForbidden(value[k]);
    }
  }
}

function validateStringOrNull(v, fieldPath) {
  if (v !== null && typeof v !== 'string') fail(`${fieldPath} must be a string or null`);
  return v;
}

// -- [labels] -----------------------------------------------------------------------------------

function validateLabelsEdit(val) {
  if (!isTable(val)) fail('labels must be a table');
  const out = {};
  for (const k of Object.keys(val)) {
    if (!LABEL_NAMES.includes(k)) fail(`unknown label "${k}"`);
    out[k] = validateStringOrNull(val[k], `labels.${k}`);
  }
  return out;
}

// -- [[timeline.kinds]] --------------------------------------------------------------------------

/** A kind entry's own values may only be strings, booleans or string arrays (SD-2); the product
 * parser (labels.js's parseKinds) is what actually validates key/glyph/aliases/before shapes and
 * echoes unrecognised entry keys back as warnings, never errors (FR20). */
function isKindEntryValueValid(v) {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

function validateKindsEdit(val) {
  if (val === null) return null;
  if (!Array.isArray(val)) fail('timeline.kinds must be an array of tables or null');
  val.forEach((entry, idx) => {
    const n = idx + 1;
    if (!isTable(entry) || !Object.keys(entry).every((k) => isKindEntryValueValid(entry[k]))) {
      fail(`timeline.kinds #${n} must be a table of strings, booleans and string arrays`);
    }
  });
  return val;
}

// -- [timeline] weights ---------------------------------------------------------------------------

function validateWeightsEdit(val) {
  if (val === null) return null;
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    fail('timeline.weights must be an array of strings or null');
  }
  return val;
}

// -- [timeline.columns] ---------------------------------------------------------------------------

function validateColumnNameArray(v, col) {
  if (v !== null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
    fail(`timeline.columns.${col} must be an array of strings or null`);
  }
  return v;
}

function validateColumnsEdit(val) {
  if (!isTable(val)) fail('timeline.columns must be a table');
  const out = {};
  for (const k of Object.keys(val)) {
    if (!COLUMN_NAMES.includes(k)) fail(`unknown [timeline.columns] key "${k}"`);
    out[k] = validateColumnNameArray(val[k], k);
  }
  return out;
}

// -- [timeline] -------------------------------------------------------------------------------

function validateTimelineEdit(val) {
  // Not one of the brief's 15 literal messages (a specification gap -- see the Engineer's
  // report): without this, a non-table `timeline` value would reach Object.keys() below, which
  // throws for null and silently no-ops for other primitives, either crashing the request with a
  // 500 or treating the whole edit as empty. Kept symmetric with "labels must be a table" and
  // "recaps must be a table".
  if (!isTable(val)) fail('timeline must be a table');

  for (const k of Object.keys(val)) {
    if (!TIMELINE_EDIT_KEYS.includes(k)) fail(`unknown [timeline] key "${k}"`);
  }

  const out = {};
  if (hasOwn(val, 'kinds')) out.kinds = validateKindsEdit(val.kinds);
  if (hasOwn(val, 'weights')) out.weights = validateWeightsEdit(val.weights);
  if (hasOwn(val, 'session_token')) out.session_token = validateStringOrNull(val.session_token, 'timeline.session_token');
  if (hasOwn(val, 'segment_units')) out.segment_units = validateStringOrNull(val.segment_units, 'timeline.segment_units');
  if (hasOwn(val, 'columns')) out.columns = validateColumnsEdit(val.columns);
  return out;
}

// -- [recaps] -----------------------------------------------------------------------------------

function validateRecapsEdit(val) {
  if (!isTable(val)) fail('recaps must be a table');
  const out = {};
  for (const k of Object.keys(val)) {
    if (k !== 'learned_heading') fail(`unknown [recaps] key "${k}"`);
    out[k] = validateStringOrNull(val[k], 'recaps.learned_heading');
  }
  return out;
}

/**
 * SD-2: shape validation only -- product validation (parity with `check`) is parsePackToml, run
 * separately by runSave as `productParse` on the candidate. Only labels/timeline/recaps are
 * inspected; baseSha256/dryRun were already validated by runSave itself (steps 3-4) and are not
 * fields this function returns.
 *
 * @param {object} parsed the whole POST body (already known to carry only allowed top-level keys)
 * @returns {{ labels?: object, timeline?: object, recaps?: object }}
 * @throws {ConfigError}
 */
function validateVocabEdits(parsed) {
  const fields = {};
  if (hasOwn(parsed, 'labels')) {
    checkForbidden(parsed.labels);
    fields.labels = validateLabelsEdit(parsed.labels);
  }
  if (hasOwn(parsed, 'timeline')) {
    checkForbidden(parsed.timeline);
    fields.timeline = validateTimelineEdit(parsed.timeline);
  }
  if (hasOwn(parsed, 'recaps')) {
    checkForbidden(parsed.recaps);
    fields.recaps = validateRecapsEdit(parsed.recaps);
  }
  return fields;
}

// -- the SD-1 merge and TOML re-serialisation --------------------------------------------------

/**
 * Sets each provided key; `null` deletes it; a key not provided in `edits` is untouched. Applies
 * uniformly to [labels], [recaps], the top level of [timeline] (kinds/weights/session_token/
 * segment_units/columns, columns already pre-merged by the caller) and [timeline.columns] itself.
 */
function mergeTable(current, edits) {
  const out = { ...(isTable(current) ? current : {}) };
  for (const k of Object.keys(edits)) {
    const v = edits[k];
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** [timeline.columns] merges key by key (SD-1); the merged result then flows through the
 * ordinary top-level [timeline] set/delete pass like any other timeline key -- an empty merged
 * columns table is treated as a deletion, so an all-nulled-out [timeline.columns] never survives
 * as a spurious empty table (symmetric with SD-1's "a table left empty by removals is removed"). */
function mergeTimeline(currentTimeline, fields) {
  const currentTable = isTable(currentTimeline) ? currentTimeline : {};
  const setFields = { ...fields };
  if (hasOwn(setFields, 'columns')) {
    const mergedColumns = mergeTable(currentTable.columns, setFields.columns);
    setFields.columns = Object.keys(mergedColumns).length === 0 ? null : mergedColumns;
  }
  return mergeTable(currentTable, setFields);
}

/** Sets `next[key]` to `mergedValue`, or removes `key` entirely when the merge left it with zero
 * own keys (SD-1: "A table left empty by removals is removed."). */
function setOrDeleteTable(next, key, mergedValue) {
  if (Object.keys(mergedValue).length === 0) delete next[key];
  else next[key] = mergedValue;
}

/**
 * Pure: TOML.parse, the SD-1 merge, TOML.stringify. No I/O. Object-spread preserves each
 * surviving table's existing position in the file (the same precedent as
 * src/admin/packedit.js's editPackTomlTheme); a table that did not exist before lands at the end
 * only if the merge actually gives it a key.
 *
 * @param {string} raw
 * @param {{ labels?: object, timeline?: object, recaps?: object }} fields validateVocabEdits's
 *   return value
 * @returns {string}
 */
function editPackTomlVocab(raw, fields) {
  const parsed = TOML.parse(raw);
  const next = { ...parsed };

  if (hasOwn(fields, 'labels')) setOrDeleteTable(next, 'labels', mergeTable(parsed.labels, fields.labels));
  if (hasOwn(fields, 'timeline')) setOrDeleteTable(next, 'timeline', mergeTimeline(parsed.timeline, fields.timeline));
  if (hasOwn(fields, 'recaps')) setOrDeleteTable(next, 'recaps', mergeTable(parsed.recaps, fields.recaps));

  return TOML.stringify(next);
}

// -- GET /api/state?include=vocab (SD-3) -----------------------------------------------------

const VOCAB_DEFAULTS = Object.freeze({
  labels: DEFAULT_LABELS,
  timeline: Object.freeze({
    kinds: DEFAULT_VOCAB.kinds,
    weights: DEFAULT_VOCAB.weights,
    session_token: DEFAULT_VOCAB.sessionToken.source,
    segment_units: DEFAULT_VOCAB.segmentUnits.source,
    columns: DEFAULT_VOCAB.columns,
  }),
  recaps: Object.freeze({ learned_heading: DEFAULT_VOCAB.learnedHeading }),
});

/**
 * @param {object} ctx
 * @returns {{ exists: boolean, tables: {labels,timeline,recaps}|null, error: string|null, defaults: object }}
 * Never throws (FR21 precedent).
 */
function vocabView(ctx) {
  const file = packfiles.readPackFile(ctx, 'pack.toml');
  if (!file.exists) {
    return { exists: false, tables: null, error: null, defaults: VOCAB_DEFAULTS };
  }

  const raw = file.raw.toString('utf8');
  try {
    const parsed = TOML.parse(raw);
    const tables = {
      labels: hasOwn(parsed, 'labels') ? parsed.labels : null,
      timeline: hasOwn(parsed, 'timeline') ? parsed.timeline : null,
      recaps: hasOwn(parsed, 'recaps') ? parsed.recaps : null,
    };
    return { exists: true, tables, error: null, defaults: VOCAB_DEFAULTS };
  } catch (err) {
    return { exists: true, tables: null, error: err.message, defaults: VOCAB_DEFAULTS };
  }
}

// -- POST /api/pack/vocab ----------------------------------------------------------------------

/** POST /api/pack/vocab (FR25, SD-4: reuses runSave unchanged). */
async function saveVocab(req, res, ctx) {
  await runSave(req, res, ctx, {
    name: 'pack.toml',
    allowedKeys: ['labels', 'timeline', 'recaps', 'baseSha256', 'dryRun'],
    baseShaAllowsNull: false,
    requireAtLeastOneOf: ['labels', 'timeline', 'recaps'],
    validateFields: validateVocabEdits,
    buildCandidate: editPackTomlVocab,
    productParse: (text, c) => parsePackToml(text, { tomlPath: path.join(c.packDir, 'pack.toml'), campaign: c.campaign }),
  });
}

module.exports = { saveVocab, vocabView, editPackTomlVocab, validateVocabEdits, TIMELINE_EDIT_KEYS };
