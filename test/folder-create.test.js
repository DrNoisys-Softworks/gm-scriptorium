'use strict';

const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot, treeSnapshot } = require('./helpers/setup-fixtures');

const { createFolder } = require('../src/admin/foldercreate');
const { ConfigError } = require('../src/util/errors');

/*
 * ADR 0049: New folder makes exactly one folder, directly inside an existing, listed parent, and
 * never anything else: no recursion, no overwrite, no delete, nothing inside the config folder, the
 * panel folder or a registered vault. The real-filesystem tests use a scratch tree; races, errors
 * and hung calls are injected fakes (never chmod, which root would bypass).
 */

// The probe's own timer is unref'd (it must never keep the panel alive), so a test that waits on a
// hung call holds the event loop open itself, as test/setup-probe.test.js does.
const keepAlive = setInterval(() => {}, 20);
after(() => clearInterval(keepAlive));

const mkErr = (code) => Object.assign(new Error(code), { code });
const statOf = (kind) => ({ isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' });
const settle = () => new Promise((r) => setImmediate(r));

/** Real fs.promises with per-method overrides; every call is recorded. */
function realFsp(over = {}) {
  const calls = [];
  const wrap = (name) => (...args) => {
    calls.push([name, ...args]);
    return (over[name] || fs.promises[name])(...args);
  };
  return { calls, lstat: wrap('lstat'), stat: wrap('stat'), realpath: wrap('realpath'), opendir: wrap('opendir'), mkdir: wrap('mkdir') };
}

/** A fully fake fsp: the parent is a plain folder, realpath is the identity, mkdir succeeds. */
function passFsp(over = {}) {
  const calls = [];
  const wrap = (name, dflt) => (...args) => {
    calls.push([name, ...args]);
    return (over[name] || dflt)(...args);
  };
  return {
    calls,
    lstat: wrap('lstat', () => Promise.resolve(statOf('dir'))),
    stat: wrap('stat', () => Promise.resolve(statOf('dir'))),
    realpath: wrap('realpath', (p) => Promise.resolve(p)),
    opendir: wrap('opendir', () => Promise.reject(mkErr('ENOENT'))),
    mkdir: wrap('mkdir', () => Promise.resolve()),
  };
}

function scratch(t) {
  const root = fs.realpathSync(scratchRoot(t));
  const parent = path.join(root, 'work');
  fs.mkdirSync(parent);
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir);
  return { root, parent, configDir, panelDir: path.join(configDir, 'panel'), vault: path.join(root, 'vault') };
}

const ctxOf = (s, deps = {}, extra = {}) => ({ configDir: s.configDir, panelDir: s.panelDir, vaults: [s.vault], deps, ...extra });

test('creates exactly one folder directly inside the parent and answers its path', async (t) => {
  const s = scratch(t);
  const before = treeSnapshot(s.root);
  const res = await createFolder({ parent: s.parent, name: 'Session Art' }, ctxOf(s));
  assert.deepEqual(res, { ok: true, path: path.join(s.parent, 'Session Art') });
  assert.equal(fs.statSync(path.join(s.parent, 'Session Art')).isDirectory(), true);
  assert.deepEqual(treeSnapshot(s.root), [...before, 'work/Session Art/'].sort());
});

test('M4 the answer is the lexical join of the resolved parent, and the folder lands at realpath(parent)/name even when an ancestor is a link', async (t) => {
  const s = scratch(t);
  fs.mkdirSync(path.join(s.parent, 'real'));
  fs.symlinkSync(path.join(s.parent, 'real'), path.join(s.parent, 'viaLink'));
  fs.mkdirSync(path.join(s.parent, 'real', 'sub'));
  const given = `${path.join(s.parent, 'viaLink', 'sub')}${path.sep}..${path.sep}sub`;
  const res = await createFolder({ parent: given, name: 'Made' }, ctxOf(s));
  assert.equal(res.ok, true);
  assert.equal(res.path, path.join(s.parent, 'viaLink', 'sub', 'Made'));
  assert.equal(fs.statSync(path.join(s.parent, 'real', 'sub', 'Made')).isDirectory(), true);
});

test('M4 an unusable name is refused before any filesystem call and nothing is created anywhere', async (t) => {
  const s = scratch(t);
  const before = treeSnapshot(s.root);
  for (const name of ['a/b', 'a\\b', '..', '.x', 'CON', 'x.', '', 'nul.txt', 'a:b', undefined, 5, 'x'.repeat(129)]) {
    const fsp = realFsp();
    await assert.rejects(
      createFolder({ parent: s.parent, name }, ctxOf(s, { fsp })),
      (err) => err instanceof ConfigError && err.field === 'name',
      JSON.stringify(name),
    );
    assert.deepEqual(fsp.calls, [], JSON.stringify(name));
  }
  assert.deepEqual(treeSnapshot(s.root), before);
});

test('an unusable parent is refused before any filesystem call', async () => {
  for (const parent of ['', 'relative/dir', './x', undefined, 7, `/${'a'.repeat(2048)}`, '/x\u0000y']) {
    const fsp = realFsp();
    await assert.rejects(
      createFolder({ parent, name: 'ok' }, { configDir: '/c', panelDir: '/c/panel', vaults: [], deps: { fsp, platform: 'linux' } }),
      (err) => err instanceof ConfigError && err.field === 'parent',
      JSON.stringify(parent),
    );
    assert.deepEqual(fsp.calls, []);
  }
});

test('M5 an existing folder, or a file, is refused as exists and left exactly as it was', async (t) => {
  const s = scratch(t);
  const target = path.join(s.parent, 'Maps');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'precious');
  fs.writeFileSync(path.join(s.parent, 'afile'), 'x');
  const mtime = fs.statSync(target).mtimeMs;
  const before = treeSnapshot(s.root);
  assert.deepEqual(await createFolder({ parent: s.parent, name: 'Maps' }, ctxOf(s)), { ok: false, error: 'exists' });
  assert.deepEqual(await createFolder({ parent: s.parent, name: 'afile' }, ctxOf(s)), { ok: false, error: 'exists' });
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'precious');
  assert.equal(fs.statSync(target).mtimeMs, mtime);
  assert.deepEqual(treeSnapshot(s.root), before);
});

