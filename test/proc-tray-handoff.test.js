'use strict';

/*
 * The terminal hand-off to the tray helper (ADR 0046 addendum "The tray hand-off"; ADR 0057 section
 * 10): runTrayHandoff in src/proc/run.js. Every spawn here is a spy from fb.spySpawn, so no test ever
 * starts a program. The Windows paths are written out as literals, not built by the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runTrayHandoff, TRAY_ENV_EXTRA, ProcError, liveRunCount } = require('../src/proc/run');
const { makeFakeBin, WIN_DIR } = require('./helpers/proc-fakebin');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const EXEC_PATH = 'C:\\Tools\\GM-Scriptorium\\gm-scriptorium.exe';
const TRAY_PATH = 'C:\\Tools\\GM-Scriptorium\\gm-scriptorium-tray.exe';
const TRAY_DIR = 'C:\\Tools\\GM-Scriptorium';

function winEnv(extra = {}) {
  return {
    PATH: WIN_DIR,
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Profiles\\Sam',
    USERNAME: 'Sam',
    ...extra,
  };
}

/** Every fake child is released when its test ends, so a failing assertion cannot leave one holding the loop open. */
function releaseAfter(t, spy) {
  t.after(() => spy.calls.forEach((c) => c.child.release()));
  return spy;
}

/** A spy whose child exits with `code` straight away. */
function exitsWith(fb, code, t) {
  const spy = fb.spySpawn((child) => {
    setImmediate(() => child.closeNow(code, null));
  });
  return t ? releaseAfter(t, spy) : spy;
}

async function refused(promise, code, reason) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof ProcError, 'a ProcError');
    assert.equal(e.code, code);
    if (reason !== undefined) assert.equal(e.reason, reason);
    return true;
  });
}

test('the names carried on top of the base list are pinned as a literal (proves the list, not that it is enforced)', () => {
  assert.deepEqual([...TRAY_ENV_EXTRA], ['SCRIPTORIUM_CONFIG', 'SCRIPTORIUM_PROFILE', 'USERDOMAIN']);
  assert.ok(Object.isFrozen(TRAY_ENV_EXTRA));
});

test('starts exactly the helper beside the program, with --handoff, no shell, ignored stdio, in its folder', async (t) => {
  const fb = makeFakeBin(t);
  const spy = exitsWith(fb, 3, t);
  const result = await runTrayHandoff({ env: winEnv() }, { spawn: spy, platform: 'win32', execPath: EXEC_PATH });
  assert.deepEqual(result, { outcome: 'exited', exitCode: 3 });
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0];
  assert.equal(call.file, TRAY_PATH);
  assert.deepEqual(call.args, ['--handoff']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.cwd, TRAY_DIR);
  assert.equal(call.options.windowsHide, true);
  assert.notEqual(call.options.detached, true, 'the hand-off process is waited for, not detached');
});

test('the helper path comes from the program path alone: a network share works, a PATH copy is never used', async (t) => {
  const fb = makeFakeBin(t);
  const spy = exitsWith(fb, 0, t);
  const decoyDir = 'D:\\decoy\\bin';
  await runTrayHandoff(
    { env: winEnv({ PATH: `${decoyDir};${WIN_DIR}` }) },
    { spawn: spy, platform: 'win32', execPath: '\\\\fileserver\\apps\\gm\\gm-scriptorium.exe' },
  );
  assert.equal(spy.calls[0].file, '\\\\fileserver\\apps\\gm\\gm-scriptorium-tray.exe');
  assert.ok(!spy.calls[0].file.startsWith(decoyDir));
});

test('a caller cannot supply a path: trayPath, execPath or command in the options are refused before any spawn', async (t) => {
  const fb = makeFakeBin(t);
  const spy = exitsWith(fb, 0, t);
  for (const key of ['trayPath', 'execPath', 'command', 'file', 'args']) {
    await refused(
      runTrayHandoff({ env: winEnv(), [key]: 'D:\\elsewhere\\gm-scriptorium-tray.exe' }, { spawn: spy, platform: 'win32', execPath: EXEC_PATH }),
      'E_PROC_BAD_OPTIONS',
      'unknown-option',
    );
  }
  assert.equal(spy.calls.length, 0);
});

