'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const addr = require('../src/remote/addr');

/*
 * V1.5a (SD-a2). Pure IP handling. Every expected value below is typed independently of the code
 * (RFC 5952 forms worked out by hand), and RFC 5737 / 3849 documentation addresses are the
 * neutral examples throughout.
 */

test('LOOPBACK_PEERS is exactly the two loopback literals', () => {
  assert.deepEqual([...addr.LOOPBACK_PEERS], ['127.0.0.1', '::1']);
  assert.ok(Object.isFrozen(addr.LOOPBACK_PEERS));
});

const CANONICAL = [
  ['192.0.2.42', '192.0.2.42'],
  ['0.0.0.0', '0.0.0.0'],
  ['255.255.255.255', '255.255.255.255'],
  ['::', '::'],
  ['0:0:0:0:0:0:0:0', '::'],
  ['::1', '::1'],
  ['0:0:0:0:0:0:0:1', '::1'],
  ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
  ['2001:db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
  ['2001:db8::', '2001:db8::'],
  ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'], // a single zero group is NOT compressed
  ['1:0:0:2:0:0:0:3', '1:0:0:2::3'], // the longest run wins
  ['1:0:0:2:0:0:3:4', '1::2:0:0:3:4'], // a tie goes to the first run
  ['fe80::1', 'fe80::1'],
  ['::ffff:127.0.0.1', '127.0.0.1'], // IPv4-mapped: dotted form
  ['::FFFF:192.0.2.42', '192.0.2.42'],
  ['::ffff:c000:22a', '192.0.2.42'],
  ['::ffff:0:1', '0.0.0.1'], // mapped: groups 0-4 zero, group 5 ffff
  ['1::ffff:0:1', '1::ffff:0:1'], // not mapped (the leading group is non-zero)
  ['64:ff9b::192.0.2.1', '64:ff9b::c000:201'],
];

for (const [input, expected] of CANONICAL) {
  test(`canonicalize(${JSON.stringify(input)}) is ${JSON.stringify(expected)}`, () => {
    assert.equal(addr.canonicalize(input), expected);
  });
}

const REJECTED = [
  '',
  ' 192.0.2.42',
  '192.0.2.42 ',
  '192.0.2',
  '192.0.2.256',
  '192.0.2.042',
  '192.0.2.42.1',
  '192.0.2.42:80',
  '192.0.2.0/24',
  'localhost',
  'example.test',
  '*',
  'fe80::1%eth0',
  '[::1]',
  '1::2::3',
  ':::',
  '12345::1',
  '1:2:3:4:5:6:7',
  '1:2:3:4:5:6:7:8:9',
  '::1.2.3',
  'g::1',
];

for (const input of REJECTED) {
  test(`canonicalize(${JSON.stringify(input)}) is null`, () => {
    assert.equal(addr.canonicalize(input), null);
  });
}

test('canonicalize refuses non-strings', () => {
  for (const v of [undefined, null, 127, {}, [], true]) assert.equal(addr.canonicalize(v), null);
});

test('normalizePeer folds the socket forms to the comparison form, and null for junk', () => {
  assert.equal(addr.normalizePeer('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(addr.normalizePeer('::1'), '::1');
  assert.equal(addr.normalizePeer('198.51.100.20'), '198.51.100.20');
  assert.equal(addr.normalizePeer(undefined), null);
  assert.equal(addr.normalizePeer('not-an-address'), null);
});

test('a loopback peer is recognised in every spelling the socket may use, and a sibling is not', () => {
  const isLoop = (p) => addr.LOOPBACK_PEERS.includes(addr.normalizePeer(p));
  assert.equal(isLoop('127.0.0.1'), true);
  assert.equal(isLoop('::ffff:127.0.0.1'), true);
  assert.equal(isLoop('::1'), true);
  assert.equal(isLoop('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoop('127.0.0.2'), false);
  assert.equal(isLoop('127.0.0.10'), false);
  assert.equal(isLoop('::ffff:127.0.0.2'), false);
});

test('rightmostForwardedFor takes the LAST entry, never the first', () => {
  assert.equal(addr.rightmostForwardedFor('203.0.113.9, 198.51.100.20'), '198.51.100.20');
  assert.equal(addr.rightmostForwardedFor('198.51.100.20'), '198.51.100.20');
  assert.equal(addr.rightmostForwardedFor('203.0.113.9,198.51.100.20'), '198.51.100.20');
  assert.equal(addr.rightmostForwardedFor('1.1.1.1, 2.2.2.2, 3.3.3.3'), '3.3.3.3');
});

test('rightmostForwardedFor normalises mapped IPv6, strips brackets, and gives null for junk', () => {
  assert.equal(addr.rightmostForwardedFor('203.0.113.9, ::ffff:198.51.100.20'), '198.51.100.20');
  assert.equal(addr.rightmostForwardedFor('203.0.113.9, [2001:db8::1]'), '2001:db8::1');
  assert.equal(addr.rightmostForwardedFor('203.0.113.9, unknown'), null);
  assert.equal(addr.rightmostForwardedFor('203.0.113.9,'), null);
  assert.equal(addr.rightmostForwardedFor(''), null);
  assert.equal(addr.rightmostForwardedFor(undefined), null);
  assert.equal(addr.rightmostForwardedFor(['198.51.100.20']), null);
});

test('ipBytes gives 4 bytes for IPv4 and 16 for IPv6, byte for byte', () => {
  assert.deepEqual(Array.from(addr.ipBytes('192.0.2.42') || []), [192, 0, 2, 42]);
  assert.deepEqual(Array.from(addr.ipBytes('2001:db8::1') || []), [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal((addr.ipBytes('::') || []).length, 16);
  assert.equal(addr.ipBytes('nope'), null);
});

test('src/remote/addr.js requires no module at all (NFR-03: no `net`)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'remote', 'addr.js'), 'utf8');
  assert.doesNotMatch(src, /require\(/);
  assert.doesNotMatch(src, /\bnet\b\s*\./);
});
