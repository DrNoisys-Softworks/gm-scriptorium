'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pw = require('../src/remote/password');
const { remotePaths } = require('../src/remote/paths');
const accounts = require('../src/remote/accounts');

/*
 * ADR 0054 sections 2 and 3. The username rule and the read-only accounts reader. Expected values
 * are typed here, never read from the constants under test. The reader must never write: the
 * legacy-fallback tests assert that nothing appears on disk and that password.json is untouched.
 */

let sharedRecord = null;
async function record() {
  if (sharedRecord === null) sharedRecord = await pw.hashPassword('correct horse battery');
  return sharedRecord;
}

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-accounts-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = remotePaths(path.join(dir, 'config.toml'));
  fs.mkdirSync(paths.panelDir, { recursive: true });
  return paths;
}

function entry(rec, name, fromEarlierPassword = false) {
  return { name, ...rec, fromEarlierPassword };
}

function writeAccountsFile(paths, list, extra = {}) {
  fs.writeFileSync(paths.accountsFile, JSON.stringify({ version: 1, accounts: list, ...extra }));
}

// --- canonicalUsername ----------------------------------------------------------------------

test('canonicalUsername: the accepted and refused table, one expected answer per row', () => {
  const rows = [
    ['rook', 'rook'],
    ['Rook', 'rook'],
    ['ROOK', 'rook'],
    ['a', 'a'],
    ['9', '9'],
    ['a'.repeat(32), 'a'.repeat(32)],
    ['A'.repeat(32), 'a'.repeat(32)],
    ['a'.repeat(33), null],
    ['', null],
    ['.rook', null],
    ['-rook', null],
    ['_rook', null],
    ['r.o-o_k', 'r.o-o_k'],
    ['9lives', '9lives'],
    ['ro ok', null],
    [' rook', null],
    ['rook ', null],
    ['rook\n', null],
    ['röok', null],
    ['ｒook', null], // fullwidth r
    ['ŕook', null], // r with a combining accent (decomposed form)
    ['é', null], // NFD input
    ['é', null], // the composed form of the same letter
    ['ro/ok', null],
    ['ro:ok', null],
    ['\u0000', null],
  ];
  for (const [input, expected] of rows) assert.equal(accounts.canonicalUsername(input), expected, JSON.stringify(input));
});

test('canonicalUsername: anything that is not a string is refused, never thrown on', () => {
  for (const bad of [undefined, null, 5, {}, [], ['rook'], true]) {
    assert.equal(accounts.canonicalUsername(bad), null, String(bad));
  }
});

test('constants: the cap is 8 and the rule is a regular expression that matches what the table accepts', () => {
  assert.equal(accounts.MAX_ACCOUNTS, 8);
  assert.ok(accounts.USERNAME_RE instanceof RegExp);
  assert.equal(accounts.USERNAME_RE.test('Rook'), true);
  assert.equal(accounts.USERNAME_RE.test('.x'), false);
});

// --- readAccounts: nothing on disk ------------------------------------------------------------

test('readAccounts: neither file exists gives unset', (t) => {
  const paths = scratch(t);
  assert.deepEqual(accounts.readAccounts(paths), { state: 'unset' });
});

test('readAccounts: a missing panel folder also gives unset (not an error)', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-accounts-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(accounts.readAccounts(remotePaths(path.join(dir, 'config.toml'))), { state: 'unset' });
});

// --- readAccounts: the legacy fallback, with nothing written ----------------------------------

test('readAccounts: only password.json gives the legacy account gm, and NOTHING is written', async (t) => {
  const paths = scratch(t);
  const rec = await record();
  fs.writeFileSync(paths.passwordFile, JSON.stringify(rec));
  const old = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(paths.passwordFile, old, old);
  const before = fs.statSync(paths.passwordFile);
  const listing = fs.readdirSync(paths.panelDir).sort();

  const out = accounts.readAccounts(paths);
  assert.deepEqual(out, { state: 'set', source: 'legacy', accounts: [{ name: 'gm', record: rec, fromEarlierPassword: true }] });

  assert.equal(fs.existsSync(paths.accountsFile), false, 'accounts.json must not be created by a read');
  assert.deepEqual(fs.readdirSync(paths.panelDir).sort(), listing);
  const after = fs.statSync(paths.passwordFile);
  assert.equal(after.mtimeMs, before.mtimeMs, 'password.json mtime is unchanged');
  assert.equal(after.mtimeMs, old.getTime());
  assert.equal(fs.readFileSync(paths.passwordFile, 'utf8'), JSON.stringify(rec));
});