test('a tray from another folder is never started, whatever the environment says', async (t) => {
  const fb = makeFakeBin(t);
  const spy = exitsWith(fb, 0, t);
  await runTrayHandoff(
    { env: winEnv({ SCRIPTORIUM_TRAY: 'D:\\elsewhere\\gm-scriptorium-tray.exe', ProgramFiles: 'D:\\elsewhere' }) },
    { spawn: spy, platform: 'win32', execPath: EXEC_PATH },
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].file, TRAY_PATH);
});

test('the child environment keeps the settings path, the profile and USERDOMAIN, and nothing else outside the base list', async (t) => {
  const fb = makeFakeBin(t);
  const spy = exitsWith(fb, 0, t);
  const env = winEnv({
    SCRIPTORIUM_CONFIG: 'C:\\Scratch\\config.toml',
    SCRIPTORIUM_PROFILE: 'work',
    USERDOMAIN: 'HARBOUR-PC',
    ANTHROPIC_API_KEY: 'sk-not-real',
    SOME_OTHER_SECRET: 'nope',
  });
  await runTrayHandoff({ env }, { spawn: spy, platform: 'win32', execPath: EXEC_PATH });
  const childEnv = spy.calls[0].options.env;
  assert.equal(childEnv.SCRIPTORIUM_CONFIG, 'C:\\Scratch\\config.toml');
  assert.equal(childEnv.SCRIPTORIUM_PROFILE, 'work');
  assert.equal(childEnv.USERDOMAIN, 'HARBOUR-PC');
  assert.equal(childEnv.SystemRoot, 'C:\\Windows');
  assert.equal(childEnv.USERNAME, 'Sam');
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.SOME_OTHER_SECRET, undefined);
});

test('USERDOMAIN is found whatever its case, and absent names are simply left out', async (t) => {
  const fb = makeFakeBin(t);
  const spy = exitsWith(fb, 0, t);
  await runTrayHandoff({ env: winEnv({ UserDomain: 'HARBOUR-PC', Scriptorium_Config: 'C:\\Scratch\\c.toml' }) }, { spawn: spy, platform: 'win32', execPath: EXEC_PATH });
  const childEnv = spy.calls[0].options.env;
  assert.equal(childEnv.USERDOMAIN, 'HARBOUR-PC');
  assert.equal(childEnv.SCRIPTORIUM_CONFIG, 'C:\\Scratch\\c.toml');
  assert.equal(Object.keys(childEnv).some((k) => /^scriptorium_profile$/i.test(k)), false);

  const bare = exitsWith(fb, 0, t);
  await runTrayHandoff({ env: winEnv() }, { spawn: bare, platform: 'win32', execPath: EXEC_PATH });
  const names = Object.keys(bare.calls[0].options.env).map((k) => k.toUpperCase());
  for (const absent of ['USERDOMAIN', 'SCRIPTORIUM_CONFIG', 'SCRIPTORIUM_PROFILE']) assert.ok(!names.includes(absent), absent);
});

test('the exit code is reported as it came, and an exit with no code reports null', async (t) => {
  const fb = makeFakeBin(t);
  for (const code of [0, 1, 3, 4, 9]) {
    const result = await runTrayHandoff({ env: winEnv() }, { spawn: exitsWith(fb, code), platform: 'win32', execPath: EXEC_PATH });
    assert.deepEqual(result, { outcome: 'exited', exitCode: code });
  }
  const killed = releaseAfter(t, fb.spySpawn((child) => setImmediate(() => child.closeNow(null, 'SIGKILL'))));
  assert.deepEqual(await runTrayHandoff({ env: winEnv() }, { spawn: killed, platform: 'win32', execPath: EXEC_PATH }), { outcome: 'exited', exitCode: null });
});

test('a helper that is still running at the timeout gives { outcome: timeout } and is never killed', async (t) => {
  const fb = makeFakeBin(t);
  const spy = releaseAfter(t, fb.spySpawn(() => {}));
  const result = await runTrayHandoff({ env: winEnv(), timeoutMs: 40 }, { spawn: spy, platform: 'win32', execPath: EXEC_PATH });
  assert.deepEqual(result, { outcome: 'timeout' });
  const child = spy.calls[0].child;
  assert.deepEqual(child.killCalls, []);
  assert.equal(liveRunCount(), 0, 'never in the live-run set');
});

test('after a timeout the child no longer holds the process open, and a late exit or error changes nothing', async (t) => {
  const fb = makeFakeBin(t);
  let unrefs = 0;
  const spy = releaseAfter(t, fb.spySpawn((child) => {
    child.unref = () => {
      unrefs += 1;
    };
  }));
  const result = await runTrayHandoff({ env: winEnv(), timeoutMs: 30 }, { spawn: spy, platform: 'win32', execPath: EXEC_PATH });
  assert.equal(result.outcome, 'timeout');
  assert.equal(unrefs, 1);
  const child = spy.calls[0].child;
  assert.doesNotThrow(() => child.emit('error', new Error('late')));
  assert.doesNotThrow(() => child.closeNow(0, null));
});

