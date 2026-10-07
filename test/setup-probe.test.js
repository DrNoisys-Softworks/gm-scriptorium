'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot, copySample } = require('./helpers/setup-fixtures');

const probe = require('../src/setup/probe');

/*
 * FR-16: path checks never stall the server. The probe runs a filesystem call on the libuv thread
 * pool and gives up after a bound; at most two may be in flight. The hanging call here is an
 * injected fake `fsp`, never a real unreachable share. The probe's own timer is unref'd (it must
 * never keep the panel alive), so a test that waits on a hanging call holds the loop open itself.
 */

function keepAlive(t) {
  const iv = setInterval(() => {}, 20);
  t.after(() => clearInterval(iv));
}

/** A fake fsp whose stat never settles until released. */
function hangingFsp() {
  const pending = [];
  return {
    calls: 0,
    stat() {
      this.calls++;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    release(err) {
      for (const p of pending.splice(0)) (err ? p.reject(err) : p.resolve({}));
    },
  };
}

test('probePath answers ok for a path that exists and missing for one that does not', async (t) => {
  const root = scratchRoot(t);
  assert.equal(await probe.probePath(root), 'ok');
  assert.equal(await probe.probePath(path.join(root, 'nope')), 'missing');
});

test('probePath maps ENOENT and ENOTDIR to missing, and any other error code to error', async () => {
  const mk = (code) => ({ stat: () => Promise.reject(Object.assign(new Error('x'), { code })) });
  assert.equal(await probe.probePath('/x', { fsp: mk('ENOENT') }), 'missing');
  assert.equal(await probe.probePath('/x', { fsp: mk('ENOTDIR') }), 'missing');
  assert.equal(await probe.probePath('/x', { fsp: mk('EACCES') }), 'error');
  assert.equal(await probe.probePath('/x', { fsp: mk('EIO') }), 'error');
});

test('a hanging stat resolves to timeout within the bound (injected short bound)', async (t) => {
  keepAlive(t);
  const fsp = hangingFsp();
  t.after(() => fsp.release());
  const started = Date.now();
  const state = await probe.probePath('//host/share/vault', { fsp, timeoutMs: 60 });
  const took = Date.now() - started;
  assert.equal(state, 'timeout');
  assert.ok(took >= 50 && took < 1500, `took ${took} ms`);
});

test('at most two probes are in flight: the third gets busy at once, and the slot frees when the hung call finally settles', async (t) => {
  keepAlive(t);
  const fsp = hangingFsp();
  t.after(() => fsp.release());
  const a = probe.probePath('/a', { fsp, timeoutMs: 40 });
  const b = probe.probePath('/b', { fsp, timeoutMs: 40 });
  assert.equal(probe.inFlightCount(), 2);
  assert.equal(await probe.probePath('/c', { fsp, timeoutMs: 40 }), 'busy');
  assert.equal(fsp.calls, 2, 'the busy probe never reached the filesystem');
  assert.deepEqual([await a, await b], ['timeout', 'timeout']);
  // Timing out does not free the thread: the call is still running, so a new probe is still busy.
  assert.equal(await probe.probePath('/d', { fsp, timeoutMs: 40 }), 'busy');
  fsp.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(probe.inFlightCount(), 0);
  assert.equal(await probe.probePath('/e', { fsp: { stat: () => Promise.resolve({}) } }), 'ok');
});

test('isUncPath: \\\\host\\share and //host/share forms only', () => {
  const yes = ['\\\\host\\share', '\\\\host\\share\\vault', '//host/share', '//host/share/vault', '\\\\10.0.0.5\\campaigns\\x', '//nas.local/c$/x'];
  const no = ['C:\\vault', 'C:/vault', '/home/gm/vault', 'vault', '', '\\\\', '//', '\\\\host', '//host', '\\host\\share', '/host/share', 'z:\\share'];
  for (const s of yes) assert.equal(probe.isUncPath(s), true, JSON.stringify(s));
  for (const s of no) assert.equal(probe.isUncPath(s), false, JSON.stringify(s));
  assert.equal(probe.isUncPath(undefined), false);
  assert.equal(probe.isUncPath(42), false);
});

test('findVaultChild finds a vault exactly one folder down, first in sorted order, and nothing two down', async (t) => {
  const root = scratchRoot(t);
  const parent = path.join(root, 'parent');
  fs.mkdirSync(path.join(parent, 'b-notes'), { recursive: true });
  copySample(parent, 'z-vault');
  copySample(parent, 'm-vault');
  assert.equal(await probe.findVaultChild(parent), path.join(parent, 'm-vault'));

  const deep = path.join(root, 'deep');
  fs.mkdirSync(path.join(deep, 'mid'), { recursive: true });
  copySample(path.join(deep, 'mid'), 'inner');
  assert.equal(await probe.findVaultChild(deep), null);

  assert.equal(await probe.findVaultChild(path.join(root, 'does-not-exist')), null);
});

test('findVaultChild ignores files and reads at most 500 entries', async () => {
  const names = [];
  for (let i = 0; i < 600; i++) names.push({ name: `d${String(i).padStart(3, '0')}`, isDirectory: () => true });
  names.push({ name: 'file.txt', isDirectory: () => false });
  const statted = [];
  const fsp = {
    readdir: () => Promise.resolve(names),
    stat: (p) => {
      statted.push(p);
      return p.includes(`${path.sep}d499${path.sep}`) ? Promise.resolve({}) : Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }));
    },
  };
  const found = await probe.findVaultChild('/p', { fsp });
  assert.equal(found, path.join('/p', 'd499'));
  const found2 = await probe.findVaultChild('/p', { fsp: { ...fsp, stat: (p) => (p.includes(`${path.sep}d500${path.sep}`) ? Promise.resolve({}) : Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }))) } });
  assert.equal(found2, null, 'the 501st entry is never looked at');
  assert.ok(!statted.some((p) => p.includes('file.txt')));
});

test('every timer in src/setup/probe.js is unref\'d (source pin: unref count >= setTimeout count)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup', 'probe.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const timers = (src.match(/\bsetTimeout\(/g) || []).length;
  const unrefs = (src.match(/\.unref\(\)/g) || []).length;
  assert.ok(timers >= 1);
  assert.ok(unrefs >= timers, `${unrefs} unref for ${timers} setTimeout`);
});
