'use strict';

/*
 * The browser opener (ADR 0028, section 8; ADR 0046 addendum): openFile in src/proc/run.js. Every
 * spawn goes through the PATH-scrub helper (fb.guardedSpawn for a real fake program on a scratch
 * PATH, fb.spySpawn for the Windows and macOS simulations), so no test ever opens a real browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { openFile, OPENER_ENV_EXTRA, BASE_ENV_POSIX, ProcError, killAll, liveRunCount } = require('../src/proc/run');
const { makeFakeBin, WIN_DIR } = require('./helpers/proc-fakebin');
const { runLaunch } = require('../src/cli/launch');

const WIN_TARGET = 'C:\\Config\\Scriptorium\\panel\\launch-4242.html';
const WIN_ENV = { PATH: WIN_DIR, SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Home', DISPLAY: ':1', BROWSER: 'evil' };

/** Writes a fake xdg-open (the helper's shebang pattern) into the scratch bin. */
function writeFake(fb, body, name = 'xdg-open', mode = 0o755) {
  const file = path.join(fb.dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, mode);
  return file;
}

function scratchTarget(fb) {
  const dir = path.join(fb.root, 'panel');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'launch-4242.html');
}

function recorder(fb, extra = '') {
  const record = path.join(fb.root, 'record.json');
  const body = `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env), env: process.env, cwd: process.cwd() }));
${extra}`;
  return { record, body, read: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

/**
 * openFile lets go of its child on purpose (unref-ed, with an unref-ed settle timer), so under the
 * test runner nothing else keeps the event loop alive while it waits. Hold the loop open for the call.
 */
async function openAlive(opts, deps) {
  const keep = setInterval(() => {}, 25);
  try {
    return await openFile(opts, deps);
  } finally {
    clearInterval(keep);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn, what, ms = 8000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

// --- the pins -----------------------------------------------------------------------------------------

test('OPENER_ENV_EXTRA is the pinned, frozen list of display variables (proves the list, not that it is enforced)', () => {
  assert.deepEqual([...OPENER_ENV_EXTRA], ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'DBUS_SESSION_BUS_ADDRESS', 'BROWSER']);
  assert.ok(Object.isFrozen(OPENER_ENV_EXTRA));
});

// --- win32 and darwin (spy spawns: they prove the call, not Windows) ------------------------------------------

test('win32: rundll32 from SystemRoot, the file as the only data argument, no shell, detached, ignored stdio, hidden window, PATH never consulted', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const probes = [];
  const spy = fb.spySpawn((child) => {
    child.unref = () => probes.push('unref');
    setImmediate(() => child.closeNow(0, null));
  });
  const result = await openAlive(
    { target: WIN_TARGET, env: { ...WIN_ENV }, settleMs: 2000 },
    { spawn: spy, platform: 'win32', fileExists: (p) => (probes.push(`exists:${p}`), true) },
  );
  assert.deepEqual(result, { outcome: 'exited', exitCode: 0, signal: null });
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0];
  assert.equal(call.file, 'C:\\Windows\\System32\\rundll32.exe');
  assert.deepEqual(call.args, ['url.dll,FileProtocolHandler', WIN_TARGET]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.cwd, 'C:\\Config\\Scriptorium\\panel');
  assert.deepEqual(probes.filter((p) => p.startsWith('exists:')), [], 'the PATH (and the disk) was never consulted for the program');
  assert.ok(probes.includes('unref'), 'the child is unref-ed');
  // The display variables and BROWSER are POSIX-only; Windows gets the scrubbed base only.
  assert.equal(call.options.env.DISPLAY, undefined);
  assert.equal(call.options.env.BROWSER, undefined);
  assert.equal(call.options.env.SystemRoot, 'C:\\Windows');
  assert.equal(liveRunCount(), 0);
});

test('win32: a SystemRoot that is missing or odd is refused before any spawn', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  for (const env of [{ PATH: WIN_DIR }, { PATH: WIN_DIR, SystemRoot: 'C:\\Win dows;calc' }, { PATH: WIN_DIR, SystemRoot: '\\\\host\\share' }]) {
    const spy = fb.spySpawn();
    await assert.rejects(
      openAlive({ target: WIN_TARGET, env }, { spawn: spy, platform: 'win32' }),
      (e) => e instanceof ProcError && e.code === 'E_PROC_ENV',
    );
    assert.equal(spy.calls.length, 0);
  }
});

