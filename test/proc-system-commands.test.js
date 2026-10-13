'use strict';

/*
 * The Windows system-tool list of src/proc/run.js (ADR 0046 addendum, "a Windows system tool";
 * ADR 0056). SYSTEM_COMMANDS is separate from ALLOWED_COMMANDS: its programs are run only on
 * Windows, only from <SystemRoot>\System32, and are never looked up through PATH. This proves the
 * TEXT the spawner would hand to Windows, with a spy spawn that executes nothing. It does not
 * prove how Windows treats it: that is C180 to C183 in .agents/windows-verification.md (OPEN).
 *
 * Every expected value is a hand-written literal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProcError, ALLOWED_COMMANDS, SYSTEM_COMMANDS, resolveCommand } = require('../src/proc/run');
const { makeFakeBin, WIN_DIR } = require('./helpers/proc-fakebin');

function winEnv(extra = {}) {
  return { PATH: WIN_DIR, SystemRoot: 'C:\\Windows', ...extra };
}

async function refusal(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal');
}

const PATH_CONSULTED = () => {
  throw new Error('PATH consulted');
};

test('SYSTEM_COMMANDS is pinned as the literal list, frozen, and is not part of ALLOWED_COMMANDS', () => {
  assert.deepEqual([...SYSTEM_COMMANDS], ['icacls']);
  assert.ok(Object.isFrozen(SYSTEM_COMMANDS));
  assert.ok(!ALLOWED_COMMANDS.includes('icacls'));
  assert.deepEqual([...ALLOWED_COMMANDS], ['claude', 'codex', 'gemini', 'git', 'rsync', 'ssh', 'whisper-cli']);
});

test('simulated win32: icacls runs from System32 and PATH is never consulted', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  const args = ['C:\\scratch\\panel', '/inheritance:r', '/Q'];
  const result = await fb.run({ command: 'icacls', args, env: winEnv() }, { platform: 'win32', spawn: spy, fileExists: PATH_CONSULTED });
  assert.equal(result.exitCode, 0);
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0];
  assert.equal(call.file, 'C:\\Windows\\System32\\icacls.exe');
  assert.deepEqual(call.args, ['C:\\scratch\\panel', '/inheritance:r', '/Q']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsVerbatimArguments, undefined);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('simulated win32: a planted icacls earlier on PATH is not used', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  await fb.run(
    { command: 'icacls', args: ['x'], env: winEnv() },
    { platform: 'win32', spawn: spy, fileExists: (p) => p === 'C:\\scriptorium-fakebin\\bin\\icacls.exe' },
  );
  assert.equal(spy.calls[0].file, 'C:\\Windows\\System32\\icacls.exe');
});

test('simulated win32: SystemRoot decides the folder', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  await fb.run({ command: 'icacls', args: [], env: winEnv({ SystemRoot: 'D:\\WINNT' }) }, { platform: 'win32', spawn: spy, fileExists: PATH_CONSULTED });
  assert.equal(spy.calls[0].file, 'D:\\WINNT\\System32\\icacls.exe');
});

test('real (Linux) platform: icacls is refused as windows-only and nothing is started', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  if (process.platform === 'win32') return t.skip('this check is for a non-Windows platform');
  const err = await refusal(() => fb.run({ command: 'icacls', env: fb.baseEnv() }));
  assert.ok(err instanceof ProcError);
  assert.equal(err.code, 'E_PROC_NOT_ALLOWED');
  assert.equal(err.reason, 'windows-only');
  assert.equal(fb.attempts.length, 0);
});

test('resolveCommand: off Windows it refuses windows-only, never reading PATH', () => {
  assert.throws(
    () => resolveCommand('icacls', { env: { PATH: '/x' }, platform: 'linux' }, { fileExists: PATH_CONSULTED }),
    (e) => e instanceof ProcError && e.code === 'E_PROC_NOT_ALLOWED' && e.reason === 'windows-only',
  );
});

test('near misses are refused as not-allowed: extension, case, full path', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  for (const name of ['icacls.exe', 'ICACLS', 'Icacls', 'C:\\Windows\\System32\\icacls', 'icacls ', '']) {
    const spy = fb.spySpawn();
    const err = await refusal(() => fb.run({ command: name, env: winEnv() }, { platform: 'win32', spawn: spy, fileExists: PATH_CONSULTED }));
    assert.equal(err.code, 'E_PROC_NOT_ALLOWED', name);
    assert.equal(err.reason, 'not-allowed', name);
    assert.equal(spy.calls.length, 0, name);
  }
});

test('simulated win32: a relative or missing SystemRoot is refused as E_PROC_ENV and nothing is started', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  for (const env of [winEnv({ SystemRoot: 'relative' }), { PATH: WIN_DIR }]) {
    const spy = fb.spySpawn();
    const err = await refusal(() => fb.run({ command: 'icacls', args: [], env }, { platform: 'win32', spawn: spy, fileExists: PATH_CONSULTED }));
    assert.equal(err.code, 'E_PROC_ENV');
    assert.equal(spy.calls.length, 0);
  }
});

test('NUL in an argument is still refused for a system tool', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  const err = await refusal(() => fb.run({ command: 'icacls', args: ['a\0b'], env: winEnv() }, { platform: 'win32', spawn: spy, fileExists: PATH_CONSULTED }));
  assert.equal(err.code, 'E_PROC_ARG');
  assert.equal(spy.calls.length, 0);
});
