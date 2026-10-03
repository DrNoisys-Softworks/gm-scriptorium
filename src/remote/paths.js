'use strict';

const fs = require('fs');
const path = require('path');
const { ConfigError } = require('../util/errors');
// Called through the module object (packwrite.isInsideOrEqual), not destructured, so a test can
// patch it, and so there is exactly one containment rule in the repo (it folds case per
// platformFoldsCase() and compares with a path separator, never a bare startsWith).
const packwrite = require('../vault/packwrite');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, section 4; SD-doc section 2). Where remote-access
 * files live: a `panel` folder beside the RESOLVED config path, so SCRIPTORIUM_CONFIG and --config
 * isolation also isolate the secrets and the audit log. This is the same folder
 * src/config/machinedir.js's resolveMachineDir() names for an absolute config path (backups and
 * panel-prefs.json sit there too): the two are pinned equal by test/remote-paths.test.js.
 *
 * Nothing here is ever built from a settings value. The panel writes only under remotePaths().
 */

/**
 * @param {string} configPath
 * @returns {Readonly<{ configDir: string, panelDir: string, passwordFile: string, sessionsFile: string, auditFile: string, tlsDir: string, generatedTlsFile: string }>}
 */
function remotePaths(configPath) {
  const configDir = path.dirname(path.resolve(configPath));
  const panelDir = path.join(configDir, 'panel');
  const tlsDir = path.join(configDir, 'tls');
  return Object.freeze({
    configDir,
    panelDir,
    passwordFile: path.join(panelDir, 'password.json'),
    sessionsFile: path.join(panelDir, 'sessions.json'),
    auditFile: path.join(panelDir, 'audit.log'),
    tlsDir,
    generatedTlsFile: path.join(tlsDir, 'generated.pem'),
  });
}

/**
 * realpath of the deepest EXISTING ancestor, with the not-yet-existing tail appended unchanged,
 * so a folder that does not exist yet (panel/ before its first write) is still judged by where it
 * will really land, symlinks resolved.
 */
function realpathLoose(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function vaultsOf(campaign) {
  const out = [];
  if (campaign && typeof campaign.vault === 'string' && campaign.vault.length > 0) out.push(campaign.vault);
  const profiles = campaign && campaign.paths && typeof campaign.paths === 'object' ? campaign.paths : {};
  for (const table of Object.values(profiles)) {
    if (table && typeof table.vault === 'string' && table.vault.length > 0) out.push(table.vault);
  }
  return out;
}

/**
 * Refuses a folder inside ANY registered campaign's vault (every campaign, and every profile's
 * vault for it). src/config/write.js only checks at write time, and the panel may not reach
 * write.js (FR35), so this is the panel's own check.
 *
 * @param {string} dir
 * @param {{ campaigns?: object }} config
 * @throws {ConfigError} naming the campaign
 */
function assertNotInsideAnyVault(dir, config) {
  const realDir = realpathLoose(dir);
  for (const [name, campaign] of Object.entries((config && config.campaigns) || {})) {
    for (const vault of vaultsOf(campaign)) {
      const realVault = realpathLoose(vault);
      if (packwrite.isInsideOrEqual(realVault, realDir)) {
        throw new ConfigError(
          `remote access keeps its files beside the config, never inside a vault, but ${dir} is inside the vault of campaign "${name}"`,
        );
      }
    }
  }
}

module.exports = { remotePaths, assertNotInsideAnyVault };
