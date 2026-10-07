'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findLinkTag } = require('../src/build/housestyle');

// CodeQL js/incomplete-sanitization: the filename is interpolated into a RegExp, so every
// metacharacter must match literally, not just the dot.

test('findLinkTag matches a filename containing + literally, not as a quantifier', () => {
  const html = '<link rel="stylesheet" href="css/aab.css"><link rel="stylesheet" href="css/a+b.css">';
  const found = findLinkTag(html, 'a+b.css');
  assert.ok(found);
  assert.equal(found.href, 'css/a+b.css');
});

test('findLinkTag does not match a decoy that only matches the unescaped pattern', () => {
  assert.equal(findLinkTag('<link rel="stylesheet" href="css/aab.css">', 'a+b.css'), null);
  assert.equal(findLinkTag('<link rel="stylesheet" href="css/axb.css">', 'a.b.css'), null);
});

test('findLinkTag does not throw on unbalanced metacharacters in the filename', () => {
  const html = '<link rel="stylesheet" href="css/a(b[c.css">';
  assert.doesNotThrow(() => findLinkTag('<link href="x.css">', 'a(b[c.css'));
  const found = findLinkTag(html, 'a(b[c.css');
  assert.ok(found);
  assert.equal(found.href, 'css/a(b[c.css');
});

test('findLinkTag treats | $ ^ ? * \\ { } literally', () => {
  const name = 'a|b$^?*{1}.css';
  const found = findLinkTag(`<link href="d/${name}">`, name);
  assert.ok(found);
  assert.equal(found.href, `d/${name}`);
  assert.equal(findLinkTag('<link href="d/a.css">', name), null);
});
