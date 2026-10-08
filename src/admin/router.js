'use strict';

const gate = require('./gate');
const session = require('./session');
const respond = require('./respond');
const assets = require('./assets');
const core = require('./handlers/core');
const views = require('./handlers/views');
const pack = require('./handlers/pack');
const vocab = require('./handlers/vocab');
const images = require('./handlers/images');
const vaultconfig = require('./handlers/vaultconfig');
const vaultconfigeditor = require('./handlers/vaultconfigeditor');
const prefs = require('./handlers/prefs');
const variantHandlers = require('./handlers/variants');
const remoteHandlers = require('./handlers/remote');
const setupHandlers = require('./handlers/setup');
const launchHandlers = require('./handlers/launch');
const folderHandlers = require('./handlers/folders');
const setupmode = require('./setupmode');
const { ADMIN_COOKIE, PREVIEW_COOKIE } = require('../remote/sessions');

/*
 * Phase 8 slice S1 (Structural decision 4: "the gate is pure, and the route table is data").
 * ADMIN_ROUTES is frozen after this slice: every route any later slice will ever serve already
 * has an entry here, most as a 501 stub, so S2-S6 land behind an already-gated, already-tested
 * table instead of editing it (avoiding the textual-conflict problem the plan called out).
 *
 * 13 method+path entries, plus the GET /assets/<name> prefix entry (14 total) -- the split the
 * S1 brief's route-sweep test names explicitly.
 */
