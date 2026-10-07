'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* QA F12: the entry script is executable. */

const ROOT = path.join(__dirname, '..');

test('F12: bin/scriptorium.js is executable (POSIX)', { skip: process.platform === 'win32' && 'POSIX modes do not exist on Windows' }, () => {
  assert.ok(fs.statSync(path.join(ROOT, 'bin', 'scriptorium.js')).mode & 0o100);
});
