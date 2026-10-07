'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

/*
 * The release blocker this guards: the packaged pkg exe's small-icu Node
 * build throws `RangeError: pkg: Intl.Segmenter is unavailable...` from
 * gm-apprentice-publish/lib/unicode.js, reached via
 * src/checks/leak/outputscan.js's needleFormsFor -> pinned.truncateGraphemes,
 * on both `check` and `build --force` whenever built output exists. The
 * shim that fixes this (src/generator/intl-shim.js) already existed before
 * this bug shipped — it was installed on src/generator/bootstrap.js's
 * generator-build path, but nothing installed it on the facade
 * (src/generator/pinned.js) that outputscan.js actually calls through, so
 * it never covered that route. 358 node-run tests passed anyway, because
 * plain node's ICU is never missing break-iterator data, so
 * installSegmenterShim()'s own gate (segmenterDataMissing()) is always
 * false here regardless of whether install was ever called — a test that
 * only calls truncateGraphemes under plain node and checks the output
 * cannot distinguish "the shim installed and did nothing because native
 * ICU is fine" from "nothing ever tried to install it". That is why this
 * test does not do that; see the module-level comment below.
 *
 * What this test actually proves: merely requiring src/generator/pinned.js
 * — the ONE Scriptorium module allowed to deep-require the pin's unicode
 * functions, per its own file-header contract — synchronously calls
 * src/generator/intl-shim.js's installSegmenterShim() as a side effect of
 * module load, before any of pinned.js's exports (including
 * truncateGraphemes) can be used by any caller. That is a structural
 * property: true for every current caller (src/checks/leak/outputscan.js,
 * src/vault/publishset.js) and every future one, since none of them can
 * reach the pin's unicode functions except through this facade.
 *
 * Why intercept rather than simulate the real small-icu gate: `process.config`
 * is frozen at the property level (`Object.getOwnPropertyDescriptor(...).writable
 * === false`) on every Node this repo's dev/CI boxes run, so
 * segmenterDataMissing()'s real gate (process.config.variables.icu_small)
 * cannot be forced true in-process the way test/intl-shim.test.js forces
 * installSegmenterShim({force:true}) directly. What CAN be controlled from
 * a test is whether the *call* happens at all: this test substitutes a
 * require.cache entry for intl-shim.js, ahead of a fresh require of
 * pinned.js, whose installSegmenterShim wrapper forces the real
 * installation (bypassing the gate, exactly like test/intl-shim.test.js
 * already does) and records that it was called. This proves the wiring
 * (pinned.js unconditionally calls the installer) independently of
 * whatever the real small-icu gate would decide on this box.
 *
 * Node's test runner isolates each matched test file into its own process
 * by default, so mutating require.cache / Intl.Segmenter.prototype here
 * cannot leak into other test files; this file still restores everything
 * itself (cache entries and the prototype method) so re-running it, or a
 * future isolation-mode change, stays safe.
 *
 * What this test does NOT cover (see also the Engineer report): it never
 * runs inside a real packaged pkg exe, so it cannot by itself prove the
 * RangeError is gone in production — only that the fix's wiring exists.
 * The packaged-binary proof (`check` and `build --force` against a real
 * withheld-name vault, run inside an actual pkg-linux binary) was done
 * manually and is recorded in docs/decisions/0005-generator-pin.md's D2
 * coverage addendum, following this repo's existing precedent
 * (scripts/package.js's asset gate and rules-content gate are unit-tested
 * at the function level the same way, with the real-build proof done
 * manually and recorded rather than run inside `npm test`).
 */

const ROOT = path.join(__dirname, '..');
const SHIM_PATH = path.join(ROOT, 'src', 'generator', 'intl-shim.js');
const PINNED_PATH = path.join(ROOT, 'src', 'generator', 'pinned.js');

function withInterceptedShim(fn) {
  const real = require(SHIM_PATH); // the genuine module, cached normally
  const originalSegment = Intl.Segmenter.prototype.segment;
  const originalShimCacheEntry = require.cache[SHIM_PATH];
  const originalPinnedCacheEntry = require.cache[PINNED_PATH];

  let installCalls = 0;
  const capturedArgs = [];
  const stub = {
    ...real,
    installSegmenterShim(opts) {
      installCalls += 1;
      capturedArgs.push(opts);
      // Force the real installation regardless of what the caller passed,
      // bypassing segmenterDataMissing()'s gate (unforceable in-process;
      // see the module comment above) so this proves the CALL happened
      // and had its intended effect, not the real small-icu gate's value.
      return real.installSegmenterShim({ ...(opts || {}), force: true });
    },
  };

  const fakeShimModule = new Module(SHIM_PATH, null);
  fakeShimModule.filename = SHIM_PATH;
  fakeShimModule.loaded = true;
  fakeShimModule.exports = stub;
  require.cache[SHIM_PATH] = fakeShimModule;
  delete require.cache[PINNED_PATH];

  try {
    return fn({ getInstallCalls: () => installCalls, getCapturedArgs: () => capturedArgs });
  } finally {
    Intl.Segmenter.prototype.segment = originalSegment;
    if (originalShimCacheEntry) require.cache[SHIM_PATH] = originalShimCacheEntry;
    else delete require.cache[SHIM_PATH];
    if (originalPinnedCacheEntry) require.cache[PINNED_PATH] = originalPinnedCacheEntry;
    else delete require.cache[PINNED_PATH];
  }
}

test('requiring pinned.js calls installSegmenterShim() exactly once, at module load', () => {
  withInterceptedShim(({ getInstallCalls }) => {
    assert.equal(getInstallCalls(), 0, 'sanity: not called before pinned.js is required');
    // eslint-disable-next-line global-require
    require(PINNED_PATH);
    assert.equal(getInstallCalls(), 1);
  });
});

test('the shim is active (Intl.Segmenter.prototype.segment patched) before pinned.js returns its exports', () => {
  withInterceptedShim(() => {
    const before = Intl.Segmenter.prototype.segment;
    // eslint-disable-next-line global-require
    require(PINNED_PATH);
    assert.notEqual(Intl.Segmenter.prototype.segment, before);
  });
});

test('pinned.truncateGraphemes uses the now-installed shim end to end (matches intl-shim\'s own grapheme split)', () => {
  withInterceptedShim(() => {
    // eslint-disable-next-line global-require
    const pinned = require(PINNED_PATH);
    // eslint-disable-next-line global-require
    const { graphemeSegments } = require(SHIM_PATH);
    const name = 'A really quite long withheld NPC name indeed';
    const max = 15;
    const keep = 13;
    const expected = graphemeSegments(name.normalize('NFC')).length > max
      ? graphemeSegments(name.normalize('NFC')).slice(0, keep).join('') + '…'
      : name.normalize('NFC');
    assert.equal(pinned.truncateGraphemes(name, max, keep), expected);
  });
});

test('installSegmenterShim() is called with no arguments (unforced; the real small-icu gate governs it)', () => {
  withInterceptedShim(({ getCapturedArgs }) => {
    // eslint-disable-next-line global-require
    require(PINNED_PATH);
    const args = getCapturedArgs();
    assert.equal(args.length, 1);
    assert.equal(args[0], undefined, 'pinned.js must not force-install; only the real gate should decide');
  });
});
