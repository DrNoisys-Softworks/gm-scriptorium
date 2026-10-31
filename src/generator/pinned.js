'use strict';

/*
 * The single facade onto the pinned generator's PURE functions (Track DEP-b,
 * Structural decision 1). This is the ONLY Scriptorium module that requires
 * gm-apprentice-publish internals, by deep literal path
 * ("gm-apprentice-publish/lib/<file>"). Everything re-exported here is a
 * function Scriptorium calls directly and unmodified; nothing here forks,
 * patches, or vendor-modifies the pin (docs/decisions/0005-generator-pin.md,
 * FR-DEP-02).
 *
 * File I/O — the scan walk, pairStoryFiles, the config merge, and the
 * verdict loop — is ported (not required) into src/vault/publishset.js,
 * because the pin's own file-reading entry points (loadPublishConfig,
 * loadManifest, scanVaultReport) bypass Scriptorium's read-only,
 * abort-on-EIO chokepoint (src/vault/read.js) and write warnings straight to
 * stderr during `check`. Every citation below names the pin's file and line
 * at commit PIN_COMMIT; re-verify them on any pin move
 * (docs/decisions/0005-generator-pin.md's "Pin-move procedure", step 6).
 *
 * `lunr` is the one export here that is not a generator internal — it is the
 * search-index library gm-apprentice-publish depends on directly
 * (lib/search-index.js:3, lib/build.js:856). Track D2's index-term leak
 * check (src/checks/leak/outputscan.js) has to reproduce the generator's own
 * lunr pipeline (trimmer, stopWordFilter, stemmer) byte-for-byte to decide
 * whether a withheld name is reachable as a stemmed or possessive term in
 * search-index.json, and that reproduction is only meaningful against the
 * *same resolved copy* of lunr the generator indexed with — a second,
 * independently-resolved lunr could silently drift in tokenizer or stemmer
 * behaviour. Requiring it here, rather than adding it to package.json's own
 * dependencies, keeps exactly one resolved copy on disk (verified:
 * require.resolve('lunr') from this module and from
 * node_modules/gm-apprentice-publish/lib both resolve to the same
 * node_modules/lunr/lunr.js, because lunr is already hoisted out of the
 * vendored tgz as a top-level dependency and package.json:24 already lists
 * node_modules/lunr/lunr.js in pkg.assets for packaging).
 *
 * installSegmenterShim() (src/generator/intl-shim.js) is called once,
 * unconditionally, below, before `truncateGraphemes` is re-exported. This
 * is deliberately the facade itself, not `src/generator/bootstrap.js`
 * (which installs the same shim, separately, around its own direct
 * `gm-apprentice-publish` `build()` call): `truncateGraphemes` is reached
 * from src/checks/leak/outputscan.js's output-leak scan
 * (needleFormsFor -> truncateGraphemes), which runs on both `build` (via
 * src/build/outputgate.js, after runGeneratorBuild has already restored
 * its own install) and standalone `check` (which never calls
 * runGeneratorBuild / bootstrap.js at all) — bootstrap.js's install never
 * covered either. Because this facade is the one Scriptorium module
 * allowed to deep-require the pin's internals, and every consumer of
 * `truncateGraphemes` gets it only by requiring this file, installing here
 * (module load, before any export is used, since `require()` fully runs a
 * module's body first) covers every current and future call site by
 * construction, not by each caller remembering to install it. On plain
 * node (every dev machine and the test suite) `installSegmenterShim()`'s
 * own gate (`segmenterDataMissing()`) is false, so this is a no-op; it
 * only ever patches inside a packaged pkg small-icu executable. See
 * docs/decisions/0005-generator-pin.md ("Packaging findings resolved,
 * DEP-a2" and its D2 coverage addendum) for the RangeError this closes.
 */
const fs = require('fs');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');

// eslint-disable-next-line global-require
const { installSegmenterShim } = require('./intl-shim');
installSegmenterShim();

// FR-19/SD-19: the runtime no-network guarantee, installed here for the same reason
// installSegmenterShim() is above -- this facade is the one Scriptorium module every consumer of
// the pin's exports goes through, so installing here covers every entry point by construction,
// not by each caller remembering to. Process-lifetime and idempotent (src/generator/netguard.js).
// eslint-disable-next-line global-require
const { installNetworkGuard } = require('./netguard');
installNetworkGuard();