test('M5 EEXIST from the filesystem is a refusal, never a success', async () => {
  const fsp = passFsp({ mkdir: () => Promise.reject(mkErr('EEXIST')) });
  const res = await createFolder({ parent: '/p', name: 'x' }, { configDir: '/c', panelDir: '/c/panel', vaults: [], deps: { fsp, platform: 'linux' } });
  assert.deepEqual(res, { ok: false, error: 'exists' });
});

test('M3 mkdir is called once with the target and NO options (so never recursive), after the parent is resolved', async () => {
  const fsp = passFsp();
  const res = await createFolder({ parent: '/p', name: 'x' }, { configDir: '/c', panelDir: '/c/panel', vaults: [], deps: { fsp, platform: 'linux' } });
  assert.deepEqual(res, { ok: true, path: '/p/x' });
  const mk = fsp.calls.filter((c) => c[0] === 'mkdir');
  assert.deepEqual(mk, [['mkdir', '/p/x']]);
  const names = fsp.calls.map((c) => c[0]);
  assert.ok(names.indexOf('lstat') < names.indexOf('realpath') && names.indexOf('realpath') < names.indexOf('mkdir'));
  assert.equal(names[names.length - 1], 'realpath', 'the created folder is verified last');
});

test('M3 a parent that vanishes after it was resolved is missing, and is NOT recreated', async (t) => {
  const s = scratch(t);
  const doomed = path.join(s.parent, 'doomed');
  fs.mkdirSync(doomed);
  const fsp = realFsp({
    realpath: async (p) => {
      const real = await fs.promises.realpath(p);
      if (p === doomed) fs.rmdirSync(doomed);
      return real;
    },
  });
  const res = await createFolder({ parent: doomed, name: 'x' }, ctxOf(s, { fsp }));
  assert.deepEqual(res, { ok: false, error: 'missing' });
  assert.equal(fs.existsSync(doomed), false, 'a recursive create would have rebuilt it');
});

