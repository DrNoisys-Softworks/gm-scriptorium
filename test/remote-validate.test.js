'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../src/setup/validate');
const { ConfigError } = require('../src/util/errors');

/*
 * V1.5a (SD-a2): the four remote-access validators in src/setup/validate.js, shared with V7.
 */

function refuses(fn, messagePart) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err && err.constructor && err.constructor.name}`);
    assert.ok(err.message.includes(messagePart), `"${err.message}" should include "${messagePart}"`);
    return true;
  });
}

test('validatePort accepts 1 and 65535, as a number or a digit string', () => {
  assert.equal(v.validatePort(1), 1);
  assert.equal(v.validatePort('65535'), 65535);
  assert.equal(v.validatePort('7400'), 7400);
});

test('validatePort refuses 0, 65536, junk and non-whole numbers, naming the label', () => {
  for (const bad of [0, '0', 65536, '65536', '12.5', 12.5, '', ' 80', '80 ', '1e3', '-1', 'abc', null, undefined, true, '000001']) {
    refuses(() => v.validatePort(bad, '--port'), '--port must be a whole number from 1 to 65535');
  }
});

test('validateIpLiteral returns the canonical form and refuses names, ports, prefixes and zones', () => {
  assert.equal(v.validateIpLiteral('192.0.2.42'), '192.0.2.42');
  assert.equal(v.validateIpLiteral('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(v.validateIpLiteral('::ffff:198.51.100.20'), '198.51.100.20');
  assert.equal(v.validateIpLiteral('0.0.0.0'), '0.0.0.0');
  for (const bad of ['', 'example.test', '192.0.2.42:80', '192.0.2.0/24', 'fe80::1%eth0', '*', 42, null]) {
    refuses(() => v.validateIpLiteral(bad), 'is not an IP address');
  }
});

test('validateExternalUrl stores the origin: host lowercased, default port dropped, trailing slash allowed', () => {
  assert.equal(v.validateExternalUrl('https://Scriptorium.Home.Arpa'), 'https://scriptorium.home.arpa');
  assert.equal(v.validateExternalUrl('https://scriptorium.home.arpa/'), 'https://scriptorium.home.arpa');
  assert.equal(v.validateExternalUrl('https://scriptorium.home.arpa:443'), 'https://scriptorium.home.arpa');
  assert.equal(v.validateExternalUrl('https://panel-host.example-tailnet.ts.net:8443'), 'https://panel-host.example-tailnet.ts.net:8443');
  assert.equal(v.validateExternalUrl('https://192.0.2.42:7400'), 'https://192.0.2.42:7400');
  assert.equal(v.validateExternalUrl('https://[2001:db8::1]:7400'), 'https://[2001:db8::1]:7400');
});

test('validateExternalUrl refuses http:// with the exact FR-07 message', () => {
  assert.throws(() => v.validateExternalUrl('http://scriptorium.home.arpa'), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.message, 'remote access needs HTTPS: http://scriptorium.home.arpa');
    return true;
  });
  refuses(() => v.validateExternalUrl('ftp://scriptorium.home.arpa'), 'remote access needs HTTPS: ftp://scriptorium.home.arpa');
});

test('validateExternalUrl refuses credentials, paths, queries, fragments, trailing dots and junk', () => {
  refuses(() => v.validateExternalUrl('https://user:pw@scriptorium.home.arpa'), 'must not carry a user name');
  refuses(() => v.validateExternalUrl('https://scriptorium.home.arpa/admin'), 'no path, query or fragment');
  refuses(() => v.validateExternalUrl('https://scriptorium.home.arpa/?x=1'), 'no path, query or fragment');
  refuses(() => v.validateExternalUrl('https://scriptorium.home.arpa/#x'), 'no path, query or fragment');
  refuses(() => v.validateExternalUrl('https://scriptorium.home.arpa./'), 'trailing dot');
  refuses(() => v.validateExternalUrl('not a url'), 'is not a web address');
  refuses(() => v.validateExternalUrl(''), 'must be a web address');
  refuses(() => v.validateExternalUrl(undefined), 'must be a web address');
});

test('validateExternalUrl refuses every loopback and unspecified form, so the two request kinds never overlap', () => {
  for (const bad of [
    'https://localhost',
    'https://LOCALHOST:7400',
    'https://panel.localhost',
    'https://127.0.0.1',
    'https://127.1.2.3:7400',
    'https://2130706433', // the URL parser turns this into 127.0.0.1
    'https://[::1]',
    'https://[::]',
    'https://0.0.0.0',
    'https://[::ffff:127.0.0.1]',
  ]) {
    refuses(() => v.validateExternalUrl(bad), "loopback name or address");
  }
});

test('validatePanelPassword: 12 code points minimum, 1024 maximum, NFC result', () => {
  assert.equal(v.validatePanelPassword('abcdefghijkl'), 'abcdefghijkl');
  refuses(() => v.validatePanelPassword('abcdefghijk'), 'the panel password must be at least 12 characters');
  assert.equal(v.validatePanelPassword('a'.repeat(1024)).length, 1024);
  refuses(() => v.validatePanelPassword('a'.repeat(1025)), 'the panel password must be at most 1024 characters');
  refuses(() => v.validatePanelPassword(12345678901234), 'must be text');
  refuses(() => v.validatePanelPassword(undefined), 'must be text');
});

test('validatePanelPassword counts code points after NFC, and returns the NFC form', () => {
  // 11 ASCII letters + one decomposed e-acute (e + U+0301) is 12 code points after NFC (the pair
  // composes to one), so it passes; the raw string has 13 UTF-16 units.
  const decomposed = 'abcdefghijk' + 'é';
  assert.equal(decomposed.length, 13);
  const out = v.validatePanelPassword(decomposed);
  assert.equal(out, 'abcdefghijké');
  // Eleven letters plus an astral emoji: 12 code points (13 UTF-16 units) passes.
  assert.equal(v.validatePanelPassword('abcdefghijk\u{1F600}'), 'abcdefghijk\u{1F600}');
  // Ten letters plus a decomposed pair: 11 code points after NFC, so it fails even though it is 12 units.
  refuses(() => v.validatePanelPassword('abcdefghij' + 'é'), 'at least 12');
});
