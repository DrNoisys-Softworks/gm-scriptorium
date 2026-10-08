'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const probe = require('./probe');
const { ILLEGAL_CHARS_RE, RESERVED_DEVICE_NAME_RE } = require('../admin/uploadname');
const { ConfigError } = require('../util/errors');

/*
 * ADR 0049: the folder picker's listing. This module answers one question, "which folders are in
 * this folder", and never anything else: it names no file, counts nothing, reports no size or date,
 * and never reads through a link. It sits in src/setup on purpose, so test/setup-structure.test.js
 * already holds it read-only (no write token, no computed require). The one folder write the
 * picker has lives in src/admin/foldercreate.js, fenced by test/folders-structure.test.js.
 *
 * Nothing here waits on the operating system without a bound. Every filesystem call is one
 * probe.bounded() op, so the shared cap of two in-flight calls (src/setup/probe.js, FR-16) covers
 * the picker and the field checks together: a dead share costs one bounded wait, and the next call
 * answers "busy" at once. An op that needs the error code catches inside itself and resolves it,
 * which leaves probe.classify (and every other probe caller) untouched. No synchronous fs call is
 * made on a request path, and nothing uses Intl (the packaged executable's collation history).
 *
 * The caps (docs/decisions/0049-folder-picker.md, section 2): 500 folders shown, 20,000 entries
 * scanned (files included), 1,000 link or unknown-type entries confirmed, a 2,000 ms soft scan
 * deadline, a 128-character filter and a 2,048-character path.
 *
 * Will not catch, deliberately: a folder hidden only by a Windows attribute (the attribute is not
 * read); a mapped drive's network nature (it is just a letter); an exactly-20,000-entry folder is
 * reported truncated although nothing remained (the scan stops without peeking past the cap).
 */

const MAX_SHOWN = 500;
const MAX_SCANNED = 20000;
const MAX_CONFIRM = 1000;
const SCAN_DEADLINE_MS = 2000;
const MAX_FILTER = 128;
const MAX_PATH = 2048;
const MAX_NAME = 128;
const MAX_ANCESTORS = 32;

// Compared case-insensitively, on win32 only.
const WIN_HIDDEN = new Set(['$recycle.bin', 'system volume information', '$winreagent', '$windows.~bt', 'config.msi', 'recovery']);

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// --- names and paths ------------------------------------------------------------------------------

/**
 * ADR 0022 section 7, rules 1 to 7, in the same order. Rules 8 and 9 (.md, image extension) are
 * about files and do not apply to a folder.
 *
 * @param {unknown} name
 * @returns {string} `name`, unchanged
 * @throws {ConfigError} the first applicable rule
 */
function validateFolderName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError('folder name is required');
  }
  if (name.length > MAX_NAME) {
    throw new ConfigError('folder name is longer than 128 characters');
  }
  if (ILLEGAL_CHARS_RE.test(name)) {
    throw new ConfigError(`folder name "${name}" contains a character that is not allowed in a folder name`);
  }
  if (name.startsWith('.')) {
    throw new ConfigError('folder name must not start with a dot');
  }
  if (name.includes('..')) {
    throw new ConfigError('folder name must not contain ".."');
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new ConfigError('folder name must not end with a dot or a space');
  }
  if (RESERVED_DEVICE_NAME_RE.test(name)) {
    throw new ConfigError(`folder name "${name}" is a reserved Windows device name`);
  }
  return name;
}

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function validateWindowsPath(raw) {
  const slashed = raw.split('/').join('\\');
  if (slashed.startsWith('\\\\.\\') || slashed.startsWith('\\\\?\\')) {
    throw new ConfigError('folder path must not use the Windows device namespace');
  }
  let rest;
  if (/^[A-Za-z]:[\\/]/.test(raw)) rest = slashed.slice(2);
  else if (/^(?:\\\\|\/\/)[^\\/]+[\\/]+[^\\/]+/.test(raw)) rest = slashed.slice(2);
  else throw new ConfigError('folder path must start with a drive letter such as C:\\ or with \\\\host\\share');
  if (rest.includes(':')) {
    throw new ConfigError('folder path must not contain a colon after the drive');
  }
  for (const component of rest.split('\\')) {
    if (component.length > 0 && RESERVED_DEVICE_NAME_RE.test(component)) {
      throw new ConfigError(`folder path contains "${component}", a reserved Windows device name`);
    }
  }
  return path.win32.resolve(raw);
}

