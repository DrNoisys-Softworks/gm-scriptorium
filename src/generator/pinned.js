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
 * (lib/search-index.js:3, lib/build.js:559). Track D2's index-term leak
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

// lib/processor.js:1281 (module.exports)
const {
  stripDataview,
  stripGmOnly,
  stripSpoiler,
  stripHtmlComments,
  stripLeadingH1,
  stripCallouts,
  filterSections,
  keepOnlySections: upstreamKeepOnlySections,
  publishedFrontmatter,
  publishMode,
} = require('gm-apprentice-publish/lib/processor');

/*
 * Issue #100: the pin's keepOnlySections (lib/processor.js, `publish: stub`) keeps any heading
 * whose TEXT matches an include entry, wherever it sits in the heading tree. A `### Appearance`
 * under the withheld `## GM Notes` was therefore kept on a stub page, and because the withheld
 * parent heading is dropped by the same pass, the later filterSections has nothing left to match:
 * the sub-heading published, and with it the search index and backlinks. UPSTREAM DEFECT, not
 * Scriptorium's section filter (src/ never filters sections). See the report / docs/COLLABORATING.md.
 *
 * Scriptorium-layer fix: this guard runs filterSections (the excluded sections, withheld parent
 * wins) BEFORE the pin's keepOnlySections. That is semantically identical to the pin's own order
 * for everything except the leak: filterSections runs on every published body afterwards anyway.
 *
 * Reach: lib/build.js destructures keepOnlySections from the processor's exports at ITS module load
 * (the only callers on the build path are lib/build.js:523 and :529; processor.js calls it from nowhere;
 * lib/lines-cli.js and lib/sheet-cli.js also use it, but a build never reaches them), so replacing
 * the export here works for the build if, and only if, it happens before lib/build.js first loads.
 * That is unlike ADR 0013's filterSections, which processor.js also calls internally. The
 * `live` flag records whether the replacement beat build.js; runGeneratorBuild refuses to build
 * (fail closed) when it did not. The effective excluded sections of the build in flight are set
 * per build via setStubExcludeSections (bootstrap.js); with none set, PUBLISH_DEFAULTS apply.
 */
const processorModule = require('gm-apprentice-publish/lib/processor');
const STUB_GUARD_BUILD_PATH = require.resolve('gm-apprentice-publish/lib/build.js');

function installStubSectionGuard() {
  const existing = processorModule.keepOnlySections;
  // Idempotent across a re-evaluated copy of this module: reuse the first install, so the state
  // build.js's binding reads from is the one state every copy of this module writes to.
  if (existing && existing.scriptoriumStubGuard) return existing;
  function guardedKeepOnlySections(markdown, includeSections = [], excludeSections) {
    const exclude = Array.isArray(excludeSections)
      ? excludeSections
      : guardedKeepOnlySections.currentExclude || PUBLISH_DEFAULTS.exclude_sections;
    return upstreamKeepOnlySections(filterSections(markdown, exclude), includeSections);
  }
  guardedKeepOnlySections.scriptoriumStubGuard = true;
  guardedKeepOnlySections.currentExclude = null;
  guardedKeepOnlySections.live = !require.cache[STUB_GUARD_BUILD_PATH];
  processorModule.keepOnlySections = guardedKeepOnlySections;
  return guardedKeepOnlySections;
}

const keepOnlySections = installStubSectionGuard();

/** @param {string[]|null} list the effective exclude_sections of the build about to run, or null to clear. */
function setStubExcludeSections(list) {
  keepOnlySections.currentExclude = Array.isArray(list) ? list.slice() : null;
}

/** @throws {ScriptoriumError} when the guard cannot reach lib/build.js's binding (fail closed). */
function assertStubGuardLive() {
  if (processorModule.keepOnlySections !== keepOnlySections || keepOnlySections.live !== true) {
    throw new ScriptoriumError(
      'the stub-page section guard (issue #100) is not live: gm-apprentice-publish/lib/build.js was loaded before src/generator/pinned.js ' +
        'replaced keepOnlySections, so a stub page could publish a withheld sub-heading. Refusing to build.',
    );
  }
}

// lib/publish-decision.js:220-229 (module.exports)
const {
  decidePage,
  publishesPage,
  ALWAYS_EXCLUDE_DIRS,
} = require('gm-apprentice-publish/lib/publish-decision');

// lib/manifest.js:99 (module.exports)
const { parseManifest } = require('gm-apprentice-publish/lib/manifest');

// lib/config.js:539 (module.exports)
const { PUBLISH_DEFAULTS, vaultRelPath, scanConfigFor } = require('gm-apprentice-publish/lib/config');

// lib/scanner.js:415 (module.exports). dirIsExcluded is FR-16/SD-19's new export: the pin's own
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

// lib/unicode.js:89 (module.exports)
const { canonicalNfc, truncateGraphemes } = require('gm-apprentice-publish/lib/unicode');

// lib/templates/base.js:206-215 (module.exports)
const { metadataBadgesFor, TYPE_BADGE_FIELDS } = require('gm-apprentice-publish/lib/templates/base');

// Not a gm-apprentice-publish internal; see the module doc block above. FR-17/SD-17 (v1.11.40
// bundles its own gray-matter/lunr/markdown-it, so lunr is no longer hoisted to a top-level
// node_modules/lunr -- it installs inside the package): require it from the exact bundled copy
// the generator itself resolves, a literal path so pkg's static asset walk sees it and PIN.json
// integrity-pins it.
// eslint-disable-next-line global-require
const lunr = require('gm-apprentice-publish/node_modules/lunr');
// eslint-disable-next-line global-require
const LUNR_VERSION = require('gm-apprentice-publish/node_modules/lunr/package.json').version;

const PIN_COMMIT = 'ea94de7f47f398eb695600653017323ee20caa65';

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
  keepOnlySections,
  setStubExcludeSections,
  assertStubGuardLive,
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
  canonicalNfc,
  truncateGraphemes,
  metadataBadgesFor,
  TYPE_BADGE_FIELDS,
  lunr,
  LUNR_VERSION,
  PIN_COMMIT,
  readVaultConfigTemplate,
  generatorGrayMatter,
};
