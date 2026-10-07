'use strict';

const crypto = require('crypto');

/*
 * Phase 8 slice S1, D02 seam (docs/agent-runs/admin-panel-skeleton-2026-09-28.md section 1.8).
 * Only this module, core.authExchange and app.js's api() know the token is carried by a cookie
 * after the first load. The token itself: 256 bits from a CSPRNG, base64url, so 43 characters
 * with no shell metacharacters and no `&` in the printed URL (Structural decision 8).
 */

/** @returns {string} 32 CSPRNG bytes, base64url, 43 characters, no padding. */
function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

/**
 * Constant-time compare. A non-string `presented` (or any length, including 0 or 1000) never
 * throws: both sides are hashed to a fixed-length digest before timingSafeEqual runs, so a
 * length mismatch in the raw input can never reach it.
 *
 * @param {*} presented
 * @param {string} token
 * @returns {boolean}
 */
function tokenMatches(presented, token) {
  if (typeof presented !== 'string') return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(token));
}

/** @param {number} port */
function cookieName(port) {
  return `scriptorium_admin_${port}`;
}

/** @param {number} port @param {string} token */
function sessionCookieHeader(port, token) {
  return `${cookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/**
 * Minimal Cookie-header parser: name/value pairs in order, no decoding (cookie values here are
 * always the plain base64url token). A same-name decoy placed before the real cookie must not
 * shadow it -- isAuthenticated() below accepts ANY matching cookie of the right name, exactly so
 * a decoy earlier in the header can't cause a denial of service (Structural decision 5).
 *
 * @param {string|undefined} header
 * @returns {[string, string][]}
 */
function parseCookies(header) {
  const out = [];
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out.push([part.slice(0, idx).trim(), part.slice(idx + 1).trim()]);
  }
  return out;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ adminPort: number, token: string }} ctx
 * @returns {boolean} true if ANY cookie of this admin port's name matches the token.
 */
function isAuthenticated(req, { adminPort, token }) {
  const name = cookieName(adminPort);
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return cookies.some(([n, v]) => n === name && tokenMatches(v, token));
}

module.exports = { createToken, tokenMatches, cookieName, sessionCookieHeader, parseCookies, isAuthenticated };
