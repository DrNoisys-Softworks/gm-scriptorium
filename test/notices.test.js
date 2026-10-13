'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { NOTICES_FILENAME, EMBEDDED_NOTICES_PATH, getNoticesText, noticesLine } = require('../src/util/notices');

// -- getNoticesText(): reads the real, committed file --

test('getNoticesText() reads the committed THIRD-PARTY-NOTICES.txt', () => {
  const text = getNoticesText();
  assert.match(text, /Scriptorium: Third-Party Notices/);
  assert.equal(EMBEDDED_NOTICES_PATH, path.join(__dirname, '..', NOTICES_FILENAME));
});

// -- noticesLine(): what `--version` says about the notices. It never names a file that may not exist. --

test('noticesLine() when packaged: points at --notices, names no path, and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-'));
  try {
    const line = noticesLine({ isPkg: true, execPath: path.join(dir, 'gm-scriptorium-win-x64.exe') });
    assert.equal(line, 'third-party notices: run gm-scriptorium --notices to print them');
    assert.deepEqual(fs.readdirSync(dir), [], 'asking for the version must not write a file beside the executable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noticesLine() when not packaged: points at the repo copy and --notices', () => {
  const line = noticesLine({ isPkg: false });
  assert.match(line, /^third-party notices: /);
  assert.ok(line.includes(EMBEDDED_NOTICES_PATH));
  assert.match(line, /run from source/);
  assert.match(line, /--notices/);
});

test('noticesLine() defaults isPkg from process.pkg (plain node here, so the from-source wording)', () => {
  assert.match(noticesLine(), /run from source/);
});
