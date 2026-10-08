'use strict';

const crypto = require('crypto');

/*
 * ADR 0028, section 7. The one-time launch code that signs the browser in after the panel opens it
 * for the GM. The same shape as the preview tickets (src/remote/tickets.js): 256 random bits, only
 * the SHA-256 held in memory, single use (any lookup spends the entry it found), dead at exactly
 * +ttlMs (usable at +59999, refused at +60000 with the default), and at most `max` outstanding with
 * the oldest evicted first.
 *
 * onConsumed receives the entry's hash (never the code) after a SUCCESSFUL consume, so the launcher
 * file that carries the code can be removed the moment it is spent.
 */

function codeKey(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
}

/** @param {{ now?: () => number, randomBytes?: (size: number) => Buffer, ttlMs?: number, max?: number, onConsumed?: (key: string) => void }} [opts] */
function createLaunchCodeStore({ now = Date.now, randomBytes = crypto.randomBytes, ttlMs = 60000, max = 4, onConsumed } = {}) {
  /** @type {Map<string, number>} hash -> expiry; insertion order is age order */
  const entries = new Map();

  return {
    /** @returns {string} a fresh code (the only copy outside the launcher file) */
    mint() {
      const code = randomBytes(32).toString('base64url');
      entries.set(codeKey(code), now() + ttlMs);
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return code;
    },

    /** @returns {boolean} true once, for a live code; every other lookup is false */
    consume(code) {
      if (typeof code !== 'string' || code.length === 0 || code.length > 256) return false;
      const key = codeKey(code);
      const expires = entries.get(key);
      entries.delete(key);
      if (expires === undefined || !(expires > now())) return false;
      if (typeof onConsumed === 'function') {
        try {
          onConsumed(key);
        } catch {
          // a failed tidy-up never changes whether the code worked
        }
      }
      return true;
    },

    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}

module.exports = { createLaunchCodeStore, codeKey };
