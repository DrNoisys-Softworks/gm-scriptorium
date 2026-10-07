'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./args');
const { resolveConfigPath } = require('../config/location');
const { addCampaign, assertConfigPathNotInVault } = require('../config/write');
const { writeConfigFile } = require('./config');
const { loadPackConfig, runCheckCommand: runCheckCommandImpl } = require('./check');
const { loadPackToml } = require('../build/packtoml');
const { THEMES, INIT_DEFAULT_THEME } = require('../build/themes');
const { locateVault } = require('../vault/locate');
const { assertSafeOutputDir } = require('../build/plan');
const { packDirFor, createPackEntries } = require('../vault/packwrite');
const { createPrompter } = require('./prompt');
const read = require('../vault/read');
const pinned = require('../generator/pinned');
const { packShadowedMessage } = require('../checks/configdiv');
const { ConfigError, ScriptoriumError, VaultUnreachableError } = require('../util/errors');
const { deriveFolderMapAdditions } = require('../setup/foldermap');
const { NAME_RE, validateName, validateTheme, validateTitle, composePackToml } = require('../setup/validate');

/*
 * ADR 0021: the first-run setup wizard. `bin` stays thin (Structural
 * decision 10): the offer and the pause live here, and `bin` only gains
 * `reportError`, moved unchanged from its existing catch body.
 *
 * Every vault write goes through src/vault/packwrite.js (the create-only
 * chokepoint); this module and src/cli/prompt.js are structurally
 * write-free (test/pack-write.test.js's PW15).
 */

const SCAFFOLD = Object.freeze([
  { rel: 'css', kind: 'dir' },
  { rel: 'images', kind: 'dir' },
  { rel: 'pack.toml', kind: 'file' },
  { rel: 'vault.config.json', kind: 'file' },
]);

const BANNER_LINE_1 = 'GM-Scriptorium campaign setup';
const BANNER_LINE_2 =
  'This creates new files under <vault>/_meta/scriptorium/ only. Nothing else in the vault is changed, and no existing file is overwritten.';

function displayEntry(entry) {
  return entry.kind === 'dir' ? `${entry.rel}/` : entry.rel;
}

function dSuffix(value) {
  return value !== undefined && value !== null && value !== '' ? ` [${value}]` : '';
}

/** D-02: never "out", always a sibling of the vault named after the campaign. */
function defaultOutputFor(vaultAbs, name) {
  return path.join(path.dirname(vaultAbs), `${name}-site`);
}

/** vault-config.md's `campaign` frontmatter, if it's a non-empty string once trimmed; otherwise the name. */
function defaultTitleFor(vaultAbs, name) {
  const configPath = path.join(vaultAbs, '_meta', 'vault-config.md');
  const result = read.readFrontmatter(configPath);
  if (result.ok && typeof result.data.campaign === 'string' && result.data.campaign.trim().length > 0) {
    return result.data.campaign.trim();
  }
  return name;
}

/**
 * Stopgap, publish-v1.12.0 repin. Up to publish-v1.11.44 the pin's vault.config.json template
 * carried these campaign settings and a new pack inherited them from it. At publish-v1.12.0 the
 * pin moved them to `publish:` in _meta/vault-config.md and its template shrank to deploy keys.
 * `init` writes only under <vault>/_meta/scriptorium/, and src/vault/packconfig's shape check
 * requires excludeDirs and folderMap in the pack's own file, so a new pack still gets them here,
 * in their old JSON spelling and with the values the 1.11.44 template had. The pin reads them
 * as a fallback and warns on every build that they have moved; it plans to drop that fallback at
 * plugin 1.11.0. Whether `init` should write `publish:` in the vault file instead is an open
 * owner decision (docs/decisions/0005-generator-pin.md, publish-v1.12.0 addendum).
 */
const LEGACY_SCAFFOLD_SETTINGS = {
  landingTagline: '',
  attachmentsDir: '_attachments',
  folderMap: {
    'Characters/PCs': 'characters/pcs',
    'Characters/NPCs': 'characters/npcs',
    Locations: 'locations',
    'Factions & Organizations': 'factions',
    'Items & Artifacts': 'items',
    Creatures: 'creatures',
    Events: 'events',
    Documents: 'documents',
    Clues: 'clues',
    Chapters: 'chapters',
    _Campaign: 'campaign',
    _World: 'world',
    Heritages: 'heritages',
  },
  excludeDirs: ['_meta', '_Templates', '_resources'],
  excludeSections: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'],
  excludeCallouts: true,
  backend: { statusBar: false, inbox: false },
};

