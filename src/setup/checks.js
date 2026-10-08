'use strict';

const fs = require('fs');
const path = require('path');
const locate = require('../vault/locate');
const { assertSafeOutputDir } = require('../build/plan');
const { THEMES, INIT_DEFAULT_THEME, loadTheme } = require('../build/themes');
const { loadPackToml } = require('../build/packtoml');
const { loadPackConfig } = require('../cli/check');
const { paletteScheme } = require('../checks/themescheme');
const { packDirFor, isInsideOrEqual } = require('../vault/packwrite');
const { inspectTarget } = require('../vault/vaultcreate');
const { ConfigError, ScriptoriumError, VaultUnreachableError } = require('../util/errors');
const { validateName, validateTitle, validateTheme, validateSystem, validateStarterTitle } = require('./validate');
const template = require('./template');
const { defaultOutputFor, defaultTitleFor, isNonEmptyForeignOutput, nonEmptyOutputWarning } = require('./scaffold');
const probeLib = require('./probe');

/*
 * Browser setup's field checks (ADR 0028, section 3). Every check runs on the server and answers
 * { field, state, value, rule, facts }: `state` is ok, warn, bad, deferred or unreachable; `rule`
 * is the shared validator's own message, word for word (the browser shows it under its friendly
 * text and never decides validity itself); `facts` is what the screen needs to draw the rows.
 *
 * The shared validators for a path (locateVault, assertSafeOutputDir) are synchronous, so each
 * path is first probed asynchronously and with a bound (./probe.js), and the sync validator runs
 * only after the probe answers ok or missing. A UNC path is not touched at all until the GM
 * commits the field (blur, Continue or Check again): checking per keystroke would probe every
 * partial host name as it is typed.
 */

const RELATIVE_RULE = 'Use the full folder path, starting with a drive letter or /';
const NEED_VAULT_RULE = 'Choose the vault folder first.';
const UNREACHABLE_RULES = Object.freeze({
  busy: 'The panel is still waiting on an earlier folder check. Try again in a few seconds.',
  timeout: "Can't reach that folder within a few seconds. If it is on a network share, check that the share is online, then check again.",
  error: "Can't read that folder.",
});

function result(field, state, value, rule, facts) {
  return { field, state, value, rule, facts };
}

/** @returns {{ clean: string, unc: boolean, relative: boolean, abs: string }} */
function typedPath(raw) {
  let clean = typeof raw === 'string' ? raw.trim() : '';
  if (clean.length >= 2 && clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1).trim();
  const unc = probeLib.isUncPath(clean);
  const relative = clean === '' || (!path.isAbsolute(clean) && !unc);
  return { clean, unc, relative, abs: relative ? clean : path.resolve(clean) };
}

function probeOpts(deps) {
  const opts = {};
  if (deps && deps.fsp) opts.fsp = deps.fsp;
  if (deps && deps.timeoutMs !== undefined) opts.timeoutMs = deps.timeoutMs;
  return opts;
}

function unreachable(field, value, probeState, unc, facts) {
  return result(field, 'unreachable', value, UNREACHABLE_RULES[probeState] || UNREACHABLE_RULES.error, { ...facts, unc, reason: probeState });
}

/** 'The Long Lease!' > 'the-long-lease'; null when nothing usable is left or the result still fails the name rule. */
function suggestSlug(raw) {
  const slug = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '');
  try {
    return validateName(slug);
  } catch {
    return null;
  }
}

async function checkName(value) {
  const typed = typeof value === 'string' ? value.trim() : '';
  try {
    validateName(typed);
    return result('name', 'ok', typed, null, { suggestion: null });
  } catch (err) {
    return result('name', 'bad', typed, err.message, { suggestion: suggestSlug(typed) });
  }
}

function vaultFacts(overrides) {
  return { found: false, isVault: false, unc: false, candidate: null, packExists: false, campaignTitle: null, ...overrides };
}

