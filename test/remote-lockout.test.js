'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/remote/lockout');

/*
 * ADR 0054 section 4 (replacing ADR 0029 section 6's single global counter). The pure state
 * machine, on an injected clock: 5 wrong tries for one username in 10 minutes pause that name for
 * 15 minutes, and 50 wrong tries across all names in 10 minutes pause everything for 15 minutes.
 * Every number below is an independent literal in milliseconds (a minute is 60000), never read from
 * the constants under test. A name is just a key here: the handler decides what key a typed
 * username becomes (a canonical name, or the one shared key for a malformed name).
 */

const MIN = 60000;
const T0 = 1_000_000;

function fail(state, key, times, at) {
  let events = [];
  for (let i = 0; i < times; i++) events = events.concat(L.recordFailure(state, key, at + i).events);
  return events;
}

test('constants are the stated numbers', () => {
  assert.equal(L.NAME_MAX_FAILURES, 5);
  assert.equal(L.GLOBAL_MAX_FAILURES, 50);
  assert.equal(L.WINDOW_MS, 600000);
  assert.equal(L.PAUSE_MS, 900000);
  assert.equal(L.INVALID_KEY, '\u0000');
});

test('a fresh state allows every key, with no events and no recorded anything', () => {
  const s = L.createLockoutState();
  assert.deepEqual(L.check(s, 'rook', T0), { allowed: true, events: [] });
  assert.deepEqual(L.status(s, T0), { active: false, until: null, recentFailures: 0, refused: 0, pausedKeys: [], events: [] });
});

test('failures 1 to 4 for one name do not pause it; the 5th inside the window pauses THAT name for 900000 ms, with a name event', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 4; i++) assert.deepEqual(L.recordFailure(s, 'rook', T0 + i * MIN), { events: [] });
  assert.deepEqual(L.check(s, 'rook', T0 + 4 * MIN - 1), { allowed: true, events: [] });
  const out = L.recordFailure(s, 'rook', T0 + 4 * MIN);
  assert.deepEqual(out, { events: [{ type: 'lockout-start', scope: 'name', key: 'rook', until: T0 + 4 * MIN + 900000 }] });
  assert.deepEqual(L.check(s, 'rook', T0 + 4 * MIN + 1), { allowed: false, scope: 'name', until: T0 + 4 * MIN + 900000, refused: 1, events: [] });
});

test('a paused name leaves every other name, known or not, able to try', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  assert.equal(L.check(s, 'rook', T0 + 10).allowed, false);
  for (const other of ['saffron', 'gm', 'nobody', L.INVALID_KEY]) assert.deepEqual(L.check(s, other, T0 + 10), { allowed: true, events: [] }, other);
});

test('boundary: failures at 0, 1, 2 and 3 minutes plus a fifth at 9:59.999 pause the name', () => {
  const s = L.createLockoutState();
  for (const m of [0, 1, 2, 3]) L.recordFailure(s, 'rook', T0 + m * MIN);
  const out = L.recordFailure(s, 'rook', T0 + 599999);
  assert.deepEqual(out.events, [{ type: 'lockout-start', scope: 'name', key: 'rook', until: T0 + 599999 + 900000 }]);
});

test('boundary: a fifth at exactly 10:00.000 does NOT pause (the first failure has left the window)', () => {
  const s = L.createLockoutState();
  for (const m of [0, 1, 2, 3]) L.recordFailure(s, 'rook', T0 + m * MIN);
  assert.deepEqual(L.recordFailure(s, 'rook', T0 + 600000), { events: [] });
  assert.deepEqual(L.check(s, 'rook', T0 + 600001), { allowed: true, events: [] });
});

test('boundary: paused at T, T + 899999 is still refused and T + 900000 is released, with a name lockout-end stamped at the real end', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  const until = T0 + 4 + 900000;
  assert.deepEqual(L.check(s, 'rook', until - 1), { allowed: false, scope: 'name', until, refused: 1, events: [] });
  assert.deepEqual(L.check(s, 'rook', until), { allowed: true, events: [{ type: 'lockout-end', scope: 'name', key: 'rook', at: until, refused: 1 }] });
  assert.deepEqual(L.check(s, 'rook', until + 1), { allowed: true, events: [] }, 'no second end event');
});

