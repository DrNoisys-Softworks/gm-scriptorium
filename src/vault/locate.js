'use strict';

const read = require('./read');
const { VaultUnreachableError } = require('../util/errors');
const { vaultState } = require('./vaultstate');

/*
 * Reachability and is-a-vault taxonomy (Requirements section 2.1). Every
 * command that touches a vault calls locateVault() first and lets a
 * VaultUnreachableError propagate to exit code 3, rather than each command
 * re-deriving its own "is this even a vault" logic.
 *
 * A read-only vault is a supported mode (Decisions Addendum, gap 1): this
 * module never checks writability, only existence and vault-ness.
 *
 * A vault whose settings are in _meta/vault-config.yaml (moved), or that holds both settings files
 * (mixed), is a vault like any other: locateVault returns for it. Which file is read is decided
 * where the settings are read, not here.
 */

function isMappedDriveLetter(p) {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * @param {string} vaultPath absolute path
 * @param {string} campaign campaign name, for the error message
 * @throws {VaultUnreachableError}
 */
function locateVault(vaultPath, campaign) {
  if (!read.pathExists(vaultPath)) {
    const driveHint = isMappedDriveLetter(vaultPath)
      ? ` (if this is a mapped drive, it may not be mapped in this session)`
      : '';
    throw new VaultUnreachableError(
      `campaign "${campaign}": configured vault path does not exist: ${vaultPath}${driveHint}`,
      { path: vaultPath, campaign, reason: 'not-found' },
    );
  }

  const state = vaultState(vaultPath, read.pathExists);
  if (state === 'none') {
    throw new VaultUnreachableError(
      `campaign "${campaign}": ${vaultPath} exists but has no _meta/vault-config.md; it is not a gm-apprentice vault. ` +
        'A vault needs a _meta/vault-config.md settings page. To see a complete one, look at examples/the-long-lease ' +
        'in the GM-Scriptorium download. To start a new campaign, run "gm-scriptorium init --new-vault <folder>", ' +
        'or choose "Start a new campaign here" in browser setup. To learn more, see the gm-apprentice project: ' +
        'https://github.com/AntTheLimey/gm-apprentice',
      { path: vaultPath, campaign, reason: 'not-a-vault' },
    );
  }

  return { vaultPath, campaign };
}

module.exports = { locateVault };
