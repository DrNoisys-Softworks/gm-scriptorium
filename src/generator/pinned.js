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
 * (lib/search-index.js:3, lib/build.js:631). Track D2's index-term leak
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

// lib/processor.js:1707 (module.exports)
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
  // L5 (ADR 0045) reads headings as the generator does: findHeadings is the parser reading
  // (lib/processor.js:204-247), renderInline the build's own inline renderer (lib/processor.js:251-253),
  // resolveWikiLinks the wikilink-to-display-text step (lib/processor.js:91-115). Re-exported, never re-implemented.
  findHeadings,
  renderInline,
  resolveWikiLinks,
} = require('gm-apprentice-publish/lib/processor');

/*
 * Issue #100 (ADR 0042) is retired at publish-v1.17.0. Scriptorium used to replace the pin's
 * keepOnlySections with a guard that withheld an excluded parent's sub-headings on a stub page.
 * The pin now does this itself (#320 there): keepOnlySections and stubCut take the build's
 * `withhold` object (lib/processor.js:474) and run a note's strips, then its exclude list, then the
 * cut. Callers must pass that object, as lib/build.js:589 does; without excludeSections nothing is
 * withheld. The real-build proof is test/stub-heading-collision.test.js.
 */

// lib/publish-decision.js:220-229 (module.exports)
const {
  decidePage,
  publishesPage,
  ALWAYS_EXCLUDE_DIRS,
} = require('gm-apprentice-publish/lib/publish-decision');

// lib/manifest.js:99 (module.exports)
const { parseManifest } = require('gm-apprentice-publish/lib/manifest');

// lib/config.js:567 (module.exports)
const { PUBLISH_DEFAULTS, vaultRelPath, scanConfigFor } = require('gm-apprentice-publish/lib/config');

// lib/scanner.js:444 (module.exports). dirIsExcluded is FR-16/SD-19's new export: the pin's own
// case-insensitive excludeDirs matcher (matchExcludedDir), used by src/vault/publishset.js so its
// hand-ported directory-skip test can never drift from the pin's own casing rule.
const { slugify, mapFolder, dirIsExcluded } = require('gm-apprentice-publish/lib/scanner');

// lib/session-hub.js's module doc block (module.exports): FR-21/SD-21's session-model guard.
// "This file is the ONE pairing rule, and pairHubs the one place it runs... Change the rule here
// only." -- required unmodified, never re-implemented (SD-21's own rejected alternative).
// R2 (ADR 0036) adds isWrapUp/WRAP_UP_TYPES from the same module: the ONE Wrap-Up type list,
// never wiki.js's own second copy (docs/agent-runs corrections, R2) and never a hand copy.
const { pairHubs, isWrapUp, WRAP_UP_TYPES } = require('gm-apprentice-publish/lib/session-hub');

// lib/theme.js:217 (module.exports)
const { resolveGenrePreset } = require('gm-apprentice-publish/lib/theme');

// lib/wikilink.js:129 (module.exports). New at publish-v1.17.0: how the pin prints a wikilink
// inside a title (by its label), which src/vault/publishset.js's display-title port calls.
const { labelsForLinks } = require('gm-apprentice-publish/lib/wikilink');

// lib/frontmatter.js:155 and lib/frontmatter-shape.js:110 (module.exports). New at
// publish-v1.17.0: the scanner cuts comments out of frontmatter values, then puts wrongly typed values
// into shape or leaves them unread (lib/scanner.js:126-128); src/vault/publishset.js does the same.
const { cutValueComments } = require('gm-apprentice-publish/lib/frontmatter');
const { shapeFrontmatter } = require('gm-apprentice-publish/lib/frontmatter-shape');

// lib/unicode.js:89 (module.exports)
const { canonicalNfc, truncateGraphemes } = require('gm-apprentice-publish/lib/unicode');

// lib/templates/base.js:230-249 (module.exports). DIR_LABELS (ADR 0061): the sections lib/build.js
// resolves a banner for (lib/build.js:1401), read by src/vault/imagecopies.js.
const { metadataBadgesFor, TYPE_BADGE_FIELDS, DIR_LABELS } = require('gm-apprentice-publish/lib/templates/base');

// lib/banners.js:96-99 (module.exports). ADR 0061: the pin's own banner-entry reader, folder lookup,
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

const PIN_COMMIT = 'db6fb2b083e8ee897a381b9de4642f12769e4cc2';

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
  decidePage,
  publishesPage,
  ALWAYS_EXCLUDE_DIRS,
  parseManifest,
  PUBLISH_DEFAULTS,
  vaultRelPath,
  scanConfigFor,
  slugify,
  mapFolder,
  dirIsExcluded,
  pairHubs,
  isWrapUp,
  WRAP_UP_TYPES,
  resolveGenrePreset,
  labelsForLinks,
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
