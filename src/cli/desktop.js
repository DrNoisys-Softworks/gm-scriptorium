'use strict';

const config = require('./config');
const { loadConfig } = require('./args');
const { ConfigError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');
const { validatePort } = require('../setup/validate');
const { parseDesktopTable } = require('../config/desktopsettings');
const { setDesktopPorts } = require('../config/write');

/*
 * `gm-scriptorium desktop set [--port N] [--preview-port N]` (docs/decisions/0057-windows-desktop-app.md,
 * section 8). The command line writer for the `[desktop]` ports; Setup and the tray's ports dialog
 * both run it, so NSIS never writes TOML. A flag left out keeps the current value (or the default).
 * The write goes through the one config writer, and only the `[desktop]` table changes. S2 adds
 * `desktop run` to this module; `--background` is accepted by the flag table for it and refused here.
 */

const USAGE = 'usage: gm-scriptorium desktop set [--port N] [--preview-port N]';
const SET_FLAGS = ['port', 'preview-port'];
const ALLOWED_FLAGS = { set: ['config', ...SET_FLAGS] };

/**
 * @param {object} flags parsed argv flags
 * @param {string|undefined} subcommand
 * @param {string[]} args positional arguments after the subcommand
 * @returns {{ exitCode: number, human: string }}
 * @throws {ConfigError} bad usage or a bad value (exit 1); VaultUnreachableError from loadConfig for a malformed config (exit 3)
 */
function runDesktopCommand(flags, subcommand, args = []) {
  if (subcommand !== 'set' || args.length > 0) throw new ConfigError(USAGE);
  for (const key of Object.keys(flags)) {
    if (!ALLOWED_FLAGS.set.includes(key)) throw new ConfigError(`desktop set does not accept --${key}`);
  }
  if (!SET_FLAGS.some((f) => flags[f] !== undefined)) {
    throw new ConfigError(`desktop set: nothing to change; pass at least one of ${SET_FLAGS.map((f) => `--${f}`).join(', ')}`);
  }
  const asked = {};
  if (flags.port !== undefined) asked.port = validatePort(flags.port, '--port');
  if (flags['preview-port'] !== undefined) asked.previewPort = validatePort(flags['preview-port'], '--preview-port');

  const { configPath, config: current } = loadConfig(flags);
  const existing = parseDesktopTable(current.desktop);
  const next = setDesktopPorts(current, {
    port: asked.port === undefined ? existing.port : asked.port,
    previewPort: asked.previewPort === undefined ? existing.previewPort : asked.previewPort,
  });
  config.writeConfigFile(configPath, next);
  const saved = parseDesktopTable(next.desktop);
  return {
    exitCode: EXIT_CODES.OK,
    human: `desktop app ports: panel ${saved.port}, preview ${saved.previewPort}\nchanges take effect the next time the desktop app starts its panel`,
  };
}

module.exports = { runDesktopCommand, USAGE, ALLOWED_FLAGS };
