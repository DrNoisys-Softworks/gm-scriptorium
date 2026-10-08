'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { onStopSignal, stopSignalNames } = require('../src/util/stop-signals');

/*
 * Issue #27: serve (plain and --admin) stops cleanly on SIGTERM as well as SIGINT, and --json
 * emits NDJSON readiness/stopped lines. Spawns the real bin as a child. POSIX only: win32 has no
 * real SIGTERM (see .agents/windows-verification.md C88). Synthetic names only.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const skip = process.platform === 'win32' ? 'POSIX signals; Windows is C88' : false;

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-serve-signals-'));
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), '{"siteTitle":"Alpha Test"}\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'index.html'), '<html>hi</html>');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${out}'`, ''].join('\n'),
  );
  return { root, tmp, configPath };
}

function start(t, args, { root, tmp }) {
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');
  const child = spawn(process.execPath, [BIN, ...args], { env });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => (state.stdout += c));
  child.stderr.on('data', (c) => (state.stderr += c));
  state.exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  state.child = child;
  state.waitLines = (n) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; stdout: ${state.stdout} stderr: ${state.stderr}`)), 60000);
      const check = () => {
        const got = state.stdout.split('\n').filter(Boolean);
        if (got.length >= n) {
          clearTimeout(timer);
          child.stdout.removeListener('data', check);
          resolve(got);
        }
      };
      child.stdout.on('data', check);
      check();
    });
  return state;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function post(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', agent: false, headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

const PORT_PLAIN = 8381;

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`#27: plain serve --json: ${signal} closes the port, exits 0, JSON lines parse`, { skip }, async (t) => {
    const s = scratch();
    t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
    const run = start(t, ['serve', 'alpha', '--json', '--port', String(PORT_PLAIN), '--config', s.configPath], s);
    const [ready] = await run.waitLines(1);
    const obj = JSON.parse(ready);
    assert.equal(obj.event, 'ready');
    assert.equal(obj.port, PORT_PLAIN);
    assert.equal(obj.url, `http://127.0.0.1:${PORT_PLAIN}`);
    assert.equal(await get(PORT_PLAIN, '/'), 200);
    run.child.kill(signal);
    const { code, signal: sig } = await run.exit;
    assert.equal(sig, null, 'exited via its own handler, not killed by the signal');
    assert.equal(code, 0);
    const lines = run.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines[lines.length - 1], { event: 'stopped', signal, exitCode: 0 });
    assert.equal(await canConnect(PORT_PLAIN), false, 'listener closed');
  });
}

test('#27: plain serve without --json prints human lines and a final "stopped." on SIGTERM', { skip }, async (t) => {
  const s = scratch();
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const run = start(t, ['serve', 'alpha', '--port', '8382', '--config', s.configPath], s);
  const [line] = await run.waitLines(1);
  assert.match(line, /^serving .* at http:\/\/127\.0\.0\.1:8382 \(Ctrl-C to stop\)$/);
  run.child.kill('SIGTERM');
  const { code, signal: sig } = await run.exit;
  assert.equal(sig, null, run.stdout + run.stderr);
  assert.equal(code, 0);
  assert.match(run.stdout, /stopped\.\n$/);
  assert.equal(await canConnect(8382), false);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`#27: serve --admin --json: ${signal} closes both ports, removes the preview temp dir, exits 0`, { skip }, async (t) => {
    const s = scratch();
    t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
    const run = start(t, ['serve', '--admin', 'alpha', '--json', '--port', '8383', '--config', s.configPath], s);
    const [ready] = await run.waitLines(1);
    const obj = JSON.parse(ready);
    assert.equal(obj.event, 'ready');
    assert.equal(obj.mode, 'admin');
    assert.equal(obj.adminPort, 8383);
    assert.match(obj.adminUrl, /^http:\/\/127\.0\.0\.1:8383\/auth\?token=[A-Za-z0-9_-]{43}$/);
    assert.match(obj.previewUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(Number.isInteger(obj.previewPort) && obj.previewPort > 0);
    assert.equal(await canConnect(obj.previewPort), true);
    // The preview temp dir is created lazily by the first preview build: trigger one so the
    // "cleaned up" assertion below is not vacuous.
    const token = obj.adminUrl.match(/token=([A-Za-z0-9_-]{43})$/)[1];
    await post(8383, '/api/preview', { Cookie: `scriptorium_admin_8383=${token}` });
    assert.ok(fs.readdirSync(s.tmp).some((n) => n.startsWith('scriptorium-preview-')), 'preview temp dir exists before the signal');
    run.child.kill(signal);
    const { code, signal: sig } = await run.exit;
    assert.equal(sig, null);
    assert.equal(code, 0);
    const lines = run.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines[lines.length - 1], { event: 'stopped', signal, exitCode: 0 });
    assert.equal(await canConnect(8383), false);
    assert.equal(await canConnect(obj.previewPort), false);
    assert.deepEqual(fs.readdirSync(s.tmp), [], 'no temp dirs left behind');
  });
}

test('#27: stop-signal registration: every platform name fires the handler exactly once, then detaches', () => {
  // ADR 0028, section 9: Windows reports a closed console window as SIGHUP in every serve mode;
  // POSIX registers SIGHUP only when the caller asks (launch mode), so serve --admin behaves there
  // exactly as it did before launch mode existed.
  assert.deepEqual(stopSignalNames('linux'), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(stopSignalNames('darwin'), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(stopSignalNames('win32'), ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  assert.deepEqual(stopSignalNames('linux', { hup: true }), ['SIGINT', 'SIGTERM', 'SIGHUP']);
  assert.deepEqual(stopSignalNames('linux', { hup: false }), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(stopSignalNames('win32', { hup: false }), ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  const cases = [
    ['linux', undefined, ['SIGINT', 'SIGTERM']],
    ['linux', { hup: true }, ['SIGINT', 'SIGTERM', 'SIGHUP']],
    ['win32', undefined, ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']],
  ];
  for (const [platform, opts, names] of cases) {
    for (const name of names) {
      const em = new EventEmitter();
      const seen = [];
      onStopSignal(em, (n) => seen.push(n), platform, opts);
      for (const n of names) assert.equal(em.listenerCount(n), 1, `${platform} registers ${n}`);
      assert.equal(em.listenerCount('SIGHUP'), names.includes('SIGHUP') ? 1 : 0);
      em.emit(name);
      em.emit(name);
      em.emit('SIGINT');
      assert.deepEqual(seen, [name]);
      for (const n of names) assert.equal(em.listenerCount(n), 0);
    }
  }
});

test('onStopSignal returns a dispose function that removes every listener without firing the handler', () => {
  for (const [platform, opts] of [['linux', undefined], ['linux', { hup: true }], ['win32', undefined]]) {
    const em = new EventEmitter();
    const seen = [];
    const dispose = onStopSignal(em, (n) => seen.push(n), platform, opts);
    assert.equal(typeof dispose, 'function');
    dispose();
    dispose();
    for (const n of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) assert.equal(em.listenerCount(n), 0, n);
    em.emit('SIGINT');
    assert.deepEqual(seen, []);
  }
});

test('#27: serve --json with no build prints one parseable error line and exits 3', { skip }, async (t) => {
  const s = scratch();
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  fs.rmSync(path.join(s.root, 'out'), { recursive: true });
  const run = start(t, ['serve', 'alpha', '--json', '--port', '8384', '--config', s.configPath], s);
  const { code } = await run.exit;
  assert.equal(code, 3); // #108: a campaign problem
  const lines = run.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'error');
  assert.match(lines[0].message, /no build exists at/);
});
