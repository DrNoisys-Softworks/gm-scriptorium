'use strict';
// C2 stub.
module.exports = {
  AUDIT_KEYS: Object.freeze([]),
  sanitize: () => ({}),
  browserFamily: () => 'other',
  createAuditLog: () => ({
    file: '',
    append: () => undefined,
    writable: () => false,
    read: () => ({ entries: [], truncated: false, malformed: 0 }),
    prune: () => undefined,
    health: () => ({ ok: false, lastError: null }),
  }),
};
