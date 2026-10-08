'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./args');
const { addCampaign, assertConfigPathNotInVault } = require('../config/write');
const { writeConfigFile } = require('./config');
const { loadPackConfig, runCheckCommand: runCheckCommandImpl } = require('./check');
const { loadPackToml } = require('../build/packtoml');
const { THEMES, INIT_DEFAULT_THEME } = require('../build/themes');
const { locateVault } = require('../vault/locate');
const { assertSafeOutputDir } = require('../build/plan');
const { packDirFor, createPackEntries } = require('../vault/packwrite');
const { inspectTarget, createVault } = require('../vault/vaultcreate');
const { remotePaths } = require('../remote/paths');
const { createPrompter } = require('./prompt');
const read = require('../vault/read');
const { packShadowedMessage } = require('../checks/configdiv');
const { ConfigError, ScriptoriumError, VaultUnreachableError } = require('../util/errors');
const { NAME_RE, validateName, validateTheme, validateTitle, validateSystem, validateStarterTitle, composePackToml } = require('../setup/validate');
const template = require('../setup/template');
const { underOneDrive } = require('../setup/checks');
const {
  SCAFFOLD,
  defaultOutputFor,
  defaultTitleFor,
  composeVaultConfigJson,
  scaffoldEntries,
  isNonEmptyForeignOutput,
  nonEmptyOutputWarning,
  nonEmptyOutputRefusal,
  cleanPathAnswer,
} = require('../setup/scaffold');

/*
 * ADR 0021: the first-run setup wizard. `bin` stays thin (Structural
 * decision 10). The no-argument offer this file once held, and its pause, were replaced by launch
 * mode (src/cli/launch.js, ADR 0028); `init` itself is unchanged.
 *
 * Every vault write goes through src/vault/packwrite.js (the create-only
 * chokepoint) or, for a new campaign (docs/decisions/0048-new-campaign-vault.md), through
 * src/vault/vaultcreate.js; this module and src/cli/prompt.js are structurally
 * write-free (test/pack-write.test.js's PW15).
 */

const BANNER_LINE_1 = 'GM-Scriptorium campaign setup';
const BANNER_LINE_2 =
  'This creates new files under <vault>/_meta/scriptorium/ only. Nothing else in the vault is changed, and no existing file is overwritten.';

const NEW_CAMPAIGN_LINE = 'Starting a new campaign: this first creates the vault itself, in a new or empty folder. Nothing is overwritten or removed.';

function displayEntry(entry) {
  return entry.kind === 'dir' ? `${entry.rel}/` : entry.rel;
}

function dSuffix(value) {
  return value !== undefined && value !== null && value !== '' ? ` [${value}]` : '';
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
  for (const flag of ['name', 'vault', 'out', 'title', 'theme', 'new-vault', 'system']) {
    if (flags[flag] === true) {
      throw new ConfigError(`--${flag} needs a value`);
    }
  }
  if (flags['new-vault'] !== undefined && flags.vault !== undefined) {
    throw new ConfigError('init takes --vault or --new-vault, not both');
  }
  if (flags.system !== undefined && flags['new-vault'] === undefined) {
    throw new ConfigError('--system only applies with --new-vault');
  }
  if (flags.yes && flags['new-vault'] !== undefined) {
    if (!flags.name) throw new ConfigError('init --yes --new-vault needs --name <name>');
    if (flags.system === undefined) throw new ConfigError('init --yes --new-vault needs --system <id> or --system none');
  } else if (flags.yes && (!flags.name || !flags.vault)) {
    throw new ConfigError('init --yes needs --name <name> and --vault <path>');
  }
  if (flags.name !== undefined) validateName(flags.name);
  if (flags.theme !== undefined) validateTheme(flags.theme, registry);
  if (flags.title !== undefined) validateTitle(flags.title);
}

