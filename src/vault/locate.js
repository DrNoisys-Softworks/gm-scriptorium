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
 * A vault whose settings moved to _meta/vault-config.yaml (moved), or that holds both settings
 * files (mixed), is refused with reason "settings-moved" (issue #171): this version reads only
 * _meta/vault-config.md, and never reads the settings of such a vault. The message text is written
 * out whole, because docs/how-to/troubleshooting.md quotes a fragment of it and a test checks that
 * the fragment is a literal substring of the source.
 */

const ISSUE_171 = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/issues/171';

function settingsMovedMessage(campaign, vaultPath, leftover) {
  return (
    `campaign "${campaign}": ${vaultPath} keeps its settings in _meta/vault-config.yaml, the file the gm-apprentice plugin's update moves a vault's settings to.` +
    (leftover ? ' Its _meta/vault-config.md is a leftover that gm-apprentice ignores.' : '') +
    " This version of GM-Scriptorium reads only _meta/vault-config.md, so it won't check, build or serve this campaign." +
    ' Nothing in the vault was read or changed.' +
    " Don't create, copy or edit a vault-config.md to get round this." +
    ` Support comes in a later GM-Scriptorium release; to follow it, see ${ISSUE_171}`
  );
}

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
  if (state === 'moved' || state === 'mixed') {
    throw new VaultUnreachableError(settingsMovedMessage(campaign, vaultPath, state === 'mixed'), {
      path: vaultPath,
      campaign,
      reason: 'settings-moved',
    });
  }
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
