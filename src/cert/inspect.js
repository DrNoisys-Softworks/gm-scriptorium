'use strict';
// STUB (C1): every export present, every function returns a wrong value.
module.exports = {
  EXPIRY_WARNING_DAYS: 0,
  fingerprint: () => '',
  splitPem: () => ({ certificates: [], privateKeys: [], encryptedKeys: 0 }),
  inspectPair: () => ({ ok: true }),
  checkTrustChain: () => true,
};
