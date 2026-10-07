'use strict';

/*
 * Phase 8 slice S1. Header sets and a tiny response sender. No response from either listener
 * ever carries Access-Control-* (FR09); adminHeaders() is the exact FR10 set, previewHeaders()
 * is the same set minus the CSP.
 */

const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** @param {object} [extra] @returns {object} */
function adminHeaders(extra = {}) {
  return {
    'Content-Security-Policy': ADMIN_CSP,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

/** @param {object} [extra] @returns {object} */
function previewHeaders(extra = {}) {
  return {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

/*
 * V1e-3 (SD-16, ADR 0035): two pure CSP-string builders for the preview framing change. Both fail
 * closed on anything other than the exact validated shapes gate.hostnameFor()/ctx.adminPort and
 * ctx.previewPort can produce -- ADMIN_CSP, adminHeaders and previewHeaders above are byte-
 * unchanged (SD-16's constraint).
 */

/** @param {unknown} hostname @returns {boolean} */
function isFramingHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

/** @param {unknown} port @returns {boolean} */
function isFramingPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

const CONNECT_SRC_MARKER = "connect-src 'self';";

/**
 * ADMIN_CSP with `frame-src http://<hostname>:<previewPort>;` inserted directly after
 * `connect-src 'self';` -- exactly ADMIN_CSP (fail closed) unless both inputs are the exact
 * validated shapes gate.hostnameFor()/ctx.previewPort produce. This is the ONLY admin response
 * that ever carries frame-src (core.panelShell, GET / only): it is the only document that frames.
 *
 * @param {unknown} hostname
 * @param {unknown} previewPort
 * @returns {string}
 */
function adminShellCsp(hostname, previewPort) {
  if (!isFramingHostname(hostname) || !isFramingPort(previewPort)) return ADMIN_CSP;
  return ADMIN_CSP.replace(CONNECT_SRC_MARKER, `${CONNECT_SRC_MARKER} frame-src http://${hostname}:${previewPort};`);
}

/**
 * `frame-ancestors http://<hostname>:<adminPort>`, naming exactly the admin origin -- so only the
 * panel's own page (never any other loopback service) may frame a preview page. Fails closed to
 * `frame-ancestors 'none'` unless both inputs are the exact validated shapes
 * gate.hostnameFor()/ctx.adminPort produce.
 *
 * @param {unknown} hostname
 * @param {unknown} adminPort
 * @returns {string}
 */
function previewFrameCsp(hostname, adminPort) {
  if (!isFramingHostname(hostname) || !isFramingPort(adminPort)) return "frame-ancestors 'none'";
  return `frame-ancestors http://${hostname}:${adminPort}`;
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} headers
 * @param {string|Buffer} [body]
 * @param {{ isHead?: boolean }} [opts]
 */
function send(res, status, headers, body, { isHead = false } = {}) {
  res.writeHead(status, headers);
  if (isHead || body === undefined || body === null) {
    res.end();
  } else {
    res.end(body);
  }
}

module.exports = { ADMIN_CSP, adminHeaders, previewHeaders, adminShellCsp, previewFrameCsp, send };
