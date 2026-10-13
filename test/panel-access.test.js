'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyPanelAccess, ownerPrincipal, icaclsArgs, accessWarning, accessRefusal, accessSecretRefusal, ICACLS_TIMEOUT_MS } = require('../src/remote/panelaccess');
const { findLooseModes } = require('../src/remote/paths');

/*
 * ADR 0056 (an owner-only access list on the panel folder on Windows). The module unit: the exact
 * icacls text, the owner name rules, the closed set of failure reasons, and that nothing is touched
 * off Windows or inside a vault. `run` is a recording fake, so no program starts. This proves the
 * TEXT handed to the spawner, not how Windows treats it (C180 to C183 in .agents/windows-verification.md).
 *
 * Synthetic identity: EXAMPLEPC / examplegm. Every expected value is a hand-written literal.
 */

const ENV = { USERDOMAIN: 'EXAMPLEPC', USERNAME: 'examplegm', SystemRoot: 'C:\\Windows', PATH: 'C:\\x' };

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pacl-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, panelDir: path.join(root, 'panel') };
}

function recorder(result = { exitCode: 0, timedOut: false }, panelDir) {
  const calls = [];
  const run = async (opts) => {
    calls.push({ opts, existedAtCall: panelDir ? fs.existsSync(panelDir) : null });
    if (result instanceof Error) throw result;
    return result;
  };
  run.calls = calls;
  return run;
}

const win = (extra = {}) => ({ insideVault: false, platform: 'win32', env: ENV, ...extra });

test('linux: a no-op, the spawner is never called and the folder is not created', async (t) => {
  const { panelDir } = scratch(t);
  const run = recorder(undefined, panelDir);
  const out = await applyPanelAccess({ panelDir }, { insideVault: false, platform: 'linux', env: ENV }, { run });
  assert.deepEqual(out, { state: 'posix', reason: null });
  assert.equal(run.calls.length, 0);
  assert.equal(fs.existsSync(panelDir), false);
});

test('win32, a new folder: created first, exactly one icacls call with the literal arguments, applied', async (t) => {
  const { panelDir } = scratch(t);
  const run = recorder(undefined, panelDir);
  const out = await applyPanelAccess({ panelDir }, win(), { run });
  assert.deepEqual(out, { state: 'applied', reason: null });
  assert.equal(run.calls.length, 1);
  const { opts, existedAtCall } = run.calls[0];
  assert.equal(existedAtCall, true);
  assert.equal(opts.command, 'icacls');
  assert.deepEqual(opts.args, [panelDir, '/inheritance:r', '/grant:r', 'EXAMPLEPC\\examplegm:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q']);
  assert.equal(opts.timeoutMs, 30000);
  assert.equal(ICACLS_TIMEOUT_MS, 30000);
  assert.deepEqual(opts.env, ENV);
  assert.notEqual(opts.env, ENV, 'the child gets a copy, never the caller object');
});

test('win32, an existing folder: the list is applied again', async (t) => {
  const { panelDir } = scratch(t);
  fs.mkdirSync(panelDir);
  const run = recorder(undefined, panelDir);
  const out = await applyPanelAccess({ panelDir }, win(), { run });
  assert.equal(out.state, 'applied');
  assert.equal(run.calls.length, 1);
});

test('failures carry the exact reason', async (t) => {
  const { panelDir } = scratch(t);
  const cases = [
    [{ exitCode: 5, timedOut: false }, 'icacls exited 5'],
    [{ exitCode: null, timedOut: true }, 'icacls timed out'],
    [Object.assign(new Error('could not start'), { code: 'E_PROC_SPAWN' }), 'icacls could not be run (E_PROC_SPAWN)'],
  ];
  for (const [result, reason] of cases) {
    const run = recorder(result, panelDir);
    const out = await applyPanelAccess({ panelDir }, win(), { run });
    assert.deepEqual(out, { state: 'failed', reason });
    assert.equal(run.calls.length, 1);
  }
});

test('an account name that is missing or holds a risky character is a failure and icacls is never run', async (t) => {
  const { panelDir } = scratch(t);
  const envs = [
    { ...ENV, USERDOMAIN: undefined },
    { ...ENV, USERNAME: undefined },
    { ...ENV, USERNAME: '' },
    { ...ENV, USERNAME: 'a:b' },
    { ...ENV, USERNAME: 'a"b' },
    { ...ENV, USERNAME: 'a\\b' },
    { ...ENV, USERNAME: 'a*b' },
    { ...ENV, USERDOMAIN: 'EXAMPLE\u0001PC' },
    { ...ENV, USERNAME: 'x'.repeat(257) },
  ];
  for (const env of envs) {
    const run = recorder(undefined, panelDir);
    const out = await applyPanelAccess({ panelDir }, win({ env }), { run });
    assert.deepEqual(out, { state: 'failed', reason: 'the account name could not be read' });
    assert.equal(run.calls.length, 0);
  }
  assert.equal(fs.existsSync(panelDir), false, 'nothing is created before the name is known to be usable');
});

