'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Writable } = require('stream');

const { runRemoteCommand } = require('../src/cli/remote');
const { ConfigError } = require('../src/util/errors');
const { createSessionStore } = require('../src/remote/sessions');

/*
 * ADR 0056 and its amendment for secret writes. `runRemoteCommand` with a simulated Windows
 * (panelAccess: { platform, env, run }) and a recording icacls fake: the access-list step runs
 * once, immediately before the first write into the panel folder, and never for the read-only
 * commands. When it fails, the four commands that save a password or its hash refuse and write
 * nothing; the other five warn on the last line and carry on. This proves order and text, not how
 * Windows treats the list (C180 to C183). Synthetic identity: EXAMPLEPC / examplegm.
 */

const ENV = { USERDOMAIN: 'EXAMPLEPC', USERNAME: 'examplegm', SystemRoot: 'C:\\Windows', PATH: 'C:\\x' };
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pacli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha Test', excludeDirs: [], folderMap: {} })}\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n'));
  return { root, vault, configPath, panelDir: path.join(root, 'panel') };
}

function pipes(lines) {
  const input = new PassThrough();
  const output = new Writable({ write: (c, _e, cb) => cb() });
  input.end((lines || []).map((l) => `${l}\n`).join(''));
  return { input, output };
}

/** A recording icacls fake that notes whether accounts.json / password.json existed when it ran. */
function icacls(fx, exitCode = 0) {
  const calls = [];
  const run = async (opts) => {
    calls.push({ opts, accountsExisted: fs.existsSync(path.join(fx.panelDir, 'accounts.json')), panelExisted: fs.existsSync(fx.panelDir) });
    return { exitCode, timedOut: false };
  };
  run.calls = calls;
  return run;
}

function win(run) {
  return { platform: 'win32', env: ENV, run };
}

async function call(fx, sub, { flags = {}, args = [], lines, panelAccess } = {}) {
  const p = pipes(lines);
  return runRemoteCommand({ config: fx.configPath, ...flags }, sub, args, { stdin: p.input, stdout: p.output, panelAccess });
}

/** Two accounts, set up on the real platform (POSIX: the access-list step is a no-op there). */
async function seeded(t) {
  if (process.platform === 'win32') return null;
  const fx = fixture(t);
  await call(fx, 'account', { args: ['add', 'gm'], lines: [PASSWORD] });
  await call(fx, 'account', { args: ['add', 'rook'], lines: [PASSWORD] });
  return fx;
}

const bytesOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
function snapshot(fx) {
  return ['accounts.json', 'password.json', 'audit.log'].map((n) => bytesOrNull(path.join(fx.panelDir, n)));
}
function warningLine(fx, reason) {
  return `warning: ${fx.panelDir} could not be limited to your account, SYSTEM and Administrators (${reason}); remote access will refuse to start until it can`;
}
function secretRefusal(fx, reason) {
  return `remote access needs ${fx.panelDir} limited to your account, SYSTEM and Administrators before a password is saved there, and that could not be done (${reason}); no password was saved`;
}

test('account add, list applied: one icacls call, before accounts.json exists, exit 0', async (t) => {
  const fx = fixture(t);
  const run = icacls(fx, 0);
  const result = await call(fx, 'account', { args: ['add', 'gm'], lines: [PASSWORD], panelAccess: win(run) });
  assert.equal(result.exitCode, 0);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].accountsExisted, false);
  assert.equal(run.calls[0].opts.command, 'icacls');
  assert.equal(run.calls[0].opts.args[0], fx.panelDir);
  assert.ok(fs.existsSync(path.join(fx.panelDir, 'accounts.json')));
  assert.ok(!result.human.includes('could not be limited'));
});

test('the four commands that save a password refuse when the list cannot be set, and write nothing', async (t) => {
  const fx = await seeded(t);
  if (fx === null) return t.skip('seeding uses the real (non-Windows) platform');
  const cases = [
    ['account', { args: ['add', 'newone'], lines: [PASSWORD] }],
    ['account', { args: ['change', 'rook'], lines: [PASSWORD, NEW_PASSWORD] }],
    ['account', { args: ['reset', 'rook'], lines: [NEW_PASSWORD] }],
    ['password', { lines: [PASSWORD, NEW_PASSWORD] }],
  ];
  for (const [sub, opts] of cases) {
    const before = snapshot(fx);
    const run = icacls(fx, 5);
    await assert.rejects(call(fx, sub, { ...opts, panelAccess: win(run) }), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message, secretRefusal(fx, 'icacls exited 5'));
      return true;
    });
    assert.equal(run.calls.length, 1, `${sub} ${(opts.args || []).join(' ')}`);
    assert.deepEqual(snapshot(fx), before, `${sub} ${(opts.args || []).join(' ')}: accounts.json, password.json and audit.log are byte-identical`);
  }
});

