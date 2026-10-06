'use strict';

const fs = require('fs');
const { loadConfigFile, parseConfig } = require('../config/load');
const { migrateConfig } = require('../config/migrate');
const { resolveConfigPath } = require('../config/location');
const { resolveCampaignName, resolveCampaign } = require('../config/resolve');
const { ConfigError, VaultUnreachableError } = require('../util/errors');

/*
 * Global flag parsing and campaign resolution, shared by every subcommand
 * (bin/scriptorium.js dispatches, but does no parsing itself). Global
 * flags: --campaign <name>, --json, --quiet, --no-color, --config <path>,
 * --vault/--out/--site-config diagnostic overrides, --version, --help, --notices, --yes.
 */

const GLOBAL_FLAGS_WITH_VALUE = new Set(['campaign', 'config', 'vault', 'out', 'site-config', 'port', 'host']);
const GLOBAL_BOOLEAN_FLAGS = new Set(['json', 'quiet', 'no-color', 'version', 'help', 'notices', 'force', 'no-check', 'graph', 'build', 'check', 'pre', 'no-shim', 'yes', 'admin']);

/*
 * Issue #106: the flags each command accepts. Anything else is an error (an unknown flag used to be
 * ignored silently, so a typo of --force or --json quietly did something other than intended).
 * COMMON_FLAGS are the documented global flags (see HELP in bin/scriptorium.js); --quiet and
 * --no-color are documented and accepted but nothing reads them yet.
 */
const COMMON_FLAGS = ['help', 'version', 'notices', 'config', 'json', 'quiet', 'no-color', 'campaign', 'vault', 'out', 'site-config'];
const COMMAND_FLAGS = Object.freeze({
  init: [...COMMON_FLAGS, 'name', 'title', 'theme', 'yes'],
  check: [...COMMON_FLAGS, 'graph'],
  build: [...COMMON_FLAGS, 'force', 'no-check'],
  serve: [...COMMON_FLAGS, 'build', 'port', 'host', 'admin', 'preview-port'],
  status: [...COMMON_FLAGS],
  config: [...COMMON_FLAGS],
  update: [...COMMON_FLAGS, 'check', 'pre'],
  // V1.5a (ADR 0029): the remote-access command; each subcommand narrows this further itself
  // (src/cli/remote.js), so a flag meant for `set` is refused by `show`.
  remote: [...COMMON_FLAGS, 'mode', 'admin-url', 'preview-url', 'bind', 'trusted-proxy', 'port', 'preview-port'],
});
// Of the accepted flags, the ones that need a value after them (`update --version <tag>` is the one
// place --version takes a value; elsewhere it is the boolean that prints the version).
const VALUE_FLAGS = new Set(['campaign', 'config', 'vault', 'out', 'site-config', 'port', 'host', 'name', 'title', 'theme', 'preview-port', 'mode', 'admin-url', 'preview-url', 'bind', 'trusted-proxy']);

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** The closest accepted flag within 1 edit (names up to 3 letters) or 2 edits, else null. */
function closestFlag(name, accepted) {
  const limit = name.length <= 3 ? 1 : 2;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of [...accepted].sort()) {
    const d = editDistance(name, candidate);
    if (d <= limit && d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Throws a ConfigError for the first unknown flag, or for a value flag given with no value.
 * Exit code is whatever ConfigError maps to (unchanged: the frozen table has no usage code).
 *
 * @param {string} command
 * @param {Record<string, string|true>} flags parsed flags
 */
function validateFlags(command, flags) {
  const accepted = COMMAND_FLAGS[command];
  if (!accepted) return; // an unknown command is reported by the dispatcher
  for (const name of Object.keys(flags)) {
    if (accepted.includes(name)) {
      const takesValue = VALUE_FLAGS.has(name) || (name === 'version' && command === 'update');
      if (takesValue && flags[name] === true) {
        throw new ConfigError(`--${name} needs a value: ${command} --${name} <value>`);
      }
      continue;
    }
    const eq = name.indexOf('=');
    if (eq > 0 && accepted.includes(name.slice(0, eq))) {
      const base = name.slice(0, eq);
      throw new ConfigError(`unknown flag --${name}: write the value after a space, as in --${base} <value>`);
    }
    const guess = closestFlag(name, accepted);
    throw new ConfigError(
      `unknown flag --${name} for "${command}".` +
        (guess ? ` Did you mean --${guess}?` : '') +
        ' Run "gm-scriptorium --help" to see the flags each command accepts.',
    );
  }
}

/** Minimal, dependency-free argv parser: enough for this CLI's flat flag set. */
function parseArgv(argv) {
  const result = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      // `update --version <tag>` is the one place --version takes a value (issue #83). Anywhere
      // else it stays the global boolean that prints the running version.
      const updateTag = name === 'version' && result._[0] === 'update';
      if (updateTag || GLOBAL_FLAGS_WITH_VALUE.has(name) || !GLOBAL_BOOLEAN_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          result.flags[name] = next;
          i++;
          continue;
        }
      }
      result.flags[name] = true;
    } else {
      result._.push(a);
    }
  }
  return result;
}

/**
 * Loads and validates the config file, migrating forward if needed
 * (Engineering Brief section 6.3: on every command, not only `update`).
 * `config list`/`config path` callers may need this to succeed even when
 * no campaign is reachable, so this never touches vault content.
 */
function loadConfig(flags, { lenient = false } = {}) {
  const configPath = resolveConfigPath({ cliConfigPath: flags.config });
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      config: { config_version: 1, campaigns: {} },
      warnings: [],
      isNew: true,
    };
  }
  let loaded;
  try {
    loaded = loadConfigFile(configPath, { lenientCampaigns: lenient });
  } catch (err) {
    // Issue #108: a malformed config is a config problem, so exit 3 (same message, no new code).
    if (err instanceof ConfigError) {
      throw new VaultUnreachableError(err.message, { path: configPath, campaign: err.campaign, reason: 'bad-config' });
    }
    throw err;
  }
  const { config, warnings } = loaded;
  const { config: migrated, migrated: didMigrate, changes } = migrateConfig(config);
  return { configPath, config: migrated, warnings, isNew: false, didMigrate, migrationChanges: changes };
}

/**
 * Resolves the campaign name and its machine-specific paths for a command
 * that needs a vault. Does not check reachability (src/vault/locate.js's
 * job) and does not stat anything.
 */
function resolveCampaignContext(flags, explicitCampaign) {
  // QA F10: a --config path that does not exist used to fall through to "no campaigns registered",
  // which sent people to the default config. Say the file is missing. (config add may still
  // create a new file; it does not come through here.)
  if (typeof flags.config === 'string') {
    const wanted = resolveConfigPath({ cliConfigPath: flags.config });
    if (!fs.existsSync(wanted)) {
      throw new VaultUnreachableError(
        `config file not found: ${wanted} (create it with "gm-scriptorium config add <name> --vault <path> --config ${flags.config}")`,
        { path: wanted, campaign: null, reason: 'bad-config' },
      );
    }
  }
  const { configPath, config } = loadConfig(flags);
  const campaignName = resolveCampaignName(config, explicitCampaign || flags.campaign);
  const resolved = resolveCampaign(config, campaignName, {
    cliOverrides: { vault: flags.vault, output: flags.out, site_config: flags['site-config'] },
  });
  return { configPath, config, ...resolved };
}

module.exports = { COMMON_FLAGS, parseArgv, validateFlags, COMMAND_FLAGS, closestFlag, loadConfig, resolveCampaignContext, ConfigError };