async function checkVault(value, { name = '', commit = false, deferUntilCommit = false } = {}, deps = {}) {
  const typed = typedPath(value);
  if (typed.relative) return result('vault', 'bad', typed.clean, RELATIVE_RULE, vaultFacts({}));
  if ((typed.unc || deferUntilCommit === true) && commit !== true) return result('vault', 'deferred', typed.clean, null, vaultFacts({ unc: typed.unc }));

  const opts = probeOpts(deps);
  const probed = await probeLib.probePath(typed.abs, opts);
  if (probed !== 'ok' && probed !== 'missing') return unreachable('vault', typed.abs, probed, typed.unc, vaultFacts({}));

  try {
    locate.locateVault(typed.abs, name);
  } catch (err) {
    if (!(err instanceof VaultUnreachableError)) throw err;
    if (err.reason === 'not-a-vault') {
      const candidate = await probeLib.findVaultChild(typed.abs, opts);
      return result('vault', 'bad', typed.abs, err.message, vaultFacts({ found: true, unc: typed.unc, candidate }));
    }
    return result('vault', 'bad', typed.abs, err.message, vaultFacts({ unc: typed.unc }));
  }

  let campaignTitle = null;
  try {
    campaignTitle = defaultTitleFor(typed.abs, '') || null;
  } catch {
    campaignTitle = null;
  }
  const facts = vaultFacts({
    found: true,
    isVault: true,
    unc: typed.unc,
    packExists: fs.existsSync(packDirFor(typed.abs)),
    campaignTitle,
  });
  return result('vault', typed.unc ? 'warn' : 'ok', typed.abs, null, facts);
}

async function checkOutput(value, { vault = '', name = '', commit = false, deferUntilCommit = false } = {}, deps = {}) {
  const baseFacts = { default: null, inside: false, nonEmptyForeign: false, exists: false };
  if (typeof vault !== 'string' || vault === '') return result('output', 'bad', '', NEED_VAULT_RULE, baseFacts);
  const facts = { ...baseFacts, default: defaultOutputFor(vault, name) };

  const typed = typedPath(value);
  if (typed.relative) return result('output', 'bad', typed.clean, RELATIVE_RULE, facts);
  if ((typed.unc || deferUntilCommit === true) && commit !== true) return result('output', 'deferred', typed.clean, null, facts);

  const probed = await probeLib.probePath(typed.abs, probeOpts(deps));
  if (probed !== 'ok' && probed !== 'missing') return unreachable('output', typed.abs, probed, typed.unc, facts);

  try {
    assertSafeOutputDir(vault, typed.abs);
  } catch (err) {
    if (!(err instanceof ScriptoriumError)) throw err;
    return result('output', 'bad', typed.abs, err.message, { ...facts, inside: err.message.startsWith('refusing to build inside the vault') });
  }
  if (isNonEmptyForeignOutput(typed.abs)) {
    return result('output', 'warn', typed.abs, nonEmptyOutputWarning(typed.abs), { ...facts, nonEmptyForeign: true });
  }
  return result('output', 'ok', typed.abs, null, { ...facts, exists: fs.existsSync(typed.abs) });
}

async function checkTitle(value, { vault = '', name = '' } = {}) {
  const jsonPath = vault ? path.join(packDirFor(vault), 'vault.config.json') : null;
  if (jsonPath && fs.existsSync(jsonPath)) {
    try {
      const existing = loadPackConfig(jsonPath, name).siteTitle;
      return result('title', 'ok', typeof existing === 'string' ? existing : null, null, { readOnly: true, default: null });
    } catch (err) {
      return result('title', 'bad', null, err.message, { readOnly: true, default: null });
    }
  }
  let fallback = null;
  if (vault) {
    try {
      fallback = defaultTitleFor(vault, name);
    } catch {
      fallback = name || null;
    }
  }
  if (value === undefined || value === null) return result('title', 'ok', fallback, null, { readOnly: false, default: fallback });
  try {
    return result('title', 'ok', validateTitle(value), null, { readOnly: false, default: fallback });
  } catch (err) {
    return result('title', 'bad', typeof value === 'string' ? value : '', err.message, { readOnly: false, default: fallback });
  }
}

/** The haze-versus-light-palette note: only when the theme does not own the palette and the schemes differ. */
function themeNote(theme, vault) {
  if (!vault) return null;
  try {
    const loaded = loadTheme(theme);
    if (loaded.scheme === null || loaded.owns.includes('palette')) return null;
    const { scheme, background } = paletteScheme(vault);
    if (scheme === null || scheme === loaded.scheme) return null;
    return (
      `Your vault's palette background (${background}) is ${scheme} and ${theme} is ${loaded.scheme}. ` +
      'Check will report this as info, config/theme-scheme-mismatch. It still builds.'
    );
  } catch {
    return null;
  }
}

