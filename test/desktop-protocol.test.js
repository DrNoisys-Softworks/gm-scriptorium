'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const protocol = require('../src/desktop/protocol');
const { ScriptoriumError } = require('../src/util/errors');

/*
 * Desktop protocol v1 (ADR 0057, "Protocol v1"). Expected values here are typed from the ADR,
 * not computed from the module under test.
 */

const TAB = '\t';
const ADR = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'decisions', '0057-windows-desktop-app.md'),
  'utf8'
);

test('constants match the ADR', () => {
  assert.equal(protocol.PROTOCOL_VERSION, 1);
  assert.equal(protocol.MAX_LINE_BYTES, 1024);
  assert.deepEqual(protocol.HOST_VERBS, ['hello', 'state', 'confirm', 'update', 'bye']);
  assert.deepEqual(protocol.HELPER_VERBS, [
    'open', 'stop?', 'stop', 'start', 'restart', 'retry', 'quit?', 'quit',
  ]);
  for (const list of [protocol.HOST_VERBS, protocol.HELPER_VERBS]) {
    assert.ok(Object.isFrozen(list), 'verb lists are frozen');
  }
});

test('ADR 0057 names every verb and the line limit', () => {
  for (const v of [...protocol.HOST_VERBS, ...protocol.HELPER_VERBS]) {
    assert.ok(ADR.includes('`' + v), 'ADR 0057 mentions ' + v);
  }
  assert.ok(ADR.includes('1024 bytes'));
});

test('encodeLine joins with TAB and ends with one LF', () => {
  assert.equal(
    protocol.encodeLine(['hello', '1', '0.5.0', 'D:\\GM\\logs']),
    'hello\t1\t0.5.0\tD:\\GM\\logs\n'
  );
  assert.equal(protocol.encodeLine(['quit']), 'quit\n');
  assert.equal(protocol.encodeLine(['state', 'stopped', '-']), 'state\tstopped\t-\n');
});

test('encodeLine keeps empty fields and coerces numbers', () => {
  assert.equal(protocol.encodeLine(['state', 'error', 'port', 'in use', 7400]), 'state\terror\tport\tin use\t7400\n');
  assert.equal(protocol.encodeLine(['bye', '']), 'bye\t\n');
  assert.equal(protocol.encodeLine(['bye', null, undefined]), 'bye\t\t\n');
});

test('encodeLine strips every C0 control and DEL from every field', () => {
  for (let c = 0; c <= 0x1f; c++) {
    const ch = String.fromCharCode(c);
    assert.equal(
      protocol.encodeLine(['state', 'error', 'other', 'a' + ch + 'b']),
      'state\terror\tother\tab\n',
      'control U+' + c.toString(16) + ' is stripped'
    );
  }
  assert.equal(protocol.encodeLine(['bye', 'a\u007fb']), 'bye\tab\n');
  // The verb is a field too.
  assert.equal(protocol.encodeLine(['qu\nit']), 'quit\n');
});

test('encodeLine: a TAB or LF inside a field cannot split or forge a line', () => {
  const line = protocol.encodeLine(['state', 'error', 'other', 'x\nquit\ty']);
  assert.equal(line, 'state\terror\tother\txquity\n');
  assert.equal(line.split('\n').length, 2);
  assert.equal(line.split('\t').length, 4);
});

test('encodeLine leaves printable and non-ASCII text alone', () => {
  assert.equal(protocol.encodeLine(['hello', '1', '0.5.0', 'D:\\Vault \u00e9\u00e8 \u2603']), 'hello\t1\t0.5.0\tD:\\Vault \u00e9\u00e8 \u2603\n');
});

test('encodeLine: exactly 1024 bytes including the LF is allowed, 1025 is refused', () => {
  const head = 'bye\t';
  const ok = protocol.encodeLine(['bye', 'x'.repeat(1024 - Buffer.byteLength(head) - 1)]);
  assert.equal(Buffer.byteLength(ok), 1024);
  assert.throws(
    () => protocol.encodeLine(['bye', 'x'.repeat(1024 - Buffer.byteLength(head))]),
    (e) => e instanceof ScriptoriumError
  );
});

test('encodeLine counts bytes, not characters', () => {
  // 600 two-byte characters is 1200 bytes but only 600 characters.
  assert.throws(() => protocol.encodeLine(['bye', '\u00e9'.repeat(600)]), ScriptoriumError);
  // 300 three-byte characters (900 bytes) plus the verb fits.
  assert.equal(Buffer.byteLength(protocol.encodeLine(['bye', '\u2603'.repeat(300)])), 4 + 900 + 1);
});

