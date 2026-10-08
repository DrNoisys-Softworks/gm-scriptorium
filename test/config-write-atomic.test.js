'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serializeConfig, writeConfigFile } = require('../src/config/write');
const { runConfigCommand } = require('../src/cli/config');
const { ConfigError } = require('../src/util/errors');

/*
 * ADR 0050 section 6: writeConfigFile is a temp file plus a rename in the config's own folder, for
 * every caller. The bytes are what the canonical emitter produced before, written to a temp file
 * that is flushed, then renamed over the target. Every fs call goes through the module object, so
 * the spies below are the proof, and the fault-injection tests prove that a failure leaves the old
 * file untouched and nothing behind. Expected bytes are written out by hand where they matter.
 */

const IS_POSIX = process.platform !== 'win32';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SAMPLE = {
  config_version: 1,
  default_campaign: 'a',
  campaigns: { a: { vault: '/v/a', output: '/o/a' }, b: { vault: '/v/b', output: '/o/b' } },
};

const OLD_TEXT = '# an older config\nconfig_version = 1\n';

function leftovers(dir) {
  return fs.readdirSync(dir).filter((n) => n.includes('scriptorium-tmp'));
}

/** Replaces fs[name] for the duration of a test. */
function patch(t, name, wrapper) {
  const original = fs[name];
  fs[name] = wrapper(original);
  t.after(() => {
    fs[name] = original;
  });
}

test('the written bytes equal the canonical emitter output for a hand-written config', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  writeConfigFile(file, SAMPLE);
  const expected = [
    '# Scriptorium config.',
    '#',
    '# Hand-editable TOML. Rewritten by "config add" / "config remove" /',
    '# "config set-default" using a canonical emitter: fixed key order, this',
    '# header regenerated each time. Comments you add elsewhere in this file',
    '# will NOT survive the next rewrite; unrecognised keys will.',
    '#',
    '# [campaigns.<name>.paths.<profile>] tables are per-machine overrides.',
    '# See docs/decisions for the resolution rules (platform/hostname match,',
    '# specificity, --vault/--out overrides, SCRIPTORIUM_PROFILE).',
    '',
    'config_version = 1',
    'default_campaign = "a"',
    '',
    '[campaigns.a]',
    'vault = "/v/a"',
    'output = "/o/a"',
    '',
    '[campaigns.b]',
    'vault = "/v/b"',
    'output = "/o/b"',
    '',
    '',
  ].join('\n');
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
  assert.equal(fs.readFileSync(file, 'utf8'), serializeConfig(SAMPLE));
});

test('one rename: at that moment the temp file in the same folder holds the new bytes and the target still holds the old', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, OLD_TEXT);
  const seen = [];
  patch(t, 'renameSync', (orig) => (from, to) => {
    seen.push({
      from,
      to,
      fromText: fs.readFileSync(from, 'utf8'),
      toText: fs.readFileSync(to, 'utf8'),
    });
    return orig(from, to);
  });
  writeConfigFile(file, SAMPLE);
  assert.equal(seen.length, 1);
  assert.equal(path.dirname(seen[0].from), dir);
  assert.match(path.basename(seen[0].from), /^\.config\.toml\.scriptorium-tmp-\d+-[0-9a-f]{12}$/);
  assert.equal(fs.realpathSync(path.dirname(seen[0].to)), fs.realpathSync(dir));
  assert.equal(seen[0].fromText, serializeConfig(SAMPLE));
  assert.equal(seen[0].toText, OLD_TEXT);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(fs.readFileSync(file, 'utf8'), serializeConfig(SAMPLE));
});

test('the temp file is flushed (fsync) before the rename', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  const order = [];
  patch(t, 'fsyncSync', (orig) => (fd) => {
    order.push('fsync');
    return orig(fd);
  });
  patch(t, 'renameSync', (orig) => (a, b) => {
    order.push('rename');
    return orig(a, b);
  });
  writeConfigFile(file, SAMPLE);
  assert.deepEqual(order, ['fsync', 'rename']);
});

