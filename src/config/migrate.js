'use strict';

const { ConfigError } = require('../util/errors');
const { CONFIG_VERSION } = require('./schema');

/*
 * Config migration runs on every command, not only `update` (Engineering
 * Brief section 6.3). load.js already hard-errors on a config_version
 * newer than this build understands, so by the time a config reaches this
 * module its version is <= CONFIG_VERSION. There is no version older than
 * 1 yet, so MIGRATIONS is empty; this module exists so a future version 2
 * has one obvious place to add a step, with the backup-then-migrate
 * contract already decided.
 */

// Ordered list of { from, to, migrate(config) } steps. Empty until a
// version 2 exists.
const MIGRATIONS = [];

/**
 * @param {object} config parsed, already-validated config (config_version <= CONFIG_VERSION)
 * @returns {{ config: object, migrated: boolean, changes: string[] }}
 */
function migrateConfig(config) {
  if (config.config_version === CONFIG_VERSION) {
    return { config, migrated: false, changes: [] };
  }
  if (config.config_version > CONFIG_VERSION) {
    // load.js should have already refused this; defensive only.
    throw new ConfigError(
      `config_version ${config.config_version} is newer than this build understands (${CONFIG_VERSION})`,
    );
  }

  let current = config;
  const changes = [];
  for (const step of MIGRATIONS) {
    if (current.config_version !== step.from) continue;
    current = step.migrate(current);
    current.config_version = step.to;
    changes.push(`config_version ${step.from} -> ${step.to}`);
  }

  if (current.config_version !== CONFIG_VERSION) {
    throw new ConfigError(
      `no migration path from config_version ${config.config_version} to ${CONFIG_VERSION}`,
    );
  }

  return { config: current, migrated: changes.length > 0, changes };
}

module.exports = { migrateConfig, MIGRATIONS };