test('parent outcomes: absent is missing, a file is not-folder, a link is link, denied is permission', async (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.parent, 'f'), 'x');
  fs.mkdirSync(path.join(s.parent, 'real'));
  fs.symlinkSync(path.join(s.parent, 'real'), path.join(s.parent, 'lnk'));
  const before = treeSnapshot(s.root);
  assert.deepEqual(await createFolder({ parent: path.join(s.parent, 'nope'), name: 'x' }, ctxOf(s)), { ok: false, error: 'missing' });
  assert.deepEqual(await createFolder({ parent: path.join(s.parent, 'f'), name: 'x' }, ctxOf(s)), { ok: false, error: 'not-folder' });
  assert.deepEqual(await createFolder({ parent: path.join(s.parent, 'lnk'), name: 'x' }, ctxOf(s)), { ok: false, error: 'link' });
  for (const code of ['EACCES', 'EPERM']) {
    const fsp = passFsp({ lstat: () => Promise.reject(mkErr(code)) });
    assert.deepEqual(await createFolder({ parent: '/p', name: 'x' }, { configDir: '/c', panelDir: '/c/panel', vaults: [], deps: { fsp, platform: 'linux' } }), { ok: false, error: 'permission' }, code);
  }
  assert.deepEqual(treeSnapshot(s.root), before);
});

test('mkdir errors: EACCES, EPERM and EROFS are permission, ENOENT is missing, ENOTDIR is not-folder, anything else is not-responding', async () => {
  const run = (code) =>
    createFolder({ parent: '/p', name: 'x' }, { configDir: '/c', panelDir: '/c/panel', vaults: [], deps: { fsp: passFsp({ mkdir: () => Promise.reject(mkErr(code)) }), platform: 'linux' } });
  for (const code of ['EACCES', 'EPERM', 'EROFS']) assert.deepEqual(await run(code), { ok: false, error: 'permission' }, code);
  assert.deepEqual(await run('ENOENT'), { ok: false, error: 'missing' });
  assert.deepEqual(await run('ENOTDIR'), { ok: false, error: 'not-folder' });
  assert.deepEqual(await run('EIO'), { ok: false, error: 'not-responding' });
});

// --- refusals: config, panel, vault -----------------------------------------------------------------------

test('M10 nothing is created inside the config folder, equal to it or below it', async (t) => {
  const s = scratch(t);
  fs.mkdirSync(path.join(s.configDir, 'sub'));
  const before = treeSnapshot(s.root);
  assert.deepEqual(await createFolder({ parent: s.configDir, name: 'x' }, ctxOf(s)), { ok: false, error: 'inside-config' });
  assert.deepEqual(await createFolder({ parent: path.join(s.configDir, 'sub'), name: 'x' }, ctxOf(s)), { ok: false, error: 'inside-config' });
  assert.deepEqual(treeSnapshot(s.root), before);
});

test('M10 a panel folder that is a link is checked separately by where it really is', async (t) => {
  const s = scratch(t);
  const elsewhere = path.join(s.root, 'elsewhere');
  fs.mkdirSync(path.join(elsewhere, 'p'), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'p'), s.panelDir);
  const before = treeSnapshot(s.root);
  assert.deepEqual(await createFolder({ parent: path.join(elsewhere, 'p'), name: 'x' }, ctxOf(s)), { ok: false, error: 'inside-panel' });
  assert.deepEqual(treeSnapshot(s.root), before);
});

