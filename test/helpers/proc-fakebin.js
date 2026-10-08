'use strict';

/*
 * PATH-scrub helper for every test that goes near src/proc/run.js (ADR 0046, rules a to g).
 *
 * The one rule: no real program is ever started by a test. A scratch folder holds a fake for
 * every allowed name, each run gets a PATH that is exactly that folder, and every spawn goes
 * through `guardedSpawn`, which refuses (without spawning) anything that resolves outside it.
 * Tests never call the spawner's `run` themselves; they call `fb.run`, which enforces the above
 * before and after the call.
 *
 * This file is the one test file allowed to require the spawner as a whole (the structural pin
 * in test/proc-structure.test.js exempts it by name).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn: realSpawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const assert = require('node:assert/strict');
const { run, resolveCommand } = require('../../src/proc/run');

// Written out here on purpose, not imported: an independent copy of the allowed names.
const FAKE_NAMES = ['claude', 'codex', 'gemini', 'git', 'rsync', 'ssh', 'whisper-cli'];
const VENDOR_NAMES = ['claude', 'codex', 'gemini'];

// Virtual Windows folder for simulated win32 runs. No real spawn is possible in that mode.
const WIN_DIR = 'C:\\scriptorium-fakebin\\bin';

// (g) PATH is snapshotted at load; cleanup() asserts it was never touched.
const PATH_AT_LOAD = process.env.PATH;

/** (c) Ambient realpaths of the vendor CLIs: a stat-only walk of the ambient PATH. Never executed. */
function recordAmbient() {
  const found = new Set();
  for (const dir of (PATH_AT_LOAD || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of VENDOR_NAMES) {
      try {
        const p = path.join(dir, name);
        if (fs.statSync(p).isFile()) found.add(fs.realpathSync(p));
      } catch {
        /* not there */
      }
    }
  }
  return found;
}
const AMBIENT = recordAmbient();

const spies = new WeakSet();
let nextSpyPid = 1000000000;

