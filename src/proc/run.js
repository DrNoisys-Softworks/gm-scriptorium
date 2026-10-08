'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');

/*
 * The one place in Scriptorium that starts another program on the admin path (ADR 0046). It is
 * async only, has a fixed list of program names, never uses a shell, builds the child's
 * environment from scratch, runs the child in an empty temp folder, and kills the whole process
 * tree on timeout, cancel, output cap or shutdown.
 *
 * One deliberate exception sits at the end of this file: openFile, the launch-only browser opener
 * (ADR 0028, section 8; ADR 0046 addendum). It hands one local file to the operating system's own
 * opener and lets go. It is not on the list, is never registered in the live-run set and is never
 * killed, because the browser it starts has to outlive the panel (the "stopped" tab).
 *
 * What this still cannot see (residual limits, written down rather than left for the next person
 * to rediscover; the same list is in ADR 0046, "Will not catch"):
 *
 * - A grandchild that left the process group on purpose (setsid, or a detached start of its own)
 *   survives a kill. The group kill reaches only processes still in the child's group.
 * - A grandchild that outlives a clean exit of the child while its pipes are closed is not seen.
 *   The exit drain handles one that still holds the pipes; one that has let go is invisible.
 * - A hard kill of the panel (SIGKILL, power loss) skips killAll(), so children can outlive it.
 * - On Windows, taskkill walks the tree from the child's pid. If the child has already gone, its
 *   own children are no longer reachable from it.
 * - What a vendor program does by itself (files it writes, network it opens, its own children
 *   outside the group) is outside this module.
 * - Arguments that make git or ssh run another command (a core.sshCommand setting, an
 *   ProxyCommand option) are passed through. A feature that takes arguments from config must
 *   constrain them before calling here.
 * - A Windows .cmd shim that re-parses its own arguments unquoted can still misread them, whatever
 *   quoting reached cmd.exe.
 * - The process-group id can in principle be reused between the child's exit and a late signal.
 */

const ALLOWED_COMMANDS = Object.freeze(['claude', 'codex', 'gemini', 'git', 'rsync', 'ssh', 'whisper-cli']);

const BASE_ENV_POSIX = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
]);

