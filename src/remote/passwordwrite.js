'use strict';

const { writePrivateFileAtomic } = require('./privatefile');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, sections 6 and 9). The password file's only
 * writers, used by `scriptorium remote` and nothing else. The panel's own module graph never
 * reaches this file (test/remote-structure.test.js, SD-doc 15(a)): the panel can read the hash to
 * check a sign-in, but it can never set or clear one.
 */

/** @param {string} file @param {object} record from password.hashPassword */
function writePasswordRecord(file, record) {
  writePrivateFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** @param {string} file @param {{ now?: () => number }} [opts] */
function clearPasswordRecord(file, { now = Date.now } = {}) {
  writePrivateFileAtomic(file, `${JSON.stringify({ version: 1, cleared: true, clearedAt: new Date(now()).toISOString() }, null, 2)}\n`);
}

module.exports = { writePasswordRecord, clearPasswordRecord };
