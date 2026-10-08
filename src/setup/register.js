'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../cli/args');
const read = require('../vault/read');
const { packDirFor, createPackEntries } = require('../vault/packwrite');
const { createVault } = require('../vault/vaultcreate');
const { addCampaign, assertConfigPathNotInVault } = require('../config/write');
// Called through the module object, never destructured: a test spies on writeConfigFile to prove it
// is called once from the setup commit and from nowhere else (ADR 0028, section 2).
const configWrite = require('../config/write');
const { assertNotInsideAnyVault } = require('../remote/paths');
const welcome = require('../admin/welcome');
const { ConfigError, ScriptoriumError, VaultUnreachableError } = require('../util/errors');
const { SCAFFOLD, scaffoldEntries, nonEmptyOutputRefusal } = require('./scaffold');
const checks = require('./checks');
const template = require('./template');

/*
 * Browser setup's commit (docs/decisions/0028-installer-and-first-run.md, sections 1 and 2). This
 * is the ONLY panel-side importer of src/config/write.js, and src/admin/handlers/setup.js is the
 * only module that requires this one, from the setup commit route alone. It reaches neither
 * src/cli/config.js (which starts the editor) nor src/cli/init.js, nor child_process
 * (test/setup-structure.test.js proves each of those).
 *
 * Vault writes go only through createPackEntries (src/vault/packwrite.js: create-only, never an
 * overwrite) and, when the GM starts a new campaign, createVault (src/vault/vaultcreate.js: also
 * create-only, docs/decisions/0048-new-campaign-vault.md). Nothing is ever rolled back: whatever was
 * created stays, and the result says so.
 */

function invalid(field, rule) {
  return { invalid: { field, rule } };
}

const BAD_STATES = new Set(['bad', 'unreachable', 'deferred']);

/**
 * @param {{ name: string, vault: string, output: string, outputConfirmed?: boolean, title?: string, theme?: string,
 *   newVault?: boolean, system?: string }} answers newVault: true means `vault` is a folder to create a new vault in
 *   (title is then the new vault's site title, system its game system)
 * @param {{ configPath: string, panelDir: string }} where
 * @param {{ fsp?: object, timeoutMs?: number, now?: () => Date, env?: object, templateDir?: string }} [deps] injection (tests only)
 * @returns {Promise<
 *   { created: string[], untouched: string[], packDir: string, configPath: string, isDefault: boolean } |
 *   { refused: 'taken' } |
 *   { invalid: { field: string, rule: string } }>}
 */
async function commitSetup(answers, { configPath, panelDir }, deps = {}) {
  if (answers.newVault === true) return commitNewVault(answers, { configPath, panelDir }, deps);

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
 * The new-campaign commit: the same order as above, with the vault created first.
 *   race check > revalidate every answer > re-read the config > refuse a config or panel folder in
 *   the vault > render the starter in memory > create the vault > create the pack > the one config write.
 * If the vault cannot be created nothing else is written. If a later step fails the vault stays,
 * and the message says so.
 */
async function commitNewVault(answers, { configPath, panelDir }, deps) {
  const { config } = loadConfig({ config: configPath });
  if (Object.keys(config.campaigns || {}).length > 0) return { refused: 'taken' };

  const nameRes = await checks.checkName(answers.name);
  if (BAD_STATES.has(nameRes.state)) return invalid('name', nameRes.rule);
  const name = nameRes.value;

  const vaultRes = await checks.checkNewVault(answers.vault, { name, commit: true, configPath, panelDir }, deps);
  if (BAD_STATES.has(vaultRes.state)) return invalid('newVault', vaultRes.rule);
  const vaultAbs = vaultRes.value;

  const outRes = await checks.checkOutput(answers.output, { vault: vaultAbs, name, commit: true }, deps);
  if (BAD_STATES.has(outRes.state)) return invalid('output', outRes.rule);
  const outAbs = outRes.value;
  if (outRes.facts.nonEmptyForeign && answers.outputConfirmed !== true) return invalid('output', nonEmptyOutputRefusal(outAbs));

  const titleRes = await checks.checkStarterTitle(answers.title, { name }, deps);
  if (BAD_STATES.has(titleRes.state)) return invalid('starterTitle', titleRes.rule);
  const themeRes = await checks.checkTheme(answers.theme, { vault: vaultAbs, name });
  if (BAD_STATES.has(themeRes.state)) return invalid('theme', themeRes.rule);
  const systemRes = await checks.checkSystem(answers.system, deps);
  if (BAD_STATES.has(systemRes.state)) return invalid('system', systemRes.rule);

  // The last await: from here to the writes everything is synchronous (see commitSetup).
  const latest = loadConfig({ config: configPath }).config;
  if (Object.keys(latest.campaigns || {}).length > 0) return { refused: 'taken' };

  const next = addCampaign(latest, name, { vault: vaultAbs, output: outAbs });
  try {
    assertConfigPathNotInVault(configPath, next);
    assertNotInsideAnyVault(panelDir, next);
  } catch (err) {
    if (err instanceof ConfigError) return invalid('config', err.message);
    throw err;
  }

  let starter;
  try {
    const now = typeof deps.now === 'function' ? deps.now() : new Date();
    starter = template.renderStarter(template.loadTemplate({ dir: deps.templateDir }), {
      system: systemRes.value,
      title: titleRes.value,
      created: template.localDate(now),
    });
  } catch (err) {
    if (err instanceof ConfigError) return invalid('starterTitle', err.message);
    throw err;
  }

  // 1. The vault. A failure here leaves nothing else written.
  let vault;
  const vaultStart = process.hrtime.bigint();
  try {
    vault = createVault(vaultAbs, starter, { configPath, panelDir, campaign: name });
  } catch (err) {
    if (err instanceof VaultUnreachableError) return invalid('newVault', err.message);
    throw err;
  }

  const vaultMs = Number(process.hrtime.bigint() - vaultStart) / 1e6;

  // 2. The pack, inside the vault just made. A failure leaves the vault and says so.
  let created;
  const packStart = process.hrtime.bigint();
  try {
    created = createPackEntries(vaultAbs, scaffoldEntries(vaultAbs, SCAFFOLD, { title: titleRes.value, theme: themeRes.value }), { campaign: name }).created;
  } catch (err) {
    if (!(err instanceof ScriptoriumError)) throw err;
    return invalid('newVault', `${err.message.replace(/\.$/, '')}. The new vault at ${vaultAbs} was created and is left as it is.`);
  }
  const packMs = Number(process.hrtime.bigint() - packStart) / 1e6;

  // 3. The one config write.
  const registerStart = process.hrtime.bigint();
  configWrite.writeConfigFile(configPath, next);
  const registerMs = Number(process.hrtime.bigint() - registerStart) / 1e6;
  const isDefault = !latest.default_campaign && next.default_campaign === name;

  try {
    welcome.addPending(panelDir, name);
  } catch {
    // swallowed deliberately: the welcome is a courtesy, the registration already succeeded.
  }

  return {
    created,
    untouched: [],
    packDir: packDirFor(vaultAbs),
    configPath,
    isDefault,
    vaultRoot: vault.root,
    vaultCreated: vault.created,
    vaultAncestors: vault.createdAncestors,
    ms: { vault: vaultMs, pack: packMs, register: registerMs },
  };
}

module.exports = { commitSetup };
