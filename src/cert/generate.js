'use strict';

/*
 * In-house X.509 generation for remote access (ADR 0029 section 10): a name-constrained
 * trust certificate plus a server certificate signed by it, with the trust key discarded
 * in memory. Node can parse certificates but not create them, so the structure is encoded
 * by ./der.js and signed with node:crypto. Requires only node:crypto, ../util/errors and
 * ./der: no network builtin, no dependency.
 *
 * The trust private key is a block-local variable inside generateCertificatePair. It is
 * never exported, returned, stored, logged or passed anywhere except buildCertificate's
 * signingKey argument for the two certificates it signs.
 */
const crypto = require('node:crypto');
const der = require('./der');
const { ConfigError } = require('../util/errors');

const DEFAULT_DAYS = 820;
const MAX_DAYS = 825;
const BACKDATE_MS = 3600000;

const OIDS = Object.freeze({
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  nameConstraints: '2.5.29.30',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
});

// GeneralName context tags (RFC 5280): dNSName [2], iPAddress [7].
const GN_DNS = 2;
const GN_IP = 7;

function dnsGeneralName(name) {
  return der.implicitPrimitive(GN_DNS, Buffer.from(name, 'ascii'));
}

const ext = {
  basicConstraints({ ca, pathLen } = {}) {
    // cA DEFAULT FALSE is omitted when false (DER); pathLen only with cA.
    const parts = ca ? [der.boolean(true)] : [];
    if (ca && pathLen !== undefined) parts.push(der.integer(pathLen));
    return { oid: OIDS.basicConstraints, critical: true, value: der.sequence(parts) };
  },

  keyUsage({ digitalSignature = false, keyCertSign = false } = {}) {
    // Named bits: digitalSignature(0), keyCertSign(5). DER drops trailing zero bits.
    let byte = 0;
    let lastBit = 0;
    if (digitalSignature) byte |= 0x80;
    if (keyCertSign) {
      byte |= 0x04;
      lastBit = 5;
    }
    if (byte === 0) throw new RangeError('keyUsage needs at least one bit');
    return { oid: OIDS.keyUsage, critical: true, value: der.bitString(Buffer.from([byte]), 7 - lastBit) };
  },

  extKeyUsageServerAuth() {
    return { oid: OIDS.extKeyUsage, critical: false, value: der.sequence([der.oid(OIDS.serverAuth)]) };
  },

  subjectAltName({ dnsNames = [], ipAddresses = [] } = {}) {
    const parts = [
      ...dnsNames.map(dnsGeneralName),
      ...ipAddresses.map((ip) => der.implicitPrimitive(GN_IP, ip)),
    ];
    return { oid: OIDS.subjectAltName, critical: false, value: der.sequence(parts) };
  },

  nameConstraints({ dnsNames = [], ipAddresses = [] } = {}) {
    // permittedSubtrees [0]; each GeneralSubtree is SEQUENCE { base } (minimum DEFAULT 0 omitted).
    // An iPAddress constraint is address plus an all-ones mask: 8 bytes for IPv4, 32 for IPv6.
    const subtrees = [
      ...dnsNames.map((n) => der.sequence([dnsGeneralName(n)])),
      ...ipAddresses.map((ip) => der.sequence([der.implicitPrimitive(GN_IP, Buffer.concat([ip, Buffer.alloc(ip.length, 0xff)]))])),
    ];
    return { oid: OIDS.nameConstraints, critical: true, value: der.sequence([der.implicitConstructed(0, subtrees)]) };
  },

  subjectKeyIdentifier(spkiDer) {
    const keyId = crypto.createHash('sha256').update(spkiDer).digest().subarray(0, 20);
    return { oid: OIDS.subjectKeyIdentifier, critical: false, value: der.octetString(keyId) };
  },

  authorityKeyIdentifier(keyId) {
    return { oid: OIDS.authorityKeyIdentifier, critical: false, value: der.sequence([der.implicitPrimitive(0, keyId)]) };
  },
};

/** attrs: [{ type: dotted-oid, value: string }], one RDN each, in order. */
function buildName(attrs) {
  return der.sequence(attrs.map(({ type, value }) => der.set([der.sequence([der.oid(type), der.utf8String(value)])])));
}

