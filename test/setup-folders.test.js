'use strict';

const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot } = require('./helpers/setup-fixtures');

const folders = require('../src/setup/folders');
const probe = require('../src/setup/probe');
const { ConfigError } = require('../src/util/errors');

/*
 * ADR 0049: the folder picker's listing. The module answers one question, "which folders are in
 * this folder", without ever naming a file, following a link or waiting on a dead share. The
 * real-filesystem tests use a scratch tree; everything the OS could do badly (a permission error,
 * a hung share, a huge folder, a Windows drive) is an injected fake fsp, so none of it depends on
 * the host. Expected numbers (500, 20000, 1000, 2000, 128, 2048) are written out here by hand and
 * never read from the module. The win32-injected cases prove the path RULES on this host only;
 * they are not Windows behaviour (that is the C138 criterion).
 */

// The probe's own timer is unref'd (it must never keep the panel alive), so a test that waits on a
// hung call holds the event loop open itself, as test/setup-probe.test.js does.
const keepAlive = setInterval(() => {}, 20);
after(() => clearInterval(keepAlive));

const mkErr = (code) => Object.assign(new Error(code), { code });
const statOf = (kind) => ({ isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link', isFIFO: () => kind === 'fifo' });
const dirent = (name, kind) => ({ name, ...statOf(kind) });

/** A fake fsp: every method records its call and, unless overridden, answers ENOENT. */
function fakeFsp(over = {}) {
  const calls = [];
  const method = (name) =>
    function fake(...args) {
      calls.push([name, ...args]);
      if (over[name]) return over[name](...args);
      return Promise.reject(mkErr('ENOENT'));
    };
  return { calls, lstat: method('lstat'), stat: method('stat'), opendir: method('opendir'), realpath: method('realpath'), mkdir: method('mkdir') };
}

/** An opendir() result over fixed entries; `pulled` counts how many the caller actually read. */
function fakeDir(entries) {
  const dir = {
    pulled: 0,
    closed: 0,
    async close() {
      dir.closed++;
    },
    [Symbol.asyncIterator]() {
      return (async function* gen() {
        for (const e of typeof entries === 'function' ? entries(dir) : entries) {
          dir.pulled++;
          yield e;
        }
      })();
    },
  };
  return dir;
}

const dirsOnly = (dir) => ({ lstat: () => Promise.resolve(statOf('dir')), opendir: () => Promise.resolve(dir) });

/** Pending promises that never settle until release() is called (a dead share). */
function hung() {
  const pending = [];
  return {
    promise: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    release() {
      for (const p of pending.splice(0)) p.reject(mkErr('ENOENT'));
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

// --- names ------------------------------------------------------------------------------------------

test('validateFolderName accepts ordinary names, including spaces, ampersands, non-ASCII and exactly 128 characters', () => {
  for (const ok of ['Session Art', 'Tom & Jerry', 'Ünïcödé', 'com10', 'a.b', 'x'.repeat(128), 'lpt0', 'console']) {
    assert.equal(folders.validateFolderName(ok), ok, ok);
  }
});

test('validateFolderName refuses in the documented order, with the "folder name" stem, as a ConfigError', () => {
  const cases = [
    [undefined, 'folder name is required'],
    [42, 'folder name is required'],
    ['', 'folder name is required'],
    ['x'.repeat(129), 'folder name is longer than 128 characters'],
    ['a/b', 'folder name "a/b" contains a character that is not allowed in a folder name'],
    ['a\\b', 'folder name "a\\b" contains a character that is not allowed in a folder name'],
    ['a:b', 'folder name "a:b" contains a character that is not allowed in a folder name'],
    ['a*b', 'folder name "a*b" contains a character that is not allowed in a folder name'],
    ['a\u0001b', 'folder name "a\u0001b" contains a character that is not allowed in a folder name'],
    ['a\u007fb', 'folder name "a\u007fb" contains a character that is not allowed in a folder name'],
    ['.x', 'folder name must not start with a dot'],
    ['..', 'folder name must not start with a dot'],
    ['a..b', 'folder name must not contain ".."'],
    ['x.', 'folder name must not end with a dot or a space'],
    ['x ', 'folder name must not end with a dot or a space'],
    ['CON', 'folder name "CON" is a reserved Windows device name'],
    ['nul.txt', 'folder name "nul.txt" is a reserved Windows device name'],
    ['Com1', 'folder name "Com1" is a reserved Windows device name'],
    ['LPT9', 'folder name "LPT9" is a reserved Windows device name'],
  ];
  for (const [name, message] of cases) {
    assert.throws(() => folders.validateFolderName(name), (err) => err instanceof ConfigError && err.message === message, JSON.stringify(name));
  }
});

test('validateFolderName applies rules 1 to 7 only: a name ending .md or an image extension is a fine folder name', () => {
  assert.equal(folders.validateFolderName('notes.md'), 'notes.md');
  assert.equal(folders.validateFolderName('cover.png'), 'cover.png');
});

// --- paths ------------------------------------------------------------------------------------------

test('validateFolderPath, POSIX: absolute only, canonicalised, at most 2048 characters, no NUL', () => {
  assert.equal(folders.validateFolderPath('/a/b/../c', 'linux'), '/a/c');
  assert.equal(folders.validateFolderPath('/a/b/', 'linux'), '/a/b');
  assert.equal(folders.validateFolderPath('/', 'linux'), '/');
  assert.equal(folders.validateFolderPath(`/${'a'.repeat(2047)}`, 'linux').length, 2048);
  for (const bad of ['', 'a/b', './a', '~/a', 'C:\\a', '\\\\host\\share', `/${'a'.repeat(2048)}`, '/a\u0000b', undefined, 7, null]) {
    assert.throws(() => folders.validateFolderPath(bad, 'linux'), ConfigError, JSON.stringify(bad));
  }
});

test('validateFolderPath, win32: X:\\, X:/, \\\\host\\share and //host/share only', () => {
  assert.equal(folders.validateFolderPath('C:\\a\\..\\b', 'win32'), 'C:\\b');
  assert.equal(folders.validateFolderPath('C:/a/b', 'win32'), 'C:\\a\\b');
  assert.equal(folders.validateFolderPath('d:\\', 'win32'), 'd:\\');
  assert.equal(folders.validateFolderPath('\\\\host\\share\\x', 'win32'), '\\\\host\\share\\x');
  assert.equal(folders.validateFolderPath('//host/share/x', 'win32'), '\\\\host\\share\\x');
  assert.equal(folders.validateFolderPath('C:\\People\\Café & Co\\Session Art', 'win32'), 'C:\\People\\Café & Co\\Session Art');
});

test('validateFolderPath, win32: refuses drive-relative, rooted-without-drive, device namespace, a colon after the drive and reserved device names', () => {
  const bad = [
    'C:foo',
    'C:',
    '\\foo',
    '/foo',
    'foo\\bar',
    '\\\\.\\C:\\x',
    '\\\\?\\C:\\x',
    '//./C:/x',
    '//?/C:/x',
    '\\\\?\\UNC\\host\\share',
    'C:\\a:b',
    'C:\\a\\file.txt:stream',
    'C:\\CON',
    'C:\\x\\nul.txt',
    'C:\\x\\COM3',
    '\\\\host\\share\\aux',
    '\\\\host',
    '//host',
    `C:\\${'a'.repeat(2048)}`,
    'C:\\a\u0000b',
  ];
  for (const b of bad) assert.throws(() => folders.validateFolderPath(b, 'win32'), ConfigError, JSON.stringify(b));
});

// --- hidden names -----------------------------------------------------------------------------------

test('isHiddenName: a leading dot everywhere; the fixed system list on win32 only, case-insensitively', () => {
  assert.equal(folders.isHiddenName('.git', 'linux'), true);
  assert.equal(folders.isHiddenName('visible', 'linux'), false);
  assert.equal(folders.isHiddenName('$Recycle.Bin', 'linux'), false);
  for (const n of ['$Recycle.Bin', 'System Volume Information', '$WinREAgent', '$WINDOWS.~BT', 'Config.Msi', 'Recovery', 'RECOVERY', '$recycle.bin']) {
    assert.equal(folders.isHiddenName(n, 'win32'), true, n);
  }
  assert.equal(folders.isHiddenName('.git', 'win32'), true);
  assert.equal(folders.isHiddenName('Recovery Notes', 'win32'), false);
  assert.equal(folders.isHiddenName('Documents', 'win32'), false);
});

// --- listing a real scratch tree --------------------------------------------------------------------

function tree(t) {
  const root = fs.realpathSync(scratchRoot(t));
  for (const d of ['Alpha', 'beta', 'Zeta', '.hidden-dir', 'Target']) fs.mkdirSync(path.join(root, d));
  fs.mkdirSync(path.join(root, 'Target', 'sentinel-child-folder'));
  fs.writeFileSync(path.join(root, 'notes.md'), 'x');
  fs.writeFileSync(path.join(root, 'SENTINEL-FILE-NAME.txt'), 'x');
  fs.symlinkSync(path.join(root, 'Target'), path.join(root, 'linkdir'));
  fs.symlinkSync(path.join(root, 'notes.md'), path.join(root, 'filelink'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
  return root;
}

test('AC-01: lists child folders only, sorted case-insensitively, each with exactly name, path, link, hidden and unreadable', async (t) => {
  const root = tree(t);
  const res = await folders.listFolder(root, {}, {});
  assert.equal(res.view, 'folder');
  assert.equal(res.state, 'ok');
  assert.equal(res.path, root);
  assert.equal(res.parent, path.dirname(root));
  assert.equal(res.truncated, false);
  assert.deepEqual(
    res.entries.map((e) => e.name),
    ['Alpha', 'beta', 'linkdir', 'Target', 'Zeta'],
  );
  assert.deepEqual(res.entries[0], { name: 'Alpha', path: path.join(root, 'Alpha'), link: false, hidden: false, unreadable: false });
  for (const e of res.entries) assert.deepEqual(Object.keys(e).sort(), ['hidden', 'link', 'name', 'path', 'unreadable']);
});

test('AC-01 no files: no file name, file symlink, dangling link or link-target child appears anywhere in the response', async (t) => {
  const root = tree(t);
  const text = JSON.stringify(await folders.listFolder(root, { hidden: true }, {}));
  for (const forbidden of ['notes.md', 'SENTINEL-FILE-NAME', 'filelink', 'dangling', 'sentinel-child-folder']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('AC-02 a link to a folder is listed with link:true and is never read through', async (t) => {
  const root = tree(t);
  const res = await folders.listFolder(root, {}, {});
  const link = res.entries.find((e) => e.name === 'linkdir');
  assert.deepEqual(link, { name: 'linkdir', path: path.join(root, 'linkdir'), link: true, hidden: false, unreadable: false });
  const into = await folders.listFolder(path.join(root, 'linkdir'), {}, {});
  assert.deepEqual(into, { view: 'folder', state: 'link', path: path.join(root, 'linkdir') });
});

test('AC-03 hidden folders are skipped by default and shown, flagged, with hidden:true', async (t) => {
  const root = tree(t);
  const plain = await folders.listFolder(root, {}, {});
  assert.equal(plain.entries.some((e) => e.name === '.hidden-dir'), false);
  const shown = await folders.listFolder(root, { hidden: true }, {});
  const dot = shown.entries.find((e) => e.name === '.hidden-dir');
  assert.equal(dot.hidden, true);
  assert.equal(shown.entries.find((e) => e.name === 'Alpha').hidden, false);
});

test('AC-03 win32 (injected): the system list is hidden by default and flagged with hidden:true', async () => {
  const fsp = fakeFsp(
    dirsOnly(fakeDir([dirent('$Recycle.Bin', 'dir'), dirent('System Volume Information', 'dir'), dirent('Users', 'dir'), dirent('.git', 'dir'), dirent('Recovery', 'dir')])),
  );
  const deps = { fsp, platform: 'win32' };
  const plain = await folders.listFolder('C:\\', {}, deps);
  assert.deepEqual(plain.entries.map((e) => e.name), ['Users']);
  const shown = await folders.listFolder('C:\\', { hidden: true }, { ...deps, fsp: fakeFsp(dirsOnly(fakeDir([dirent('$Recycle.Bin', 'dir'), dirent('Users', 'dir'), dirent('.git', 'dir')]))) });
  assert.deepEqual(shown.entries.map((e) => [e.name, e.hidden, e.path]), [['$Recycle.Bin', true, 'C:\\$Recycle.Bin'], ['.git', true, 'C:\\.git'], ['Users', false, 'C:\\Users']]);
  assert.equal(shown.parent, null);
});

test('parent is the containing folder, and null at a root (POSIX and a UNC root)', async () => {
  const empty = () => fakeFsp(dirsOnly(fakeDir([])));
  assert.equal((await folders.listFolder('/', {}, { fsp: empty(), platform: 'linux' })).parent, null);
  assert.equal((await folders.listFolder('/a/b', {}, { fsp: empty(), platform: 'linux' })).parent, '/a');
  assert.equal((await folders.listFolder('C:\\a', {}, { fsp: empty(), platform: 'win32' })).parent, 'C:\\');
  assert.equal((await folders.listFolder('\\\\host\\share\\', {}, { fsp: empty(), platform: 'win32' })).parent, null);
});

test('filter: a case-insensitive substring narrows the list; an empty folder is ok with no entries', async (t) => {
  const root = tree(t);
  const res = await folders.listFolder(root, { filter: 'ET' }, {});
  assert.deepEqual(res.entries.map((e) => e.name), ['beta', 'Target', 'Zeta']);
  const none = await folders.listFolder(root, { filter: 'zzz' }, {});
  assert.deepEqual(none.entries, []);
  assert.equal(none.state, 'ok');
  const emptyDir = path.join(root, 'Alpha');
  const empty = await folders.listFolder(emptyDir, {}, {});
  assert.deepEqual([empty.state, empty.entries, empty.truncated], ['ok', [], false]);
});

test('sorting is case-insensitive with a raw ordinal tiebreak (no Intl)', async () => {
  const fsp = fakeFsp(dirsOnly(fakeDir([dirent('b', 'dir'), dirent('B', 'dir'), dirent('a', 'dir'), dirent('Ab', 'dir'), dirent('_x', 'dir'), dirent('Z', 'dir')])));
  const res = await folders.listFolder('/s', {}, { fsp, platform: 'linux' });
  assert.deepEqual(res.entries.map((e) => e.name), ['_x', 'a', 'Ab', 'B', 'b', 'Z']);
});

// --- states -----------------------------------------------------------------------------------------

test('states: a file is not-folder, an absent path is missing, a link is link', async (t) => {
  const root = tree(t);
  assert.deepEqual(await folders.listFolder(path.join(root, 'notes.md'), {}, {}), { view: 'folder', state: 'not-folder', path: path.join(root, 'notes.md') });
  assert.deepEqual(await folders.listFolder(path.join(root, 'nope'), {}, {}), { view: 'folder', state: 'missing', path: path.join(root, 'nope') });
  assert.equal((await folders.listFolder(path.join(root, 'filelink'), {}, {})).state, 'link');
});

test('AC-04 permission: EACCES and EPERM from lstat or from opendir answer permission, never throw', async () => {
  for (const code of ['EACCES', 'EPERM']) {
    const a = fakeFsp({ lstat: () => Promise.reject(mkErr(code)) });
    assert.deepEqual(await folders.listFolder('/p', {}, { fsp: a, platform: 'linux' }), { view: 'folder', state: 'permission', path: '/p' });
    const b = fakeFsp({ lstat: () => Promise.resolve(statOf('dir')), opendir: () => Promise.reject(mkErr(code)) });
    assert.deepEqual(await folders.listFolder('/p', {}, { fsp: b, platform: 'linux' }), { view: 'folder', state: 'permission', path: '/p' });
  }
});

test('AC-04 an iteration failure part-way answers a state, never an exception, and the directory is closed', async () => {
  const dir = fakeDir(function* boom() {
    yield dirent('a', 'dir');
    throw mkErr('EIO');
  });
  const res = await folders.listFolder('/p', {}, { fsp: fakeFsp(dirsOnly(dir)), platform: 'linux' });
  assert.equal(res.view, 'folder');
  assert.notEqual(res.state, 'ok');
  assert.equal(dir.closed, 1);
});

test('AC-10 a hung filesystem answers not-responding within the bound, and a third concurrent call answers busy without touching it', { timeout: 8000 }, async (t) => {
  const h = hung();
  t.after(async () => {
    h.release();
    await settle();
  });
  const fsp = fakeFsp({ lstat: () => h.promise() });
  const deps = { fsp, platform: 'linux', timeoutMs: 40 };
  const started = Date.now();
  const a = folders.listFolder('/a', {}, deps);
  const b = folders.listFolder('/b', {}, deps);
  const c = await folders.listFolder('/c', {}, deps);
  assert.deepEqual(c, { view: 'folder', state: 'busy', path: '/c' });
  assert.equal(fsp.calls.length, 2, 'the busy call never reached the filesystem');
  assert.deepEqual((await a).state, 'not-responding');
  assert.deepEqual((await b).state, 'not-responding');
  assert.ok(Date.now() - started < 1500);
});

// --- caps -------------------------------------------------------------------------------------------

test('AC-05 at most 500 folders are returned, in order, and truncated is set', async () => {
  const names = Array.from({ length: 600 }, (_, i) => `f${String(i).padStart(3, '0')}`);
  const dir = fakeDir(names.map((n) => dirent(n, 'dir')));
  const res = await folders.listFolder('/big', {}, { fsp: fakeFsp(dirsOnly(dir)), platform: 'linux' });
  assert.equal(res.entries.length, 500);
  assert.equal(res.entries[0].name, 'f000');
  assert.equal(res.entries[499].name, 'f499');
  assert.equal(res.truncated, true);
  assert.equal(dir.closed, 1);
});

test('AC-05 exactly 500 folders is not truncated', async () => {
  const dir = fakeDir(Array.from({ length: 500 }, (_, i) => dirent(`f${String(i).padStart(3, '0')}`, 'dir')));
  const res = await folders.listFolder('/big', {}, { fsp: fakeFsp(dirsOnly(dir)), platform: 'linux' });
  assert.equal(res.entries.length, 500);
  assert.equal(res.truncated, false);
});

test('AC-05 scanning stops at exactly 20000 entries, files included, and sets truncated; the directory is closed', async () => {
  const dir = fakeDir(function* many() {
    for (let i = 0; i < 25000; i++) yield dirent(`file${i}.txt`, 'file');
  });
  const res = await folders.listFolder('/huge', {}, { fsp: fakeFsp(dirsOnly(dir)), platform: 'linux' });
  assert.equal(dir.pulled, 20000);
  assert.equal(res.truncated, true);
  assert.deepEqual(res.entries, []);
  assert.equal(dir.closed, 1);
});

test('AC-05 a folder of exactly 19999 files is scanned in full and not truncated', async () => {
  const dir = fakeDir(Array.from({ length: 19999 }, (_, i) => dirent(`file${i}.txt`, 'file')));
  const res = await folders.listFolder('/huge', {}, { fsp: fakeFsp(dirsOnly(dir)), platform: 'linux' });
  assert.equal(dir.pulled, 19999);
  assert.equal(res.truncated, false);
});

test('AC-05 the soft deadline is 2000 ms: with a clock that advances 1000 ms per entry the scan stops after the second', async () => {
  let clock = 0;
  const dir = fakeDir(function* slow() {
    for (let i = 0; i < 50; i++) {
      clock += 1000;
      yield dirent(`d${i}`, 'dir');
    }
  });
  const res = await folders.listFolder('/slow', {}, { fsp: fakeFsp(dirsOnly(dir)), platform: 'linux', now: () => clock });
  assert.equal(dir.pulled, 2);
  assert.equal(res.truncated, true);
  assert.deepEqual(res.entries.map((e) => e.name), ['d0', 'd1']);
});

test('AC-05 at most 1000 link or unknown entries are confirmed per request; more sets truncated and stops', async () => {
  const dir = fakeDir(Array.from({ length: 1100 }, (_, i) => dirent(`l${String(i).padStart(4, '0')}`, 'link')));
  let lstats = 0;
  const fsp = fakeFsp({
    lstat: (p) => {
      if (p === '/links') return Promise.resolve(statOf('dir'));
      lstats++;
      return Promise.resolve(statOf('link'));
    },
    stat: () => Promise.resolve(statOf('file')),
    opendir: () => Promise.resolve(dir),
  });
  const res = await folders.listFolder('/links', {}, { fsp, platform: 'linux' });
  assert.equal(lstats, 1000);
  assert.equal(res.truncated, true);
  assert.deepEqual(res.entries, []);
});

// --- link and unknown-type confirmation -------------------------------------------------------------

test('AC-02/04 links and unknown types are confirmed one at a time: folder links listed, file and dangling links omitted, denied ones flagged', async () => {
  const dir = fakeDir([
    dirent('a-dirlink', 'link'),
    dirent('b-filelink', 'link'),
    dirent('c-dangling', 'link'),
    dirent('d-denied', 'link'),
    dirent('e-unknown-dir', 'unknown'),
    dirent('f-unknown-denied', 'unknown'),
    dirent('g-unknown-file', 'unknown'),
    dirent('h-fifo', 'fifo'),
  ]);
  const lstats = {
    'a-dirlink': statOf('link'),
    'b-filelink': statOf('link'),
    'c-dangling': statOf('link'),
    'd-denied': statOf('link'),
    'e-unknown-dir': statOf('dir'),
    'g-unknown-file': statOf('file'),
  };
  const stats = { 'a-dirlink': statOf('dir'), 'b-filelink': statOf('file') };
  const fsp = fakeFsp({
    lstat: (p) => {
      if (p === '/c') return Promise.resolve(statOf('dir'));
      const key = p.split('/').pop();
      if (key === 'f-unknown-denied') return Promise.reject(mkErr('EACCES'));
      return Promise.resolve(lstats[key]);
    },
    stat: (p) => {
      const key = p.split('/').pop();
      if (key === 'c-dangling') return Promise.reject(mkErr('ENOENT'));
      if (key === 'd-denied') return Promise.reject(mkErr('EACCES'));
      return Promise.resolve(stats[key]);
    },
    opendir: () => Promise.resolve(dir),
  });
  const res = await folders.listFolder('/c', {}, { fsp, platform: 'linux' });
  assert.deepEqual(
    res.entries.map((e) => [e.name, e.link, e.unreadable]),
    [
      ['a-dirlink', true, false],
      ['d-denied', true, true],
      ['e-unknown-dir', false, false],
      ['f-unknown-denied', false, true],
    ],
  );
});

test('after the first timeout confirming stops: the remaining link or unknown entries are listed unreadable and the filesystem is not asked again', { timeout: 8000 }, async (t) => {
  const h = hung();
  t.after(async () => {
    h.release();
    await settle();
  });
  const dir = fakeDir([dirent('a', 'link'), dirent('b', 'unknown'), dirent('c', 'link'), dirent('d', 'dir')]);
  const fsp = fakeFsp({
    lstat: (p) => {
      if (p === '/t') return Promise.resolve(statOf('dir'));
      if (p.endsWith('/a')) return Promise.resolve(statOf('link'));
      return h.promise();
    },
    stat: () => Promise.resolve(statOf('dir')),
    opendir: () => Promise.resolve(dir),
  });
  const res = await folders.listFolder('/t', {}, { fsp, platform: 'linux', timeoutMs: 40 });
  assert.deepEqual(
    res.entries.map((e) => [e.name, e.link, e.unreadable]),
    [
      ['a', true, false],
      ['b', false, true],
      ['c', true, true],
      ['d', false, false],
    ],
  );
  assert.equal(fsp.calls.filter((c) => c[0] === 'lstat').length, 3, 'folder, a, then b (which hung); c was never asked');
});

// --- roots ------------------------------------------------------------------------------------------

test('roots, POSIX: / and Home, and no filesystem call at all', async () => {
  const fsp = fakeFsp();
  const res = await folders.listRoots({}, { fsp, platform: 'linux', homedir: '/home/gm' });
  assert.deepEqual(res, {
    view: 'roots',
    platform: 'posix',
    home: '/home/gm',
    roots: [
      { path: '/', name: '/', state: 'ok' },
      { path: '/home/gm', name: 'Home', state: 'ok' },
    ],
  });
  assert.deepEqual(fsp.calls, []);
});

function drives(present, hang) {
  return fakeFsp({
    stat: (p) => {
      const letter = p[0];
      if (hang && hang.includes(letter)) return hang.h.promise();
      return present.includes(letter) ? Promise.resolve(statOf('dir')) : Promise.reject(mkErr('ENOENT'));
    },
  });
}

test('roots, win32 (injected): A: to Z: probed strictly one at a time, absent letters omitted, Home last', async () => {
  const fsp = drives(['C', 'D']);
  const res = await folders.listRoots({}, { fsp, platform: 'win32', homedir: 'C:\\People\\gm' });
  assert.equal(res.platform, 'win32');
  assert.deepEqual(res.roots, [
    { path: 'C:\\', name: 'C:', state: 'ok' },
    { path: 'D:\\', name: 'D:', state: 'ok' },
    { path: 'C:\\People\\gm', name: 'Home', state: 'ok' },
  ]);
  assert.equal(fsp.calls.length, 26);
  assert.deepEqual(fsp.calls.slice(0, 3).map((c) => c[1]), ['A:\\', 'B:\\', 'C:\\']);
});

test('M11 roots, win32: a drive that hangs is not-responding, every later letter is unchecked and never asked, and it is remembered until refresh', { timeout: 8000 }, async (t) => {
  const h = hung();
  t.after(async () => {
    h.release();
    await settle();
  });
  const hang = ['E'];
  hang.h = h;
  const fsp = drives(['C', 'D', 'F'], hang);
  const memory = new Set();
  const res = await folders.listRoots({ memory }, { fsp, platform: 'win32', homedir: 'C:\\People\\gm', timeoutMs: 40 });
  const byLetter = Object.fromEntries(res.roots.filter((r) => r.name !== 'Home').map((r) => [r.name, r.state]));
  assert.equal(byLetter['C:'], 'ok');
  assert.equal(byLetter['D:'], 'ok');
  assert.equal(byLetter['E:'], 'not-responding');
  for (const letter of 'FGHIJKLMNOPQRSTUVWXYZ') assert.equal(byLetter[`${letter}:`], 'unchecked', letter);
  assert.deepEqual(fsp.calls.map((c) => c[1]), ['A:\\', 'B:\\', 'C:\\', 'D:\\', 'E:\\'], 'nothing was asked after E:');

  // Remembered: the next request does not ask for E: again and carries on to F: onwards.
  const before = fsp.calls.length;
  const again = await folders.listRoots({ memory }, { fsp, platform: 'win32', homedir: 'C:\\People\\gm', timeoutMs: 40 });
  assert.equal(again.roots.find((r) => r.name === 'E:').state, 'not-responding');
  assert.equal(again.roots.find((r) => r.name === 'F:').state, 'ok');
  assert.equal(fsp.calls.slice(before).some((c) => c[1] === 'E:\\'), false);

  // Refresh forgets it and asks again.
  const beforeRefresh = fsp.calls.length;
  await folders.listRoots({ memory, refresh: true }, { fsp, platform: 'win32', homedir: 'C:\\People\\gm', timeoutMs: 40 });
  assert.equal(fsp.calls.slice(beforeRefresh).some((c) => c[1] === 'E:\\'), true);
});

test('roots, win32: when the shared cap is full every letter is unchecked and the filesystem is not asked', { timeout: 8000 }, async (t) => {
  const h = hung();
  t.after(async () => {
    h.release();
    await settle();
  });
  const stuck = fakeFsp({ stat: () => h.promise() });
  const holders = [probe.bounded(() => stuck.stat('x'), 30), probe.bounded(() => stuck.stat('y'), 30)];
  await Promise.all(holders);
  const fsp = drives(['C']);
  const res = await folders.listRoots({}, { fsp, platform: 'win32', homedir: 'C:\\People\\gm' });
  assert.deepEqual(fsp.calls, []);
  assert.equal(res.roots.filter((r) => r.name !== 'Home').every((r) => r.state === 'unchecked'), true);
});

// --- start ------------------------------------------------------------------------------------------

test('start: the deepest existing folder above the value; a file or a link is skipped upwards', async (t) => {
  const root = tree(t);
  fs.mkdirSync(path.join(root, 'Alpha', 'inner'));
  const deps = { homedir: '/home/gm' };
  assert.deepEqual(await folders.startFolder(path.join(root, 'Alpha', 'inner', 'c', 'd'), deps), { view: 'start', path: path.join(root, 'Alpha', 'inner'), deferred: false });
  assert.equal((await folders.startFolder(path.join(root, 'Alpha'), deps)).path, path.join(root, 'Alpha'));
  assert.equal((await folders.startFolder(path.join(root, 'notes.md'), deps)).path, root);
  assert.equal((await folders.startFolder(path.join(root, 'linkdir', 'x'), deps)).path, root, 'a link is never the start');
});

test('start: no value, a relative value or an invalid value opens at Home', async () => {
  const fsp = fakeFsp();
  for (const v of [undefined, '', 'relative/path', '~/x']) {
    assert.deepEqual(await folders.startFolder(v, { fsp, platform: 'linux', homedir: '/home/gm' }), { view: 'start', path: '/home/gm', deferred: false }, String(v));
  }
  assert.deepEqual(fsp.calls, []);
});

test('M7/AC-06 start: a UNC value is never probed; the answer is deferred with no filesystem call', async () => {
  for (const platform of ['win32', 'linux']) {
    for (const unc of ['\\\\host\\share\\x', '//host/share/x']) {
      const fsp = fakeFsp();
      assert.deepEqual(await folders.startFolder(unc, { fsp, platform, homedir: 'C:\\People\\gm' }), { view: 'start', path: null, deferred: true }, `${platform} ${unc}`);
      assert.deepEqual(fsp.calls, []);
    }
  }
});

test('start: walks up at most 32 levels, then falls back to Home', async () => {
  const fsp = fakeFsp();
  const deep = `/${Array.from({ length: 40 }, (_, i) => `s${i}`).join('/')}`;
  assert.deepEqual(await folders.startFolder(deep, { fsp, platform: 'linux', homedir: '/home/gm' }), { view: 'start', path: '/home/gm', deferred: false });
  assert.equal(fsp.calls.length, 32);
});

test('start: a hung ancestor answers Home within the bound', { timeout: 8000 }, async (t) => {
  const h = hung();
  t.after(async () => {
    h.release();
    await settle();
  });
  const fsp = fakeFsp({ lstat: () => h.promise() });
  const res = await folders.startFolder('/a/b', { fsp, platform: 'linux', homedir: '/home/gm', timeoutMs: 40 });
  assert.deepEqual(res, { view: 'start', path: '/home/gm', deferred: false });
});

test('the constants are the stated ones', () => {
  assert.deepEqual(
    [folders.MAX_SHOWN, folders.MAX_SCANNED, folders.MAX_CONFIRM, folders.SCAN_DEADLINE_MS, folders.MAX_FILTER, folders.MAX_PATH],
    [500, 20000, 1000, 2000, 128, 2048],
  );
});
