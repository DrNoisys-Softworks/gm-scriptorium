'use strict';

const fs = require('fs');
const path = require('path');
const locate = require('../vault/locate');
const { assertSafeOutputDir } = require('../build/plan');
const { THEMES, INIT_DEFAULT_THEME, loadTheme } = require('../build/themes');
const { loadPackToml } = require('../build/packtoml');
const { loadPackConfig } = require('../cli/check');
const { paletteScheme } = require('../checks/themescheme');
const { packDirFor } = require('../vault/packwrite');
const { ScriptoriumError, VaultUnreachableError } = require('../util/errors');
const { validateName, validateTitle, validateTheme } = require('./validate');
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

async function checkVault(value, { name = '', commit = false } = {}, deps = {}) {
  const typed = typedPath(value);
  if (typed.relative) return result('vault', 'bad', typed.clean, RELATIVE_RULE, vaultFacts({}));
  if (typed.unc && commit !== true) return result('vault', 'deferred', typed.clean, null, vaultFacts({ unc: true }));

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

async function checkOutput(value, { vault = '', name = '', commit = false } = {}, deps = {}) {
  const baseFacts = { default: null, inside: false, nonEmptyForeign: false };
  if (typeof vault !== 'string' || vault === '') return result('output', 'bad', '', NEED_VAULT_RULE, baseFacts);
  const facts = { ...baseFacts, default: defaultOutputFor(vault, name) };

  const typed = typedPath(value);
  if (typed.relative) return result('output', 'bad', typed.clean, RELATIVE_RULE, facts);
  if (typed.unc && commit !== true) return result('output', 'deferred', typed.clean, null, facts);

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
  return result('output', 'ok', typed.abs, null, facts);
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

module.exports = { checkName, checkVault, checkOutput, checkTitle, checkTheme, suggestSlug, RELATIVE_RULE, NEED_VAULT_RULE };
