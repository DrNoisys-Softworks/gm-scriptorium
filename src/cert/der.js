'use strict';

/*
 * Minimal DER encoder for the certificate generator (src/cert/generate.js).
 * Pure and synchronous; every function returns a Buffer. Bad input is a
 * programming error and throws TypeError or RangeError. Tag numbers 0-30 only.
 * Requires nothing: this module has no imports at all.
 */

function assertBuffer(v, what) {
  if (!Buffer.isBuffer(v)) throw new TypeError(`${what} must be a Buffer`);
}

function assertTagNumber(n) {
  if (!Number.isInteger(n) || n < 0 || n > 30) throw new RangeError('tag number must be an integer from 0 to 30');
}

function lengthOctets(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('length must be a non-negative integer');
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  if (!Number.isInteger(tag) || tag < 0 || tag > 255) throw new RangeError('tag must be one byte');
  assertBuffer(content, 'content');
  return Buffer.concat([Buffer.from([tag]), lengthOctets(content.length), content]);
}

function concatParts(parts) {
  if (!Array.isArray(parts)) throw new TypeError('parts must be an array of Buffers');
  parts.forEach((p) => assertBuffer(p, 'part'));
  return Buffer.concat(parts);
}

const sequence = (parts) => tlv(0x30, concatParts(parts));

function set(parts) {
  concatParts(parts);
  return tlv(0x31, Buffer.concat([...parts].sort(Buffer.compare)));
}

function integer(v) {
  let bytes;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new TypeError('integer must be an integer or a Buffer');
    if (v < 0) throw new RangeError('negative integers are not supported');
    const out = [];
    for (let n = v; n > 0; n = Math.floor(n / 256)) out.unshift(n % 256);
    bytes = Buffer.from(out);
  } else {
    assertBuffer(v, 'integer');
    bytes = v;
  }
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  bytes = bytes.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

const boolean = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));

function oid(dotted) {
  if (typeof dotted !== 'string' || !/^\d+(\.\d+)+$/.test(dotted)) throw new TypeError('oid must be a dotted-decimal string with at least two arcs');
  const arcs = dotted.split('.').map(Number);
  if (arcs[0] > 2) throw new RangeError('first arc must be 0, 1 or 2');
  if (arcs[0] < 2 && arcs[1] > 39) throw new RangeError('second arc must be below 40 under arcs 0 and 1');
  const out = [];
  const encode = (n) => {
    const parts = [n % 128];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) parts.unshift((v % 128) | 0x80);
    out.push(...parts);
  };
  encode(arcs[0] * 40 + arcs[1]);
  arcs.slice(2).forEach(encode);
  return tlv(0x06, Buffer.from(out));
}

const octetString = (buf) => {
  assertBuffer(buf, 'octetString');
  return tlv(0x04, buf);
};

function bitString(buf, unusedBits = 0) {
  assertBuffer(buf, 'bitString');
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) throw new RangeError('unusedBits must be 0 to 7');
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
}

function utf8String(s) {
  if (typeof s !== 'string') throw new TypeError('utf8String needs a string');
  return tlv(0x0c, Buffer.from(s, 'utf8'));
}

function ia5String(s) {
  if (typeof s !== 'string') throw new TypeError('ia5String needs a string');
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(s)) throw new RangeError('ia5String is ASCII only');
  return tlv(0x16, Buffer.from(s, 'ascii'));
}

function time(date) {
  if (!(date instanceof Date)) throw new TypeError('time needs a Date');
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid Date');
  const d = new Date(Math.floor(date.getTime() / 1000) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const year = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${p(year % 100)}${rest}`, 'ascii'));
  return tlv(0x18, Buffer.from(`${p(year, 4)}${rest}`, 'ascii'));
}

function explicit(n, inner) {
  assertTagNumber(n);
  return tlv(0xa0 | n, inner);
}

function implicitPrimitive(n, content) {
  assertTagNumber(n);
  return tlv(0x80 | n, content);
}

function implicitConstructed(n, parts) {
  assertTagNumber(n);
  return tlv(0xa0 | n, concatParts(parts));
}

module.exports = {
  tlv, lengthOctets, sequence, set, integer, boolean, oid, octetString, bitString,
  utf8String, ia5String, time, explicit, implicitPrimitive, implicitConstructed,
};