test('a write that throws leaves the original byte-identical and no temp file behind', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, OLD_TEXT);
  patch(t, 'writeSync', () => () => {
    const err = new Error('disk full');
    err.code = 'ENOSPC';
    throw err;
  });
  assert.throws(() => writeConfigFile(file, SAMPLE), /disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), OLD_TEXT);
  assert.deepEqual(leftovers(dir), []);
});

test('EPERM twice, then success: the write lands and no temp is left', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, OLD_TEXT);
  let calls = 0;
  patch(t, 'renameSync', (orig) => (a, b) => {
    calls++;
    if (calls <= 2) {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    return orig(a, b);
  });
  writeConfigFile(file, SAMPLE);
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), serializeConfig(SAMPLE));
  assert.deepEqual(leftovers(dir), []);
});

test('EPERM on every attempt: the bounded retry gives up, throws the original error, keeps the original and leaves no temp', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, OLD_TEXT);
  let calls = 0;
  patch(t, 'renameSync', () => () => {
    calls++;
    const err = new Error('operation not permitted');
    err.code = 'EPERM';
    throw err;
  });
  assert.throws(() => writeConfigFile(file, SAMPLE), (err) => err.code === 'EPERM');
  assert.equal(calls, 6, 'one try plus five retries');
  assert.equal(fs.readFileSync(file, 'utf8'), OLD_TEXT);
  assert.deepEqual(leftovers(dir), []);
});

test('a code that is not a sharing violation is not retried', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  let calls = 0;
  patch(t, 'renameSync', () => () => {
    calls++;
    const err = new Error('no space');
    err.code = 'ENOSPC';
    throw err;
  });
  assert.throws(() => writeConfigFile(file, SAMPLE), (err) => err.code === 'ENOSPC');
  assert.equal(calls, 1);
  assert.deepEqual(leftovers(dir), []);
});

test('a new file in a new folder is created (the folder is made first)', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'deeper', 'cfg', 'config.toml');
  writeConfigFile(file, SAMPLE);
  assert.equal(fs.readFileSync(file, 'utf8'), serializeConfig(SAMPLE));
  assert.deepEqual(leftovers(path.dirname(file)), []);
});

test('POSIX: a 0600 config stays 0600', { skip: !IS_POSIX && 'POSIX modes only' }, (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, OLD_TEXT, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  writeConfigFile(file, SAMPLE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('POSIX: a symlinked config stays a symlink and its target is updated', { skip: !IS_POSIX && 'POSIX symlinks only' }, (t) => {
  const dir = scratch(t);
  const realDir = path.join(dir, 'real');
  fs.mkdirSync(realDir);
  const target = path.join(realDir, 'config.toml');
  fs.writeFileSync(target, OLD_TEXT);
  const link = path.join(dir, 'config.toml');
  fs.symlinkSync(target, link);
  writeConfigFile(link, SAMPLE);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), serializeConfig(SAMPLE));
  assert.deepEqual(leftovers(dir), []);
  assert.deepEqual(leftovers(realDir), []);
});

// --- every caller goes through it -------------------------------------------------------------------

test('the CLI config add, set-default and remove each go through the rename (every caller is atomic)', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  writeConfigFile(file, SAMPLE);
  let renames = 0;
  patch(t, 'renameSync', (orig) => (a, b) => {
    renames++;
    return orig(a, b);
  });
  runConfigCommand({ config: file }, 'set-default', ['b']);
  assert.equal(renames, 1);
  // add needs --vault and --out; without them it refuses before writing, so still one rename.
  assert.throws(() => runConfigCommand({ config: file }, 'add', ['c']), ConfigError);
  assert.equal(renames, 1);
  runConfigCommand({ config: file, vault: '/v/c', out: '/o/c' }, 'add', ['c']);
  assert.equal(renames, 2);
  runConfigCommand({ config: file }, 'remove', ['a']);
  assert.equal(renames, 3);
  assert.deepEqual(leftovers(dir), []);
});

test('the in-vault refusal still writes nothing: no temp file, no target', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'vault', 'config.toml');
  fs.mkdirSync(path.dirname(file));
  const config = { config_version: 1, campaigns: { a: { vault: path.join(dir, 'vault') } } };
  assert.throws(() => writeConfigFile(file, config), ConfigError);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(leftovers(path.dirname(file)), []);
});