test('each refusal during a pause is counted, and the end event carries the total and the real end, even when first observed much later', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  const until = T0 + 4 + 900000;
  for (let i = 0; i < 7; i++) assert.equal(L.check(s, 'rook', T0 + 1000 + i).allowed, false);
  const out = L.check(s, 'rook', until + 5 * MIN);
  assert.equal(out.allowed, true);
  assert.deepEqual(out.events, [{ type: 'lockout-end', scope: 'name', key: 'rook', at: until, refused: 7 }]);
});

test('after a pause ends the name starts clean: five more failures are needed to pause it again', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  const later = T0 + 4 + 900000;
  L.check(s, 'rook', later);
  for (let i = 0; i < 4; i++) assert.deepEqual(L.recordFailure(s, 'rook', later + i), { events: [] });
  assert.equal(L.recordFailure(s, 'rook', later + 4).events.length, 1);
});

// --- unknown and malformed names count exactly like known ones --------------------------------

test('an unknown name is counted like a known one: five failures pause it', () => {
  const s = L.createLockoutState();
  const events = fail(s, 'nobody', 5, T0);
  assert.equal(events.length, 1);
  assert.equal(events[0].scope, 'name');
  assert.equal(events[0].key, 'nobody');
  assert.equal(L.check(s, 'nobody', T0 + 100).allowed, false);
});

test('every malformed name shares the one INVALID_KEY bucket: five different bad names pause that bucket together', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 4; i++) L.recordFailure(s, L.INVALID_KEY, T0 + i);
  assert.equal(L.check(s, L.INVALID_KEY, T0 + 10).allowed, true);
  const out = L.recordFailure(s, L.INVALID_KEY, T0 + 5);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].key, L.INVALID_KEY);
  assert.equal(L.check(s, L.INVALID_KEY, T0 + 10).allowed, false);
  assert.equal(L.check(s, 'rook', T0 + 10).allowed, true, 'a real name is not affected by the malformed bucket');
});

// --- the global ceiling -------------------------------------------------------------------------

test('GLOBAL: 4 failures each across 13 names (52 in all, 50 within the window) pause everything, and none of those names is paused alone', () => {
  const s = L.createLockoutState();
  const names = Array.from({ length: 13 }, (_, i) => `n${i + 1}`);
  let started = [];
  let count = 0;
  for (const name of names) {
    for (let k = 0; k < 4; k++) {
      count++;
      const out = L.recordFailure(s, name, T0 + count);
      if (out.events.length > 0) started.push({ count, events: out.events });
      if (count < 50) assert.deepEqual(out.events, [], `failure ${count} starts nothing`);
    }
  }
  assert.equal(started.length, 1);
  assert.equal(started[0].count, 50, 'the 50th failure starts the pause');
  assert.deepEqual(started[0].events, [{ type: 'lockout-start', scope: 'all', until: T0 + 50 + 900000 }]);
  // every name is now refused, including one nobody has tried
  assert.deepEqual(L.check(s, 'n1', T0 + 100), { allowed: false, scope: 'all', until: T0 + 50 + 900000, refused: 1, events: [] });
  assert.equal(L.check(s, 'brand-new', T0 + 100).allowed, false);
  assert.equal(L.check(s, L.INVALID_KEY, T0 + 100).allowed, false);
});

test('GLOBAL: 49 failures across 13 names (none with five) do not pause anything', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 49; i++) assert.deepEqual(L.recordFailure(s, `n${i % 13}`, T0 + i), { events: [] });
  assert.equal(L.status(s, T0 + 100).active, false);
  assert.equal(L.check(s, 'n0', T0 + 100).allowed, true);
});

test('GLOBAL: the window slides: 50 failures spread over more than 10 minutes do not pause', () => {
  const s = L.createLockoutState();
  // two failures a minute across 25 distinct names, so no name reaches five and the global count
  // never holds more than about 20 inside any 10 minutes
  for (let i = 0; i < 50; i++) assert.deepEqual(L.recordFailure(s, `m${i % 25}`, T0 + i * 30000), { events: [] });
  assert.equal(L.status(s, T0 + 50 * 30000).active, false);
});

test('GLOBAL: the global pause ends 900000 ms later with an end event for scope all, and the refusals during it are counted into it', () => {
  const s = L.createLockoutState();
  for (let i = 1; i <= 50; i++) L.recordFailure(s, `n${i % 13}`, T0);
  const until = T0 + 900000;
  assert.equal(L.check(s, 'x', until - 1).allowed, false);
  assert.equal(L.check(s, 'y', until - 1).allowed, false);
  const out = L.check(s, 'z', until);
  assert.equal(out.allowed, true);
  assert.deepEqual(out.events.filter((e) => e.scope === 'all'), [{ type: 'lockout-end', scope: 'all', at: until, refused: 2 }]);
});