async function checkTheme(value, { vault = '', name = '' } = {}) {
  if (vault && fs.existsSync(path.join(packDirFor(vault), 'pack.toml'))) {
    try {
      const loaded = loadPackToml(packDirFor(vault), { campaign: name });
      return result('theme', 'ok', loaded.theme, null, { readOnly: true, note: themeNote(loaded.theme, vault) });
    } catch (err) {
      return result('theme', 'bad', null, err.message, { readOnly: true, note: null });
    }
  }
  const chosen = value === undefined || value === null || value === '' ? INIT_DEFAULT_THEME : value;
  try {
    const theme = validateTheme(chosen, THEMES);
    return result('theme', 'ok', theme, null, { readOnly: false, note: themeNote(theme, vault) });
  } catch (err) {
    return result('theme', 'bad', typeof chosen === 'string' ? chosen : '', err.message, { readOnly: false, note: null });
  }
}

/*
 * The new-campaign path (docs/decisions/0048-new-campaign-vault.md, section 5). Same shape and same
 * rules as the checks above: the browser never decides validity, and a refusal's `rule` is the
 * writer's or the validator's own message, word for word.
 */

const ONEDRIVE_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];

function underOneDrive(abs, env) {
  for (const key of ONEDRIVE_VARS) {
    const base = env && env[key];
    if (typeof base === 'string' && base !== '' && isInsideOrEqual(path.resolve(base), abs)) return true;
  }
  return false;
}

function newVaultFacts(overrides) {
  return { exists: false, litter: [], missingAncestors: [], unc: false, oneDrive: false, refusal: null, ...overrides };
}

/**
 * The folder a NEW vault would be created in. ok: it does not exist yet, or is empty (apart from
 * OS litter and an .obsidian folder). Missing parent folders are allowed and listed in
 * facts.missingAncestors, because the commit creates them, level by level, after the review.
 * Nothing is created here.
 */
async function checkNewVault(value, { name = '', commit = false, configPath, panelDir, deferUntilCommit = false } = {}, deps = {}) {
  const typed = typedPath(value);
  if (typed.relative) return result('newVault', 'bad', typed.clean, RELATIVE_RULE, newVaultFacts({ refusal: 'relative' }));
  if ((typed.unc || deferUntilCommit === true) && commit !== true) return result('newVault', 'deferred', typed.clean, null, newVaultFacts({ unc: typed.unc }));

  const probed = await probeLib.probePath(typed.abs, probeOpts(deps));
  if (probed !== 'ok' && probed !== 'missing') return unreachable('newVault', typed.abs, probed, typed.unc, newVaultFacts({}));

  let info;
  try {
    info = inspectTarget(typed.abs, { configPath, panelDir, campaign: name || null });
  } catch (err) {
    if (!(err instanceof VaultUnreachableError)) throw err;
    return result('newVault', 'bad', typed.abs, err.message, newVaultFacts({ unc: typed.unc, refusal: err.kind || null, holds: err.holds, ancestor: err.ancestor }));
  }
  const facts = newVaultFacts({
    exists: info.state === 'empty',
    litter: info.litter,
    missingAncestors: info.missingAncestors,
    unc: typed.unc,
    oneDrive: underOneDrive(typed.abs, (deps && deps.env) || process.env),
  });
  return result('newVault', typed.unc ? 'warn' : 'ok', typed.abs, null, facts);
}

/** @returns {{ tpl: object }|{ problem: string }} */
function loadStarter(deps) {
  try {
    return { tpl: template.loadTemplate({ dir: deps && deps.templateDir }) };
  } catch (err) {
    if (err instanceof ScriptoriumError) return { problem: err.message };
    throw err;
  }
}

async function checkSystem(value, deps = {}) {
  const shown = typeof value === 'string' ? value : '';
  const loaded = loadStarter(deps);
  if (loaded.problem) return result('system', 'bad', shown, loaded.problem, { systems: [] });
  const systems = template.starterSystems(loaded.tpl);
  try {
    const id = validateSystem(value, systems);
    const chosen = loaded.tpl.systems.get(id);
    // What the starter holds for this system, so the review can list every folder and file it makes.
    return result('system', 'ok', id, null, { systems, layout: { dirs: [...chosen.dirs], files: chosen.files.map((x) => x.rel) } });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return result('system', 'bad', shown, err.message, { systems });
  }
}