test('encodeLine: stripping happens before the length is measured', () => {
  const padded = 'x'.repeat(1000) + '\u0001'.repeat(500);
  assert.equal(Buffer.byteLength(protocol.encodeLine(['bye', padded])), 4 + 1000 + 1);
});

test('encodeLine refuses a non-array or empty list', () => {
  assert.throws(() => protocol.encodeLine('quit'), ScriptoriumError);
  assert.throws(() => protocol.encodeLine([]), ScriptoriumError);
  assert.throws(() => protocol.encodeLine(undefined), ScriptoriumError);
});

test('parseLine round trips every verb with and without arguments', () => {
  const samples = [
    ['hello', '1', '0.5.0', 'C:\\logs'],
    ['state', 'starting', 'long-lease', 'opening the vault'],
    ['state', 'running', 'setup', 'local', 'http://127.0.0.1:7400'],
    ['state', 'stopped', '-'],
    ['state', 'error', 'port', 'port 7400 is already in use', '7400'],
    ['confirm', 'remote'],
    ['update', '0.5.1', 'https://github.com/example/example/releases/tag/v0.5.1'],
    ['bye', 'crash'],
    ['open'],
    ['open', 'updates'],
    ['stop?'], ['stop'], ['start'], ['restart'], ['retry'], ['quit?'], ['quit'],
  ];
  for (const fields of samples) {
    const parsed = protocol.parseLine(protocol.encodeLine(fields));
    assert.deepEqual(parsed, { verb: fields[0], args: fields.slice(1) }, fields.join(' '));
  }
});

test('parseLine accepts text with or without the closing LF', () => {
  assert.deepEqual(protocol.parseLine('quit\n'), { verb: 'quit', args: [] });
  assert.deepEqual(protocol.parseLine('quit'), { verb: 'quit', args: [] });
});

test('parseLine keeps empty arguments in place', () => {
  assert.deepEqual(protocol.parseLine('bye\t\t\n'), { verb: 'bye', args: ['', ''] });
});

test('parseLine ignores an unknown first field', () => {
  for (const text of ['frobnicate\n', 'HELLO\t1\n', 'hello \t1\n', 'quit!\n', 'states\tx\n', '\tquit\n']) {
    assert.equal(protocol.parseLine(text), null, JSON.stringify(text));
  }
});

test('parseLine drops malformed lines', () => {
  const bad = [
    '',
    '\n',
    '\n\n',
    'quit\nquit\n',
    'quit\r\n',
    'hello\t1\u0000\n',
    'bye\tx\u001by\n',
    'bye\tx\u007fy\n',
    'quit\u0007\n',
  ];
  for (const text of bad) assert.equal(protocol.parseLine(text), null, JSON.stringify(text));
  for (const notText of [undefined, null, 5, {}, ['quit'], Buffer.from('quit\n')]) {
    assert.equal(protocol.parseLine(notText), null);
  }
});

test('parseLine drops a line over 1024 bytes and keeps one of exactly 1024', () => {
  const fits = 'bye\t' + 'x'.repeat(1024 - 4 - 1) + '\n';
  assert.equal(Buffer.byteLength(fits), 1024);
  assert.equal(protocol.parseLine(fits).verb, 'bye');
  const over = 'bye\t' + 'x'.repeat(1024 - 4) + '\n';
  assert.equal(Buffer.byteLength(over), 1025);
  assert.equal(protocol.parseLine(over), null);
  // Multi-byte: few characters, many bytes.
  assert.equal(protocol.parseLine('bye\t' + '\u00e9'.repeat(600) + '\n'), null);
});

test('encodeLine output always parses back, whatever the field text', () => {
  const nasty = ['\u0000\u0001\t\n\r', 'a\tb', 'tab\there', '\u007f', ''];
  for (const n of nasty) {
    const parsed = protocol.parseLine(protocol.encodeLine(['bye', n]));
    assert.ok(parsed && parsed.verb === 'bye');
    assert.equal(parsed.args.length, 1);
    assert.equal(/[\u0000-\u001f\u007f]/.test(parsed.args[0]), false);
  }
});

test('module requires nothing but the error classes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop', 'protocol.js'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(reqs, ['../util/errors']);
});