/**
 * SD-6: parse the template, delete vaultPath/outputDir/siteUrl (pack-relative
 * inputs a pack resolves itself, and a 404-page basePath this scaffold has
 * no opinion on), set siteTitle, add LEGACY_SCAFFOLD_SETTINGS for any key the
 * template does not carry itself, then serialise. A leftover `{{NAME}}`
 * placeholder anywhere else in the template is a packaging defect, not a
 * silently-shipped literal.
 *
 * @throws {ScriptoriumError} I-TEMPLATE
 */
function composeVaultConfigJson(templateText, title, extraFolderMap = {}) {
  const fail = (reason) => {
    throw new ScriptoriumError(`the generator's vault.config.json template ${reason}`);
  };

  let obj;
  try {
    obj = JSON.parse(templateText);
  } catch (err) {
    fail(`is not valid JSON: ${err.message}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    fail('is not a JSON object');
  }

  delete obj.vaultPath;
  delete obj.outputDir;
  delete obj.siteUrl;
  obj.siteTitle = title;

  const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/;
  function checkNoPlaceholder(value) {
    if (typeof value === 'string') {
      const m = value.match(PLACEHOLDER_RE);
      if (m) fail(`still contains the placeholder ${m[0]}`);
    } else if (Array.isArray(value)) {
      value.forEach(checkNoPlaceholder);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) checkNoPlaceholder(v);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'siteTitle') continue; // the guard must ignore siteTitle: the GM's own title may contain "{{"
    checkNoPlaceholder(value);
  }

  // Key order is the 1.11.44 template's own, so a pack scaffolded at this pin is byte-identical to
  // one scaffolded before it. A template key always wins over the stopgap default.
  const { host, siteTitle, ...rest } = obj;
  const { landingTagline, ...legacy } = LEGACY_SCAFFOLD_SETTINGS;
  const out = { siteTitle, landingTagline, ...(host !== undefined ? { host } : {}), ...structuredClone(legacy), ...rest };
  // Added after the stopgap, not on the template object: at this pin the template has no folderMap,
  // and one set there would replace the stopgap's whole map through `...rest`.
  if (Object.keys(extraFolderMap).length > 0) out.folderMap = { ...(out.folderMap || {}), ...extraFolderMap };

  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * @param {{ positional: string[], flags: object, stdinIsTTY: boolean, stdoutIsTTY: boolean, exists?: (p: string) => boolean }} opts
 * @returns {boolean}
 */
function shouldOfferInit({ positional, flags, stdinIsTTY, stdoutIsTTY, exists = fs.existsSync }) {
  if (positional.length !== 0) return false;
  if (flags.help || flags.version || flags.notices) return false;
  if (flags.config !== undefined && typeof flags.config !== 'string') return false;
  const configPath = resolveConfigPath({ cliConfigPath: flags.config });
  if (exists(configPath)) return false;
  return Boolean(stdinIsTTY && stdoutIsTTY);
}

/** SD-12: format checks that run before the banner and before any prompt. @throws {ConfigError} */
function runUpFrontChecks(flags, positional, registry) {
  if (positional.length > 0) {
    throw new ConfigError(`init takes no positional argument (got "${positional[0]}"); use --name <name>`);
  }
  for (const flag of ['campaign', 'site-config', 'json']) {
    if (flags[flag] !== undefined) {
      throw new ConfigError(`init does not accept --${flag}`);
    }
  }
  for (const flag of ['name', 'vault', 'out', 'title', 'theme']) {
    if (flags[flag] === true) {
      throw new ConfigError(`--${flag} needs a value`);
    }
  }
  if (flags.yes && (!flags.name || !flags.vault)) {
    throw new ConfigError('init --yes needs --name <name> and --vault <path>');
  }
  if (flags.name !== undefined) validateName(flags.name);
  if (flags.theme !== undefined) validateTheme(flags.theme, registry);
  if (flags.title !== undefined) validateTitle(flags.title);
}

function abortError() {
  return new ConfigError('init aborted; nothing written');
}

/** A1 (orchestrator addendum): a folder that exists, is non-empty, and does not look like a previous build. */
function looksLikePreviousBuild(outAbs) {
  return fs.existsSync(path.join(outAbs, 'index.html')) && fs.existsSync(path.join(outAbs, 'css', 'scriptorium.css'));
}

function isNonEmptyForeignOutput(outAbs) {
  if (!fs.existsSync(outAbs)) return false;
  let entries;
  try {
    entries = fs.readdirSync(outAbs);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return !looksLikePreviousBuild(outAbs);
}

/**
 * @param {string} vaultAbs
 * @param {string[] | []} positional
 * @param {object} [opts]
 * @returns {{ exitCode: 0 }}
 */
async function runInitCommand(
  flags,
  positional = [],
  {
    input = process.stdin,
    output = process.stdout,
    signals = process,
    prompter: injectedPrompter = null,
    registry = THEMES,
    runCheck = runCheckCommandImpl,
  } = {},
) {
  runUpFrontChecks(flags, positional, registry);

  const emit = (line) => output.write(`${line}\n`);

  let ownPrompter = null;
  function getPrompter() {
    if (injectedPrompter) return injectedPrompter;
    if (!ownPrompter) ownPrompter = createPrompter({ input, output, signals });
    return ownPrompter;
  }

  async function askYesNo(question, defaultYes) {
    const p = getPrompter();
    for (;;) {
      const answer = await p.ask(question);
      if (answer === null) return null;
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') return defaultYes;
      if (trimmed === 'y' || trimmed === 'yes') return true;
      if (trimmed === 'n' || trimmed === 'no') return false;
      emit('  please answer y or n');
    }
  }

  function cleanPathAnswer(raw) {
    let s = raw.trim();
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return path.resolve(s);
  }

  /** A1: a non-empty foreign output folder is confirmed interactively or refused under --yes/flags. */
  async function guardNonEmptyForeignOutput(outAbs) {
    if (!isNonEmptyForeignOutput(outAbs)) return;
    if (flags.yes) {
      throw new ConfigError(
        `refusing to use ${outAbs} as the output folder: it exists and is not empty and does not look like a ` +
          'previous build; choose an empty or new folder',
      );
    }
    emit(`warning: ${outAbs} exists and is not empty; the first build will replace its contents`);
    const proceed = await askYesNo('Continue with this output folder? [y/N]: ', false);
    if (!proceed) throw abortError();
  }

  try {
    const { configPath, config } = loadConfig(flags);

    emit(BANNER_LINE_1);
    emit(BANNER_LINE_2);

    // --- Step 1: name -------------------------------------------------
    let name;
    if (flags.name !== undefined) {
      name = flags.name;
    } else {
      for (;;) {
        const answer = await getPrompter().ask('Campaign name (lowercase letters, digits and hyphens): ');
        if (answer === null) throw abortError();
        try {
          name = validateName(answer.trim());
          break;
        } catch (err) {
          emit(`  ${err.message}`);
        }
      }
    }
    const existing = (config.campaigns && config.campaigns[name]) || null;

    // --- Step 2: vault --------------------------------------------------
    let vaultAbs;
    const existingVaultDefault = existing && typeof existing.vault === 'string' ? existing.vault : undefined;
    if (flags.vault !== undefined) {
      vaultAbs = path.resolve(flags.vault);
      locateVault(vaultAbs, name);
    } else {
      for (;;) {
        const answer = await getPrompter().ask(
          `Vault folder (the one holding _meta/vault-config.md)${dSuffix(existingVaultDefault)}: `,
        );
        if (answer === null) throw abortError();
        const trimmedAnswer = answer.trim();
        const chosenRaw = trimmedAnswer === '' && existingVaultDefault !== undefined ? existingVaultDefault : answer;
        let candidate;
        try {
          candidate = cleanPathAnswer(chosenRaw);
          locateVault(candidate, name);
        } catch (err) {
          if (err instanceof VaultUnreachableError) {
            emit(`  ${err.message}`);
            continue;
          }
          throw err;
        }
        vaultAbs = candidate;
        break;
      }
    }

    const packDir = packDirFor(vaultAbs);
    const packDirStat = read.statOrNull(packDir);
    if (packDirStat && !packDirStat.isDirectory()) {
      throw new ConfigError(`refusing to write the campaign pack: ${packDir} exists and is not a folder`);
    }

    // --- Step 3: output ---------------------------------------------------
    let outAbs;
    const existingOutputDefault = existing && typeof existing.output === 'string' ? existing.output : undefined;
    const computedDefaultOutput =
      existingOutputDefault !== undefined ? existingOutputDefault : defaultOutputFor(vaultAbs, name);
    if (flags.out !== undefined) {
      outAbs = path.resolve(flags.out);
      assertSafeOutputDir(vaultAbs, outAbs);
    } else if (flags.yes) {
      outAbs = path.resolve(computedDefaultOutput);
      assertSafeOutputDir(vaultAbs, outAbs);
    } else {
      for (;;) {
        const answer = await getPrompter().ask(
          `Output folder for the built site${dSuffix(computedDefaultOutput)}: `,
        );
        if (answer === null) throw abortError();
        const trimmedAnswer = answer.trim();
        const chosenRaw = trimmedAnswer === '' ? computedDefaultOutput : answer;
        let candidate;
        try {
          candidate = cleanPathAnswer(chosenRaw);
          assertSafeOutputDir(vaultAbs, candidate);
        } catch (err) {
          if (err instanceof ScriptoriumError) {
            emit(`  ${err.message}`);
            continue;
          }
          throw err;
        }
        outAbs = candidate;
        break;
      }
    }
    await guardNonEmptyForeignOutput(outAbs);

    // --- Step 4: title ------------------------------------------------
    const jsonPath = path.join(packDir, 'vault.config.json');
    let title;
    if (fs.existsSync(jsonPath)) {
      const existingJson = loadPackConfig(jsonPath, name);
      const existingTitle = existingJson.siteTitle;
      if (flags.title !== undefined && flags.title !== existingTitle) {
        throw new ConfigError(
          `--title "${flags.title}" differs from the siteTitle in ${jsonPath} (${JSON.stringify(existingTitle ?? null)}); ` +
            'init never edits existing pack files, so edit that file instead',
        );
      }
      title = existingTitle;
      const titleDisplay = existingTitle === undefined || existingTitle === null ? '(not set)' : JSON.stringify(existingTitle);
      emit(`site title: ${titleDisplay} (from ${jsonPath}; init never edits it, edit that file to change it)`);
    } else {
      const defaultTitle = defaultTitleFor(vaultAbs, name);
      if (flags.title !== undefined) {
        title = validateTitle(flags.title);
      } else if (flags.yes) {
        title = defaultTitle;
      } else {
        for (;;) {
          const answer = await getPrompter().ask(`Site title${dSuffix(defaultTitle)}: `);
          if (answer === null) throw abortError();
          const trimmedAnswer = answer.trim();
          try {
            title = trimmedAnswer === '' ? defaultTitle : validateTitle(answer);
            break;
          } catch (err) {
            emit(`  ${err.message}`);
          }
        }
      }
    }

    // --- Step 5: theme --------------------------------------------------
    const tomlPath = path.join(packDir, 'pack.toml');
    let theme;
    if (fs.existsSync(tomlPath)) {
      const loaded = loadPackToml(packDir, { campaign: name, registry });
      const existingTheme = loaded.theme;
      if (flags.theme !== undefined && flags.theme !== existingTheme) {
        throw new ConfigError(
          `--theme "${flags.theme}" differs from the theme in ${tomlPath} ("${existingTheme}"); init never edits ` +
            'existing pack files, so edit that file instead',
        );
      }
      theme = existingTheme;
      emit(`theme: ${theme} (from ${tomlPath}; init never edits it, edit that file to change it)`);
      for (const w of loaded.warnings) emit(`warning: ${w}`);
    } else if (flags.theme !== undefined) {
      theme = validateTheme(flags.theme, registry);
    } else if (flags.yes) {
      theme = INIT_DEFAULT_THEME;
    } else {
      const names = Object.keys(registry).sort().join(', ');
      for (;;) {
        const answer = await getPrompter().ask(`Theme (${names})${dSuffix(INIT_DEFAULT_THEME)}: `);
        if (answer === null) throw abortError();
        const trimmedAnswer = answer.trim();
        try {
          theme = trimmedAnswer === '' ? INIT_DEFAULT_THEME : validateTheme(trimmedAnswer, registry);
          break;
        } catch (err) {
          emit(`  ${err.message}`);
        }
      }
    }

    // --- Step 6: scaffold -------------------------------------------------
    const next = addCampaign(config, name, { vault: vaultAbs, output: outAbs });
    assertConfigPathNotInVault(configPath, next);

    const missing = SCAFFOLD.filter((entry) => !fs.existsSync(path.join(packDir, entry.rel)));
    const untouched = SCAFFOLD.filter((entry) => fs.existsSync(path.join(packDir, entry.rel)));
    if (untouched.length > 0) {
      emit(`left untouched: ${untouched.map(displayEntry).join(', ')}`);
    }
    if (missing.length > 0) {
      if (!flags.yes) {
        const list = missing.map(displayEntry).join(', ');
        const proceed = await askYesNo(`Create ${list} in ${packDir}? [Y/n]: `, true);
        if (!proceed) throw abortError();
      }
      const entries = missing.map((entry) => {
        if (entry.kind === 'dir') return { rel: entry.rel, kind: 'dir' };
        if (entry.rel === 'pack.toml') return { rel: entry.rel, kind: 'file', data: composePackToml(theme) };
        const templateText = pinned.readVaultConfigTemplate();
        // Issue #103: the scaffold template maps no Sessions folder and no folder of this vault's
        // own, so add what the vault actually has; otherwise those pages are dropped silently.
        const base = JSON.parse(composeVaultConfigJson(templateText, title));
        const extra = deriveFolderMapAdditions(vaultAbs, base);
        return { rel: entry.rel, kind: 'file', data: composeVaultConfigJson(templateText, title, extra) };
      });
      const result = createPackEntries(vaultAbs, entries, { campaign: name });
      emit(`created in ${result.packDir}: ${result.created.join(', ')}`);
    }

    // --- Step 7: register, then offer a first check -----------------------
    writeConfigFile(configPath, next);
    const wasDefaultSet = !config.default_campaign && next.default_campaign === name;
    emit(`registered campaign "${name}" in ${configPath}${wasDefaultSet ? ' (now the default campaign)' : ''}`);

    const base = next.campaigns[name];
    const hasBaseSiteConfig = typeof base.site_config === 'string' && base.site_config.length > 0;
    const hasBasePackKey = typeof base.pack === 'string' && base.pack.length > 0;
    if (hasBaseSiteConfig) {
      emit(
        `note: ${packShadowedMessage({ siteConfigPath: path.resolve(base.site_config), packDir })} (init left site_config in place)`,
      );
    } else if (hasBasePackKey) {
      emit(
        `note: the pack key ${path.resolve(base.pack)} is in use, so the campaign pack at ${packDir} is ignored; remove the pack key to use it`,
      );
    }

    if (!flags.yes) {
      const proceed = await askYesNo('Run a first check now? [Y/n]: ', true);
      if (proceed) {
        try {
          const result = runCheck({ config: configPath }, name);
          emit(result.human);
        } catch (err) {
          if (err instanceof ScriptoriumError) {
            emit(`check could not run: ${err.message}`);
          } else {
            emit(err.stack);
          }
        }
      }
    }

    emit(`next: run "check ${name}", then "build ${name}"`);
    return { exitCode: 0 };
  } finally {
    if (ownPrompter) ownPrompter.close();
  }
}

/**
 * The TTY-only no-argument offer (D-05). Waits for Enter before returning,
 * whatever the outcome, so a Windows double-click's console window does
 * not flash and close.
 *
 * @returns {Promise<number>}
 */
async function runInitOffer(flags, { help, reportError, input = process.stdin, output = process.stdout, signals = process }) {
  const prompter = createPrompter({ input, output, signals });
  let code = 0;
  try {
    prompter.say(BANNER_LINE_1);
    prompter.say(BANNER_LINE_2);
    const configPath = resolveConfigPath({ cliConfigPath: flags.config });
    const answer = await prompter.ask(`No GM-Scriptorium config file at ${configPath}. Set up a campaign now? [Y/n]: `);
    const wantsInit = answer !== null && (answer.trim() === '' || /^y(es)?$/i.test(answer.trim()));
    if (!wantsInit) {
      output.write(help);
    } else {
      try {
        const result = await runInitCommand(flags, [], { input, output, signals, prompter });
        code = result.exitCode;
      } catch (err) {
        code = reportError(err);
      }
    }
  } finally {
    await prompter.ask('Press Enter to close this window.\n');
    prompter.close();
  }
  return code;
}

module.exports = {
  NAME_RE,
  SCAFFOLD,
  validateName,
  validateTheme,
  validateTitle,
  defaultOutputFor,
  defaultTitleFor,
  composePackToml,
  composeVaultConfigJson,
  shouldOfferInit,
  runInitCommand,
  runInitOffer,
};
