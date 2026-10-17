'use strict';

const path = require('path');

/*
 * Which settings file a vault has. The gm-apprentice plugin's update can move a vault's settings
 * from _meta/vault-config.md to _meta/vault-config.yaml (issue #171). Four states, by which of the
 * two files exist:
 *   old   only vault-config.md
 *   moved only vault-config.yaml
 *   mixed both
 *   none  neither
 *
 * A leaf on purpose: it requires only `path`, so no module graph gains an edge by using it. It does
 * no filesystem calls. Each caller passes in the existence check it already uses (read.pathExists
 * in locate.js, fs.existsSync in remote/paths.js), so a site keeps its own behaviour; the setup
 * picker is async and uses only settingsPaths().
 *
 * Notes:
 *   - Unrelated to upstream's vault-state.json.
 *   - src/vault/vaultcreate.js writes the same two names inline, because its require list is pinned
 *     by test/vault-create-structure.test.js.
 *   - Known residual: with an existsSync-style check, a .yaml that is a dangling link counts as
 *     absent. Upstream's own vault test (tools/publish/lib/settings/layout.js) is existsSync too, so
 *     a folder whose only .yaml is a dangling link is not a vault to gm-apprentice either.
 *     vaultconfigwrite.checkTarget uses lstat and counts it; that site only refuses.
 */

const SETTINGS_MD = 'vault-config.md';
const SETTINGS_YAML = 'vault-config.yaml';

/** @param {string} dir a vault folder */
function settingsPaths(dir) {
  return {
    md: path.join(dir, '_meta', SETTINGS_MD),
    yaml: path.join(dir, '_meta', SETTINGS_YAML),
  };
}

/**
 * @param {boolean} hasMd
 * @param {boolean} hasYaml
 * @returns {'old'|'moved'|'mixed'|'none'}
 */
function stateOf(hasMd, hasYaml) {
  if (hasYaml) return hasMd ? 'mixed' : 'moved';
  return hasMd ? 'old' : 'none';
}

/**
 * @param {string} dir a vault folder
 * @param {(p: string) => boolean} exists the caller's own existence check
 * @returns {'old'|'moved'|'mixed'|'none'}
 */
function vaultState(dir, exists) {
  const { md, yaml } = settingsPaths(dir);
  return stateOf(Boolean(exists(md)), Boolean(exists(yaml)));
}

module.exports = { SETTINGS_MD, SETTINGS_YAML, settingsPaths, stateOf, vaultState };
