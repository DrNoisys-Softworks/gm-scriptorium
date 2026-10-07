'use strict';

const path = require('path');
const { buildResolutionIndex } = require('../vault/index');
const { computePublishedSet, scanAllCandidatePages } = require('../vault/publishset');
const { pathExists } = require('../vault/read');
const { readRelationshipTypes } = require('../vault/relationshiptypes');

/**
 * Does `outputPath` contain an actual build, as opposed to merely existing?
 * The migration layout (retained in the private archive at `b5b48b4`) pre-creates `out/` for every
 * campaign before anything has ever been built into it, so "the directory
 * exists" is not evidence of a build; every new campaign starts in exactly
 * that state, and it is the state the real NAS vault was in the first time
 * a reviewer ran `check` against it. `build()` (lib/build.js) always writes
 * `index.html` at the output root as its last successful step, so its
 * presence is the signal used here rather than "the directory has some
 * file in it," which an empty `.gitkeep`-style placeholder would also
 * satisfy.
 */
function outputHasBuild(outputPath) {
  return pathExists(outputPath) && pathExists(path.join(outputPath, 'index.html'));
}

/**
 * Builds the shared context every check runs against, so the vault is only
 * walked once per `check` invocation regardless of how many checks are
 * enabled. Everything here is read-only and vault content only comes from
 * src/vault/read.js underneath index.js and publishset.js.
 *
 * @param {object} opts
 * @param {string} opts.campaign
 * @param {string} opts.vaultPath absolute path
 * @param {object} opts.jsonConfig parsed vault.config.json (site config, outside the vault)
 * @param {string|null} [opts.outputPath] absolute path to the configured output dir, or null
 * @param {boolean} [opts.graph]
 * @param {object|null} [opts.vaultMismatch] FR-18: null, or the site config's
 *   own vaultPath diverging from the vault actually resolved (src/cli/check.js's
 *   resolveVaultContext), for config/site-vault-path-mismatch to report.
 * @param {object|null} [opts.packShadowed] ADR 0018: null, or
 *   {siteConfigPath, packDir, packSource} when a legacy site_config won over
 *   a campaign pack that would otherwise have been used (src/cli/check.js's
 *   resolveVaultContext), for config/pack-shadowed to report.
 * @param {object|null} [opts.packToml] ADR 0023: the parsed pack.toml (src/build/packtoml.js's
 *   loadPackToml return value, from src/cli/check.js's resolveVaultContext), or null when no
 *   check-driving command threaded one through. Only src/checks/themescheme.js reads it.
 * @param {boolean} [opts.deferOutputScan] Track D2, FR-16: true only for the
 *   pre-build `check` `scriptorium build` runs internally (src/cli/build.js
 *   is the only caller that ever passes true — no CLI flag, config key, or
 *   env var reaches this). When true, leak/l4-output-name and
 *   leak/l4-index-term each emit exactly one INFO saying the scan is
 *   deferred to this build's own staging tree, instead of judging the OLD
 *   finalOut that build is about to replace. Nothing is suppressed: the
 *   real scan still runs and still gates, against the staging tree, via
 *   src/build/outputgate.js, between the generator run and the swap.
 */
function buildCheckContext({
  campaign,
  vaultPath,
  jsonConfig,
  outputPath = null,
  graph = false,
  vaultMismatch = null,
  packShadowed = null,
  packToml = null,
  deferOutputScan = false,
}) {
  const index = buildResolutionIndex(vaultPath, jsonConfig);
  const publishSet = computePublishedSet(vaultPath, jsonConfig);
  // Defense-in-depth against a stale build (see scanAllCandidatePages' own doc comment): not
  // used by anything that predicts what a fresh build produces, only by leak/l2 and
  // config/exclude-dirs-divergence, which must still be able to name a directory-excluded page
  // that a build made before the exclusion existed could still have left in real output.
  const allCandidatePages = scanAllCandidatePages(vaultPath, jsonConfig);
  const resolvedOutputPath = outputPath ? path.resolve(outputPath) : null;
  return {
    campaign,
    vaultPath,
    jsonConfig,
    // outputPathExists: the directory is there at all, regardless of build state.
    // outputPath: only set when a real build actually exists in it. L2 (and
    // anything else that needs "is there a built site to inspect") must use
    // outputPath, not outputPathExists, so an empty pre-created out/ reads
    // the same as no output dir at all.
    outputPathConfigured: resolvedOutputPath,
    outputPath: resolvedOutputPath && outputHasBuild(resolvedOutputPath) ? resolvedOutputPath : null,
    graph,
    vaultMismatch,
    packShadowed,
    packToml,
    deferOutputScan: Boolean(deferOutputScan),
    index,
    // ADR 0037: _meta/relationship-types.md's word list, read once here rather than by each
    // runner, so relationship/unknown-predicate and graph/generic-relationship-type share one read.
    relationshipTypes: readRelationshipTypes(vaultPath),
    publishSet,
    allCandidatePages,
  };
}

module.exports = { buildCheckContext, outputHasBuild };