// ADR 0007: the rules-content redactions must be in require.cache before any pin module loads the
// character-sheet templates. Up to publish-v1.21.0 only the build reached them (bootstrap.js seeds
// them just before require('gm-apprentice-publish')). From publish-v1.26.0 nearly every pin module
// requires lib/settings, whose registry requires lib/templates/pc-registry.js, which loads every
// system's templates, gurps/blocks/reference.js and coc/skills-data.js among them. So the facade
// seeds them here, before its first pin require, as it installs the shims above. bootstrap.js still
// re-seeds before each build (applyRedactions accepts its own earlier seed), and a pin module loaded
// before this point makes applyRedactions throw, so the process fails closed.
// eslint-disable-next-line global-require
const { applyRedactions } = require('./redactions');
applyRedactions();

// lib/processor.js:2265 (module.exports)
const {
  stripDataview,
  stripGmOnly,
  stripSpoiler,
  stripHtmlComments,
  stripLeadingH1,
  stripCallouts,
  filterSections,
  keepOnlySections,
  publishedFrontmatter,
  publishMode,
  // dateText (publish-v1.17.0 use) is how the pin prints a YAML date (lib/processor.js:19-21), which
  // src/build/dates.js matches to put the "D Month YYYY" form back.
  dateText,
  // gmAliasRewriter (publish-v1.21.0 use) is how the pin rewrites every GM alias to its owner's title
  // before anything renders (lib/processor.js:2094, run by pairHubs at lib/build.js:754-755);
  // src/build/connections.js applies it before resolving a note's own relationships.
  gmAliasRewriter,
  // L5 (ADR 0045) reads headings as the generator does: findHeadings is the parser reading
  // (lib/processor.js:242-285), renderInline the build's own inline renderer (lib/processor.js:289-291),
  // resolveWikiLinks the wikilink-to-display-text step (lib/processor.js:93-117). Re-exported, never re-implemented.
  findHeadings,
  renderInline,
  resolveWikiLinks,
} = require('gm-apprentice-publish/lib/processor');

/*
 * Issue #100 (ADR 0042) is retired at publish-v1.17.0. Scriptorium used to replace the pin's
 * keepOnlySections with a guard that withheld an excluded parent's sub-headings on a stub page.
 * The pin now does this itself (#320 there): keepOnlySections and stubCut take the build's
 * `withhold` object (lib/processor.js:524) and run a note's strips, then its exclude list, then the
 * cut. Callers must pass that object, as lib/build.js:799 does; without excludeSections nothing is
 * withheld. The real-build proof is test/stub-heading-collision.test.js.
 */

// lib/publish-decision.js:295-309 (module.exports)
const {
  decidePage,
  publishesPage,
  ALWAYS_EXCLUDE_DIRS,
} = require('gm-apprentice-publish/lib/publish-decision');

// lib/manifest.js:99 (module.exports)
const { parseManifest } = require('gm-apprentice-publish/lib/manifest');

// lib/config.js:379 (module.exports).
const { vaultRelPath, scanConfigFor } = require('gm-apprentice-publish/lib/config');

// lib/settings/folders.js:104 and lib/settings/types.js:125 (module.exports). At publish-v1.26.0
// normalizeExcludeDir (lib/settings/folders.js:12-27) moved out of lib/config.js; it is still how the
// pin spells an exclude_dirs entry. readSwitch (lib/settings/types.js:8-13) is the pin's one reader of
// a switch word (true, yes, on, false, no, off): true, false, or null for text that is not one, and
// undefined for a setting that is not set. normalizeExcludeDir's third argument is now a function the pin tells about a
// dropped entry (it was true, false or a function). Scriptorium passes `false` to mean "quietly",
// which the pin would now call and throw on, so the wrapper below turns anything that is not a
// function into a no-op.
const settingsFolders = require('gm-apprentice-publish/lib/settings/folders');
const { readSwitch } = require('gm-apprentice-publish/lib/settings/types');

