'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// The same three codes src/vault/packreplace.js and src/remote/privatefile.js treat as worth a
// bounded wait: on Windows a rename over a file that something holds open fails with one of them.
// Copied, not imported, so this module gains no dependency on the build or remote code.
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = Object.freeze([100, 200, 400, 800, 1600]);

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function removeTempBestEffort(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // swallowed deliberately: the caller's own error already explains what went wrong.
  }
}

/**
 * Writes the config file: refuses a path inside a registered vault, creates the folder, and writes
 * the canonical emitter's output. Moved here from src/cli/config.js (ADR 0028 section 2), which
 * re-exports this same function, so the admin panel's one config write can reach it without ever
 * reaching the module that starts the editor.
 *
 * ADR 0050, section 6: the bytes go to a temp file in the target's own folder, are flushed, and are
 * renamed over the target, so a crash or a full disk leaves the old file whole. A symlinked config
 * stays a link (the target is the link's real path) and an existing file's mode is kept. The rename
 * is retried a bounded number of times on a sharing violation. Every fs call goes through the module
 * object so a test can patch exactly one of them.
 */
function writeConfigFile(configPath, config) {
  assertConfigPathNotInVault(configPath, config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  let target = configPath;
  let mode = 0o666;
  try {
    target = fs.realpathSync(configPath);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // no file yet: write beside the path as given, with the default mode
  }

  const bytes = Buffer.from(serializeConfig(config), 'utf8');
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.scriptorium-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeSync(fd, bytes, 0, bytes.length, null);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the original error below is what gets reported.
      }
    }
    removeTempBestEffort(tmp);
    throw err;
  }

  const maxAttempts = RENAME_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      const last = attempt === maxAttempts - 1;
      if (!last && RETRYABLE_CODES.has(err.code)) {
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      removeTempBestEffort(tmp);
      throw err;
    }
  }
}

module.exports = {
  serializeConfig,
  addCampaign,
  removeCampaign,
  setDefaultCampaign,
  assertConfigPathNotInVault,
  writeConfigFile,
};
