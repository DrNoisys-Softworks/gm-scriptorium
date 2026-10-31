'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const pinned = require('../generator/pinned');

/*
 * FR-DEP-10: the pinned generator reads some inputs relative to its config
 * file's directory (configDir), not just vaultPath/outputDir:
 *   - css/overrides.css (pub/lib/build.js:397-408)
 *   - backend detection: wrangler.toml, functions/api/request.js,
 *     functions/api/loadout.js (pub/lib/build.js:279, :1339-1340, pub/lib/backend-flags.js:12-29)
 * Scriptorium's staged config lives in a staging root that is NOT the
 * user's site dir (src/build/stage.js's stageConfig), so
 * without mirroring these, the pin's copyOverridesCSS and its
 * hasRealKvId/detectInbox/detectStatusBar would silently see an empty configDir and drop them.
 * This list is a change-detector target: test/build-site-mirror.test.js
 * extracts the literal path.join(configDir|siteDir, <literal>) joins from
 * the pin's own lib/build.js and lib/backend-flags.js and asserts they
 * still equal this list, so a future pin adding another config-dir-relative
 * input fails loudly instead of silently.
 */
const SITE_RELATIVE_INPUTS = [
  'css/overrides.css',
  'wrangler.toml',
  'functions/api/request.js',
  'functions/api/loadout.js',
];

/**
 * Copies each of SITE_RELATIVE_INPUTS that exists in the user's site dir
 * into stagingRoot, byte for byte, at the same relative path. The pin's own
 * copyOverridesCSS and backend detection then run unmodified against an
 * exact view of what they would see run directly against the user's site
 * config (Structural decision 4: writing into the site dir itself was
 * rejected as a new write location on a possibly read-only share).
 *
 * @param {string} siteDir absolute, the user's site config's own directory
 * @param {string} stagingRoot absolute
 * @returns {string[]} the SITE_RELATIVE_INPUTS entries actually copied
 */
function mirrorSiteInputs(siteDir, stagingRoot) {
  const copied = [];
  for (const rel of SITE_RELATIVE_INPUTS) {
    const src = path.join(siteDir, ...rel.split('/'));
    if (!fs.existsSync(src)) continue;
    const dest = path.join(stagingRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(rel);
  }
  return copied;
}

/**
 * Writes <stagingRoot>/vault.config.json: every key from the user's own
 * site config verbatim, with vaultPath and outputDir rewritten to absolute
 * paths (outputDir = stagingOut). Absolute paths make the synthesised
 * config's own location irrelevant and preserve the generator's
 * relative-path contract for the USER's file (Engineering Brief section
 * 3, step 6). Does not rewrite the user's own vault.config.json.
 *
 * On a vault whose settings moved to _meta/vault-config.yaml (ADR 0071) the staged file carries no
 * outputDir at all, and the output folder comes back as `outputDirOverride` instead, for the
 * generator's own build option of that name (lib/build.js:226). On that layout the generator reads
 * outputDir as a site-file setting it is about to move, and warned on every build that it "moves to
 * player_site.output", about a key only this file ever held. The override changes nothing else on a
 * player-site build: it also turns off the vault's build steps, which Scriptorium never runs.
 *
 * @param {object} userJsonConfig already-loaded vault.config.json content
 * @param {string} vaultPath absolute
 * @param {string} stagingRoot
 * @param {string} stagingOut absolute
 * @returns {{ configPath: string, outputDirOverride: string|null }} the synthesised config's absolute
 *   path, and the output folder to hand the generator's build (null: it is in the file)
 */
function stageConfig(userJsonConfig, vaultPath, stagingRoot, stagingOut) {
  fs.mkdirSync(stagingRoot, { recursive: true });
  // A moved vault's pack is staged with every key the vault's settings now own taken out, so the
  // generator never sees one (the settings it reads come from the vault). runAtomicBuild's signature
  // is pinned (test/gm-link-gate.test.js), so it is handed the resolved pack, not the raw one; the
  // moved keys it holds are overwritten or removed by the resolve, so stripping them gives the same file.
  // The resolve also fills the site-folder keys from the pack when the yaml sets none.
  const moved = pinned.settingsLayoutOf(vaultPath) === 'new';
  // The site-folder keys stay (siteUrl, host, cloudflarePagesProject, preserveDirs): the generator still
  // reads them from the site file while the yaml sets none, as the pin's own leaveFallback leaves them.
  // outputDir alone goes, because the output folder is handed over as outputDirOverride below.
  const staged = moved
    ? { ...pinned.stripMovedSettings(userJsonConfig, { leaveFallback: true }).config, vaultPath }
    : { ...userJsonConfig, vaultPath, outputDir: stagingOut };
  if (moved) {
    delete staged.outputDir;
    // The resolve fills each site-folder key with its built-in value when neither file sets it (host,
    // preserveDirs). Staged, the generator would warn on every build that the key "moves to" the vault's
    // settings, about a key nobody wrote. Left out, the generator reads the same built-in value.
    for (const { key, default: builtIn } of pinned.siteFolderKeys()) {
      if (Object.prototype.hasOwnProperty.call(staged, key) && isDeepStrictEqual(staged[key], builtIn)) delete staged[key];
    }
  }
  const configPath = path.join(stagingRoot, 'vault.config.json');
  fs.writeFileSync(configPath, JSON.stringify(staged, null, 2));
  return { configPath, outputDirOverride: moved ? stagingOut : null };
}

module.exports = { stageConfig, SITE_RELATIVE_INPUTS, mirrorSiteInputs };