/**
 * The pin's normalizeExcludeDir, with a non-function `say` read as "say nothing".
 *
 * @param {unknown} entry an exclude_dirs entry as written
 * @param {string} vaultPath
 * @param {Function|boolean} [say]
 * @returns {string|null}
 */
function normalizeExcludeDir(entry, vaultPath, say) {
  return settingsFolders.normalizeExcludeDir(entry, vaultPath, typeof say === 'function' ? say : () => {});
}

// lib/config.js:93-242 (loadPublishConfig) and lib/settings/faults.js:69 (stops): how the build reads a
// vault's settings, and which of its faults stop the build (lib/config.js:246-255, assertNoStops).
// lib/settings/layout.js:10-11 names the two settings files.
const pinConfig = require('gm-apprentice-publish/lib/config');
const settingsLayout = require('gm-apprentice-publish/lib/settings/layout');
const { stops: stopFaults } = require('gm-apprentice-publish/lib/settings/faults');

/**
 * The pin's own reading of a vault's settings (lib/config.js's loadPublishConfig), with the settings
 * file's text supplied by the caller instead of read from disk by the pin.
 *
 * The pin's reader opens `_meta/vault-config.md` itself, with fs (lib/settings/legacy.js:241-243,
 * lib/settings/layout.js:45-48). `check` reads every vault file through src/vault/read.js, which
 * aborts on a failing disk and, for the admin panel, serves an edited copy in place of the file
 * (ADR 0041). So for the length of this one synchronous call, fs.existsSync and fs.readFileSync
 * answer for exactly two paths: the old settings file, from `oldFileText` (null: absent), and the
 * new one, `_meta/vault-config.yaml`, always absent, because Scriptorium refuses a moved vault before
 * it reads settings at all. Every other path goes to the real fs, and both functions are restored in
 * a `finally`, so nothing outside this call ever sees the change (the pattern of
 * src/generator/bootstrap.js's vault read shim).
 *
 * The pin prints nothing here: its warn function is a no-op and stops are kept quiet.
 *
 * @param {string} vaultPath
 * @param {object} siteConfig the site's vault.config.json, as the build is given it
 * @param {string|null} oldFileText the text of _meta/vault-config.md, or null when there is none
 * @returns {{ config: object, stops: object[] }} the pin's publishConfig and its stop-level faults
 * @throws whatever the pin throws for a settings file it cannot parse
 */
function readPublishSettings(vaultPath, siteConfig, oldFileText) {
  const served = new Map([
    [path.resolve(settingsLayout.at(vaultPath, settingsLayout.OLD_FILE)), typeof oldFileText === 'string' ? oldFileText : null],
    [path.resolve(settingsLayout.at(vaultPath, settingsLayout.NEW_FILE)), null],
  ]);
  const servedFor = (p) => (typeof p === 'string' && served.has(path.resolve(p)) ? served.get(path.resolve(p)) : undefined);
  const realExists = fs.existsSync;
  const realRead = fs.readFileSync;
  fs.existsSync = function servedExistsSync(p) {
    const text = servedFor(p);
    return text === undefined ? realExists.apply(fs, arguments) : text !== null;
  };
  fs.readFileSync = function servedReadFileSync(p, options) {
    const text = servedFor(p);
    if (text === undefined) return realRead.apply(fs, arguments);
    if (text === null) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    const encoding = typeof options === 'string' ? options : options && options.encoding;
    return encoding ? text : Buffer.from(text, 'utf8');
  };
  try {
    const config = pinConfig.loadPublishConfig(vaultPath, siteConfig, () => {}, { quietStops: true });
    return { config, stops: stopFaults(config.faults || []) };
  } finally {
    fs.existsSync = realExists;
    fs.readFileSync = realRead;
  }
}

// lib/settings/registry.js:685 (module.exports). At publish-v1.26.0 the pin dropped PUBLISH_DEFAULTS:
// each setting's default now lives on its entry in the settings registry. Scriptorium still reads
// the old shape (check's config models, the panel, the reference pages), so it is rebuilt here from
// the registry, one entry per old key, each found by the old name the registry keeps for it
// (`was`, in the vault file). Against publish-v1.21.0's object two keys differ: landing.max_events
// is new (the landing page's event count), and four_oh_four.style is gone (the pin retired it).
// theme.genre and theme.campaign_image have no default in the registry (unset), as before.
const settingsRegistry = require('gm-apprentice-publish/lib/settings/registry');