test('readAccounts: the other password.json states pass through', (t) => {
  const paths = scratch(t);
  fs.writeFileSync(paths.passwordFile, JSON.stringify({ version: 1, cleared: true, clearedAt: '2026-10-01T00:00:00.000Z' }));
  assert.deepEqual(accounts.readAccounts(paths), { state: 'cleared' });
  fs.writeFileSync(paths.passwordFile, '{ nope');
  const bad = accounts.readAccounts(paths);
  assert.equal(bad.state, 'invalid');
  assert.equal(typeof bad.message, 'string');
});

// --- readAccounts: accounts.json --------------------------------------------------------------

test('readAccounts: accounts.json gives its names, in file order, as source accounts', async (t) => {
  const paths = scratch(t);
  const rec = await record();
  writeAccountsFile(paths, [entry(rec, 'rook'), entry(rec, 'gm', true), entry(rec, 'saffron')]);
  const out = accounts.readAccounts(paths);
  assert.equal(out.state, 'set');
  assert.equal(out.source, 'accounts');
  assert.deepEqual(
    out.accounts.map((a) => [a.name, a.fromEarlierPassword]),
    [
      ['rook', false],
      ['gm', true],
      ['saffron', false],
    ],
  );
  assert.equal(out.accounts[0].record.hash, rec.hash);
  assert.equal(out.accounts[0].record.name, undefined, 'the record handed to verifyPassword is the password part only');
  assert.equal(out.accounts[0].record.fromEarlierPassword, undefined);
});

test('readAccounts: PRECEDENCE, accounts.json wins over a set password.json', async (t) => {
  const paths = scratch(t);
  const rec = await record();
  fs.writeFileSync(paths.passwordFile, JSON.stringify(rec));
  writeAccountsFile(paths, [entry(rec, 'rook')]);
  const out = accounts.readAccounts(paths);
  assert.equal(out.source, 'accounts');
  assert.deepEqual(out.accounts.map((a) => a.name), ['rook']);
});

test('readAccounts: a cleared accounts.json wins over a set password.json (remote off stays off)', async (t) => {
  const paths = scratch(t);
  fs.writeFileSync(paths.passwordFile, JSON.stringify(await record()));
  fs.writeFileSync(paths.accountsFile, JSON.stringify({ version: 1, cleared: true, clearedAt: '2026-10-01T00:00:00.000Z' }));
  assert.deepEqual(accounts.readAccounts(paths), { state: 'cleared' });
});

test('readAccounts: an invalid accounts.json wins too (it never falls back to password.json)', async (t) => {
  const paths = scratch(t);
  fs.writeFileSync(paths.passwordFile, JSON.stringify(await record()));
  fs.writeFileSync(paths.accountsFile, '{ broken');
  assert.equal(accounts.readAccounts(paths).state, 'invalid');
});

test('readAccounts: an empty list is unset, and still wins over password.json', async (t) => {
  const paths = scratch(t);
  fs.writeFileSync(paths.passwordFile, JSON.stringify(await record()));
  writeAccountsFile(paths, []);
  assert.deepEqual(accounts.readAccounts(paths), { state: 'unset' });
});

test('readAccounts: the cap is 8 entries, a ninth makes the whole file invalid', async (t) => {
  const paths = scratch(t);
  const rec = await record();
  const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
  writeAccountsFile(paths, names.slice(0, 8).map((n) => entry(rec, n)));
  assert.equal(accounts.readAccounts(paths).state, 'set');
  writeAccountsFile(paths, names.map((n) => entry(rec, n)));
  assert.equal(accounts.readAccounts(paths).state, 'invalid');
});

