'use strict';

/*
 * src/cert/inspect.js against fixtures made by the openssl CLI (test/fixtures/tls).
 * Expected values come from openssl itself or from literals, never from src/cert.
 *
 * Tests that pass today and prove nothing (named so a Reviewer can refuse them):
 *  - anything that only checks PEM text shape;
 *  - a fingerprint compared with our own fingerprint() alone (every comparison here
 *    is against openssl or an independent createHash over the decoded base64).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const inspect = require('../src/cert/inspect');

const FIX = path.join(__dirname, 'fixtures', 'tls');
const read = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const NOW = Date.parse('2027-01-01T00:00:00Z');
const DAY = 86400000;

function derOfFirst(pemText) {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pemText);
  return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
}
const colonHex = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase().match(/../g).join(':');
const opensslFp = (file) =>
  execFileSync('openssl', ['x509', '-in', path.join(FIX, file), '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' })
    .trim().split('=')[1];
const opensslEnd = (file) =>
  Date.parse(execFileSync('openssl', ['x509', '-in', path.join(FIX, file), '-noout', '-enddate'], { encoding: 'utf8' }).trim().split('=')[1]);

const REQUIRED = { requiredDnsNames: ['scriptorium.home.arpa', 'preview.scriptorium.home.arpa', 'localhost'], requiredIps: ['192.0.2.42', '127.0.0.1'] };

test('fingerprint: uppercase colon hex of SHA-256, equals openssl and an independent hash', () => {
  const der = derOfFirst(read('ec-leaf.pem'));
  const fp = inspect.fingerprint(der);
  assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(fp, opensslFp('ec-leaf.pem'));
  assert.equal(fp, colonHex(der));
});

test('splitPem: counts certificates, plain keys and encrypted keys', () => {
  const s = inspect.splitPem(read('chain-leaf.pem') + read('chain-leaf.key') + read('encrypted.key'));
  assert.equal(s.certificates.length, 2);
  assert.equal(s.privateKeys.length, 1);
  assert.equal(s.encryptedKeys, 1);
  assert.match(s.certificates[0], /^-----BEGIN CERTIFICATE-----/);
  assert.match(s.certificates[1], /-----END CERTIFICATE-----$/);
  assert.deepEqual(inspect.splitPem(''), { certificates: [], privateKeys: [], encryptedKeys: 0 });
  const legacy = '-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\nBBBB\n-----END RSA PRIVATE KEY-----';
  assert.equal(inspect.splitPem(legacy).privateKeys.length, 2);
});

test('inspectPair accepts the EC leaf and reports fingerprint, dates and SAN', () => {
  const r = inspect.inspectPair({ certPemText: read('ec-leaf.pem'), keyPemText: read('ec-leaf.key'), now: NOW, ...REQUIRED });
  assert.equal(r.ok, true);
  assert.equal(r.leafFingerprint, opensslFp('ec-leaf.pem'));
  assert.equal(r.chainTopFingerprint, null);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.subjectAltName.includes('DNS:scriptorium.home.arpa'));
  assert.ok(r.subjectAltName.includes('IP Address:192.0.2.42'));
  const end = opensslEnd('ec-leaf.pem');
  assert.equal(Date.parse(r.notAfter), end);
  assert.equal(r.expiresInDays, Math.floor((end - NOW) / DAY));
});

test('inspectPair accepts the RSA leaf', () => {
  const r = inspect.inspectPair({ certPemText: read('rsa-leaf.pem'), keyPemText: read('rsa-leaf.key'), now: NOW, ...REQUIRED });
  assert.equal(r.ok, true);
  assert.equal(r.leafFingerprint, opensslFp('rsa-leaf.pem'));
});

test('inspectPair accepts a chain; chainTopFingerprint is the intermediate DER hash', () => {
  const r = inspect.inspectPair({ certPemText: read('chain-leaf.pem'), keyPemText: read('chain-leaf.key'), now: NOW, ...REQUIRED });
  assert.equal(r.ok, true);
  const intermediate = colonHex(derOfFirst(read('intermediate.pem')));
  assert.equal(r.chainTopFingerprint, intermediate);
  assert.equal(r.chainTopFingerprint, opensslFp('intermediate.pem'));
  assert.notEqual(r.leafFingerprint, r.chainTopFingerprint);
});

test('inspectPair: one failure reason per case', () => {
  const base = { now: NOW, ...REQUIRED };
  const cases = [
    ['no-certificate', { certPemText: '', keyPemText: read('ec-leaf.key') }],
    ['no-certificate', { certPemText: read('ec-leaf.key'), keyPemText: read('ec-leaf.key') }],
    ['bad-certificate', { certPemText: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', keyPemText: read('ec-leaf.key') }],
    ['no-key', { certPemText: read('ec-leaf.pem'), keyPemText: '' }],
    ['encrypted-key', { certPemText: read('ec-leaf.pem'), keyPemText: read('encrypted.key') }],
    ['bad-key', { certPemText: read('ec-leaf.pem'), keyPemText: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }],
    ['key-mismatch', { certPemText: read('ec-leaf.pem'), keyPemText: read('mismatch.key') }],
    ['key-mismatch', { certPemText: read('ec-leaf.pem'), keyPemText: read('rsa-leaf.key') }],
    ['expired', { certPemText: read('expired-leaf.pem'), keyPemText: read('expired-leaf.key') }],
    ['not-yet-valid', { certPemText: read('ec-leaf.pem'), keyPemText: read('ec-leaf.key'), now: Date.parse('2020-06-01T00:00:00Z') }],
    ['name-missing', { certPemText: read('wrong-san-leaf.pem'), keyPemText: read('wrong-san-leaf.key') }],
  ];
  for (const [reason, args] of cases) {
    const r = inspect.inspectPair({ ...base, ...args });
    assert.equal(r.ok, false, `${reason} should fail`);
    assert.equal(r.reason, reason, JSON.stringify(r));
    assert.equal(typeof r.detail, 'string');
  }
});

test('expired and not-yet-valid details name the date', () => {
  const e = inspect.inspectPair({ certPemText: read('expired-leaf.pem'), keyPemText: read('expired-leaf.key'), now: NOW });
  assert.ok(e.detail.includes('2020-02-01'), e.detail);
  const n = inspect.inspectPair({ certPemText: read('ec-leaf.pem'), keyPemText: read('ec-leaf.key'), now: Date.parse('2020-06-01T00:00:00Z') });
  assert.ok(n.detail.includes('2026-10-03'), n.detail);
});

test('wrong-SAN sibling certificate refuses the real names (string-prefix controls)', () => {
  const args = { certPemText: read('wrong-san-leaf.pem'), keyPemText: read('wrong-san-leaf.key'), now: NOW };
  const dns = inspect.inspectPair({ ...args, requiredDnsNames: ['scriptorium.home.arpa'] });
  assert.equal(dns.reason, 'name-missing');
  assert.equal(dns.detail.includes('scriptorium.home.arpa'), true);
  const ip = inspect.inspectPair({ ...args, requiredIps: ['192.0.2.42'] });
  assert.equal(ip.reason, 'name-missing');
  assert.equal(ip.detail.includes('192.0.2.42'), true);
  // positive control: the names it really has are accepted
  const ok = inspect.inspectPair({ ...args, requiredDnsNames: ['scriptorium.home.arpa.example'], requiredIps: ['192.0.2.43'] });
  assert.equal(ok.ok, true);
});

test('wildcards are never partial matches; subject CN is not consulted', () => {
  const r = inspect.inspectPair({ certPemText: read('ec-leaf.pem'), keyPemText: read('ec-leaf.key'), now: NOW, requiredDnsNames: ['evil.example'] });
  assert.equal(r.reason, 'name-missing');
  assert.equal(r.detail.includes('evil.example'), true);
});

test('expiry warning at 30 days or fewer, none at 31', () => {
  const end = opensslEnd('ec-leaf.pem');
  const args = { certPemText: read('ec-leaf.pem'), keyPemText: read('ec-leaf.key') };
  const at30 = inspect.inspectPair({ ...args, now: end - 30 * DAY });
  assert.equal(at30.ok, true);
  assert.deepEqual(at30.warnings, [{ type: 'expiring', days: 30 }]);
  const at10 = inspect.inspectPair({ ...args, now: end - 10 * DAY - 1000 });
  assert.deepEqual(at10.warnings, [{ type: 'expiring', days: 10 }]);
  const at31 = inspect.inspectPair({ ...args, now: end - 31 * DAY });
  assert.deepEqual(at31.warnings, []);
  assert.equal(inspect.EXPIRY_WARNING_DAYS, 30);
});

test('checkTrustChain: right issuer true, wrong issuer false, garbage false', () => {
  assert.equal(inspect.checkTrustChain(read('ec-leaf.pem'), read('ca.pem')), true);
  assert.equal(inspect.checkTrustChain(read('rsa-leaf.pem'), read('ca.pem')), true);
  assert.equal(inspect.checkTrustChain(read('ec-leaf.pem'), read('intermediate.pem')), false);
  assert.equal(inspect.checkTrustChain(read('chain-leaf.pem'), read('intermediate.pem')), true);
  assert.equal(inspect.checkTrustChain(read('chain-leaf.pem'), read('ca.pem')), false);
  assert.equal(inspect.checkTrustChain('garbage', read('ca.pem')), false);
});

test('openssl agrees with the fixture verdicts (oracle independence)', () => {
  const v = (leaf, extra = []) => {
    try {
      execFileSync('openssl', ['verify', '-CAfile', path.join(FIX, 'ca.pem'), ...extra, path.join(FIX, leaf)], { stdio: 'pipe' });
      return true;
    } catch { return false; }
  };
  assert.equal(v('ec-leaf.pem'), true);
  assert.equal(v('expired-leaf.pem'), false);
  assert.equal(v('chain-leaf.pem', ['-untrusted', path.join(FIX, 'intermediate.pem')]), true);
});
