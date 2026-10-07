'use strict';

/*
 * The two stream parsers (ADR 0024, section 3): src/net/sse.js and src/net/ndjson.js.
 * Pure and offline: no sockets here. Every fixture is run three ways (every single split position,
 * one byte at a time, and every pair of split positions for fixtures under 80 bytes), and every
 * expected value is written out by hand below.
 *
 * Tests that pass today and prove nothing: none of the error-code spellings are checked against
 * anything but themselves, so the caps tests also assert the parser really stopped (no later
 * event is returned).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { createSseParser } = require('../src/net/sse');
const { createNdjsonParser } = require('../src/net/ndjson');
const { NetError } = require('../src/net/errors');
const { sentinel } = require('./helpers/net-stubs');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const bytes = (s) => Buffer.from(s, 'utf8');

function feed(make, parts, opts) {
  const p = make(opts);
  const out = [];
  try {
    for (const part of parts) out.push(...p.push(part));
    out.push(...p.end());
  } catch (error) {
    return { out, error };
  }
  return { out, error: null };
}

function splitsOf(buf) {
  const all = [];
  for (let i = 0; i <= buf.length; i++) all.push([buf.subarray(0, i), buf.subarray(i)]);
  all.push(Array.from({ length: buf.length }, (_, i) => buf.subarray(i, i + 1)));
  if (buf.length < 80) {
    for (let i = 0; i <= buf.length; i++) {
      for (let j = i + 1; j <= buf.length; j++) all.push([buf.subarray(0, i), buf.subarray(i, j), buf.subarray(j)]);
    }
  }
  return all;
}

function everyWay(make, buf, opts, check) {
  const ways = splitsOf(buf);
  assert.ok(ways.length >= buf.length + 2);
  for (const parts of ways) check(feed(make, parts, opts), parts.map((p) => p.length).join(','));
}

function assertEvents(make, buf, expected, opts) {
  everyWay(make, buf, opts, (r, label) => {
    assert.equal(r.error, null, `split ${label}: ${r.error && r.error.message}`);
    assert.deepEqual(r.out, expected, `split ${label}`);
  });
}

// --- SSE ------------------------------------------------------------------------------------------

const SSE_A = Buffer.concat([BOM, bytes('data: héllo \u{1F409}\r\n\r\nevent: delta\r\ndata: a\r\ndata: b\r\n\r\n')]);
const SSE_A_EXPECTED = [
  { event: 'message', data: 'héllo \u{1F409}', id: '' },
  { event: 'delta', data: 'a\nb', id: '' },
];

test('sse: fixture A (BOM, multi-byte text, CRLF, multi-line data) at every split, byte at a time and every pair', () => {
  assert.ok(SSE_A.length < 80);
  assertEvents(createSseParser, SSE_A, SSE_A_EXPECTED);
});

const SSE_B = bytes(
  ': comment line\nretry: 3000\ndata:no-space\r\revent: ping\n\ndata\ndata:  two-spaces\n\nid: 42\ndata: x\nfoo: bar\n\ndata: after-id\n\ndata: incomplete',
);
const SSE_B_EXPECTED = [
  { event: 'message', data: 'no-space', id: '' },
  { event: 'message', data: '\n two-spaces', id: '' },
  { event: 'message', data: 'x', id: '42' },
  { event: 'message', data: 'after-id', id: '42' },
];

test('sse: fixture B (comments, lone CR, bare field, id persistence, unfinished event) at every split and byte at a time', () => {
  assert.ok(SSE_B.length >= 80);
  assertEvents(createSseParser, SSE_B, SSE_B_EXPECTED);
});

test('sse: a CR at the end of one chunk and the LF at the start of the next make one line end', () => {
  const r = feed(createSseParser, [bytes('data: a\r'), bytes('\ndata: b\r\n\r\n')]);
  assert.deepEqual(r.out, [{ event: 'message', data: 'a\nb', id: '' }]);
  // An empty push between them must not lose the pending skip.
  const r2 = feed(createSseParser, [bytes('data: a\r'), Buffer.alloc(0), bytes('\ndata: b\r\n\r\n')]);
  assert.deepEqual(r2.out, [{ event: 'message', data: 'a\nb', id: '' }]);
});

test('sse: a four-byte character split across chunks, with the skip pending, still decodes whole', () => {
  const dragon = bytes('\u{1F409}');
  const r = feed(createSseParser, [bytes('data: x\r'), dragon.subarray(0, 2), dragon.subarray(2), bytes('\n\n')]);
  // After the CR the dragon is a line of its own (an unknown field, ignored), then a blank line
  // dispatches the event.
  assert.deepEqual(r.out, [{ event: 'message', data: 'x', id: '' }]);
});

test('sse: a BOM split across chunks is dropped once and a later BOM is data', () => {
  const r = feed(createSseParser, [BOM.subarray(0, 1), Buffer.concat([BOM.subarray(1), bytes('data: a\n\n')])]);
  assert.deepEqual(r.out, [{ event: 'message', data: 'a', id: '' }]);
});

test('sse: id with a NUL is ignored, retry and unknown fields are ignored, an empty id resets', () => {
  const src = bytes('id: 1\ndata: a\n\nid: 2\u0000\ndata: b\n\nid\ndata: c\n\nretry: 5\nnope\ndata: d\n\n');
  assertEvents(createSseParser, src, [
    { event: 'message', data: 'a', id: '1' },
    { event: 'message', data: 'b', id: '1' },
    { event: 'message', data: 'c', id: '' },
    { event: 'message', data: 'd', id: '' },
  ]);
});

test('sse: an event type applies to one event only; an empty data buffer dispatches nothing', () => {
  assertEvents(createSseParser, bytes('event: x\n\ndata: a\n\nevent: y\ndata: b\n\n'), [
    { event: 'message', data: 'a', id: '' },
    { event: 'y', data: 'b', id: '' },
  ]);
});

test('sse caps: line length', () => {
  const opts = { maxLineLength: 8 };
  assertEvents(createSseParser, bytes('data: ab\n\n'), [{ event: 'message', data: 'ab', id: '' }], opts);
  everyWay(createSseParser, bytes('data: abc\n'), opts, (r, label) => {
    assert.ok(r.error instanceof NetError && r.error.code === 'E_SSE_LINE_CAP', `split ${label}`);
    assert.equal(r.error.limit, 8);
    assert.deepEqual(r.out, []);
  });
  const p = createSseParser(opts);
  assert.throws(() => p.push(bytes('data: abc')), (e) => e.code === 'E_SSE_LINE_CAP');
});

test('sse caps: event length', () => {
  const opts = { maxEventLength: 10 };
  everyWay(createSseParser, bytes('data: 12345\ndata: 12345\n'), opts, (r, label) => {
    assert.ok(r.error instanceof NetError && r.error.code === 'E_SSE_EVENT_CAP', `split ${label}`);
    assert.equal(r.error.limit, 10);
  });
  assertEvents(createSseParser, bytes('data: 1234\ndata: 1\n\n'), [{ event: 'message', data: '1234\n1', id: '' }], opts);
});

test('sse: a call after an error or after end() throws E_PARSER_DONE; a string chunk is E_PARSER_INPUT', () => {
  const p = createSseParser({ maxLineLength: 8 });
  assert.throws(() => p.push(bytes('data: abc\n')), (e) => e.code === 'E_SSE_LINE_CAP');
  assert.throws(() => p.push(bytes('data: a\n\n')), (e) => e.code === 'E_PARSER_DONE');
  assert.throws(() => p.end(), (e) => e.code === 'E_PARSER_DONE');
  const q = createSseParser();
  assert.deepEqual(q.end(), []);
  assert.throws(() => q.push(bytes('x')), (e) => e.code === 'E_PARSER_DONE');
  assert.throws(() => q.end(), (e) => e.code === 'E_PARSER_DONE');
  const r = createSseParser();
  assert.throws(() => r.push('data: a\n\n'), (e) => e.code === 'E_PARSER_INPUT');
  assert.ok(Buffer.isBuffer(bytes('x')));
  const s = createSseParser();
  assert.deepEqual(s.push(new Uint8Array(bytes('data: a\n\n'))), [{ event: 'message', data: 'a', id: '' }]);
});

// --- NDJSON ---------------------------------------------------------------------------------------

const ND_A = bytes('{"a":1}\n\n  \t \n{"b":"é\u{1F409}"}\r\n{"c":[1,2]}');

test('ndjson: fixture A (blank lines, CRLF, multi-byte text, unterminated last line) at every split', () => {
  assertEvents(createNdjsonParser, ND_A, [{ a: 1 }, { b: 'é\u{1F409}' }, { c: [1, 2] }]);
});

test('ndjson: a leading BOM is dropped, even split across chunks', () => {
  assertEvents(createNdjsonParser, Buffer.concat([BOM, bytes('{"d":true}\n')]), [{ d: true }]);
});

test('ndjson: an invalid line gives E_NDJSON_INVALID with the line number only, at every split', () => {
  const s = sentinel('ndjson');
  const src = bytes('{"ok":1}\n{"k":"' + s + '"\n{"never":1}\n');
  everyWay(createNdjsonParser, src, undefined, (r, label) => {
    assert.ok(r.error instanceof NetError, `split ${label}`);
    assert.equal(r.error.code, 'E_NDJSON_INVALID');
    assert.equal(r.error.line, 2);
    assert.equal(r.error.cause, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(r.error, 'cause'));
    for (const text of [r.error.message, r.error.stack, String(r.error), util.inspect(r.error), JSON.stringify(r.error)]) {
      assert.ok(!text.includes(s), 'the sentinel must not appear in any rendering');
    }
  });
});

test('ndjson: values parsed earlier in the same push are dropped when a later line fails', () => {
  const p = createNdjsonParser();
  assert.throws(() => p.push(bytes('{"a":1}\nnope\n')), (e) => e.code === 'E_NDJSON_INVALID' && e.line === 2);
});

test('ndjson: an unterminated invalid last line fails in end() with its line number', () => {
  const p = createNdjsonParser();
  assert.deepEqual(p.push(bytes('{"a":1}\n{bad')), [{ a: 1 }]);
  assert.throws(() => p.end(), (e) => e.code === 'E_NDJSON_INVALID' && e.line === 2);
});

test('ndjson caps: line length, including while pending', () => {
  const opts = { maxLineLength: 8 };
  assertEvents(createNdjsonParser, bytes('{"a":12}\n'), [{ a: 12 }], opts);
  everyWay(createNdjsonParser, bytes('{"a":123}\n'), opts, (r, label) => {
    assert.ok(r.error instanceof NetError && r.error.code === 'E_NDJSON_LINE_CAP', `split ${label}`);
    assert.equal(r.error.limit, 8);
  });
  const p = createNdjsonParser(opts);
  assert.throws(() => p.push(bytes('{"a":123}')), (e) => e.code === 'E_NDJSON_LINE_CAP');
});

test('ndjson: a call after an error or after end() throws E_PARSER_DONE; a string chunk is E_PARSER_INPUT', () => {
  const p = createNdjsonParser();
  assert.throws(() => p.push(bytes('nope\n')), (e) => e.code === 'E_NDJSON_INVALID');
  assert.throws(() => p.push(bytes('{}\n')), (e) => e.code === 'E_PARSER_DONE');
  assert.throws(() => p.end(), (e) => e.code === 'E_PARSER_DONE');
  const q = createNdjsonParser();
  assert.deepEqual(q.end(), []);
  assert.throws(() => q.push(bytes('{}\n')), (e) => e.code === 'E_PARSER_DONE');
  const r = createNdjsonParser();
  assert.throws(() => r.push('{}\n'), (e) => e.code === 'E_PARSER_INPUT');
});

test('ndjson: a final line with no terminator is returned by end(), a blank one is not', () => {
  const a = createNdjsonParser();
  assert.deepEqual(a.push(bytes('{"z":0}')), []);
  assert.deepEqual(a.end(), [{ z: 0 }]);
  const b = createNdjsonParser();
  assert.deepEqual(b.push(bytes('{"z":0}\n   ')), [{ z: 0 }]);
  assert.deepEqual(b.end(), []);
});