function toPem(derBuf, label) {
  const lines = derBuf.toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function encodeExtension({ oid, critical, value }) {
  // critical DEFAULT FALSE: only encoded when true (Chromium's verifier rejects non-DER).
  return der.sequence([der.oid(oid), ...(critical ? [der.boolean(true)] : []), der.octetString(value)]);
}

/**
 * Low-level builder, exported so a test can build a hostile certificate under a CA it controls.
 * serial: Buffer (unsigned big-endian). issuer/subject: DER Names from buildName.
 * extensions: array of { oid, critical, value } from ext.*. signingKey: KeyObject (P-256).
 */
function buildCertificate({ serial, issuer, subject, notBefore, notAfter, spkiDer, extensions, signingKey }) {
  const sigAlg = der.sequence([der.oid(OIDS.ecdsaWithSHA256)]);
  const tbs = der.sequence([
    der.explicit(0, der.integer(2)),
    der.integer(serial),
    sigAlg,
    issuer,
    der.sequence([der.time(notBefore), der.time(notAfter)]),
    subject,
    spkiDer,
    der.explicit(3, der.sequence(extensions.map(encodeExtension))),
  ]);
  const signature = crypto.sign('sha256', tbs, { key: signingKey, dsaEncoding: 'der' });
  const certDer = der.sequence([tbs, sigAlg, der.bitString(signature)]);
  return { der: certDer, pem: toPem(certDer, 'CERTIFICATE') };
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function normaliseDns(raw) {
  if (typeof raw !== 'string') throw new ConfigError('a certificate name must be a string');
  if (raw.includes('*')) throw new ConfigError(`wildcard certificate names are not supported: ${raw}`);
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(raw)) throw new ConfigError(`certificate names must be ASCII (use the punycode form): ${raw}`);
  const name = raw.toLowerCase();
  if (name.length === 0 || name.length > 253) throw new ConfigError(`certificate name has an invalid length: ${raw}`);
  for (const label of name.split('.')) {
    if (label.length < 1 || label.length > 63 || !LABEL_RE.test(label)) {
      throw new ConfigError(`certificate name is not a valid host name (letters, digits and hyphens; no trailing dot): ${raw}`);
    }
  }
  return name;
}

/** ipAddresses are 4- or 16-byte Buffers (the caller converts). Adds localhost and 127.0.0.1. */
function normaliseNames({ dnsNames = [], ipAddresses = [] } = {}) {
  const dns = [];
  for (const raw of [...dnsNames, 'localhost']) {
    const name = normaliseDns(raw);
    if (!dns.includes(name)) dns.push(name);
  }
  const ips = [];
  for (const ip of [...ipAddresses, Buffer.from([127, 0, 0, 1])]) {
    if (!Buffer.isBuffer(ip) || (ip.length !== 4 && ip.length !== 16)) {
      throw new ConfigError('an IP address must be a 4-byte (IPv4) or 16-byte (IPv6) buffer');
    }
    if (!ips.some((seen) => seen.equals(ip))) ips.push(Buffer.from(ip));
  }
  return { dnsNames: dns, ipAddresses: ips };
}

function serialBytes(randomBytes) {
  const b = Buffer.from(randomBytes(16));
  b[0] = (b[0] & 0x7f) | 0x40;
  return b;
}

function generateCertificatePair({ dnsNames, ipAddresses, days = DEFAULT_DAYS, now = Date.now(), randomBytes = crypto.randomBytes } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new ConfigError(`certificate validity must be a whole number of days from 1 to ${MAX_DAYS}`);
  }
  const names = normaliseNames({ dnsNames, ipAddresses });
  const notBefore = new Date(Math.floor(now / 1000) * 1000 - BACKDATE_MS);
  const notAfter = new Date(notBefore.getTime() + days * 86400000 - 1000);
  const org = { type: OIDS.organizationName, value: 'GM-Scriptorium' };

  const leafKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leafSpki = leafKeys.publicKey.export({ type: 'spki', format: 'der' });
  let trust;
  let leaf;
  {
    // The trust key lives only inside this block.
    const trustKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const trustSpki = trustKeys.publicKey.export({ type: 'spki', format: 'der' });
    const trustName = buildName([org, { type: OIDS.commonName, value: `GM-Scriptorium panel trust ${randomBytes(4).toString('hex')}` }]);
    const trustSki = ext.subjectKeyIdentifier(trustSpki);
    trust = buildCertificate({
      serial: serialBytes(randomBytes),
      issuer: trustName,
      subject: trustName,
      notBefore,
      notAfter,
      spkiDer: trustSpki,
      extensions: [
        ext.basicConstraints({ ca: true, pathLen: 0 }),
        ext.keyUsage({ keyCertSign: true }),
        ext.nameConstraints(names),
        trustSki,
      ],
      signingKey: trustKeys.privateKey,
    });
    leaf = buildCertificate({
      serial: serialBytes(randomBytes),
      issuer: trustName,
      subject: buildName([org]),
      notBefore,
      notAfter,
      spkiDer: leafSpki,
      extensions: [
        ext.basicConstraints({ ca: false }),
        ext.keyUsage({ digitalSignature: true }),
        ext.extKeyUsageServerAuth(),
        ext.subjectAltName(names),
        ext.authorityKeyIdentifier(crypto.createHash('sha256').update(trustSpki).digest().subarray(0, 20)),
      ],
      signingKey: trustKeys.privateKey,
    });
  }

  return {
    keyPem: leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    leafPem: leaf.pem,
    trustPem: trust.pem,
    leafDer: leaf.der,
    trustDer: trust.der,
    notBefore,
    notAfter,
    dnsNames: names.dnsNames,
    ipAddresses: names.ipAddresses,
  };
}

module.exports = {
  DEFAULT_DAYS, MAX_DAYS, BACKDATE_MS, OIDS, ext, buildName, buildCertificate, toPem,
  normaliseNames, generateCertificatePair,
};
