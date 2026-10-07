'use strict';

/*
 * Shared test helper: spawn `scriptorium serve --admin`, wait for its printed
 * `admin panel: ...auth?token=<43 chars>` line, and hand back the token. Replaces the per-file
 * fixed-wait polling loops that null-dereferenced when a loaded machine started the server slowly
 * (issue #101). Resolves on the ready line (no fixed wait), has a generous ceiling, and on any
 * failure (early exit, ceiling, spawn error) kills the child and rejects with the captured
 * stdout and stderr tails. Not a *.test.js file, so `node --test` does not run it.
 */

const { spawn } = require('child_process');

const DEFAULT_CEILING_MS = Number(process.env.SCRIPTORIUM_TEST_START_CEILING_MS) || 90000;
const TOKEN_RE = /token=([A-Za-z0-9_-]{43})/;
const TAIL = 2000;

function killChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (_) {
      /* gone */
    }
  }
}

// Stop gracefully (SIGINT), escalating to SIGKILL after graceMs. Safe to call twice.
function stopChild(child, graceMs = 4000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      killChild(child);
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGINT');
  });
}

/**
 * @param {string[]} args  argv after `node <bin>`, e.g. ['serve','--admin','--port',P,...]
 * @param {{bin:string, env?:object, cwd?:string, ceilingMs?:number}} opts
 * @returns {Promise<{child, token:string, output:()=>string, stop:()=>Promise<void>}>}
 */
function startAdminServer(args, opts) {
  const { bin, env, cwd, ceilingMs = DEFAULT_CEILING_MS } = opts;
  const child = spawn(process.execPath, [bin, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const output = () => stdout + stderr;
  const tail = (s) => (s.length > TAIL ? '...' + s.slice(-TAIL) : s);
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killChild(child);
      reject(new Error(`admin server not ready: ${why}\n--- stdout tail ---\n${tail(stdout)}\n--- stderr tail ---\n${tail(stderr)}`));
    };
    const check = () => {
      if (done) return;
      const m = TOKEN_RE.exec(stdout + '\n' + stderr);
      if (!m) return;
      done = true;
      clearTimeout(timer);
      child.stdout.removeListener('data', check);
      child.stderr.removeListener('data', check);
      resolve({ child, token: m[1], output, stop: () => stopChild(child) });
    };
    const timer = setTimeout(() => fail(`no token line within ${ceilingMs}ms`), ceilingMs);
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('error', (e) => fail(`spawn error: ${e.message}`));
    child.once('exit', (code, sig) => fail(`exited before ready (code=${code} signal=${sig})`));
  });
}

module.exports = { startAdminServer, stopChild, killChild };
