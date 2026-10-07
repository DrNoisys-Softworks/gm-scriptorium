'use strict';

/*
 * Certificate and key inspection for remote access. Everything here leans on
 * crypto.X509Certificate; this module decodes no DER of its own. Requires only
 * node:crypto.
 */
const { X509Certificate, createPrivateKey, createHash } = require('node:crypto');

const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86400000;

const CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const KEY_RE = /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |RSA )?PRIVATE KEY-----/g;
const ENCRYPTED_RE = /-----BEGIN ENCRYPTED PRIVATE KEY-----/g;

/** Uppercase colon-separated SHA-256 of the certificate DER. */
function fingerprint(der) {
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

function splitPem(text) {
  const s = typeof text === 'string' ? text : '';
  return {
    certificates: s.match(CERT_RE) || [],
    privateKeys: s.match(KEY_RE) || [],
    encryptedKeys: (s.match(ENCRYPTED_RE) || []).length,
  };
}

const fail = (reason, detail) => ({ ok: false, reason, detail });
const COVER_OPTIONS = { subject: 'never', partialWildcards: false };

function inspectPair({ certPemText, keyPemText, now = Date.now(), requiredDnsNames = [], requiredIps = [] }) {
  const certs = splitPem(certPemText).certificates;
  if (certs.length === 0) return fail('no-certificate', 'no PEM certificate block found');
  let parsed;
  try {
    parsed = certs.map((c) => new X509Certificate(c));
  } catch (err) {
    return fail('bad-certificate', `the certificate could not be parsed (${err.code || err.message})`);
  }
  const leaf = parsed[0];

  const keys = splitPem(keyPemText);
  if (keys.privateKeys.length === 0) {
    if (keys.encryptedKeys > 0) return fail('encrypted-key', 'the private key is passphrase-protected; supply an unencrypted key');
    return fail('no-key', 'no PEM private key block found');
  }
  let key;
  try {
    key = createPrivateKey(keys.privateKeys[0]);
  } catch (err) {
    return fail('bad-key', `the private key could not be parsed (${err.code || err.message})`);
  }
  if (!leaf.checkPrivateKey(key)) return fail('key-mismatch', 'the private key does not belong to the certificate');

  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (now < notBefore.getTime()) return fail('not-yet-valid', `the certificate is not valid until ${notBefore.toISOString()}`);
  if (now > notAfter.getTime()) return fail('expired', `the certificate expired on ${notAfter.toISOString()}`);

  for (const name of requiredDnsNames) {
    if (leaf.checkHost(name, COVER_OPTIONS) === undefined) return fail('name-missing', name);
  }
  for (const ip of requiredIps) {
    if (leaf.checkIP(ip) === undefined) return fail('name-missing', ip);
  }

  const expiresInDays = Math.floor((notAfter.getTime() - now) / DAY_MS);
  const warnings = [];
  if (expiresInDays <= EXPIRY_WARNING_DAYS) warnings.push({ type: 'expiring', days: expiresInDays });
  return {
    ok: true,
    leafFingerprint: fingerprint(leaf.raw),
    chainTopFingerprint: parsed.length > 1 ? fingerprint(parsed[parsed.length - 1].raw) : null,
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    subjectAltName: leaf.subjectAltName || '',
    expiresInDays,
    warnings,
  };
}

/** True when `leafPem` was issued and signed by `trustPem`. */
function checkTrustChain(leafPem, trustPem) {
  try {
    const leaf = new X509Certificate(leafPem);
    const trust = new X509Certificate(trustPem);
    return leaf.checkIssued(trust) && leaf.verify(trust.publicKey);
  } catch {
    return false;
  }
}

module.exports = { EXPIRY_WARNING_DAYS, fingerprint, splitPem, inspectPair, checkTrustChain };
