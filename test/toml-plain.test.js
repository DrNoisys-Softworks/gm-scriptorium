'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TOML = require('smol-toml');
const { plain } = require('./helpers/toml-plain');

// smol-toml 1.9.0 returns tables with a null prototype. These tests fix the two facts the other
// tests rely on: that is still true (so the helper is needed), and plain() changes nothing but
// the prototype.

test('a parsed table has a null prototype, and plain() gives it the ordinary one without changing content', () => {
  const parsed = TOML.parse('a = 1\n[t]\nb = "x"\n[[arr]]\nc = true\n');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.getPrototypeOf(parsed.t), null);
  const p = plain(parsed);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.equal(Object.getPrototypeOf(p.t), Object.prototype);
  assert.equal(Object.getPrototypeOf(p.arr[0]), Object.prototype);
  assert.deepEqual(p, { a: 1, t: { b: 'x' }, arr: [{ c: true }] });
});

test('plain() keeps dates and a key named __proto__ as data, and leaves scalars alone', () => {
  const parsed = TOML.parse('when = 2026-10-08\n["__proto__"]\nx = 1\n');
  const p = plain(parsed);
  assert.equal(p.when, parsed.when);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(p, '__proto__'), true);
  assert.equal(plain(5), 5);
  assert.equal(plain(null), null);
});
