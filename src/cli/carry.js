'use strict';

const path = require('path');
const { resolveCampaignContext } = require('./args');
const { resolveVaultSite } = require('./check');
const { createPrompter } = require('./prompt');
const { planCarry, applyCarry, discardCarry } = require('../vault/settingscarry');
const { writeCarriedPack } = require('../vault/carrypack');
const { resolveMachineDir } = require('../config/machinedir');
const { EXIT_CODES } = require('../util/exitcodes');
const { ScriptoriumError, VaultUnreachableError } = require('../util/errors');

/*
 * `gm-scriptorium carry [campaign] [--yes]`: moves the settings a campaign pack still holds into the
 * vault's own settings file (_meta/vault-config.yaml), for a vault whose settings gm-apprentice has
 * moved there. `check` reports those settings and names this command. Everything it does is in
 * src/vault/settingscarry.js; this file resolves the campaign, shows the plan and asks.
 *
 * Exit codes (the frozen table): 0 carried, or nothing to carry, or the GM said no; 3 the carry is
 * blocked or a file changed since it was planned (a VaultUnreachableError, reason 'carry-blocked');
 * 1 closed input, a backup that failed, or a pack that could not be rewritten.
 */

const QUESTION = "Carry these settings into the vault's settings file? [y/N]: ";

/**
 * @param {object} flags parsed CLI flags (`yes` skips the question)
 * @param {string[]} positional the words after the command; the first, if any, names the campaign
 * @param {{ input?: NodeJS.ReadableStream, output?: { write(s: string): unknown }, now?: () => number }} [io]
 * @returns {Promise<{ exitCode: 0 }>}
 * @throws {VaultUnreachableError} blocked, or a file changed since the plan (reason 'carry-blocked')
 * @throws {ScriptoriumError} closed input, a failed backup, or a pack that could not be rewritten
 */
async function runCarryCommand(flags, positional = [], { input = process.stdin, output = process.stdout, now } = {}) {
  const say = (line) => output.write(`${line}\n`);

  const ctxInfo = resolveCampaignContext(flags, positional[0]);
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  const packConfigPath = path.resolve(site.siteConfigPath);

  const planned = planCarry({ vaultPath, packConfigPath });
  if (planned.state === 'blocked') {
    throw new VaultUnreachableError(planned.blockers.join('\n'), { path: vaultPath, campaign: ctxInfo.campaign, reason: 'carry-blocked' });
  }
  if (planned.state === 'nothing') {
    say(`There is nothing to carry: ${packConfigPath} holds nothing the carry can move.`);
    for (const line of planned.lines) say(line);
    return { exitCode: EXIT_CODES.OK };
  }

  try {
    // Fail before asking when the backups have nowhere to go.
    const machine = resolveMachineDir({ configPath: ctxInfo.configPath, vaultPath });
    if (!machine.ok) throw new ScriptoriumError(`${machine.reason} Nothing was written.`, { campaign: ctxInfo.campaign });

    for (const line of planned.lines) say(line);

    if (flags.yes !== true) {
      const prompter = createPrompter({ input, output });
      let answer;
      try {
        answer = await prompter.ask(QUESTION);
      } finally {
        prompter.close();
      }
      if (answer === null) throw new ScriptoriumError('carry aborted; nothing written', { campaign: ctxInfo.campaign });
      if (!/^y(es)?$/i.test(answer.trim())) {
        say('Nothing was written.');
        return { exitCode: EXIT_CODES.OK };
      }
    }

    const done = applyCarry(planned, { machineDir: machine.dir, campaign: ctxInfo.campaign, now, packWriter: writeCarriedPack });
    // A line the plan already printed word for word, such as the pin's "already on the new settings
    // file", is not printed a second time.
    const printed = new Set(planned.lines);
    for (const line of done.lines) if (!printed.has(line)) say(line);
    say('Backups of the files as they were:');
    say(`  ${done.backups.yaml}`);
    if (done.backups.pack) say(`  ${done.backups.pack}`);
    if (done.backups.md) say(`  ${done.backups.md} (the leftover _meta/vault-config.md, which the carry removed)`);
    return { exitCode: EXIT_CODES.OK };
  } finally {
    // Removes the scratch folder when the plan was not applied; applyCarry has already done so otherwise.
    discardCarry(planned);
  }
}

module.exports = { runCarryCommand };