const ADMIN_ROUTES = Object.freeze([
  { method: 'GET', path: '/auth', auth: false, handler: core.authExchange },
  { method: 'GET', path: '/', auth: true, page: true, handler: core.panelShell },
  { method: 'GET', prefix: '/assets/', auth: false, handler: core.asset },
  { method: 'GET', path: '/api/session', auth: true, handler: core.session },
  { method: 'POST', path: '/api/noop', auth: true, handler: core.noop },
  { method: 'GET', path: '/api/state', auth: true, handler: views.state },
  { method: 'POST', path: '/api/check', auth: true, audit: true, handler: views.check },
  { method: 'POST', path: '/api/preview', auth: true, audit: true, handler: views.preview },
  { method: 'GET', path: '/api/image', auth: true, handler: images.image },
  { method: 'POST', path: '/api/pack/theme', auth: true, audit: true, handler: pack.saveTheme },
  { method: 'POST', path: '/api/pack/settings', auth: true, audit: true, handler: pack.saveSettings },
  { method: 'POST', path: '/api/pack/vocab', auth: true, audit: true, handler: vocab.saveVocab },
  { method: 'POST', path: '/api/pack/slots', auth: true, audit: true, handler: images.saveSlots },
  { method: 'POST', path: '/api/images/upload', auth: true, audit: true, handler: images.upload },
  // V1e-1 (ADR 0033, SD-6): the vault-config.md tagline chokepoint's only write route.
  { method: 'POST', path: '/api/vault-config/tagline', auth: true, audit: true, handler: vaultconfig.saveTagline },
  // V1e-2 (ADR 0033, SD-10): per-machine panel preferences. Neither route is a vault write, so
  // both are allowed for read-only campaigns (D-18 covers vault writes only).
  { method: 'GET', path: '/api/prefs', auth: true, handler: prefs.getPrefs },
  { method: 'POST', path: '/api/prefs', auth: true, audit: true, handler: prefs.postPrefs },
  // V1e-5 (ADR 0038, SD-50): read-only, contained listing of and byte access to the GM's own
  // vault attachments folder. GETs, so the gate order (Host, URL, Method, Auth; no Origin) is
  // unchanged, the same as /api/image.
  { method: 'GET', path: '/api/vault-art', auth: true, handler: images.vaultArtList },
  { method: 'GET', path: '/api/vault-art/file', auth: true, handler: images.vaultArtFile },
  // V1e-9 (ADR 0033 addendum, ADR 0041, SD-99): the guarded vault-config.md editor's own routes.
  { method: 'GET', path: '/api/vault-config/backups', auth: true, handler: vaultconfigeditor.listBackups },
  { method: 'POST', path: '/api/vault-config/effects', auth: true, audit: true, handler: vaultconfigeditor.effects },
  { method: 'POST', path: '/api/vault-config/text', auth: true, audit: true, handler: vaultconfigeditor.saveText },
  { method: 'POST', path: '/api/vault-config/restore', auth: true, audit: true, handler: vaultconfigeditor.restore },
  // V1e-10 (ADR 0033 second addendum, SD-110/SD-112): the field layout's own two routes.
  { method: 'GET', path: '/api/vault-config/fields', auth: true, handler: vaultconfigeditor.getFields },
  { method: 'POST', path: '/api/vault-config/fields', auth: true, audit: true, handler: vaultconfigeditor.saveFields },
  // V1e-7 (ADR 0039, SD-62): builds a private, never-written copy of the site in a registry
  // theme, through the exact same pipeline Build preview uses.
  { method: 'POST', path: '/api/variants/theme', auth: true, audit: true, handler: variantHandlers.buildTheme },
  // V1e-8 (ADR 0039 addendum, SD-70): builds a private, never-written copy of the site from the
  // saved pack.toml plus the Vocabulary screen's own unsaved edits, through the save path's own
  // dry run.
  { method: 'POST', path: '/api/variants/vocab', auth: true, audit: true, handler: variantHandlers.buildVocab },
  // V1.5a (ADR 0029): password sign-in (public, Origin-checked, remote requests only), the preview
  // hand-off, the read-only Remote access screen's data, and its two sign-outs. The sign-in and
  // sign-out routes write their own audit events, so they carry no audit flag.
  { method: 'POST', path: '/auth/password', auth: false, handler: remoteHandlers.passwordSignin },
  // ADR 0028: the launch-code exchange (public; the handler writes its own audit event). It only
  // does anything in a process that has a code store, which only launch mode creates.
  { method: 'POST', path: '/auth/launch', auth: false, handler: launchHandlers.launchExchange },
  { method: 'GET', path: '/open-preview', auth: true, handler: remoteHandlers.openPreview },
  { method: 'GET', path: '/api/remote', auth: true, handler: remoteHandlers.apiRemote },
  { method: 'POST', path: '/api/remote/signout', auth: true, handler: remoteHandlers.signout },
  { method: 'POST', path: '/api/remote/signout-all', auth: true, handler: remoteHandlers.signoutAll },
  // ADR 0028: browser setup (the five routes below), reached with no campaign yet. While setup is
  // active only GET /auth, /api/session and these setup routes answer (src/admin/setupmode.js);
  // afterwards /setup redirects to the Overview and the check and commit routes answer 409.
  { method: 'GET', path: '/setup', auth: true, handler: setupHandlers.setupPage },
  { method: 'GET', path: '/api/setup/state', auth: true, handler: setupHandlers.state },
  { method: 'GET', path: '/api/setup/check', auth: true, handler: setupHandlers.check },
  { method: 'POST', path: '/api/setup/commit', auth: true, audit: true, handler: setupHandlers.commit },
  { method: 'POST', path: '/api/welcome/dismiss', auth: true, audit: true, handler: setupHandlers.welcomeDismiss },
  // ADR 0049: the folder picker. The listing names folders only and is audited by its handler for a
  // remote session; the create makes one folder, create-only, and is audited here. Both are admitted
  // while setup is active (src/admin/setupmode.js).
  { method: 'GET', path: '/api/folders', auth: true, handler: folderHandlers.list },
  { method: 'POST', path: '/api/folders/create', auth: true, audit: true, handler: folderHandlers.create },
]);

