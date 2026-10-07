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
  { method: 'POST', path: '/api/check', auth: true, handler: views.check },
  { method: 'POST', path: '/api/preview', auth: true, handler: views.preview },
  { method: 'GET', path: '/api/image', auth: true, handler: images.image },
  { method: 'POST', path: '/api/pack/theme', auth: true, handler: pack.saveTheme },
  { method: 'POST', path: '/api/pack/settings', auth: true, handler: pack.saveSettings },
  { method: 'POST', path: '/api/pack/vocab', auth: true, handler: vocab.saveVocab },
  { method: 'POST', path: '/api/pack/slots', auth: true, handler: images.saveSlots },
  { method: 'POST', path: '/api/images/upload', auth: true, handler: images.upload },
  // V1e-1 (ADR 0033, SD-6): the vault-config.md tagline chokepoint's only write route.
  { method: 'POST', path: '/api/vault-config/tagline', auth: true, handler: vaultconfig.saveTagline },
  // V1e-2 (ADR 0033, SD-10): per-machine panel preferences. Neither route is a vault write, so
  // both are allowed for read-only campaigns (D-18 covers vault writes only).
  { method: 'GET', path: '/api/prefs', auth: true, handler: prefs.getPrefs },
  { method: 'POST', path: '/api/prefs', auth: true, handler: prefs.postPrefs },
  // V1e-5 (ADR 0038, SD-50): read-only, contained listing of and byte access to the GM's own
  // vault attachments folder. GETs, so the gate order (Host, URL, Method, Auth; no Origin) is
  // unchanged, the same as /api/image.
  { method: 'GET', path: '/api/vault-art', auth: true, handler: images.vaultArtList },
  { method: 'GET', path: '/api/vault-art/file', auth: true, handler: images.vaultArtFile },
  // V1e-9 (ADR 0033 addendum, ADR 0041, SD-99): the guarded vault-config.md editor's own routes.
  { method: 'GET', path: '/api/vault-config/backups', auth: true, handler: vaultconfigeditor.listBackups },
  { method: 'POST', path: '/api/vault-config/effects', auth: true, handler: vaultconfigeditor.effects },
  { method: 'POST', path: '/api/vault-config/text', auth: true, handler: vaultconfigeditor.saveText },
  { method: 'POST', path: '/api/vault-config/restore', auth: true, handler: vaultconfigeditor.restore },
  // V1e-10 (ADR 0033 second addendum, SD-110/SD-112): the field layout's own two routes.
  { method: 'GET', path: '/api/vault-config/fields', auth: true, handler: vaultconfigeditor.getFields },
  { method: 'POST', path: '/api/vault-config/fields', auth: true, handler: vaultconfigeditor.saveFields },
  // V1e-7 (ADR 0039, SD-62): builds a private, never-written copy of the site in a registry
  // theme, through the exact same pipeline Build preview uses.
  { method: 'POST', path: '/api/variants/theme', auth: true, handler: variantHandlers.buildTheme },
  // V1e-8 (ADR 0039 addendum, SD-70): builds a private, never-written copy of the site from the
  // saved pack.toml plus the Vocabulary screen's own unsaved edits, through the save path's own
  // dry run.
  { method: 'POST', path: '/api/variants/vocab', auth: true, handler: variantHandlers.buildVocab },
]);

function isAuthenticatedFor(ctx) {
  return (req) => session.isAuthenticated(req, { adminPort: ctx.adminPort, token: ctx.token });
}

function sendGateRefusal(res, listener, isRootPath, result, isHead) {
  if (listener === 'admin' && result.reason === 'token' && isRootPath) {
    const bodyBytes = assets.readAdminAsset('locked.html');
    respond.send(res, 403, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8' }), isHead ? undefined : bodyBytes, { isHead });
    return;
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
          isAuthenticated: isAuthenticatedFor(ctx),
        });

        if (!result.ok) {
          // The gate's failure shape carries no decoded pathname (a Host failure means decode
          // never ran), so the locked-page special case for `/` is decided on the raw,
          // undecoded req.url: a literal "/" needs no decoding to know it names the root, and
          // that is the only form the printed admin URL's browser navigation ever produces.
          sendGateRefusal(res, 'admin', req.url === '/', result, isHead);
          return;
        }

        const matchMethod = isHead ? 'GET' : req.method;
        const assetRoute = routes.find((r) => r.prefix && result.pathname.startsWith(r.prefix));
        if (assetRoute && matchMethod === assetRoute.method) {
          await assetRoute.handler(req, res, ctx, { pathname: result.pathname, query: result.query, isHead });
          return;
        }

        const route = routes.find((r) => r.path !== undefined && r.path === result.pathname && r.method === matchMethod);
        if (!route) {
          respond.send(res, 404, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }), isHead ? undefined : 'not found', { isHead });
          return;
        }

        await route.handler(req, res, ctx, { pathname: result.pathname, query: result.query, isHead });
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
          isAuthenticated: isAuthenticatedFor(ctx),
        });

        if (!result.ok) {
          sendGateRefusal(res, 'preview', undefined, result, isHead);
          return;
        }

        await views.servePreview(req, res, ctx, { pathname: result.pathname, query: result.query, isHead });
      })
      .catch(() => {
        send500(res);
      });
  };
}

module.exports = { ADMIN_ROUTES, createAdminHandler, createPreviewHandler };
