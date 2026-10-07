'use strict';

/*
 * Linux integration tests for src/proc/run.js against REAL fake programs (ADR 0046).
 *
 * Nothing here ever starts a real program. Every spawn goes through test/helpers/proc-fakebin.js:
 * PATH is exactly a scratch folder of fakes, `fb.run` refuses anything else before the spawner is
 * called, and the guarded spawn refuses anything resolving outside the scratch folder. The
 * spawner's `run` is deliberately never imported into this file.
 *
 * Tests that pass today and so prove nothing about enforcement: the args byte-identity test proves
 * only "no shell" on Linux (not Windows); the ambient vendor record on CI (no vendor program is
 * installed there, so only the probe proves there is no fallback).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { spawnSync } = require('child_process');
const {
  ProcError,
  MAX_LIVE_RUNS,
  killAll,
  liveRunCount,
} = require('../src/proc/run');
const { makeFakeBin } = require('./helpers/proc-fakebin');

const SKIP = process.platform === 'win32' ? 'POSIX fakes; Windows is C98/C128' : false;
const ROOT = path.join(__dirname, '..');
const PROBE = path.join(__dirname, 'helpers', 'proc-ambient-probe.js');

// --- small helpers ---------------------------------------------------------------------------------

function hex(n = 12) {
  return crypto.randomBytes(n).toString('hex');
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

async function waitFor(cond, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

function isDead(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return true;
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state === 'Z';
  } catch {
    return false;
  }
}

async function waitDead(pid) {
  return waitFor(() => isDead(pid), 5000, 50);
}

function readPid(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const pid = Number(txt);
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `bad pid in ${file}`);
  return pid;
}

/** Exact-pid cleanup so a failing test cannot leave a fake behind. Never a pattern kill. */
function killExact(pidfile) {
  for (const f of [pidfile, pidfile + '.leader']) {
    try {
      process.kill(readPid(f), 'SIGKILL');
    } catch {
      /* already gone, or never written */
    }
  }
}

/** Starts a run whose fake prints READY, resolving `ready` when that line is seen. */
function startWatched(fb, opts, deps) {
  let acc = '';
  let seen = false;
  let resolveReady;
  const ready = new Promise((r) => {
    resolveReady = r;
  });
  const promise = fb.run(
    {
      ...opts,
      onStdout: (b) => {
        acc += b.toString('utf8');
        if (!seen && acc.includes('READY')) {
          seen = true;
          resolveReady(true);
        }
      },
    },
    deps,
  );
  promise.then(
    () => resolveReady(seen),
    () => resolveReady(seen),
  );
  return { promise, ready, seenReady: () => seen };
}

function assertClean(err, sentinels, label) {
  const renderings = [
    err.message,
    err.stack,
    String(err),
    util.inspect(err, { depth: 6, showHidden: true }),
    JSON.stringify(err),
  ];
  for (const r of renderings) {
    for (const s of sentinels) assert.ok(!String(r).includes(s), `${label}: a sentinel leaked into a rendering`);
  }
  assert.equal(err.cause, undefined, `${label}: no cause`);
  assert.ok(err instanceof ProcError, `${label}: is a ProcError`);
}