/**
 * @param {object} ctx
 * @param {'admin'|'preview'} listener
 * @returns {(req: object, kind?: 'loopback'|'remote') => boolean}
 *
 * A loopback request signs in with the launch token's cookie, exactly as always. A remote request
 * needs a server-side session of this listener's own kind (the admin session cookie on the admin
 * listener, the preview cookie on the preview listener, never the other): cookie NAMES match by
 * exact equality, and any matching cookie wins (ADR 0022's decoy rule).
 */
function isAuthenticatedFor(ctx, listener) {
  return (req, kind) => {
    if (kind === 'remote') {
      if (!ctx.sessions) return false;
      const name = listener === 'admin' ? ADMIN_COOKIE : PREVIEW_COOKIE;
      const sessionKind = listener === 'admin' ? 'admin' : 'preview';
      return session.parseCookies(req.headers && req.headers.cookie).some(([n, v]) => n === name && ctx.sessions.verify(sessionKind, v) !== null);
    }
    return session.isAuthenticated(req, { adminPort: ctx.adminPort, token: ctx.token });
  };
}

function sendHtmlRefusal(res, file, isHead) {
  const bodyBytes = assets.readAdminAsset(file);
  respond.send(res, 403, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8' }), isHead ? undefined : bodyBytes, { isHead });
}

/**
 * Refusal pages. The gate's failure shape carries no decoded pathname (a Host failure means decode
 * never ran), so the page choices are made on the raw, undecoded req.url: a literal "/" is the only
 * form a browser navigation to the panel produces, and the raw path before "?" being exactly /auth is
 * the only way a token URL reaches the sign-in page.
 *  - token on / or /setup  : locked.html (ADR 0028 adds /setup); launch-locked.html in launch mode
 *  - session on /          : signin.html (V1.5a: a remote browser with no session)
 *  - kind on /auth         : signin.html (V1.5a: a token URL used against the external name)
 *  - everything else       : `refused: <reason>` as text
 */
function sendGateRefusal(res, listener, rawUrl, result, isHead, lockedFile = 'locked.html') {
  if (listener === 'admin') {
    const isRoot = rawUrl === '/';
    const rawPath = typeof rawUrl === 'string' ? rawUrl.split('?')[0] : '';
    if (result.reason === 'token' && (isRoot || rawPath === '/setup')) return sendHtmlRefusal(res, lockedFile, isHead);
    if (result.reason === 'session' && isRoot) return sendHtmlRefusal(res, 'signin.html', isHead);
    if (result.reason === 'kind' && rawPath === '/auth') return sendHtmlRefusal(res, 'signin.html', isHead);
  }
  const base = listener === 'admin' ? respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }) : respond.previewHeaders({ 'Content-Type': 'text/plain; charset=utf-8' });
  const headers = result.status === 413 ? { ...base, Connection: 'close' } : base;
  respond.send(res, result.status, headers, isHead ? undefined : `refused: ${result.reason}`, { isHead });
}

function send500(res) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  respond.send(res, 500, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }), 'internal error');
}

/**
 * V1.5a audit hook (docs/decisions/0029-remote-access.md section 8): a route flagged `audit: true`
 * is bracketed by a `request` entry before the handler and a `response` entry (with the status)
 * after. If the BEFORE entry cannot be written, a remote request is refused with 503 and the
 * handler never runs (a remote session must not change things the log cannot record); a loopback
 * request proceeds, and the failure shows on the Remote access screen. A failure of the AFTER entry
 * never changes the response.
 *
 * @returns {Promise<void>}
 */
async function runAudited(route, req, res, ctx, handlerOpts) {
  const base = { route: handlerOpts.pathname, via: handlerOpts.kind, from: handlerOpts.clientAddress, campaign: ctx.campaign };
  try {
    ctx.audit.append({ event: 'request', method: req.method, ...base });
  } catch {
    if (handlerOpts.kind === 'remote') {
      respond.send(res, 503, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), remoteHandlers.AUDIT_REFUSAL_BODY);
      return;
    }
  }
  try {
    await route.handler(req, res, ctx, handlerOpts);
  } catch {
    send500(res);
  }
  try {
    ctx.audit.append({ event: 'response', ...base, status: res.statusCode });
  } catch {
    // swallowed: audit.health() records it.
  }
}

