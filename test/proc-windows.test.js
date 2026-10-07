'use strict';

/*
 * Pure Windows logic for src/proc/run.js, run on every platform with a spy spawn that never
 * executes anything and a virtual file system. This proves the TEXT of the command line the
 * spawner would hand to Windows. It does not prove how cmd.exe treats that text: that is the
 * exe-run criteria C98 and C128 in .agents/windows-verification.md (OPEN).
 *
 * Every expected command line below is a hand-written literal. None is built by calling the code
 * under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProcError,
  BASE_ENV_WIN32,
  WINDOWS_EXTENSIONS,
  buildChildEnv,
  resolveCommand,
  buildInvocation,
} = require('../src/proc/run');
const { makeFakeBin, WIN_DIR } = require('./helpers/proc-fakebin');

const SHIM = 'C:\\scriptorium-fakebin\\bin\\claude.cmd';
const EXE = 'C:\\scriptorium-fakebin\\bin\\claude.exe';

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

test('the helper uses the literal virtual Windows folder these literals assume', (t) => {
  const fb = makeFakeBin(t, { empty: true });
  assert.equal(fb.winDir, 'C:\\scriptorium-fakebin\\bin');
  assert.equal(WIN_DIR, 'C:\\scriptorium-fakebin\\bin');
});

test('shim invocation: cmd.exe with a verbatim, fully quoted command line (hand-written literal)', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  await fb.run(
    { command: 'claude', args: ['-p', 'a&b', 'C:\\x y\\', ''], env: winEnv() },
    { platform: 'win32', spawn: spy, fileExists: (p) => p === SHIM },
  );
  const call = spy.calls[0];
  assert.equal(call.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(call.args, [
    '/d',
    '/s',
    '/v:off',
    '/c',
    '""C:\\scriptorium-fakebin\\bin\\claude.cmd" "-p" "a&b" "C:\\x y\\\\" """',
  ]);
  assert.equal(call.options.windowsVerbatimArguments, true);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, false);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('shim invocation: cmd metacharacters that are inert inside quotes pass through', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  await fb.run(
    { command: 'claude', args: ['a&b|c^d(e)f<g>h;i$j'], env: winEnv() },
    { platform: 'win32', spawn: spy, fileExists: (p) => p === SHIM },
  );
  assert.equal(
    spy.calls[0].args[4],
    '""C:\\scriptorium-fakebin\\bin\\claude.cmd" "a&b|c^d(e)f<g>h;i$j""',
  );
});

test('shim invocation: the four refused classes are refused with the right index and no spawn', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const bad = ['"', '%', '!', '\r', '\n', '\x01', '\x1f', '\t'];
  for (const ch of bad) {
    const spy = fb.spySpawn();
    const err = await refusal(() =>
      fb.run(
        { command: 'claude', args: ['ok', 'x' + ch + 'y'], env: winEnv() },
        { platform: 'win32', spawn: spy, fileExists: (p) => p === SHIM },
      ),
    );
    assert.ok(err instanceof ProcError);
    assert.equal(err.code, 'E_PROC_ARG', JSON.stringify(ch));
    assert.equal(err.reason, 'cmd-metachar');
    assert.equal(err.index, 1);
    assert.equal(spy.calls.length, 0);
  }
});

test('the same arguments with an .exe resolution pass through untouched, no verbatim flag', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  const args = ['say "hi"', '100%', 'wow!', 'l1\nl2'];
  await fb.run(
    { command: 'claude', args, env: winEnv() },
    { platform: 'win32', spawn: spy, fileExists: (p) => p === EXE },
  );
  const call = spy.calls[0];
  assert.equal(call.file, EXE);
  assert.deepEqual(call.args, ['say "hi"', '100%', 'wow!', 'l1\nl2']);
  assert.notEqual(call.options.windowsVerbatimArguments, true);
  assert.equal(call.options.shell, false);
});

test('NUL in an argument is refused on win32 as well, naming only the index', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const spy = fb.spySpawn();
  const err = await refusal(() =>
    fb.run(
      { command: 'claude', args: ['a', 'b\0c'], env: winEnv() },
      { platform: 'win32', spawn: spy, fileExists: (p) => p === EXE },
    ),
  );
  assert.equal(err.code, 'E_PROC_ARG');
  assert.equal(err.reason, 'nul');
  assert.equal(err.index, 1);
  assert.equal(spy.calls.length, 0);
});

test('a shim path containing a percent sign, quote, bang or control character is refused as unsafe', () => {
  // The guarded run only allows the scratch PATH, so the unsafe path is reached through the pure function.
  for (const bad of ['C:\\a%b\\claude.cmd', 'C:\\a"b\\claude.cmd', 'C:\\a!b\\claude.cmd', 'C:\\a\nb\\claude.cmd']) {
    assert.throws(
      () => buildInvocation({ resolvedPath: bad, kind: 'cmd-shim' }, [], { platform: 'win32', env: winEnv() }),
      (e) => e instanceof ProcError && e.code === 'E_PROC_SHIM',
    );
  }
});

test('SystemRoot missing, or not matching the pattern, refuses every win32 run before spawn', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  for (const env of [{ PATH: WIN_DIR }, winEnv({ SystemRoot: 'C:\\Win dows' }), winEnv({ SystemRoot: 'C:\\Windows\\..\\x%' }), winEnv({ SystemRoot: '' })]) {
    const spy = fb.spySpawn();
    const err = await refusal(() =>
      fb.run({ command: 'claude', env }, { platform: 'win32', spawn: spy, fileExists: (p) => p === EXE }),
    );
    assert.equal(err.code, 'E_PROC_ENV');
    assert.equal(spy.calls.length, 0);
  }
});

test('SystemRoot is found case-insensitively and emitted with the canonical spelling', () => {
  const env = buildChildEnv({ Path: 'C:\\p', systemroot: 'C:\\Windows' }, {}, 'win32');
  assert.deepEqual(env, { PATH: 'C:\\p', SystemRoot: 'C:\\Windows' });
});

test('timeout on win32 runs taskkill from SystemRoot with exactly /PID <pid> /T /F, then falls back to child.kill', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  let leader = null;
  const spy = fb.spySpawn((child, call, n) => {
    if (n === 1) leader = child; // the shim run hangs
    else child.closeNow(0, null); // taskkill finishes
  });
  const result = await fb.run(
    { command: 'claude', env: winEnv(), timeoutMs: 40, killGraceMs: 40 },
    { platform: 'win32', spawn: spy, fileExists: (p) => p === SHIM },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(spy.calls[1].file, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(spy.calls[1].args, ['/PID', String(leader.pid), '/T', '/F']);
  assert.equal(spy.calls[1].options.shell, false);
  assert.equal(spy.calls[1].options.windowsHide, true);
  assert.equal(spy.calls[1].options.stdio, 'ignore');
  assert.ok(leader.killCalls.length >= 1, 'child.kill() is the fallback after the grace period');
});

test('abort on win32 reports cancelled and uses taskkill', async (t) => {
  const fb = makeFakeBin(t, { empty: true });
  const ac = new AbortController();
  let leader = null;
  const spy = fb.spySpawn((child, call, n) => {
    if (n === 1) {
      leader = child;
      setImmediate(() => ac.abort());
    } else child.closeNow(0, null);
  });
  const result = await fb.run(
    { command: 'claude', env: winEnv(), signal: ac.signal, timeoutMs: 60000, killGraceMs: 30 },
    { platform: 'win32', spawn: spy, fileExists: (p) => p === EXE },
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.deepEqual(spy.calls[1].args, ['/PID', String(leader.pid), '/T', '/F']);
});

// --- resolution (virtual file system, read-only) --------------------------------------------------

test('win32 resolution: the fixed extension list is .exe then .cmd and nothing else', () => {
  assert.deepEqual([...WINDOWS_EXTENSIONS], ['.exe', '.cmd']);
});

test('win32 resolution: .exe beats .cmd in the same folder, but folder order beats extension', () => {
  const both = new Set(['C:\\a\\claude.exe', 'C:\\a\\claude.cmd']);
  const r1 = resolveCommand('claude', { env: { PATH: 'C:\\a' }, platform: 'win32' }, { fileExists: (p) => both.has(p) });
  assert.deepEqual(r1, { resolvedPath: 'C:\\a\\claude.exe', kind: 'direct' });
  const order = new Set(['C:\\b\\claude.exe', 'C:\\a\\claude.cmd']);
  const r2 = resolveCommand('claude', { env: { PATH: 'C:\\a;C:\\b' }, platform: 'win32' }, { fileExists: (p) => order.has(p) });
  assert.deepEqual(r2, { resolvedPath: 'C:\\a\\claude.cmd', kind: 'cmd-shim' });
});

test('win32 resolution: .ps1, .bat, .com or an extensionless file alone is not found, PATHEXT or not', () => {
  for (const name of ['claude.ps1', 'claude.bat', 'claude.com', 'claude', 'claude.js']) {
    const files = new Set(['C:\\a\\' + name]);
    assert.throws(
      () =>
        resolveCommand(
          'claude',
          { env: { PATH: 'C:\\a', PATHEXT: '.PS1;.BAT;.JS;.COM' }, platform: 'win32' },
          { fileExists: (p) => files.has(p) },
        ),
      (e) => e instanceof ProcError && e.code === 'E_PROC_NOT_FOUND',
      name,
    );
  }
});

test('win32 resolution: relative and drive-relative entries are skipped, quotes are stripped once', () => {
  const files = new Set(['rel\\claude.exe', '.\\claude.exe', 'C:claude.exe', 'C:rel\\claude.exe', 'C:\\q uoted\\claude.exe']);
  const fileExists = (p) => files.has(p);
  const r = resolveCommand(
    'claude',
    { env: { PATH: 'rel;.;C:;C:rel;"C:\\q uoted"' }, platform: 'win32' },
    { fileExists },
  );
  assert.deepEqual(r, { resolvedPath: 'C:\\q uoted\\claude.exe', kind: 'direct' });
  assert.throws(
    () => resolveCommand('claude', { env: { PATH: 'rel;.;C:;C:rel' }, platform: 'win32' }, { fileExists }),
    (e) => e.code === 'E_PROC_NOT_FOUND',
  );
});

test('win32 resolution: a UNC folder is accepted', () => {
  const files = new Set(['\\\\host\\share\\claude.exe']);
  const r = resolveCommand('claude', { env: { PATH: '\\\\host\\share' }, platform: 'win32' }, { fileExists: (p) => files.has(p) });
  assert.equal(r.resolvedPath, '\\\\host\\share\\claude.exe');
});

// --- POSIX resolution, virtual (kept here: pure) ----------------------------------------------------

test('posix resolution: empty, dot and relative entries are skipped and the first absolute hit wins', () => {
  const files = new Set(['/rel/claude', './claude', 'rel/claude', '/b/claude', '/c/claude']);
  const r = resolveCommand('claude', { env: { PATH: ':.:rel:/a:/b:/c' }, platform: 'linux' }, { fileExists: (p) => files.has(p) });
  assert.deepEqual(r, { resolvedPath: '/b/claude', kind: 'direct' });
  assert.throws(
    () => resolveCommand('claude', { env: { PATH: ':.:rel' }, platform: 'linux' }, { fileExists: (p) => files.has(p) }),
    (e) => e.code === 'E_PROC_NOT_FOUND',
  );
});

test('resolution refuses a missing or empty PATH, and a name off the allowlist', () => {
  for (const env of [{}, { PATH: '' }]) {
    assert.throws(() => resolveCommand('claude', { env, platform: 'linux' }), (e) => e.code === 'E_PROC_ENV');
  }
  assert.throws(() => resolveCommand('node', { env: { PATH: '/x' }, platform: 'linux' }), (e) => e.code === 'E_PROC_NOT_ALLOWED');
});

// --- environment (pure) --------------------------------------------------------------------------

test('win32 env: a source Path is copied as PATH, and two casings with different values are refused', () => {
  const ok = buildChildEnv({ Path: 'C:\\p', SystemRoot: 'C:\\Windows' }, {}, 'win32');
  assert.deepEqual(Object.keys(ok).sort(), ['PATH', 'SystemRoot']);
  assert.equal(ok.PATH, 'C:\\p');
  const same = buildChildEnv({ PATH: 'C:\\p', Path: 'C:\\p', SystemRoot: 'C:\\Windows' }, {}, 'win32');
  assert.equal(same.PATH, 'C:\\p');
  const err = (() => {
    try {
      buildChildEnv({ PATH: 'C:\\p', Path: 'C:\\other', SystemRoot: 'C:\\Windows' }, {}, 'win32');
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(err instanceof ProcError);
  assert.equal(err.code, 'E_PROC_ENV');
  assert.equal(err.variable, 'PATH');
  assert.ok(!/other/.test(err.message + err.stack));
});

test('win32 env: the strip is case-insensitive, including names added through extraEnv', () => {
  const planted = {
    anthropic_api_key: 'v1',
    Anthropic_Auth_Token: 'v2',
    Claude_Code_Use_Bedrock: 'v3',
    CLAUDE_CODE_USE_VERTEX: 'v4',
  };
  const env = buildChildEnv({ PATH: 'C:\\p', SystemRoot: 'C:\\Windows', ...planted }, planted, 'win32');
  assert.deepEqual(env, { PATH: 'C:\\p', SystemRoot: 'C:\\Windows' });
});

test('win32 env: the lower-case strip also holds under the linux rules (stricter than required)', () => {
  const planted = { anthropic_api_key: 'v1', claude_code_use_bedrock: 'v3', ANTHROPIC_API_KEY: 'v5' };
  const env = buildChildEnv({ PATH: '/p', ...planted }, planted, 'linux');
  assert.deepEqual(env, { PATH: '/p' });
});

test('win32 base list is pinned as a literal', () => {
  assert.deepEqual([...BASE_ENV_WIN32], [
    'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramW6432', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  ]);
});

test('env: PATH in extraEnv is refused in any casing; NUL and = are refused naming only the variable', () => {
  const secret = 'val-' + Math.random().toString(16).slice(2);
  for (const k of ['PATH', 'Path', 'path']) {
    assert.throws(() => buildChildEnv({ PATH: '/p' }, { [k]: secret }, 'linux'), (e) => e.code === 'E_PROC_ENV' && !String(e.stack).includes(secret));
  }
  assert.throws(() => buildChildEnv({ PATH: '/p' }, { GOOD: 'a\0' + secret }, 'linux'), (e) => e.code === 'E_PROC_ENV' && e.variable === 'GOOD' && !String(e.stack).includes(secret));
  assert.throws(() => buildChildEnv({ PATH: '/p' }, { 'BA=D': secret }, 'linux'), (e) => e.code === 'E_PROC_ENV' && !String(e.stack).includes(secret));
  assert.throws(() => buildChildEnv({ PATH: '/p', HOME: 'x\0' + secret }, {}, 'linux'), (e) => e.code === 'E_PROC_ENV' && e.variable === 'HOME' && !String(e.stack).includes(secret));
  assert.throws(() => buildChildEnv({}, {}, 'linux'), (e) => e.code === 'E_PROC_ENV');
  assert.throws(() => buildChildEnv({ PATH: '' }, {}, 'linux'), (e) => e.code === 'E_PROC_ENV');
});