test('the five other writing commands warn on the last line and carry on (exit 0) when the list cannot be set', async (t) => {
  const fx = await seeded(t);
  if (fx === null) return t.skip('seeding uses the real (non-Windows) platform');
  const cases = [
    ['account', { args: ['remove', 'rook'] }],
    ['account', { args: ['rename', 'gm', 'chief'] }],
    ['signout-all', {}],
    ['signout-all', { flags: { account: 'chief' } }],
    ['set', { flags: { mode: 'ssh' } }],
    ['off', {}],
  ];
  for (const [sub, opts] of cases) {
    const run = icacls(fx, 5);
    const result = await call(fx, sub, { ...opts, panelAccess: win(run) });
    const label = `${sub} ${(opts.args || []).join(' ')}`;
    assert.equal(result.exitCode, 0, label);
    assert.equal(run.calls.length, 1, label);
    assert.ok(result.human.endsWith(`\n${warningLine(fx, 'icacls exited 5')}`), label);
  }
});

test('off, signout-all and password each call the step once when it works', async (t) => {
  const fx = await seeded(t);
  if (fx === null) return t.skip('seeding uses the real (non-Windows) platform');
  for (const [sub, opts] of [
    ['signout-all', {}],
    ['password', { lines: [PASSWORD, NEW_PASSWORD] }],
    ['off', {}],
  ]) {
    const run = icacls(fx, 0);
    const result = await call(fx, sub, { ...opts, panelAccess: win(run) });
    assert.equal(result.exitCode, 0, sub);
    assert.equal(run.calls.length, 1, sub);
    assert.ok(!result.human.includes('could not be limited'), sub);
  }
});

test('set calls the step once when it changes something, and not when nothing changes', async (t) => {
  const fx = fixture(t);
  const first = icacls(fx, 0);
  await call(fx, 'set', { flags: { mode: 'ssh' }, panelAccess: win(first) });
  assert.equal(first.calls.length, 1);
  const again = icacls(fx, 0);
  await call(fx, 'set', { flags: { mode: 'ssh' }, panelAccess: win(again) });
  assert.equal(again.calls.length, 0);
});

test('show and account list never call the step and leave the panel folder exactly as it was (A46-4)', async (t) => {
  const fx = await seeded(t);
  if (fx === null) return t.skip('seeding uses the real (non-Windows) platform');
  // One expired session record: any code path that loads the session store would prune and rewrite it.
  createSessionStore({ file: path.join(fx.panelDir, 'sessions.json'), now: () => 1000 }).create('admin', { account: 'gm' });
  const listing = () =>
    fs
      .readdirSync(fx.panelDir)
      .sort()
      .map((n) => {
        const st = fs.statSync(path.join(fx.panelDir, n));
        return [n, st.size, st.mtimeMs];
      });
  const before = listing();
  assert.ok(before.some(([n]) => n === 'sessions.json'));
  await new Promise((r) => setTimeout(r, 20));
  for (const [sub, args] of [['show', []], ['account', ['list']]]) {
    const run = icacls(fx, 0);
    const result = await call(fx, sub, { args, panelAccess: win(run) });
    assert.equal(result.exitCode, 0);
    assert.equal(run.calls.length, 0, sub);
    assert.deepEqual(listing(), before, `${sub} left the panel folder unchanged`);
  }
});

test('a cancelled prompt calls nothing and creates no panel folder', async (t) => {
  const fx = fixture(t);
  const run = icacls(fx, 0);
  await assert.rejects(call(fx, 'account', { args: ['add', 'gm'], lines: [], panelAccess: win(run) }), (err) => err instanceof ConfigError && err.message === 'cancelled; nothing changed');
  assert.equal(run.calls.length, 0);
  assert.equal(fs.existsSync(fx.panelDir), false);
});

test('the real platform with no panelAccess (POSIX): the step is a no-op and nothing is run', async (t) => {
  if (process.platform === 'win32') return t.skip('this check is for a non-Windows platform');
  const fx = fixture(t);
  const run = icacls(fx, 5);
  const result = await call(fx, 'account', { args: ['add', 'gm'], lines: [PASSWORD], panelAccess: { run } });
  assert.equal(result.exitCode, 0);
  assert.equal(run.calls.length, 0);
});
