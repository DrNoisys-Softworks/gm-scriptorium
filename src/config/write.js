'use strict';

const path = require('path');
const TOML = require('smol-toml');
const { ConfigError, VaultUnreachableError } = require('../util/errors');
const { CAMPAIGN_STRING_FIELDS, CAMPAIGN_INTEGER_FIELDS } = require('./schema');

/*
 * The canonical config emitter (Engineering Brief section 4): "Write with
 * a canonical emitter we own, not a round-tripping library." config
 * add/remove/set-default rewrite the whole file in fixed key order with
 * header comments regenerated; user comments elsewhere in the file are NOT
 * preserved. Unknown keys (top-level or per-campaign) ARE preserved,
 * because load.js already treats them as "warn and keep", not "drop".
 */

const HEADER = [
  '# Scriptorium config.',
  '#',
  '# Hand-editable TOML. Rewritten by "config add" / "config remove" /',
  '# "config set-default" using a canonical emitter: fixed key order, this',
  '# header regenerated each time. Comments you add elsewhere in this file',
  '# will NOT survive the next rewrite; unrecognised keys will.',
  '#',
  '# [campaigns.<name>.paths.<profile>] tables are per-machine overrides.',
  '# See docs/decisions for the resolution rules (platform/hostname match,',
  '# specificity, --vault/--out overrides, SCRIPTORIUM_PROFILE).',
  '',
  '',
].join('\n');

const CAMPAIGN_KEY_ORDER = [...CAMPAIGN_STRING_FIELDS, ...CAMPAIGN_INTEGER_FIELDS];

function orderCampaign(campaign) {
  if (typeof campaign !== 'object' || campaign === null || Array.isArray(campaign)) return campaign; // malformed entry, kept as found
  const ordered = {};
  for (const key of CAMPAIGN_KEY_ORDER) {
    if (campaign[key] !== undefined) ordered[key] = campaign[key];
  }
  for (const key of Object.keys(campaign)) {
    if (key === 'paths' || CAMPAIGN_KEY_ORDER.includes(key)) continue;
    ordered[key] = campaign[key]; // preserved unknown key
  }
  if (campaign.paths) {
    ordered.paths = {};
    for (const [profileName, table] of Object.entries(campaign.paths)) {
      ordered.paths[profileName] = table;
    }
  }
  return ordered;
}

function serializeConfig(config) {
  const ordered = { config_version: config.config_version };
  if (config.default_campaign !== undefined) ordered.default_campaign = config.default_campaign;
  ordered.campaigns = {};
  for (const [name, campaign] of Object.entries(config.campaigns || {})) {
    ordered.campaigns[name] = orderCampaign(campaign);
  }
  for (const key of Object.keys(config)) {
    if (['config_version', 'default_campaign', 'campaigns'].includes(key)) continue;
    ordered[key] = config[key]; // preserved unknown top-level key
  }
  return HEADER + TOML.stringify(ordered) + '\n';
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

/**
 * ADR 0021, Structural decision 7: "undefined means keep". `vault`,
 * `output` and `siteConfig` are assigned onto the existing campaign block
 * only when the caller actually passed a value; an omitted (`undefined`)
 * one leaves whatever was already registered untouched, instead of
 * clobbering it. This fixes both `init` (a re-run must not silently drop
 * `site_config`/`output` it never touched) and `config add` on an already-
 * registered name, which called this same function and previously lost
 * those keys on every re-add.
 */
function addCampaign(config, name, { vault, output, siteConfig }) {
  if (!name) throw new ConfigError('campaign name is required');
  const next = cloneConfig(config);
  next.campaigns = next.campaigns || {};
  const campaign = { ...(next.campaigns[name] || {}) };
  for (const [key, value] of Object.entries({ vault, output, site_config: siteConfig })) {
    if (value !== undefined) campaign[key] = value;
  }
  next.campaigns[name] = campaign;
  if (!next.default_campaign) next.default_campaign = name;
  return next;
}

/** Deregisters only. Never deletes anything on disk (Requirements section 3.5). */
function removeCampaign(config, name) {
  const next = cloneConfig(config);
  if (!next.campaigns || !(name in next.campaigns)) {
    throw new VaultUnreachableError(`no campaign named "${name}" to remove`, { path: null, campaign: name, reason: 'unknown-campaign' });
  }
  delete next.campaigns[name];
  if (next.default_campaign === name) delete next.default_campaign;
  return next;
}

function setDefaultCampaign(config, name) {
  const next = cloneConfig(config);
  if (!next.campaigns || !(name in next.campaigns)) {
    throw new VaultUnreachableError(`no campaign named "${name}"`, { path: null, campaign: name, reason: 'unknown-campaign' });
  }
  next.default_campaign = name;
  return next;
}

/**
 * Refuse to load or write a config path that resolves inside a registered
 * vault (Engineering Brief section 4.3: "Must not live inside a vault").
 * Best-effort string comparison, normalising slash direction: a true
 * cross-platform path containment check is not possible when the config
 * may name a Windows path while running on Linux, or vice versa.
 */
function assertConfigPathNotInVault(configPath, config) {
  const normalisedConfig = path.resolve(configPath).replace(/\\/g, '/').toLowerCase();
  for (const [name, campaign] of Object.entries(config.campaigns || {})) {
    const vault = campaign.vault;
    if (!vault) continue;
    const normalisedVault = String(vault).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (normalisedConfig === normalisedVault || normalisedConfig.startsWith(normalisedVault + '/')) {
      throw new ConfigError(
        `refusing to write config to ${configPath}: it resolves inside campaign "${name}"'s vault`,
      );
    }
  }
}

module.exports = {
  serializeConfig,
  addCampaign,
  removeCampaign,
  setDefaultCampaign,
  assertConfigPathNotInVault,
};
