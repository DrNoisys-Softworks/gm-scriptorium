'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./args');
const { listCampaigns, resolveCampaign } = require('../config/resolve');
const { serializeConfig, addCampaign, removeCampaign, setDefaultCampaign, assertConfigPathNotInVault } = require('../config/write');
const { locateVault } = require('../vault/locate');
const { VaultUnreachableError, ConfigError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');

/*
 * `config` never requires reachable storage (Requirements section 3.5).
 * Every subcommand here only touches the config file itself, never a
 * vault, and never stats a vault path except `add`'s best-effort
 * reachability check (which warns, never blocks, on failure).
 */

function writeConfigFile(configPath, config) {
  assertConfigPathNotInVault(configPath, config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, serializeConfig(config));
}

function runConfigCommand(flags, subcommand, args) {
  // `remove` loads leniently so a malformed entry (which makes every other command refuse to
  // load the config) can still be removed, instead of forcing a hand edit of the TOML.
  const { configPath, config } = loadConfig(flags, { lenient: subcommand === 'remove' });

  switch (subcommand) {
    case 'list': {
      const names = listCampaigns(config);
      if (names.length === 0) {
        return { exitCode: EXIT_CODES.OK, human: `no campaigns registered (config: ${configPath})` };
      }
      const lines = names.map((name) => {
        const resolved = resolveCampaign(config, name);
        const isDefault = config.default_campaign === name ? ' [default]' : '';
        let reachability = 'unknown';
        try {
          locateVault(path.resolve(resolved.vault), name);
          reachability = 'reachable';
        } catch (err) {
          reachability = err instanceof VaultUnreachableError ? `unreachable (${err.reason})` : `error: ${err.message}`;
        }
        return `${name}${isDefault}: vault=${resolved.vault} out=${resolved.output} [${reachability}]`;
      });
      return { exitCode: EXIT_CODES.OK, human: lines.join('\n') };
    }

    case 'add': {
      const name = args[0];
      if (!name) throw new ConfigError('usage: gm-scriptorium config add <name> --vault <path> [--out <path>] [--site-config <path>]');
      // A flag given with no value parses as `true`; writing that would corrupt the config.
      for (const flag of ['vault', 'out', 'site-config']) {
        if (flags[flag] === true) throw new ConfigError(`--${flag} needs a value: config add ${name} --${flag} <path>`);
      }
      if (!flags.vault) throw new ConfigError('config add requires --vault <path>');
      const existingOutput = config.campaigns && config.campaigns[name] && config.campaigns[name].output;
      if (!flags.out && typeof existingOutput !== 'string') {
        throw new ConfigError(
          `config add needs --out <folder>: the campaign "${name}" has no output folder yet, so "build" would have ` +
            `nowhere to put the site. Try: gm-scriptorium config add ${name} --vault <vault folder> --out <output folder>`,
        );
      }
      const replacing = Boolean(config.campaigns && config.campaigns[name]);
      const next = addCampaign(config, name, {
        vault: flags.vault,
        output: flags.out,
        siteConfig: flags['site-config'],
      });
      writeConfigFile(configPath, next);

      let warning = '';
      try {
        locateVault(path.resolve(flags.vault), name);
      } catch (err) {
        warning = `\nwarning: ${err.message} (registered anyway)`;
      }
      return { exitCode: EXIT_CODES.OK, human: `${replacing ? `replaced the existing campaign "${name}"` : `registered campaign "${name}"`} at ${configPath}${warning}` };
    }

    case 'remove': {
      const name = args[0];
      if (!name) throw new ConfigError('usage: gm-scriptorium config remove <name>');
      const next = removeCampaign(config, name);
      writeConfigFile(configPath, next);
      return {
        exitCode: EXIT_CODES.OK,
        human: `deregistered campaign "${name}" from ${configPath}. Nothing on disk was touched or deleted.`,
      };
    }

    case 'set-default': {
      const name = args[0];
      if (!name) throw new ConfigError('usage: gm-scriptorium config set-default <name>');
      const next = setDefaultCampaign(config, name);
      writeConfigFile(configPath, next);
      return { exitCode: EXIT_CODES.OK, human: `default campaign is now "${name}"` };
    }

    case 'path':
      return { exitCode: EXIT_CODES.OK, human: configPath };

    case 'edit': {
      const editor = process.env.EDITOR || process.env.VISUAL;
      if (!editor) {
        return { exitCode: EXIT_CODES.OK, human: `no $EDITOR set; config is at ${configPath}` };
      }
      if (!fs.existsSync(configPath)) writeConfigFile(configPath, config);
      const result = spawnSync(editor, [configPath], { stdio: 'inherit' });
      return { exitCode: result.status || EXIT_CODES.OK, human: '' };
    }

    default:
      throw new ConfigError(`unknown config subcommand: ${subcommand}`);
  }
}

module.exports = { runConfigCommand, writeConfigFile };
