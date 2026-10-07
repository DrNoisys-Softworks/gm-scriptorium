'use strict';

const fs = require('fs');
const path = require('path');

/*
 * FR-DEP-10: the pinned generator reads some inputs relative to its config
 * file's directory (configDir), not just vaultPath/outputDir:
 *   - css/overrides.css (pub/lib/build.js:188-197)
 *   - backend detection: wrangler.toml, functions/api/request.js,
 *     functions/api/loadout.js (pub/lib/build.js:90, :1339-1340, pub/lib/backend-flags.js:12-29)
 * Scriptorium's staged config lives in a staging root that is NOT the
 * user's site dir (src/build/stage.js's writeStagedConfig, unchanged), so
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
 * @param {object} userJsonConfig already-loaded vault.config.json content
 * @param {string} vaultPath absolute
 * @param {string} stagingRoot
 * @param {string} stagingOut absolute
 * @returns {string} the synthesised config's absolute path
 */
function writeStagedConfig(userJsonConfig, vaultPath, stagingRoot, stagingOut) {
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staged = { ...userJsonConfig, vaultPath, outputDir: stagingOut };
  const configPath = path.join(stagingRoot, 'vault.config.json');
  fs.writeFileSync(configPath, JSON.stringify(staged, null, 2));
  return configPath;
}

module.exports = { writeStagedConfig, SITE_RELATIVE_INPUTS, mirrorSiteInputs };
