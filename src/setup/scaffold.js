'use strict';

const fs = require('fs');
const path = require('path');
const read = require('../vault/read');
const pinned = require('../generator/pinned');
const { ScriptoriumError } = require('../util/errors');
const { deriveFolderMapAdditions } = require('./foldermap');
const { composePackToml } = require('./validate');

/*
 * The pieces `init` and browser setup share, so the two can never drift (ADR 0028). Moved out of
 * src/cli/init.js, which now requires them from here and re-exports the identical objects (the
 * src/setup/validate.js precedent). `init.js` stays write-free (test/pack-write.test.js's PW15), and
 * so does this module: the only vault writes anywhere are createPackEntries in
 * src/vault/packwrite.js, which the callers hand the entries built here.
 */

const SCAFFOLD = Object.freeze([
  { rel: 'css', kind: 'dir' },
  { rel: 'images', kind: 'dir' },
  { rel: 'pack.toml', kind: 'file' },
  { rel: 'vault.config.json', kind: 'file' },
]);

/** D-02: never "out", always a sibling of the vault named after the campaign. */
function defaultOutputFor(vaultAbs, name) {
  return path.join(path.dirname(vaultAbs), `${name}-site`);
}

/** vault-config.md's `campaign` frontmatter, if it's a non-empty string once trimmed; otherwise the name. */
function defaultTitleFor(vaultAbs, name) {
  const configPath = path.join(vaultAbs, '_meta', 'vault-config.md');
  const result = read.readFrontmatter(configPath);
  if (result.ok && typeof result.data.campaign === 'string' && result.data.campaign.trim().length > 0) {
    return result.data.campaign.trim();
  }
  return name;
}

/**
 * Stopgap, publish-v1.12.0 repin. Up to publish-v1.11.44 the pin's vault.config.json template
 * carried these campaign settings and a new pack inherited them from it. At publish-v1.12.0 the
 * pin moved them to `publish:` in _meta/vault-config.md and its template shrank to deploy keys.
 * `init` writes only under <vault>/_meta/scriptorium/, and src/vault/packconfig's shape check
 * requires excludeDirs and folderMap in the pack's own file, so a new pack still gets them here,
 * in their old JSON spelling and with the values the 1.11.44 template had. The pin reads them
 * as a fallback and warns on every build that they have moved; it plans to drop that fallback at
 * plugin 1.11.0. Whether `init` should write `publish:` in the vault file instead is an open
 * owner decision (docs/decisions/0005-generator-pin.md, publish-v1.12.0 addendum).
 */
const LEGACY_SCAFFOLD_SETTINGS = {
  landingTagline: '',
  attachmentsDir: '_attachments',
  folderMap: {
    'Characters/PCs': 'characters/pcs',
    'Characters/NPCs': 'characters/npcs',
    Locations: 'locations',
    'Factions & Organizations': 'factions',
    'Items & Artifacts': 'items',
    Creatures: 'creatures',
    Events: 'events',
    Documents: 'documents',
    Clues: 'clues',
    Chapters: 'chapters',
    _Campaign: 'campaign',
    _World: 'world',
    Heritages: 'heritages',
  },
  excludeDirs: ['_meta', '_Templates', '_resources'],
  excludeSections: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'],
  excludeCallouts: true,
  backend: { statusBar: false, inbox: false },
};

/**
 * SD-6: parse the template, delete vaultPath/outputDir/siteUrl (pack-relative
 * inputs a pack resolves itself, and a 404-page basePath this scaffold has
 * no opinion on), set siteTitle, add LEGACY_SCAFFOLD_SETTINGS for any key the
 * template does not carry itself, then serialise. A leftover `{{NAME}}`
 * placeholder anywhere else in the template is a packaging defect, not a
 * silently-shipped literal.
 *
 * @throws {ScriptoriumError} I-TEMPLATE
 */