const OLD_DEFAULT_KEYS = [
  'mode', 'exclude_drafts', 'exclude_callouts', 'exclude_sections', 'exclude_fields', 'exclude_dirs',
  'search', 'attachments_dir', 'folder_map',
  'landing.recency_window', 'landing.max_npcs', 'landing.max_locations', 'landing.max_events',
  'landing.featured_npcs', 'landing.featured_locations', 'landing.quick_links',
  'theme.palette.primary', 'theme.palette.accent', 'theme.palette.background', 'theme.palette.text',
  'theme.fonts.heading', 'theme.fonts.body', 'theme.fonts.source', 'theme.fonts.files', 'theme.default_mode',
  'four_oh_four.message',
  'images.optimize', 'images.format', 'images.max_width', 'images.quality',
  'overrides.fields', 'section_titles',
];

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function buildPublishDefaults() {
  const out = { theme: { genre: null, campaign_image: null } };
  for (const key of OLD_DEFAULT_KEYS) {
    const oldName = `publish.${key}`;
    const e = settingsRegistry.REGISTRY.find((x) => (x.was || []).some((w) => w.in === 'vault' && w.name === oldName));
    if (!e || e.default === undefined) {
      throw new ScriptoriumError(`the pinned generator's settings registry has no default for ${oldName}`);
    }
    const parts = key.split('.');
    let at = out;
    for (const part of parts.slice(0, -1)) at = at[part] || (at[part] = {});
    at[parts[parts.length - 1]] = structuredClone(e.default);
  }
  // Key order as publish-v1.21.0 had it, so anything that lists the keys lists them as before.
  const { theme, ...rest } = out;
  const { genre, palette, fonts, campaign_image: campaignImage, default_mode: defaultMode } = theme;
  const { landing, four_oh_four: notFound, images, overrides, section_titles: sectionTitles, ...head } = rest;
  return deepFreeze({
    ...head,
    landing,
    theme: { genre, palette, fonts, campaign_image: campaignImage, default_mode: defaultMode },
    four_oh_four: notFound,
    images,
    overrides,
    section_titles: sectionTitles,
  });
}

const PUBLISH_DEFAULTS = buildPublishDefaults();

// The words a withheld name is printed as (lib/settings/registry.js:567-582), the pin's defaults.
// An old-layout vault cannot set them, so they are what its build uses; publishset's
// loadPublishConfig carries the build's own reading as publishConfig.withheld_words.
const DEFAULT_WITHHELD_WORDS = deepFreeze({
  person: settingsRegistry.entry('player_site.withheld_words.person').default,
  place: settingsRegistry.entry('player_site.withheld_words.place').default,
  thing: settingsRegistry.entry('player_site.withheld_words.thing').default,
});

// lib/scanner.js:457 (module.exports). buildLinkMap (publish-v1.21.0 use) is the pin's own name-to-page
// table, which src/build/connections.js resolves relationship targets against. dirIsExcluded is FR-16/SD-19's new export: the pin's own
// case-insensitive excludeDirs matcher (matchExcludedDir), used by src/vault/publishset.js so its
// hand-ported directory-skip test can never drift from the pin's own casing rule.
const { slugify, mapFolder, dirIsExcluded, buildLinkMap } = require('gm-apprentice-publish/lib/scanner');

// lib/session-hub.js's module doc block (module.exports): FR-21/SD-21's session-model guard.
// "This file is the ONE pairing rule, and pairHubs the one place it runs... Change the rule here
// only." -- required unmodified, never re-implemented (SD-21's own rejected alternative).
// R2 (ADR 0036) adds isWrapUp/WRAP_UP_TYPES from the same module: the ONE Wrap-Up type list,
// never wiki.js's own second copy (docs/agent-runs corrections, R2) and never a hand copy.
const { pairHubs, isWrapUp, WRAP_UP_TYPES } = require('gm-apprentice-publish/lib/session-hub');

