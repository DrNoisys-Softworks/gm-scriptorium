'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot } = require('./helpers/setup-fixtures');

const welcome = require('../src/admin/welcome');

/*
 * FR-23: the Overview welcome is remembered on the server, per machine, beside the config. The
 * file is { "pending": [names] }; reads never throw; every name is checked against the campaign
 * name rule; the file is private (0600) in a private (0700) folder.
 */

test('reads never throw: no folder, no file, garbage, a non-object, a symlink and an oversized file all read as empty', (t) => {
  const root = scratchRoot(t);
  assert.deepEqual(welcome.readPending(path.join(root, 'absent')), []);
  const dir = path.join(root, 'panel');
  fs.mkdirSync(dir);
  assert.deepEqual(welcome.readPending(dir), []);
  fs.writeFileSync(path.join(dir, 'welcome.json'), '{not json');
  assert.deepEqual(welcome.readPending(dir), []);
  fs.writeFileSync(path.join(dir, 'welcome.json'), '[1,2]');
  assert.deepEqual(welcome.readPending(dir), []);
  fs.writeFileSync(path.join(dir, 'welcome.json'), JSON.stringify({ pending: 'lease' }));
  assert.deepEqual(welcome.readPending(dir), []);
  fs.writeFileSync(path.join(dir, 'welcome.json'), JSON.stringify({ pending: ['lease'], pad: 'x'.repeat(5000) }));
  assert.deepEqual(welcome.readPending(dir), []);
  fs.rmSync(path.join(dir, 'welcome.json'));
  fs.writeFileSync(path.join(root, 'real.json'), JSON.stringify({ pending: ['lease'] }));
  fs.symlinkSync(path.join(root, 'real.json'), path.join(dir, 'welcome.json'));
  assert.deepEqual(welcome.readPending(dir), []);
});

test('only names that pass the campaign name rule are read back, once each', (t) => {
  const root = scratchRoot(t);
  const dir = path.join(root, 'panel');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'welcome.json'), JSON.stringify({ pending: ['lease', 'Bad Name', 'lease', '../x', 7, 'ok-2'] }));
  assert.deepEqual(welcome.readPending(dir), ['lease', 'ok-2']);
});

test('addPending creates the private folder and file (0700 and 0600 on POSIX), keeps order, and does not duplicate', (t) => {
  const root = scratchRoot(t);
  const dir = path.join(root, 'cfg', 'panel');
  welcome.addPending(dir, 'lease');
  welcome.addPending(dir, 'second');
  welcome.addPending(dir, 'lease');
  assert.deepEqual(welcome.readPending(dir), ['lease', 'second']);
  assert.equal(fs.readFileSync(path.join(dir, 'welcome.json'), 'utf8'), '{\n  "pending": [\n    "lease",\n    "second"\n  ]\n}\n');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'welcome.json')).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dir), ['welcome.json'], 'no temp file is left behind');
});

test('addPending refuses a name that fails the name rule', (t) => {
  const root = scratchRoot(t);
  assert.throws(() => welcome.addPending(path.join(root, 'panel'), '../etc'), /campaign name/);
});

test('removePending drops one name, reports whether it was there, and leaves the others', (t) => {
  const root = scratchRoot(t);
  const dir = path.join(root, 'panel');
  welcome.addPending(dir, 'a');
  welcome.addPending(dir, 'b');
  assert.equal(welcome.removePending(dir, 'a'), true);
  assert.equal(welcome.removePending(dir, 'a'), false);
  assert.deepEqual(welcome.readPending(dir), ['b']);
  assert.equal(welcome.removePending(path.join(root, 'nope'), 'b'), false);
});
