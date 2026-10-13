'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { SCRYPT, readPasswordRecord, recordShapeOk } = require('./password');

/*
 * ADR 0054 (docs/decisions/0054-gm-access-from-the-player-site.md), sections 2 and 3. Named GM
 * accounts: the username rule and the READ-ONLY reader of panel/accounts.json.
 *
 * This module is read-only with respect to the filesystem, exactly like password.js, and it is in
 * the panel's own module graph. Its requires are exactly `fs`, `crypto` and `./password`, so the
 * panel never reaches a writer through it (test/remote-structure.test.js, test (f)). The writers
 * live in passwordwrite.js.
 *
 * Nothing is rewritten on read. An install that only has the older password.json reads as one
 * account named "gm", and the file stays as it is until the first `gm-scriptorium remote account`
 * command writes accounts.json.
 */

const MAX_ACCOUNTS = 8;
/** 1 to 32 ASCII letters, digits, dots, hyphens or underscores, starting with a letter or digit. */
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * The one canonical form of a username: NFC, ASCII only, lower case. ASCII only on purpose: a
 * name anyone can try from a public page must have no confusable look-alikes and no locale case
 * folding. (Under the ASCII rule the NFC step changes nothing a person could observe; it stays so
 * that widening the rule later keeps one pipeline.)
 *
 * @param {unknown} raw
 * @returns {string|null} the canonical name, or null when it is not a valid username
 */
function canonicalUsername(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFC');
  if (!USERNAME_RE.test(n)) return null;
  return n.toLowerCase();
}

/*
 * A record that is never a valid password. Sign-in verifies against this when the username is
 * unknown, so an unknown name costs exactly one scrypt run with the real parameters, the same as
 * a known one. Made fresh at module load: random salt, random hash, nothing derived from input.
 */
const DUMMY_RECORD = Object.freeze({
  version: 1,
  algorithm: 'scrypt',
  'N': SCRYPT.N,
  r: SCRYPT.r,
  p: SCRYPT.p,
  keylen: SCRYPT.keylen,
  salt: crypto.randomBytes(SCRYPT.saltBytes).toString('base64'),
  hash: crypto.randomBytes(SCRYPT.keylen).toString('base64'),
  setAt: '1970-01-01T00:00:00.000Z',
});

function invalid(message) {
  return { state: 'invalid', message };
}

/** The password part of an accounts.json entry, in the exact shape password.verifyPassword takes. */
function passwordPart(entry) {
  return {
    version: entry.version,
    algorithm: entry.algorithm,
    'N': entry.N,
    r: entry.r,
    p: entry.p,
    keylen: entry.keylen,
    salt: entry.salt,
    hash: entry.hash,
    setAt: entry.setAt,
  };
}

/** accounts.json alone: { state: 'absent' } when the file does not exist. */
function readAccountsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' };
    return invalid(`could not read the accounts file (${err.code || 'error'})`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return invalid('the accounts file is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1) {
    return invalid('the accounts file is not in a form this version understands');
  }
  if (doc.cleared === true) return { state: 'cleared' };
  if (!Array.isArray(doc.accounts)) return invalid('the accounts file is not in a form this version understands');
  if (doc.accounts.length > MAX_ACCOUNTS) return invalid(`the accounts file lists more than ${MAX_ACCOUNTS} accounts`);
  const seen = new Set();
  const list = [];
  for (const entry of doc.accounts) {
    if (!recordShapeOk(entry) || typeof entry.name !== 'string' || typeof entry.fromEarlierPassword !== 'boolean') {
      return invalid('the accounts file has an entry this version does not understand');
    }
    if (canonicalUsername(entry.name) !== entry.name) return invalid('the accounts file has a name that is not in its canonical form');
    if (seen.has(entry.name)) return invalid('the accounts file names one account twice');
    seen.add(entry.name);
    list.push({ name: entry.name, record: passwordPart(entry), fromEarlierPassword: entry.fromEarlierPassword });
  }
  return list.length === 0 ? { state: 'unset' } : { state: 'set', source: 'accounts', accounts: list };
}

/**
 * accounts.json when it exists, in any form (it wins); otherwise the older password.json, read as
 * the one account "gm". Nothing is written.
 *
 * @param {{ accountsFile: string, passwordFile: string }} paths
 * @returns {{ state: 'set', source: 'accounts'|'legacy', accounts: { name: string, record: object, fromEarlierPassword: boolean }[] } | { state: 'unset' } | { state: 'cleared' } | { state: 'invalid', message: string }}
 */
function readAccounts(paths) {
  const own = readAccountsFile(paths.accountsFile);
  if (own.state !== 'absent') return own;
  const legacy = readPasswordRecord(paths.passwordFile);
  if (legacy.state === 'set') {
    return { state: 'set', source: 'legacy', accounts: [{ name: 'gm', record: legacy.record, fromEarlierPassword: true }] };
  }
  return legacy;
}

/**
 * @param {{ name: string }[]|undefined} list the `accounts` of a readAccounts result
 * @param {unknown} key a canonical name (or the lockout's invalid-name key)
 * @returns {{ name: string, record: object, fromEarlierPassword: boolean }|null}
 */
function findAccount(list, key) {
  if (!Array.isArray(list) || typeof key !== 'string' || key === '') return null;
  return list.find((a) => a.name === key) || null;
}

module.exports = { MAX_ACCOUNTS, USERNAME_RE, canonicalUsername, readAccounts, findAccount, DUMMY_RECORD };
