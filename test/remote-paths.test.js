'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { remotePaths, assertNotInsideAnyVault } = require('../src/remote/paths');
const { ensurePrivateDir, writePrivateFileAtomic, appendPrivateLine } = require('../src/remote/privatefile');
const { resolveMachineDir } = require('../src/config/machinedir');
const { ConfigError, ScriptoriumError } = require('../src/util/errors');

/*
 * V1.5a (SD-a1). Where the panel's secrets live and how they are created. POSIX mode assertions
 * are skipped on Windows (modes mean nothing there; C68's ACL criterion covers it).
 */

const posix = { skip: process.platform === 'win32' ? 'POSIX modes only' : false };

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-paths-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('remotePaths: every path is derived from the directory of the resolved config path', () => {
  const p = remotePaths('/home/gm/.config/scriptorium/config.toml');
  assert.deepEqual(
    { ...p },
    {
      configDir: '/home/gm/.config/scriptorium',
      panelDir: '/home/gm/.config/scriptorium/panel',
      passwordFile: '/home/gm/.config/scriptorium/panel/password.json',
      sessionsFile: '/home/gm/.config/scriptorium/panel/sessions.json',
      auditFile: '/home/gm/.config/scriptorium/panel/audit.log',
      tlsDir: '/home/gm/.config/scriptorium/tls',
      generatedTlsFile: '/home/gm/.config/scriptorium/tls/generated.pem',
    },
  );
  assert.ok(Object.isFrozen(p));
});

test('remotePaths resolves a relative config path first, and a different config folder gives different files (isolation)', () => {
  const rel = remotePaths('some/dir/config.toml');
  assert.equal(rel.configDir, path.resolve('some/dir'));
  const a = remotePaths('/tmp/a/config.toml');
  const b = remotePaths('/tmp/b/config.toml');
  assert.notEqual(a.passwordFile, b.passwordFile);
  assert.notEqual(a.sessionsFile, b.sessionsFile);
  assert.notEqual(a.auditFile, b.auditFile);
});

test('Mf7 pin: configDir equals resolveMachineDir().dir, the folder backups and panel-prefs.json already use (A3)', (t) => {
  const dir = scratch(t);
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  const configPath = path.join(dir, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath));
  const machine = resolveMachineDir({ configPath, vaultPath: vault });
  assert.equal(machine.ok, true);
  assert.equal(remotePaths(configPath).configDir, machine.dir);
  // and `panel` sits beside the existing entries with no name collision
  assert.notEqual(path.basename(remotePaths(configPath).panelDir), 'backups');
  assert.notEqual(path.basename(remotePaths(configPath).panelDir), 'panel-prefs.json');
});

test('Ma15 pin: the panel folder is a child of the config folder, never of its parent', () => {
  const p = remotePaths('/home/gm/.config/scriptorium/config.toml');
  assert.equal(path.dirname(p.panelDir), p.configDir);
  assert.equal(path.dirname(p.configDir), '/home/gm/.config');
  assert.notEqual(path.dirname(p.panelDir), '/home/gm/.config');
});

// --- assertNotInsideAnyVault ---------------------------------------------------

test('assertNotInsideAnyVault: a folder beside the vault passes; inside it, or equal to it, is refused naming the campaign', (t) => {
  const dir = scratch(t);
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  const config = { campaigns: { alpha: { vault } } };
  assert.doesNotThrow(() => assertNotInsideAnyVault(path.join(dir, 'cfg', 'panel'), config));
  assert.throws(() => assertNotInsideAnyVault(path.join(vault, 'panel'), config), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /campaign "alpha"/);
    return true;
  });
  assert.throws(() => assertNotInsideAnyVault(vault, config), ConfigError);
});

test('Ma15c: a vault that is an ANCESTOR of the config folder is refused (the direction of the containment test)', (t) => {
  const dir = scratch(t);
  const vault = path.join(dir, 'vault');
  const panel = path.join(vault, 'deep', 'cfg', 'panel');
  fs.mkdirSync(path.dirname(panel), { recursive: true });
  assert.throws(() => assertNotInsideAnyVault(panel, { campaigns: { alpha: { vault } } }), ConfigError);
});

