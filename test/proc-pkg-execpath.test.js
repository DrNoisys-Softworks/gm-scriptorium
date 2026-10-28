'use strict';

/*
 * The packager's PKG_EXECPATH never reaches a child (ADR 0046 addendum "The packager's PKG_EXECPATH";
 * issue 212). A packaged program's spawn adds that variable to the environment it is handed, naming
 * the program itself, so a child that is the same program (the tray's handoff, the host) runs as plain
 * Node. The fix is a hidden entry in every environment buildChildEnv builds: the packager sees a
 * defined value and leaves it alone, and Node leaves non-enumerable names out of the child's block.
 *
 * What these tests prove, and what they do not:
 * - They lay the packager's own patchChildProcess over a recording spawner, and over a real stand-in
 *   program, so the variable is injected by the real wrapper.
 * - C0 and C0-real are controls. They pass on the base and prove nothing about the fix: they show the
 *   packager still injects the variable. If one goes red, the packager changed; stop and re-read it.
 * - Nothing here proves anything about win-x64 or the tray. Only the VM does (C216 in
 *   .agents/windows-verification.md, OPEN).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const childProcess = require('child_process');

const { buildChildEnv, runTrayHandoff, openFile, ProcError } = require('../src/proc/run');
const { makeFakeBin, WIN_DIR } = require('./helpers/proc-fakebin');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const MEMBERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];
const EXEC_PATH = 'C:\\Tools\\GM-Scriptorium\\gm-scriptorium.exe';

/** The packager's real wrapper laid over `ancestor`; child_process is put back before this returns. */
function pkgPatchedOver(ancestor) {
  const saved = {};
  for (const name of MEMBERS) saved[name] = childProcess[name];
  let wrapped;
  try {
    childProcess.spawn = ancestor;
    require('@yao-pkg/pkg/prelude/bootstrap-shared.js').patchChildProcess('/snapshot/gm-scriptorium/package.json');
    wrapped = childProcess.spawn;
  } finally {
    for (const name of MEMBERS) childProcess[name] = saved[name];
  }
  return wrapped;
}

/** The names Node's own loop would put in a child's block (for...in, so non-enumerable names are left out). */
function visibleNames(env) {
  const names = [];
  for (const key in env) names.push(key);
  return names;
}

function hasPkgName(env) {
  return visibleNames(env).some((k) => /^pkg_execpath$/i.test(k));
}

function winEnv(extra = {}) {
  return {
    PATH: WIN_DIR,
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Profiles\\Sam',
    USERNAME: 'Sam',
    ...extra,
  };
}

function exitsWith(fb, code, t) {
  const spy = fb.spySpawn((child) => {
    setImmediate(() => child.closeNow(code, null));
  });
  t.after(() => spy.calls.forEach((c) => c.child.release()));
  return spy;
}

test('control: after the wrapper is laid over a spy, child_process is put back as it was', () => {
  const before = MEMBERS.map((n) => childProcess[n]);
  const spy = () => {};
  const wrapped = pkgPatchedOver(spy);
  assert.equal(typeof wrapped, 'function');
  assert.notEqual(wrapped, spy);
  MEMBERS.forEach((n, i) => assert.equal(childProcess[n], before[i], n + ' restored'));
});

test('C0 control (proves nothing about the fix): the packager adds PKG_EXECPATH inside spawn', (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = exitsWith(fb, 0, t);
  const wrapped = pkgPatchedOver(spy);
  wrapped('/x', [], { env: { PATH: '/x' }, shell: false });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options.env.PKG_EXECPATH, process.execPath);
});

function collect(child) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    child.stdout.on('data', (b) => chunks.push(b));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    child.stdin.end();
  });
}

function dumpOf(fb, text) {
  const lines = text.split('\n');
  assert.equal(lines[0], fb.sentinel);
  return JSON.parse(lines[1]);
}