test('GLOBAL is checked before the name: a name paused inside a global pause reports the global scope', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  for (let i = 0; i < 45; i++) L.recordFailure(s, `n${i % 13}`, T0 + 10);
  assert.equal(L.check(s, 'rook', T0 + 20).scope, 'all');
});

// --- success ----------------------------------------------------------------------------------------

test('success clears that name only: its failures restart at zero, the global count is untouched', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 4; i++) L.recordFailure(s, 'rook', T0 + i);
  for (let i = 0; i < 4; i++) L.recordFailure(s, 'saffron', T0 + 10 + i);
  assert.equal(L.status(s, T0 + 100).recentFailures, 8);
  L.recordSuccess(s, 'rook');
  assert.equal(L.status(s, T0 + 100).recentFailures, 8, 'global is untouched by a success');
  // rook is back to zero: four more do not pause it, a fifth does
  for (let i = 0; i < 4; i++) assert.deepEqual(L.recordFailure(s, 'rook', T0 + 200 + i), { events: [] });
  assert.equal(L.recordFailure(s, 'rook', T0 + 300).events.length, 1);
  // saffron kept her four: one more pauses her
  assert.equal(L.recordFailure(s, 'saffron', T0 + 400).events.length, 1);
});

test('success for a name nobody failed is a no-op, never a throw', () => {
  const s = L.createLockoutState();
  L.recordSuccess(s, 'rook');
  assert.deepEqual(L.status(s, T0), { active: false, until: null, recentFailures: 0, refused: 0, pausedKeys: [], events: [] });
});

test('failures that already counted toward the global ceiling stay counted after a success (a guesser cannot reset it by logging in)', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 49; i++) L.recordFailure(s, `n${i % 13}`, T0 + i);
  L.recordSuccess(s, 'n1');
  const out = L.recordFailure(s, 'fresh', T0 + 100);
  assert.deepEqual(out.events, [{ type: 'lockout-start', scope: 'all', until: T0 + 100 + 900000 }]);
});

// --- busy refusals, status, pruning --------------------------------------------------------------------

test('countRefusal counts into the global total and returns it', () => {
  const s = L.createLockoutState();
  assert.equal(L.countRefusal(s), 1);
  assert.equal(L.countRefusal(s), 2);
  assert.equal(L.status(s, T0).refused, 2);
});

test('status: reports a global pause, the paused names, and counts failures inside the window only', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  L.recordFailure(s, 'saffron', T0 + 10);
  const st = L.status(s, T0 + 20);
  assert.equal(st.active, false);
  assert.equal(st.until, null);
  assert.deepEqual(st.pausedKeys, ['rook']);
  assert.equal(st.recentFailures, 6);
  assert.deepEqual(st.events, []);
  // eleven minutes on, the old failures have left the window
  assert.equal(L.status(s, T0 + 11 * MIN).recentFailures, 0);
});

test('status ends expired pauses as events (name and global), exactly once', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  const later = T0 + 4 + 900000;
  const st = L.status(s, later + 5);
  assert.deepEqual(st.events, [{ type: 'lockout-end', scope: 'name', key: 'rook', at: later, refused: 0 }]);
  assert.deepEqual(st.pausedKeys, []);
  assert.deepEqual(L.status(s, later + 6).events, []);
});

test('pruning: name buckets with no failure in the window and no pause are dropped, so the state cannot grow without bound', () => {
  const s = L.createLockoutState();
  for (let i = 0; i < 30; i++) L.recordFailure(s, `n${i}`, T0 + i);
  assert.equal(s.names.size, 30);
  L.check(s, 'anyone', T0 + 11 * MIN);
  assert.equal(s.names.size, 0);
});

test('pruning keeps a name that is paused, and a name with a failure still inside the window', () => {
  const s = L.createLockoutState();
  fail(s, 'rook', 5, T0);
  L.recordFailure(s, 'saffron', T0 + 9 * MIN);
  L.check(s, 'anyone', T0 + 10 * MIN + 100);
  assert.deepEqual([...s.names.keys()].sort(), ['rook', 'saffron']);
});
