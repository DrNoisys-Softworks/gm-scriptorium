'use strict';
// C2 stub.
module.exports = {
  MAX_FAILURES: 0,
  WINDOW_MS: 0,
  PAUSE_MS: 0,
  createLockoutState: () => ({ failures: [], pausedUntil: null, refused: 0 }),
  check: () => ({ allowed: false, events: [] }),
  countRefusal: () => 0,
  recordFailure: () => ({ events: [] }),
  recordSuccess: () => undefined,
  status: () => ({ active: false, until: null, recentFailures: -1, refused: -1, events: [] }),
};
