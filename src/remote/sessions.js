'use strict';
// C2 stub.
module.exports = {
  SESSION_TTL_MS: 0,
  ADMIN_COOKIE: '',
  PREVIEW_COOKIE: '',
  createSessionStore: () => ({
    load: () => undefined,
    create: () => ({ credential: '', id: '', expires: 0 }),
    verify: () => null,
    revoke: () => undefined,
    revokeAll: () => ({ count: -1 }),
    activeCount: () => -1,
    health: () => ({ ok: false, error: 'not implemented' }),
  }),
};