test('M10 the config check is made both ways: by real path (a link to the config folder) and lexically (when the real path cannot be had)', async (t) => {
  const s = scratch(t);
  // real: the config folder is reached through a link, the parent is given by its real name
  const realCfg = path.join(s.root, 'realcfg');
  fs.mkdirSync(realCfg);
  const linkCfg = path.join(s.root, 'linkcfg');
  fs.symlinkSync(realCfg, linkCfg);
  const ctx = { configDir: linkCfg, panelDir: path.join(linkCfg, 'panel'), vaults: [], deps: {} };
  assert.deepEqual(await createFolder({ parent: realCfg, name: 'x' }, ctx), { ok: false, error: 'inside-config' });
  assert.equal(fs.existsSync(path.join(realCfg, 'x')), false);

  // lexical: the real path of the config folder cannot be had (denied), so its written path is used
  const fsp = passFsp({ realpath: (p) => (p === '/cfg' ? Promise.reject(mkErr('EACCES')) : Promise.resolve(p)) });
  const res = await createFolder({ parent: '/cfg/sub', name: 'x' }, { configDir: '/cfg', panelDir: '/cfg/panel', vaults: [], deps: { fsp, platform: 'linux' } });
  assert.deepEqual(res, { ok: false, error: 'inside-config' });
  assert.equal(fsp.calls.some((c) => c[0] === 'mkdir'), false);
});

test('M10 the config check is also made lexically when its real path answers with somewhere else (the written path still counts)', async () => {
  const fsp = passFsp({ realpath: (p) => Promise.resolve(p === '/cfg' ? '/elsewhere' : p) });
  const res = await createFolder({ parent: '/cfg/sub', name: 'x' }, { configDir: '/cfg', panelDir: '/cfg/panel', vaults: [], deps: { fsp, platform: 'linux' } });
  assert.deepEqual(res, { ok: false, error: 'inside-config' });
  assert.equal(fsp.calls.some((c) => c[0] === 'mkdir'), false);
});

test('M10 the target is judged by where its parent really is AND by where it is written: a parent that resolves elsewhere is still refused inside the written config folder', async () => {
  const fsp = passFsp({ realpath: (p) => Promise.resolve(p === '/cfg/sub' ? '/data/else/sub' : p) });
  const res = await createFolder({ parent: '/cfg/sub', name: 'x' }, { configDir: '/cfg', panelDir: '/cfg/panel', vaults: [], deps: { fsp, platform: 'linux' } });
  assert.deepEqual(res, { ok: false, error: 'inside-config' });
  assert.equal(fsp.calls.some((c) => c[0] === 'mkdir'), false);
  // and the other way: written outside, really inside
  const fsp2 = passFsp({ realpath: (p) => Promise.resolve(p === '/tmp/work' ? '/cfg/sub' : p) });
  const res2 = await createFolder({ parent: '/tmp/work', name: 'x' }, { configDir: '/cfg', panelDir: '/cfg/panel', vaults: [], deps: { fsp: fsp2, platform: 'linux' } });
  assert.deepEqual(res2, { ok: false, error: 'inside-config' });
});

test('M10 an unanswered realpath of the config folder falls back to its written path (a hung call never stalls the create)', { timeout: 8000 }, async (t) => {
  const pending = [];
  t.after(async () => {
    pending.splice(0).forEach((p) => p.reject(mkErr('ENOENT')));
    await settle();
  });
  const fsp = passFsp({ realpath: (p) => (p === '/cfg' ? new Promise((resolve, reject) => pending.push({ resolve, reject })) : Promise.resolve(p)) });
  const res = await createFolder({ parent: '/cfg/sub', name: 'x' }, { configDir: '/cfg', panelDir: '/cfg/panel', vaults: [], deps: { fsp, platform: 'linux', timeoutMs: 40 } });
  assert.deepEqual(res, { ok: false, error: 'inside-config' });
});

