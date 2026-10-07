'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readBody, JSON_BODY_CAP, parseJson } = require('../src/admin/body');

/*
 * admin-fix-1, item 4 (NFR09): src/admin/body.js's readBody has no dedicated test file at all.
 * This covers the branches QA listed as uncovered plus the ones needed to exercise them safely.
 * A fake `req` is a plain object exposing on/removeListener/resume -- readBody's own contract --
 * with handler references captured directly rather than relying on a real EventEmitter's
 * bookkeeping, so a test can invoke a handler again after "removal" to exercise the double-settle
 * guard, which a real stream's own removeListener would otherwise make unreachable.
 */

function makeFakeReq({ headers = {} } = {}) {
  const handlers = {};
  let removeListenerCalls = 0;
  return {
    req: {
      headers,
      on(event, fn) {
        handlers[event] = fn;
        return this;
      },
      removeListener() {
        removeListenerCalls += 1;
        return this;
      },
      resume() {
        return this;
      },
    },
    handlers,
    removeListenerCallCount: () => removeListenerCalls,
  };
}

// --- body.js:43, the double-settle guard -------------------------------------------------------

test('double-settle guard: a handler firing twice (data over cap, then end) only runs cleanup once', async () => {
  const { req, handlers, removeListenerCallCount } = makeFakeReq();
  const promise = readBody(req, 10);

  const overCap = Buffer.from('x'.repeat(20));
  handlers.data(overCap); // total(20) > cap(10): finish({ok:false,status:413}), cleanup() runs once
  handlers.end(); // a real stream could never reach this (removeListener already fired for real);
  // this fake holds the reference regardless, so it exercises the guard directly.

  const result = await promise;
  assert.deepEqual(result, { ok: false, status: 413 }, 'the FIRST finish() call\'s result must win');
  // cleanup() removes exactly 3 listeners (data/end/error) per call; the guard means it only ever
  // runs once, so the total must be 3, not 6 -- this is the actual observable signal, because a
  // native Promise silently ignores a second resolve() with a different value on its own, which
  // would make an assertion on `result` alone pass even with the guard removed.
  assert.equal(removeListenerCallCount(), 3, 'cleanup() must run exactly once, not once per handler firing');
});

// --- Positive controls: normal completion paths --------------------------------------------------

test('positive control: a body within the cap resolves {ok:true, body} once, from a single end', async () => {
  const { req, handlers } = makeFakeReq();
  const promise = readBody(req, 65536);
  handlers.data(Buffer.from('hello'));
  handlers.data(Buffer.from(' world'));
  handlers.end();
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.body.toString('utf8'), 'hello world');
});

test('positive control: a declared Content-Length already over the cap is refused before any data event, draining rather than destroying', async () => {
  const { req, handlers, removeListenerCallCount } = makeFakeReq({ headers: { 'content-length': '999999' } });
  const result = await readBody(req, JSON_BODY_CAP);
  assert.deepEqual(result, { ok: false, status: 413 });
  // The early Content-Length path returns before ever registering a data/end/error listener, so
  // there is nothing to clean up -- this must stay 0, distinguishing it from the streaming path.
  assert.equal(removeListenerCallCount(), 0);
});

test('a stream error resolves {ok:false, status:413}', async () => {
  const { req, handlers } = makeFakeReq();
  const promise = readBody(req, 65536);
  handlers.error(new Error('boom'));
  const result = await promise;
  assert.deepEqual(result, { ok: false, status: 413 });
});

test('parseJson parses valid JSON bytes and throws SyntaxError on malformed input', () => {
  assert.deepEqual(parseJson(Buffer.from('{"a":1}')), { a: 1 });
  assert.throws(() => parseJson(Buffer.from('{not json')), SyntaxError);
});
