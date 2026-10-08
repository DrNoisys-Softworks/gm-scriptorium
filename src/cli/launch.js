'use strict';

const { createLaunchCodeStore, codeKey } = require('../launch/codes');
const { writeLauncher, removeLauncher } = require('../launch/launcherfile');
const { launchLines, attachKeys } = require('../launch/console');
const { startAdminPanel, adminUrl } = require('./serve-admin');
const { createPrompter } = require('./prompt');
const { onStopSignal } = require('../util/stop-signals');
const settingsLib = require('../remote/settings');
const procRun = require('../proc/run');

/*
 * ADR 0028, section 6. Running GM-Scriptorium with no command, in a terminal or by double-click,
 * starts `serve --admin` underneath in launch mode: a plain console, a one-time launch code carried
 * to the browser in an owner-only launcher file, a shell-free opener that is never killed, O to open
 * the browser again, a clean stop on Ctrl+C or a closed window, and a pause on any error so a
 * double-clicked window does not vanish with the message in it.
 *
 * bin/scriptorium.js calls runLaunch with nothing but the flags, the error mapper and the version;
 * every other dependency has its real default bound here, and a test injects all of them (every test
 * that loads this file also injects openFile, so no test can open a real browser).
 */

const PAUSE_PROMPT = 'Press Enter to close this window.\n';
const OPEN_FAILED = "The browser couldn't be opened. Open this link instead:";

/**
 * Launch mode starts when there is no command, no flag other than --config <path>, and both ends are
 * terminals. A double-click and a typed command cannot be told apart (both give a TTY on each end).
 *
 * @param {{ positional: string[], flags: object, stdinIsTTY: boolean, stdoutIsTTY: boolean }} info
 * @returns {boolean}
 */
function shouldLaunch({ positional, flags, stdinIsTTY, stdoutIsTTY }) {
  if (positional.length !== 0) return false;
  if (!Object.keys(flags).every((key) => key === 'config' && typeof flags[key] === 'string')) return false;
  return Boolean(stdinIsTTY && stdoutIsTTY);
}

/**
 * @param {object} flags only --config is ever present (see shouldLaunch)
 * @param {{ input?: object, output?: object, signals?: object, platform?: string, env?: object,
 *   openFile?: Function, killAll?: Function, startPanel?: Function, now?: () => number, version?: string,
 *   reportError?: (err: Error) => number, ttlMs?: number, randomBytes?: Function, pid?: number }} [deps]
 * @returns {Promise<number>} 0 after a deliberate stop; otherwise the exit code of the error, after the pause
 */
async function runLaunch(flags, deps = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    signals = process,
    platform = process.platform,
    env = process.env,
    now = Date.now,
    version = '',
    reportError = (err) => {
      output.write(`${err && err.message ? err.message : String(err)}\n`);
      return 1;
    },
    ttlMs,
    randomBytes,
    pid = process.pid,
  } = deps;
  const startPanel = deps.startPanel || startAdminPanel;
  const openFile = deps.openFile || procRun.openFile;
  const killAll = deps.killAll || procRun.killAll;
  const say = (line) => output.write(`${line}\n`);

  let panel = null;
  let store = null;
  let held = null; // { key, file, timer }: the launcher file for the newest code
  let detachKeys = () => {};
  let disposeSignals = () => {};
  let stopping = null;
  let resolveStopped = () => {};

  function dropHeld() {
    if (held === null) return;
    clearTimeout(held.timer);
    removeLauncher(held.file);
    held = null;
  }

  function printFallback() {
    say(OPEN_FAILED);
    say(`admin panel: ${adminUrl(panel.ctx.adminPort, panel.token)}`);
  }

  /** Mints a code, writes the launcher for it, and hands the file (never the code) to the opener. */
  async function openBrowser() {
    const code = store.mint();
    let file;
    try {
      file = writeLauncher({ panelDir: panel.ctx.remote.paths.panelDir, config: panel.ctx.ctxInfo.config, pid, port: panel.ctx.adminPort, code });
    } catch {
      printFallback();
      return;
    }
    if (held !== null) clearTimeout(held.timer);
    const key = codeKey(code);
    const timer = setTimeout(() => {
      if (held !== null && held.key === key) dropHeld();
    }, ttlMs === undefined ? 60000 : ttlMs);
    timer.unref();
    held = { key, file, timer };
    try {
      const result = await openFile({ target: file, env });
      if (result.outcome === 'exited' && result.exitCode !== 0) printFallback();
    } catch {
      printFallback();
    }
  }

  /** The launch stop path, in order: launcher file, listeners and preview folder, spawned programs, console. */
  function stopNow() {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      dropHeld();
      try {
        await panel.stop();
      } catch {
        // a close that fails must not keep the window open
      }
      try {
        await killAll();
      } catch {
        // killAll never rejects; belt and braces
      }
      if (store !== null) store.clear();
      detachKeys();
      disposeSignals();
      resolveStopped(0);
    })();
    return stopping;
  }

  async function pause() {
    const prompter = createPrompter({ input, output, signals });
    try {
      await prompter.ask(PAUSE_PROMPT);
    } finally {
      prompter.close();
    }
  }

  let exitCode;
  try {
    const startOpts = { emit: say };
    if (deps.now !== undefined) startOpts.now = deps.now;
    const started = await startPanel({ admin: true, ...(flags.config ? { config: flags.config } : {}) }, undefined, startOpts);
    if (!started.ok) {
      say(started.human);
      exitCode = started.exitCode;
    } else {
      panel = started;
      const { ctx } = panel;
      store = createLaunchCodeStore({
        now,
        ttlMs,
        randomBytes,
        onConsumed: (key) => {
          if (held !== null && held.key === key) dropHeld();
        },
      });
      ctx.launchCodes = store;

      const remoteLines = settingsLib.remoteAddressLines(panel.settings, panel.plan, {
        adminPort: ctx.adminPort,
        previewPort: ctx.previewPort,
        user: panel.planned && panel.planned.user,
        host: panel.planned && panel.planned.host,
      });
      for (const line of launchLines({ version, port: ctx.adminPort, setupMode: panel.setup, campaign: ctx.campaign, remoteLines })) say(line);

      const stopped = new Promise((resolve) => {
        resolveStopped = resolve;
      });
      disposeSignals = onStopSignal(signals, () => void stopNow(), platform, { hup: true });
      detachKeys = attachKeys(input, {
        onOpen: () => void openBrowser().catch(() => {}),
        onStop: () => void stopNow(),
      });
      void openBrowser().catch(() => {});
      return await stopped;
    }
  } catch (err) {
    if (panel !== null) {
      try {
        await stopNow();
      } catch {
        // the error being reported is the one that matters
      }
    }
    exitCode = reportError(err);
  }
  await pause();
  return exitCode;
}

module.exports = { shouldLaunch, runLaunch };
