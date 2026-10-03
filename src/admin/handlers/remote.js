'use strict';

const respond = require('../respond');
const session = require('../session');
const body = require('../body');
const gate = require('../gate');
// Called through the module objects (password.verifyPassword, lockoutLib.check, ...) so a test can
// patch one deterministically, e.g. to count hashes.
const password = require('../../remote/password');
const lockoutLib = require('../../remote/lockout');
const settingsLib = require('../../remote/settings');
const { ADMIN_COOKIE, PREVIEW_COOKIE, SESSION_TTL_MS } = require('../../remote/sessions');
const { browserFamily } = require('../../remote/audit');
const { findLooseModes } = require('../../remote/paths');

/*
 * V1.5a (docs/decisions/0029-remote-access.md sections 6 to 9; SD-doc sections 10 and 12): the
 * handlers behind the remote-access routes. Every one is reached only after the request gate
 * (src/admin/gate.js), which has already decided the request's `kind` and, for a remote request,
 * its trusted client address; the router passes both in the options object.
 *
 *   POST /auth/password          sign in with the panel password (remote requests only)
 *   GET  /open-preview           the preview hand-off, from the admin origin
 *   GET  /:enter (preview)       consume a ticket, start (or reuse) a preview session
 *   GET  /api/remote             the read-only Remote access screen's data (never a secret)
 *   POST /api/remote/signout     sign this device out
 *   POST /api/remote/signout-all sign every device out
 */

const GENERIC_BODY = JSON.stringify({ error: 'signin', message: 'Sign-in failed. Check the password and try again.' });
const AUDIT_REFUSAL_BODY = JSON.stringify({
  error: 'audit',
  message: 'The panel could not write its audit log, so changes from other devices are paused. Use the panel on this machine, or fix the disk and try again.',
});
const LOGIN_BODY_CAP = 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function nowOf(ctx) {
  return (ctx.clock || Date.now)();
}

function sendJson(res, status, text, extra = {}) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': JSON_TYPE, ...extra }), text);
}

function sendText(res, status, text, { isHead = false, preview = false, csp } = {}) {
  const base = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (csp) base['Content-Security-Policy'] = csp;
  const headers = preview ? respond.previewHeaders(base) : respond.adminHeaders(base);
  respond.send(res, status, headers, isHead ? undefined : text, { isHead });
}

/** Best-effort audit append: a failure is recorded by audit.health() and never changes a response. */
function auditSafe(ctx, entry, opts) {
  if (!ctx.audit) return false;
  try {
    ctx.audit.append(entry, opts);
    return true;
  } catch {
    return false;
  }
}

function auditLockoutEvents(ctx, events) {
  for (const ev of events) {
    if (ev.type === 'lockout-start') auditSafe(ctx, { event: 'lockout-start', until: ev.until });
    else if (ev.type === 'lockout-end') auditSafe(ctx, { event: 'lockout-end', refused: ev.refused }, { at: ev.at });
  }
}

/** The one place lockout events are audited, whoever observed them first. */
function lockoutGate(ctx, now) {
  const result = lockoutLib.check(ctx.lockout, now);
  auditLockoutEvents(ctx, result.events);
  return result;
}

function presentedSession(req, ctx, cookieName, kind) {
  for (const [name, value] of session.parseCookies(req.headers && req.headers.cookie)) {
    if (name !== cookieName) continue;
    const rec = ctx.sessions.verify(kind, value);
    if (rec) return rec;
  }
  return null;
}

