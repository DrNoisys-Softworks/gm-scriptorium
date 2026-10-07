'use strict';
// STUB (C1): every export present, every function returns a wrong value.
const e = () => ({});
module.exports = {
  DEFAULT_DAYS: 0, MAX_DAYS: 0, BACKDATE_MS: 0, OIDS: Object.freeze({}),
  ext: {
    basicConstraints: e, keyUsage: e, extKeyUsageServerAuth: e, subjectAltName: e,
    nameConstraints: e, subjectKeyIdentifier: e, authorityKeyIdentifier: e,
  },
  buildName: () => Buffer.alloc(0), buildCertificate: () => ({ der: Buffer.alloc(0), pem: '' }),
  toPem: () => '', normaliseNames: () => ({ dnsNames: [], ipAddresses: [] }),
  generateCertificatePair: () => ({}),
};
