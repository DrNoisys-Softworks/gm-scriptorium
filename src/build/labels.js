'use strict';

const { ConfigError } = require('../util/errors');

/*
 * Engineering Brief: "Labels and vocabulary" (docs/agent-runs/agnostic-p4-engineering-brief-
 * 2026-09-25.md), ADR 0020. Pure: no fs, no Intl (L10). Owns the defaults, validation and
 * resolution of pack.toml's [labels], [timeline] and [recaps] tables, plus the island `voc`
 * delta computation (SD-1/SD-2/SD-3/SD-4). packtoml.js delegates to parseVocab.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isTomlTable(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function normalize(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// -- DEFAULT_LABELS: table B, verbatim --------------------------------------------------------

const DEFAULT_LABELS = Object.freeze({
  learned_lens: 'What the party learned',
  learned_legend: 'Learned',
  story_lens: 'The story',
  chapter: 'Chapter',
  recap: 'Recap',
  recap_learned_link: 'What the Party Learned',
  same_recap: 'Same recap',
  connections_heading: 'Connections',
  group_tie: 'Ties',
  group_named: 'Named by',
  group_pc: 'The party',
  group_npc: 'People',
  group_faction: 'Factions',
  group_location: 'Places',
  group_thing: 'Things',
  group_event: 'Events',
  group_other: 'Other',
});

const LABEL_KEYS = Object.freeze(Object.keys(DEFAULT_LABELS));

const TL_CLIENT_LABEL_KEYS = Object.freeze(['learned_lens', 'learned_legend', 'story_lens', 'chapter']);
const CX_CLIENT_LABEL_KEYS = Object.freeze([
  'recap',
  'same_recap',
  'group_tie',
  'group_named',
  'group_pc',
  'group_npc',
  'group_faction',
  'group_location',
  'group_thing',
  'group_event',
  'group_other',
]);

// -- default kinds, weights, columns, recaps --------------------------------------------------

const DEFAULT_KINDS = Object.freeze([
  Object.freeze({ key: 'fight', label: 'fight', glyph: 'fight', aliases: Object.freeze([]), before: false }),
  Object.freeze({ key: 'meeting', label: 'meeting', glyph: 'meeting', aliases: Object.freeze([]), before: false }),
  Object.freeze({ key: 'discovery', label: 'discovery', glyph: 'discovery', aliases: Object.freeze([]), before: false }),
  Object.freeze({ key: 'journey', label: 'journey', glyph: 'journey', aliases: Object.freeze([]), before: false }),
  Object.freeze({ key: 'backstory', label: 'backstory', glyph: 'backstory', aliases: Object.freeze([]), before: true }),
]);

const DEFAULT_WEIGHTS = Object.freeze(['aside', 'scene', 'turning point']);

const DEFAULT_COLUMNS = Object.freeze({
  title: Object.freeze(['title']),
  kind: Object.freeze(['kind']),
  weight: Object.freeze(['weight']),
  place: Object.freeze(['place']),
  in_game: Object.freeze(['in-game']),
  when: Object.freeze(['when']),
  real_world: Object.freeze(['real-world']),
  what: Object.freeze(['what']),
  session: Object.freeze(['session']),
  learned: Object.freeze(['learned']),
  after: Object.freeze(['after']),
});

const COLUMN_KEYS = Object.freeze(Object.keys(DEFAULT_COLUMNS));
const DATA_COLUMN_KEYS = Object.freeze(['title', 'kind', 'weight', 'place', 'in_game', 'when', 'real_world', 'what']);
const ANCHOR_COLUMN_KEYS = Object.freeze(['session', 'learned', 'after']);

const DEFAULT_SESSION_TOKEN_SRC = '\\bS(\\d+)\\b';
const DEFAULT_SEGMENT_UNITS_SRC = '\\b(week|day)\\s+(\\d+)\\b';
const DEFAULT_SESSION_TOKEN = Object.freeze(new RegExp(DEFAULT_SESSION_TOKEN_SRC, ''));
const DEFAULT_SEGMENT_UNITS = Object.freeze(new RegExp(DEFAULT_SEGMENT_UNITS_SRC, 'i'));

const DEFAULT_LEARNED_HEADING = 'what the party learned';

const GLYPH_NAMES = Object.freeze(['backstory', 'discovery', 'fight', 'journey', 'learned', 'meeting']);
const PATH_DATA_RE = /^[Mm][0-9MmZzLlHhVvCcSsQqTtAa.,+\-eE ]{0,1023}$/;
const KIND_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_KIND_KEYS = Object.freeze(new Set(['learned', 'none']));

// -- deep freeze (plain objects/arrays only; Map and Set are left as-is, D) ---------------------

function deepFreeze(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Map || v instanceof Set || v instanceof RegExp) return v;
  if (!Object.isFrozen(v)) {
    if (Array.isArray(v)) {
      for (const item of v) deepFreeze(item);
    } else {
      for (const k of Object.keys(v)) deepFreeze(v[k]);
    }
    Object.freeze(v);
  }
  return v;
}

// -- label-string validation (P4-FR09's no-\u rule) ---------------------------------------------

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function validateLabelString(value, where, T, c) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`campaign "${c}": ${T}: ${where} must be a non-empty string`, { path: T, campaign: c });
  }
  if (value.length > 200) {
    throw new ConfigError(`campaign "${c}": ${T}: ${where} is longer than 200 characters`, { path: T, campaign: c });
  }
  if (CONTROL_RE.test(value) || !value.isWellFormed()) {
    throw new ConfigError(`campaign "${c}": ${T}: ${where} contains a control character or an unpaired surrogate`, {
      path: T,
      campaign: c,
    });
  }
  return value;
}

function fail(T, c, message) {
  throw new ConfigError(`campaign "${c}": ${T}: ${message}`, { path: T, campaign: c });
}

// -- [labels] -----------------------------------------------------------------------------------

function parseLabelsTable(val, warnings, T, c) {
  if (val === undefined) return DEFAULT_LABELS;
  if (!isTomlTable(val)) fail(T, c, '[labels] must be a table');
  const out = {};
  for (const key of LABEL_KEYS) {
    out[key] = hasOwn(val, key) ? validateLabelString(val[key], `[labels] ${key}`, T, c) : DEFAULT_LABELS[key];
  }
  for (const k of Object.keys(val)) {
    if (!LABEL_KEYS.includes(k)) warnings.push(`${T}: [labels] unrecognised key "${k}" (ignored)`);
  }
  return out;
}

// -- [[timeline.kinds]] --------------------------------------------------------------------------

function validateGlyph(value, n, T, c) {
  const where = `[timeline] kinds #${n} glyph`;
  const message =
    `${where} must be one of backstory, discovery, fight, journey, learned, meeting, or SVG path data ` +
    '(M or m first; digits, spaces, commas, points, signs, e and path letters only; at most 1024 characters)';
  if (typeof value !== 'string') fail(T, c, message);
  if (GLYPH_NAMES.includes(value)) return value;
  if (PATH_DATA_RE.test(value)) return value;
  fail(T, c, message);
}

function validateAliases(value, n, T, c) {
  const where = `[timeline] kinds #${n} aliases`;
  if (!Array.isArray(value) || value.length > 16 || value.some((v) => typeof v !== 'string' || v.length === 0)) {
    fail(T, c, `${where} must be an array of at most 16 non-empty strings`);
  }
  return value;
}

function parseKinds(val, warnings, T, c) {
  if (!Array.isArray(val)) fail(T, c, '[timeline] kinds must be an array of tables');
  if (val.length < 1 || val.length > 32) fail(T, c, '[timeline] kinds must list between 1 and 32 kinds');

  const out = [];
  val.forEach((entry, idx) => {
    const n = idx + 1;
    if (!isTomlTable(entry)) fail(T, c, `[timeline] kinds #${n} must be a table`);

    const slugMessage = `[timeline] kinds #${n} key must be a lower-case slug: a letter, then letters, digits or "-", at most 32 characters`;
    if (!hasOwn(entry, 'key') || typeof entry.key !== 'string' || !KIND_KEY_RE.test(entry.key)) {
      fail(T, c, slugMessage);
    }
    const key = entry.key;
    if (RESERVED_KIND_KEYS.has(key)) fail(T, c, `[timeline] kinds #${n} key "${key}" is reserved`);

    let label = key;
    if (hasOwn(entry, 'label')) label = validateLabelString(entry.label, `[timeline] kinds #${n} label`, T, c);

    let glyph = GLYPH_NAMES.includes(key) ? key : '';
    if (hasOwn(entry, 'glyph')) glyph = validateGlyph(entry.glyph, n, T, c);

    let aliases = [];
    if (hasOwn(entry, 'aliases')) aliases = validateAliases(entry.aliases, n, T, c);

    let before = false;
    if (hasOwn(entry, 'before')) {
      if (typeof entry.before !== 'boolean') fail(T, c, `[timeline] kinds #${n} before must be true or false`);
      before = entry.before;
    }

    for (const k2 of Object.keys(entry)) {
      if (!['key', 'label', 'glyph', 'aliases', 'before'].includes(k2)) {
        warnings.push(`${T}: [[timeline.kinds]] #${n} unrecognised key "${k2}" (ignored)`);
      }
    }

    out.push({ key, label, glyph, aliases, before });
  });

  const owner = new Map();
  out.forEach((k, i) => {
    const names = [k.key, ...k.aliases];
    for (const raw of names) {
      const norm = normalize(raw);
      if (owner.has(norm)) {
        fail(T, c, `[timeline] kinds #${i + 1} "${raw}" is already a key or alias of another kind`);
      }
      owner.set(norm, i);
    }
  });

  return out;
}

// -- [timeline] weights ---------------------------------------------------------------------------

function parseWeights(value, T, c) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'string')) {
    fail(T, c, '[timeline] weights must be an array of exactly 3 strings');
  }
  return value.map((v, i) => validateLabelString(v, `[timeline] weights #${i + 1}`, T, c));
}

// -- [timeline] session_token / segment_units -------------------------------------------------

function parseRegexField(value, key, minGroups, flags, T, c) {
  const where = `[timeline] ${key}`;
  if (typeof value !== 'string' || value.length === 0) fail(T, c, `${where} must be a non-empty string`);
  if (value.length > 512) fail(T, c, `${where} is longer than 512 characters`);

  let re;
  try {
    re = new RegExp(value, flags);
  } catch (err) {
    fail(T, c, `${where} is not a valid regular expression: ${err.message.replace(/\s+/g, ' ')}`);
  }

  const groupCount = new RegExp(`(?:${value})|`, flags).exec('').length - 1;
  if (groupCount < minGroups) {
    fail(T, c, `${where} must have at least ${minGroups} capture group${minGroups === 1 ? '' : 's'}`);
  }
  return re;
}

// -- [timeline.columns] ---------------------------------------------------------------------------

function validateColumnNames(value, col, T, c) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    value.some((v) => typeof v !== 'string' || v.length === 0 || v.length > 64)
  ) {
    fail(T, c, `[timeline.columns] ${col} must be an array of 1 to 16 non-empty strings of at most 64 characters`);
  }
  return value;
}

function checkColumnCollisions(resolved, keys, T, c) {
  const owner = new Map();
  for (const col of keys) {
    for (const name of resolved[col]) {
      const norm = normalize(name);
      if (owner.has(norm) && owner.get(norm) !== col) {
        fail(T, c, `[timeline.columns] "${name}" names both ${owner.get(norm)} and ${col}`);
      }
      owner.set(norm, col);
    }
  }
}

function parseColumns(val, warnings, T, c) {
  if (!isTomlTable(val)) fail(T, c, '[timeline.columns] must be a table');
  const out = {};
  for (const col of COLUMN_KEYS) {
    out[col] = hasOwn(val, col) ? validateColumnNames(val[col], col, T, c) : DEFAULT_COLUMNS[col];
  }
  for (const k of Object.keys(val)) {
    if (!COLUMN_KEYS.includes(k)) warnings.push(`${T}: [timeline.columns] unrecognised key "${k}" (ignored)`);
  }
  checkColumnCollisions(out, DATA_COLUMN_KEYS, T, c);
  checkColumnCollisions(out, ANCHOR_COLUMN_KEYS, T, c);
  return out;
}

// -- [timeline] -------------------------------------------------------------------------------

const TIMELINE_KEYS = Object.freeze(['kinds', 'weights', 'session_token', 'segment_units', 'columns']);

function parseTimelineTable(val, warnings, T, c) {
  if (val === undefined) {
    return {
      kinds: DEFAULT_KINDS,
      weights: DEFAULT_WEIGHTS,
      sessionToken: DEFAULT_SESSION_TOKEN,
      segmentUnits: DEFAULT_SEGMENT_UNITS,
      columns: DEFAULT_COLUMNS,
    };
  }
  if (!isTomlTable(val)) fail(T, c, '[timeline] must be a table');

  const kinds = hasOwn(val, 'kinds') ? parseKinds(val.kinds, warnings, T, c) : DEFAULT_KINDS;
  const weights = hasOwn(val, 'weights') ? parseWeights(val.weights, T, c) : DEFAULT_WEIGHTS;
  const sessionToken = hasOwn(val, 'session_token')
    ? parseRegexField(val.session_token, 'session_token', 1, '', T, c)
    : DEFAULT_SESSION_TOKEN;
  const segmentUnits = hasOwn(val, 'segment_units')
    ? parseRegexField(val.segment_units, 'segment_units', 2, 'i', T, c)
    : DEFAULT_SEGMENT_UNITS;
  const columns = hasOwn(val, 'columns') ? parseColumns(val.columns, warnings, T, c) : DEFAULT_COLUMNS;

  for (const k of Object.keys(val)) {
    if (!TIMELINE_KEYS.includes(k)) warnings.push(`${T}: [timeline] unrecognised key "${k}" (ignored)`);
  }

  return { kinds, weights, sessionToken, segmentUnits, columns };
}

// -- [recaps] -----------------------------------------------------------------------------------

function parseRecapsTable(val, warnings, T, c) {
  if (val === undefined) return { learnedHeading: DEFAULT_LEARNED_HEADING };
  if (!isTomlTable(val)) fail(T, c, '[recaps] must be a table');

  const learnedHeading = hasOwn(val, 'learned_heading')
    ? validateLabelString(val.learned_heading, '[recaps] learned_heading', T, c)
    : DEFAULT_LEARNED_HEADING;

  for (const k of Object.keys(val)) {
    if (k !== 'learned_heading') warnings.push(`${T}: [recaps] unrecognised key "${k}" (ignored)`);
  }

  return { learnedHeading };
}

// -- vocab assembly (SD-2) -----------------------------------------------------------------------

function kindsProjection(kinds) {
  return kinds.map((k) => ({ key: k.key, label: k.label, glyph: k.glyph, before: k.before }));
}

const DEFAULT_KINDS_PROJECTION = kindsProjection(DEFAULT_KINDS);

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function kindsProjectionEqual(a, b) {
  return a.length === b.length && a.every((k, i) => k.key === b[i].key && k.label === b[i].label && k.glyph === b[i].glyph && k.before === b[i].before);
}

/**
 * The `voc` delta by VALUE (SD-4): present only when at least one client-relevant field differs
 * from the default, and within that, only the differing sub-keys.
 */
