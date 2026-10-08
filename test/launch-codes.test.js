'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('util');
const crypto = require('crypto');

const { createLaunchCodeStore, codeKey } = require('../src/launch/codes');

/*
 * The launch code store (ADR 0028): 256 random bits, only the SHA-256 held, single use, dead at
 * exactly +60000 ms, at most four outstanding. The 60000 and the 4 below are written out by hand,
 * never read from the store's own defaults.
 */

function clock(start = 1000000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('a minted code is 43 base64url characters and works once', () => {
  const c = clock();
  const store = createLaunchCodeStore({ now: c.now });
  const code = store.mint();
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.consume(code), true);
  assert.equal(store.consume(code), false, 'the second use is refused');
  assert.equal(store.size(), 0);
});

test('two mints give two different codes', () => {
  const store = createLaunchCodeStore({});
  assert.notEqual(store.mint(), store.mint());
});

test('usable at +59999 ms and dead at +60000 ms (the boundary is written out, not derived)', () => {
  const c = clock();
  const store = createLaunchCodeStore({ now: c.now });
  const live = store.mint();
  const dead = store.mint();
  c.t += 59999;
  assert.equal(store.consume(live), true, 'usable at +59999');
  c.t += 1; // now +60000 since the mint
  assert.equal(store.consume(dead), false, 'dead at +60000');
});

test('an unknown, empty, non-string or oversized code is refused and never throws', () => {
  const store = createLaunchCodeStore({});
  store.mint();
  for (const bad of ['', 'x', undefined, null, 42, {}, 'a'.repeat(300), '\u0000']) assert.equal(store.consume(bad), false, String(bad));
});

test('a refused lookup does not spend a different code', () => {
  const store = createLaunchCodeStore({});
  const code = store.mint();
  assert.equal(store.consume('not-the-code'), false);
  assert.equal(store.consume(code), true);
});

test('at most 4 are outstanding: the oldest is evicted first', () => {
  const store = createLaunchCodeStore({});
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push(store.mint());
  assert.equal(store.size(), 4);
  assert.equal(store.consume(codes[0]), false, 'oldest evicted');
  assert.equal(store.consume(codes[1]), false, 'second oldest evicted');
  for (const code of codes.slice(2)) assert.equal(store.consume(code), true);
});

test('clear() drops every outstanding code', () => {
  const store = createLaunchCodeStore({});
  const code = store.mint();
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.consume(code), false);
});

test('only the SHA-256 is held: neither util.inspect(store) nor the internal map holds the code', () => {
  const sentinel = Buffer.alloc(32, 0xab); // base64url of this is a runtime sentinel the store cannot have invented
  const store = createLaunchCodeStore({ randomBytes: () => sentinel });
  const code = store.mint();
  assert.equal(code, sentinel.toString('base64url'));
  const shown = util.inspect(store, { depth: 10, showHidden: true });
  assert.ok(!shown.includes(code), 'util.inspect shows no code');
  assert.ok(!JSON.stringify(Object.entries(store)).includes(code));
  // The map is closed over, so reach the only other place a copy could be: every own property value of the store.
  for (const v of Object.values(store)) assert.ok(!String(v).includes(code));
  // The map is closed over: watch what is stored into any Map while a code is minted.
  const stored = [];
  const realSet = Map.prototype.set;
  Map.prototype.set = function spy(k, v) {
    stored.push(String(k), String(v));
    return realSet.call(this, k, v);
  };
  try {
    const second = createLaunchCodeStore({ randomBytes: () => Buffer.alloc(32, 0xcd) });
    const secondCode = second.mint();
    assert.ok(stored.length >= 2, 'the spy saw the store write');
    assert.ok(!stored.join('|').includes(secondCode), 'no Map entry holds the code');
    assert.ok(stored.join('|').includes(codeKey(secondCode)), 'the hash is what is held');
  } finally {
    Map.prototype.set = realSet;
  }
  assert.equal(typeof codeKey, 'function');
  assert.equal(codeKey(code), crypto.createHash('sha256').update(code, 'utf8').digest('hex'));
  assert.notEqual(codeKey(code), code);
});

test('onConsumed fires exactly once, with the hash, only for a successful consume', () => {
  const seen = [];
  const store = createLaunchCodeStore({ onConsumed: (key) => seen.push(key) });
  const code = store.mint();
  assert.equal(store.consume('wrong'), false);
  assert.deepEqual(seen, []);
  assert.equal(store.consume(code), true);
  assert.equal(store.consume(code), false);
  assert.deepEqual(seen, [crypto.createHash('sha256').update(code, 'utf8').digest('hex')]);
  assert.ok(!seen.join('').includes(code));
});

test('onConsumed does not fire for an expired code', () => {
  const c = clock();
  const seen = [];
  const store = createLaunchCodeStore({ now: c.now, onConsumed: (k) => seen.push(k) });
  const code = store.mint();
  c.t += 60000;
  assert.equal(store.consume(code), false);
  assert.deepEqual(seen, []);
});

test('a custom ttlMs and max are honoured (the knobs the other tests use)', () => {
  const c = clock();
  const store = createLaunchCodeStore({ now: c.now, ttlMs: 50, max: 2 });
  const a = store.mint();
  store.mint();
  store.mint();
  assert.equal(store.size(), 2);
  assert.equal(store.consume(a), false);
  const b = store.mint();
  c.t += 49;
  assert.equal(store.consume(b), true);
});
