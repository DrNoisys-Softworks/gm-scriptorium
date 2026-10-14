'use strict';

const path = require('path');
const pkg = require('../../package.json');
const util = require('util');
const config = require('./config');
const { loadConfig } = require('./args');
const { ConfigError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');
const { validatePort } = require('../setup/validate');
const { parseDesktopTable } = require('../config/desktopsettings');
const { setDesktopPorts } = require('../config/write');
const { resolveConfigPath } = require('../config/location');
const { remotePaths } = require('../remote/paths');
const { createDesktopLog } = require('../desktop/log');

/*
 * `gm-scriptorium desktop set [--port N] [--preview-port N]` (docs/decisions/0057-windows-desktop-app.md,
 * section 8). The command line writer for the `[desktop]` ports; Setup and the tray's ports dialog
 * both run it, so NSIS never writes TOML. A flag left out keeps the current value (or the default).
 * The write goes through the one config writer, and only the `[desktop]` table changes.
 *
 * `gm-scriptorium desktop run [--background]` (section 3) is the hidden host the tray helper starts. It
 * refuses to run anywhere but Windows, and with a terminal on its input, because it is only ever started
 * by gm-scriptorium-tray.exe. Before the host starts, everything the panel would print (console.*, and
 * writes to process.stdout and process.stderr) is redirected to the desktop log, so a stray print can
 * never corrupt the protocol; the host gets the output stream as it was before the redirect.
 */

const USAGE = 'usage: gm-scriptorium desktop set [--port N] [--preview-port N]';
const SET_FLAGS = ['port', 'preview-port'];
const ALLOWED_FLAGS = { set: ['config', ...SET_FLAGS], run: ['config', 'background'] };
const WINDOWS_ONLY = 'the desktop app runs only on Windows; run "gm-scriptorium" or "serve --admin"';
const NOT_A_TERMINAL = 'desktop run is started by gm-scriptorium-tray.exe; to open the panel, run "gm-scriptorium"';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const SAFETY_EXIT_MS = 3000;

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
 * @param {object} flags parsed argv flags
 * @param {string|undefined} subcommand
 * @param {string[]} args positional arguments after the subcommand
 * @param {object} [deps] `run` only: platform, stdin, stdout, stderr, consoleObj, proc and the host's own dependencies (tests inject them)
 * @returns {{ exitCode: number, human: string } | Promise<{ exitCode: number, human: string }>} a promise for `run`
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