test('Ma15c control: a vault INSIDE the config folder does not put the panel folder inside the vault', (t) => {
  const dir = scratch(t);
  const cfg = path.join(dir, 'cfg');
  const vault = path.join(cfg, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  assert.doesNotThrow(() => assertNotInsideAnyVault(path.join(cfg, 'panel'), { campaigns: { alpha: { vault } } }));
});

test('assertNotInsideAnyVault: a sibling whose name merely starts with the vault name is not inside it (never startsWith)', (t) => {
  const dir = scratch(t);
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  fs.mkdirSync(path.join(dir, 'vault-notes'));
  assert.doesNotThrow(() => assertNotInsideAnyVault(path.join(dir, 'vault-notes', 'panel'), { campaigns: { alpha: { vault } } }));
});

test('assertNotInsideAnyVault checks EVERY campaign and every profile vault, not just the first', (t) => {
  const dir = scratch(t);
  const v1 = path.join(dir, 'v1');
  const v2 = path.join(dir, 'v2');
  const v3 = path.join(dir, 'v3');
  for (const v of [v1, v2, v3]) fs.mkdirSync(v);
  const config = { campaigns: { one: { vault: v1 }, two: { vault: v2, paths: { desk: { match: { platform: 'win32' }, vault: v3 } } } } };
  assert.throws(() => assertNotInsideAnyVault(path.join(v2, 'x'), config), /campaign "two"/);
  assert.throws(() => assertNotInsideAnyVault(path.join(v3, 'x'), config), /campaign "two"/);
  assert.doesNotThrow(() => assertNotInsideAnyVault(path.join(dir, 'elsewhere'), config));
});

test('assertNotInsideAnyVault follows symlinks: a config folder reached through a link into the vault is refused', posix, (t) => {
  const dir = scratch(t);
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  fs.symlinkSync(vault, path.join(dir, 'link'));
  assert.throws(() => assertNotInsideAnyVault(path.join(dir, 'link', 'panel'), { campaigns: { alpha: { vault } } }), ConfigError);
});

test('assertNotInsideAnyVault with no campaigns, or none registered, passes', (t) => {
  const dir = scratch(t);
  assert.doesNotThrow(() => assertNotInsideAnyVault(dir, {}));
  assert.doesNotThrow(() => assertNotInsideAnyVault(dir, { campaigns: {} }));
});

// --- ensurePrivateDir ----------------------------------------------------------

test('ensurePrivateDir creates a missing folder at 0700 and reports created', posix, (t) => {
  const dir = scratch(t);
  const target = path.join(dir, 'panel');
  const out = ensurePrivateDir(target);
  assert.deepEqual(out, { created: true, looseMode: false });
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
});

test('ensurePrivateDir reports looseMode for an existing folder that group or others can enter, and never changes it', posix, (t) => {
  const dir = scratch(t);
  const target = path.join(dir, 'panel');
  fs.mkdirSync(target, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  assert.deepEqual(ensurePrivateDir(target), { created: false, looseMode: true });
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  const tight = path.join(dir, 'tight');
  fs.mkdirSync(tight, { mode: 0o700 });
  assert.deepEqual(ensurePrivateDir(tight), { created: false, looseMode: false });
});

test('Ma15b: a panel folder that is a symlink (to an ancestor of the config folder, or anywhere) is refused', posix, (t) => {
  const dir = scratch(t);
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  const panel = path.join(cfg, 'panel');
  fs.symlinkSync(dir, panel); // a link to an ANCESTOR of the config folder
  assert.throws(() => ensurePrivateDir(panel), (err) => {
    assert.ok(err instanceof ScriptoriumError);
    assert.match(err.message, /must be a real folder, not a link/);
    return true;
  });
  const elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const second = path.join(cfg, 'panel2');
  fs.symlinkSync(elsewhere, second);
  assert.throws(() => ensurePrivateDir(second), /not a link/);
});

test('ensurePrivateDir refuses a path that exists but is a file', (t) => {
  const dir = scratch(t);
  const f = path.join(dir, 'panel');
  fs.writeFileSync(f, 'x');
  assert.throws(() => ensurePrivateDir(f), /must be a folder/);
});

// --- writePrivateFileAtomic / appendPrivateLine --------------------------------

test('writePrivateFileAtomic writes the data at 0600, leaves no temp file, and replaces atomically', posix, (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'panel', 'password.json');
  writePrivateFileAtomic(file, 'one');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  writePrivateFileAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['password.json']);
});

test('Ma21: the mode is 0600 at the FIRST write to a new descriptor (not chmod-ed afterwards)', posix, (t) => {
  const dir = scratch(t);
  const original = fs.writeSync;
  const seen = [];
  t.after(() => {
    fs.writeSync = original;
  });
  fs.writeSync = function patched(fd, ...rest) {
    const st = fs.fstatSync(fd);
    if (st.isFile()) seen.push(st.mode & 0o777);
    return original.call(this, fd, ...rest);
  };
  writePrivateFileAtomic(path.join(dir, 'p', 'a.json'), 'data');
  appendPrivateLine(path.join(dir, 'p', 'audit.log'), 'line\n');
  fs.writeSync = original;
  assert.deepEqual(seen, [0o600, 0o600]);
});

test('writePrivateFileAtomic failure removes the temp file, keeps the old file intact, and rethrows', posix, (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'p', 'a.json');
  writePrivateFileAtomic(file, 'old');
  const original = fs.renameSync;
  t.after(() => {
    fs.renameSync = original;
  });
  fs.renameSync = () => {
    const err = new Error('boom');
    err.code = 'EIO';
    throw err;
  };
  assert.throws(() => writePrivateFileAtomic(file, 'new'), /boom/);
  fs.renameSync = original;
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['a.json']);
});

test('writePrivateFileAtomic retries a rename that fails with EBUSY, then succeeds', posix, (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'p', 'a.json');
  const original = fs.renameSync;
  let calls = 0;
  t.after(() => {
    fs.renameSync = original;
  });
  fs.renameSync = function patched(a, b) {
    calls++;
    if (calls === 1) {
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    }
    return original.call(this, a, b);
  };
  writePrivateFileAtomic(file, 'data');
  fs.renameSync = original;
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'data');
});

test('writePrivateFileAtomic refuses a symlinked panel folder', posix, (t) => {
  const dir = scratch(t);
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(dir, 'panel'));
  assert.throws(() => writePrivateFileAtomic(path.join(dir, 'panel', 'a.json'), 'x'), /not a link/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test('appendPrivateLine creates the file at 0600 and appends in order', posix, (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'panel', 'audit.log');
  appendPrivateLine(file, 'one\n');
  appendPrivateLine(file, 'two\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('appendPrivateLine throws when the log path is a directory (the audit-failure shape the router tests use)', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'panel', 'audit.log');
  fs.mkdirSync(file, { recursive: true });
  assert.throws(() => appendPrivateLine(file, 'x\n'), (err) => err.code === 'EISDIR');
});
