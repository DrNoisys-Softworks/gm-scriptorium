'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { NOTICES_FILENAME, EMBEDDED_NOTICES_PATH, getNoticesText, deliverNotices } = require('../src/util/notices');

// -- getNoticesText(): reads the real, committed file --

test('getNoticesText() reads the committed THIRD-PARTY-NOTICES.txt', () => {
  const text = getNoticesText();
  assert.match(text, /Scriptorium: Third-Party Notices/);
  assert.equal(EMBEDDED_NOTICES_PATH, path.join(__dirname, '..', NOTICES_FILENAME));
});

// -- deliverNotices(): pure decision logic + the write, every branch, no real process.pkg mutation --

test('deliverNotices() when not packaged: points at the repo copy, does not touch the filesystem', () => {
  let wrote = false;
  const line = deliverNotices({
    isPkg: false,
    execPath: '/usr/bin/node',
    readNoticesText: () => 'irrelevant',
    writeFileSync: () => {
      wrote = true;
    },
  });
  assert.equal(wrote, false);
  assert.match(line, /^third-party notices: /);
  assert.ok(line.includes(EMBEDDED_NOTICES_PATH));
  assert.match(line, /run from source/);
  assert.match(line, /--notices/);
});

test('deliverNotices() when packaged: writes the notices text next to the executable and names that path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-'));
  const execPath = path.join(dir, 'scriptorium-win-x64.exe');
  const written = {};
  const line = deliverNotices({
    isPkg: true,
    execPath,
    readNoticesText: () => 'NOTICES TEXT HERE',
    writeFileSync: (p, data) => {
      written.path = p;
      written.data = data;
    },
  });
  const expectedDest = path.join(dir, NOTICES_FILENAME);
  assert.equal(written.path, expectedDest);
  assert.equal(written.data, 'NOTICES TEXT HERE');
  assert.equal(line, `third-party notices: ${expectedDest}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliverNotices() when packaged and the write actually succeeds on disk (real fs)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-real-'));
  const execPath = path.join(dir, 'scriptorium-win-x64.exe');
  const line = deliverNotices({ isPkg: true, execPath, readNoticesText: () => 'REAL WRITE' });
  const expectedDest = path.join(dir, NOTICES_FILENAME);
  assert.equal(line, `third-party notices: ${expectedDest}`);
  assert.equal(fs.readFileSync(expectedDest, 'utf8'), 'REAL WRITE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliverNotices() when packaged but the write fails: says so, never claims a path exists', () => {
  const line = deliverNotices({
    isPkg: true,
    execPath: '/does/not/exist/scriptorium-win-x64.exe',
    readNoticesText: () => 'irrelevant',
    writeFileSync: () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    },
  });
  assert.match(line, /^third-party notices: could not write /);
  assert.match(line, /EACCES/);
  assert.match(line, /--notices/);
  assert.ok(!line.includes('could not write \n'));
});

test('deliverNotices() when packaged and reading the embedded text itself throws', () => {
  const line = deliverNotices({
    isPkg: true,
    execPath: '/tmp/scriptorium-win-x64.exe',
    readNoticesText: () => {
      throw new Error('ENOENT: no such file');
    },
  });
  assert.match(line, /^third-party notices: could not write /);
  assert.match(line, /ENOENT/);
});

test('deliverNotices() defaults isPkg from process.pkg and execPath from process.execPath', () => {
  // No overrides for isPkg/execPath: exercises the default-parameter branch directly. This
  // process is plain node, so process.pkg is undefined -> the "not packaged" branch.
  const line = deliverNotices({ readNoticesText: () => 'x' });
  assert.match(line, /run from source/);
});
