'use strict';

const path = require('path');
const { StringDecoder } = require('string_decoder');
const { startAdminPanel } = require('../cli/serve-admin');
const { loadConfig } = require('../cli/args');
const { resolveConfigPath } = require('../config/location');
const os = require('os');
const { parseDesktopTable, confirmedHere } = require('../config/desktopsettings');
const settingsLib = require('../remote/settings');
const { remotePaths } = require('../remote/paths');
const { createLaunchCodeStore, codeKey } = require('../launch/codes');
const { writeLauncher, removeLauncher } = require('../launch/launcherfile');
const procRun = require('../proc/run');
const { ConfigError, VaultUnreachableError } = require('../util/errors');
const { PROTOCOL_VERSION, MAX_LINE_BYTES, encodeLine, parseLine } = require('./protocol');
const { createDesktopLog, scrub } = require('./log');

/*
 * The hidden desktop host (ADR 0057, sections 3 to 9). `gm-scriptorium desktop run [--background]`
 * runs the admin panel on the [desktop] ports and speaks protocol v1 on its input and output, the
 * pipes the tray helper holds. It is the launch-mode panel (src/cli/launch.js) with the console
 * replaced by those lines, and it follows launch mode's stop path order for order.
 *
 * Rules this file keeps:
 *  - The output carries protocol lines and nothing else. Anything the panel prints is redirected to
 *    the log by src/cli/desktop.js before this runs, and the lines go through the output handed in,
 *    captured before that redirect.
 *  - Every start mints a fresh session token (the panel's own default, or the injected createToken):
 *    a cookie from before a Stop, Start or Restart never works again.
 *  - Nothing secret reaches the log or the output: the launch code only ever goes into the launcher
 *    file, and the opener is given the file, never the code or a URL.
 *  - A start at sign-in (--background) is quiet, retries only a vault that cannot be found, and runs
 *    this-PC-only unless the GM confirmed remote access at sign-in. Every start the GM makes opens a tab.
 *  - No network module and no spawner here; the browser opener is procRun.openFile, injected in tests.
 */

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([10000, 20000, 30000, 60000, 60000, 60000]);
const MAX_MESSAGE_CHARS = 300;
const LAUNCHER_TTL_MS = 60000;
const PORT_IN_USE = /port (\d+) is already in use/;

function oneLine(text) {
  const clean = scrub(String(text)).replace(/[\r\n\t]+/g, ' ').trim();
  return clean.length > MAX_MESSAGE_CHARS ? clean.slice(0, MAX_MESSAGE_CHARS) : clean;
}

/** @returns {{ kind: string, message: string, retryable: boolean }} the error class of a thrown error */
function classify(err) {
  const message = oneLine(err && err.message ? err.message : err);
  if (err instanceof VaultUnreachableError) {
    if (err.reason === 'not-found') return { kind: 'vault', message, retryable: true };
    if (err.reason === 'bad-config') return { kind: 'config', message, retryable: false };
    return { kind: 'other', message, retryable: false };
  }
  if (err instanceof ConfigError) return { kind: 'config', message, retryable: false };
  return { kind: 'other', message, retryable: false };
}

/**
 * @param {{ background?: boolean }} options
 * @param {{ input: object, output: object, env?: object, now?: () => number, version?: string,
 *   startPanel?: Function, openFile?: Function, killAll?: Function, createToken?: () => string,
 *   randomBytes?: Function, retryDelaysMs?: number[], pollMs?: number, configPath?: string,
 *   log?: object, proc?: object, pid?: number }} deps
 * @returns {Promise<number>} the exit code: 0 after a quit or end of input, 1 after a crash
 */