const BASE_ENV_WIN32 = Object.freeze([
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);

const STRIPPED_ENV_NAMES = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const STRIPPED_ENV_PREFIXES = Object.freeze(['CLAUDE_CODE_USE_']);
const WINDOWS_EXTENSIONS = Object.freeze(['.exe', '.cmd']);
const MAX_LIVE_RUNS = 8;
const DEFAULTS = Object.freeze({
  timeoutMs: 600000,
  killGraceMs: 5000,
  maxStdoutBytes: 8388608,
  maxStderrBytes: 1048576,
});

const OPTION_KEYS = new Set([
  'command', 'args', 'env', 'extraEnv', 'stdin', 'timeoutMs', 'killGraceMs', 'maxStdoutBytes',
  'maxStderrBytes', 'signal', 'onStdout', 'onStderr',
]);

// Written with escapes so no quote character sits inside a regex literal.
const SYSTEM_ROOT_RE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/;
const CMD_UNSAFE_RE = /[\x22%!\x00-\x1f]/;

const SAFE_FIELDS = ['command', 'index', 'reason', 'variable', 'stream', 'limit', 'syscallCode'];

/**
 * Every error this module throws. The message is fixed text per code. The extra fields are the
 * only data it ever carries: an allowed program name, an argument index, a short reason, an
 * environment variable NAME, a stream name, a byte limit, and a system error code. It never
 * carries a cause, a path, an environment value, an argument value or stdin.
 */
class ProcError extends ScriptoriumError {
  constructor(code, message, fields = {}) {
    super(message);
    this.code = code;
    for (const key of SAFE_FIELDS) {
      if (fields[key] !== undefined) this[key] = fields[key];
    }
  }
}

function fail(code, message, fields) {
  return new ProcError(code, message, fields);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeSyscallCode(err) {
  const code = err && err.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
}

// --- environment -----------------------------------------------------------------------------------

function hasNul(text) {
  return text.indexOf('\0') !== -1;
}

function isStripped(name) {
  const upper = name.toUpperCase();
  if (STRIPPED_ENV_NAMES.includes(upper)) return true;
  return STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Case-insensitive lookup of a name in an environment object. */
function findKey(env, wanted) {
  const lower = wanted.toLowerCase();
  return Object.keys(env).find((k) => k.toLowerCase() === lower);
}

/**
 * Builds the child's environment from scratch.
 *
 * The base list is copied from `sourceEnv`; then `extraEnv`, which cannot set PATH; then a strip
 * that removes the Anthropic credentials and every CLAUDE_CODE_USE_ switch, whatever their case,
 * whatever platform and however they arrived.
 *
 * @param {object} sourceEnv  the caller's environment (never read from the process)
 * @param {object} extraEnv   explicit per-call additions (strings)
 * @param {string} platform
 * @returns {object}
 */
function buildChildEnv(sourceEnv, extraEnv, platform) {
  if (!isPlainObject(sourceEnv)) throw fail('E_PROC_ENV', 'the source environment is not an object', { reason: 'source' });
  const extra = extraEnv === undefined ? {} : extraEnv;
  if (!isPlainObject(extra)) throw fail('E_PROC_ENV', 'the extra environment is not an object', { reason: 'extra' });
  const win = platform === 'win32';
  const base = win ? BASE_ENV_WIN32 : BASE_ENV_POSIX;
  const out = {};

  for (const name of base) {
    let value;
    if (win) {
      const lower = name.toLowerCase();
      const hits = Object.keys(sourceEnv).filter((k) => k.toLowerCase() === lower && sourceEnv[k] !== undefined);
      const values = new Set(hits.map((k) => sourceEnv[k]));
      if (values.size > 1) throw fail('E_PROC_ENV', 'environment names differ only by case', { reason: 'ambiguous-case', variable: name });
      value = hits.length > 0 ? sourceEnv[hits[0]] : undefined;
    } else {
      value = Object.prototype.hasOwnProperty.call(sourceEnv, name) ? sourceEnv[name] : undefined;
    }
    if (value === undefined) continue;
    if (typeof value !== 'string' || hasNul(value)) {
      throw fail('E_PROC_ENV', 'an environment value is not usable', { reason: 'value', variable: name });
    }
    setOwn(out, name, value);
  }

  const pathKey = findKey(out, 'PATH');
  if (pathKey === undefined || out[pathKey] === '') {
    throw fail('E_PROC_ENV', 'the environment has no PATH', { reason: 'path-missing', variable: 'PATH' });
  }

  for (const name of Object.keys(extra)) {
    const value = extra[name];
    if (name === '' || name.indexOf('=') !== -1 || hasNul(name)) {
      throw fail('E_PROC_ENV', 'an environment name is not usable', { reason: 'name' });
    }
    if (name.toLowerCase() === 'path') {
      throw fail('E_PROC_ENV', 'PATH cannot be set per call', { reason: 'path-in-extra', variable: 'PATH' });
    }
    if (typeof value !== 'string' || hasNul(value)) {
      throw fail('E_PROC_ENV', 'an environment value is not usable', { reason: 'value', variable: name });
    }
    const existing = win ? findKey(out, name) : undefined;
    setOwn(out, existing === undefined ? name : existing, value);
  }

  for (const key of Object.keys(out)) {
    if (isStripped(key)) delete out[key];
  }

  if (win) systemRootOf(out);
  return out;
}

/** The validated SystemRoot of a win32 child environment, or E_PROC_ENV. */
function systemRootOf(env) {
  const key = findKey(env, 'SystemRoot');
  const value = key === undefined ? undefined : env[key];
  if (typeof value !== 'string' || !SYSTEM_ROOT_RE.test(value)) {
    throw fail('E_PROC_ENV', 'SystemRoot is missing or not usable', { reason: 'systemroot', variable: 'SystemRoot' });
  }
  return value;
}

// --- resolution ------------------------------------------------------------------------------------

function posixFileExists(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function winFileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The first absolute PATH entry that holds `command` as an executable regular file, or null.
 * Shared by resolveCommand and the browser opener, so the two cannot drift. Relative and empty
 * entries are never looked at.
 */
function findOnPosixPath(command, pathValue, exists) {
  for (const entry of pathValue.split(':')) {
    if (entry === '' || !path.posix.isAbsolute(entry)) continue;
    const candidate = path.posix.join(entry, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Finds `command` on the PATH of the given (child) environment, and nowhere else. Read-only.
 *
 * @param {string} command  an allowed name
 * @param {{ env: object, platform: string }} ctx
 * @param {{ fileExists?: (p: string) => boolean }} [deps]
 * @returns {{ resolvedPath: string, kind: 'direct' | 'cmd-shim' }}
 */
function resolveCommand(command, { env, platform }, deps = {}) {
  if (typeof command !== 'string' || !ALLOWED_COMMANDS.includes(command)) {
    throw fail('E_PROC_NOT_ALLOWED', 'that program is not on the allowed list', { reason: 'not-allowed' });
  }
  const key = isPlainObject(env) ? findKey(env, 'PATH') : undefined;
  const value = key === undefined ? undefined : env[key];
  if (typeof value !== 'string' || value === '') {
    throw fail('E_PROC_ENV', 'the environment has no PATH', { reason: 'path-missing', variable: 'PATH' });
  }
  const notFound = () => fail('E_PROC_NOT_FOUND', 'the program was not found on the given PATH', { command });

  if (platform === 'win32') {
    const exists = deps.fileExists || winFileExists;
    for (const raw of value.split(';')) {
      const entry = raw.replace(/^"(.*)"$/, '$1');
      if (!/^[A-Za-z]:\\/.test(entry) && !entry.startsWith('\\\\')) continue;
      const folder = entry.endsWith('\\') ? entry : entry + '\\';
      for (const ext of WINDOWS_EXTENSIONS) {
        const candidate = folder + command + ext;
        if (exists(candidate)) return { resolvedPath: candidate, kind: ext === '.exe' ? 'direct' : 'cmd-shim' };
      }
    }
    throw notFound();
  }

  const found = findOnPosixPath(command, value, deps.fileExists || posixFileExists);
  if (found !== null) return { resolvedPath: found, kind: 'direct' };
  throw notFound();
}

// --- invocation --------------------------------------------------------------------------------------

function quoteForCmd(text) {
  return '"' + text.replace(/(\\+)$/, '$1$1') + '"';
}

/**
 * The exact file and arguments to hand to spawn. On Windows a .cmd shim is run through cmd.exe
 * with one verbatim, fully quoted command line, after refusing the four things quoting cannot
 * make inert: a double quote, a percent sign, an exclamation mark and a control character.
 *
 * @returns {{ file: string, args: string[], windowsVerbatimArguments: boolean }}
 */
function buildInvocation({ resolvedPath, kind }, args, { platform, env }) {
  if (platform !== 'win32' || kind !== 'cmd-shim') {
    return { file: resolvedPath, args: [...args], windowsVerbatimArguments: false };
  }
  if (CMD_UNSAFE_RE.test(resolvedPath)) {
    throw fail('E_PROC_SHIM', 'the shim path is not safe to run through cmd.exe', { reason: 'shim-path' });
  }
  args.forEach((arg, index) => {
    if (CMD_UNSAFE_RE.test(arg)) {
      throw fail('E_PROC_ARG', 'an argument cannot be passed to a cmd shim safely', { reason: 'cmd-metachar', index });
    }
  });
  const root = systemRootOf(env);
  const line = '"' + [resolvedPath, ...args].map(quoteForCmd).join(' ') + '"';
  return {
    file: root + '\\System32\\cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', line],
    windowsVerbatimArguments: true,
  };
}

// --- options -------------------------------------------------------------------------------------------

function validateOptions(opts) {
  const bad = (reason) => fail('E_PROC_BAD_OPTIONS', 'the options are not valid', { reason });
  if (!isPlainObject(opts)) throw bad('options');
  for (const key of Object.keys(opts)) {
    if (!OPTION_KEYS.has(key)) throw bad('unknown-option');
  }
  if (opts.args !== undefined) {
    if (!Array.isArray(opts.args) || !opts.args.every((a) => typeof a === 'string')) throw bad('args');
  }
  if (!isPlainObject(opts.env)) throw bad('env');
  if (opts.extraEnv !== undefined) {
    if (!isPlainObject(opts.extraEnv)) throw bad('extraEnv');
    if (!Object.values(opts.extraEnv).every((v) => typeof v === 'string')) throw bad('extraEnv');
  }
  if (opts.stdin !== undefined && typeof opts.stdin !== 'string' && !Buffer.isBuffer(opts.stdin)) throw bad('stdin');
  for (const key of ['timeoutMs', 'killGraceMs', 'maxStdoutBytes', 'maxStderrBytes']) {
    if (opts[key] !== undefined && !isPositiveSafeInteger(opts[key])) throw bad(key);
  }
  if (opts.signal !== undefined) {
    const s = opts.signal;
    if (!s || typeof s.aborted !== 'boolean' || typeof s.addEventListener !== 'function' || typeof s.removeEventListener !== 'function') {
      throw bad('signal');
    }
  }
  for (const key of ['onStdout', 'onStderr']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'function') throw bad(key);
  }
}

// --- the live-run registry ---------------------------------------------------------------------------------

const liveRuns = new Set();

function liveRunCount() {
  return liveRuns.size;
}

/** Cancels every live run and waits for all of them to settle. Never rejects. Safe to call twice. */
async function killAll() {
  const runs = [...liveRuns];
  for (const record of runs) {
    try {
      record.cancel();
    } catch {
      /* a failed cancel must not stop the others */
    }
  }
  await Promise.all(runs.map((record) => record.done));
}

// --- run -----------------------------------------------------------------------------------------------------

/**
 * Runs one allowed program and resolves when it and its pipes are finished.
 *
 * Refusals reject (never throw synchronously), in this order: options, allowlist, NUL arguments,
 * environment, already-aborted signal, live-run limit, resolution, shim checks, temp folder, spawn.
 *
 * @param {object} opts
 * @param {{ spawn?: Function, platform?: string, fileExists?: Function }} [deps]  tests only
 */
async function run(opts, deps = {}) {
  validateOptions(opts);
  const command = opts.command;
  if (typeof command !== 'string' || !ALLOWED_COMMANDS.includes(command)) {
    throw fail('E_PROC_NOT_ALLOWED', 'that program is not on the allowed list', { reason: 'not-allowed' });
  }
  const args = opts.args === undefined ? [] : opts.args;
  args.forEach((arg, index) => {
    if (hasNul(arg)) throw fail('E_PROC_ARG', 'an argument contains a NUL character', { reason: 'nul', index });
  });
  const platform = deps.platform || process.platform;
  const win = platform === 'win32';
  const spawnFn = deps.spawn || spawn;
  const childEnv = buildChildEnv(opts.env, opts.extraEnv, platform);
  if (opts.signal && opts.signal.aborted) {
    throw fail('E_PROC_ABORTED', 'the run was cancelled before it started', { command });
  }
  if (liveRuns.size >= MAX_LIVE_RUNS) {
    throw fail('E_PROC_LIMIT', 'too many programs are running', { limit: MAX_LIVE_RUNS });
  }
  const resolved = resolveCommand(command, { env: childEnv, platform }, { fileExists: deps.fileExists });
  const invocation = buildInvocation(resolved, args, { platform, env: childEnv });

  let cwd;
  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-proc-'));
  } catch (err) {
    throw fail('E_PROC_SPAWN', 'the program could not be started', { syscallCode: safeSyscallCode(err), reason: 'tempdir' });
  }

  const cfg = {
    timeoutMs: opts.timeoutMs === undefined ? DEFAULTS.timeoutMs : opts.timeoutMs,
    killGraceMs: opts.killGraceMs === undefined ? DEFAULTS.killGraceMs : opts.killGraceMs,
    maxStdoutBytes: opts.maxStdoutBytes === undefined ? DEFAULTS.maxStdoutBytes : opts.maxStdoutBytes,
    maxStderrBytes: opts.maxStderrBytes === undefined ? DEFAULTS.maxStderrBytes : opts.maxStderrBytes,
  };

  const spawnOptions = {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: !win,
  };
  if (invocation.windowsVerbatimArguments) spawnOptions.windowsVerbatimArguments = true;

  let child;
  try {
    child = spawnFn(invocation.file, invocation.args, spawnOptions);
  } catch (err) {
    removeDir(cwd);
    throw fail('E_PROC_SPAWN', 'the program could not be started', { syscallCode: safeSyscallCode(err) });
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const chunks = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    const caps = { stdout: cfg.maxStdoutBytes, stderr: cfg.maxStderrBytes };
    const sinks = { stdout: opts.onStdout, stderr: opts.onStderr };
    const pid = child && child.pid;

    let settled = false;
    let closed = false;
    let killing = false;
    let reason = null; // the first thing that stopped the run: timeout, cancel, cap, callback
    let failure = null; // a ProcError to reject with, set by cap, callback or spawn error
    let exited = null; // { code, signal } from the exit event
    const timers = [];
    let finishRecord;
    const record = {
      cancel: () => stop('cancel'),
      done: new Promise((r) => {
        finishRecord = r;
      }),
    };
    liveRuns.add(record);

    function later(fn, ms) {
      const timer = setTimeout(fn, ms);
      timer.unref();
      timers.push(timer);
      return timer;
    }

    function destroyStreams() {
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        try {
          if (stream && typeof stream.destroy === 'function') stream.destroy();
        } catch {
          /* already gone */
        }
      }
    }

    function signalGroup(sig) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      try {
        process.kill(-pid, sig);
      } catch {
        /* ESRCH and friends: nothing left to signal */
      }
    }

    // The one kill routine, used by every path.
    function killTree() {
      if (killing) return;
      killing = true;
      if (win) {
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            const killer = spawnFn(systemRootOf(childEnv) + '\\System32\\taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
              stdio: 'ignore',
              shell: false,
              windowsHide: true,
            });
            if (killer && typeof killer.on === 'function') killer.on('error', () => {});
          } catch {
            /* fall through to the plain kill after the grace period */
          }
        }
        later(() => {
          if (closed) return;
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          forceSettle();
        }, cfg.killGraceMs);
        return;
      }
      signalGroup('SIGTERM');
      later(() => {
        if (closed) return;
        signalGroup('SIGKILL');
        later(() => {
          if (!closed) forceSettle();
        }, cfg.killGraceMs);
      }, cfg.killGraceMs);
    }

    function stop(why) {
      if (settled) return;
      if (reason === null) reason = why;
      killTree();
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      liveRuns.delete(record);
      removeDir(cwd);
      if (error) reject(error);
      else resolve(result);
      finishRecord();
    }

    function settleNow() {
      if (settled) return;
      if (failure) {
        finish(failure);
        return;
      }
      const info = exited || { code: null, signal: null };
      finish(null, {
        command,
        resolvedPath: resolved.resolvedPath,
        cwd,
        exitCode: info.code,
        signal: info.signal,
        timedOut: reason === 'timeout',
        cancelled: reason === 'cancel',
        durationMs: Date.now() - startedAt,
        stdout: sinks.stdout ? null : Buffer.concat(chunks.stdout),
        stderr: sinks.stderr ? null : Buffer.concat(chunks.stderr),
        stdoutBytes: bytes.stdout,
        stderrBytes: bytes.stderr,
      });
    }

    function forceSettle() {
      destroyStreams();
      settleNow();
    }

    function onAbort() {
      stop('cancel');
    }

    function onData(name, buf) {
      if (failure || settled) return; // discarded after a cap or a callback failure
      const have = bytes[name];
      let piece = buf;
      let crossed = false;
      if (have + buf.length > caps[name]) {
        piece = buf.subarray(0, caps[name] - have);
        crossed = true;
      }
      if (piece.length > 0) {
        bytes[name] += piece.length;
        const sink = sinks[name];
        if (sink) {
          try {
            sink(piece);
          } catch {
            failure = fail('E_PROC_CALLBACK', 'an output callback failed', { stream: name });
            stop('callback');
            return;
          }
        } else {
          chunks[name].push(piece);
        }
      }
      if (crossed) {
        failure = fail('E_PROC_OUTPUT_CAP', 'the program produced more output than allowed', { stream: name, limit: caps[name] });
        stop('cap');
      }
    }

    child.on('error', (err) => {
      if (settled) return;
      if (!failure) failure = fail('E_PROC_SPAWN', 'the program could not be started', { syscallCode: safeSyscallCode(err) });
      if (reason === null) reason = 'error';
      if (!win) signalGroup('SIGKILL');
      else killing || killTree();
      closed = true;
      forceSettle();
    });

    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // The leader is gone. If something else still holds the pipes, close never comes: drain.
      later(() => {
        if (closed || settled) return;
        killTree();
        forceSettle();
      }, cfg.killGraceMs);
    });

    child.on('close', (code, signal) => {
      closed = true;
      if (!exited) exited = { code, signal };
      settleNow();
    });

    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      if (!stream) continue;
      stream.on('error', () => {});
      stream.on('data', (buf) => onData(name, buf));
    }

    if (child.stdin) {
      child.stdin.on('error', () => {});
      try {
        if (opts.stdin === undefined) child.stdin.end();
        else child.stdin.end(typeof opts.stdin === 'string' ? Buffer.from(opts.stdin, 'utf8') : opts.stdin);
      } catch {
        /* the child may already be gone */
      }
    }

    later(() => stop('timeout'), cfg.timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) onAbort();
    }
  });
}

