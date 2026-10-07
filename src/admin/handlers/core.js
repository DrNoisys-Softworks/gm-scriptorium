'use strict';

const respond = require('../respond');
const session = require('../session');
const assets = require('../assets');
const body = require('../body');
const gate = require('../gate');

/*
 * Phase 8 slice S1. The five real handlers this slice ships: the token-for-cookie exchange, the
 * panel shell, the static asset reader, /api/session, and the one write-free POST route used as
 * the Origin test target (FR08). Every one of these is only ever invoked once the router has
 * already applied the request gate (src/admin/gate.js) -- panelShell in particular is never
 * called unauthenticated: an unauthenticated GET / is turned into the locked page by the router
 * itself, from the gate's own refusal, before any route handler runs.
 */

/** GET /auth?token=<t>. Never sets or clears a cookie on failure (Structural decision 5). */
function authExchange(req, res, ctx, { query }) {
  const presented = query.get('token');
  if (!session.tokenMatches(presented, ctx.token)) {
    const bodyBytes = assets.readAdminAsset('locked.html');
    respond.send(res, 403, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8' }), bodyBytes);
    return;
  }
  respond.send(
    res,
    303,
    respond.adminHeaders({
      Location: '/',
      'Set-Cookie': session.sessionCookieHeader(ctx.adminPort, ctx.token),
    }),
  );
}

/**
 * GET /. Only ever reached authenticated (see module doc above).
 *
 * V1e-3 (SD-16, ADR 0035): the only admin response that ever gets frame-src, because it is the
 * only document that frames anything. respond.adminShellCsp fails closed to the byte-unchanged
 * ADMIN_CSP unless both the host and ctx.previewPort are the exact validated shapes it expects;
 * adminHeaders spreads `extra` last, so this Content-Security-Policy always overrides the
 * default one.
 */
function panelShell(req, res, ctx, { isHead }) {
  const bodyBytes = assets.readAdminAsset('index.html');
  const csp = respond.adminShellCsp(gate.hostnameFor(req.headers.host, ctx.adminPort), ctx.previewPort);
  respond.send(res, 200, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }), bodyBytes, {
    isHead,
  });
}

/** GET /assets/<name>, public (Structural decision 6). */
function asset(req, res, ctx, { pathname, isHead }) {
  const name = pathname.slice('/assets/'.length);
  const contentType = assets.ADMIN_ASSET_ROUTES[name];
  if (!Object.prototype.hasOwnProperty.call(assets.ADMIN_ASSET_ROUTES, name)) {
    respond.send(res, 404, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }), isHead ? undefined : 'not found', { isHead });
    return;
  }
  const bodyBytes = assets.readAdminAsset(name);
  respond.send(res, 200, respond.adminHeaders({ 'Content-Type': contentType }), bodyBytes, { isHead });
}

/** GET /api/session. */
function apiSession(req, res, ctx) {
  const payload = {
    campaign: ctx.campaign,
    siteSource: ctx.siteSource,
    writable: ctx.writable,
    readOnlyReason: ctx.readOnlyReason,
    previewPort: ctx.previewPort,
  };
  respond.send(res, 200, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

/** POST /api/noop. Write-free; exists only as the Origin/limits test target (FR08, FR13). */
async function noop(req, res) {
  const result = await body.readBody(req, body.JSON_BODY_CAP);
  if (!result.ok) {
    respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
    return;
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      body.parseJson(result.body);
    } catch {
      respond.send(
        res,
        400,
        respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
        JSON.stringify({ error: 'malformed JSON' }),
      );
      return;
    }
  }

  respond.send(
    res,
    200,
    respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    JSON.stringify({ ok: true, bytes: result.body.length }),
  );
}

module.exports = { authExchange, panelShell, asset, session: apiSession, noop };