/**
 * A request's folder path, made canonical: absolute, at most 2048 characters, no NUL. Nothing is
 * denied by location: loopback means the same user's own machine, and a remote session is signed in.
 *
 * @param {unknown} raw
 * @param {string} [platform] process.platform by default
 * @returns {string} path[platform].resolve(raw)
 * @throws {ConfigError}
 */
function validateFolderPath(raw, platform = process.platform) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ConfigError('folder path is required');
  }
  if (raw.length > MAX_PATH) {
    throw new ConfigError('folder path is longer than 2048 characters');
  }
  if (raw.includes('\u0000')) {
    throw new ConfigError('folder path must not contain a NUL character');
  }
  if (platform === 'win32') return validateWindowsPath(raw);
  if (!raw.startsWith('/')) {
    throw new ConfigError('folder path must be an absolute path');
  }
  return path.posix.resolve(raw);
}

/** A leading dot everywhere; on win32 also the fixed list of system folders, case-insensitively. */
function isHiddenName(name, platform = process.platform) {
  if (name.startsWith('.')) return true;
  return platform === 'win32' && WIN_HIDDEN.has(name.toLowerCase());
}

// --- bounded filesystem access --------------------------------------------------------------------

function settingsOf(deps) {
  const d = deps || {};
  return {
    fsp: d.fsp || fs.promises,
    timeoutMs: d.timeoutMs || probe.DEFAULT_TIMEOUT_MS,
    platform: d.platform || process.platform,
    homedir: d.homedir,
    now: d.now || Date.now,
    deadlineMs: d.deadlineMs || SCAN_DEADLINE_MS,
  };
}

function homeOf(s) {
  const given = typeof s.homedir === 'function' ? s.homedir() : s.homedir;
  if (typeof given === 'string' && given.length > 0) return given;
  try {
    return os.homedir() || null;
  } catch {
    return null;
  }
}

/**
 * One filesystem call under the shared bound. Never throws.
 *
 * @returns {Promise<{ outcome: 'ok', value: any } | { outcome: 'timeout'|'busy' } | { outcome: 'error', code: string }>}
 */
async function ask(s, call) {
  const r = await probe.bounded(async () => {
    try {
      return { value: await call() };
    } catch (err) {
      return { code: (err && err.code) || 'UNKNOWN' };
    }
  }, s.timeoutMs);
  if (r.state === 'timeout') return { outcome: 'timeout' };
  if (r.state === 'busy') return { outcome: 'busy' };
  if (r.state !== 'ok' || !r.value) return { outcome: 'error', code: 'UNKNOWN' };
  if (r.value.code !== undefined) return { outcome: 'error', code: r.value.code };
  return { outcome: 'ok', value: r.value.value };
}

const GONE_CODES = ['ENOENT', 'ENOTDIR'];
const DENIED_CODES = ['EACCES', 'EPERM'];

/** The folder state a failed or unanswered call stands for. */
function stateOf(r) {
  if (r.outcome === 'timeout') return 'not-responding';
  if (r.outcome === 'busy') return 'busy';
  if (GONE_CODES.includes(r.code)) return 'missing';
  if (DENIED_CODES.includes(r.code)) return 'permission';
  return 'not-responding';
}

// --- listing one folder ----------------------------------------------------------------------------

function isKnownOtherType(ent) {
  return ['isFIFO', 'isSocket', 'isBlockDevice', 'isCharacterDevice'].some((m) => typeof ent[m] === 'function' && ent[m]());
}