test('ownerPrincipal: the plain name, a spaced name, and the refusals', () => {
  assert.equal(ownerPrincipal(ENV), 'EXAMPLEPC\\examplegm');
  assert.equal(ownerPrincipal({ USERDOMAIN: 'EXAMPLE PC', USERNAME: 'example gm' }), 'EXAMPLE PC\\example gm');
  assert.equal(ownerPrincipal({ USERDOMAIN: 'EXAMPLEPC', USERNAME: 'a:b' }), null);
  assert.equal(ownerPrincipal(null), null);
  assert.equal(ownerPrincipal({}), null);
});

test('icaclsArgs is the literal list', () => {
  assert.deepEqual(icaclsArgs('C:\\p', 'D\\u'), ['C:\\p', '/inheritance:r', '/grant:r', 'D\\u:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q']);
});

test('inside a vault: nothing is created and nothing is run', async (t) => {
  const { panelDir } = scratch(t);
  const run = recorder(undefined, panelDir);
  const out = await applyPanelAccess({ panelDir }, win({ insideVault: true }), { run });
  assert.deepEqual(out, { state: 'inside-vault', reason: null });
  assert.equal(run.calls.length, 0);
  assert.equal(fs.existsSync(panelDir), false);
});

test('a panel that is a link: failed, the prepared reason, icacls never run', async (t) => {
  const { root, panelDir } = scratch(t);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  try {
    fs.symlinkSync(elsewhere, panelDir, 'dir');
  } catch {
    t.skip('symbolic links are not available here');
    return;
  }
  const run = recorder(undefined, panelDir);
  const out = await applyPanelAccess({ panelDir }, win(), { run });
  assert.deepEqual(out, { state: 'failed', reason: 'the folder could not be prepared (not a real folder)' });
  assert.equal(run.calls.length, 0);
});

test('a panel that is a file: failed, the prepared reason', async (t) => {
  const { panelDir } = scratch(t);
  fs.writeFileSync(panelDir, 'x');
  const run = recorder(undefined, panelDir);
  const out = await applyPanelAccess({ panelDir }, win(), { run });
  assert.deepEqual(out, { state: 'failed', reason: 'the folder could not be prepared (not a real folder)' });
  assert.equal(run.calls.length, 0);
});

test('it never rejects, even when the runner throws a plain error or the paths are unusable', async (t) => {
  const { panelDir } = scratch(t);
  const boom = recorder(new Error('plain'), panelDir);
  assert.deepEqual(await applyPanelAccess({ panelDir }, win(), { run: boom }), { state: 'failed', reason: 'icacls could not be run (unknown)' });
  const out = await applyPanelAccess(undefined, win(), {});
  assert.equal(out.state, 'failed');
});

test('findLooseModes on win32: the folder only when the access list failed', () => {
  const paths = { panelDir: 'C:\\cfg\\panel', passwordFile: 'x', accountsFile: 'y', sessionsFile: 'z', auditFile: 'w' };
  assert.deepEqual(findLooseModes(paths, { platform: 'win32', panelAccess: { state: 'failed' } }), ['C:\\cfg\\panel']);
  assert.deepEqual(findLooseModes(paths, { platform: 'win32', panelAccess: { state: 'applied' } }), []);
  assert.deepEqual(findLooseModes(paths, { platform: 'win32', panelAccess: null }), []);
  assert.deepEqual(findLooseModes(paths, { platform: 'win32' }), []);
});

test('the messages are exact', () => {
  assert.equal(
    accessWarning('C:\\cfg\\panel', 'icacls exited 5'),
    'warning: C:\\cfg\\panel could not be limited to your account, SYSTEM and Administrators (icacls exited 5); remote access will refuse to start until it can',
  );
  assert.equal(
    accessRefusal('proxy', 'C:\\cfg\\panel', 'icacls timed out'),
    'remote access (mode proxy) needs C:\\cfg\\panel limited to your account, SYSTEM and Administrators, and that could not be done (icacls timed out); nothing was started',
  );
  assert.equal(
    accessSecretRefusal('C:\\cfg\\panel', 'icacls exited 5'),
    'remote access needs C:\\cfg\\panel limited to your account, SYSTEM and Administrators before a password is saved there, and that could not be done (icacls exited 5); no password was saved',
  );
});