/** @returns {{ ok: true, rel: string, path: string } | { ok: false }} */
function validatePreviewTarget(to) {
  if (to === null || to === undefined || to === '') return { ok: true, rel: '', path: '/' };
  if (typeof to !== 'string' || to.length > 1024) return { ok: false };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(to)) return { ok: false };
  let variantId = null;
  let rel = to;
  if (to.startsWith(':variant/')) {
    const rest = to.slice(':variant/'.length);
    const slash = rest.indexOf('/');
    if (slash < 1) return { ok: false };
    variantId = rest.slice(0, slash);
    // mirrors assets/admin/sitepane.js VARIANT_ID_RE
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(variantId)) return { ok: false };
    rel = rest.slice(slash + 1);
  }
  if (rel.length === 0 || rel.charAt(0) === '/') return { ok: false };
  for (const bad of ['\\', ':', '?', '#']) if (rel.includes(bad)) return { ok: false };
  const segments = rel.split('/');
  for (const seg of segments) if (seg === '' || seg === '.' || seg === '..') return { ok: false };
  const encoded = segments.map((s) => encodeURIComponent(s)).join('/');
  return { ok: true, rel: variantId ? `:variant/${variantId}/${rel}` : rel, path: variantId ? `/:variant/${variantId}/${encoded}` : `/${encoded}` };
}

// --- POST /auth/password -----------------------------------------------------------------

function signinEntry(req, ctx, kind, clientAddress, result) {
  return {
    event: 'signin',
    method: 'password',
    result,
    via: kind,
    from: clientAddress,
    browser: browserFamily(req.headers && req.headers['user-agent']),
    campaign: ctx.campaign,
  };
}

async function passwordSignin(req, res, ctx, { kind, clientAddress }) {
  const read = await body.readBody(req, LOGIN_BODY_CAP);
  if (!read.ok) {
    respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
    return;
  }
  let parsed;
  try {
    parsed = body.parseJson(read.body);
  } catch {
    sendJson(res, 400, GENERIC_BODY);
    return;
  }
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : null;
  if (keys === null || keys.length !== 1 || keys[0] !== 'password' || typeof parsed.password !== 'string' || parsed.password.length < 1 || parsed.password.length > 1024) {
    sendJson(res, 400, GENERIC_BODY);
    return;
  }
  const entry = (result) => signinEntry(req, ctx, kind, clientAddress, result);

  // Paused, or another check already running: refused before any hash, and counted. The first
  // refusal is audited (so the pause has a visible first attempt), the rest are only counted.
  const t = nowOf(ctx);
  const gateResult = lockoutGate(ctx, t);
  if (!gateResult.allowed) {
    if (ctx.lockout.refused === 1) auditSafe(ctx, entry('refused'));
    sendJson(res, 403, GENERIC_BODY);
    return;
  }
  if (ctx.signinBusy) {
    if (lockoutLib.countRefusal(ctx.lockout) === 1) auditSafe(ctx, entry('refused'));
    sendJson(res, 403, GENERIC_BODY);
    return;
  }

  const record = require('../../remote/password').readPasswordRecord(ctx.remote.paths.passwordFile);
  if (record.state !== 'set') {
    auditSafe(ctx, entry('error'));
    sendJson(res, 403, GENERIC_BODY);
    return;
  }
  // A sign-in that could not be recorded is not accepted.
  if (!ctx.audit || !ctx.audit.writable()) {
    sendJson(res, 403, GENERIC_BODY);
    return;
  }

  ctx.signinBusy = true;
  let ok;
  try {
    ok = await password.verifyPassword(parsed.password, record.record);
  } finally {
    ctx.signinBusy = false;
  }

  if (!ok) {
    const failure = lockoutLib.recordFailure(ctx.lockout, nowOf(ctx));
    auditLockoutEvents(ctx, failure.events);
    auditSafe(ctx, entry('refused'));
    sendJson(res, 403, GENERIC_BODY);
    return;
  }

  lockoutLib.recordSuccess(ctx.lockout);
  let created;
  try {
    const old = presentedSession(req, ctx, ADMIN_COOKIE, 'admin');
    if (old) ctx.sessions.revoke(old.id);
    created = ctx.sessions.create('admin');
  } catch {
    auditSafe(ctx, entry('error'));
    sendJson(res, 403, GENERIC_BODY);
    return;
  }
  auditSafe(ctx, entry('ok'));
  // A new admin session lasts exactly SESSION_TTL_MS, so the cookie says so; the clock having moved a
  // millisecond between create() and here must not turn it into 86399.
  sendJson(res, 200, '{"ok":true}', { 'Set-Cookie': session.remoteCookieHeader(ADMIN_COOKIE, created.credential, SESSION_TTL_MS / 1000) });
}

