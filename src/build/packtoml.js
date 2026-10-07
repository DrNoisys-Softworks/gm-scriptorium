'use strict';

const TOML = require('smol-toml');
const path = require('path');
const read = require('../vault/read');
const { ConfigError } = require('../util/errors');
const { DEFAULT_THEME, SLOT_NAMES, THEMES } = require('./themes');
const { platformFoldsCase } = require('../vault/exclusions');
const { DEFAULT_VOCAB, parseVocab } = require('./labels');

/*
 * ADR 0019: an optional pack.toml, the opt-in for the whole asset step
 * (Structural decision 3). Parsing (P3a-FR05) is pure over already-read
 * text, so it can run inside resolveVaultContext for check/build/status
 * alike; reading is loadPackToml's job, through the vault read chokepoint.
 */

const PACK_TOML_FILE = 'pack.toml';

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Validates one [images] slot value against the syntax rules, in the
 * documented order, and returns its SlotRef. Throws the first applicable
 * ConfigError.
 */
function validateSlotValue(slot, raw, { T, c, D }) {
  const fail = (message) => {
    throw new ConfigError(message, { path: T, campaign: c });
  };

  if (raw.includes('\\')) {
    fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" uses a backslash; write paths with forward slashes, even on Windows`);
  }

  let kind = 'pack';
  let p = raw;
  if (raw.startsWith('vault:')) {
    kind = 'vault';
    p = raw.slice('vault:'.length);
  }

  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" is an absolute path; write "vault:<path inside the vault>" or a path relative to ${D}`);
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) {
    fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" is a URL; only files inside the vault ("vault:<path>") or relative to ${D} are allowed`);
  }

  const segments = p.split('/');

  if (segments.includes('..')) {
    fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" contains ".."; write "vault:<path inside the vault>" or a path relative to ${D}`);
  }

  if (segments.some((s) => s === '' || s === '.')) {
    fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" has an empty or "." path segment; write a plain relative path such as "images/example.webp"`);
  }

  if (kind === 'vault') {
    const first = segments[0];
    const folded = platformFoldsCase() ? first.toLowerCase() : first;
    if (folded === '_meta') {
      fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" points into _meta/; put the image in ${D} and write its path relative to that folder instead`);
    }
  }

  return { slot, raw, kind, rel: p };
}

/**
 * Pure. @returns {{ path, present: true, theme: string, images: SlotRef[], warnings: string[], vocab: object }}
 * SlotRef = { slot: string, raw: string, kind: 'vault'|'pack', rel: string } (images in
 * SLOT_NAMES order). `vocab` is ADR 0020's resolved [labels]/[timeline]/[recaps] object
 * (src/build/labels.js), or the shared DEFAULT_VOCAB reference when none of those tables is
 * present.
 * @throws {ConfigError}
 */
function parsePackToml(text, { tomlPath, campaign = null, registry = THEMES }) {
  const T = tomlPath;
  const c = campaign;

  let raw;
  try {
    raw = TOML.parse(text);
  } catch (err) {
    throw new ConfigError(`campaign "${c}": ${T} is not valid TOML: ${err.message.replace(/\s+/g, ' ')}`, {
      path: T,
      campaign: c,
    });
  }

  const warnings = [];

  let theme = DEFAULT_THEME;
  if (hasOwn(raw, 'theme')) {
    if (typeof raw.theme !== 'string') {
      throw new ConfigError(`campaign "${c}": ${T}: theme must be a string`, { path: T, campaign: c });
    }
    theme = raw.theme;
  }
  if (!hasOwn(registry, theme)) {
    throw new ConfigError(
      `campaign "${c}": ${T}: unknown theme "${theme}"; valid themes: ${Object.keys(registry).sort().join(', ')}`,
      { path: T, campaign: c },
    );
  }

  for (const k of Object.keys(raw)) {
    if (k !== 'theme' && k !== 'images' && k !== 'labels' && k !== 'timeline' && k !== 'recaps') {
      warnings.push(`${T}: unrecognised key "${k}" (ignored)`);
    }
  }

  let imagesTable = {};
  if (hasOwn(raw, 'images')) {
    const imagesVal = raw.images;
    if (typeof imagesVal !== 'object' || imagesVal === null || Array.isArray(imagesVal)) {
      throw new ConfigError(`campaign "${c}": ${T}: [images] must be a table`, { path: T, campaign: c });
    }
    imagesTable = imagesVal;
  }

  const D = path.dirname(T);
  const bySlot = {};
  for (const [slot, value] of Object.entries(imagesTable)) {
    if (!SLOT_NAMES.includes(slot)) {
      warnings.push(`${T}: [images] unrecognised slot "${slot}" (ignored; slots are ${SLOT_NAMES.join(', ')})`);
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new ConfigError(`campaign "${c}": ${T}: [images] ${slot} must be a non-empty string`, { path: T, campaign: c });
    }
    bySlot[slot] = value;
  }

  const images = [];
  for (const slot of SLOT_NAMES) {
    if (!hasOwn(bySlot, slot)) continue;
    images.push(validateSlotValue(slot, bySlot[slot], { T, c, D }));
  }

  // ADR 0020 (P4-FR02): [labels]/[timeline]/[recaps] parse after [images], appending their
  // warnings to the ones collected above.
  const { vocab, warnings: vocabWarnings } = parseVocab(raw, { T, c });
  warnings.push(...vocabWarnings);

  return { path: T, present: true, theme, images, warnings, vocab };
}

/**
 * read.pathExists then read.readText (called via the module object, so
 * tests can spy). Absent -> { path, present: false, theme: DEFAULT_THEME,
 * images: [], warnings: [] } with no readText call.
 *
 * @param {string} siteDir absolute
 * @param {{ campaign?: string, registry?: object }} [opts]
 */
function loadPackToml(siteDir, { campaign = null, registry = THEMES } = {}) {
  const tomlPath = path.join(siteDir, PACK_TOML_FILE);
  if (!read.pathExists(tomlPath)) {
    return { path: tomlPath, present: false, theme: DEFAULT_THEME, images: [], warnings: [], vocab: DEFAULT_VOCAB };
  }
  const text = read.readText(tomlPath);
  return parsePackToml(text, { tomlPath, campaign, registry });
}

module.exports = { PACK_TOML_FILE, parsePackToml, loadPackToml };
