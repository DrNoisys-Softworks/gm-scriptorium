'use strict';

/*
 * V1.5a (docs/decisions/0029-remote-access.md, section 6; SD-doc section 8). The sign-in
 * lockout as a pure, clock-injected state machine: no timers, no I/O, nothing but the `now` each
 * call is given. Five wrong passwords inside any ten-minute window pause ALL remote password
 * sign-in (globally, not per address: an attacker controls their own address) for fifteen
 * minutes. State lives in memory only; a restart clears it, as does the passage of time.
 *
 * Every function that can end a pause returns the end as an EVENT instead of recording it
 * anywhere, stamped with the time the pause actually ended (`at`), so the caller audits it
 * whenever it is first observed (handlers/remote.js lockoutGate is the one place that does).
 */

const MAX_FAILURES = 5;
const WINDOW_MS = 600000;
const PAUSE_MS = 900000;

/** @returns {{ failures: number[], pausedUntil: number|null, refused: number }} */
function createLockoutState() {
  return { failures: [], pausedUntil: null, refused: 0 };
}

function endPause(state) {
  const event = { type: 'lockout-end', at: state.pausedUntil, refused: state.refused };
  state.failures = [];
  state.pausedUntil = null;
  state.refused = 0;
  return event;
}

/**
 * @param {ReturnType<typeof createLockoutState>} state
 * @param {number} now
 * @returns {{ allowed: boolean, until?: number, events: object[] }}
 */
function check(state, now) {
  if (state.pausedUntil !== null) {
    if (now < state.pausedUntil) {
      state.refused++;
      return { allowed: false, until: state.pausedUntil, events: [] };
    }
    return { allowed: true, events: [endPause(state)] };
  }
  return { allowed: true, events: [] };
}

/**
 * Counts a refusal that was not a pause (a concurrent attempt turned away while one check was
 * already running), so it shows up in the same lockout-end total.
 */
function countRefusal(state) {
  state.refused++;
  return state.refused;
}

/** @returns {{ events: object[] }} */
function recordFailure(state, now) {
  state.failures = state.failures.filter((t) => now - t < WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= MAX_FAILURES) {
    state.pausedUntil = now + PAUSE_MS;
    state.failures = [];
    return { events: [{ type: 'lockout-start', until: state.pausedUntil }] };
  }
  return { events: [] };
}

function recordSuccess(state) {
  state.failures = [];
}

/** Like check(), without counting a refusal. */
function status(state, now) {
  const events = [];
  if (state.pausedUntil !== null && now >= state.pausedUntil) events.push(endPause(state));
  const active = state.pausedUntil !== null;
  return {
    active,
    until: active ? state.pausedUntil : null,
    recentFailures: state.failures.filter((t) => now - t < WINDOW_MS).length,
    refused: state.refused,
    events,
  };
}

module.exports = { MAX_FAILURES, WINDOW_MS, PAUSE_MS, createLockoutState, check, countRefusal, recordFailure, recordSuccess, status };
