'use strict';

const fs = require('fs');
const TOML = require('smol-toml');
const { ConfigError } = require('../util/errors');
const {
  CONFIG_VERSION,
  MATCH_KEYS,
  CAMPAIGN_STRING_FIELDS,
  CAMPAIGN_INTEGER_FIELDS,
  TOP_LEVEL_KEYS,
} = require('./schema');

/*
 * Parse and structurally validate a config TOML document against the
 * schema frozen in schema.js. This is the shape contract only: it does not
 * resolve a per-machine profile, does not apply --vault/--out overrides,
 * and does not migrate an older config forward. Those are phase 2
 * (src/config/resolve.js) and phase 3 (src/config/migrate.js) work.
 *
 * Config migration runs on every command, not only `update` (Engineering
 * Brief section 6): a newer config_version than this binary understands is
 * always a hard error here, never a silent partial read, regardless of
 * which command triggered the load.
 *
 * Unknown top-level or campaign keys are not an error: they are collected
 * as warnings and the raw parsed value is returned unmodified, so a
 * caller (a future writer) can preserve them on rewrite rather than
 * silently drop a key it does not understand (section 9: "Unknown
 * top-level or campaign keys: WARN and preserve on rewrite").
 *
 * An unrecognised key inside a `match` table is different: it is always a
 * hard ConfigError, never a warning (section 5), because silently ignoring
 * it would let an older Scriptorium match a profile it should not.
 */

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateFieldTypes(table, { stringFields, integerFields, where }) {
  for (const key of stringFields) {
    if (key in table && typeof table[key] !== 'string') {
      throw new ConfigError(`${where}: "${key}" must be a string`);
    }
  }
  for (const key of integerFields) {
    if (key in table && !Number.isInteger(table[key])) {
      throw new ConfigError(`${where}: "${key}" must be an integer`);
    }
  }
}

function validateMatchTable(match, { campaignName, profileName }) {
  if (!isPlainObject(match)) {
    throw new ConfigError(
      `campaigns.${campaignName}.paths.${profileName}: "match" must be a table`,
    );
  }
  const unknown = Object.keys(match).filter((k) => !MATCH_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `campaigns.${campaignName}.paths.${profileName}: unrecognised match key(s): ${unknown.join(', ')}. ` +
        `v1 supports exactly: ${MATCH_KEYS.join(', ')}`,
    );
  }
}

function validateCampaign(name, table, warnings) {
  if (!isPlainObject(table)) {
    throw new ConfigError(`campaigns.${name} must be a table`);
  }

  const knownKeys = new Set([...CAMPAIGN_STRING_FIELDS, ...CAMPAIGN_INTEGER_FIELDS, 'paths']);
  for (const key of Object.keys(table)) {
    if (!knownKeys.has(key)) {
      warnings.push(`campaigns.${name}: unrecognised key "${key}" (preserved, not applied)`);
    }
  }

  validateFieldTypes(table, {
    stringFields: CAMPAIGN_STRING_FIELDS,
    integerFields: CAMPAIGN_INTEGER_FIELDS,
    where: `campaigns.${name}`,
  });

  if ('paths' in table) {
    if (!isPlainObject(table.paths)) {
      throw new ConfigError(`campaigns.${name}.paths must be a table`);
    }
    for (const [profileName, profileTable] of Object.entries(table.paths)) {
      if (!isPlainObject(profileTable)) {
        throw new ConfigError(`campaigns.${name}.paths.${profileName} must be a table`);
      }
      if (!('match' in profileTable)) {
        throw new ConfigError(
          `campaigns.${name}.paths.${profileName} is missing required "match" table`,
        );
      }
      validateMatchTable(profileTable.match, { campaignName: name, profileName });

      const profileKnownKeys = new Set([
        ...CAMPAIGN_STRING_FIELDS,
        ...CAMPAIGN_INTEGER_FIELDS,
        'match',
      ]);
      for (const key of Object.keys(profileTable)) {
        if (!profileKnownKeys.has(key)) {
          warnings.push(
            `campaigns.${name}.paths.${profileName}: unrecognised key "${key}" (preserved, not applied)`,
          );
        }
      }
      validateFieldTypes(profileTable, {
        stringFields: CAMPAIGN_STRING_FIELDS,
        integerFields: CAMPAIGN_INTEGER_FIELDS,
        where: `campaigns.${name}.paths.${profileName}`,
      });
    }
  }
}

/**
 * @param {string} text raw TOML document contents
 * @returns {{ config: object, warnings: string[], needsMigration: boolean }}
 */
function parseConfig(text, { lenientCampaigns = false } = {}) {
  let raw;
  try {
    raw = TOML.parse(text);
  } catch (err) {
    throw new ConfigError(`config is not valid TOML: ${err.message}`, { cause: err });
  }

  if (!isPlainObject(raw)) {
    throw new ConfigError('config must be a table at the top level');
  }

  if (!Number.isInteger(raw.config_version)) {
    throw new ConfigError('config is missing mandatory integer "config_version"');
  }
  if (raw.config_version > CONFIG_VERSION) {
    throw new ConfigError(
      `config_version ${raw.config_version} is newer than this build understands ` +
        `(${CONFIG_VERSION}). Update Scriptorium before using this config.`,
    );
  }

  if ('default_campaign' in raw && typeof raw.default_campaign !== 'string') {
    throw new ConfigError('"default_campaign" must be a string');
  }

  if ('campaigns' in raw && !isPlainObject(raw.campaigns)) {
    throw new ConfigError('"campaigns" must be a table');
  }

  const warnings = [];

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      warnings.push(`unrecognised top-level key "${key}" (preserved, not applied)`);
    }
  }

  const campaigns = raw.campaigns || {};
  for (const [name, table] of Object.entries(campaigns)) {
    if (lenientCampaigns) continue; // `config remove` must be able to load a config with a bad entry
    try {
      validateCampaign(name, table, warnings);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new ConfigError(
        `${err.message}. The campaign "${name}" in your config is malformed. To fix it, run ` +
          `"gm-scriptorium config remove ${name}" and add it again with "gm-scriptorium config add", or edit the config file.`,
        { cause: err },
      );
    }
  }

  return {
    config: raw,
    warnings,
    needsMigration: raw.config_version < CONFIG_VERSION,
  };
}

function loadConfigFile(filePath, opts) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseConfig(text, opts);
}

module.exports = { parseConfig, loadConfigFile };