test('darwin: /usr/bin/open with the file only, same spawn options, no PATH lookup', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const probes = [];
  const spy = fb.spySpawn((child) => {
    child.unref = () => probes.push('unref');
    setImmediate(() => child.closeNow(0, null));
  });
  const target = '/Volumes/data/Scriptorium/panel/launch-9.html';
  const result = await openAlive({ target, env: fb.baseEnv({ DISPLAY: ':0' }) }, { spawn: spy, platform: 'darwin', fileExists: (p) => (probes.push(`exists:${p}`), false) });
  assert.equal(result.outcome, 'exited');
  const call = spy.calls[0];
  assert.equal(call.file, '/usr/bin/open');
  assert.deepEqual(call.args, [target]);
  assert.deepEqual({ shell: call.options.shell, detached: call.options.detached, stdio: call.options.stdio, windowsHide: call.options.windowsHide }, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
  assert.equal(call.options.cwd, '/Volumes/data/Scriptorium/panel');
  assert.deepEqual(probes.filter((p) => p.startsWith('exists:')), []);
  assert.ok(probes.includes('unref'));
});

// --- linux, with a real fake xdg-open on a scratch PATH -----------------------------------------------------------

test('linux: the fake xdg-open is run from the scratch PATH with the file as its only argument, a scrubbed environment, and no shell', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  const rec = recorder(fb);
  writeFake(fb, rec.body);
  const env = fb.baseEnv({
    DISPLAY: ':99',
    WAYLAND_DISPLAY: 'wayland-9',
    XDG_CURRENT_DESKTOP: 'TEST',
    XDG_SESSION_TYPE: 'x11',
    XDG_DATA_DIRS: '/usr/share',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus',
    BROWSER: 'some-browser',
    ANTHROPIC_API_KEY: 'a-secret-value-not-a-key',
    SSH_AUTH_SOCK: '/tmp/agent',
    SECRET_THING: 'nope',
  });
  const result = await openAlive({ target, env, settleMs: 5000 }, { spawn: fb.guardedSpawn });
  assert.deepEqual(result, { outcome: 'exited', exitCode: 0, signal: null });

  const attempt = fb.attempts[0];
  assert.equal(fb.attempts.length, 1);
  assert.equal(fs.realpathSync(attempt.file), fs.realpathSync(path.join(fb.dir, 'xdg-open')));
  assert.deepEqual(attempt.args, [target]);
  assert.equal(attempt.options.shell, false);
  assert.equal(attempt.options.detached, true);
  assert.equal(attempt.options.stdio, 'ignore');
  assert.equal(attempt.options.windowsHide, true);
  assert.equal(attempt.options.cwd, path.dirname(target));
  assert.equal(attempt.piped, false, 'ignored stdio: the child has no pipes');

  const seen = rec.read();
  assert.deepEqual(seen.argv, [target], 'the file is the only argument');
  assert.equal(seen.cwd, fs.realpathSync(path.dirname(target)));
  const allowed = new Set([...BASE_ENV_POSIX, 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'DBUS_SESSION_BUS_ADDRESS', 'BROWSER']);
  for (const k of seen.envKeys) assert.ok(allowed.has(k), `unexpected variable ${k} reached the opener`);
  assert.equal(seen.env.DISPLAY, ':99');
  assert.equal(seen.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1/bus');
  assert.equal(seen.env.BROWSER, 'some-browser');
  for (const k of ['ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK', 'SECRET_THING']) assert.equal(seen.env[k], undefined, k);
});

test('linux: no DISPLAY and no WAYLAND_DISPLAY (or empty ones) gives E_PROC_NO_DISPLAY with nothing spawned', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  writeFake(fb, 'process.exit(0);');
  for (const extra of [{}, { DISPLAY: '' }, { WAYLAND_DISPLAY: '' }, { DISPLAY: '', WAYLAND_DISPLAY: '' }]) {
    await assert.rejects(
      openAlive({ target, env: fb.baseEnv(extra) }, { spawn: fb.guardedSpawn }),
      (e) => e instanceof ProcError && e.code === 'E_PROC_NO_DISPLAY',
    );
  }
  assert.equal(fb.attempts.length, 0);
});

test('linux: WAYLAND_DISPLAY alone is enough', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  writeFake(fb, 'process.exit(0);');
  const result = await openAlive({ target, env: fb.baseEnv({ WAYLAND_DISPLAY: 'wayland-0' }) }, { spawn: fb.guardedSpawn });
  assert.equal(result.outcome, 'exited');
  assert.equal(fb.attempts.length, 1);
});