function isInside(real, realRoot) {
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

function implSource(sentinel) {
  return `'use strict';
const fs = require('fs');
const cp = require('child_process');
const SENTINEL = ${JSON.stringify(sentinel)};
module.exports = function main(name) {
  const mode = process.env.SCRIPTORIUM_FAKE_MODE || 'echo';
  const pidfile = process.env.SCRIPTORIUM_FAKE_PIDFILE || null;
  const noop = () => {};
  process.stdout.on('error', noop);
  process.stderr.on('error', noop);
  if (pidfile) fs.writeFileSync(pidfile + '.leader', String(process.pid));
  const safety = (ms) => setTimeout(() => process.exit(0), ms);
  function dump(stdin) {
    return JSON.stringify({
      sentinel: SENTINEL, name, argv: process.argv.slice(2), cwd: process.cwd(),
      cwdEntries: fs.readdirSync(process.cwd()), env: process.env, stdin,
    });
  }
  function head(stdin) { process.stdout.write(SENTINEL + '\\n' + dump(stdin) + '\\n'); }
  function readStdin(cb) {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => cb(''));
  }
  function flood(stream) {
    const chunk = Buffer.alloc(8192, 120);
    const pump = () => {
      let ok = true;
      while (ok) ok = stream.write(chunk);
      stream.once('drain', pump);
    };
    safety(60000);
    pump();
  }
  const GRANDCHILD = "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120000);";
  if (mode === 'echo') {
    readStdin((stdin) => head(stdin));
  } else if (mode.startsWith('exit:')) {
    const code = Number(mode.slice(5));
    readStdin((stdin) => {
      process.stdout.write(SENTINEL + '\\n' + dump(stdin) + '\\n', () => process.exit(code));
    });
  } else if (mode === 'sleep') {
    head(null);
    process.stdout.write('READY\\n');
    safety(120000);
  } else if (mode === 'ignore-term-grandchild') {
    process.on('SIGTERM', noop);
    const gc = cp.spawn(process.execPath, ['-e', GRANDCHILD, pidfile], { stdio: 'ignore' });
    gc.unref();
    head(null);
    const poll = setInterval(() => {
      let txt = '';
      try { txt = fs.readFileSync(pidfile, 'utf8'); } catch (e) { return; }
      if (txt.length > 0) { clearInterval(poll); process.stdout.write('READY\\n'); }
    }, 25);
    safety(120000);
  } else if (mode === 'flood-stdout') {
    head(null);
    flood(process.stdout);
  } else if (mode === 'flood-stderr') {
    head(null);
    flood(process.stderr);
  } else if (mode === 'no-read-exit') {
    process.stdout.write(SENTINEL + '\\n', () => process.exit(0));
  } else if (mode === 'linger') {
    const gc = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    fs.writeFileSync(pidfile, String(gc.pid));
    gc.unref();
    process.stdout.write(SENTINEL + '\\n', () => process.exit(0));
  } else {
    process.stdout.write(SENTINEL + '\\n');
    process.exit(64);
  }
};
`;
}

/** A child stand-in for spy spawns. Nothing is executed. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = nextSpyPid++;
  child.stdin = new PassThrough();
  child.stdin.resume();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  // A live child keeps the loop alive, as a real one would; released on close or when the streams are destroyed.
  const keepAlive = setInterval(() => {}, 50);
  const release = () => clearInterval(keepAlive);
  child.release = release;
  child.stdout.once('close', release);
  child.once('close', release);
  child.kill = (sig) => {
    child.killCalls.push(sig === undefined ? null : sig);
    return true;
  };
  child.on('error', release);
  child.closeNow = (code = 0, signal = null) => {
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  return child;
}

/**
 * @param {import('node:test').TestContext|null} t  registers cleanup when given
 * @param {{ empty?: boolean }} [opts]  empty: a bin folder with no fakes (the negative control)
 */
function makeFakeBin(t, { empty = false } = {}) {
  const exe = process.execPath;
  if (/\s/.test(exe) || exe.length > 120) {
    throw new Error('proc-fakebin: process.execPath is unusable as a shebang (whitespace or over 120 characters)');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fakebin-'));
  const dir = path.join(root, 'bin');
  const implDir = path.join(root, 'impl');
  fs.mkdirSync(dir);
  fs.mkdirSync(implDir);
  const realRoot = fs.realpathSync(root);
  const sentinel = 'fakebin-' + crypto.randomBytes(16).toString('hex');
  const implFile = path.join(implDir, 'fake.js');
  fs.writeFileSync(implFile, implSource(sentinel));
  if (!empty) {
    for (const name of FAKE_NAMES) {
      const f = path.join(dir, name);
      fs.writeFileSync(f, `#!${exe}\nrequire(${JSON.stringify(implFile)})(${JSON.stringify(name)});\n`);
      fs.chmodSync(f, 0o755);
    }
  }

  const fb = {
    root,
    dir,
    winDir: WIN_DIR,
    sentinel,
    attempts: [],
    refusals: [],
    cleaned: false,
    pidfiles: [],
  };

  // Register a pidfile base path: cleanup() kills the exact pids recorded there (never a pattern).
  fb.trackPidfile = (pidfile) => {
    fb.pidfiles.push(pidfile);
    return pidfile;
  };

  // (b) The guard on every real spawn.
  fb.guardedSpawn = function guardedSpawn(file, args, options) {
    const attempt = { file, args, options, tee: Buffer.alloc(0), refused: null };
    fb.attempts.push(attempt);
    const refuse = (why) => {
      attempt.refused = why;
      fb.refusals.push(why);
      throw new Error('proc-fakebin guard refused a spawn: ' + why);
    };
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      refuse('file does not resolve');
    }
    if (!isInside(real, realRoot)) refuse('file is outside the scratch folder');
    if (!options || options.shell !== false) refuse('shell is not false');
    if (!options.env || options.env.PATH !== dir) refuse('PATH is not the scratch folder');
    if (AMBIENT.has(real)) refuse('file is an ambient vendor program');
    attempt.real = true;
    const child = realSpawn(file, args, options);
    attempt.piped = Boolean(child.stdout);
    if (child.stdout) child.stdout.on('data', (b) => {
      if (attempt.tee.length < 4096) attempt.tee = Buffer.concat([attempt.tee, b]).subarray(0, 4096);
    });
    return child;
  };

  // A spy that records calls and executes nothing.
  fb.spySpawn = function spySpawn(handler) {
    const spy = function spy(file, args, options) {
      const child = makeFakeChild();
      const call = { file, args, options, child };
      spy.calls.push(call);
      if (handler) {
        try {
          handler(child, call, spy.calls.length);
        } catch (err) {
          child.release();
          throw err;
        }
      } else setImmediate(() => child.closeNow(0, null));
      return child;
    };
    spy.calls = [];
    spies.add(spy);
    return spy;
  };

  fb.baseEnv = (extra = {}) => ({ PATH: dir, HOME: root, LANG: 'C', ...extra });

  // (b) + (d): the only way a test calls the spawner.
  fb.run = async function guardedRun(opts, deps = {}) {
    assert.ok(opts && typeof opts === 'object', 'fb.run needs options');
    const env = opts.env || {};
    const pathKeys = Object.keys(env).filter((k) => /^path$/i.test(k));
    if (pathKeys.length !== 1 || pathKeys[0] !== 'PATH') throw new Error('proc-fakebin: env must have exactly one PATH key, spelled PATH');
    const sim = deps.platform === 'win32';
    if (env.PATH !== (sim ? WIN_DIR : dir)) throw new Error('proc-fakebin: PATH must be exactly the scratch folder');
    if (opts.extraEnv && Object.keys(opts.extraEnv).some((k) => /^path$/i.test(k))) {
      throw new Error('proc-fakebin: extraEnv must not carry PATH');
    }
    if (sim) {
      if (!spies.has(deps.spawn) || typeof deps.fileExists !== 'function') {
        throw new Error('proc-fakebin: simulated win32 needs a spy spawn and a virtual fileExists');
      }
    } else if (deps.platform !== undefined && deps.platform !== process.platform) {
      throw new Error('proc-fakebin: only win32 may be simulated');
    }
    const spy = deps.spawn !== undefined;
    if (spy && !spies.has(deps.spawn)) throw new Error('proc-fakebin: deps.spawn must come from fb.spySpawn()');
    const effective = { ...deps, spawn: spy ? deps.spawn : fb.guardedSpawn };

    const before = fb.attempts.length;
    let result;
    let error = null;
    try {
      result = await run(opts, effective);
    } catch (err) {
      error = err;
    }
    // (d) every real attempt must have produced the sentinel; the resolved path stays inside.
    for (const a of fb.attempts.slice(before)) {
      if (!a.real) continue;
      assert.ok(
        a.tee.toString('utf8').includes(sentinel),
        'proc-fakebin: spawn output did not carry the run sentinel (a real program?)',
      );
    }
    if (result && !spy) {
      assert.ok(isInside(fs.realpathSync(result.resolvedPath), realRoot), 'proc-fakebin: resolved outside the scratch folder');
      if (Buffer.isBuffer(result.stdout)) {
        assert.ok(result.stdout.toString('utf8').startsWith(sentinel), 'proc-fakebin: stdout did not start with the sentinel');
      }
    }
    if (error) throw error;
    return result;
  };

  /** Parse the fake's dump (line two of stdout). */
  fb.parse = (result) => {
    const lines = result.stdout.toString('utf8').split('\n');
    assert.equal(lines[0], sentinel);
    return JSON.parse(lines[1]);
  };

  fb.cleanup = () => {
    if (fb.cleaned) return;
    fb.cleaned = true;
    for (const base of fb.pidfiles) {
      for (const f of [base, base + '.leader']) {
        try {
          const pid = Number(fs.readFileSync(f, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
        } catch {
          /* never written, or already gone */
        }
      }
    }
    assert.equal(process.env.PATH, PATH_AT_LOAD, 'proc-fakebin: process PATH was modified');
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  // (c) The scratch folder must win for the vendor names, and never equal an ambient program.
  if (!empty) {
    for (const name of VENDOR_NAMES) {
      const r = resolveCommand(name, { env: { PATH: dir }, platform: process.platform });
      const real = fs.realpathSync(r.resolvedPath);
      assert.ok(isInside(real, realRoot), `proc-fakebin: ${name} resolves outside the scratch folder`);
      assert.ok(!AMBIENT.has(real), `proc-fakebin: ${name} resolves to an ambient program`);
    }
  }
  if (t && typeof t.after === 'function') t.after(() => fb.cleanup());
  return fb;
}

module.exports = { makeFakeBin, WIN_DIR, AMBIENT_VENDOR_PATHS: AMBIENT };