// lib/theme.js:211 (module.exports). resolveGenrePreset is gone at publish-v1.26.0 (the settings
// reader now turns an unknown genre into null before the theme sees it); its body was one line over
// GENRE_ALIASES, which the pin still exports, and this is that line.
const { GENRE_ALIASES } = require('gm-apprentice-publish/lib/theme');

/**
 * The preset a genre names, or null: publish-v1.21.0's resolveGenrePreset, over the pin's own aliases.
 *
 * @param {unknown} genre
 * @returns {string|null}
 */
function resolveGenrePreset(genre) {
  if (!genre) return null;
  return GENRE_ALIASES[String(genre).toLowerCase().trim()] || null;
}

// lib/wikilink.js:197 (module.exports). labelsForLinks is new at publish-v1.17.0: how the pin prints a
// wikilink inside a title (by its label), which src/vault/publishset.js's display-title port calls.
// linkText, wikilinkRe and parseWikilink are how the pin's Connections model reads a relationship's
// target (lib/connections.js:159-169); src/build/connections.js resolves targets the same way.
// #194: src/vault/links.js (check) finds wikilinks with the pin's own pattern (wikilinkRe, lib/wikilink.js:22-24,
// over WIKILINK_SOURCE at :18) and splits them with its parser (parseWikilink, lib/wikilink.js:40-60), never a hand copy.
const { labelsForLinks, linkText, wikilinkRe, parseWikilink } = require('gm-apprentice-publish/lib/wikilink');

// lib/frontmatter.js:155 and lib/frontmatter-shape.js:110 (module.exports). New at
// publish-v1.17.0: the scanner cuts comments out of frontmatter values, then puts wrongly typed values
// into shape or leaves them unread (lib/scanner.js:127-129); src/vault/publishset.js does the same.
const { cutValueComments } = require('gm-apprentice-publish/lib/frontmatter');
const { shapeFrontmatter } = require('gm-apprentice-publish/lib/frontmatter-shape');

// lib/unicode.js:93 (module.exports)
const { canonicalNfc, truncateGraphemes } = require('gm-apprentice-publish/lib/unicode');

// lib/templates/base.js:245-266 (module.exports). DIR_LABELS (ADR 0061): the sections lib/build.js
// resolves a banner for (lib/build.js:1692), read by src/vault/imagecopies.js.
const { metadataBadgesFor, TYPE_BADGE_FIELDS, DIR_LABELS } = require('gm-apprentice-publish/lib/templates/base');

// lib/banners.js:109-114 (module.exports). ADR 0061: the pin's own banner-entry reader, folder lookup,
// SVG test and extension order, so src/vault/imagecopies.js picks the banner the build copies.
// resolveBanner and findConventionBanner are not re-exported: they read the disk directly, so their
// file I/O is ported there instead, through src/vault/read.js.
const { normalizeEntry, sourceFolderFor, isSvg, BANNER_EXTS } = require('gm-apprentice-publish/lib/banners');

// Not a gm-apprentice-publish internal; see the module doc block above. FR-17/SD-17 (v1.11.40
// bundles its own gray-matter/lunr/markdown-it, so lunr is no longer hoisted to a top-level
// node_modules/lunr -- it installs inside the package): require it from the exact bundled copy
// the generator itself resolves, a literal path so pkg's static asset walk sees it and PIN.json
// integrity-pins it.
// eslint-disable-next-line global-require
const lunr = require('gm-apprentice-publish/node_modules/lunr');
// eslint-disable-next-line global-require
const LUNR_VERSION = require('gm-apprentice-publish/node_modules/lunr/package.json').version;

const PIN_COMMIT = '228fa161932d9119408d28e11628e22dd9b2ed76';