function composeVaultConfigJson(templateText, title, extraFolderMap = {}) {
  const fail = (reason) => {
    throw new ScriptoriumError(`the generator's vault.config.json template ${reason}`);
  };

  let obj;
  try {
    obj = JSON.parse(templateText);
  } catch (err) {
    fail(`is not valid JSON: ${err.message}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    fail('is not a JSON object');
  }

  delete obj.vaultPath;
  delete obj.outputDir;
  delete obj.siteUrl;
  obj.siteTitle = title;

  const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/;
  function checkNoPlaceholder(value) {
    if (typeof value === 'string') {
      const m = value.match(PLACEHOLDER_RE);
      if (m) fail(`still contains the placeholder ${m[0]}`);
    } else if (Array.isArray(value)) {
      value.forEach(checkNoPlaceholder);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) checkNoPlaceholder(v);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'siteTitle') continue; // the guard must ignore siteTitle: the GM's own title may contain "{{"
    checkNoPlaceholder(value);
  }

  // Key order is the 1.11.44 template's own, so a pack scaffolded at this pin is byte-identical to
  // one scaffolded before it. A template key always wins over the stopgap default.
  const { host, siteTitle, ...rest } = obj;
  const { landingTagline, ...legacy } = LEGACY_SCAFFOLD_SETTINGS;
  const out = { siteTitle, landingTagline, ...(host !== undefined ? { host } : {}), ...structuredClone(legacy), ...rest };
  // Added after the stopgap, not on the template object: at this pin the template has no folderMap,
  // and one set there would replace the stopgap's whole map through `...rest`.
  if (Object.keys(extraFolderMap).length > 0) out.folderMap = { ...(out.folderMap || {}), ...extraFolderMap };

  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Step 6's entry building: the create-only list handed to createPackEntries for the scaffold
 * entries that are missing from the pack folder.
 *
 * @param {string} vaultAbs
 * @param {{ rel: string, kind: 'dir'|'file' }[]} missing a subset of SCAFFOLD
 * @param {{ title: string, theme: string }} answers
 */
function scaffoldEntries(vaultAbs, missing, { title, theme }) {
  return missing.map((entry) => {
    if (entry.kind === 'dir') return { rel: entry.rel, kind: 'dir' };
    if (entry.rel === 'pack.toml') return { rel: entry.rel, kind: 'file', data: composePackToml(theme) };
    const templateText = pinned.readVaultConfigTemplate();
    // Issue #103: the scaffold template maps no Sessions folder and no folder of this vault's
    // own, so add what the vault actually has; otherwise those pages are dropped silently.
    const base = JSON.parse(composeVaultConfigJson(templateText, title));
    const extra = deriveFolderMapAdditions(vaultAbs, base);
    return { rel: entry.rel, kind: 'file', data: composeVaultConfigJson(templateText, title, extra) };
  });
}

/** A1 (orchestrator addendum): a folder that exists, is non-empty, and does not look like a previous build. */
function looksLikePreviousBuild(outAbs) {
  return fs.existsSync(path.join(outAbs, 'index.html')) && fs.existsSync(path.join(outAbs, 'css', 'scriptorium.css'));
}

function isNonEmptyForeignOutput(outAbs) {
  if (!fs.existsSync(outAbs)) return false;
  let entries;
  try {
    entries = fs.readdirSync(outAbs);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return !looksLikePreviousBuild(outAbs);
}

/** What `init` prints before asking whether to continue with a non-empty foreign output folder. */
function nonEmptyOutputWarning(outAbs) {
  return `warning: ${outAbs} exists and is not empty; the first build will replace its contents`;
}

/** What `init --yes` (and browser setup without the tick) refuses with. */
function nonEmptyOutputRefusal(outAbs) {
  return (
    `refusing to use ${outAbs} as the output folder: it exists and is not empty and does not look like a ` +
    'previous build; choose an empty or new folder'
  );
}

function cleanPathAnswer(raw) {
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return path.resolve(s);
}

module.exports = {
  SCAFFOLD,
  defaultOutputFor,
  defaultTitleFor,
  LEGACY_SCAFFOLD_SETTINGS,
  composeVaultConfigJson,
  scaffoldEntries,
  looksLikePreviousBuild,
  isNonEmptyForeignOutput,
  nonEmptyOutputWarning,
  nonEmptyOutputRefusal,
  cleanPathAnswer,
};
