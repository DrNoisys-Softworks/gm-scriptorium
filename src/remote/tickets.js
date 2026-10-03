'use strict';

const crypto = require('crypto');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, section 7; SD-doc section 10). The one-time
 * tickets behind "Open preview": an admin session mints one, and the preview listener consumes it
 * to start a preview session. A ticket is 256 random bits, lives in memory only, is single use,
 * expires after 60 seconds (strictly: usable at +59999, dead at +60000), and is bound to the admin
 * session that minted it. Only its SHA-256 is held. At most `max` are outstanding; the oldest is
 * evicted first.
 */

function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** @param {{ now?: () => number, randomBytes?: (size: number) => Buffer, ttlMs?: number, max?: number }} [opts] */
function createTicketStore({ now = Date.now, randomBytes = crypto.randomBytes, ttlMs = 60000, max = 32 } = {}) {
  /** @type {Map<string, { parentId: string, expires: number }>} insertion order is age order */
  const tickets = new Map();

  return {
    /** @param {string} parentId the admin session id @returns {string} the ticket */
    mint(parentId) {
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(sha256hex(ticket), { parentId, expires: now() + ttlMs });
      while (tickets.size > max) tickets.delete(tickets.keys().next().value);
      return ticket;
    },

    /** @returns {string|null} the parent admin session id, or null (unknown, used, or expired) */
    consume(ticket) {
      if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 256) return null;
      const key = sha256hex(ticket);
      const rec = tickets.get(key);
      tickets.delete(key);
      if (!rec) return null;
      return rec.expires > now() ? rec.parentId : null;
    },

    size() {
      return tickets.size;
    },
  };
}

module.exports = { createTicketStore };
