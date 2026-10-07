'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* QA F13: DEVELOPING.md does not call the tool Windows-only. */

const ROOT = path.join(__dirname, '..');

test('F13: DEVELOPING.md no longer says the tool is Windows-only', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'DEVELOPING.md'), 'utf8');
  assert.ok(!text.includes('is a compiled Windows command-line tool'));
  assert.ok(text.includes('released as a Windows and a Linux executable'));
});