test('readAccounts: every invalid form fails the whole file closed', async (t) => {
  const paths = scratch(t);
  const rec = await record();
  const good = entry(rec, 'rook');
  const forms = {
    'not JSON': '{ nope',
    'an array at the top': '[]',
    'a null': 'null',
    'version 2': JSON.stringify({ version: 2, accounts: [good] }),
    'accounts not an array': JSON.stringify({ version: 1, accounts: { rook: good } }),
    'an entry that is not an object': JSON.stringify({ version: 1, accounts: [good, 'x'] }),
    'an entry with no hash': JSON.stringify({ version: 1, accounts: [good, { ...entry(rec, 'saffron'), hash: undefined }] }),
    'an entry with a hash that is not a string': JSON.stringify({ version: 1, accounts: [{ ...good, hash: 5 }] }),
    'an entry with parameters out of bounds': JSON.stringify({ version: 1, accounts: [{ ...good, N: 4 }] }),
    'an entry with a different algorithm': JSON.stringify({ version: 1, accounts: [{ ...good, algorithm: 'md5' }] }),
    'a name in capitals': JSON.stringify({ version: 1, accounts: [entry(rec, 'Rook')] }),
    'a name with a space': JSON.stringify({ version: 1, accounts: [entry(rec, 'ro ok')] }),
    'a name of 33 characters': JSON.stringify({ version: 1, accounts: [entry(rec, 'a'.repeat(33))] }),
    'a name that is not a string': JSON.stringify({ version: 1, accounts: [{ ...good, name: 5 }] }),
    'no name': JSON.stringify({ version: 1, accounts: [{ ...good, name: undefined }] }),
    'repeated names': JSON.stringify({ version: 1, accounts: [good, entry(rec, 'rook')] }),
    'fromEarlierPassword not a boolean': JSON.stringify({ version: 1, accounts: [{ ...good, fromEarlierPassword: 'no' }] }),
    'an empty file': '',
  };
  for (const [label, text] of Object.entries(forms)) {
    fs.writeFileSync(paths.accountsFile, text);
    const out = accounts.readAccounts(paths);
    assert.equal(out.state, 'invalid', label);
    assert.equal(typeof out.message, 'string', label);
    assert.ok(!out.message.includes(rec.hash), `${label}: the message never carries a hash`);
  }
});

test('readAccounts: an unreadable accounts.json (a folder in its place) is invalid, not a throw', (t) => {
  const paths = scratch(t);
  fs.mkdirSync(paths.accountsFile);
  assert.equal(accounts.readAccounts(paths).state, 'invalid');
});

test('readAccounts never writes: the listing of the panel folder is identical after every read above', async (t) => {
  const paths = scratch(t);
  const rec = await record();
  writeAccountsFile(paths, [entry(rec, 'rook')]);
  const before = fs.readdirSync(paths.panelDir).sort();
  const mtime = fs.statSync(paths.accountsFile).mtimeMs;
  accounts.readAccounts(paths);
  accounts.readAccounts(paths);
  assert.deepEqual(fs.readdirSync(paths.panelDir).sort(), before);
  assert.equal(fs.statSync(paths.accountsFile).mtimeMs, mtime);
});

// --- findAccount -------------------------------------------------------------------------------

test('findAccount: by the canonical key, and null for an unknown, empty or non-string key', async (t) => {
  const paths = scratch(t);
  const rec = await record();
  writeAccountsFile(paths, [entry(rec, 'rook'), entry(rec, 'saffron')]);
  const list = accounts.readAccounts(paths).accounts;
  assert.equal(accounts.findAccount(list, 'rook').name, 'rook');
  assert.equal(accounts.findAccount(list, 'saffron').name, 'saffron');
  assert.equal(accounts.findAccount(list, 'nobody'), null);
  assert.equal(accounts.findAccount(list, ''), null);
  assert.equal(accounts.findAccount(list, undefined), null);
  assert.equal(accounts.findAccount(list, '\u0000'), null);
  assert.equal(accounts.findAccount(undefined, 'rook'), null);
  assert.equal(accounts.findAccount(list, '__proto__'), null);
});

// --- DUMMY_RECORD ------------------------------------------------------------------------------