/*
 * V1e-1 (ADR 0033, SD-5): the generator's OWN gray-matter, as the pin's lib/frontmatter.js:2 itself
 * resolves it (lib/config.js:4 reached it directly up to publish-v1.11.44) -- deliberately not Scriptorium's own top-level gray-matter, because
 * src/admin/vaultconfigedit.js's semantic guard exists specifically to catch the two ever
 * disagreeing.
 *
 * R1 repin (2026-09-30): at `78696167`, this is no longer the same module. gray-matter is now a
 * BUNDLED dependency (SD-17's lunr precedent, arrived), so the line below is the literal,
 * pkg-visible, PIN.json-integrity-pinned path into the bundle --
 * `require('gm-apprentice-publish/node_modules/gray-matter')` -- never the hoisted top-level copy
 * `src/vault/read.js` uses. `test/vault-config-parsers.test.js`'s identity test now proves THIS
 * fact (the generator's own resolved copy) instead of the old "same hoisted module" one; its
 * sibling test recording "same module as Scriptorium's own" is inverted to record the opposite,
 * now-true fact, per this same file's own comment predicting exactly this moment.
 */
// eslint-disable-next-line global-require
const generatorGrayMatter = require('gm-apprentice-publish/node_modules/gray-matter');

/*
 * ADR 0034 / FR-FM-03: freeze the bundled gray-matter's engine registry to yaml-only, then
 * self-check the freeze THROUGH the generator's own parseManifest (proving the neutering reached
 * the exact copy the generator itself resolves, not merely this module's own reference to it).
 * Installed here, at facade load, following the same "this facade is the one module every
 * consumer goes through" reasoning as installSegmenterShim()/installNetworkGuard() above --
 * covers every current and future generator call site by construction. A throw here (either
 * call) propagates out of this module's load, which bin/scriptorium.js:66 loads before
 * dispatching any command, so a self-check failure fails the whole process closed at exit 1 (the
 * redactions.js pattern), before any vault content could ever reach the generator.
 */
// eslint-disable-next-line global-require
const fmguard = require('./fmguard');
fmguard.installFrontmatterEngineGuard(generatorGrayMatter);
fmguard.verifyFrontmatterEngineGuard(parseManifest, generatorGrayMatter);

/**
 * The pin's scaffold vault.config.json template, raw (ADR 0021). Located
 * the same way the pin's own `init()` locates it (lib/init.js:8), but
 * anchored on `require.resolve('gm-apprentice-publish/lib/processor.js')`
 * rather than `__dirname`: this facade is the one Scriptorium module
 * allowed to deep-require the pin's internals, and processor.js is already
 * required elsewhere in this file, so it is guaranteed present in a
 * packaged snapshot even if lib/init.js itself is not.
 *
 * @returns {string}
 * @throws {ScriptoriumError}
 */
function readVaultConfigTemplate() {
  const p = path.join(
    path.dirname(require.resolve('gm-apprentice-publish/lib/processor.js')),
    '..',
    'templates-scaffold',
    'vault.config.json.tmpl',
  );
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new ScriptoriumError(`could not read the generator's vault.config.json template at ${p}: ${err.message}`, {
      path: p,
      cause: err,
    });
  }
}

module.exports = {
  stripDataview,
  stripGmOnly,
  stripSpoiler,
  stripHtmlComments,
  stripLeadingH1,
  stripCallouts,
  filterSections,
  findHeadings,
  renderInline,
  resolveWikiLinks,
  keepOnlySections,
  publishedFrontmatter,
  publishMode,
  dateText,
  gmAliasRewriter,
  decidePage,
  publishesPage,
  ALWAYS_EXCLUDE_DIRS,
  parseManifest,
  PUBLISH_DEFAULTS,
  DEFAULT_WITHHELD_WORDS,
  readPublishSettings,
  vaultRelPath,
  scanConfigFor,
  normalizeExcludeDir,
  readSwitch,
  slugify,
  mapFolder,
  dirIsExcluded,
  pairHubs,
  isWrapUp,
  WRAP_UP_TYPES,
  resolveGenrePreset,
  labelsForLinks,
  linkText,
  wikilinkRe,
  parseWikilink,
  buildLinkMap,
  cutValueComments,
  shapeFrontmatter,
  canonicalNfc,
  truncateGraphemes,
  metadataBadgesFor,
  TYPE_BADGE_FIELDS,
  DIR_LABELS,
  normalizeEntry,
  sourceFolderFor,
  isSvg,
  BANNER_EXTS,
  lunr,
  LUNR_VERSION,
  PIN_COMMIT,
  readVaultConfigTemplate,
  generatorGrayMatter,
};
