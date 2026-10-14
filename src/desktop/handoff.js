'use strict';

/*
 * The terminal hand-off (ADR 0057 section 10; ADR 0046 addendum "The tray hand-off"). On an installed
 * Windows copy, bare `gm-scriptorium` in a terminal asks the tray helper beside the program to start
 * the background app, or to reuse the one that is running, and then prints a short status and returns.
 * Portable copies, Linux and --config keep console launch mode (src/cli/launch.js).
 *
 * This file starts nothing itself. The one spawner is runTrayHandoff in src/proc/run.js, passed in.
 *
 * How the helper's exit code becomes the command's (never passed through, because 4 is the frozen
 * update-prerequisite code of the command line):
 *   0 (delivered to a running copy) or 3 (started one)   > exit 0
 *   4 (a copy is running but its panel could not start)  > exit 1, with a line pointing at the log
 *   1 (nothing was started)                              > fall back to console launch mode
 *   anything else, or no code                            > exit 1, no fallback (something may be running)
 * A spawn failure falls back too, since nothing was started. A timeout prints a line and exits 1 with
 * no fallback: a fallback after the helper has started a copy would give two panels.
 */

const path = require('path');

const TRAY_EXE_NAME = 'gm-scriptorium-tray.exe';
const WIN_ABSOLUTE_RE = /^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/])/;
const CONTROLS_RE = /[\u0000-\u001f\u007f]/g;

const TIMEOUT_LINE = 'GM-Scriptorium is still starting. Look for its icon in the system tray.';
const PANEL_FAILED_LINE =
  "GM-Scriptorium is running, but its panel couldn't start. See the notification, or open the log from its icon in the system tray.";
const UNEXPECTED_LINE =
  "GM-Scriptorium's tray app stopped before it finished. Look for its icon in the system tray, or open the log from there.";

/** The helper's path, from the program's own path alone. Nobody can pass a path in. */
function trayPathFor(execPath) {
  return path.win32.join(path.win32.dirname(execPath), TRAY_EXE_NAME);
}

/**
 * True only on a packaged Windows program with the helper beside it and no --config flag.
 *
 * @param {{ platform: string, isPkg: boolean, execPath: string, flags: object, exists: (p: string) => boolean }} info
 */
function handoffApplies({ platform, isPkg, execPath, flags, exists }) {
  if (platform !== 'win32' || isPkg !== true) return false;
  if (flags && Object.prototype.hasOwnProperty.call(flags, 'config')) return false;
  if (typeof execPath !== 'string' || !WIN_ABSOLUTE_RE.test(execPath)) return false;
  try {
    return exists(trayPathFor(execPath)) === true;
  } catch {
    return false;
  }
}

function suffix(campaign) {
  const name = typeof campaign === 'string' ? campaign.replace(CONTROLS_RE, '') : '';
  return name === '' ? '' : ` (${name})`;
}

/**
 * Runs the hand-off and prints the status lines.
 *
 * @param {{ output: { write: Function }, env: object, execPath: string, campaign?: string|null }} info
 * @param {{ runTrayHandoff: Function }} deps
 * @returns {Promise<number|null>} the command's exit code, or null to fall back to console launch mode
 */
async function runHandoff({ output, env, execPath, campaign = null }, { runTrayHandoff }) {
  const say = (line) => output.write(`${line}\n`);
  let result;
  try {
    // A plain copy: process.env is not a plain object, and the spawner only takes one.
    result = await runTrayHandoff({ env: { ...env } }, { execPath });
  } catch {
    return null; // the helper could not be started: nothing is running because of this command
  }
  if (result.outcome === 'timeout') {
    say(TIMEOUT_LINE);
    return 1;
  }
  const where = suffix(campaign);
  switch (result.exitCode) {
    case 0:
      say(`GM-Scriptorium is already running in the background${where}.`);
      say('Opened a new signed-in tab in your browser.');
      return 0;
    case 3:
      say(`Started GM-Scriptorium in the background${where}.`);
      say('Its icon is in the system tray, and your browser is opening.');
      return 0;
    case 4:
      say(PANEL_FAILED_LINE);
      return 1;
    case 1:
      return null;
    default:
      say(UNEXPECTED_LINE);
      return 1;
  }
}

/**
 * The campaign the status line names: the default, else the only one, else nothing. Any trouble reading
 * the config means nothing, because the hand-off must not fail over a label.
 */
function campaignLabel(flags, { loadConfig } = {}) {
  try {
    const load = loadConfig || require('../cli/args').loadConfig;
    const { config } = load(flags);
    if (config && typeof config.default_campaign === 'string' && config.default_campaign !== '') return config.default_campaign;
    const names = Object.keys((config && config.campaigns) || {});
    return names.length === 1 ? names[0] : null;
  } catch {
    return null;
  }
}

/**
 * What bin/scriptorium.js calls before console launch mode. Every dependency has its real default
 * here; a test injects all of them.
 *
 * @returns {Promise<number|null>} an exit code, or null when console launch mode should run
 */
async function runBareHandoff(flags, deps = {}) {
  const platform = deps.platform || process.platform;
  const isPkg = deps.isPkg === undefined ? typeof process.pkg !== 'undefined' : deps.isPkg;
  const execPath = deps.execPath || process.execPath;
  const exists = deps.exists || require('fs').existsSync;
  if (!handoffApplies({ platform, isPkg, execPath, flags, exists })) return null;
  const runTrayHandoff = deps.runTrayHandoff || require('../proc/run').runTrayHandoff;
  return runHandoff(
    {
      output: deps.output || process.stdout,
      env: deps.env || process.env,
      execPath,
      campaign: campaignLabel(flags, { loadConfig: deps.loadConfig }),
    },
    { runTrayHandoff },
  );
}

module.exports = { TRAY_EXE_NAME, TIMEOUT_LINE, trayPathFor, handoffApplies, runHandoff, campaignLabel, runBareHandoff };