function computeTlVoc(labels, timeline) {
  const outLabels = {};
  let anyLabel = false;
  for (const key of TL_CLIENT_LABEL_KEYS) {
    if (labels[key] !== DEFAULT_LABELS[key]) {
      outLabels[key] = labels[key];
      anyLabel = true;
    }
  }
  const proj = kindsProjection(timeline.kinds);
  const kindsDiffer = !kindsProjectionEqual(proj, DEFAULT_KINDS_PROJECTION);
  const weightsDiffer = !arraysEqual(timeline.weights, DEFAULT_WEIGHTS);

  if (!anyLabel && !kindsDiffer && !weightsDiffer) return null;

  const out = {};
  if (anyLabel) out.labels = outLabels;
  if (kindsDiffer) out.kinds = proj;
  if (weightsDiffer) out.weights = timeline.weights;
  return out;
}

function computeCxVoc(labels) {
  const outLabels = {};
  let any = false;
  for (const key of CX_CLIENT_LABEL_KEYS) {
    if (labels[key] !== DEFAULT_LABELS[key]) {
      outLabels[key] = labels[key];
      any = true;
    }
  }
  if (!any) return null;
  return { labels: outLabels };
}

function buildVocab(labels, timeline, recaps) {
  const kindByName = new Map();
  const beforeKinds = new Set();
  for (const k of timeline.kinds) {
    kindByName.set(normalize(k.key), k.key);
    for (const a of k.aliases) kindByName.set(normalize(a), k.key);
    if (k.before) beforeKinds.add(k.key);
  }

  const vocab = {
    labels,
    kinds: timeline.kinds,
    kindByName,
    beforeKinds,
    weights: timeline.weights,
    columns: timeline.columns,
    sessionToken: timeline.sessionToken,
    segmentUnits: timeline.segmentUnits,
    learnedHeading: recaps.learnedHeading,
    tlVoc: computeTlVoc(labels, timeline),
    cxVoc: computeCxVoc(labels),
  };
  return deepFreeze(vocab);
}

