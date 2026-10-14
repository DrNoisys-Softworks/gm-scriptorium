#!/usr/bin/env node
'use strict';

const { parseArgv, validateFlags } = require('../src/cli/args');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { VaultUnreachableError, ConfigError, UpdatePrerequisiteError, ScriptoriumError } = require('../src/util/errors');
const pkg = require('../package.json');

/*
 * argv, dispatch, exit codes. No logic: every command's actual behaviour
 * lives in src/cli/<command>.js.
 */

const HELP = `gm-scriptorium <command> [campaign] [flags]

Commands:
  init     [--name <name>] [--vault <path>] [--out <path>] [--title <text>] [--theme <name>] [--yes]
           init --new-vault <path> --system <id|none> [--name <name>] [--title <text>] [--out <path>] [--theme <name>] [--yes]
  check    [campaign] [--graph] [--json] [--no-color]
  build    [campaign] [--no-check] [--force-check] [--force-out] [--out <path>] [--json]
  serve    [campaign] [--build] [--port N] [--host ADDR] | [campaign] --admin [--port N] [--preview-port N]
  remote   show | set [--mode local|ssh|tailscale|proxy] [--admin-url URL] [--preview-url URL] [--bind ADDR]
           [--trusted-proxy ADDR,...] [--port N] [--preview-port N] | account add|change|reset|remove|rename|list
           | password | signout-all [--account NAME] | off
  desktop  set [--port N] [--preview-port N]
           (the ports the Windows desktop app uses; defaults 7400 and 7401)
  status   [campaign] [--json]
  config   list | add <name> --vault <path> [--out <path>] [--site-config <path>] | remove <name> | set-default <name> | path | edit
  update   [--check] [--pre] [--version TAG]

Global flags: --campaign <name>, --config <path>, --json, --no-color, --version, --help,
  --notices, --vault <path>, --out <path>, --site-config <path>
  (--vault/--out/--site-config override the registered campaign's paths for that one run only,
  never persisted. check/build/status read all three; serve only reads --vault/--out (it never
  reads the site config). To change a path for good, use "config add" or "config edit".)

Run "gm-scriptorium <command> --help" for what one command does and the exit codes it can return.
Run "gm-scriptorium" with no command in a terminal to open the panel in your browser.
`;

/** The existing catch body, moved unchanged (ADR 0021, Structural decision 10): the main catch
 * and launch mode (ADR 0028) both call this, so there is exactly one exit mapping. */
function reportError(err) {
  if (err instanceof VaultUnreachableError) {
    console.error(err.message);
    return EXIT_CODES.VAULT_UNREACHABLE;
  }
  if (err instanceof UpdatePrerequisiteError) {
    console.error(err.message);
    return EXIT_CODES.UPDATE_PREREQUISITE;
  }
  if (err instanceof ConfigError || err instanceof ScriptoriumError) {
    console.error(err.message);
    return EXIT_CODES.SCRIPTORIUM_ERROR;
  }
  console.error(err.stack || String(err));
  return EXIT_CODES.SCRIPTORIUM_ERROR;
}

async function main() {
  const argv = process.argv.slice(2);
  const { _: positional, flags } = parseArgv(argv);

  if (flags.version && positional[0] !== 'update') {
    const { noticesLine } = require('../src/util/notices');
    console.log(pkg.version);
    console.log(noticesLine());
    return EXIT_CODES.OK;
  }
  if (flags.notices) {
    const { getNoticesText } = require('../src/util/notices');
    console.log(getNoticesText());
    return EXIT_CODES.OK;
  }
  // ADR 0028: with no command in a terminal (a typed command or a double-click, which look the same),
  // the panel opens in the browser. This replaces ADR 0021's no-argument offer.
  const { shouldLaunch, runLaunch } = require('../src/cli/launch');
  if (shouldLaunch({ positional, flags, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY) })) {
    // ADR 0057, section 10: on an installed Windows copy the background app is started (or reused)
    // instead of a console panel. null means the hand-off does not apply, or nothing was started.
    const handedOff = await require('../src/desktop/handoff').runBareHandoff(flags);
    if (handedOff !== null) return handedOff;
    return runLaunch(flags, { reportError, version: pkg.version });
  }
  if (flags.help && positional.length > 0) {
    const text = require('../src/cli/help').commandHelp(positional[0], positional[1]);
    if (text) {
      console.log(text);
      return EXIT_CODES.OK;
    }
  }
  if (flags.help || positional.length === 0) {
    console.log(HELP);
    return EXIT_CODES.OK;
  }

  const [command, ...rest] = positional;

  try {
    validateFlags(command, flags);
    switch (command) {
      case 'init': {
        const { runInitCommand } = require('../src/cli/init');
        return (await runInitCommand(flags, rest)).exitCode;
      }
      case 'check': {
        const { runCheckCommand } = require('../src/cli/check');
        const result = runCheckCommand(flags, rest[0]);
        console.log(flags.json ? JSON.stringify(result.envelope, null, 2) : result.human);
        return result.exitCode;
      }
      case 'build': {
        const { runBuildCommand } = require('../src/cli/build');
        const result = runBuildCommand(flags, rest[0]);
        console.log(flags.json ? JSON.stringify(result.envelope, null, 2) : result.human);
        return result.exitCode;
      }
      case 'serve': {
        const { runServeCommand } = require('../src/cli/serve');
        const result = await runServeCommand(flags, rest[0]);
        // Issue #27: --json emits compact NDJSON (the readiness line is printed by serve itself).
        if (flags.json && result.envelope) console.log(JSON.stringify(result.envelope));
        else if (flags.json && result.human) {
          console.log(JSON.stringify({ event: result.exitCode === 0 ? 'message' : 'error', message: result.human }));
        } else if (result.human) console.log(result.human);
        return result.exitCode;
      }
      case 'status': {
        const { runStatusCommand } = require('../src/cli/status');
        const result = runStatusCommand(flags, rest[0]);
        console.log(flags.json ? JSON.stringify(result.envelope, null, 2) : result.human);
        return result.exitCode;
      }
      case 'config': {
        const { runConfigCommand } = require('../src/cli/config');
        const [subcommand, ...subArgs] = rest;
        const result = runConfigCommand(flags, subcommand, subArgs);
        if (result.human) console.log(result.human);
        return result.exitCode;
      }
      case 'remote': {
        const { runRemoteCommand } = require('../src/cli/remote');
        const [subcommand, ...subArgs] = rest;
        const result = await runRemoteCommand(flags, subcommand, subArgs, { panelAccess: { env: process.env } });
        if (result.human) console.log(result.human);
        return result.exitCode;
      }
      case 'desktop': {
        const { runDesktopCommand } = require('../src/cli/desktop');
        const [subcommand, ...subArgs] = rest;
        const result = await runDesktopCommand(flags, subcommand, subArgs);
        if (result.human) console.log(result.human);
        return result.exitCode;
      }
      case 'update': {
        const { runUpdateCommand } = require('../src/cli/update');
        const result = await runUpdateCommand(flags);
        console.log(result.human);
        return result.exitCode;
      }
      default:
        console.error(`unknown command: ${command}\n`);
        console.log(HELP);
        return EXIT_CODES.SCRIPTORIUM_ERROR;
    }
  } catch (err) {
    return reportError(err);
  }
}

main().then((code) => {
  process.exitCode = code;
});
