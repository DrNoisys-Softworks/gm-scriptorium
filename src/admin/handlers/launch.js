'use strict';

const respond = require('../respond');
const session = require('../session');
const assets = require('../assets');
const body = require('../body');
const { browserFamily } = require('../../remote/audit');

/*
 * ADR 0028, section 7. POST /auth/launch: the one place a launch code is exchanged. The browser
 * gets here by auto-submitting the form in the launcher file (a file: page), so the request has no
 * session and carries "Origin: null", which the gate accepts for this path only, on a loopback
 * request to a process that has a code store.
 *
 * It answers 200, never a redirect: the session cookie is SameSite=Strict, and a cookie is not sent
 * on a redirect that began on another site. The 200 page's own script then navigates to / from a
 * same-origin document. The code is never echoed, logged or put in a header or a location.
 */

const FORM = 'application/x-www-form-urlencoded';

/** Every attempt that reaches here is audited, best effort, like a token sign-in (the code is never recorded). */
function auditCodeSignin(req, ctx, kind, clientAddress, result) {
  if (!ctx.audit) return;
  try {
    ctx.audit.append({
      event: 'signin',
      method: 'code',
      result,
      via: kind || 'loopback',
      from: clientAddress === undefined ? null : clientAddress,
      browser: browserFamily(req.headers && req.headers['user-agent']),
      campaign: ctx.campaign,
    });
  } catch {
    // swallowed: health() records it and the Remote access screen shows it.
  }
}

function refuse(res, extra = {}) {
  respond.send(res, 403, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8', ...extra }), assets.readAdminAsset('launch-locked.html'));
}

/** POST /auth/launch. */
async function launchExchange(req, res, ctx, { kind, clientAddress }) {
  const store = ctx.launchCodes;
  if (!store) {
    refuse(res);
    return;
  }
  const result = await body.readBody(req, 1024);
  const contentType = String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
  let presented = '';
  if (result.ok && contentType === FORM) {
    const value = new URLSearchParams(result.body.toString('utf8')).get('code');
    presented = typeof value === 'string' ? value : '';
  }
  const ok = presented !== '' && store.consume(presented) === true;
  auditCodeSignin(req, ctx, kind, clientAddress, ok ? 'ok' : 'refused');
  if (!ok) {
    refuse(res, result.ok ? {} : { Connection: 'close' });
    return;
  }
  respond.send(
    res,
    200,
    respond.adminHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': session.sessionCookieHeader(ctx.adminPort, ctx.token, { secure: Boolean(ctx.access && ctx.access.loopbackScheme === 'https') }),
    }),
    assets.readAdminAsset('launch.html'),
  );
}

module.exports = { launchExchange };
