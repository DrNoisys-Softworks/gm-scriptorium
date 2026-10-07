'use strict';

const os = require('os');
const { VaultUnreachableError } = require('../util/errors');
const { MATCH_KEYS } = require('./schema');

/*
 * The per-machine path seam (Engineering Brief section 5): one campaign, N
 * machine profiles. This module resolves which paths a given campaign uses
 * on THIS machine, without touching the filesystem (criterion 21: config
 * resolution must not stat anything) and without any Linux-specific path
 * translation, mount detection, or POSIX normalisation (brief section 14:
 * "Do not build any Linux-side path behaviour"). LK-1/SC-1 is an edit to a
 * config file, not a code change, because this resolver already handles an
 * arbitrary number of platform/hostname profiles.
 *
 * Resolution order:
 *   1. campaign base block.
 *   2. the winning [campaigns.<name>.paths.<profile>] table, chosen by
 *      match specificity (platform+hostname > platform > hostname; two
 *      equally specific matches is a hard error naming both), overrides
 *      per key, absent keys fall through to the base.
 *   3. --vault / --out / --site-config CLI flags override everything, for
 *      diagnostics only, never persisted.
 *   4. SCRIPTORIUM_PROFILE forces a named profile and skips matching.
 */

const CAMPAIGN_FIELDS = ['vault', 'site_config', 'output', 'pack', 'serve_port'];

function specificityOf(match) {
  let n = 0;
  if ('platform' in match) n++;
  if ('hostname' in match) n++;
  return n;
}

function matches(match, { platform, hostname }) {
  if ('platform' in match && match.platform !== platform) return false;
  if ('hostname' in match && String(match.hostname).toLowerCase() !== String(hostname).toLowerCase()) {
    return false;
  }
  return true;
}

/**
 * @param {object} config parsed config (from src/config/load.js)
 * @param {string} campaignName
 * @param {object} [opts]
 * @param {string} [opts.platform] defaults to process.platform
 * @param {string} [opts.hostname] defaults to os.hostname()
 * @param {string} [opts.envProfile] defaults to process.env.SCRIPTORIUM_PROFILE
 * @param {{ vault?: string, output?: string, site_config?: string }} [opts.cliOverrides]
 */
function resolveCampaign(config, campaignName, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const hostname = opts.hostname ?? os.hostname();
  const envProfile = opts.envProfile ?? process.env.SCRIPTORIUM_PROFILE;
  const cliOverrides = opts.cliOverrides || {};

  const campaigns = config.campaigns || {};
  const campaignBlock = campaigns[campaignName];
  if (!campaignBlock) {
    const known = Object.keys(campaigns);
    // Issue #108: a campaign problem, so exit 3 (the frozen table has no usage code).
    throw new VaultUnreachableError(
      `no campaign named "${campaignName}" in config` +
        (known.length > 0 ? ` (known: ${known.join(', ')})` : ' (no campaigns registered)'),
      { path: null, campaign: campaignName, reason: 'unknown-campaign' },
    );
  }

  const base = {};
  for (const key of CAMPAIGN_FIELDS) base[key] = campaignBlock[key];

  const pathsTable = campaignBlock.paths || {};
  let winnerName = null;
  let winnerTable = null;

  if (envProfile) {
    if (!pathsTable[envProfile]) {
      throw new VaultUnreachableError(
        `SCRIPTORIUM_PROFILE="${envProfile}" names a profile that does not exist for campaign "${campaignName}"`,
        { path: null, campaign: campaignName, reason: 'bad-profile' },
      );
    }
    winnerName = envProfile;
    winnerTable = pathsTable[envProfile];
  } else {
    const candidates = [];
    for (const [name, table] of Object.entries(pathsTable)) {
      const match = table.match || {};
      // load.js already rejects unrecognised match keys; this is a second,
      // cheap defensive check so a caller building `config` by hand (tests,
      // a future in-memory path) cannot silently bypass it.
      const unknown = Object.keys(match).filter((k) => !MATCH_KEYS.includes(k));
      if (unknown.length > 0) {
        throw new VaultUnreachableError(`profile "${name}": unrecognised match key(s): ${unknown.join(', ')}`, {
          path: null,
          campaign: campaignName,
          reason: 'bad-profile',
        });
      }
      if (!matches(match, { platform, hostname })) continue;
      candidates.push({ name, table, specificity: specificityOf(match) });
    }
    candidates.sort((a, b) => b.specificity - a.specificity);
    if (candidates.length > 0) {
      const top = candidates[0].specificity;
      const tied = candidates.filter((c) => c.specificity === top);
      if (tied.length > 1) {
        throw new VaultUnreachableError(
          `two profiles are equally specific for this machine: ${tied.map((c) => c.name).join(', ')}`,
          { path: null, campaign: campaignName, reason: 'bad-profile' },
        );
      }
      winnerName = tied[0].name;
      winnerTable = tied[0].table;
    }
  }

  const resolved = { ...base };
  if (winnerTable) {
    for (const key of CAMPAIGN_FIELDS) {
      if (winnerTable[key] !== undefined) resolved[key] = winnerTable[key];
    }
  }

  if (cliOverrides.vault) resolved.vault = cliOverrides.vault;
  if (cliOverrides.output) resolved.output = cliOverrides.output;
  if (cliOverrides.site_config) resolved.site_config = cliOverrides.site_config;

  return {
    campaign: campaignName,
    profile: winnerName,
    vault: resolved.vault,
    site_config: resolved.site_config,
    output: resolved.output,
    pack: resolved.pack,
    serve_port: resolved.serve_port,
  };
}

/** No campaign argument: list every registered campaign name (config only, no I/O). */
function listCampaigns(config) {
  return Object.keys(config.campaigns || {});
}

/** Campaign resolves from the argument, else the configured default, else error if more than one is registered (Requirements section 3). */
function resolveCampaignName(config, explicitName) {
  if (explicitName) return explicitName;
  if (config.default_campaign) return config.default_campaign;
  const names = listCampaigns(config);
  if (names.length === 1) return names[0];
  if (names.length === 0) {
    throw new VaultUnreachableError('no campaigns registered; run "gm-scriptorium config add" first', {
      path: null,
      campaign: null,
      reason: 'no-campaigns',
    });
  }
  throw new VaultUnreachableError(
    `no campaign specified and no default_campaign set, with ${names.length} campaigns registered ` +
      `(${names.join(', ')}); pass --campaign or set a default`,
    { path: null, campaign: null, reason: 'no-campaign-chosen' },
  );
}

module.exports = { resolveCampaign, listCampaigns, resolveCampaignName };