test('linux: an empty bin folder gives E_PROC_NOT_FOUND with reason opener and nothing spawned', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  await assert.rejects(
    openAlive({ target, env: fb.baseEnv({ DISPLAY: ':1' }) }, { spawn: fb.guardedSpawn }),
    (e) => e instanceof ProcError && e.code === 'E_PROC_NOT_FOUND' && e.reason === 'opener',
  );
  assert.equal(fb.attempts.length, 0);
});

test('linux: a non-executable xdg-open, a directory called xdg-open, and a relative PATH entry are not found', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  writeFake(fb, 'process.exit(0);', 'xdg-open', 0o644);
  await assert.rejects(openAlive({ target, env: fb.baseEnv({ DISPLAY: ':1' }) }, { spawn: fb.guardedSpawn }), (e) => e.code === 'E_PROC_NOT_FOUND');
  fs.rmSync(path.join(fb.dir, 'xdg-open'));
  fs.mkdirSync(path.join(fb.dir, 'xdg-open'));
  await assert.rejects(openAlive({ target, env: fb.baseEnv({ DISPLAY: ':1' }) }, { spawn: fb.guardedSpawn }), (e) => e.code === 'E_PROC_NOT_FOUND');
  fs.rmdirSync(path.join(fb.dir, 'xdg-open'));
  writeFake(fb, 'process.exit(0);');
  // The only place the program exists is reached by a relative entry: not looked at.
  const env = fb.baseEnv({ DISPLAY: ':1' });
  env.PATH = `bin:${path.relative(process.cwd(), fb.dir)}`;
  await assert.rejects(openAlive({ target, env }, { spawn: fb.guardedSpawn }), (e) => e.code === 'E_PROC_NOT_FOUND');
  assert.equal(fb.attempts.length, 0);
});

test('linux: a non-zero exit within the settle time is reported as exited with the code', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  writeFake(fb, 'process.exit(3);');
  const result = await openAlive({ target, env: fb.baseEnv({ DISPLAY: ':1' }), settleMs: 5000 }, { spawn: fb.guardedSpawn });
  assert.deepEqual(result, { outcome: 'exited', exitCode: 3, signal: null });
});

test('linux: an opener that is still running after settleMs is reported as running, is not in the live-run registry, and is never signalled by killAll', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  const pidfile = fb.trackPidfile(path.join(fb.root, 'pid'));
  writeFake(fb, `require('fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setTimeout(() => process.exit(0), 30000);`);
  const result = await openAlive({ target, env: fb.baseEnv({ DISPLAY: ':1' }), settleMs: 150 }, { spawn: fb.guardedSpawn });
  assert.deepEqual(result, { outcome: 'running' });
  const pid = Number(await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8'), 'the fake pid'));
  assert.equal(liveRunCount(), 0, 'not registered as a live run');
  await killAll();
  assert.ok(pidAlive(pid), 'killAll left the opener alone');
});

test('linux: a grandchild left in the opener process group survives killAll and the whole launch stop path', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const target = scratchTarget(fb);
  const gcPid = fb.trackPidfile(path.join(fb.root, 'grandchild'));
  writeFake(
    fb,
    `const cp = require('child_process');
const gc = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000);", ${JSON.stringify(gcPid)}], { stdio: 'ignore' });
gc.unref();
setTimeout(() => process.exit(0), 20000);`,
  );
  const result = await openAlive({ target, env: fb.baseEnv({ DISPLAY: ':1' }), settleMs: 200 }, { spawn: fb.guardedSpawn });
  assert.deepEqual(result, { outcome: 'running' });
  const pid = Number(await until(() => fs.existsSync(gcPid) && fs.readFileSync(gcPid, 'utf8'), 'the grandchild pid'));
  await killAll();
  assert.ok(pidAlive(pid), 'the grandchild survived killAll');

  // And through the real launch stop path: runLaunch with this opener, then a stop.
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  const signals = new EventEmitter();
  const root = fs.mkdtempSync(path.join(fb.root, 'launch-'));
  const configPath = path.join(root, 'config.toml');
  const started = runLaunch({ config: configPath }, {
    input,
    output,
    signals,
    platform: process.platform,
    env: fb.baseEnv({ DISPLAY: ':1' }),
    openFile: (o) => openAlive(o, { spawn: fb.guardedSpawn }),
    version: '0.0.0-test',
    help: 'HELP',
    reportError: () => 1,
  });
  const printed = [];
  output.on('data', (c) => printed.push(String(c)));
  await until(() => fb.attempts.length >= 2, 'the launch to open the launcher');
  signals.emit('SIGINT');
  assert.equal(await Promise.race([started, new Promise((_, rej) => setTimeout(() => rej(new Error('the launch stop path did not finish')), 8000).unref())]), 0);
  assert.ok(pidAlive(pid), 'the grandchild survived the launch stop path');
  assert.equal(liveRunCount(), 0);
});