test('DUMMY_RECORD: frozen, the same scrypt cost as a real record, random salt and hash, never a valid password', async () => {
  const d = accounts.DUMMY_RECORD;
  assert.ok(Object.isFrozen(d));
  assert.equal(d.algorithm, 'scrypt');
  assert.equal(d.N, 32768);
  assert.equal(d.r, 8);
  assert.equal(d.p, 3);
  assert.equal(d.keylen, 64);
  assert.equal(Buffer.from(d.salt, 'base64').length, 16);
  assert.equal(Buffer.from(d.hash, 'base64').length, 64);
  const real = await record();
  for (const key of ['algorithm', 'N', 'r', 'p', 'keylen']) assert.equal(d[key], real[key], key);
  assert.equal(await pw.verifyPassword('correct horse battery', d), false);
  assert.equal(await pw.verifyPassword('', d), false);
});

test('DUMMY_RECORD is made fresh at module load: a second load has a different salt and hash', () => {
  const key = require.resolve('../src/remote/accounts');
  const first = accounts.DUMMY_RECORD;
  delete require.cache[key];
  try {
    const second = require('../src/remote/accounts').DUMMY_RECORD;
    assert.notEqual(second.salt, first.salt);
    assert.notEqual(second.hash, first.hash);
  } finally {
    delete require.cache[key];
    require('../src/remote/accounts');
  }
});

// --- the writers (passwordwrite.js), through the reader -----------------------------------------

const posix = { skip: process.platform === 'win32' ? 'POSIX modes only' : false };

test('writeAccounts then readAccounts round-trips names, flags and records, and the file is 0600 in a 0700 folder', posix, async (t) => {
  const { writeAccounts } = require('../src/remote/passwordwrite');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-accounts-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = remotePaths(path.join(dir, 'config.toml'));
  const rec = await record();
  writeAccounts(paths.accountsFile, [
    { name: 'gm', record: rec, fromEarlierPassword: true },
    { name: 'rook', record: rec, fromEarlierPassword: false },
  ]);
  assert.equal(fs.statSync(paths.accountsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.panelDir).mode & 0o777, 0o700);
  const out = accounts.readAccounts(paths);
  assert.equal(out.state, 'set');
  assert.equal(out.source, 'accounts');
  assert.deepEqual(out.accounts.map((a) => [a.name, a.fromEarlierPassword]), [['gm', true], ['rook', false]]);
  assert.equal(out.accounts[1].record.hash, rec.hash);
  const onDisk = JSON.parse(fs.readFileSync(paths.accountsFile, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(Object.keys(onDisk.accounts[0]).sort(), ['N', 'algorithm', 'fromEarlierPassword', 'hash', 'keylen', 'name', 'p', 'r', 'salt', 'setAt', 'version']);
});

test('writeAccounts refuses a panel folder that is a symlink, and replaces (never follows) a symlinked file', posix, async (t) => {
  const { writeAccounts } = require('../src/remote/passwordwrite');
  const rec = await record();
  const list = [{ name: 'rook', record: rec, fromEarlierPassword: false }];

  const linked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-accounts-')));
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  const real = path.join(linked, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(linked, 'panel'));
  assert.throws(() => writeAccounts(path.join(linked, 'panel', 'accounts.json'), list), /must be a real folder, not a link/);
  assert.deepEqual(fs.readdirSync(real), []);

  const paths = scratch(t);
  const elsewhere = path.join(path.dirname(paths.panelDir), 'elsewhere.json');
  fs.writeFileSync(elsewhere, 'keep');
  fs.symlinkSync(elsewhere, paths.accountsFile);
  writeAccounts(paths.accountsFile, list);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'keep', 'the link target is untouched');
  assert.equal(fs.lstatSync(paths.accountsFile).isSymbolicLink(), false);
});

test('clearAccounts writes the cleared form with the injected time, and the reader says cleared', (t) => {
  const { clearAccounts } = require('../src/remote/passwordwrite');
  const paths = scratch(t);
  clearAccounts(paths.accountsFile, { now: () => Date.UTC(2026, 9, 12, 1, 2, 3) });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.accountsFile, 'utf8')), { version: 1, cleared: true, clearedAt: '2026-10-12T01:02:03.000Z' });
  assert.deepEqual(accounts.readAccounts(paths), { state: 'cleared' });
});
