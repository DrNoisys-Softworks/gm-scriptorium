'use strict';

const fs = require('fs');
const crypto = require('crypto');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, section 6). The panel password: an ASYNCHRONOUS
 * crypto.scrypt (never scryptSync, which would stall the event loop for the whole hash: pinned
 * by test/remote-structure.test.js), a random salt, the cost parameters stored beside the hash,
 * and a constant-time compare. Both sides are NFC-normalised, so the same visible password typed
 * in a different Unicode form (a decomposed accent from one keyboard, a composed one from
 * another) is still the same password.
 *
 * This module is READ-ONLY with respect to the filesystem. The writers live in passwordwrite.js,
 * which the panel's own module graph never reaches (test/remote-structure.test.js).
 */

const SCRYPT = Object.freeze({ 'N': 32768, r: 8, p: 3, keylen: 64, saltBytes: 16, maxmem: 64 * 1024 * 1024 });

function scryptAsync(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * @param {string} pw
 * @param {{ randomBytes?: (size: number) => Buffer, now?: () => number }} [opts]
 * @returns {Promise<object>} the password.json record
 */
async function hashPassword(pw, { randomBytes = crypto.randomBytes, now = Date.now } = {}) {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scryptAsync(pw.normalize('NFC'), salt, SCRYPT.keylen, {
    'N': SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return {
    version: 1,
    algorithm: 'scrypt',
    'N': SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
    salt: salt.toString('base64'),
    hash: key.toString('base64'),
    setAt: new Date(now()).toISOString(),
  };
}

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** The stored parameters must be sane before they reach scrypt (a hand-edited file can't DoS). */
function paramsInBounds(rec) {
  return (
    isPowerOfTwo(rec.N) &&
    rec.N >= 2 ** 14 &&
    rec.N <= 2 ** 20 &&
    Number.isInteger(rec.r) &&
    rec.r >= 1 &&
    rec.r <= 32 &&
    Number.isInteger(rec.p) &&
    rec.p >= 1 &&
    rec.p <= 16 &&
    (rec.keylen === 32 || rec.keylen === 64)
  );
}

/**
 * @param {string} pw
 * @param {object} record a password.json record
 * @returns {Promise<boolean>} false for any malformed record, never a throw
 */
async function verifyPassword(pw, record) {
  try {
    if (typeof pw !== 'string' || !record || record.algorithm !== 'scrypt' || !paramsInBounds(record)) return false;
    if (typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    if (salt.length === 0 || expected.length !== record.keylen) return false;
    const key = await scryptAsync(pw.normalize('NFC'), salt, record.keylen, {
      'N': record.N,
      r: record.r,
      p: record.p,
      maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

function recordShapeOk(rec) {
  return (
    rec &&
    typeof rec === 'object' &&
    rec.version === 1 &&
    rec.algorithm === 'scrypt' &&
    typeof rec.salt === 'string' &&
    typeof rec.hash === 'string' &&
    typeof rec.setAt === 'string' &&
    paramsInBounds(rec)
  );
}

/**
 * @param {string} file
 * @returns {{ state: 'set', record: object } | { state: 'unset' } | { state: 'cleared' } | { state: 'invalid', message: string }}
 */
function readPasswordRecord(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'unset' };
    return { state: 'invalid', message: `could not read the panel password file (${err.code || 'error'})` };
  }
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    return { state: 'invalid', message: 'the panel password file is not valid JSON' };
  }
  if (rec && typeof rec === 'object' && rec.version === 1 && rec.cleared === true) return { state: 'cleared' };
  if (!recordShapeOk(rec)) return { state: 'invalid', message: 'the panel password file is not in a form this version understands' };
  return { state: 'set', record: rec };
}

module.exports = { SCRYPT, hashPassword, verifyPassword, readPasswordRecord };