// --- refusals -------------------------------------------------------------------------------------------------------

test('options are closed and checked: unknown keys, a bad target, a bad env and a bad settleMs all give E_PROC_BAD_OPTIONS', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  const base = { target: '/tmp/x/launch-1.html', env: fb.baseEnv({ DISPLAY: ':1' }) };
  const bad = [
    [undefined, 'options'],
    [{ ...base, shell: true }, 'unknown-option'],
    [{ ...base, args: ['--evil'] }, 'unknown-option'],
    [{ ...base, command: 'sh' }, 'unknown-option'],
    [{ ...base, target: undefined }, 'target'],
    [{ ...base, target: 42 }, 'target'],
    [{ ...base, target: '' }, 'target'],
    [{ ...base, target: 'relative/launch.html' }, 'target'],
    [{ ...base, target: '/tmp/x/\u0000.html' }, 'target'],
    [{ ...base, target: '/tmp/x/a\nb.html' }, 'target'],
    [{ ...base, target: '/tmp/x/a\u007fb.html' }, 'target'],
    [{ ...base, env: undefined }, 'env'],
    [{ ...base, env: 'PATH=/bin' }, 'env'],
    [{ ...base, env: process.env }, 'env'], // the live environment is not a plain object: callers pass a copy
    [{ ...base, settleMs: 0 }, 'settleMs'],
    [{ ...base, settleMs: -5 }, 'settleMs'],
    [{ ...base, settleMs: 1.5 }, 'settleMs'],
    [{ ...base, settleMs: '100' }, 'settleMs'],
  ];
  for (const [opts, reason] of bad) {
    await assert.rejects(openAlive(opts, { spawn: spy, platform: 'linux' }), (e) => e instanceof ProcError && e.code === 'E_PROC_BAD_OPTIONS' && e.reason === reason, `${reason}: ${JSON.stringify(opts)}`);
  }
  for (const target of ['C:/scratch/x.html', 'relative.html', '\\relative.html', 'C:relative.html']) {
    await assert.rejects(openAlive({ ...base, target, env: { ...WIN_ENV } }, { spawn: spy, platform: 'win32' }), (e) => e.code === 'E_PROC_BAD_OPTIONS' && e.reason === 'target', target);
  }
  await openAlive({ target: '\\\\host\\share\\panel\\launch-1.html', env: { ...WIN_ENV } }, { spawn: spy, platform: 'win32' });
  assert.equal(spy.calls.length, 1, 'only the UNC-absolute Windows target got through');
});

test('a spawn that throws, and a child that emits error, both reject E_PROC_SPAWN with fixed text and no path in the error', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const secretTarget = '/tmp/secret-folder-name/launch-1.html';
  const throwing = fb.spySpawn(() => {
    const err = new Error(`spawn ${secretTarget} EACCES`);
    err.code = 'EACCES';
    throw err;
  });
  const check = (e) => {
    assert.ok(e instanceof ProcError);
    assert.equal(e.code, 'E_PROC_SPAWN');
    assert.ok(!JSON.stringify(e).includes('secret-folder-name'));
    assert.ok(!String(e.message).includes('secret-folder-name'));
    return true;
  };
  const found = () => true; // the spy never runs anything, so pretend the program exists
  await assert.rejects(openAlive({ target: secretTarget, env: fb.baseEnv({ DISPLAY: ':1' }) }, { spawn: throwing, fileExists: found }), check);
  const spy = fb.spySpawn((child) => {
    const err = new Error(`spawn ${secretTarget} ENOENT`);
    err.code = 'ENOENT';
    setImmediate(() => child.emit('error', err));
  });
  await assert.rejects(openAlive({ target: secretTarget, env: fb.baseEnv({ DISPLAY: ':1' }) }, { spawn: spy, fileExists: found }), check);
});

test('a child that never exits is reported running after settleMs; a late exit afterwards changes nothing', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const children = [];
  const spy = fb.spySpawn((child) => {
    child.unref = () => {};
    children.push(child);
  });
  const result = await openAlive({ target: path.join(fb.root, 'launch-1.html'), env: fb.baseEnv({ DISPLAY: ':1' }), settleMs: 40 }, { spawn: spy, fileExists: () => true });
  assert.deepEqual(result, { outcome: 'running' });
  children[0].closeNow(0, null); // a late exit changes nothing and throws nothing
  assert.equal(liveRunCount(), 0);
});
