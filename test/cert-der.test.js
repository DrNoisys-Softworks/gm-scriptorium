'use strict';

/*
 * src/cert/der.js known answers. Every expected byte string below is typed by
 * hand from the ASN.1/DER rules (X.690) and the registered OIDs, never produced
 * by the encoder under test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const der = require('../src/cert/der');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('oid: known answers', () => {
  assert.deepEqual(der.oid('1.2.840.10045.4.3.2'), hex('06 08 2A 86 48 CE 3D 04 03 02'));
  assert.deepEqual(der.oid('2.5.29.17'), hex('06 03 55 1D 11'));
  assert.deepEqual(der.oid('1.3.6.1.5.5.7.3.1'), hex('06 08 2B 06 01 05 05 07 03 01'));
  assert.deepEqual(der.oid('2.5.4.3'), hex('06 03 55 04 03'));
});

test('oid: rejects malformed input', () => {
  assert.throws(() => der.oid('1'), TypeError);
  assert.throws(() => der.oid('3.1.2'), RangeError);
  assert.throws(() => der.oid('1.40.2'), RangeError);
  assert.throws(() => der.oid('1.2.x'), TypeError);
  assert.throws(() => der.oid(5), TypeError);
});

test('integer: known answers', () => {
  assert.deepEqual(der.integer(0), hex('02 01 00'));
  assert.deepEqual(der.integer(0x7f), hex('02 01 7F'));
  assert.deepEqual(der.integer(0x80), hex('02 02 00 80'));
  assert.deepEqual(der.integer(256), hex('02 02 01 00'));
  assert.deepEqual(der.integer(Buffer.from([0, 0, 1])), hex('02 01 01'));
  assert.deepEqual(der.integer(Buffer.from([0x80, 0x01])), hex('02 03 00 80 01'));
  assert.deepEqual(der.integer(Buffer.from([0, 0])), hex('02 01 00'));
  assert.deepEqual(der.integer(Buffer.alloc(0)), hex('02 01 00'));
});

test('integer: rejects negatives and non-integers', () => {
  assert.throws(() => der.integer(-1), RangeError);
  assert.throws(() => der.integer(1.5), TypeError);
  assert.throws(() => der.integer('1'), TypeError);
});

test('lengthOctets: boundaries', () => {
  assert.deepEqual(der.lengthOctets(0), hex('00'));
  assert.deepEqual(der.lengthOctets(127), hex('7F'));
  assert.deepEqual(der.lengthOctets(128), hex('81 80'));
  assert.deepEqual(der.lengthOctets(255), hex('81 FF'));
  assert.deepEqual(der.lengthOctets(256), hex('82 01 00'));
  assert.deepEqual(der.lengthOctets(65536), hex('83 01 00 00'));
  assert.throws(() => der.lengthOctets(-1), RangeError);
});

test('tlv: long-form content uses the long length', () => {
  const t = der.tlv(0x04, Buffer.alloc(128, 0xab));
  assert.deepEqual(t.subarray(0, 3), hex('04 81 80'));
  assert.equal(t.length, 131);
  const u = der.tlv(0x04, Buffer.alloc(256, 0));
  assert.deepEqual(u.subarray(0, 4), hex('04 82 01 00'));
});

test('boolean', () => {
  assert.deepEqual(der.boolean(true), hex('01 01 FF'));
  assert.deepEqual(der.boolean(false), hex('01 01 00'));
});

test('time: UTCTime below 2050, GeneralizedTime from 2050', () => {
  assert.deepEqual(der.time(new Date('2049-12-31T23:59:59Z')), Buffer.concat([hex('17 0D'), Buffer.from('491231235959Z')]));
  assert.deepEqual(der.time(new Date('2050-01-01T00:00:00Z')), Buffer.concat([hex('18 0F'), Buffer.from('20500101000000Z')]));
  assert.deepEqual(der.time(new Date('1950-01-01T00:00:00Z')), Buffer.concat([hex('17 0D'), Buffer.from('500101000000Z')]));
  assert.deepEqual(der.time(new Date('2027-01-01T00:00:00.999Z')), Buffer.concat([hex('17 0D'), Buffer.from('270101000000Z')]));
  assert.deepEqual(der.time(new Date('1949-12-31T23:59:59Z')), Buffer.concat([hex('18 0F'), Buffer.from('19491231235959Z')]));
  assert.throws(() => der.time(new Date(NaN)), RangeError);
  assert.throws(() => der.time('2027-01-01'), TypeError);
});

test('strings', () => {
  assert.deepEqual(der.utf8String('GM'), hex('0C 02 47 4D'));
  assert.deepEqual(der.utf8String('é'), hex('0C 02 C3 A9'));
  assert.deepEqual(der.ia5String('a.b'), hex('16 03 61 2E 62'));
  assert.throws(() => der.ia5String('é'), RangeError);
});

test('octetString and bitString', () => {
  assert.deepEqual(der.octetString(Buffer.from([1, 2])), hex('04 02 01 02'));
  assert.deepEqual(der.bitString(Buffer.from([0x04]), 2), hex('03 02 02 04'));
  assert.deepEqual(der.bitString(Buffer.from([0x80]), 7), hex('03 02 07 80'));
  assert.deepEqual(der.bitString(Buffer.from([1, 2, 3])), hex('03 04 00 01 02 03'));
  assert.throws(() => der.bitString(Buffer.from([0]), 8), RangeError);
  assert.throws(() => der.bitString(Buffer.from([0]), -1), RangeError);
});

test('sequence and set; set sorts its elements', () => {
  assert.deepEqual(der.sequence([der.integer(1), der.boolean(true)]), hex('30 06 02 01 01 01 01 FF'));
  assert.deepEqual(der.sequence([]), hex('30 00'));
  // 02 01 05 sorts after 01 01 FF (first byte 0x01 < 0x02), whatever the input order.
  assert.deepEqual(der.set([der.integer(5), der.boolean(true)]), hex('31 06 01 01 FF 02 01 05'));
  assert.deepEqual(der.set([der.boolean(true), der.integer(5)]), hex('31 06 01 01 FF 02 01 05'));
  // Equal first bytes: compared byte-wise on the whole encoding.
  assert.deepEqual(der.set([der.integer(9), der.integer(2)]), hex('31 06 02 01 02 02 01 09'));
});

test('context tags', () => {
  assert.deepEqual(der.explicit(0, der.integer(2)), hex('A0 03 02 01 02'));
  assert.deepEqual(der.explicit(3, der.integer(2)), hex('A3 03 02 01 02'));
  assert.deepEqual(der.implicitPrimitive(2, Buffer.from('ab')), hex('82 02 61 62'));
  assert.deepEqual(der.implicitPrimitive(7, Buffer.from([192, 0, 2, 42])), hex('87 04 C0 00 02 2A'));
  assert.deepEqual(der.implicitConstructed(0, [der.integer(1)]), hex('A0 03 02 01 01'));
  assert.throws(() => der.explicit(31, Buffer.alloc(0)), RangeError);
  assert.throws(() => der.implicitPrimitive(-1, Buffer.alloc(0)), RangeError);
});

test('type errors on non-Buffer parts', () => {
  assert.throws(() => der.sequence(['x']), TypeError);
  assert.throws(() => der.octetString('x'), TypeError);
});
