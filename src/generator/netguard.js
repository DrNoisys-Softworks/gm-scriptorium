'use strict';

/*
 * FR-19/SD-19 (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md): the runtime
 * no-network guarantee. At publish-v1.11.40 a network capability enters the generator's own
 * module graph (lib/fonts.js's self-host font prefetch, lib/update-pin.js's release-pin update)
 * in a way the static module-graph scan cannot see on its own (both reach `fetch` via
 * `opts.fetch || globalThis.fetch` / an injected `fetchFn`, never a literal network-builtin
 * `require()`). Scriptorium never calls either path (src/generator/bootstrap.js calls the pin's
 * `build()` directly, with no prefetch step, and nothing in src/ or bin/ names
 * the pin's release-pin-update entry points), but that is a *behavioural* fact, not a structural one the
 * static graph walk alone can prove. This module is the structural backstop: once installed, no
 * code running in this process can reach the network via `fetch`/`WebSocket`, regardless of
 * which code path tries.
 *
 * Design:
 * - installNetworkGuard() replaces globalThis.fetch (and globalThis.WebSocket, if present) with
 *   a function that throws a ScriptoriumError whose message starts "network access is disabled
 *   in Scriptorium" and increments a module-scoped counter. It is idempotent (repeat calls are a
 *   no-op after the first) and process-lifetime (there is no restore/uninstall -- unlike
 *   intl-shim.js's per-call install/restore, this guard is meant to stay installed for the whole
 *   life of the process once either entry point requires this module, per SD-19's own rejection
 *   of "a guard scoped to runGeneratorBuild, which misses async continuations").
 * - The guard property is defined with a getter/setter pair (Object.defineProperty), not a plain
 *   assignment, so "plain reassignment after install must not remove it" (SD-19): any later
 *   `globalThis.fetch = something` still routes through the same guard function and the same
 *   attempts() counter, rather than silently replacing it with an unguarded value.
 * - attempts() reports the running count, for the FR-19 runtime tests (a real build/check/preview
 *   run must show attempts() unchanged across the whole run).
 * - No new exit code: a blocked call is an ordinary thrown error, caught the same way any other
 *   build failure is (src/util/exitcodes.js is unchanged; CLAUDE.md's "No new exit codes").
 */

const { ScriptoriumError } = require('../util/errors');

let installed = false;
let attemptCount = 0;
let guardValue;

function makeGuard(name) {
  const guard = function networkGuard() {
    attemptCount += 1;
    throw new ScriptoriumError(
      `network access is disabled in Scriptorium (${name}() was called; the generator/build path must never reach the network)`,
    );
  };
  return guard;
}

/**
 * Defines `globalThis[prop]` as a getter/setter pair that always reads back the guard function,
 * so a later plain `globalThis[prop] = x` cannot silently uninstall the guard.
 */
function defineGuardedProperty(prop, guard) {
  let current = guard;
  Object.defineProperty(globalThis, prop, {
    configurable: true,
    enumerable: false,
    get() {
      return current;
    },
    set(_next) {
      // A later reassignment (by anything, including a well-meaning caller trying to restore
      // native fetch) is accepted syntactically but never takes effect: `current` is only ever
      // the guard. This is deliberate -- see the module doc block above.
      current = guard;
    },
  });
}

/**
 * Installs the network guard, once per process. Idempotent: a second call anywhere is a no-op.
 * @returns {{ installed: boolean }} whether THIS call performed the install (false if it was
 *   already installed by an earlier call).
 */
function installNetworkGuard() {
  if (installed) return { installed: false };
  installed = true;

  guardValue = makeGuard('fetch');
  defineGuardedProperty('fetch', guardValue);

  if (typeof globalThis.WebSocket !== 'undefined') {
    defineGuardedProperty('WebSocket', makeGuard('WebSocket'));
  }

  return { installed: true };
}

/** @returns {number} total guarded-call attempts across the process so far. */
function attempts() {
  return attemptCount;
}

module.exports = { installNetworkGuard, attempts };