function compareNames(a, b) {
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** Reads at most MAX_SCANNED entries (or until the soft deadline) and keeps the folder candidates. */
async function scanFolder(s, dirPath, wanted, filter) {
  const dir = await s.fsp.opendir(dirPath);
  const out = { candidates: [], truncated: false };
  const startedAt = s.now();
  let scanned = 0;
  try {
    for await (const ent of dir) {
      scanned++;
      const name = ent.name;
      let kind = null;
      if (ent.isFile()) kind = null;
      else if (ent.isDirectory()) kind = 'dir';
      else if (ent.isSymbolicLink()) kind = 'link';
      else if (!isKnownOtherType(ent)) kind = 'unknown';
      if (kind !== null) {
        const hidden = isHiddenName(name, s.platform);
        if ((!hidden || wanted.hidden === true) && (filter === '' || name.toLowerCase().includes(filter))) {
          out.candidates.push({ name, kind, hidden });
        }
      }
      if (scanned >= MAX_SCANNED || s.now() - startedAt >= s.deadlineMs) {
        out.truncated = true;
        break;
      }
    }
  } finally {
    try {
      await dir.close();
    } catch {
      // the iterator already closed it
    }
  }
  return out;
}

/**
 * Confirms one link or unknown-type entry with bounded calls. Only these decide what a Windows
 * reparse point (a OneDrive folder, a junction) is: the directory entry's own type cannot.
 *
 * @returns {Promise<{ omit: true } | { stop: true } | { link: boolean, unreadable: boolean }>}
 */
async function verifyEntry(s, fullPath, direntKind) {
  const direntLink = direntKind === 'link';
  const l = await ask(s, () => s.fsp.lstat(fullPath));
  if (l.outcome === 'timeout' || l.outcome === 'busy') return { stop: true };
  if (l.outcome === 'error') {
    if (GONE_CODES.includes(l.code)) return { omit: true };
    return { link: direntLink, unreadable: true };
  }
  const st = l.value;
  if (st && st.isSymbolicLink()) {
    const target = await ask(s, () => s.fsp.stat(fullPath));
    if (target.outcome === 'timeout' || target.outcome === 'busy') return { stop: true, link: true };
    if (target.outcome === 'error') {
      if (GONE_CODES.includes(target.code)) return { omit: true };
      return { link: true, unreadable: true };
    }
    return target.value && target.value.isDirectory() ? { link: true, unreadable: false } : { omit: true };
  }
  if (st && st.isDirectory()) return { link: false, unreadable: false };
  return { omit: true };
}

/**
 * Lists the child folders of one canonical absolute folder.
 *
 * @param {string} dirPath already passed through validateFolderPath
 * @param {{ hidden?: boolean, filter?: string }} [opts]
 * @param {object} [deps] { fsp, timeoutMs, platform, homedir, now, deadlineMs }: the test seam
 * @returns {Promise<object>} { view:'folder', state:'ok', path, parent, entries, truncated } or { view:'folder', state, path }
 */
async function listFolder(dirPath, opts, deps) {
  const s = settingsOf(deps);
  const wanted = opts || {};
  const P = pathFor(s.platform);
  const filter = typeof wanted.filter === 'string' ? wanted.filter.slice(0, MAX_FILTER).toLowerCase() : '';
  const refuse = (state) => ({ view: 'folder', state, path: dirPath });

  const first = await ask(s, () => s.fsp.lstat(dirPath));
  if (first.outcome !== 'ok') return refuse(stateOf(first));
  if (first.value.isSymbolicLink()) return refuse('link');
  if (!first.value.isDirectory()) return refuse('not-folder');

  const scan = await ask(s, () => scanFolder(s, dirPath, wanted, filter));
  if (scan.outcome !== 'ok') return refuse(stateOf(scan));

  const candidates = scan.value.candidates.sort(compareNames);
  const entries = [];
  let truncated = scan.value.truncated;
  let confirmed = 0;
  let stopConfirming = false;
  for (const c of candidates) {
    if (entries.length >= MAX_SHOWN) {
      truncated = true;
      break;
    }
    const fullPath = P.join(dirPath, c.name);
    const entry = (link, unreadable) => ({ name: c.name, path: fullPath, link, hidden: c.hidden, unreadable });
    if (c.kind === 'dir') {
      entries.push(entry(false, false));
      continue;
    }
    if (stopConfirming) {
      entries.push(entry(c.kind === 'link', true));
      continue;
    }
    if (confirmed >= MAX_CONFIRM) {
      truncated = true;
      break;
    }
    confirmed++;
    const verdict = await verifyEntry(s, fullPath, c.kind);
    if (verdict.omit) continue;
    if (verdict.stop) {
      stopConfirming = true;
      entries.push(entry(verdict.link === true || c.kind === 'link', true));
      continue;
    }
    entries.push(entry(verdict.link, verdict.unreadable));
  }

  const up = P.dirname(dirPath);
  return { view: 'folder', state: 'ok', path: dirPath, parent: up === dirPath ? null : up, entries, truncated };
}

// --- roots and the starting point -------------------------------------------------------------------

/**
 * The shortcuts: / and Home on POSIX; the drives and Home on Windows. Drives are asked strictly one
 * at a time, so enumeration never holds both slots of the shared cap. The first drive that does not
 * answer is remembered (in `opts.memory`, kept by the caller) and skipped until `opts.refresh`.
 *
 * @param {{ memory?: Set<string>, refresh?: boolean }} [opts]
 * @param {object} [deps]
 * @returns {Promise<object>} { view:'roots', platform, home, roots:[{ path, name, state }] }
 */
async function listRoots(opts, deps) {
  const s = settingsOf(deps);
  const o = opts || {};
  const home = homeOf(s);
  const homeRoot = home ? [{ path: home, name: 'Home', state: 'ok' }] : [];
  if (s.platform !== 'win32') {
    return { view: 'roots', platform: 'posix', home, roots: [{ path: '/', name: '/', state: 'ok' }, ...homeRoot] };
  }
  const memory = o.memory instanceof Set ? o.memory : new Set();
  if (o.refresh === true) memory.clear();
  const roots = [];
  let stopped = false;
  for (const letter of DRIVE_LETTERS) {
    const root = { path: `${letter}:\\`, name: `${letter}:` };
    if (stopped) {
      roots.push({ ...root, state: 'unchecked' });
      continue;
    }
    if (memory.has(letter)) {
      roots.push({ ...root, state: 'not-responding' });
      continue;
    }
    const r = await ask(s, () => s.fsp.stat(root.path));
    if (r.outcome === 'timeout') {
      memory.add(letter);
      roots.push({ ...root, state: 'not-responding' });
      stopped = true;
    } else if (r.outcome === 'busy') {
      roots.push({ ...root, state: 'unchecked' });
      stopped = true;
    } else if (r.outcome === 'ok') {
      roots.push({ ...root, state: 'ok' });
    }
    // any other answer: no such drive, or nothing usable in it. Omitted.
  }
  return { view: 'roots', platform: 'win32', home, roots: [...roots, ...homeRoot] };
}

/**
 * Where the picker opens for a field's current value: the deepest existing folder above it (a file
 * or a link is walked past), at most 32 levels, else Home. A UNC value is never probed: the answer
 * is `deferred` and the client puts the value in the location box for an explicit Go.
 *
 * @param {unknown} raw
 * @param {object} [deps]
 * @returns {Promise<{ view: 'start', path: string|null, deferred: boolean }>}
 */
async function startFolder(raw, deps) {
  const s = settingsOf(deps);
  const fallback = { view: 'start', path: homeOf(s), deferred: false };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH) return fallback;
  if (probe.isUncPath(raw)) return { view: 'start', path: null, deferred: true };
  let current;
  try {
    current = validateFolderPath(raw, s.platform);
  } catch {
    return fallback;
  }
  const P = pathFor(s.platform);
  for (let level = 0; level < MAX_ANCESTORS; level++) {
    const r = await ask(s, () => s.fsp.lstat(current));
    if (r.outcome === 'ok') {
      if (r.value.isDirectory() && !r.value.isSymbolicLink()) return { view: 'start', path: current, deferred: false };
    } else if (r.outcome !== 'error' || !GONE_CODES.includes(r.code)) {
      return fallback;
    }
    const up = P.dirname(current);
    if (up === current) return fallback;
    current = up;
  }
  return fallback;
}

module.exports = {
  validateFolderName,
  validateFolderPath,
  listFolder,
  listRoots,
  startFolder,
  isHiddenName,
  MAX_SHOWN,
  MAX_SCANNED,
  MAX_CONFIRM,
  SCAN_DEADLINE_MS,
  MAX_FILTER,
  MAX_PATH,
};
