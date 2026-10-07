'use strict';

/*
 * The config TOML schema. Frozen in phase 1 (Engineering Brief section 4
 * and section 9): the shape below, `config_version = 1` mandatory from day
 * one so `update` can migrate forward.
 *
 * config_version = 1
 * default_campaign = "my-campaign"
 *
 * [campaigns.my-campaign]
 * vault       = '~/campaigns/my-campaign/vault'
 * site_config = '~/campaigns/my-campaign/site/vault.config.json'
 * output      = '~/campaigns/my-campaign/out'
 * serve_port  = 8080
 *
 * [campaigns.my-campaign.paths.win-desktop]
 * match = { platform = "win32" }
 * # keys omitted here fall back to the campaign block above
 * # e.g. vault = 'D:\Campaigns\my-campaign\vault'
 *
 * This module holds only the shape: what a valid config looks like, and
 * what a phase-2 resolver (src/config/resolve.js, not built yet) and
 * writer (src/config/write.js, not built yet) will assume is already true
 * of anything load.js hands them. It does not implement profile matching,
 * specificity, --vault/--out overrides, or SCRIPTORIUM_PROFILE: that
 * resolution engine is phase 2 chunk A.
 */

// The config_version this build understands. A file with a higher version
// is a hard error (section 6.3: "never a silent partial read"). A file
// with a lower version is structurally valid here; migrating it forward is
// src/config/migrate.js, phase 3.
const CONFIG_VERSION = 1;

// v1 supports exactly two match keys. An unrecognised key inside `match` is
// a hard config error, never ignored (section 5), so a future key added by
// a newer Scriptorium cannot silently match on an older one.
const MATCH_KEYS = Object.freeze(['platform', 'hostname']);

// The per-campaign fields a profile override may supply. Absent keys fall
// through to the campaign's base block (resolution logic is phase 2).
const CAMPAIGN_STRING_FIELDS = Object.freeze(['vault', 'site_config', 'output', 'pack']);
const CAMPAIGN_INTEGER_FIELDS = Object.freeze(['serve_port']);

const TOP_LEVEL_KEYS = Object.freeze(['config_version', 'default_campaign', 'campaigns']);

module.exports = {
  CONFIG_VERSION,
  MATCH_KEYS,
  CAMPAIGN_STRING_FIELDS,
  CAMPAIGN_INTEGER_FIELDS,
  TOP_LEVEL_KEYS,
};