test('C0-real control (proves nothing about the fix): a real stand-in child sees the variable the packager adds', async (t) => {
  const fb = makeFakeBin(t);
  t.after(() => fb.cleanup());
  const wrapped = pkgPatchedOver(fb.guardedSpawn);
  const text = await collect(wrapped(path.join(fb.dir, 'git'), [], { env: { ...fb.baseEnv() }, shell: false }));
  const dump = dumpOf(fb, text);
  assert.equal(dump.env.PKG_EXECPATH, process.execPath);
});

test('E1: a real stand-in child started with a built environment gets no PKG_EXECPATH, and does get its PATH', async (t) => {
  const fb = makeFakeBin(t);
  t.after(() => fb.cleanup());
  const wrapped = pkgPatchedOver(fb.guardedSpawn);
  const env = buildChildEnv(fb.baseEnv(), {}, process.platform);
  const text = await collect(wrapped(path.join(fb.dir, 'git'), [], { env, shell: false }));
  const dump = dumpOf(fb, text);
  assert.equal(dump.env.PATH, fb.dir, 'positive control: the environment did arrive');
  assert.deepEqual(
    Object.keys(dump.env).filter((k) => /^pkg_execpath$/i.test(k)),
    [],
  );
});

test('P1: the tray handoff spawn is given no PKG_EXECPATH once the packager has run', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = exitsWith(fb, 3, t);
  const wrapped = pkgPatchedOver(spy);
  const result = await runTrayHandoff({ env: winEnv() }, { spawn: wrapped, platform: 'win32', execPath: EXEC_PATH });
  assert.equal(result.outcome, 'exited');
  assert.equal(result.exitCode, 3);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options.env.PATH, WIN_DIR, 'positive control: this is the built environment');
  assert.equal(hasPkgName(spy.calls[0].options.env), false);
});

test('P2: the opener spawn is given no PKG_EXECPATH once the packager has run', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = exitsWith(fb, 0, t);
  const wrapped = pkgPatchedOver(spy);
  await openFile({ target: 'C:\\Scratch\\stopped.html', env: winEnv() }, { spawn: wrapped, platform: 'win32' });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options.env.PATH, WIN_DIR, 'positive control: this is the built environment');
  assert.equal(hasPkgName(spy.calls[0].options.env), false);
});

const P3_ROWS = [
  ['linux', { PATH: '/usr/bin', HOME: '/h' }, {}, 'linux'],
  ['win32', { PATH: 'C:\\p', SystemRoot: 'C:\\Windows' }, {}, 'win32'],
  ['win32 with a lower-case extra', { PATH: 'C:\\p', SystemRoot: 'C:\\Windows' }, { pkg_execpath: 'C:\\x' }, 'win32'],
];

for (const [label, source, extra, platform] of P3_ROWS) {
  test(`P3: a built environment (${label}) reaches spawn with no PKG_EXECPATH`, (t) => {
    const fb = makeFakeBin(t, { empty: true });
    const spy = exitsWith(fb, 0, t);
    const wrapped = pkgPatchedOver(spy);
    const env = buildChildEnv(source, extra, platform);
    wrapped('/x', [], { env, shell: false });
    assert.equal(spy.calls.length, 1);
    const seen = spy.calls[0].options.env;
    assert.equal(seen.PATH, source.PATH, 'positive control: this is the built environment');
    assert.equal(hasPkgName(seen), false);
    assert.deepEqual(visibleNames(seen).sort(), Object.keys(env).sort());
  });
}

test('the hidden entry holds the empty string, is not enumerable, and a refused ProcError is still a ProcError', () => {
  const env = buildChildEnv({ PATH: '/usr/bin' }, {}, 'linux');
  const desc = Object.getOwnPropertyDescriptor(env, 'PKG_EXECPATH');
  assert.ok(desc, 'the entry exists');
  assert.equal(desc.value, '');
  assert.equal(desc.enumerable, false);
  assert.equal(desc.writable, true);
  assert.equal(desc.configurable, false);
  assert.deepEqual(Object.keys(env), ['PATH']);
  assert.throws(() => buildChildEnv({ HOME: '/h' }, {}, 'linux'), (e) => e instanceof ProcError);
});