// --- the preview hand-off ----------------------------------------------------------------

function openPreview(req, res, ctx, { query, isHead, kind }) {
  if (isHead) {
    respond.send(res, 204, respond.adminHeaders(), undefined, { isHead: true });
    return;
  }
  const target = validatePreviewTarget(query.get('to'));
  if (!target.ok) {
    sendText(res, 400, 'refused: url');
    return;
  }
  const handoff = (location) =>
    respond.send(res, 303, respond.adminHeaders({ Location: location, 'Content-Security-Policy': respond.handoffCsp() }));

  if (kind === 'remote') {
    const admin = presentedSession(req, ctx, ADMIN_COOKIE, 'admin');
    if (!admin) {
      sendText(res, 403, 'refused: session');
      return;
    }
    const ticket = ctx.tickets.mint(admin.id);
    const to = target.rel === '' ? '' : `&to=${encodeURIComponent(target.rel)}`;
    handoff(`${ctx.access.preview.origin}/:enter?ticket=${ticket}${to}`);
    return;
  }
  const hostname = gate.hostnameFor(req.headers.host, ctx.adminPort);
  const scheme = (ctx.access && ctx.access.loopbackScheme) || 'http';
  handoff(`${scheme}://${hostname}:${ctx.previewPort}${target.path}`);
}

function previewEnter(req, res, ctx, { query, isHead, kind }) {
  const csp = respond.remoteFrameAncestorsCsp(ctx.access);
  const deny = (status, text) => sendText(res, status, text, { isHead, preview: true, csp });
  if (isHead || kind !== 'remote') {
    deny(403, 'refused: kind');
    return;
  }
  const target = validatePreviewTarget(query.get('to'));
  if (!target.ok) {
    deny(400, 'refused: url');
    return;
  }
  const parentId = ctx.tickets.consume(query.get('ticket'));
  if (parentId === null) {
    deny(403, 'refused: session');
    return;
  }
  // One preview session per admin session: a browser that already holds a valid preview session for
  // this same parent keeps it, instead of every frame load adding a record.
  const existing = presentedSession(req, ctx, PREVIEW_COOKIE, 'preview');
  if (existing && existing.parent === parentId) {
    respond.send(res, 303, respond.previewHeaders({ Location: target.path, 'Content-Security-Policy': csp }));
    return;
  }
  let created;
  try {
    created = ctx.sessions.create('preview', { parentId });
  } catch {
    deny(403, 'refused: session');
    return;
  }
  const maxAge = Math.max(0, Math.floor((created.expires - nowOf(ctx)) / 1000));
  respond.send(res, 303, respond.previewHeaders({ Location: target.path, 'Content-Security-Policy': csp, 'Set-Cookie': session.remoteCookieHeader(PREVIEW_COOKIE, created.credential, maxAge) }));
}

// --- GET /api/remote ---------------------------------------------------------------------

function answersFor(settings, plan) {
  switch (settings.mode) {
    case 'ssh':
      return ['this machine, including tunnelled traffic'];
    case 'tailscale':
      return ['this machine (tailscaled connects over loopback)'];
    case 'proxy':
      return plan.allowPeers ? [...plan.allowPeers] : [];
    case 'direct':
      return ['any peer that can reach it'];
    default:
      return ['this machine'];
  }
}

function httpsFor(settings) {
  switch (settings.mode) {
    case 'ssh':
      return { by: 'ssh', hop: null };
    case 'tailscale':
      return { by: 'tailscale', hop: null };
    case 'proxy':
      return { by: 'proxy', hop: (settings.tls || 'off') === 'off' ? 'plain' : 'tls' };
    case 'direct':
      return { by: 'panel', hop: null };
    default:
      return { by: 'none', hop: null };
  }
}

