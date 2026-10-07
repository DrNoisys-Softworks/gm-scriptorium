'use strict';

/*
 * src/cert/generate.js. The oracle is independent of our code: crypto.X509Certificate,
 * the openssl CLI (a missing openssl is a failure, not a skip), and real TLS sockets.
 * Expected values are literals or hand-computed here; nothing is read back through
 * src/cert's own parsing.
 *
 * Ports 8060-8069 (one per TLS case, run in file order; node --test runs files in parallel).
 *
 * Tests that pass today and prove nothing (so a Reviewer can refuse them as evidence):
 *  - PEM text shape checks (BEGIN/END lines, base64), used here only as a precondition;
 *  - fingerprint() compared with itself;
 *  - a serial-uniqueness test with an injected randomBytes (it proves the stub, so the
 *    uniqueness test below uses two real generations);
 *  - any rejectUnauthorized:false connection (none here).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { X509Certificate, createPrivateKey, createHash, generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const gen = require('../src/cert/generate');
const inspect = require('../src/cert/inspect');
const der = require('../src/cert/der');
const { ConfigError } = require('../src/util/errors');

const DAY = 86400000;
const NOW = Date.parse('2027-01-01T00:00:00Z');
const IP4 = (s) => Buffer.from(s.split('.').map(Number));
const IPV6_DOC = Buffer.from('20010db8000000000000000000000001', 'hex'); // 2001:db8::1
const NAMES = { dnsNames: ['scriptorium.home.arpa', 'preview.scriptorium.home.arpa'], ipAddresses: [IP4('192.0.2.42')] };
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

const openssl = (args, input) => execFileSync('openssl', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cert-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
};

// Lazy, so a broken generator fails each test with its own assertion rather than at load.
let memo = null;
const fixture = () => {
  if (!memo) {
    const pair = gen.generateCertificatePair({ ...NAMES });
    memo = { pair, leaf: new X509Certificate(pair.leafPem), trust: new X509Certificate(pair.trustPem) };
  }
  return memo;
};

test('openssl is present (a gate failure, not a skip)', () => {
  assert.match(openssl(['version']), /^OpenSSL 3\./);
});

test('constants and OIDS', () => {
  assert.equal(gen.DEFAULT_DAYS, 820);
  assert.equal(gen.MAX_DAYS, 825);
  assert.equal(gen.BACKDATE_MS, 3600000);
  assert.equal(Object.isFrozen(gen.OIDS), true);
  assert.deepEqual(
    { ...gen.OIDS },
    {
      ecdsaWithSHA256: '1.2.840.10045.4.3.2', commonName: '2.5.4.3', organizationName: '2.5.4.10',
      basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', serverAuth: '1.3.6.1.5.5.7.3.1',
      subjectAltName: '2.5.29.17', nameConstraints: '2.5.29.30', subjectKeyIdentifier: '2.5.29.14', authorityKeyIdentifier: '2.5.29.35',
    },
  );
});

test('ext.* builders: DER values and criticality match the table byte for byte', () => {
  const bcCa = gen.ext.basicConstraints({ ca: true, pathLen: 0 });
  assert.deepEqual(bcCa.value, hex('30 06 01 01 FF 02 01 00'));
  assert.equal(bcCa.critical, true);
  assert.equal(bcCa.oid, '2.5.29.19');
  const bcLeaf = gen.ext.basicConstraints({ ca: false });
  assert.deepEqual(bcLeaf.value, hex('30 00'));
  assert.equal(bcLeaf.critical, true);
  assert.deepEqual(gen.ext.keyUsage({ keyCertSign: true }).value, hex('03 02 02 04'));
  assert.deepEqual(gen.ext.keyUsage({ digitalSignature: true }).value, hex('03 02 07 80'));
  assert.deepEqual(gen.ext.keyUsage({ digitalSignature: true, keyCertSign: true }).value, hex('03 02 02 84'));
  assert.equal(gen.ext.keyUsage({ keyCertSign: true }).critical, true);
  const eku = gen.ext.extKeyUsageServerAuth();
  assert.deepEqual(eku.value, hex('30 0A 06 08 2B 06 01 05 05 07 03 01'));
  assert.equal(eku.critical, false);
  const san = gen.ext.subjectAltName({ dnsNames: ['a.b'], ipAddresses: [IP4('192.0.2.42')] });
  assert.deepEqual(san.value, hex('30 0B 82 03 61 2E 62 87 04 C0 00 02 2A'));
  assert.equal(san.critical, false);
  const nc = gen.ext.nameConstraints({ dnsNames: ['a.b'], ipAddresses: [IP4('192.0.2.42')] });
  assert.deepEqual(nc.value, hex('30 15 A0 13 30 05 82 03 61 2E 62 30 0A 87 08 C0 00 02 2A FF FF FF FF'));
  assert.equal(nc.critical, true);
  const aki = gen.ext.authorityKeyIdentifier(Buffer.alloc(20, 0xaa));
  assert.deepEqual(aki.value, Buffer.concat([hex('30 16 80 14'), Buffer.alloc(20, 0xaa)]));
  assert.equal(aki.critical, false);
  // SKI = first 20 bytes of SHA-256 over the SPKI, as an OCTET STRING (04 14 ...)
  const spki = Buffer.from('0123456789', 'hex');
  const ski = gen.ext.subjectKeyIdentifier(spki);
  assert.deepEqual(ski.value, Buffer.concat([hex('04 14'), createHash('sha256').update(spki).digest().subarray(0, 20)]));
  assert.equal(ski.critical, false);
});

test('ext.nameConstraints: IPv4 constraint is 8 bytes, IPv6 is 32', () => {
  const v4 = gen.ext.nameConstraints({ dnsNames: [], ipAddresses: [IP4('192.0.2.42')] }).value;
  assert.deepEqual(v4, hex('30 0E A0 0C 30 0A 87 08 C0 00 02 2A FF FF FF FF'));
  const v6 = gen.ext.nameConstraints({ dnsNames: [], ipAddresses: [IPV6_DOC] }).value;
  const expected = Buffer.concat([hex('30 26 A0 24 30 22 87 20'), IPV6_DOC, Buffer.alloc(16, 0xff)]);
  assert.deepEqual(v6, expected);
});

test('normaliseNames: always adds localhost and 127.0.0.1, lowercases, dedupes', () => {
  const n = gen.normaliseNames({ dnsNames: ['Scriptorium.Home.ARPA', 'scriptorium.home.arpa'], ipAddresses: [IP4('192.0.2.42'), IP4('192.0.2.42')] });
  assert.deepEqual(n.dnsNames, ['scriptorium.home.arpa', 'localhost']);
  assert.deepEqual(n.ipAddresses.map((b) => [...b].join('.')), ['192.0.2.42', '127.0.0.1']);
  const empty = gen.normaliseNames({});
  assert.deepEqual(empty.dnsNames, ['localhost']);
  assert.equal(empty.ipAddresses.length, 1);
  const again = gen.normaliseNames({ dnsNames: ['localhost'], ipAddresses: [IP4('127.0.0.1')] });
  assert.deepEqual(again.dnsNames, ['localhost']);
  assert.equal(again.ipAddresses.length, 1);
  assert.equal(gen.normaliseNames({ ipAddresses: [IPV6_DOC] }).ipAddresses.length, 2);
});

test('normaliseNames: refuses wildcards, non-ASCII, bad LDH, bad IP', () => {
  const bad = [
    { dnsNames: ['*.example'] }, { dnsNames: ['\u00e9.example'] }, { dnsNames: ['-a.example'] }, { dnsNames: ['a-.example'] },
    { dnsNames: ['a..example'] }, { dnsNames: ['example.'] }, { dnsNames: ['a_b.example'] }, { dnsNames: [''] },
    { dnsNames: [`${'a'.repeat(64)}.example`] }, { dnsNames: [`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`] },
    { dnsNames: [7] },
    { ipAddresses: [Buffer.alloc(5)] }, { ipAddresses: [Buffer.alloc(0)] }, { ipAddresses: ['192.0.2.42'] },
  ];
  for (const b of bad) assert.throws(() => gen.normaliseNames(b), ConfigError, JSON.stringify(b));
  // positive controls at the boundary
  assert.doesNotThrow(() => gen.normaliseNames({ dnsNames: [`${'a'.repeat(63)}.example`] }));
  assert.doesNotThrow(() => gen.normaliseNames({ dnsNames: [`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`] }));
});

test('generated leaf: parse-back oracle with negative controls', () => {
  const { pair, leaf, trust } = fixture();
  for (const name of ['scriptorium.home.arpa', 'preview.scriptorium.home.arpa', 'localhost']) {
    assert.equal(leaf.checkHost(name, { subject: 'never' }), name, name);
  }
  assert.equal(leaf.checkIP('192.0.2.42'), '192.0.2.42');
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
  for (const name of ['evil.example', 'scriptorium.home.arpa.example', 'xscriptorium.home.arpa', 'home.arpa']) {
    assert.equal(leaf.checkHost(name, { subject: 'never', partialWildcards: false }), undefined, name);
  }
  assert.equal(leaf.checkIP('192.0.2.43'), undefined);
  assert.equal(leaf.ca, false);
  assert.ok(leaf.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
  assert.equal(leaf.checkPrivateKey(createPrivateKey(pair.keyPem)), true);
  assert.equal(leaf.verify(trust.publicKey), true);
  assert.equal(leaf.checkIssued(trust), true);
  assert.equal(leaf.verify(leaf.publicKey), false);
  assert.equal(leaf.checkIssued(leaf), false);
  assert.equal(leaf.subject.includes('CN='), false);
  assert.equal(leaf.subject, 'O=GM-Scriptorium');
  assert.equal(leaf.publicKey.asymmetricKeyType, 'ec');
  assert.equal(leaf.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('generated trust certificate: CA, self-signed, name constrained', () => {
  const { pair, leaf, trust } = fixture();
  assert.equal(trust.ca, true);
  assert.equal(trust.verify(trust.publicKey), true);
  assert.equal(trust.checkIssued(trust), true);
  assert.match(trust.subject, /^O=GM-Scriptorium\nCN=GM-Scriptorium panel trust [0-9a-f]{8}$/);
  assert.equal(trust.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.notEqual(trust.fingerprint256, leaf.fingerprint256);
  assert.equal(trust.checkPrivateKey(createPrivateKey(pair.keyPem)), false, 'the leaf key must not be the trust key');
});

test('validity: ceiling and exact window, literals computed here', () => {
  const { pair, leaf, trust } = fixture();
  const span = Date.parse(leaf.validTo) - Date.parse(leaf.validFrom);
  assert.ok(span <= 825 * 86400000 - 1000);
  assert.equal(span, 820 * 86400000 - 1000);
  const fixed = gen.generateCertificatePair({ ...NAMES, now: NOW + 999 }); // sub-second part is floored
  const f = new X509Certificate(fixed.leafPem);
  const expectedFrom = Date.UTC(2026, 11, 31, 23, 0, 0);
  assert.equal(Date.parse(f.validFrom), expectedFrom);
  assert.equal(Date.parse(f.validTo), expectedFrom + 820 * DAY - 1000);
  assert.equal(fixed.notBefore.getTime ? fixed.notBefore.getTime() : Date.parse(fixed.notBefore), expectedFrom);
  assert.equal(Date.parse(new X509Certificate(fixed.trustPem).validFrom), expectedFrom);
  assert.equal(Date.parse(new X509Certificate(fixed.trustPem).validTo), expectedFrom + 820 * DAY - 1000);
  const max = new X509Certificate(gen.generateCertificatePair({ ...NAMES, days: 825, now: NOW }).leafPem);
  assert.equal(Date.parse(max.validTo) - Date.parse(max.validFrom), 825 * DAY - 1000);
  const one = new X509Certificate(gen.generateCertificatePair({ ...NAMES, days: 1, now: NOW }).leafPem);
  assert.equal(Date.parse(one.validTo) - Date.parse(one.validFrom), DAY - 1000);
});

test('days outside 1-825 or non-integer is refused with the specified message', () => {
  for (const days of [0, 826, -1, 1.5, NaN, '820', 1e9]) {
    assert.throws(
      () => gen.generateCertificatePair({ ...NAMES, days }),
      (e) => e instanceof ConfigError && e.message === 'certificate validity must be a whole number of days from 1 to 825',
      String(days),
    );
  }
});

test('two real generations never share a serial, trust subject or keys', () => {
  const { pair, leaf, trust } = fixture();
  const other = gen.generateCertificatePair({ ...NAMES });
  const l2 = new X509Certificate(other.leafPem);
  const t2 = new X509Certificate(other.trustPem);
  assert.notEqual(leaf.serialNumber, l2.serialNumber);
  assert.notEqual(trust.serialNumber, t2.serialNumber);
  assert.notEqual(leaf.serialNumber, trust.serialNumber);
  assert.notEqual(trust.subject, t2.subject);
  assert.notEqual(pair.keyPem, other.keyPem);
  // 64 or more bits: 16 bytes, high byte 0x40..0x7f (so 128 bits, positive, never padded)
  for (const c of [leaf, trust, l2, t2]) {
    assert.equal(c.serialNumber.length, 32);
    const top = parseInt(c.serialNumber.slice(0, 2), 16);
    assert.ok(top >= 0x40 && top <= 0x7f, c.serialNumber);
  }
});

test('fingerprint equals node fingerprint256 and an independent SHA-256 of the DER', () => {
  const { pair, leaf, trust } = fixture();
  const independent = createHash('sha256').update(leaf.raw).digest('hex').toUpperCase().match(/../g).join(':');
  assert.equal(inspect.fingerprint(pair.leafDer), leaf.fingerprint256);
  assert.equal(leaf.fingerprint256, independent);
  assert.deepEqual(pair.leafDer, leaf.raw);
  assert.deepEqual(pair.trustDer, trust.raw);
  const fromOpenssl = openssl(['x509', '-noout', '-fingerprint', '-sha256'], pair.leafPem).trim().split('=')[1];
  assert.equal(fromOpenssl, independent);
  assert.equal(inspect.fingerprint(pair.trustDer), trust.fingerprint256);
});

test('returned shape: exactly the nine keys, so no trust key can be returned', () => {
  const { pair, leaf, trust } = fixture();
  assert.deepEqual(Object.keys(pair).sort(), ['dnsNames', 'ipAddresses', 'keyPem', 'leafDer', 'leafPem', 'notAfter', 'notBefore', 'trustDer', 'trustPem']);
  assert.equal((pair.keyPem.match(/-----BEGIN PRIVATE KEY-----/g) || []).length, 1);
  assert.equal((pair.keyPem.match(/PRIVATE KEY/g) || []).length, 2);
  assert.equal(/PRIVATE KEY/.test(pair.leafPem), false);
  assert.equal(/PRIVATE KEY/.test(pair.trustPem), false);
  assert.deepEqual(pair.dnsNames, ['scriptorium.home.arpa', 'preview.scriptorium.home.arpa', 'localhost']);
  assert.deepEqual(pair.ipAddresses.map((b) => [...b].join('.')), ['192.0.2.42', '127.0.0.1']);
  assert.ok(pair.notBefore instanceof Date && pair.notAfter instanceof Date);
});

test('openssl: verify -x509_strict, and the text dump shows the specified shape', () => {
  const { pair, leaf, trust } = fixture();
  const trustFile = write('trust.pem', pair.trustPem);
  const leafFile = write('leaf.pem', pair.leafPem);
  openssl(['verify', '-x509_strict', '-CAfile', trustFile, leafFile]); // throws on non-zero
  const t = openssl(['x509', '-noout', '-text', '-in', trustFile]);
  assert.match(t, /Signature Algorithm: ecdsa-with-SHA256/);
  assert.match(t, /ASN1 OID: prime256v1/);
  assert.match(t, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(t, /X509v3 Key Usage: critical\s+Certificate Sign\s*\n/);
  assert.match(t, /X509v3 Name Constraints: critical\s+Permitted:/);
  assert.match(t, /DNS:scriptorium\.home\.arpa/);
  assert.match(t, /DNS:preview\.scriptorium\.home\.arpa/);
  assert.match(t, /DNS:localhost/);
  assert.match(t, /IP:192\.0\.2\.42\/255\.255\.255\.255/);
  assert.match(t, /IP:127\.0\.0\.1\/255\.255\.255\.255/);
  assert.match(t, /Subject: O = GM-Scriptorium, CN = GM-Scriptorium panel trust [0-9a-f]{8}\n/);
  assert.doesNotMatch(t, /Extended Key Usage/);
  assert.doesNotMatch(t, /Subject Alternative Name/);
  const l = openssl(['x509', '-noout', '-text', '-in', leafFile]);
  assert.match(l, /Signature Algorithm: ecdsa-with-SHA256/);
  assert.match(l, /Subject: O = GM-Scriptorium\n/);
  assert.doesNotMatch(l, /Subject:.*CN\s*=/);
  assert.match(l, /X509v3 Basic Constraints: critical\s+CA:FALSE/);
  assert.match(l, /X509v3 Key Usage: critical\s+Digital Signature\s*\n/);
  assert.match(l, /X509v3 Extended Key Usage:\s+TLS Web Server Authentication\s*\n/);
  assert.match(l, /X509v3 Subject Alternative Name:\s+DNS:scriptorium\.home\.arpa, DNS:preview\.scriptorium\.home\.arpa, DNS:localhost, IP Address:192\.0\.2\.42, IP Address:127\.0\.0\.1/);
  assert.match(l, /X509v3 Authority Key Identifier:\s+[0-9A-F:]{59}\s*\n/);
  assert.doesNotMatch(l, /Name Constraints/);
  assert.doesNotMatch(l, /Subject Key Identifier/);
  // the leaf's AKI is the trust's SKI
  const aki = /Authority Key Identifier:\s+([0-9A-F:]{59})/.exec(l)[1];
  const ski = /Subject Key Identifier:\s+([0-9A-F:]{59})/.exec(t)[1];
  assert.equal(aki, ski);
});

test('openssl: window matches the hand-computed dates', () => {
  const f = gen.generateCertificatePair({ ...NAMES, now: NOW });
  const out = openssl(['x509', '-noout', '-startdate', '-enddate'], f.leafPem);
  assert.match(out, /notBefore=Dec 31 23:00:00 2026 GMT/);
  // 2026-12-31T23:00:00Z + 820 days - 1 s, computed with Date.UTC arithmetic in the test
  const end = new Date(Date.UTC(2026, 11, 31, 23, 0, 0) + 820 * DAY - 1000).toISOString();
  const m = /notAfter=(\w+)\s+(\d+) (\d\d:\d\d:\d\d) (\d{4}) GMT/.exec(out);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parsed = new Date(Date.UTC(Number(m[4]), months.indexOf(m[1]), Number(m[2]), ...m[3].split(':').map(Number)));
  assert.equal(parsed.toISOString(), end);
});

test('openssl: no non-DER artefacts (no DEFAULT-valued critical FALSE encoded)', () => {
  const { pair, leaf, trust } = fixture();
  const asn1 = (file) => execFileSync('openssl', ['asn1parse', '-inform', 'DER', '-in', file], { encoding: 'utf8' });
  const leafDer = write('leaf.der', pair.leafDer);
  const trustDer = write('trust.der', pair.trustDer);
  // BOOLEANs at extension level are exactly the critical ones: leaf BC + KU, trust BC + KU + NC.
  assert.equal((asn1(leafDer).match(/BOOLEAN/g) || []).length, 2);
  assert.equal((asn1(trustDer).match(/BOOLEAN/g) || []).length, 3);
});

test('IPv6: SAN and name constraint round trip through openssl and node', () => {
  const p = gen.generateCertificatePair({ dnsNames: ['scriptorium.home.arpa'], ipAddresses: [IPV6_DOC] });
  const l = new X509Certificate(p.leafPem);
  assert.equal(l.checkIP('2001:db8::1'), '2001:db8::1');
  assert.equal(l.checkIP('2001:db8::2'), undefined);
  const t = openssl(['x509', '-noout', '-text'], p.trustPem);
  assert.match(t, /IP:2001:DB8:0:0:0:0:0:1\/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF/);
  const trustFile = write('v6trust.pem', p.trustPem);
  const leafFile = write('v6leaf.pem', p.leafPem);
  openssl(['verify', '-x509_strict', '-CAfile', trustFile, leafFile]);
});

// ---- real TLS sockets ------------------------------------------------------------------------

function listen(port, options) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = tls.createServer(options, (s) => {
      sockets.add(s);
      s.on('error', () => {});
      s.end('ok');
    });
    server.on('tlsClientError', () => {});
    server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}); });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, sockets }));
  });
}

function connect(port, { ca, servername }) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, ca, servername, rejectUnauthorized: true }, () => {
      const authorized = s.authorized;
      s.destroy();
      resolve({ ok: true, authorized });
    });
    s.on('error', (err) => resolve({ ok: false, code: err.code, message: err.message }));
  });
}

async function withServer(t, port, options) {
  const { server, sockets } = await listen(port, options);
  t.after(() => new Promise((res) => {
    for (const s of sockets) s.destroy();
    server.close(() => res());
  }));
}

test('real TLS: generated pair authorises for each configured name, refuses others', async (t) => {
  const { pair } = fixture();
  await withServer(t, 8060, { key: pair.keyPem, cert: pair.leafPem + pair.trustPem });
  const good = await connect(8060, { ca: pair.trustPem, servername: 'scriptorium.home.arpa' });
  assert.deepEqual(good, { ok: true, authorized: true });
  assert.deepEqual(await connect(8060, { ca: pair.trustPem, servername: 'preview.scriptorium.home.arpa' }), { ok: true, authorized: true });
  assert.deepEqual(await connect(8060, { ca: pair.trustPem, servername: 'localhost' }), { ok: true, authorized: true });
  const evil = await connect(8060, { ca: pair.trustPem, servername: 'evil.example' });
  assert.equal(evil.ok, false);
  assert.equal(evil.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  const sibling = await connect(8060, { ca: pair.trustPem, servername: 'scriptorium.home.arpa.example' });
  assert.equal(sibling.ok, false);
});

test('real TLS: a different generation\'s trust certificate is refused', async (t) => {
  const { pair } = fixture();
  const other = gen.generateCertificatePair({ ...NAMES });
  await withServer(t, 8061, { key: pair.keyPem, cert: pair.leafPem + pair.trustPem });
  const r = await connect(8061, { ca: other.trustPem, servername: 'scriptorium.home.arpa' });
  assert.equal(r.ok, false);
  assert.match(r.code, /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/);
});

function hostileCa({ permitted }) {
  const caKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caSpki = caKeys.publicKey.export({ type: 'spki', format: 'der' });
  const caName = gen.buildName([{ type: gen.OIDS.organizationName, value: 'Constraint Test CA' }, { type: gen.OIDS.commonName, value: 'ca' }]);
  const ski = gen.ext.subjectKeyIdentifier(caSpki);
  const nb = new Date(Date.now() - 3600000);
  const na = new Date(Date.now() + 86400000);
  const caCert = gen.buildCertificate({
    serial: Buffer.from('4000000000000000000000000000abcd', 'hex'),
    issuer: caName, subject: caName, notBefore: nb, notAfter: na, spkiDer: caSpki,
    extensions: [
      gen.ext.basicConstraints({ ca: true, pathLen: 0 }),
      gen.ext.keyUsage({ keyCertSign: true }),
      ...(permitted ? [gen.ext.nameConstraints({ dnsNames: permitted, ipAddresses: [] })] : []),
      ski,
    ],
    signingKey: caKeys.privateKey,
  });
  const leafFor = (dns) => {
    const lk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const lc = gen.buildCertificate({
      serial: Buffer.from('4000000000000000000000000000dcba', 'hex'),
      issuer: caName,
      subject: gen.buildName([{ type: gen.OIDS.organizationName, value: 'Constraint Test Leaf' }]),
      notBefore: nb, notAfter: na, spkiDer: lk.publicKey.export({ type: 'spki', format: 'der' }),
      extensions: [
        gen.ext.basicConstraints({ ca: false }), gen.ext.keyUsage({ digitalSignature: true }), gen.ext.extKeyUsageServerAuth(),
        gen.ext.subjectAltName({ dnsNames: [dns], ipAddresses: [] }),
        gen.ext.authorityKeyIdentifier(Buffer.from(ski.value.subarray(2))),
      ],
      signingKey: caKeys.privateKey,
    });
    return { certPem: lc.pem, keyPem: lk.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  };
  return { caPem: caCert.pem, leafFor };
}

test('name constraints are enforced by the verifier (hostile leaf built with buildCertificate)', async (t) => {
  const { caPem, leafFor } = hostileCa({ permitted: ['scriptorium.home.arpa'] });
  const inside = leafFor('scriptorium.home.arpa');
  const outside = leafFor('outside.example');
  await withServer(t, 8062, { key: inside.keyPem, cert: inside.certPem + caPem });
  await withServer(t, 8063, { key: outside.keyPem, cert: outside.certPem + caPem });
  assert.deepEqual(await connect(8062, { ca: caPem, servername: 'scriptorium.home.arpa' }), { ok: true, authorized: true });
  const bad = await connect(8063, { ca: caPem, servername: 'outside.example' });
  assert.equal(bad.ok, false);
  assert.equal(bad.message, 'permitted subtree violation', JSON.stringify(bad));
  // the same hostile leaf under a CA WITHOUT constraints is accepted: the constraint is what blocks it
  const open = hostileCa({ permitted: null });
  const l2 = open.leafFor('outside.example');
  await withServer(t, 8064, { key: l2.keyPem, cert: l2.certPem + open.caPem });
  assert.deepEqual(await connect(8064, { ca: open.caPem, servername: 'outside.example' }), { ok: true, authorized: true });
  // and openssl agrees about the constrained case
  const cf = write('hc.pem', caPem);
  assert.throws(() => openssl(['verify', '-CAfile', cf, write('ho.pem', outside.certPem)]), /permitted subtree violation/i);
  openssl(['verify', '-CAfile', cf, write('hi.pem', inside.certPem)]);
});

test('buildCertificate: encodes the supplied window, serial and names', () => {
  const caKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = caKeys.publicKey.export({ type: 'spki', format: 'der' });
  const name = gen.buildName([{ type: gen.OIDS.organizationName, value: 'X' }]);
  assert.deepEqual(name, hex('30 0C 31 0A 30 08 06 03 55 04 0A 0C 01 58'));
  const c = gen.buildCertificate({
    serial: hex('80 00 00 00 00 00 00 01'), issuer: name, subject: name,
    notBefore: new Date('2049-12-31T23:59:59Z'), notAfter: new Date('2050-01-01T00:00:00Z'),
    spkiDer: spki, extensions: [gen.ext.basicConstraints({ ca: true })], signingKey: caKeys.privateKey,
  });
  const x = new X509Certificate(c.pem);
  assert.equal(x.serialNumber, '8000000000000001');
  assert.equal(Date.parse(x.validFrom), Date.parse('2049-12-31T23:59:59Z'));
  assert.equal(Date.parse(x.validTo), Date.parse('2050-01-01T00:00:00Z'));
  assert.equal(x.verify(x.publicKey), true);
  assert.deepEqual(c.der, x.raw);
  assert.equal(gen.toPem(c.der, 'CERTIFICATE'), c.pem);
  assert.match(c.pem, /^-----BEGIN CERTIFICATE-----\n/);
  assert.match(c.pem, /\n-----END CERTIFICATE-----\n$/);
  for (const line of c.pem.split('\n').slice(1, -2)) assert.ok(line.length <= 64);
  assert.ok(der.sequence([]).length === 2);
});