const DEFAULT_VOCAB = buildVocab(DEFAULT_LABELS, {
  kinds: DEFAULT_KINDS,
  weights: DEFAULT_WEIGHTS,
  sessionToken: DEFAULT_SESSION_TOKEN,
  segmentUnits: DEFAULT_SEGMENT_UNITS,
  columns: DEFAULT_COLUMNS,
}, { learnedHeading: DEFAULT_LEARNED_HEADING });

/**
 * Pure. Validates and resolves `raw`'s [labels], [timeline] and [recaps] tables (own keys of the
 * already-TOML-parsed object). Returns the same DEFAULT_VOCAB object (by reference) when none of
 * the three is an own key of `raw` (L8(a)).
 *
 * @param {object} raw the result of TOML.parse(text)
 * @param {{ T: string, c: string|null }} ctx
 * @returns {{ vocab: object, warnings: string[] }}
 * @throws {ConfigError}
 */
function parseVocab(raw, { T, c }) {
  const hasLabels = hasOwn(raw, 'labels');
  const hasTimeline = hasOwn(raw, 'timeline');
  const hasRecaps = hasOwn(raw, 'recaps');
  if (!hasLabels && !hasTimeline && !hasRecaps) {
    return { vocab: DEFAULT_VOCAB, warnings: [] };
  }

  const warnings = [];
  const labels = parseLabelsTable(raw.labels, warnings, T, c);
  const timeline = parseTimelineTable(raw.timeline, warnings, T, c);
  const recaps = parseRecapsTable(raw.recaps, warnings, T, c);
  const vocab = buildVocab(labels, timeline, recaps);
  return { vocab, warnings };
}

module.exports = {
  DEFAULT_LABELS,
  DEFAULT_VOCAB,
  parseVocab,
  GLYPH_NAMES,
  PATH_DATA_RE,
  KIND_KEY_RE,
  RESERVED_KIND_KEYS,
  TL_CLIENT_LABEL_KEYS,
  CX_CLIENT_LABEL_KEYS,
};
