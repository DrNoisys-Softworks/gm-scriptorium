'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');

/*
 * V1.5a (SD-a5). The expected hash below is computed in the TEST with crypto.scryptSync (which
 * src/ may never call: test/remote-structure.test.js) from independently typed parameters, so the
 * module's output is compared against an oracle it does not share code with.
 */

const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const fixedRandom = (n) => {
  assert.equal(n, 16);
  return Buffer.from(SALT);
};

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('SCRYPT parameters are the stated literals', () => {
  assert.deepEqual({ ...pw.SCRYPT }, { 'N': 32768, r: 8, p: 3, keylen: 64, saltBytes: 16, maxmem: 64 * 1024 * 1024 });
  assert.ok(Object.isFrozen(pw.SCRYPT));
});

test('hashPassword: record fields, with the hash equal to an independent scrypt of the NFC form', async () => {
  const rec = await pw.hashPassword('correct horse battery', { randomBytes: fixedRandom, now: () => Date.UTC(2026, 9, 3, 1, 2, 3) });
  assert.equal(rec.version, 1);
  assert.equal(rec.algorithm, 'scrypt');
  assert.equal(rec.N, 32768);
  assert.equal(rec.r, 8);
  assert.equal(rec.p, 3);
  assert.equal(rec.keylen, 64);
  assert.equal(rec.salt, SALT.toString('base64'));
  assert.equal(rec.setAt, '2026-10-03T01:02:03.000Z');
  const oracle = crypto.scryptSync('correct horse battery'.normalize('NFC'), SALT, 64, { 'N': 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  assert.equal(rec.hash, oracle.toString('base64'));
  assert.deepEqual(Object.keys(rec).sort(), ['N', 'algorithm', 'hash', 'keylen', 'p', 'r', 'salt', 'setAt', 'version']);
});

test('hashPassword returns a Promise (asynchronous scrypt), and verifyPassword does too', () => {
  const a = pw.hashPassword('correct horse battery');
  assert.ok(a instanceof Promise);
  const b = pw.verifyPassword('x', {});
  assert.ok(b instanceof Promise);
  return Promise.all([a, b]);
});

test('hashPassword draws a fresh salt each time', async () => {
  const a = await pw.hashPassword('correct horse battery');
  const b = await pw.hashPassword('correct horse battery');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('verifyPassword: the right password passes (positive control, argument order pw then record), a wrong one fails', async () => {
  const rec = await pw.hashPassword('correct horse battery');
  assert.equal(await pw.verifyPassword('correct horse battery', rec), true);
  assert.equal(await pw.verifyPassword('correct horse batterz', rec), false);
  assert.equal(await pw.verifyPassword('', rec), false);
  assert.equal(await pw.verifyPassword('Correct horse battery', rec), false);
});

test('Ma9 pin: swapping the arguments never verifies', async () => {
  const rec = await pw.hashPassword('correct horse battery');
  assert.equal(await pw.verifyPassword(rec, 'correct horse battery'), false);
});

test('NFC: a decomposed password verifies against a composed one and the reverse', async () => {
  const composed = 'café au lait 123';
  const decomposed = 'café au lait 123';
  assert.notEqual(composed, decomposed);
  const a = await pw.hashPassword(decomposed);
  assert.equal(await pw.verifyPassword(composed, a), true);
  const b = await pw.hashPassword(composed);
  assert.equal(await pw.verifyPassword(decomposed, b), true);
  // and the NFD hash really is over the NFC bytes (independent oracle)
  const oracle = crypto.scryptSync(composed, Buffer.from(a.salt, 'base64'), 64, { 'N': 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  assert.equal(a.hash, oracle.toString('base64'));
});

test('verifyPassword bounds-checks the stored parameters and never throws', async () => {
  const good = await pw.hashPassword('correct horse battery');
  const variants = [
    { ...good, 'N': 3 }, // not a power of two
    { ...good, 'N': 2 ** 21 }, // above the ceiling
    { ...good, 'N': 2 ** 13 }, // below the floor
    { ...good, r: 0 },
    { ...good, r: 33 },
    { ...good, p: 0 },
    { ...good, p: 17 },
    { ...good, keylen: 48 },
    { ...good, algorithm: 'md5' },
    { ...good, salt: '' },
    { ...good, hash: 'AAAA' }, // wrong length for keylen
    { ...good, salt: 42 },
    null,
    undefined,
    'a string',
    {},
  ];
  for (const rec of variants) assert.equal(await pw.verifyPassword('correct horse battery', rec), false);
  assert.equal(await pw.verifyPassword(undefined, good), false);
  assert.equal(await pw.verifyPassword(12345, good), false);
});

test('verifyPassword with a larger-but-allowed stored cost still verifies', async () => {
  const salt = Buffer.alloc(16, 7);
  const key = crypto.scryptSync('correct horse battery', salt, 32, { 'N': 16384, r: 8, p: 1 });
  const rec = { version: 1, algorithm: 'scrypt', 'N': 16384, r: 8, p: 1, keylen: 32, salt: salt.toString('base64'), hash: key.toString('base64'), setAt: '2026-10-03T00:00:00.000Z' };
  assert.equal(await pw.verifyPassword('correct horse battery', rec), true);
});

test('readPasswordRecord: unset, set, cleared and invalid states', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'panel', 'password.json');
  assert.deepEqual(pw.readPasswordRecord(file), { state: 'unset' });

  const rec = await pw.hashPassword('correct horse battery');
  pwWrite.writePasswordRecord(file, rec);
  const set = pw.readPasswordRecord(file);
  assert.equal(set.state, 'set');
  assert.deepEqual(set.record, rec);

  pwWrite.clearPasswordRecord(file, { now: () => Date.UTC(2026, 9, 3) });
  assert.deepEqual(pw.readPasswordRecord(file), { state: 'cleared' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, cleared: true, clearedAt: '2026-10-03T00:00:00.000Z' });

  fs.writeFileSync(file, '{not json');
  assert.equal(pw.readPasswordRecord(file).state, 'invalid');
  fs.writeFileSync(file, JSON.stringify({ version: 1, algorithm: 'scrypt', 'N': 3 }));
  assert.equal(pw.readPasswordRecord(file).state, 'invalid');
  fs.writeFileSync(file, JSON.stringify({ version: 2, cleared: true }));
  assert.equal(pw.readPasswordRecord(file).state, 'invalid');
  fs.writeFileSync(file, 'null');
  assert.equal(pw.readPasswordRecord(file).state, 'invalid');
});

test('readPasswordRecord reports a directory-in-the-way as invalid, with a message that holds no secret', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'password.json');
  fs.mkdirSync(file);
  const out = pw.readPasswordRecord(file);
  assert.equal(out.state, 'invalid');
  assert.equal(typeof out.message, 'string');
});

test('writePasswordRecord stores the record as JSON at 0600 and a re-read verifies', { skip: process.platform === 'win32' }, async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'panel', 'password.json');
  const rec = await pw.hashPassword('correct horse battery');
  pwWrite.writePasswordRecord(file, rec);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await pw.verifyPassword('correct horse battery', pw.readPasswordRecord(file).record), true);
  // the plain password is nowhere in the file
  assert.ok(!fs.readFileSync(file, 'utf8').includes('correct horse battery'));
});