describe('src/proc/run.js against fakes', { skip: SKIP }, () => {
  // --- arguments, shell, stdio -------------------------------------------------------------------

  test('arguments arrive byte-identical, with no shell and piped stdio', async (t) => {
    const fb = makeFakeBin(t);
    const args = ['a&b', 'a|b', 'a^b', '%PATH%', 'say "hi"', 'a;b', '$(id)', '`id`', 'l1\nl2', '', 'trail\\', 'ünï'];
    const result = await fb.run({ command: 'git', args, env: fb.baseEnv() });
    assert.deepEqual(fb.parse(result).argv, args);
    assert.equal(result.exitCode, 0);
    const opts = fb.attempts[fb.attempts.length - 1].options;
    assert.equal(opts.shell, false);
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.detached, true);
    assert.equal(opts.windowsVerbatimArguments, undefined);
  });

  test('the exact spawn options on Linux (spy): no shell, piped stdio, detached, an empty temp cwd', async (t) => {
    const fb = makeFakeBin(t);
    const spy = fb.spySpawn();
    const env = fb.baseEnv({ SCRIPTORIUM_TEST_UNLISTED: 'u' });
    const result = await fb.run({ command: 'ssh', args: ['-V'], env }, { spawn: spy });
    const call = spy.calls[0];
    assert.equal(call.file, path.join(fb.dir, 'ssh'));
    assert.deepEqual(call.args, ['-V']);
    const { cwd, env: childEnv, ...rest } = call.options;
    assert.deepEqual(rest, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: true });
    assert.deepEqual(childEnv, { PATH: fb.dir, HOME: fb.root, LANG: 'C' });
    assert.equal(cwd, result.cwd);
    assert.equal(result.command, 'ssh');
  });

  test('exit codes are reported, not thrown', async (t) => {
    const fb = makeFakeBin(t);
    const r = await fb.run({ command: 'rsync', env: fb.baseEnv({}), extraEnv: { SCRIPTORIUM_FAKE_MODE: 'exit:3' } });
    assert.equal(r.exitCode, 3);
    assert.equal(r.signal, null);
    assert.equal(r.timedOut, false);
    assert.equal(r.cancelled, false);
    assert.ok(Number.isFinite(r.durationMs) && r.durationMs >= 0);
    assert.equal(r.stdoutBytes, r.stdout.length);
    assert.equal(r.stderrBytes, 0);
    assert.equal(r.stderr.length, 0);
  });

  // --- the allowlist -----------------------------------------------------------------------------

  test('allowlist: every near-name, path form and non-string is refused before any spawn', async (t) => {
    const fb = makeFakeBin(t);
    const spy = fb.spySpawn();
    const table = [
      'gitx', 'claude-code', 'sshd', 'rsync2', 'whisper', 'git.exe', 'whisper-cli.exe', './git', 'bin/git',
      '/usr/bin/git', 'C:\\x\\git.exe', '..\\git', 'Git', 'GIT', ' git', 'git ', '', 'node', 'sh', 'cmd',
      'powershell', 42, ['git'], undefined, null, { toString: () => 'git' },
    ];
    for (const command of table) {
      const err = await rejection(fb.run({ command, env: fb.baseEnv() }, { spawn: spy }));
      assert.ok(err instanceof ProcError, String(command));
      assert.equal(err.code, 'E_PROC_NOT_ALLOWED', String(command));
      assert.equal(err.command, undefined, 'a refused name is never echoed');
    }
    assert.equal(spy.calls.length, 0);
    assert.equal(fb.attempts.length, 0);
  });

  test('allowlist: every allowed name runs, and each fake reports its own name', async (t) => {
    const fb = makeFakeBin(t);
    for (const name of ['claude', 'codex', 'gemini', 'git', 'rsync', 'ssh', 'whisper-cli']) {
      const r = await fb.run({ command: name, env: fb.baseEnv() });
      assert.equal(fb.parse(r).name, name);
      assert.equal(r.resolvedPath, path.join(fb.dir, name));
    }
  });

  // --- resolution against the given PATH only -----------------------------------------------------

  test('resolution: not found on the given PATH gives E_PROC_NOT_FOUND and nothing is spawned', async (t) => {
    const empty = makeFakeBin(t, { empty: true });
    const err = await rejection(empty.run({ command: 'claude', env: empty.baseEnv() }));
    assert.equal(err.code, 'E_PROC_NOT_FOUND');
    assert.equal(err.command, 'claude');
    assert.equal(empty.attempts.length, 0);
  });

  test('resolution: a non-executable file or a directory is not a candidate', async (t) => {
    const fb = makeFakeBin(t, { empty: true });
    fs.writeFileSync(path.join(fb.dir, 'claude'), '#!/bin/sh\n', { mode: 0o644 });
    fs.chmodSync(path.join(fb.dir, 'claude'), 0o644);
    fs.mkdirSync(path.join(fb.dir, 'codex'));
    for (const command of ['claude', 'codex']) {
      const err = await rejection(fb.run({ command, env: fb.baseEnv() }));
      assert.equal(err.code, 'E_PROC_NOT_FOUND', command);
    }
    assert.equal(fb.attempts.length, 0);
  });

  test('rule e: with no fakes on the child PATH, the ambient PATH and the home folders are never consulted (probe)', (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-decoy-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const marker = path.join(scratch, 'marker');
    const decoyBin = path.join(scratch, 'decoy-bin');
    const decoyHome = path.join(scratch, 'decoy-home');
    const body = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'DECOY-RAN');\n`;
    for (const dir of [decoyBin, path.join(decoyHome, '.local', 'bin'), path.join(decoyHome, '.claude', 'local')]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'claude'), body, { mode: 0o755 });
      fs.chmodSync(path.join(dir, 'claude'), 0o755);
    }
    const res = spawnSync(process.execPath, [PROBE, marker], {
      env: { PATH: decoyBin, HOME: decoyHome },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(res.status, 0, 'the probe itself must run cleanly');
    const report = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.deepEqual(report, { code: 'E_PROC_NOT_FOUND', attempts: 0, marker: false });
    assert.equal(fs.existsSync(marker), false);
  });

  // --- the guard itself (rule b) -------------------------------------------------------------------

  test('rule b: the guarded run refuses any PATH but the scratch folder, before the spawner is called', async (t) => {
    const fb = makeFakeBin(t);
    const spy = fb.spySpawn();
    const bad = [
      { PATH: '/usr/bin' },
      { PATH: fb.dir + path.delimiter + '/usr/bin' },
      { PATH: fb.dir, Path: fb.dir },
      { Path: fb.dir },
      {},
    ];
    for (const env of bad) {
      await assert.rejects(() => fb.run({ command: 'git', env }, { spawn: spy }), /proc-fakebin/);
    }
    await assert.rejects(() => fb.run({ command: 'git', env: fb.baseEnv(), extraEnv: { path: fb.dir } }, { spawn: spy }), /proc-fakebin/);
    await assert.rejects(() => fb.run({ command: 'git', env: fb.baseEnv() }, { spawn: () => ({}) }), /proc-fakebin/);
    await assert.rejects(() => fb.run({ command: 'git', env: fb.baseEnv() }, { platform: 'win32' }), /proc-fakebin/);
    assert.equal(spy.calls.length, 0);
    assert.equal(fb.attempts.length, 0);
  });

  test('rule b: the guarded spawn refuses a file outside the scratch folder, a shell, or a foreign PATH', (t) => {
    const fb = makeFakeBin(t);
    const inside = path.join(fb.dir, 'git');
    assert.throws(() => fb.guardedSpawn(process.execPath, [], { shell: false, env: { PATH: fb.dir } }), /guard refused/);
    assert.throws(() => fb.guardedSpawn(inside, [], { shell: true, env: { PATH: fb.dir } }), /guard refused/);
    assert.throws(() => fb.guardedSpawn(inside, [], { shell: false, env: { PATH: '/usr/bin' } }), /guard refused/);
    assert.throws(() => fb.guardedSpawn(inside, [], { env: { PATH: fb.dir } }), /guard refused/);
    assert.throws(() => fb.guardedSpawn(path.join(fb.dir, 'nonexistent'), [], { shell: false, env: { PATH: fb.dir } }), /guard refused/);
    assert.equal(fb.refusals.length, 5);
  });

  test('rule c: the scratch folder wins for the vendor names and none equals an ambient program', (t) => {
    const fb = makeFakeBin(t);
    for (const name of ['claude', 'codex', 'gemini']) {
      const real = fs.realpathSync(path.join(fb.dir, name));
      assert.ok(real.startsWith(fs.realpathSync(fb.root) + path.sep));
    }
    assert.ok(fs.readFileSync(path.join(fb.dir, 'claude'), 'utf8').startsWith('#!' + process.execPath));
  });

  // --- environment ----------------------------------------------------------------------------------

  test('env scrub: planted sentinels in env AND extraEnv never reach the child; the key set is the literal expected one', async (t) => {
    const fb = makeFakeBin(t);
    const s = {
      ANTHROPIC_API_KEY: 'envsent-' + hex(),
      ANTHROPIC_AUTH_TOKEN: 'envsent-' + hex(),
      CLAUDE_CODE_USE_BEDROCK: 'envsent-' + hex(),
      anthropic_api_key: 'envsent-' + hex(),
      claude_code_use_vertex: 'envsent-' + hex(),
    };
    const unlisted = 'envsent-' + hex();
    const env = fb.baseEnv({ ...s, SCRIPTORIUM_TEST_UNLISTED: unlisted, TZ: 'UTC' });
    const result = await fb.run({
      command: 'claude',
      env,
      extraEnv: { ...s, SCRIPTORIUM_TEST_EXTRA: 'extra-ok' },
    });
    const dump = fb.parse(result);
    const text = JSON.stringify(dump);
    for (const v of [...Object.values(s), unlisted]) assert.ok(!text.includes(v));
    for (const k of Object.keys(s)) assert.equal(Object.prototype.hasOwnProperty.call(dump.env, k), false, k);
    assert.equal(dump.env.SCRIPTORIUM_TEST_UNLISTED, undefined);
    assert.deepEqual(Object.keys(dump.env).sort(), ['HOME', 'LANG', 'PATH', 'SCRIPTORIUM_TEST_EXTRA', 'TZ']);
    assert.equal(dump.env.PATH, fb.dir);
    assert.equal(dump.env.SCRIPTORIUM_TEST_EXTRA, 'extra-ok');
  });

  test('env: the ambient process environment is never inherited', async (t) => {
    const fb = makeFakeBin(t);
    const result = await fb.run({ command: 'git', env: { PATH: fb.dir } });
    assert.deepEqual(Object.keys(fb.parse(result).env), ['PATH']);
  });

  // --- the working folder -----------------------------------------------------------------------------

  test('working folder: an empty scriptorium-proc folder under the temp dir, removed afterwards', async (t) => {
    const fb = makeFakeBin(t);
    const result = await fb.run({ command: 'git', env: fb.baseEnv() });
    const dump = fb.parse(result);
    assert.equal(path.dirname(dump.cwd), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(dump.cwd).startsWith('scriptorium-proc-'));
    assert.equal(path.basename(dump.cwd), path.basename(result.cwd));
    assert.deepEqual(dump.cwdEntries, []);
    assert.ok(path.relative(ROOT, dump.cwd).startsWith('..'), 'not inside the repository');
    assert.equal(fs.existsSync(result.cwd), false);
  });

  test('working folder: a failed removal (EBUSY) is swallowed and the run still resolves', async (t) => {
    const fb = makeFakeBin(t);
    const orig = fs.rmSync;
    let reached = 0;
    fs.rmSync = function patched(p, o) {
      if (path.basename(String(p)).startsWith('scriptorium-proc-')) {
        reached += 1;
        const e = new Error('EBUSY: resource busy or locked');
        e.code = 'EBUSY';
        throw e;
      }
      return orig.call(this, p, o);
    };
    let result;
    try {
      result = await fb.run({ command: 'git', env: fb.baseEnv() });
    } finally {
      fs.rmSync = orig;
    }
    assert.equal(reached, 1, 'the patch was reached');
    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(result.cwd), true);
    fs.rmSync(result.cwd, { recursive: true, force: true }); // exact path
  });

  test('working folder: removed after a failed run too (spawn refused by the spy)', async (t) => {
    const fb = makeFakeBin(t);
    const spy = fb.spySpawn(() => {
      throw new Error('boom ' + hex());
    });
    const err = await rejection(fb.run({ command: 'git', env: fb.baseEnv() }, { spawn: spy }));
    assert.equal(err.code, 'E_PROC_SPAWN');
    assert.equal(fs.existsSync(spy.calls[0].options.cwd), false);
  });

  // --- stdin ------------------------------------------------------------------------------------------

  test('stdin: written then closed; the sentinel is in stdin only, never argv or env', async (t) => {
    const fb = makeFakeBin(t);
    const sentinel = 'stdinsent-' + hex();
    for (const stdin of [sentinel, Buffer.from(sentinel, 'utf8')]) {
      const r = await fb.run({ command: 'claude', args: ['-p'], env: fb.baseEnv(), stdin });
      const dump = fb.parse(r);
      assert.equal(dump.stdin, sentinel);
      assert.ok(!JSON.stringify(dump.argv).includes(sentinel));
      assert.ok(!JSON.stringify(dump.env).includes(sentinel));
    }
  });

  test('stdin: none given means an empty string and no hang', async (t) => {
    const fb = makeFakeBin(t);
    const r = await fb.run({ command: 'claude', env: fb.baseEnv(), timeoutMs: 20000 });
    assert.equal(fb.parse(r).stdin, '');
    assert.equal(r.timedOut, false);
  });

  test('stdin: a child that never reads 1 MiB of it and exits does not crash the run', async (t) => {
    const fb = makeFakeBin(t);
    const r = await fb.run({
      command: 'claude',
      env: fb.baseEnv(),
      extraEnv: { SCRIPTORIUM_FAKE_MODE: 'no-read-exit' },
      stdin: 'x'.repeat(1024 * 1024),
    });
    assert.equal(r.exitCode, 0);
  });

  // --- streaming and caps ---------------------------------------------------------------------------------

  test('streaming: callbacks get the bytes and the result holds null for that stream only', async (t) => {
    const fb = makeFakeBin(t);
    const got = [];
    const r = await fb.run({ command: 'git', env: fb.baseEnv(), onStdout: (b) => got.push(b) });
    assert.equal(r.stdout, null);
    assert.ok(Buffer.isBuffer(r.stderr));
    const all = Buffer.concat(got);
    assert.equal(r.stdoutBytes, all.length);
    assert.ok(all.toString('utf8').startsWith(fb.sentinel));
    const errBits = [];
    const r2 = await fb.run({ command: 'git', env: fb.baseEnv(), onStderr: (b) => errBits.push(b) });
    assert.equal(r2.stderr, null);
    assert.ok(Buffer.isBuffer(r2.stdout));
    assert.equal(r2.stderrBytes, 0);
    assert.equal(errBits.length, 0);
  });

  for (const stream of ['stdout', 'stderr']) {
    test(`caps: ${stream} flood is cut at exactly the cap, the child is killed, and the run rejects`, async (t) => {
      const fb = makeFakeBin(t);
      const pidfile = path.join(fb.root, 'pids-cap-' + stream);
      t.after(() => killExact(pidfile));
      const delivered = [];
      const key = stream === 'stdout' ? 'maxStdoutBytes' : 'maxStderrBytes';
      const cb = stream === 'stdout' ? 'onStdout' : 'onStderr';
      const err = await rejection(
        fb.run({
          command: 'claude',
          env: fb.baseEnv(),
          extraEnv: { SCRIPTORIUM_FAKE_MODE: 'flood-' + stream, SCRIPTORIUM_FAKE_PIDFILE: pidfile },
          [key]: 65536,
          // the dump is on stdout; keep its cap large enough for the stderr case
          ...(stream === 'stderr' ? { maxStdoutBytes: 1048576 } : {}),
          [cb]: (b) => delivered.push(b),
          killGraceMs: 300,
          timeoutMs: 30000,
        }),
      );
      assert.equal(err.code, 'E_PROC_OUTPUT_CAP');
      assert.equal(err.stream, stream);
      assert.equal(err.limit, 65536);
      assert.equal(delivered.reduce((n, b) => n + b.length, 0), 65536);
      assert.ok(await waitDead(readPid(pidfile + '.leader')), 'the flooding child is dead');
    });
  }

  test('caps: output of exactly the cap is accepted, one byte over is not', async (t) => {
    const fb = makeFakeBin(t);
    const base = await fb.run({ command: 'git', env: fb.baseEnv() });
    const n = base.stdoutBytes;
    assert.ok(n > 100);
    const exact = await fb.run({ command: 'git', env: fb.baseEnv(), maxStdoutBytes: n });
    assert.equal(exact.stdoutBytes, n);
    const seen = [];
    const over = await rejection(fb.run({ command: 'git', env: fb.baseEnv(), maxStdoutBytes: n - 1, onStdout: (b) => seen.push(b) }));
    assert.equal(over.code, 'E_PROC_OUTPUT_CAP');
    assert.equal(over.limit, n - 1);
    assert.equal(seen.reduce((x, b) => x + b.length, 0), n - 1);
  });

  // --- killing the whole tree -----------------------------------------------------------------------------

  async function treeDead(pidfile) {
    const leader = readPid(pidfile + '.leader');
    const grandchild = readPid(pidfile);
    assert.ok(await waitDead(leader), 'the fake is dead');
    assert.ok(await waitDead(grandchild), 'the SIGTERM-ignoring grandchild is dead');
  }

  test('kill the tree: a timeout kills a SIGTERM-ignoring fake and its grandchild', async (t) => {
    const fb = makeFakeBin(t);
    const pidfile = path.join(fb.root, 'pids-timeout');
    t.after(() => killExact(pidfile));
    const w = startWatched(fb, {
      command: 'claude',
      env: fb.baseEnv(),
      extraEnv: { SCRIPTORIUM_FAKE_MODE: 'ignore-term-grandchild', SCRIPTORIUM_FAKE_PIDFILE: pidfile },
      timeoutMs: 6000,
      killGraceMs: 300,
    });
    const result = await w.promise;
    assert.ok(w.seenReady(), 'READY was seen, otherwise the test is inconclusive');
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    await treeDead(pidfile);
  });

  test('kill the tree: an abort kills a SIGTERM-ignoring fake and its grandchild', async (t) => {
    const fb = makeFakeBin(t);
    const pidfile = path.join(fb.root, 'pids-abort');
    t.after(() => killExact(pidfile));
    const ac = new AbortController();
    const w = startWatched(fb, {
      command: 'claude',
      env: fb.baseEnv(),
      extraEnv: { SCRIPTORIUM_FAKE_MODE: 'ignore-term-grandchild', SCRIPTORIUM_FAKE_PIDFILE: pidfile },
      signal: ac.signal,
      timeoutMs: 60000,
      killGraceMs: 300,
    });
    assert.equal(await w.ready, true, 'READY was seen');
    ac.abort();
    const result = await w.promise;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    await treeDead(pidfile);
  });

  test('kill the tree: a polite child dies on the first signal, reported as cancelled with a signal', async (t) => {
    const fb = makeFakeBin(t);
    const pidfile = path.join(fb.root, 'pids-polite');
    t.after(() => killExact(pidfile));
    const ac = new AbortController();
    const w = startWatched(fb, {
      command: 'gemini',
      env: fb.baseEnv(),
      extraEnv: { SCRIPTORIUM_FAKE_MODE: 'sleep', SCRIPTORIUM_FAKE_PIDFILE: pidfile },
      signal: ac.signal,
    });
    assert.equal(await w.ready, true);
    ac.abort();
    const r = await w.promise;
    assert.equal(r.cancelled, true);
    assert.equal(r.signal, 'SIGTERM');
    assert.ok(await waitDead(readPid(pidfile + '.leader')));
  });

  test('exit drain: a child that exits while a grandchild holds the pipes still settles, and the grandchild is killed', async (t) => {
    const fb = makeFakeBin(t);
    const pidfile = path.join(fb.root, 'pids-linger');
    t.after(() => killExact(pidfile));
    const started = Date.now();
    const r = await fb.run({
      command: 'codex',
      env: fb.baseEnv(),
      extraEnv: { SCRIPTORIUM_FAKE_MODE: 'linger', SCRIPTORIUM_FAKE_PIDFILE: pidfile },
      killGraceMs: 300,
      timeoutMs: 20000,
    });
    assert.ok(Date.now() - started < 15000, 'settled long before the 30 s grandchild ended');
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.cancelled, false);
    assert.ok(await waitDead(readPid(pidfile)), 'the lingering grandchild was killed');
  });

  // --- callbacks ---------------------------------------------------------------------------------------------

  test('a throwing callback kills the tree and rejects with E_PROC_CALLBACK, without echoing its message', async (t) => {
    const fb = makeFakeBin(t);
    const pidfile = path.join(fb.root, 'pids-callback');
    t.after(() => killExact(pidfile));
    const secret = 'cbsent-' + hex();
    const err = await rejection(
      fb.run({
        command: 'claude',
        env: fb.baseEnv(),
        extraEnv: { SCRIPTORIUM_FAKE_MODE: 'sleep', SCRIPTORIUM_FAKE_PIDFILE: pidfile },
        killGraceMs: 300,
        onStdout: () => {
          throw new Error(secret);
        },
      }),
    );
    assert.equal(err.code, 'E_PROC_CALLBACK');
    assert.equal(err.stream, 'stdout');
    assertClean(err, [secret], 'callback');
    assert.ok(await waitDead(readPid(pidfile + '.leader')));
  });

  // --- errors -----------------------------------------------------------------------------------------------

  test('options: unknown or dangerous options and bad values give E_PROC_BAD_OPTIONS', async (t) => {
    const fb = makeFakeBin(t);
    const spy = fb.spySpawn();
    const env = fb.baseEnv();
    const base = { command: 'git', env };
    const bad = [
      { shell: true }, { shell: false }, { cwd: '/' }, { stdio: 'inherit' }, { detached: false },
      { windowsVerbatimArguments: true }, { bogus: 1 }, { args: 'x' }, { args: [1] }, { args: [null] },
      { extraEnv: 'x' }, { extraEnv: { A: 1 } }, { stdin: 5 }, { timeoutMs: 0 }, { timeoutMs: -1 },
      { timeoutMs: 1.5 }, { timeoutMs: '5' }, { killGraceMs: 0 }, { maxStdoutBytes: 0 }, { maxStderrBytes: Infinity },
      { signal: {} }, { onStdout: 'x' }, { onStderr: 1 },
    ];
    for (const extra of bad) {
      const err = await rejection(fb.run({ ...base, ...extra }, { spawn: spy }));
      assert.equal(err.code, 'E_PROC_BAD_OPTIONS', JSON.stringify(extra));
    }
    assert.equal(spy.calls.length, 0);
    assert.equal(fb.attempts.length, 0);
  });

  test('an already aborted signal gives E_PROC_ABORTED and nothing is spawned', async (t) => {
    const fb = makeFakeBin(t);
    const spy = fb.spySpawn();
    const ac = new AbortController();
    ac.abort();
    const err = await rejection(fb.run({ command: 'git', env: fb.baseEnv(), signal: ac.signal }, { spawn: spy }));
    assert.equal(err.code, 'E_PROC_ABORTED');
    assert.equal(spy.calls.length, 0);
  });

  test('NUL in an argument is refused on every platform, naming the index only', async (t) => {
    const fb = makeFakeBin(t);
    const spy = fb.spySpawn();
    const secret = 'argsent-' + hex();
    const err = await rejection(fb.run({ command: 'git', args: ['ok', secret + '\0'], env: fb.baseEnv() }, { spawn: spy }));
    assert.equal(err.code, 'E_PROC_ARG');
    assert.equal(err.reason, 'nul');
    assert.equal(err.index, 1);
    assertClean(err, [secret], 'nul');
    assert.equal(spy.calls.length, 0);
  });

  test('spawn failures: a throwing spawn and an error event both give E_PROC_SPAWN with a safe code only', async (t) => {
    const fb = makeFakeBin(t);
    const secret = 'spawnsent-' + hex();
    const thrower = fb.spySpawn(() => {
      const e = new Error('spawn failed ' + secret);
      e.code = 'EACCES';
      throw e;
    });
    const e1 = await rejection(fb.run({ command: 'git', env: fb.baseEnv() }, { spawn: thrower }));
    assert.equal(e1.code, 'E_PROC_SPAWN');
    assert.equal(e1.syscallCode, 'EACCES');
    assertClean(e1, [secret], 'thrown spawn');

    const evented = fb.spySpawn((child) => {
      child.pid = undefined;
      setImmediate(() => {
        const e = new Error('spawn x ENOENT ' + secret);
        e.code = 'ENOENT';
        child.emit('error', e);
      });
    });
    const e2 = await rejection(fb.run({ command: 'git', env: fb.baseEnv() }, { spawn: evented }));
    assert.equal(e2.code, 'E_PROC_SPAWN');
    assert.equal(e2.syscallCode, 'ENOENT');
    assertClean(e2, [secret], 'error event');
    assert.equal(fs.existsSync(evented.calls[0].options.cwd), false);
  });

  test('clean errors: no env or stdin sentinel appears in any rendering of any reachable error', async (t) => {
    const fb = makeFakeBin(t);
    const empty = makeFakeBin(t, { empty: true });
    const envSent = 'envsent-' + hex();
    const stdinSent = 'stdinsent-' + hex();
    const sentinels = [envSent, stdinSent];
    const common = { env: fb.baseEnv({ SCRIPTORIUM_SECRET: envSent }), extraEnv: { SCRIPTORIUM_SECRET2: envSent }, stdin: stdinSent };
    const ac = new AbortController();
    ac.abort();
    const spy = fb.spySpawn(() => {
      throw new Error(envSent + stdinSent);
    });
    const cases = {
      E_PROC_BAD_OPTIONS: () => fb.run({ command: 'git', ...common, shell: true }),
      E_PROC_NOT_ALLOWED: () => fb.run({ command: 'node', ...common }),
      E_PROC_ARG: () => fb.run({ command: 'git', args: [envSent + '\0'], ...common }),
      E_PROC_ENV: () => fb.run({ command: 'git', ...common, extraEnv: { BAD: 'a\0' + envSent } }),
      E_PROC_ABORTED: () => fb.run({ command: 'git', ...common, signal: ac.signal }),
      E_PROC_NOT_FOUND: () => empty.run({ command: 'git', ...common, env: empty.baseEnv({ SCRIPTORIUM_SECRET: envSent }) }),
      E_PROC_SPAWN: () => fb.run({ command: 'git', ...common }, { spawn: spy }),
      E_PROC_OUTPUT_CAP: () =>
        fb.run({ command: 'git', ...common, extraEnv: { SCRIPTORIUM_FAKE_MODE: 'echo', SCRIPTORIUM_SECRET2: envSent }, maxStdoutBytes: 10 }),
      E_PROC_CALLBACK: () =>
        fb.run({
          command: 'git',
          ...common,
          onStdout: () => {
            throw new Error(envSent + stdinSent);
          },
        }),
    };
    for (const [code, fn] of Object.entries(cases)) {
      const err = await rejection(fn());
      assert.equal(err.code, code);
      assertClean(err, sentinels, code);
    }
  });

  // --- bounded children -------------------------------------------------------------------------------------

  test('limits: the ninth live run is refused, killAll cancels all eight, and a second killAll resolves', async (t) => {
    assert.equal(MAX_LIVE_RUNS, 8);
    const fb = makeFakeBin(t);
    const pidfiles = [];
    const watched = [];
    for (let i = 0; i < 8; i++) {
      const pidfile = path.join(fb.root, 'pids-limit-' + i);
      pidfiles.push(pidfile);
      watched.push(
        startWatched(fb, {
          command: 'claude',
          env: fb.baseEnv(),
          extraEnv: { SCRIPTORIUM_FAKE_MODE: 'sleep', SCRIPTORIUM_FAKE_PIDFILE: pidfile },
          killGraceMs: 300,
        }),
      );
    }
    t.after(() => pidfiles.forEach(killExact));
    assert.equal(liveRunCount(), 8);
    const before = fb.attempts.length;
    const err = await rejection(fb.run({ command: 'claude', env: fb.baseEnv(), stdin: 'limit-stdin' }));
    assert.equal(err.code, 'E_PROC_LIMIT');
    assertClean(err, ['limit-stdin'], 'limit');
    assert.equal(fb.attempts.length, before, 'the refused run spawned nothing');
    for (const w of watched) assert.equal(await w.ready, true, 'every sleeper printed READY');
    await killAll();
    for (const w of watched) {
      const r = await w.promise;
      assert.equal(r.cancelled, true);
      assert.equal(r.timedOut, false);
    }
    assert.equal(liveRunCount(), 0);
    await killAll();
    await killAll();
    for (const pf of pidfiles) assert.ok(await waitDead(readPid(pf + '.leader')));
    // the slots are free again
    const again = await fb.run({ command: 'git', env: fb.baseEnv() });
    assert.equal(again.exitCode, 0);
  });

  test('killAll with nothing running resolves and is idempotent', async () => {
    assert.equal(liveRunCount(), 0);
    await killAll();
    await killAll();
    assert.equal(liveRunCount(), 0);
  });
});
