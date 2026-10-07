'use strict';

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-panel-skeleton-2026-09-28.md section 1.3). Pure: reads
 * only req.method, req.url and req.headers, and calls the injected isAuthenticated(req). No
 * filesystem, no network builtin, so this file trips no NFR04 scan and every branch is testable
 * with a fake req object.
 *
 * Checks run in this fixed order; the first failure wins: Host, URL, Method, Origin (admin POST
 * only), Auth. Auth is skipped only for the admin listener's /auth and /assets/* -- every other
 * path on either listener requires it.
 */

/**
 * @param {string|undefined} hostHeader
 * @param {number} port this listener's own bound port
 * @returns {boolean}
 */
function hostAllowed(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  const lastColon = hostHeader.lastIndexOf(':');
  if (lastColon === -1) return false;
  const hostPart = hostHeader.slice(0, lastColon).toLowerCase();
  const portPart = hostHeader.slice(lastColon + 1);
  if (portPart !== String(port)) return false;
  return hostPart === '127.0.0.1' || hostPart === 'localhost';
}

/**
 * V1e-3 (SD-16, ADR 0035): the validated hostname from a Host header, for building the framing
 * CSP values -- never the raw header. Delegates to hostAllowed() rather than re-parsing, so the
 * two can never drift (mutation F5: a startsWith('localhost') sibling would accept
 * 'localhostx:A', which hostAllowed already refuses).
 *
 * @param {string|undefined} hostHeader
 * @param {number} port this listener's own bound port
 * @returns {'127.0.0.1'|'localhost'|null}
 */
function hostnameFor(hostHeader, port) {
  if (!hostAllowed(hostHeader, port)) return null;
  return hostHeader.slice(0, hostHeader.lastIndexOf(':')).toLowerCase();
}

/** @returns {string|null} the decoded pathname (before '?'), or null if malformed/contains NUL. */
function decodePathname(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  const withoutQuery = url.split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  if (decoded.includes('\u0000')) return null;
  return decoded;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ listener: 'admin'|'preview', ownPort: number, adminPort: number, isAuthenticated: (req: object) => boolean }} opts
 * @returns {{ ok: true, pathname: string, query: URLSearchParams } |
 *           { ok: false, status: number, reason: 'host'|'url'|'method'|'origin'|'token' }}
 */
function checkRequest(req, { listener, ownPort, isAuthenticated }) {
  const hostHeader = req.headers && req.headers.host;
  if (!hostAllowed(hostHeader, ownPort)) {
    return { ok: false, status: 403, reason: 'host' };
  }

  const pathname = decodePathname(req.url);
  if (pathname === null) {
    return { ok: false, status: 400, reason: 'url' };
  }

  const allowedMethods = listener === 'admin' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
  if (!allowedMethods.includes(req.method)) {
    return { ok: false, status: 405, reason: 'method' };
  }

  if (listener === 'admin' && req.method === 'POST') {
    const origin = req.headers && req.headers.origin;
    const expected = `http://${hostHeader.toLowerCase()}`;
    if (origin !== expected) {
      return { ok: false, status: 403, reason: 'origin' };
    }
  }

  const skipAuth = listener === 'admin' && (pathname === '/auth' || pathname.startsWith('/assets/'));
  if (!skipAuth && !isAuthenticated(req)) {
    return { ok: false, status: 403, reason: 'token' };
  }

  const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
  return { ok: true, pathname, query };
}

module.exports = { hostAllowed, hostnameFor, checkRequest };