/**
 * @param {object} ctx an admin context (context.js)
 * @param {{ routes?: typeof ADMIN_ROUTES }} [opts]
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 */
function createAdminHandler(ctx, { routes = ADMIN_ROUTES } = {}) {
  return function adminHandler(req, res) {
    Promise.resolve()
      .then(async () => {
        const isHead = req.method === 'HEAD';
        const result = gate.checkRequest(req, {
          listener: 'admin',
          ownPort: ctx.adminPort,
          adminPort: ctx.adminPort,
          isAuthenticated: isAuthenticatedFor(ctx, 'admin'),
          access: ctx.access,
          launchExchange: Boolean(ctx.launchCodes),
        });

        if (!result.ok) {
          sendGateRefusal(res, 'admin', req.url, result, isHead, ctx.launchCodes ? 'launch-locked.html' : 'locked.html');
          return;
        }

        const handlerOpts = { pathname: result.pathname, query: result.query, isHead, kind: result.kind, clientAddress: result.clientAddress };
        const matchMethod = isHead ? 'GET' : req.method;
        const assetRoute = routes.find((r) => r.prefix && result.pathname.startsWith(r.prefix));
        if (assetRoute && matchMethod === assetRoute.method) {
          await assetRoute.handler(req, res, ctx, handlerOpts);
          return;
        }

        const route = routes.find((r) => r.path !== undefined && r.path === result.pathname && r.method === matchMethod);
        if (!route) {
          respond.send(res, 404, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }), isHead ? undefined : 'not found', { isHead });
          return;
        }

        // ADR 0028, section 1: while browser setup is active only the setup routes answer. Anything
        // else is a clean 409 with a fixed body (never a 500), and GET / is the setup page.
        // Launch mode: the code exchange must work while setup is active too (the first launch), so
        // it is let through the fence, but only in a process that has a code store.
        const verdict = route.path === '/auth/launch' && ctx.launchCodes ? 'allow' : setupmode.fence(ctx, matchMethod, result.pathname);
        if (verdict === 'page') {
          await setupHandlers.setupPage(req, res, ctx, handlerOpts);
          return;
        }
        if (verdict === 'refuse') {
          respond.send(res, 409, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), isHead ? undefined : setupmode.FENCE_BODY, { isHead });
          return;
        }

        if (route.audit === true && req.method === 'POST' && ctx.audit) {
          await runAudited(route, req, res, ctx, handlerOpts);
          return;
        }

        await route.handler(req, res, ctx, handlerOpts);
      })
      .catch(() => {
        send500(res);
      });
  };
}

/**
 * @param {object} ctx
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 */
function createPreviewHandler(ctx) {
  return function previewHandler(req, res) {
    Promise.resolve()
      .then(async () => {
        const isHead = req.method === 'HEAD';
        const result = gate.checkRequest(req, {
          listener: 'preview',
          ownPort: ctx.previewPort,
          adminPort: ctx.adminPort,
          isAuthenticated: isAuthenticatedFor(ctx, 'preview'),
          access: ctx.access,
        });

        if (!result.ok) {
          sendGateRefusal(res, 'preview', req.url, result, isHead);
          return;
        }

        const handlerOpts = { pathname: result.pathname, query: result.query, isHead, kind: result.kind, clientAddress: result.clientAddress };
        // V1.5a: dispatched on the RAW req.url, the way variants.VARIANT_PREFIX is, before the main
        // preview: the gate only lets /:enter through unauthenticated for a remote request.
        if (gate.isEnterPath(req.url)) {
          await remoteHandlers.previewEnter(req, res, ctx, handlerOpts);
          return;
        }

        await views.servePreview(req, res, ctx, handlerOpts);
      })
      .catch(() => {
        send500(res);
      });
  };
}

module.exports = { ADMIN_ROUTES, createAdminHandler, createPreviewHandler };
