'use strict';

const packreplace = require('./packreplace');

/*
 * The one step of the carry that overwrites an existing pack file. It lives apart from
 * src/vault/settingscarry.js so that `init`, which loads settingscarry and must never be able to overwrite
 * a pack (test/pack-replace.test.js, the graph walk), does not reach packreplace. Only the carry command
 * (src/cli/carry.js) loads this module and passes it to applyCarry as `packWriter`.
 */

/**
 * Replaces the pack's vault.config.json with `text`, refusing if it changed since it was read.
 * Called through the module object so a test can patch packreplace.replacePackFile.
 *
 * @param {string} vaultPath
 * @param {string} text
 * @param {{ expectedSha256: string, campaign: string|null, sleep?: (ms: number) => void }} opts
 */
function writeCarriedPack(vaultPath, text, opts) {
  return packreplace.replacePackFile(vaultPath, 'vault.config.json', text, opts);
}

module.exports = { writeCarriedPack };
