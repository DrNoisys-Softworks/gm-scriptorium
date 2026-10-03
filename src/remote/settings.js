'use strict';
// C2 stub.
module.exports = {
  REMOTE_MODES: Object.freeze([]),
  SETTABLE_MODES: Object.freeze([]),
  TLS_CHOICES: Object.freeze([]),
  REMOTE_KEYS: Object.freeze([]),
  parseRemoteTable: () => ({ mode: 'stub' }),
  applicableKeys: () => [],
  readiness: () => ['not implemented'],
  listenPlan: () => ({ useLocalListener: false, admin: { hosts: [], port: 0 }, preview: { hosts: [], port: 0 }, allowPeers: null, tls: true }),
  gateProfile: () => null,
  reachLine: () => '',
  startupText: () => ({ pre: [], post: [] }),
  applyRemoteChange: () => ({ next: {}, changed: [] }),
};