test('the default wait is 15 seconds', async (t) => {
  const fb = makeFakeBin(t);
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    const handle = realSetTimeout(fn, ms, ...rest);
    timers.push(ms);
    return handle;
  };
  try {
    await runTrayHandoff({ env: winEnv() }, { spawn: exitsWith(fb, 0, t), platform: 'win32', execPath: EXEC_PATH });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(timers.includes(15000), `timers seen: ${timers.join(',')}`);
});

test('refusals: not Windows, a relative or unusable program path, bad options and a bad environment', async (t) => {
  const fb = makeFakeBin(t);
  const spy = exitsWith(fb, 0, t);
  const ok = { spawn: spy, platform: 'win32', execPath: EXEC_PATH };

  await refused(runTrayHandoff({ env: winEnv() }, { ...ok, platform: 'linux' }), 'E_PROC_NOT_ALLOWED', 'windows-only');
  await refused(runTrayHandoff({ env: winEnv() }, { ...ok, platform: 'darwin' }), 'E_PROC_NOT_ALLOWED', 'windows-only');
  for (const bad of ['gm-scriptorium.exe', '.\\gm-scriptorium.exe', '/usr/bin/gm-scriptorium', 'C:gm-scriptorium.exe', '', 'C:\\gm\u0000\\gm-scriptorium.exe', 'C:\\gm\n\\gm-scriptorium.exe']) {
    await refused(runTrayHandoff({ env: winEnv() }, { ...ok, execPath: bad }), 'E_PROC_BAD_OPTIONS', 'execPath');
  }
  await refused(runTrayHandoff(null, ok), 'E_PROC_BAD_OPTIONS', 'options');
  await refused(runTrayHandoff([], ok), 'E_PROC_BAD_OPTIONS', 'options');
  await refused(runTrayHandoff({}, ok), 'E_PROC_BAD_OPTIONS', 'env');
  await refused(runTrayHandoff({ env: 'PATH=x' }, ok), 'E_PROC_BAD_OPTIONS', 'env');
  for (const bad of [0, -1, 1.5, '15000', NaN, Infinity]) {
    await refused(runTrayHandoff({ env: winEnv(), timeoutMs: bad }, ok), 'E_PROC_BAD_OPTIONS', 'timeoutMs');
  }
  await refused(runTrayHandoff({ env: { SystemRoot: 'C:\\Windows' } }, ok), 'E_PROC_ENV', 'path-missing');
  await refused(runTrayHandoff({ env: winEnv({ SystemRoot: 'not-a-path' }) }, ok), 'E_PROC_ENV', 'systemroot');
  await refused(runTrayHandoff({ env: winEnv({ SCRIPTORIUM_CONFIG: 'C:\\x\u0000y' }) }, ok), 'E_PROC_ENV');
  assert.equal(spy.calls.length, 0, 'every refusal happens before a spawn');
});

test('a spawn that throws, or a child that reports an error, rejects E_PROC_SPAWN with only the system code', async (t) => {
  const fb = makeFakeBin(t);
  const throwing = fb.spySpawn(() => {
    const err = new Error('spawn C:\\secret\\path ENOENT');
    err.code = 'ENOENT';
    throw err;
  });
  await assert.rejects(runTrayHandoff({ env: winEnv() }, { spawn: throwing, platform: 'win32', execPath: EXEC_PATH }), (e) => {
    assert.ok(e instanceof ProcError);
    assert.equal(e.code, 'E_PROC_SPAWN');
    assert.equal(e.syscallCode, 'ENOENT');
    assert.ok(!/secret/.test(e.message));
    return true;
  });

  const erroring = releaseAfter(t, fb.spySpawn((child) => {
    setImmediate(() => {
      const err = new Error('boom');
      err.code = 'EACCES';
      child.emit('error', err);
    });
  }));
  await assert.rejects(runTrayHandoff({ env: winEnv() }, { spawn: erroring, platform: 'win32', execPath: EXEC_PATH }), (e) => {
    assert.equal(e.code, 'E_PROC_SPAWN');
    assert.equal(e.syscallCode, 'EACCES');
    return true;
  });
});
