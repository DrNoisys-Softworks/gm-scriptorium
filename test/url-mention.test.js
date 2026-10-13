'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mentionsUrl } = require('./helpers/url-mention');

const R = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases';

test('mentionsUrl accepts the exact URL inside a sentence', () => {
  assert.equal(mentionsUrl('See ' + R + ' for more', R), true);
  assert.equal(mentionsUrl('Open ' + R + '.', R), true);
});

test('mentionsUrl rejects lookalike hosts and embedded URLs', () => {
  assert.equal(mentionsUrl('https://github.com.evil.example/DrNoisys-Softworks/gm-scriptorium/releases', R), false);
  assert.equal(mentionsUrl('https://evil.example/https://github.com/DrNoisys-Softworks/gm-scriptorium/releases', R), false);
  assert.equal(mentionsUrl('http://github.com/DrNoisys-Softworks/gm-scriptorium/releases', R), false);
  assert.equal(mentionsUrl('https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v1', R), false);
  assert.equal(mentionsUrl('no url here', R), false);
});