test('M13 nothing is created inside a registered vault or equal to it; a sibling whose name only starts the same is fine', async (t) => {
  const s = scratch(t);
  fs.mkdirSync(path.join(s.vault, 'notes'), { recursive: true });
  fs.mkdirSync(`${s.vault}2`);
  const before = treeSnapshot(s.root);
  assert.deepEqual(await createFolder({ parent: s.vault, name: 'x' }, ctxOf(s)), { ok: false, error: 'inside-vault' });
  assert.deepEqual(await createFolder({ parent: path.join(s.vault, 'notes'), name: 'x' }, ctxOf(s)), { ok: false, error: 'inside-vault' });
  assert.deepEqual(treeSnapshot(s.root), before);
  assert.equal((await createFolder({ parent: `${s.vault}2`, name: 'x' }, ctxOf(s))).ok, true);
});

test('M13 a vault reached through a link is still a vault', async (t) => {
  const s = scratch(t);
  fs.mkdirSync(s.vault);
  const alias = path.join(s.root, 'alias');
  fs.symlinkSync(s.vault, alias);
  const ctx = { ...ctxOf(s), vaults: [alias] };
  assert.deepEqual(await createFolder({ parent: s.vault, name: 'x' }, ctx), { ok: false, error: 'inside-vault' });
  assert.equal(fs.existsSync(path.join(s.vault, 'x')), false);
});

// --- moved, hung and busy ----------------------------------------------------------------------------------------

test('moved: if the created folder is not where it was meant to be, the answer says so with its path and nothing is undone', async (t) => {
  const s = scratch(t);
  const target = path.join(s.parent, 'there');
  const fsp = realFsp({ realpath: async (p) => (p === target ? path.join(s.root, 'somewhere-else') : fs.promises.realpath(p)) });
  const res = await createFolder({ parent: s.parent, name: 'there' }, ctxOf(s, { fsp }));
  assert.deepEqual(res, { ok: false, error: 'moved', path: target });
  assert.equal(fs.statSync(target).isDirectory(), true, 'the folder is left in place, never deleted or renamed');
  assert.equal(fsp.calls.some((c) => !['lstat', 'stat', 'realpath', 'opendir', 'mkdir'].includes(c[0])), false);
});

test('AC-10 a hung filesystem answers not-responding within the bound and a full cap answers checks-busy; neither reaches mkdir', { timeout: 8000 }, async (t) => {
  const pending = [];
  t.after(async () => {
    pending.splice(0).forEach((p) => p.reject(mkErr('ENOENT')));
    await settle();
  });
  const fsp = passFsp({ lstat: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const deps = { fsp, platform: 'linux', timeoutMs: 40 };
  const ctx = { configDir: '/c', panelDir: '/c/panel', vaults: [], deps };
  const a = createFolder({ parent: '/a', name: 'x' }, ctx);
  const b = createFolder({ parent: '/b', name: 'x' }, ctx);
  assert.deepEqual(await createFolder({ parent: '/c2', name: 'x' }, ctx), { ok: false, error: 'checks-busy' });
  assert.deepEqual(await a, { ok: false, error: 'not-responding' });
  assert.deepEqual(await b, { ok: false, error: 'not-responding' });
  assert.equal(fsp.calls.some((c) => c[0] === 'mkdir'), false);
});

test('M12 a mkdir that does not answer in time is not-responding (the folder may yet appear; the answer never claims it was made)', { timeout: 8000 }, async (t) => {
  const pending = [];
  t.after(async () => {
    pending.splice(0).forEach((p) => p.resolve());
    await settle();
  });
  const fsp = passFsp({ mkdir: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const res = await createFolder({ parent: '/p', name: 'x' }, { configDir: '/c', panelDir: '/c/panel', vaults: [], deps: { fsp, platform: 'linux', timeoutMs: 40 } });
  assert.deepEqual(res, { ok: false, error: 'not-responding' });
});
