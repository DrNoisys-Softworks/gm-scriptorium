'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../cli/args');
const read = require('../vault/read');
const { packDirFor, createPackEntries } = require('../vault/packwrite');
const { addCampaign, removeCampaign, setDefaultCampaign, assertConfigPathNotInVault } = require('../config/write');
const { parseConfig } = require('../config/load');
const { migrateConfig } = require('../config/migrate');
// Called through the module object, never destructured: a test spies on writeConfigFile to prove it
// is called once from the setup commit and from nowhere else (ADR 0028, section 2).
const configWrite = require('../config/write');
const { assertNotInsideAnyVault } = require('../remote/paths');
const welcome = require('../admin/welcome');
const { ConfigError, VaultUnreachableError } = require('../util/errors');
const { SCAFFOLD, scaffoldEntries, nonEmptyOutputRefusal } = require('./scaffold');
const checks = require('./checks');

/*
 * Browser setup's commit (docs/decisions/0028-installer-and-first-run.md, sections 1 and 2), and
 * the campaign set-default and remove (docs/decisions/0050-several-campaigns.md, section 5). This
 * is the ONLY panel-side importer of src/config/write.js, and only src/admin/handlers/setup.js (the
 * commit route) and src/admin/handlers/campaigns.js (the two routes above) require this one. It reaches neither
 * src/cli/config.js (which starts the editor) nor src/cli/init.js, nor child_process
 * (test/setup-structure.test.js proves each of those).
 *
 * Vault writes go only through createPackEntries (src/vault/packwrite.js: create-only, never an
 * overwrite). Nothing is ever rolled back: whatever was created stays, and the result says so.
 */

function invalid(field, rule) {
  return { invalid: { field, rule } };
}

const BAD_STATES = new Set(['bad', 'unreachable', 'deferred']);

/**
 * @param {{ name: string, vault: string, output: string, outputConfirmed?: boolean, title?: string, theme?: string }} answers
 * @param {{ configPath: string, panelDir: string }} where
 * @param {{ fsp?: object, timeoutMs?: number }} [deps] probe injection (tests only)
 * @returns {Promise<
 *   { created: string[], untouched: string[], packDir: string, configPath: string, isDefault: boolean } |
 *   { refused: 'taken' } |
 *   { invalid: { field: string, rule: string } }>}
 */
async function commitSetup(answers, { configPath, panelDir }, deps = {}) {
  // 1. The race check comes first and re-reads the file: another instance, or a terminal `init`,
  // may have registered a campaign since this page loaded.
  const { config } = loadConfig({ config: configPath });
  if (Object.keys(config.campaigns || {}).length > 0) return { refused: 'taken' };

  // 2. Re-validate every answer on the server, with the same functions the live checks use.
  const nameRes = await checks.checkName(answers.name);
  if (BAD_STATES.has(nameRes.state)) return invalid('name', nameRes.rule);
  const name = nameRes.value;

  const vaultRes = await checks.checkVault(answers.vault, { name, commit: true }, deps);
  if (BAD_STATES.has(vaultRes.state)) return invalid('vault', vaultRes.rule);
  const vaultAbs = vaultRes.value;

  const outRes = await checks.checkOutput(answers.output, { vault: vaultAbs, name, commit: true }, deps);
  if (BAD_STATES.has(outRes.state)) return invalid('output', outRes.rule);
  const outAbs = outRes.value;
  if (outRes.facts.nonEmptyForeign && answers.outputConfirmed !== true) return invalid('output', nonEmptyOutputRefusal(outAbs));

  const titleRes = await checks.checkTitle(answers.title, { vault: vaultAbs, name });
  if (BAD_STATES.has(titleRes.state)) return invalid('title', titleRes.rule);
  const themeRes = await checks.checkTheme(answers.theme, { vault: vaultAbs, name });
  if (BAD_STATES.has(themeRes.state)) return invalid('theme', themeRes.rule);

  // The probes above can each wait seconds on a slow share, so the first read of the config may be
  // stale. This is the last await: read the config again, and from here to the write everything is
  // synchronous, so nothing can register a campaign in between except a truly simultaneous write.
  const latest = loadConfig({ config: configPath }).config;
  if (Object.keys(latest.campaigns || {}).length > 0) return { refused: 'taken' };

  // 3. The pack folder must not be a file.
  const packDir = packDirFor(vaultAbs);
  const packStat = read.statOrNull(packDir);
  if (packStat && !packStat.isDirectory()) {
    return invalid('vault', `refusing to write the campaign pack: ${packDir} exists and is not a folder`);
  }

  // 4. The registration, and the two refusals that must come before anything is written.
  const next = addCampaign(latest, name, { vault: vaultAbs, output: outAbs });
  try {
    assertConfigPathNotInVault(configPath, next);
    assertNotInsideAnyVault(panelDir, next);
  } catch (err) {
    if (err instanceof ConfigError) return invalid('config', err.message);
    throw err;
  }

  // 5. Pack entries: only what is missing, create-only; what exists is left alone and listed.
  const missing = SCAFFOLD.filter((entry) => !fs.existsSync(path.join(packDir, entry.rel)));
  const untouched = SCAFFOLD.filter((entry) => fs.existsSync(path.join(packDir, entry.rel)));
  let created = [];
  const packStart = process.hrtime.bigint();
  if (missing.length > 0) {
    const entries = scaffoldEntries(vaultAbs, missing, { title: titleRes.value, theme: themeRes.value });
    created = createPackEntries(vaultAbs, entries, { campaign: name }).created;
  }

  const packMs = Number(process.hrtime.bigint() - packStart) / 1e6;

  // 6. The one config write.
  const registerStart = process.hrtime.bigint();
  configWrite.writeConfigFile(configPath, next);
  const registerMs = Number(process.hrtime.bigint() - registerStart) / 1e6;
  const isDefault = !latest.default_campaign && next.default_campaign === name;

  // 7. The welcome list: best effort, swallowed. A failure here never changes what the GM sees.
  try {
    welcome.addPending(panelDir, name);
  } catch {
    // swallowed deliberately: the welcome is a courtesy, the registration already succeeded.
  }

  return {
    created,
    untouched: untouched.map((entry) => (entry.kind === 'dir' ? `${entry.rel}/` : entry.rel)),
    packDir,
    configPath,
    isDefault,
    ms: { pack: packMs, register: registerMs },
  };
}