function apiRemote(req, res, ctx, { kind }) {
  const t = nowOf(ctx);
  const settings = ctx.remote.settings;
  const paths = ctx.remote.paths;
  const plan = settingsLib.listenPlan(settings);
  const lockout = lockoutLib.status(ctx.lockout, t);
  auditLockoutEvents(ctx, lockout.events);
  const record = require('../../remote/password').readPasswordRecord(paths.passwordFile);
  const scheme = (ctx.access && ctx.access.loopbackScheme) || 'http';
  const recent = ctx.audit.read({ sinceMs: t - SEVEN_DAYS_MS });
  const full = ctx.audit.read({});
  const remoteMode = settings.mode === 'tailscale' || settings.mode === 'proxy' || settings.mode === 'direct';
  const health = ctx.audit.health();
  const payload = {
    requestKind: kind,
    mode: settings.mode,
    configPath: ctx.ctxInfo.configPath,
    addresses: {
      admin: remoteMode ? settings.admin_url : null,
      preview: remoteMode ? settings.preview_url : null,
      adminLoopback: `${scheme}://127.0.0.1:${ctx.adminPort}`,
      previewLoopback: `${scheme}://127.0.0.1:${ctx.previewPort}`,
    },
    listening: { hosts: plan.admin.hosts, adminPort: ctx.adminPort, previewPort: ctx.previewPort, answers: answersFor(settings, plan) },
    https: httpsFor(settings),
    password: { set: record.state === 'set', setAt: record.state === 'set' ? record.record.setAt : null },
    lockout: { active: lockout.active, until: lockout.until, recentFailures: lockout.recentFailures, refused: lockout.refused },
    sessions: { active: ctx.sessions.activeCount() },
    audit: { file: paths.auditFile, ok: health.ok, lastError: health.lastError },
    files: { looseModes: findLooseModes(paths) },
    recentSignins: recent.entries.filter((e) => e.event === 'signin'),
    log: full.entries,
    truncated: full.truncated,
    tls: null,
  };
  sendJson(res, 200, JSON.stringify(payload));
}

// --- sign-outs ---------------------------------------------------------------------------

function signout(req, res, ctx, { kind, clientAddress }) {
  const headers = {};
  if (kind === 'remote') {
    const rec = presentedSession(req, ctx, ADMIN_COOKIE, 'admin');
    if (rec) {
      try {
        ctx.sessions.revoke(rec.id);
      } catch {
        // The cookie is cleared regardless; the failure shows in sessions.health().
      }
    }
    headers['Set-Cookie'] = session.clearRemoteCookieHeader(ADMIN_COOKIE);
  } else {
    headers['Set-Cookie'] = session.clearLoopbackCookieHeader(ctx.adminPort, { secure: Boolean(ctx.access && ctx.access.loopbackScheme === 'https') });
  }
  // Signing out is always allowed, so an unwritable log only skips the entry.
  auditSafe(ctx, { event: 'signout', via: kind, from: clientAddress });
  sendJson(res, 200, '{"ok":true}', headers);
}

function signoutAll(req, res, ctx, { kind, clientAddress }) {
  const { count } = ctx.sessions.revokeAll();
  const headers = {};
  if (kind === 'remote') headers['Set-Cookie'] = session.clearRemoteCookieHeader(ADMIN_COOKIE);
  auditSafe(ctx, { event: 'signout-all', by: 'panel', count, via: kind, from: clientAddress });
  sendJson(res, 200, JSON.stringify({ ok: true, signedOut: count }), headers);
}

module.exports = {
  GENERIC_BODY,
  AUDIT_REFUSAL_BODY,
  validatePreviewTarget,
  passwordSignin,
  openPreview,
  apiRemote,
  signout,
  signoutAll,
  previewEnter,
};
