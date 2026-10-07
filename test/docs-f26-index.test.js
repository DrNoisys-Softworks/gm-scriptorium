'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/* QA F26: the docs index said it excluded AI-assistant material, then linked AGENTS.md. */
test('F26: the docs index admits its one AGENTS.md pointer', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'README.md'), 'utf8');
  assert.ok(text.includes('apart from one pointer to them under Contributing'));
  assert.ok(text.includes('](../AGENTS.md)'));
  assert.ok(!text.includes('anything written for an AI assistant'));
});
