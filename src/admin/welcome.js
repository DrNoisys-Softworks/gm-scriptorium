'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensurePrivateDir } = require('../remote/privatefile');
const { NAME_RE } = require('../setup/validate');

/*
 * FR-23 (docs/decisions/0028-installer-and-first-run.md, section 5): the Overview welcome is shown
 * once for a campaign that browser setup just created, and dismissed for good. It is remembered on
 * the server, per machine, in `<panelDir>/welcome.json` beside the config: { "pending": [names] }.
 * It is not browser storage, not config.toml and never the vault.
 *
 * Reads never throw: a missing, oversized, malformed, non-object or symlinked file all read as an
 * empty list. Every name is checked against the campaign name rule on the way out, so a hand-edited
 * file can never put anything else on the screen. Writes are a private temp file (0600, in a 0700
 * folder) and a rename. This file is not a secret, so it does not go through the remote-access
 * private-file writers, whose callers test/remote-structure.test.js pins.
 */

const FILE = 'welcome.json';
const MAX_BYTES = 4096;
const MAX_NAMES = 50;

function readRaw(panelDir) {
  const file = path.join(panelDir, FILE);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Array.isArray(parsed.pending)) return [];
    return parsed.pending;
  } catch {
    return [];
  }
}

/** @param {string} panelDir @returns {string[]} valid, de-duplicated names; never throws */
function readPending(panelDir) {
  const out = [];
  for (const name of readRaw(panelDir)) {
    if (typeof name === 'string' && NAME_RE.test(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_NAMES);
}

function writePending(panelDir, names) {
  ensurePrivateDir(panelDir);
  const file = path.join(panelDir, FILE);
  const tmp = path.join(panelDir, `.${FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const data = Buffer.from(`${JSON.stringify({ pending: names }, null, 2)}\n`, 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, data, 0, data.length, null);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the original error below is what gets reported.
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // swallowed deliberately: the caller's own error already explains what went wrong.
    }
    throw err;
  }
}

/** @throws {Error} on a name that fails the campaign name rule, or an I/O failure */
function addPending(panelDir, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('not a valid campaign name');
  const names = readPending(panelDir);
  if (names.includes(name)) return;
  writePending(panelDir, [...names, name].slice(-MAX_NAMES));
}

/** @returns {boolean} whether the name was there */
function removePending(panelDir, name) {
  const names = readPending(panelDir);
  if (!names.includes(name)) return false;
  writePending(panelDir, names.filter((n) => n !== name));
  return true;
}

module.exports = { readPending, addPending, removePending, FILE };
