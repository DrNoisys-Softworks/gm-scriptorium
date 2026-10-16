'use strict';

const os = require('os');
const path = require('path');
const pkg = require('../../package.json');
const util = require('util');
const config = require('./config');
const { loadConfig } = require('./args');
const { ConfigError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');
const { validatePort } = require('../setup/validate');
const { parseDesktopTable } = require('../config/desktopsettings');
const { setDesktopPorts, setRemoteAtSignin } = require('../config/write');
const { createPrompter } = require('./prompt');
const { resolveConfigPath } = require('../config/location');
const { remotePaths } = require('../remote/paths');
const { createDesktopLog } = require('../desktop/log');

/*
 * `gm-scriptorium desktop set [--port N] [--preview-port N]` (docs/decisions/0057-windows-desktop-app.md,
 * section 8). The command line writer for the `[desktop]` ports; Setup and the tray's ports dialog
 * both run it, so NSIS never writes TOML. A flag left out keeps the current value (or the default).
 * The write goes through the one config writer, and only the `[desktop]` table changes.
 *
 * `gm-scriptorium desktop set --remote-at-signin on|off [--yes]` (section 7, "Turning it on and off from
 * the tray") is the command line twin of the tray item "Remote access at sign-in". It is given on its own,
 * not with the ports. `on` asks first at a terminal (default No), or takes --yes for a script, and is refused
 * with no terminal and no --yes; `off` asks nothing. The new settings are built before anything is asked,
 * so an unreadable [desktop] table is refused unasked.
 *
 * `gm-scriptorium desktop run [--background]` (section 3) is the hidden host the tray helper starts. It
 * refuses to run anywhere but Windows, and with a terminal on its input, because it is only ever started
 * by gm-scriptorium-tray.exe. Before the host starts, everything the panel would print (console.*, and
 * writes to process.stdout and process.stderr) is redirected to the desktop log, so a stray print can
 * never corrupt the protocol; the host gets the output stream as it was before the redirect.
 */

const USAGE = 'usage: gm-scriptorium desktop set [--port N] [--preview-port N]';
const SET_FLAGS = ['port', 'preview-port', 'remote-at-signin'];
const ALLOWED_FLAGS = { set: ['config', ...SET_FLAGS, 'yes'], run: ['config', 'background'] };
const WINDOWS_ONLY = 'the desktop app runs only on Windows; run "gm-scriptorium" or "serve --admin"';
const NOT_A_TERMINAL = 'desktop run is started by gm-scriptorium-tray.exe; to open the panel, run "gm-scriptorium"';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const SAFETY_EXIT_MS = 3000;
const SIGNIN_WARNING = 'Anyone your remote access setup lets through can reach the sign-in page whenever this PC is on.';
const SIGNIN_QUESTION = 'Start remote access when you sign in to Windows? [y/N] ';
const SIGNIN_NEEDS_YES = 'turning on remote access at sign-in asks first; run it in a terminal on this PC, or add --yes';
const SIGNIN_ON = 'remote access at sign-in: on for this PC\nit takes effect the next time you sign in to Windows; a panel that is already running is not changed';
const SIGNIN_OFF = 'remote access at sign-in: off\nthe next start at sign-in runs the panel for this PC only';

/**
 * Sends everything the panel prints to the log. Returns the function that puts the originals back.
 * @returns {() => void}
 */
function redirectOutput(log, { consoleObj, stdout, stderr }) {
  const saved = { stdoutWrite: stdout.write, stderrWrite: stderr.write };
  for (const name of CONSOLE_METHODS) saved[name] = consoleObj[name];
  const note = (source, text) => log.event('panel-warning', { source, text });
  for (const name of CONSOLE_METHODS) consoleObj[name] = (...parts) => note('console', util.format(...parts));
  const swallow = (source) => (chunk, encoding, callback) => {
    note(source, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  stdout.write = swallow('stdout');
  stderr.write = swallow('stderr');
  return () => {
    stdout.write = saved.stdoutWrite;
    stderr.write = saved.stderrWrite;
    for (const name of CONSOLE_METHODS) consoleObj[name] = saved[name];
  };
}

async function runHost(flags, deps) {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    consoleObj = console,
    proc = process,
    now = Date.now,
    host,
    // The helper compares this exactly with its own version (ADR 0057, section 11), so it is never empty.
    version = pkg.version,
    ...hostDeps
  } = deps;
  const { runDesktopHost } = host || require('../desktop/host');
  const configPath = resolveConfigPath({ cliConfigPath: flags.config });
  const log = createDesktopLog({ dir: path.join(remotePaths(configPath).panelDir, 'logs'), now });
  // The output as it is before the redirect: the only way a protocol line leaves this process.
  const realWrite = stdout.write.bind(stdout);
  const output = { write: (text) => realWrite(text), on: (event, fn) => stdout.on(event, fn) };
  const restore = redirectOutput(log, { consoleObj, stdout, stderr });
  let code;
  try {
    code = await runDesktopHost({ background: flags.background === true }, { ...hostDeps, version, input: stdin, output, now, log, configPath, proc });
  } finally {
    restore();
  }
  // If anything still holds the process open after the host has gone, end it. Unref'd, so it never delays a clean exit.
  const safety = setTimeout(() => proc.exit(code), SAFETY_EXIT_MS);
  safety.unref();
  return { exitCode: code, human: '' };
}

/**
 * `desktop set --remote-at-signin on|off [--yes]`. In this order: the value, the settings read, the new settings
 * built (an unreadable [desktop] table stops here, before any question), the question for `on`, the write.
 * @returns {Promise<{ exitCode: number, human: string }>}
 */
async function setSignin(flags, { stdin = process.stdin, stdout = process.stdout, hostname = os.hostname } = {}) {
  const value = flags['remote-at-signin'];
  if (value !== 'on' && value !== 'off') throw new ConfigError('--remote-at-signin must be on or off');
  const on = value === 'on';
  const { configPath, config: current } = loadConfig(flags);
  const next = setRemoteAtSignin(current, on, on ? hostname() : undefined);
  if (on && flags.yes !== true) {
    if (!stdin.isTTY) throw new ConfigError(SIGNIN_NEEDS_YES);
    const prompter = createPrompter({ input: stdin, output: stdout });
    let answer;
    try {
      prompter.say(SIGNIN_WARNING);
      answer = await prompter.ask(SIGNIN_QUESTION);
    } finally {
      prompter.close();
    }
    if (answer === null || !/^\s*y(es)?\s*$/i.test(answer)) throw new ConfigError('cancelled; nothing changed');
  }
  config.writeConfigFile(configPath, next);
  return { exitCode: EXIT_CODES.OK, human: on ? SIGNIN_ON : SIGNIN_OFF };
}

/**
 * @param {object} flags parsed argv flags
 * @param {string|undefined} subcommand
 * @param {string[]} args positional arguments after the subcommand
 * @param {object} [deps] `run`: platform, stdin, stdout, stderr, consoleObj, proc and the host's own dependencies; `set --remote-at-signin`: stdin, stdout, hostname (tests inject them)
 * @returns {{ exitCode: number, human: string } | Promise<{ exitCode: number, human: string }>} a promise for `run` and for `set --remote-at-signin`
 * @throws {ConfigError} bad usage or a bad value (exit 1); VaultUnreachableError from loadConfig for a malformed config (exit 3)
 */
function runDesktopCommand(flags, subcommand, args = [], deps = {}) {
  if ((subcommand !== 'set' && subcommand !== 'run') || args.length > 0) throw new ConfigError(USAGE);
  for (const key of Object.keys(flags)) {
    if (!ALLOWED_FLAGS[subcommand].includes(key)) throw new ConfigError(`desktop ${subcommand} does not accept --${key}`);
  }
  if (subcommand === 'run') {
    const { platform = process.platform, stdin = process.stdin } = deps;
    if (platform !== 'win32') return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: WINDOWS_ONLY };
    if (stdin.isTTY) return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: NOT_A_TERMINAL };
    return runHost(flags, deps);
  }
  if (!SET_FLAGS.some((f) => flags[f] !== undefined)) {
    throw new ConfigError(`desktop set: nothing to change; pass at least one of ${SET_FLAGS.map((f) => `--${f}`).join(', ')}`);
  }
  if (flags['remote-at-signin'] !== undefined && (flags.port !== undefined || flags['preview-port'] !== undefined)) {
    throw new ConfigError('desktop set: give --remote-at-signin on its own, not with --port or --preview-port');
  }
  if (flags['remote-at-signin'] !== undefined) return setSignin(flags, deps);
  if (flags.yes !== undefined) throw new ConfigError('desktop set: --yes only goes with --remote-at-signin');
  const asked = {};
  if (flags.port !== undefined) asked.port = validatePort(flags.port, '--port');
  if (flags['preview-port'] !== undefined) asked.previewPort = validatePort(flags['preview-port'], '--preview-port');

  const { configPath, config: current } = loadConfig(flags);
  const existing = parseDesktopTable(current.desktop);
  const next = setDesktopPorts(current, {
    port: asked.port === undefined ? existing.port : asked.port,
    previewPort: asked.previewPort === undefined ? existing.previewPort : asked.previewPort,
  });
  config.writeConfigFile(configPath, next);
  const saved = parseDesktopTable(next.desktop);
  return {
    exitCode: EXIT_CODES.OK,
    human: `desktop app ports: panel ${saved.port}, preview ${saved.previewPort}\nchanges take effect the next time the desktop app starts its panel`,
  };
}

module.exports = { runDesktopCommand, USAGE, ALLOWED_FLAGS };
