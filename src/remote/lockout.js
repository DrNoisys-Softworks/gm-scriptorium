'use strict';

/*
 * ADR 0054 section 4 (which replaces ADR 0029 section 6's single global counter). The sign-in
 * lockout as a pure, clock-injected state machine: no timers, no I/O, nothing but the `now` each
 * call is given.
 *
 *  - Five wrong tries for one username inside any ten-minute window pause that username for
 *    fifteen minutes.
 *  - Fifty wrong tries across all usernames inside any ten-minute window pause every sign-in for
 *    fifteen minutes (the global ceiling). A guesser who rotates through names stops there, and
 *    the price is that anyone who can reach the page can also pause sign-in for everyone: a
 *    recorded residual (ADR 0054 section 13).
 *
 * A "key" is whatever the handler counts a typed username as: the canonical name, whether or not
 * that account exists, or INVALID_KEY for any text that is not a valid username. Unknown names
 * count exactly like known ones, so the lockout reveals nothing about which accounts exist. No
 * address is ever a key (an attacker controls their own address).
 *
 * State lives in memory only; a restart clears it, as does the passage of time. Every function that
 * can end a pause returns the end as an EVENT instead of recording it anywhere, stamped with the
 * time the pause actually ended (`at`), so the caller audits it whenever it is first observed
 * (handlers/remote.js is the one place that does). The handler never writes `key`: it maps it to an
 * existing account name, or to "unknown".
 */

const NAME_MAX_FAILURES = 5;
const GLOBAL_MAX_FAILURES = 50;
const WINDOW_MS = 600000;
const PAUSE_MS = 900000;
const INVALID_KEY = '\u0000';

/** @returns {{ failures: number[], pausedUntil: number|null, refused: number }} */
function createBucket() {
  return { failures: [], pausedUntil: null, refused: 0 };
}

/** @returns {{ global: ReturnType<typeof createBucket>, names: Map<string, ReturnType<typeof createBucket>> }} */
function createLockoutState() {
  return { global: createBucket(), names: new Map() };
}

function endPause(bucket, scope, key) {
  const event = { type: 'lockout-end', scope, at: bucket.pausedUntil, refused: bucket.refused };
  if (scope === 'name') event.key = key;
  bucket.failures = [];
  bucket.pausedUntil = null;
  bucket.refused = 0;
  return event;
}

/**
 * Ends every expired pause (as events), forgets failures that left the window, and drops name
 * buckets that hold nothing (no failure in the window and no pause), so the state cannot grow
 * without bound however many different names are tried.
 */
function sweep(state, now) {
  const events = [];
  if (state.global.pausedUntil !== null && now >= state.global.pausedUntil) events.push(endPause(state.global, 'all'));
  state.global.failures = state.global.failures.filter((t) => now - t < WINDOW_MS);
  for (const [key, bucket] of state.names) {
    if (bucket.pausedUntil !== null && now >= bucket.pausedUntil) events.push(endPause(bucket, 'name', key));
    bucket.failures = bucket.failures.filter((t) => now - t < WINDOW_MS);
    if (bucket.pausedUntil === null && bucket.failures.length === 0) state.names.delete(key);
  }
  return events;
}

/**
 * Global before name. A refusal is counted into the bucket that refused it, and reports that
 * bucket's running total (`refused`), so the caller can audit the first refusal of each pause.
 *
 * @param {ReturnType<typeof createLockoutState>} state
 * @param {string} key
 * @param {number} now
 * @returns {{ allowed: boolean, scope?: 'all'|'name', until?: number, refused?: number, events: object[] }}
 */
function check(state, key, now) {
  const events = sweep(state, now);
  if (state.global.pausedUntil !== null) {
    state.global.refused++;
    return { allowed: false, scope: 'all', until: state.global.pausedUntil, refused: state.global.refused, events };
  }
  const bucket = state.names.get(key);
  if (bucket && bucket.pausedUntil !== null) {
    bucket.refused++;
    return { allowed: false, scope: 'name', until: bucket.pausedUntil, refused: bucket.refused, events };
  }
  return { allowed: true, events };
}

/**
 * Counts a refusal that was not a pause (a concurrent attempt turned away while one check was
 * already running) into the global total.
 */
function countRefusal(state) {
  state.global.refused++;
  return state.global.refused;
}

/** @returns {{ events: object[] }} */
function recordFailure(state, key, now) {
  const events = sweep(state, now);
  let bucket = state.names.get(key);
  if (!bucket) {
    bucket = createBucket();
    state.names.set(key, bucket);
  }
  bucket.failures.push(now);
  state.global.failures.push(now);
  if (bucket.failures.length >= NAME_MAX_FAILURES) {
    bucket.pausedUntil = now + PAUSE_MS;
    bucket.failures = [];
    events.push({ type: 'lockout-start', scope: 'name', key, until: bucket.pausedUntil });
  }
  if (state.global.failures.length >= GLOBAL_MAX_FAILURES) {
    state.global.pausedUntil = now + PAUSE_MS;
    state.global.failures = [];
    events.push({ type: 'lockout-start', scope: 'all', until: state.global.pausedUntil });
  }
  return { events };
}

/** Clears that name's failures only. The global count is deliberately untouched. */
function recordSuccess(state, key) {
  const bucket = state.names.get(key);
  if (!bucket) return;
  bucket.failures = [];
  if (bucket.pausedUntil === null) state.names.delete(key);
}

/**
 * Like check(), without counting a refusal.
 *
 * @returns {{ active: boolean, until: number|null, recentFailures: number, refused: number, pausedKeys: string[], events: object[] }}
 */
function status(state, now) {
  const events = sweep(state, now);
  const active = state.global.pausedUntil !== null;
  return {
    active,
    until: active ? state.global.pausedUntil : null,
    recentFailures: state.global.failures.length,
    refused: state.global.refused,
    pausedKeys: [...state.names].filter(([, b]) => b.pausedUntil !== null).map(([k]) => k),
    events,
  };
}

module.exports = {
  NAME_MAX_FAILURES,
  GLOBAL_MAX_FAILURES,
  WINDOW_MS,
  PAUSE_MS,
  INVALID_KEY,
  createLockoutState,
  check,
  countRefusal,
  recordFailure,
  recordSuccess,
  status,
};