/**
 * The config as the page saw it: the sha256 of the file's bytes and the parsed config, both from
 * ONE read, so the two can never disagree. The parse mirrors the CLI: lenient for `config remove`
 * (a malformed entry must stay removable), strict for `config set-default`, then the migration.
 *
 * @param {string} configPath
 * @param {{ lenient: boolean }} opts
 * @returns {{ exists: boolean, sha256: string|null, config: object }}
 * @throws {ConfigError} on a file that does not parse
 */
function readConfigSnapshot(configPath, { lenient }) {
  let bytes;
  try {
    bytes = fs.readFileSync(configPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, sha256: null, config: { config_version: 1, campaigns: {} } };
    throw err;
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const { config } = parseConfig(bytes.toString('utf8'), { lenientCampaigns: lenient });
  return { exists: true, sha256, config: migrateConfig(config).config };
}

/**
 * Shared by remove and set-default. Everything from the snapshot to the write is synchronous, so
 * nothing can change the file in between (the caller read its body before calling).
 */
function changeCampaign({ name, configSha256, lenient, checkActive, apply, configPath }) {
  let snap;
  try {
    snap = readConfigSnapshot(configPath, { lenient });
  } catch (err) {
    if (err instanceof ConfigError) return { refused: 'config-invalid', message: err.message };
    throw err;
  }
  if (snap.sha256 !== configSha256) return { refused: 'config-changed' };
  if (checkActive(snap)) return { refused: 'active' };
  let next;
  try {
    next = apply(snap.config, name);
  } catch (err) {
    if (err instanceof VaultUnreachableError) return { refused: 'unknown-campaign', message: err.message };
    throw err;
  }
  try {
    configWrite.writeConfigFile(configPath, next);
  } catch (err) {
    if (err instanceof ConfigError) return { refused: 'config-invalid', message: err.message };
    throw err;
  }
  return { ok: true };
}

/**
 * Deregisters a campaign: the same config bytes as `config remove`, and nothing else on disk but
 * the welcome list. The active campaign is refused.
 *
 * @param {{ name: string, configSha256: string, activeCampaign: string|null }} args
 * @param {{ configPath: string, panelDir?: string }} where
 * @returns {{ ok: true, configSha256: string } | { refused: 'config-changed'|'active' } | { refused: 'unknown-campaign'|'config-invalid', message: string }}
 */
function removeFromPanel({ name, configSha256, activeCampaign }, { configPath, panelDir }) {
  const done = changeCampaign({ name, configSha256, lenient: true, checkActive: () => name === activeCampaign, apply: removeCampaign, configPath });
  if (!done.ok) return done;
  if (panelDir) {
    try {
      welcome.removePending(panelDir, name);
    } catch {
      // swallowed deliberately: the welcome is a courtesy, the config change already stands.
    }
  }
  return { ok: true, configSha256: readConfigSnapshot(configPath, { lenient: true }).sha256 };
}

/**
 * Sets default_campaign: the same config bytes as `config set-default`. It does not switch.
 *
 * @param {{ name: string, configSha256: string }} args
 * @param {{ configPath: string }} where
 */
function setDefaultFromPanel({ name, configSha256 }, { configPath }) {
  const done = changeCampaign({ name, configSha256, lenient: false, checkActive: () => false, apply: setDefaultCampaign, configPath });
  if (!done.ok) return done;
  return { ok: true, configSha256: readConfigSnapshot(configPath, { lenient: true }).sha256 };
}

module.exports = { commitSetup, readConfigSnapshot, removeFromPanel, setDefaultFromPanel };