/** The site title of a new vault: normalised, and read back through every page it will be written into. */
async function checkStarterTitle(value, { name = '' } = {}, deps = {}) {
  const fallback = name || null;
  const raw = value === undefined || value === null ? fallback : value;
  const facts = { default: fallback };
  const shown = typeof raw === 'string' ? raw : '';
  let title;
  try {
    title = validateStarterTitle(raw);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return result('starterTitle', 'bad', shown, err.message, facts);
  }
  const loaded = loadStarter(deps);
  if (loaded.problem) return result('starterTitle', 'bad', shown, loaded.problem, facts);
  try {
    template.assertTitleReadsBack(loaded.tpl, title);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return result('starterTitle', 'bad', shown, err.message, facts);
  }
  return result('starterTitle', 'ok', title, null, facts);
}

/*
 * What the setup routes and the add-a-campaign routes (ADR 0052) share: the field list, the query
 * parsing, the one dispatcher, the answer-shape rules and the state facts. Both handlers call these
 * and neither keeps a copy, so first run and add can never answer differently for the same input.
 */

const CHECK_FIELDS = Object.freeze(['name', 'vault', 'output', 'title', 'theme', 'newVault', 'system', 'starterTitle']);
const MAX_VALUE = 2048;
const MAX_NAME = 200;
const ANSWER_KEYS = Object.freeze(['name', 'vault', 'output', 'outputConfirmed', 'title', 'theme', 'newVault', 'system']);

function oneParam(query, key, max = MAX_VALUE) {
  const v = query.get(key);
  if (v === null) return { ok: true, value: undefined };
  if (v.length > max) return { ok: false };
  return { ok: true, value: v };
}

/**
 * @param {URLSearchParams} query
 * @returns {{ ok: false, message: string } | { ok: true, field: string, value: string|undefined, name: string|undefined, vault: string|undefined, commit: boolean }}
 */
function parseCheckQuery(query) {
  const field = query.get('field');
  if (!CHECK_FIELDS.includes(field)) return { ok: false, message: `field must be one of ${CHECK_FIELDS.join(', ')}` };
  const value = oneParam(query, 'value');
  const name = oneParam(query, 'name', MAX_NAME);
  const vault = oneParam(query, 'vault');
  if (!value.ok || !name.ok || !vault.ok) return { ok: false, message: 'a value is too long' };
  return { ok: true, field, value: value.value, name: name.value, vault: vault.value, commit: query.get('commit') === '1' };
}

/**
 * The one field dispatcher.
 *
 * @param {{ field: string, value: string|undefined, name: string|undefined, vault: string|undefined, commit: boolean }} q from parseCheckQuery
 * @param {{ configPath?: string, panelDir?: string, deferUntilCommit?: boolean }} where
 * @param {object} [deps]
 */
async function runCheck(q, { configPath, panelDir, deferUntilCommit = false } = {}, deps = {}) {
  const { field, value, commit } = q;
  const where = { vault: q.vault || '', name: q.name || '' };
  let res;
  if (field === 'name') res = await checkName(value);
  else if (field === 'vault') res = await checkVault(value, { name: where.name, commit, deferUntilCommit }, deps);
  else if (field === 'output') res = await checkOutput(value, { ...where, commit, deferUntilCommit }, deps);
  else if (field === 'title') res = await checkTitle(value, where);
  else if (field === 'newVault') res = await checkNewVault(value, { ...where, commit, configPath, panelDir, deferUntilCommit }, deps);
  else if (field === 'system') res = await checkSystem(value, deps);
  else if (field === 'starterTitle') res = await checkStarterTitle(value, { name: where.name }, deps);
  else res = await checkTheme(value, where);
  return res;
}

/** Whether this build can start a new campaign (ADR 0048): the shipped game systems, or why it cannot. */
function newVaultState(deps) {
  try {
    const tpl = template.loadTemplate({ dir: deps.templateDir });
    return { available: true, systems: template.starterSystems(tpl), problem: null };
  } catch (err) {
    return { available: false, systems: [], problem: err.message };
  }
}

/** The facts both state routes report: the themes, the separator and whether a new vault can be started. */
function setupFacts(deps) {
  return { themes: Object.keys(THEMES), defaultTheme: INIT_DEFAULT_THEME, sep: path.sep, newVault: newVaultState(deps || {}) };
}

/**
 * The shape rules for a commit body that is already parsed JSON. @returns {string|null} the first problem
 * @param {object} parsed
 * @param {readonly string[]} [keys]
 */
