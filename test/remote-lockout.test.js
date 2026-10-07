'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/remote/lockout');

/*
 * V1.5a (SD-a7). The pure state machine, on an injected clock. Boundaries are independent
 * literals in milliseconds (a minute is 60000): the window is 600000, the pause 900000.
 */

const MIN = 60000;

test('constants are the stated numbers', () => {
  assert.equal(L.MAX_FAILURES, 5);
  assert.equal(L.WINDOW_MS, 600000);
  assert.equal(L.PAUSE_MS, 900000);
});

test('a fresh state allows, with no events', () => {
  const s = L.createLockoutState();
  assert.deepEqual(s, { failures: [], pausedUntil: null, refused: 0 });
  assert.deepEqual(L.check(s, 1000), { allowed: true, events: [] });
});

test('failures 1 to 4 do not lock; the 5th inside the window does, with a lockout-start event', () => {
  const s = L.createLockoutState();
  const T = 1_000_000;
  for (let i = 0; i < 4; i++) assert.deepEqual(L.recordFailure(s, T + i * MIN), { events: [] });
  assert.equal(s.pausedUntil, null);
  const out = L.recordFailure(s, T + 4 * MIN);
  assert.deepEqual(out, { events: [{ type: 'lockout-start', until: T + 4 * MIN + 900000 }] });
  assert.equal(s.pausedUntil, T + 4 * MIN + 900000);
  assert.deepEqual(s.failures, []);
});

test('boundary: failures at 0, 1, 2 and 3 minutes plus a fifth at 9:59.999 lock', () => {
  const s = L.createLockoutState();
  const T = 5_000_000;
  for (const m of [0, 1, 2, 3]) L.recordFailure(s, T + m * MIN);
  const out = L.recordFailure(s, T + 599999);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, 'lockout-start');
  assert.equal(out.events[0].until, T + 599999 + 900000);
});

test('boundary: a fifth at exactly 10:00.000 does NOT lock (the 0-minute failure has left the window)', () => {
  const s = L.createLockoutState();
  const T = 5_000_000;
  for (const m of [0, 1, 2, 3]) L.recordFailure(s, T + m * MIN);
  const out = L.recordFailure(s, T + 600000);
  assert.deepEqual(out, { events: [] });
  assert.equal(s.pausedUntil, null);
  assert.equal(s.failures.length, 4);
});

test('boundary: locked at T, T + 899999 is still paused and T + 900000 is released', () => {
  const s = L.createLockoutState();
  const T = 9_000_000;
  for (let i = 0; i < 5; i++) L.recordFailure(s, T);
  assert.equal(s.pausedUntil, T + 900000);
  const paused = L.check(s, T + 899999);
  assert.deepEqual(paused, { allowed: false, until: T + 900000, events: [] });
  const released = L.check(s, T + 900000);
  assert.deepEqual(released, { allowed: true, events: [{ type: 'lockout-end', at: T + 900000, refused: 1 }] });
});

test('each refusal during the pause is counted, and the lockout-end carries the total and is stamped with when the pause ended', () => {
  const s = L.createLockoutState();
  const T = 100;
  for (let i = 0; i < 5; i++) L.recordFailure(s, T);
  for (let i = 0; i < 7; i++) assert.equal(L.check(s, T + 1000 + i).allowed, false);
  // first observed long after the pause ended: `at` is still the real end, not the observation time
  const out = L.check(s, T + 900000 + 5 * MIN);
  assert.deepEqual(out.events, [{ type: 'lockout-end', at: T + 900000, refused: 7 }]);
  assert.equal(out.allowed, true);
});

test('after the end transition the state is clean: no pause, no failures, no refusals, and no second end event', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 5; i++) L.recordFailure(s, 0);
  L.check(s, 10);
  L.check(s, 900000);
  assert.deepEqual(s, { failures: [], pausedUntil: null, refused: 0 });
  assert.deepEqual(L.check(s, 900001), { allowed: true, events: [] });
});

test('recordSuccess clears the failure count, so four failures then a success then four more do not lock', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 4; i++) L.recordFailure(s, i);
  L.recordSuccess(s);
  assert.deepEqual(s.failures, []);
  for (let i = 0; i < 4; i++) assert.deepEqual(L.recordFailure(s, 100 + i), { events: [] });
  assert.equal(s.pausedUntil, null);
});

test('countRefusal adds to the same total the lockout-end reports', () => {
  const s = L.createLockoutState();
  assert.equal(L.countRefusal(s), 1);
  assert.equal(L.countRefusal(s), 2);
  assert.equal(s.refused, 2);
});

test('status reports without counting a refusal, and runs the end transition', () => {
  const s = L.createLockoutState();
  const T = 1000;
  L.recordFailure(s, T);
  L.recordFailure(s, T + 1);
  assert.deepEqual(L.status(s, T + 2), { active: false, until: null, recentFailures: 2, refused: 0, events: [] });
  for (let i = 0; i < 3; i++) L.recordFailure(s, T + 3);
  const active = L.status(s, T + 10);
  assert.deepEqual(active, { active: true, until: T + 3 + 900000, recentFailures: 0, refused: 0, events: [] });
  assert.equal(s.refused, 0, 'status never counts a refusal');
  const ended = L.status(s, T + 3 + 900000);
  assert.equal(ended.active, false);
  assert.deepEqual(ended.events, [{ type: 'lockout-end', at: T + 3 + 900000, refused: 0 }]);
});

test('status recentFailures ignores failures that have left the window (without mutating them away early)', () => {
  const s = L.createLockoutState();
  L.recordFailure(s, 0);
  L.recordFailure(s, 300000);
  assert.equal(L.status(s, 599999).recentFailures, 2);
  assert.equal(L.status(s, 600000).recentFailures, 1);
  assert.equal(L.status(s, 900000).recentFailures, 0);
});
