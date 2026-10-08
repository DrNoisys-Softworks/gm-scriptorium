'use strict';

const addr = require('../remote/addr');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-panel-skeleton-2026-09-28.md section 1.3). Pure: reads
 * only req.method, req.url and req.headers, and calls the injected isAuthenticated(req). No
 * filesystem, no network builtin, so this file trips no NFR04 scan and every branch is testable
 * with a fake req object.
 *
 * Checks run in this fixed order; the first failure wins: Host, URL, Method, Origin (admin POST
 * only), Auth. Auth is skipped only for the admin listener's /auth, /auth/launch and /assets/* --
 * every other path on either listener requires it.
 *
 * V1.5a (docs/decisions/0029-remote-access.md section 5; SD-doc section 5): an optional `access`
 * profile (src/remote/settings.js gateProfile) adds the second kind of request. With no profile
 * (local and ssh modes, and every pre-V1.5 test) behaviour is exactly the loopback behaviour
 * above, plus the new fields on success. With one, the sequence becomes: duplicate Host, kind (the
 * loopback Host forms, or the configured external Host), peer and protocol, URL, method, Origin
 * (per kind), kind-restricted paths, auth (per kind). Still pure: it reads only the request's
 * method, url, headers, rawHeaders and socket, and calls the injected isAuthenticated(req, kind).
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

/** How many Host header lines the request really carried (Node folds duplicates in req.headers). */
function countHostHeaders(rawHeaders) {
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === 'host') n++;
  }
  return n;
}

/**
 * The preview hand-off path is decided on the RAW request path (before any "?"), here and in the
 * router's dispatch alike, so the two can never disagree about whether a request is /:enter.
 */
function isEnterPath(rawUrl) {
  return typeof rawUrl === 'string' && rawUrl.split('?')[0] === '/:enter';
}

function refuse(status, reason) {
  return { ok: false, status, reason };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ listener: 'admin'|'preview', ownPort: number, adminPort?: number, isAuthenticated: (req: object, kind: 'loopback'|'remote') => boolean, access?: object|null, launchExchange?: boolean }} opts
 * @returns {{ ok: true, pathname: string, query: URLSearchParams, kind: 'loopback'|'remote', clientAddress: string|null } |
 *           { ok: false, status: number, reason: 'host'|'peer'|'proto'|'url'|'method'|'origin'|'kind'|'token'|'session' }}
 */
function checkRequest(req, { listener, ownPort, isAuthenticated, access = null, launchExchange = false }) {
  const headers = req.headers || {};
  const hostHeader = headers.host;
  const remoteProfile = access && access.remote ? access : null;

  // 1. Duplicate (or missing) Host. Node may already have rejected a duplicate before a handler
  // runs; this is the rule for a request that got through.
  if (Array.isArray(req.rawHeaders) && countHostHeaders(req.rawHeaders) !== 1) return refuse(403, 'host');

  // 2. Kind.
  let kind;
  if (hostAllowed(hostHeader, ownPort)) {
    kind = 'loopback';
  } else if (remoteProfile && typeof hostHeader === 'string' && hostHeader.toLowerCase() === remoteProfile[listener].host) {
    kind = 'remote';
  } else {
    return refuse(403, 'host');
  }

  // 3. Peer and protocol (remote profiles only). Forwarded headers are read ONLY after the peer
  // is proved to be a trusted one, so a header from anyone else can never influence anything,
  // including the audit address.
  const peer = addr.normalizePeer(req.socket && req.socket.remoteAddress);
  let clientAddress = peer;
  if (remoteProfile) {
    if (kind === 'loopback') {
      if (!addr.LOOPBACK_PEERS.includes(peer)) return refuse(403, 'peer');
    } else if (remoteProfile.requireTls) {
      if (!(req.socket && req.socket.encrypted === true)) return refuse(403, 'proto');
    } else if (remoteProfile.forwarded) {
      if (!remoteProfile.trustedPeers.includes(peer)) return refuse(403, 'peer');
      if (headers['x-forwarded-proto'] !== 'https') return refuse(403, 'proto');
      const forwardedFor = addr.rightmostForwardedFor(headers['x-forwarded-for']);
      clientAddress = forwardedFor === null ? 'unknown' : forwardedFor;
    }
  }

  // 4. URL decode, unchanged.
  const pathname = decodePathname(req.url);
  if (pathname === null) return refuse(400, 'url');

  // 4b. One canonical path decision for the colon-reserved namespace (ADR 0039): a preview request
  // whose DECODED path begins with ":" must have begun with a literal ":" on the wire. An encoded
  // colon (%3A, %3a) is an ambiguous spelling of /:enter or /:variant/..., refused outright.
  if (listener === 'preview' && pathname.startsWith('/:') && !String(req.url).startsWith('/:')) return refuse(400, 'url');

  // 5. Method, unchanged.
  const allowedMethods = listener === 'admin' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
  if (!allowedMethods.includes(req.method)) return refuse(405, 'method');

  // 6. Origin (admin POST only), exact: the configured external origin for a remote request, the
  // request's own loopback Host (in the scheme the loopback listener serves) otherwise.
  if (listener === 'admin' && req.method === 'POST') {
    const expected =
      kind === 'remote' ? remoteProfile.admin.origin : `${(access && access.loopbackScheme) || 'http'}://${hostHeader.toLowerCase()}`;
    // ADR 0028, section 7: the one exception. The launcher file is a file: page, so its POST carries
    // "Origin: null". It is accepted for exactly this path, from a loopback-kind caller, and only in
    // a process that has a launch code store (launchExchange). A valid unspent code is still needed.
    const launchPost = launchExchange === true && kind === 'loopback' && pathname === '/auth/launch';
    if (headers.origin !== expected && !(launchPost && headers.origin === 'null')) return refuse(403, 'origin');
  }

  // 7. Kind-restricted paths. The one-time token never signs a remote request in; the password
  // never signs a loopback request in; the preview hand-off exists only for remote requests.
  if (listener === 'admin' && kind === 'remote' && pathname === '/auth') return refuse(403, 'kind');
  if (listener === 'admin' && kind === 'loopback' && pathname === '/auth/password') return refuse(403, 'kind');
  if (listener === 'admin' && kind === 'remote' && pathname === '/auth/launch') return refuse(403, 'kind');
  if (listener === 'preview' && kind === 'loopback' && isEnterPath(req.url)) return refuse(403, 'kind');

  // 8. Auth.
  const skipAuth =
    listener === 'admin'
      ? pathname === '/auth' || pathname === '/auth/password' || pathname === '/auth/launch' || pathname.startsWith('/assets/')
      : isEnterPath(req.url);
  if (!skipAuth && !isAuthenticated(req, kind)) return refuse(403, kind === 'remote' ? 'session' : 'token');

  const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
  return { ok: true, pathname, query, kind, clientAddress };
}

module.exports = { hostAllowed, hostnameFor, checkRequest, isEnterPath };