// --- the browser opener (launch mode only) ---------------------------------------------------------------

// Passed through to the opener on POSIX so a desktop session's browser can be found and shown. Not in
// a base list on purpose: the allowlisted programs never need them.
const OPENER_ENV_EXTRA = Object.freeze([
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS',
  'DBUS_SESSION_BUS_ADDRESS', 'BROWSER',
]);

const OPEN_OPTION_KEYS = new Set(['target', 'env', 'settleMs']);
const OPEN_DEFAULT_SETTLE_MS = 10000;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const WIN_ABSOLUTE_RE = /^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/])/;

function validateOpenOptions(opts, platform) {
  const bad = (reason) => fail('E_PROC_BAD_OPTIONS', 'the options are not valid', { reason });
  if (!isPlainObject(opts)) throw bad('options');
  for (const key of Object.keys(opts)) {
    if (!OPEN_OPTION_KEYS.has(key)) throw bad('unknown-option');
  }
  const target = opts.target;
  if (typeof target !== 'string' || target === '' || CONTROL_CHAR_RE.test(target)) throw bad('target');
  const absolute = platform === 'win32' ? WIN_ABSOLUTE_RE.test(target) : path.posix.isAbsolute(target);
  if (!absolute) throw bad('target');
  if (!isPlainObject(opts.env)) throw bad('env');
  if (opts.settleMs !== undefined && !isPositiveSafeInteger(opts.settleMs)) throw bad('settleMs');
}