function runDesktopHost({ background = false } = {}, deps = {}) {
  const {
    input,
    output,
    env = process.env,
    now = Date.now,
    version = '',
    startPanel = startAdminPanel,
    openFile = procRun.openFile,
    killAll = procRun.killAll,
    createToken,
    randomBytes,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    pollMs = 60000,
    proc = process,
    pid = process.pid,
    hostname = os.hostname,
    platform = process.platform,
  } = deps;
  const configPath = deps.configPath || resolveConfigPath();
  const log = deps.log || createDesktopLog({ dir: path.join(remotePaths(configPath).panelDir, 'logs'), now });

  let panel = null; // the running panel, or null
  let store = null;
  let held = null; // { key, file, timer }: the launcher file for the newest code
  let pollTimer = null;
  let phase = 'starting'; // starting | running | stopped | error
  let lastCampaign = '-';
  let signinConfirmed = false; // remote access at sign-in is confirmed for THIS computer (ADR 0057, section 7)
  let signinLocal = false; // the running panel is local-only because remote access is not confirmed at sign-in
  let quitting = false;
  let quitStarted = false;
  let wait = null; // { timer, wake }: a retry wait in progress
  let abortStart = false;
  let nudged = false;
  let queue = Promise.resolve();
  let finish = () => {};
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const sentUpdates = new Set();

  function send(...fields) {
    let line;
    try {
      line = encodeLine(fields);
    } catch {
      return; // a line over the limit is dropped, never sent half-formed
    }
    try {
      output.write(line);
    } catch {
      requestQuit('pipe'); // a closed output means the helper has gone
    }
  }

  function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.catch((err) => {
      log.event('panel-warning', { text: oneLine(err && err.message ? err.message : err) });
    });
    return run;
  }

  function dropHeld() {
    if (held === null) return;
    clearTimeout(held.timer);
    removeLauncher(held.file);
    held = null;
  }

  function stopPoll() {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  }

  /** The launch stop path, in order: launcher file, listeners and preview folder, spawned programs, code store. */
  async function stopPanelPath() {
    stopPoll();
    dropHeld();
    if (panel !== null) {
      try {
        await panel.stop();
      } catch {
        // a close that fails must not keep the host alive
      }
    }
    try {
      await killAll();
    } catch {
      // killAll never rejects; belt and braces
    }
    if (store !== null) store.clear();
    panel = null;
    store = null;
  }

  /** Mints a code, writes the launcher for it, and hands the file (never the code) to the opener. */
  async function openBrowser() {
    if (panel === null || store === null) return;
    const code = store.mint();
    let file;
    try {
      file = writeLauncher({ panelDir: panel.ctx.remote.paths.panelDir, config: panel.ctx.ctxInfo.config, pid, port: panel.ctx.adminPort, code });
    } catch (err) {
      log.event('panel-warning', { text: `the browser could not be opened: ${oneLine(err && err.message ? err.message : err)}` });
      return;
    }
    if (held !== null) clearTimeout(held.timer);
    const key = codeKey(code);
    const timer = setTimeout(() => {
      if (held !== null && held.key === key) dropHeld();
    }, LAUNCHER_TTL_MS);
    timer.unref();
    held = { key, file, timer };
    try {
      const result = await openFile({ target: file, env: { ...env } });
      if (result && result.outcome === 'exited' && result.exitCode !== 0) log.event('panel-warning', { text: 'the browser opener reported a failure' });
    } catch {
      log.event('panel-warning', { text: 'the browser could not be opened' });
    }
  }

  function sendState(...rest) {
    send('state', ...rest);
  }

  function addressOf(ctx, settings) {
    const loopback = `http://127.0.0.1:${ctx.adminPort}`;
    if (settings.mode === 'local' || settings.mode === 'ssh') return loopback;
    return settings.admin_url || loopback;
  }

  /** Reads the settings and starts the panel once. @returns {Promise<object>} { ok: true } or { ok: false, kind, message, port?, retryable } */
  async function tryStart(atSignin) {
    const flags = { admin: true, config: configPath };
    try {
      const { config } = loadConfig({ config: configPath });
      const desktop = parseDesktopTable(config.desktop);
      // RV1 (ADR 0057, section 7): a start at sign-in runs this-PC-only unless the GM confirmed remote access.
      const confirmed = confirmedHere(config.desktop, hostname(), platform);
      // The answer counts only on the computer that gave it (a copied settings folder carries it to another PC).
      const localOnly = atSignin && !confirmed;
      const setup = Object.keys(config.campaigns || {}).length === 0;
      let local = false;
      let suppressed = false; // a remote mode is saved, and this sign-in start is holding it back
      try {
        const savedMode = settingsLib.parseRemoteTable(config.remote).mode;
        local = localOnly || savedMode === 'local';
        suppressed = localOnly && savedMode !== 'local';
      } catch {
        local = false; // a remote table that does not parse: pass no ports and let the panel report it
      }
      if (local || setup) {
        flags.port = String(desktop.port);
        flags['preview-port'] = String(desktop.previewPort);
      }
      const opts = { emit: (line) => log.event('panel-warning', { text: oneLine(line) }), localOnly };
      if (createToken !== undefined) opts.createToken = createToken;
      if (deps.now !== undefined) opts.now = deps.now;
      const started = await startPanel(flags, undefined, opts);
      if (!started.ok) {
        const human = String(started.human || '');
        const m = PORT_IN_USE.exec(human);
        if (m) return { ok: false, kind: 'port', message: oneLine(human.replace(/^failed to start server:\s*/, '')), port: m[1], retryable: false };
        return { ok: false, kind: 'other', message: oneLine(human), retryable: false };
      }
      return { ok: true, started, suppressed, confirmed };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wait = null;
        resolve();
      }, ms);
      wait = {
        timer,
        wake: () => {
          clearTimeout(timer);
          wait = null;
          resolve();
        },
      };
    });
  }

  function checkUpdates() {
    try {
      if (panel === null) return;
      const snap = panel.ctx.updateNotice.snapshot();
      if (snap.state !== 'available' || snap.dismissed || !snap.latestTag || !snap.notesUrl) return;
      if (sentUpdates.has(snap.latestTag)) return;
      sentUpdates.add(snap.latestTag);
      send('update', oneLine(snap.latestTag), snap.notesUrl);
    } catch {
      // the update line is a courtesy
    }
  }

  async function startOp({ user, open }) {
    if (quitting) return;
    if (panel !== null) {
      sendRunning();
      if (open) await openBrowser();
      return;
    }
    abortStart = false;
    nudged = false;
    phase = 'starting';
    sendState('starting', lastCampaign, '');
    log.event('panel-starting', { by: user ? 'user' : 'sign-in' });
    let attempt = 0;
    let isUser = user;
    let doOpen = open;
    for (;;) {
      const result = await tryStart(!isUser);
      if (quitting || abortStart) {
        if (result.ok) panel = result.started; // the stop path that follows (quit or stop) closes it
        return;
      }
      if (result.ok) {
        panel = result.started;
        signinLocal = result.suppressed === true;
        signinConfirmed = result.confirmed === true;
        break;
      }
      if (result.retryable && !isUser && attempt < retryDelaysMs.length) {
        log.event('retry', { attempt: attempt + 1, reason: result.kind });
        if (attempt === 0) sendState('starting', lastCampaign, oneLine('waiting for the vault'));
        await sleep(retryDelaysMs[attempt]);
        attempt += 1;
        if (nudged) {
          isUser = true;
          doOpen = true;
        }
        if (quitting || abortStart) return;
        continue;
      }
      phase = 'error';
      log.event('panel-error', { kind: result.kind, message: result.message, ...(result.port ? { port: result.port } : {}) });
      sendState('error', result.kind, result.message, ...(result.port ? [result.port] : []));
      return;
    }

    const { ctx } = panel;
    store = createLaunchCodeStore({
      now,
      randomBytes,
      onConsumed: (key) => {
        if (held !== null && held.key === key) dropHeld();
      },
    });
    ctx.launchCodes = store;
    ctx.desktop = {
      requestRestart: ({ open: reopen = true } = {}) => enqueue(() => restartOp({ open: reopen })),
      ports: { panel: ctx.adminPort, preview: ctx.previewPort },
    };
    phase = 'running';
    lastCampaign = ctx.campaign || '-';
    log.event('panel-running', { campaign: ctx.campaign || 'setup', reach: panel.settings.mode, port: ctx.adminPort, preview: ctx.previewPort });
    sendRunning();
    stopPoll();
    pollTimer = setInterval(checkUpdates, pollMs);
    pollTimer.unref();
    if (doOpen) await openBrowser();
  }

  function sendRunning() {
    if (panel === null) return;
    const fields = ['running', panel.ctx.campaign || 'setup', panel.settings.mode, addressOf(panel.ctx, panel.settings)];
    // ADR 0057 section 7: the literal fifth field tells the helper to show "Remote access is off at sign-in".
    if (signinLocal) fields.push('signin-local');
    // Always the last field: a separate fact, found by its `signin=` prefix, so older readers that only look for
    // `signin-local` as the fifth field are not disturbed.
    fields.push(signinConfirmed ? 'signin=confirmed' : 'signin=unconfirmed');
    sendState(...fields);
  }

  async function stopOp() {
    if (panel !== null) lastCampaign = panel.ctx.campaign || '-';
    await stopPanelPath();
    if (quitting) return;
    phase = 'stopped';
    log.event('panel-stopped', {});
    sendState('stopped', lastCampaign);
  }

  async function restartOp({ open = true } = {}) {
    if (quitting) return;
    log.event('op', { name: 'restart' });
    if (panel !== null) await stopOp();
    await startOp({ user: true, open });
  }

  function confirmKind() {
    if (panel === null) return 'none';
    if (panel.settings.mode !== 'local') return 'remote';
    if (panel.ctx.busy) return 'build';
    return 'none';
  }

  function requestQuit(reason, code = 0) {
    if (quitStarted) return;
    quitStarted = true;
    quitting = true;
    abortStart = true;
    if (wait !== null) wait.wake();
    // After any operation already in flight, so the stop path never runs twice at once.
    queue = queue.then(async () => {
      try {
        log.event('quit', { reason });
        await stopPanelPath();
        phase = 'stopped';
        send('bye', reason);
      } finally {
        detach();
        log.event('exit', { code });
        finish(code);
      }
    });
  }

  function onCrash(err) {
    log.event('uncaught', { message: oneLine(err && err.message ? err.message : err) });
    requestQuit('crash', 1);
  }

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discarding = false;

  function handleLine(text) {
    const parsed = parseLine(text);
    if (parsed === null) return;
    const verb = parsed.verb;
    switch (verb) {
      case 'stop?':
      case 'quit?':
        send('confirm', confirmKind());
        break;
      case 'quit':
        requestQuit('quit');
        break;
      case 'stop':
        if (wait !== null || phase === 'starting') {
          abortStart = true;
          if (wait !== null) wait.wake();
        }
        enqueue(() => {
          log.event('op', { name: 'stop' });
          return stopOp();
        });
        break;
      case 'open':
      case 'start':
      case 'retry':
      case 'restart':
        if (wait !== null && verb !== 'restart') {
          nudged = true;
          wait.wake();
          break;
        }
        if (verb === 'restart') enqueue(() => restartOp({ open: true }));
        else if (verb === 'open') {
          enqueue(() => {
            log.event('op', { name: 'open' });
            return panel !== null ? openBrowser() : startOp({ user: true, open: true });
          });
        } else {
          enqueue(() => {
            log.event('op', { name: verb });
            return startOp({ user: true, open: true });
          });
        }
        break;
      default:
        break;
    }
  }

  function onData(chunk) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at + 1);
      buffer = buffer.slice(at + 1);
      if (discarding) discarding = false;
      else handleLine(line);
      at = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      discarding = true;
    }
  }

  const onEnd = () => requestQuit('eof');
  const onOutputError = () => requestQuit('pipe');
  const onUncaught = (err) => onCrash(err);
  const onRejection = (reason) => onCrash(reason);

  function detach() {
    if (typeof input.removeListener === 'function') {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
    }
    if (typeof input.pause === 'function') input.pause();
    if (typeof proc.removeListener === 'function') {
      proc.removeListener('uncaughtException', onUncaught);
      proc.removeListener('unhandledRejection', onRejection);
    }
  }

  // hello is always the first line.
  send('hello', PROTOCOL_VERSION, version, log.dir);
  log.event('host-start', { version, background: background ? 'yes' : 'no' });
  if (typeof proc.on === 'function') {
    proc.on('uncaughtException', onUncaught);
    proc.on('unhandledRejection', onRejection);
  }
  if (typeof output.on === 'function') output.on('error', onOutputError);
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);
  if (typeof input.resume === 'function') input.resume();

  enqueue(() => startOp({ user: !background, open: !background }));

  return finished;
}

module.exports = { runDesktopHost, DEFAULT_RETRY_DELAYS_MS };
