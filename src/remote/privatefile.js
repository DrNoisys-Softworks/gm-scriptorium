'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ScriptoriumError } = require('../util/errors');
const { RETRY_DELAYS_MS } = require('../build/swap');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, section 4). The only way remote-access files
 * (panel/, and in V1.5b tls/) are created: a folder at 0700 and a file at 0600, both set at
 * creation by the open/mkdir call itself and never changed afterwards. A chmod after the fact
 * would leave a window in which another local user could read the secret, so none exists here
 * (test/remote-paths.test.js asserts the mode on the first write to a new descriptor).
 *
 * `fs` is always called through the module object (fs.openSync, fs.writeSync, ...) so a test can
 * patch a call deterministically.
 */

/** The same three codes src/vault/packreplace.js treats as worth a bounded wait. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * @param {string} dir
 * @returns {{ created: boolean, looseMode: boolean }}
 * @throws {ScriptoriumError} when `dir` is a symbolic link, or exists and is not a folder
 */
function ensurePrivateDir(dir) {
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (st !== null) {
    if (st.isSymbolicLink()) {
      throw new ScriptoriumError(`${dir} must be a real folder, not a link`, { path: dir });
    }
    if (!st.isDirectory()) {
      throw new ScriptoriumError(`${dir} must be a folder`, { path: dir });
    }
    return { created: false, looseMode: process.platform !== 'win32' && (st.mode & 0o077) !== 0 };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { created: true, looseMode: false };
}

function removeTempBestEffort(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // swallowed deliberately: the caller's own error already explains what went wrong.
  }
}

/**
 * Atomic temp-and-rename, the shape of src/vault/packreplace.js. The temp file is created with
 * 'wx' and 0600, so the final file's mode is the temp file's mode.
 *
 * @param {string} file
 * @param {string|Buffer} data
 */
function writePrivateFileAtomic(file, data) {
  ensurePrivateDir(path.dirname(file));
  const name = path.basename(file);
  const tmp = path.join(path.dirname(file), `.${name}.scriptorium-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    fs.writeSync(fd, buf, 0, buf.length, null);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the original error below is what gets reported.
      }
    }
    removeTempBestEffort(tmp);
    throw err;
  }

  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const last = attempt === maxAttempts - 1;
      if (!last && RETRYABLE_CODES.has(err.code)) {
        sleepSync(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      removeTempBestEffort(tmp);
      throw err;
    }
  }
}

/**
 * Appends one line, creating the file at 0600 if it is new. The open/write/close is spelled out
 * (rather than fs.appendFileSync) so the mode-at-creation test can intercept the first write.
 *
 * @param {string} file
 * @param {string} line a complete line, newline included
 */
function appendPrivateLine(file, line) {
  ensurePrivateDir(path.dirname(file));
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { ensurePrivateDir, writePrivateFileAtomic, appendPrivateLine };