function answersProblem(parsed, keys = ANSWER_KEYS) {
  const unknown = Object.keys(parsed).filter((k) => !keys.includes(k));
  if (unknown.length > 0) return `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
  for (const key of ['name', 'vault', 'output']) {
    if (typeof parsed[key] !== 'string' || parsed[key].length > MAX_VALUE) return `${key} must be text`;
  }
  for (const key of ['title', 'theme', 'system']) {
    if (parsed[key] !== undefined && (typeof parsed[key] !== 'string' || parsed[key].length > MAX_VALUE)) return `${key} must be text`;
  }
  if (parsed.outputConfirmed !== undefined && typeof parsed.outputConfirmed !== 'boolean') return 'outputConfirmed must be true or false';
  if (parsed.newVault !== undefined && typeof parsed.newVault !== 'boolean') return 'newVault must be true or false';
  return null;
}

/*
 * The lexical clash rules for adding a campaign (ADR 0052, section 4). Compared as written in
 * config.toml (the raw entry and every paths.<profile> table), never by looking at another
 * campaign's folders, so a dead share elsewhere can never stall an add.
 */

function canon(p) {
  return String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Every vault and output a campaign entry names, as written: the entry itself, then each paths.<profile>. */
function pathsOf(entry, key) {
  const out = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return out;
  const own = entry[key];
  if (typeof own === 'string' && canon(own) !== '') out.push(own);
  const profiles = entry.paths;
  if (typeof profiles === 'object' && profiles !== null && !Array.isArray(profiles)) {
    for (const table of Object.values(profiles)) {
      if (typeof table === 'object' && table !== null && typeof table[key] === 'string' && canon(table[key]) !== '') out.push(table[key]);
    }
  }
  return out;
}

/**
 * @param {object} config a parsed config
 * @param {{ name?: string, vault?: string, output?: string }} proposed
 * @returns {null | { field: 'name'|'vault'|'output', kind: string, campaign: string, rule: string }}
 */
function registeredClash(config, { name, vault, output } = {}) {
  const campaigns = config && typeof config.campaigns === 'object' && config.campaigns !== null ? Object.entries(config.campaigns) : [];
  const v = typeof vault === 'string' ? canon(vault) : '';
  const o = typeof output === 'string' ? canon(output) : '';

  if (typeof name === 'string' && name !== '') {
    for (const [other] of campaigns) {
      if (other === name) return { field: 'name', kind: 'name', campaign: other, rule: `campaign "${name}" is already registered; choose another name` };
    }
  }
  if (v !== '') {
    for (const [other, entry] of campaigns) {
      for (const theirs of pathsOf(entry, 'vault')) {
        if (canon(theirs) === v) return { field: 'vault', kind: 'vault-equal', campaign: other, rule: `${vault} is already registered as campaign "${other}"` };
      }
    }
    for (const [other, entry] of campaigns) {
      for (const theirs of pathsOf(entry, 'output')) {
        if (overlaps(v, canon(theirs))) {
          return { field: 'vault', kind: 'vault-in-output', campaign: other, rule: `${vault} overlaps the output folder of campaign "${other}" (${theirs}), which every build of "${other}" replaces` };
        }
      }
    }
  }
  if (o !== '') {
    for (const [other, entry] of campaigns) {
      for (const theirs of pathsOf(entry, 'output')) {
        if (overlaps(o, canon(theirs))) {
          return { field: 'output', kind: 'output-overlap-output', campaign: other, rule: `${output} overlaps the output folder of campaign "${other}" (${theirs}); each campaign needs its own output folder` };
        }
      }
    }
    for (const [other, entry] of campaigns) {
      for (const theirs of pathsOf(entry, 'vault')) {
        if (overlaps(o, canon(theirs))) {
          return { field: 'output', kind: 'output-in-vault', campaign: other, rule: `${output} overlaps the vault of campaign "${other}" (${theirs}); a build replaces its whole output folder, so it must stay clear of every vault` };
        }
      }
    }
  }
  return null;
}

module.exports = {
  CHECK_FIELDS,
  ANSWER_KEYS,
  parseCheckQuery,
  runCheck,
  setupFacts,
  answersProblem,
  registeredClash,
  checkName,
  checkVault,
  checkOutput,
  checkTitle,
  checkTheme,
  checkNewVault,
  checkSystem,
  checkStarterTitle,
  underOneDrive,
  suggestSlug,
  RELATIVE_RULE,
  NEED_VAULT_RULE,
};