function abortError() {
  return new ConfigError('init aborted; nothing written');
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
    now = () => new Date(),
    env = process.env,
    templateDir,
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

  /** A1: a non-empty foreign output folder is confirmed interactively or refused under --yes/flags. */
  async function guardNonEmptyForeignOutput(outAbs) {
    if (!isNonEmptyForeignOutput(outAbs)) return;
    if (flags.yes) {
      throw new ConfigError(nonEmptyOutputRefusal(outAbs));
    }
    emit(nonEmptyOutputWarning(outAbs));
    const proceed = await askYesNo('Continue with this output folder? [y/N]: ', false);
    if (!proceed) throw abortError();
  }

  /** Step 3 of the existing-vault flow and step 5 of the new-vault flow: where the built site goes. */
  async function chooseOutput(vaultAbs, name, existing) {
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
    return outAbs;
  }

  /** Step 5 of the existing-vault flow and the last question of the new-vault flow: the theme. */
  async function chooseTheme(packDir, name) {
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
    return theme;
  }

  /** Step 7: register, then offer a first check. Shared by both flows. */
  async function finishRegistration({ configPath, config, next, name, packDir }) {
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
  }

  /**
   * The new-campaign flow (docs/decisions/0048-new-campaign-vault.md, section 5): name (already
   * asked), new folder, title, game system, output, theme, one confirmation, then the vault, the
   * pack and the registration, in that order. Nothing is written before the confirmation.
   */
  async function runNewCampaign({ configPath, config, name }) {
    if (config.campaigns && config.campaigns[name]) {
      throw new ConfigError(`campaign "${name}" is already registered, so a new vault cannot be made for it; choose another name`);
    }
    const guard = { configPath, panelDir: remotePaths(configPath).panelDir, campaign: name };
    emit(NEW_CAMPAIGN_LINE);

    // --- the new folder (a folder problem is a vault problem: exit 3) ---------------------
    let vaultAbs;
    let target;
    if (flags['new-vault'] !== undefined) {
      vaultAbs = path.resolve(flags['new-vault']);
      target = inspectTarget(vaultAbs, guard);
    } else {
      for (;;) {
        const answer = await getPrompter().ask('New vault folder (a new or empty folder): ');
        if (answer === null) throw abortError();
        if (answer.trim() === '') {
          emit('  enter the full path of a new or empty folder');
          continue;
        }
        const candidate = cleanPathAnswer(answer);
        try {
          target = inspectTarget(candidate, guard);
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

    // --- the starter this build carries -----------------------------------------------------
    const tpl = template.loadTemplate({ dir: templateDir });
    const systems = template.starterSystems(tpl);

    // --- title ------------------------------------------------------------------------------
    let title;
    if (flags.title !== undefined) {
      title = validateStarterTitle(flags.title);
      template.assertTitleReadsBack(tpl, title);
    } else if (flags.yes) {
      title = validateStarterTitle(name);
    } else {
      for (;;) {
        const answer = await getPrompter().ask(`Site title${dSuffix(name)}: `);
        if (answer === null) throw abortError();
        try {
          title = validateStarterTitle(answer.trim() === '' ? name : answer);
          template.assertTitleReadsBack(tpl, title);
          break;
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          emit(`  ${err.message}`);
        }
      }
    }

    // --- game system (never guessed) ---------------------------------------------------------
    let system;
    if (flags.system !== undefined) {
      system = validateSystem(flags.system, systems);
    } else {
      for (;;) {
        const answer = await getPrompter().ask(`Game system (${[...systems, 'none'].join(', ')}): `);
        if (answer === null) throw abortError();
        try {
          system = validateSystem(answer.trim(), systems);
          break;
        } catch (err) {
          emit(`  ${err.message}`);
        }
      }
    }

    const packDir = packDirFor(vaultAbs);
    const outAbs = await chooseOutput(vaultAbs, name, null);
    const theme = await chooseTheme(packDir, name);

    const next = addCampaign(config, name, { vault: vaultAbs, output: outAbs });
    assertConfigPathNotInVault(configPath, next);
    const starter = template.renderStarter(tpl, { system, title, created: template.localDate(now()) });
    const counts = `${starter.dirs.length} folders, ${starter.files.length} files, game system ${system}`;

    if (underOneDrive(vaultAbs, env)) {
      emit('note: this folder is under OneDrive, which may sync the new files while they are being created');
    }
    if (!flags.yes) {
      if (target.missingAncestors.length > 0) {
        emit(`These folders do not exist yet and will be created first: ${target.missingAncestors.join(', ')}`);
      }
      const proceed = await askYesNo(
        `Create a new vault at ${vaultAbs} (${counts}) and ${SCAFFOLD.map(displayEntry).join(', ')} in ${packDir}? [Y/n]: `,
        true,
      );
      if (!proceed) throw abortError();
    }

    // --- the vault, then the pack, then the registration ---------------------------------------
    const made = createVault(vaultAbs, starter, guard);
    emit(`created the new vault at ${made.root}: ${counts}`);
    if (made.createdAncestors.length > 0) emit(`also created the folders above it: ${made.createdAncestors.join(', ')}`);
    let packResult;
    try {
      packResult = createPackEntries(vaultAbs, scaffoldEntries(vaultAbs, SCAFFOLD, { title, theme }), { campaign: name });
    } catch (err) {
      if (!(err instanceof ScriptoriumError)) throw err;
      throw new ScriptoriumError(`${err.message.replace(/\.$/, '')}. The new vault at ${vaultAbs} was created and is left as it is.`, {
        path: err.path,
        campaign: name,
        cause: err,
      });
    }
    emit(`created in ${packResult.packDir}: ${packResult.created.join(', ')}`);
    return await finishRegistration({ configPath, config, next, name, packDir });
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

    // --- Step 1b: an existing vault, or a new campaign (ADR 0048) --------------------------
    let startNew = flags['new-vault'] !== undefined;
    // Only at a terminal: scripted standard input keeps its old shape, and a script says --new-vault.
    if (!startNew && flags.vault === undefined && !flags.yes && input && input.isTTY === true) {
      const hasVault = await askYesNo('Do you already have a vault? [Y/n]: ', true);
      if (hasVault === null) throw abortError();
      startNew = !hasVault;
    }
    if (startNew) return await runNewCampaign({ configPath, config, name });

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

    const outAbs = await chooseOutput(vaultAbs, name, existing);

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

    const theme = await chooseTheme(packDir, name);

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
      const entries = scaffoldEntries(vaultAbs, missing, { title, theme });
      const result = createPackEntries(vaultAbs, entries, { campaign: name });
      emit(`created in ${result.packDir}: ${result.created.join(', ')}`);
    }

    return await finishRegistration({ configPath, config, next, name, packDir });
  } finally {
    if (ownPrompter) ownPrompter.close();
  }
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
  runInitCommand,
};
