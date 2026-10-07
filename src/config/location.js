'use strict';

const os = require('os');
const path = require('path');

/*
 * Where the config file lives (Requirements section 4.1): Windows
 * %APPDATA%\Scriptorium\config.toml, XDG-style
 * ${XDG_CONFIG_HOME:-~/.config}/scriptorium/config.toml elsewhere.
 * Overridden by --config <path>, then SCRIPTORIUM_CONFIG. Never inside a
 * vault (enforced by src/config/write.js's assertConfigPathNotInVault, at
 * the point of writing, not here).
 */

function defaultConfigPath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Scriptorium', 'config.toml');
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdgConfigHome, 'scriptorium', 'config.toml');
}

/**
 * @param {{ cliConfigPath?: string }} [opts] --config flag value, if given
 */
function resolveConfigPath(opts = {}) {
  if (opts.cliConfigPath) return path.resolve(opts.cliConfigPath);
  if (process.env.SCRIPTORIUM_CONFIG) return path.resolve(process.env.SCRIPTORIUM_CONFIG);
  return defaultConfigPath();
}

module.exports = { defaultConfigPath, resolveConfigPath };