/** The program and arguments that hand `target` to the system's opener. No PATH search on win32 or macOS. */
function resolveOpener(target, { childEnv, platform }, deps) {
  if (platform === 'win32') {
    return { file: systemRootOf(childEnv) + '\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  }
  if (platform === 'darwin') return { file: '/usr/bin/open', args: [target] };
  const hasDisplay = ['DISPLAY', 'WAYLAND_DISPLAY'].some((name) => typeof childEnv[name] === 'string' && childEnv[name] !== '');
  if (!hasDisplay) throw fail('E_PROC_NO_DISPLAY', 'there is no display to open a browser on', { reason: 'display' });
  const key = findKey(childEnv, 'PATH');
  const found = findOnPosixPath('xdg-open', childEnv[key], deps.fileExists || posixFileExists);
  if (found === null) throw fail('E_PROC_NOT_FOUND', 'the browser opener was not found on the given PATH', { reason: 'opener' });
  return { file: found, args: [target] };
}

/**
 * Hands one local file to the operating system's opener and lets go: no shell, ignored stdio, a
 * session of its own (detached), unref-ed, never added to the live-run set and never killed, by a
 * timer or by killAll. Resolves { outcome: 'exited', exitCode, signal } if the opener finishes within
 * settleMs, else { outcome: 'running' }. Rejects E_PROC_SPAWN if it could not be started.
 *
 * @param {{ target: string, env: object, settleMs?: number }} opts
 * @param {{ spawn?: Function, platform?: string, fileExists?: Function }} [deps]  tests only
 * @returns {Promise<{ outcome: 'exited', exitCode: number|null, signal: string|null } | { outcome: 'running' }>}
 */
async function openFile(opts, deps = {}) {
  const platform = deps.platform || process.platform;
  validateOpenOptions(opts, platform);
  const spawnFn = deps.spawn || spawn;
  const extra = {};
  if (platform !== 'win32') {
    for (const name of OPENER_ENV_EXTRA) {
      if (Object.prototype.hasOwnProperty.call(opts.env, name) && typeof opts.env[name] === 'string' && !hasNul(opts.env[name])) {
        setOwn(extra, name, opts.env[name]);
      }
    }
  }
  const childEnv = buildChildEnv(opts.env, extra, platform);
  const { file, args } = resolveOpener(opts.target, { childEnv, platform }, deps);
  const dir = platform === 'win32' ? path.win32.dirname(opts.target) : path.posix.dirname(opts.target);
  const settleMs = opts.settleMs === undefined ? OPEN_DEFAULT_SETTLE_MS : opts.settleMs;

  let child;
  try {
    child = spawnFn(file, args, { stdio: 'ignore', shell: false, windowsHide: true, detached: true, env: childEnv, cwd: dir });
  } catch (err) {
    throw fail('E_PROC_SPAWN', 'the program could not be started', { syscallCode: safeSyscallCode(err) });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(null, { outcome: 'running' }), settleMs);
    timer.unref();
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }
    child.on('error', (err) => finish(fail('E_PROC_SPAWN', 'the program could not be started', { syscallCode: safeSyscallCode(err) })));
    child.once('exit', (code, signal) => finish(null, { outcome: 'exited', exitCode: code, signal }));
    if (typeof child.unref === 'function') child.unref();
  });
}

/** Best-effort, swallowed: a failed removal must never change what the caller sees. */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort only; the folder is empty and under the temp directory
  }
}

module.exports = {
  ALLOWED_COMMANDS,
  BASE_ENV_POSIX,
  BASE_ENV_WIN32,
  STRIPPED_ENV_NAMES,
  STRIPPED_ENV_PREFIXES,
  WINDOWS_EXTENSIONS,
  MAX_LIVE_RUNS,
  DEFAULTS,
  ProcError,
  buildChildEnv,
  resolveCommand,
  buildInvocation,
  run,
  killAll,
  liveRunCount,
  OPENER_ENV_EXTRA,
  openFile,
};
