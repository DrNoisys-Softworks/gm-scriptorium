'use strict';

const fs = require('fs');
const path = require('path');
const respond = require('../respond');
const gate = require('../gate');
const packfiles = require('../packfiles');
const packimages = require('../packimages');
const preview = require('../preview');
const { runExclusive } = require('../context');
const { runCheckForContext, loadSiteConfig, loadPackConfig } = require('../../cli/check');
const { THEMES, loadTheme } = require('../../build/themes');
const { parsePackToml } = require('../../build/packtoml');
const read = require('../../vault/read');
const { resolveStaticPath, contentTypeFor } = require('../../serve/static');
const { EXIT_CODES } = require('../../util/exitcodes');
const { VaultUnreachableError } = require('../../util/errors');
const vocab = require('./vocab');
const themescheme = require('../../checks/themescheme');
const vaultconfig = require('./vaultconfig');
const vaultconfigeditor = require('./vaultconfigeditor');
const freshness = require('../freshness');
const pageroles = require('../pageroles');
const variants = require('../variants');
const variantHandlers = require('./variants');

/*
 * Phase 8 slice S2 (docs/agent-runs/admin-s2-engineering-brief-2026-09-28.md, "GET /api/state" /
 * "POST /api/check" / "POST /api/preview" / "servePreview"). Every handler here runs only after
 * the router's gate (src/admin/gate.js) already authenticated the request; state()'s own job is
 * to never throw regardless of what shape pack.toml or vault.config.json are in (SD-6, FR21).
 */

function readPackTomlField(ctx) {
  const file = packfiles.readPackFile(ctx, 'pack.toml');
  if (!file.exists) {
    return { exists: false, raw: null, sha256: null, error: null, theme: 'plain', images: {}, warnings: [] };
  }
  const raw = file.raw.toString('utf8');
  try {
    const parsed = parsePackToml(raw, { tomlPath: file.path, campaign: ctx.campaign });
    const images = {};
    for (const slotRef of parsed.images) images[slotRef.slot] = slotRef.raw;
    return { exists: true, raw, sha256: file.sha256, error: null, theme: parsed.theme, images, warnings: parsed.warnings };
  } catch (err) {
    return { exists: true, raw, sha256: file.sha256, error: err.message, theme: null, images: {}, warnings: [] };
  }
}

function readVaultConfigJsonField(ctx) {
  const file = packfiles.readPackFile(ctx, 'vault.config.json');
  if (!file.exists) {
    return { exists: false, raw: null, sha256: null, error: null, siteTitle: null, landingTagline: null };
  }
  const raw = file.raw.toString('utf8');
  try {
    // The display re-reads the file rather than parsing `raw` above (TOCTOU residual, Risk
    // area 5): loadSiteConfig/loadPackConfig each read through their own chokepoint. The sha
    // above is still safe to display alongside this because S3 re-checks it at save time.
    const parsed =
      ctx.siteSource === 'site_config' ? loadSiteConfig(ctx.siteConfigPath) : loadPackConfig(file.path, ctx.campaign);
    return {
      exists: true,
      raw,
      sha256: file.sha256,
      error: null,
      siteTitle: typeof parsed.siteTitle === 'string' ? parsed.siteTitle : null,
      landingTagline: typeof parsed.landingTagline === 'string' ? parsed.landingTagline : null,
    };
  } catch (err) {
    return { exists: true, raw, sha256: file.sha256, error: err.message, siteTitle: null, landingTagline: null };
  }
}

function themesField() {
  const out = [];
  for (const name of Object.keys(THEMES)) {
    let scheme = null;
    try {
      scheme = loadTheme(name).scheme;
    } catch {
      scheme = null;
    }
    out.push({ name, scheme });
  }
  return out;
}

/**
 * SD-1 (V1b, FR-19): `?include=palette`'s value. Never throws -- `paletteScheme` is called
 * through the module object (`themescheme.paletteScheme`, not destructured at require time) so a
 * test can inject a throw deterministically; a throw gives the error shape rather than a 500.
 */
function paletteField(ctx) {
  try {
    const result = themescheme.paletteScheme(ctx.vaultPath);
    return { scheme: result.scheme, background: result.background, error: null };
  } catch (err) {
    return { scheme: null, background: null, error: err.message };
  }
}

function vaultConfigMdField(ctx) {
  const mdPath = path.join(ctx.vaultPath, '_meta', 'vault-config.md');
  try {
    const result = read.readFrontmatter(mdPath);
    if (result.ok) {
      // FR32: only the frontmatter, never result.content/result.raw (the file body).
      return { ok: true, text: JSON.stringify(result.data, null, 2) };
    }
    return { ok: false, text: result.error.message };
  } catch (err) {
    // VaultReadError: the file itself could not be read at all.
    return { ok: false, text: err.message };
  }
}

/**
 * GET /api/state (FR05, FR21, FR32, FR19). Never throws.
 *
 * Phase 8 slice S4 (SD-3): with no `include` parameter the payload is byte-identical to
 * `ecffe6f`; `?include=vocab` adds exactly one extra key, `vocab`, built by vocab.vocabView.
 * S2's own frozen shape test (test/admin-views.test.js:186-219) never passes `query`, so the
 * default `{ query } = {}` below must leave the default response untouched.
 *
 * V1b SD-1 (FR-19) adds `?include=palette`, appended last. `include` is a Set built from
 * `query.getAll('include').flatMap(v => v.split(','))` -- exact-name membership only, no
 * trimming and no case-folding, so `palettes`/`Palette`/`pal`/`palette ` (a decoded trailing
 * space) never match. Both syntaxes (`?include=vocab,palette` and `?include=vocab&include=palette`)
 * land in the same Set.
 */
function state(req, res, ctx, { query } = {}) {
  const payload = {
    campaign: ctx.campaign,
    siteSource: ctx.siteSource,
    writable: ctx.writable,
    readOnlyReason: ctx.readOnlyReason,
    previewPort: ctx.previewPort,
    packToml: readPackTomlField(ctx),
    vaultConfigJson: readVaultConfigJsonField(ctx),
    themes: themesField(),
    vaultConfigMd: vaultConfigMdField(ctx),
    images: packimages.listPackImages(ctx),
    preview: { built: ctx.previewDir !== null && fs.existsSync(ctx.previewDir), dir: ctx.previewDir },
  };
  const include = new Set(query ? query.getAll('include').flatMap((v) => v.split(',')) : []);
  if (include.has('vocab')) {
    payload.vocab = vocab.vocabView(ctx);
  }
  if (include.has('palette')) {
    payload.palette = paletteField(ctx);
  }
  // V1e-1 (ADR 0033, SD-6): appended last, after palette, so the default and every pre-existing
  // include response stay byte-identical; only a NEW ?include=vaultconfig name adds this key.
  if (include.has('vaultconfig')) {
    payload.vaultConfigFile = vaultconfig.readView(ctx);
  }
  // V1e-3 (SD-19, ADR 0035 SS4/SS5): appended last, after vaultconfig, so every pre-existing
  // include response stays byte-identical; only a NEW ?include=previewinfo name adds this key.
  if (include.has('previewinfo')) {
    payload.previewInfo = previewInfoField(ctx);
  }
  // V1e-9 (ADR 0033 addendum, SD-99): appended last, after previewinfo, so every pre-existing
  // include response stays byte-identical; only a NEW ?include=vaultconfigeditor name adds this key.
  if (include.has('vaultconfigeditor')) {
    payload.vaultConfigEditor = vaultconfigeditor.editorView(ctx);
  }
  // V1e-7 (ADR 0039, SD-64): appended last, after vaultconfigeditor, so every pre-existing
  // include response stays byte-identical; only a NEW ?include=variants name adds this key.
  if (include.has('variants')) {
    payload.variants = variants.variantsInfo(ctx);
  }
  respond.send(res, 200, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

/**
 * V1e-3 (SD-19): the `?include=previewinfo` payload. Never throws -- a page-role resolution
 * failure or a freshness read failure is swallowed elsewhere (buildWithStamp's own try/catch, and
 * readTrackedShas's own "never throws" contract), so this is a pure read of already-computed ctx
 * fields.
 */
function previewInfoField(ctx) {
  const built = Boolean(ctx.previewStamp) && ctx.previewDir !== null && fs.existsSync(ctx.previewDir);
  if (!built) {
    return { built: false, builtAt: null, stale: null, savedSince: [], panelSavesSince: 0, pages: [] };
  }
  const cmp = freshness.compareStamp(ctx.previewStamp, freshness.readTrackedShas(ctx), ctx.panelSaves || 0);
  return {
    built: true,
    builtAt: ctx.previewStamp.builtAt,
    stale: cmp.stale,
    savedSince: cmp.savedSince,
    panelSavesSince: cmp.panelSavesSince,
    pages: ctx.previewPages || [],
  };
}

function exitCodeForThrow(err) {
  return err instanceof VaultUnreachableError ? EXIT_CODES.VAULT_UNREACHABLE : EXIT_CODES.SCRIPTORIUM_ERROR;
}

/** POST /api/check (FR28, FR31, FR03). The request body is ignored. */
async function check(req, res, ctx) {
  let result;
  try {
    result = await runExclusive(ctx, 'check', () => runCheckForContext(ctx.ctxInfo, {}, {}));
  } catch (err) {
    respond.send(
      res,
      200,
      respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      JSON.stringify({ exitCode: exitCodeForThrow(err), error: err.message }),
    );
    return;
  }
  if (!result.ok) {
    respond.send(
      res,
      409,
      respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      JSON.stringify({ error: 'busy', busy: result.busy }),
    );
    return;
  }
  const { envelope, exitCode, human } = result.value;
  respond.send(
    res,
    200,
    respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    JSON.stringify({ exitCode, envelope, human }),
  );
}

/**
 * V1e-3 (SD-17, D-10, ADR 0035 SS4): the freshness stamp is taken at build START, inside the
 * build lock, and committed to ctx ONLY on a successful build (exit 0) -- a refused or failed
 * build keeps the previous stamp and pages, because preview.buildPreviewWithGmLink's own atomic
 * swap keeps the previous tree on a failure, so the stamp describing "what's actually being
 * served right now" must not move either. Page-role resolution is best-effort: a failure there
 * must never fail the build itself.
 */
function buildWithStamp(ctx) {
  const stamp = freshness.takeStamp(ctx, Date.now());
  const result = preview.buildPreviewWithGmLink(ctx);
  if (result.exitCode === EXIT_CODES.OK) {
    ctx.previewStamp = stamp;
    try {
      ctx.previewPages = pageroles.resolvePageRoles(ctx.previewDir);
    } catch {
      ctx.previewPages = [];
    }
  }
  return result;
}

/** POST /api/preview (FR29, FR30, FR31). */
async function previewHandler(req, res, ctx) {
  preview.ensurePreviewRoot(ctx);

  let result;
  try {
    result = await runExclusive(ctx, 'build', () => buildWithStamp(ctx));
  } catch (err) {
    respond.send(
      res,
      200,
      respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      JSON.stringify({ exitCode: exitCodeForThrow(err), error: err.message }),
    );
    return;
  }
  if (!result.ok) {
    respond.send(
      res,
      409,
      respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      JSON.stringify({ error: 'busy', busy: result.busy }),
    );
    return;
  }
  const { envelope, exitCode, human } = result.value;
  respond.send(
    res,
    200,
    respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    JSON.stringify({ exitCode, human, envelope }),
  );
}

/**
 * Preview listener catch-all, after the gate (GET/HEAD only, enforced there). Files are read on
 * each request; no handle is held open (FR29's "the previous preview stays intact" residual: a
 * concurrent rebuild only ever replaces the tree atomically, via runAtomicBuild's swap).
 *
 * V1e-3 (SD-16, ADR 0035): every response this function sends gets a frame-ancestors CSP naming
 * exactly the admin origin, so only the panel's own page can frame a preview page -- never any
 * other loopback service, even though the SameSite=Strict cookie would reach it too.
 * respond.previewFrameCsp fails closed to `frame-ancestors 'none'` unless both the host and
 * ctx.adminPort are the exact validated shapes it expects.
 */
function servePreview(req, res, ctx, { isHead, kind } = {}) {
  // V1.5a (A1): a remote request's frame-ancestors names the configured admin origin.
  const previewCsp =
    kind === 'remote'
      ? respond.remoteFrameAncestorsCsp(ctx.access)
      : respond.previewFrameCsp(gate.hostnameFor(req.headers.host, ctx.previewPort), ctx.adminPort);

  // V1e-7 (ADR 0039, SD-63): the reserved `/:variant/<id>/` namespace, dispatched on the RAW
  // req.url (never decoded) before the "no preview has been built yet" branch below -- a colon
  // can never appear in a decoded page address the main preview could serve (static.js's rule
  // 3), so this namespace can never shadow anything the main preview answers.
  if (typeof req.url === 'string' && req.url.startsWith(variants.VARIANT_PREFIX)) {
    variantHandlers.serveVariant(req, res, ctx, { isHead, csp: previewCsp });
    return;
  }

  if (!ctx.previewDir || !fs.existsSync(ctx.previewDir)) {
    respond.send(
      res,
      404,
      respond.previewHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': previewCsp }),
      isHead ? undefined : 'no preview has been built yet',
      { isHead },
    );
    return;
  }

  const result = resolveStaticPath(ctx.previewDir, req.url);
  if (!result.ok) {
    if (result.status === 400) {
      respond.send(
        res,
        400,
        respond.previewHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': previewCsp }),
        isHead ? undefined : 'bad request',
        { isHead },
      );
      return;
    }
    const notFoundPath = path.join(ctx.previewDir, '404.html');
    if (fs.existsSync(notFoundPath)) {
      const bytes = fs.readFileSync(notFoundPath);
      respond.send(
        res,
        404,
        respond.previewHeaders({ 'Content-Type': contentTypeFor(notFoundPath), 'Content-Security-Policy': previewCsp }),
        isHead ? undefined : bytes,
        { isHead },
      );
    } else {
      respond.send(
        res,
        404,
        respond.previewHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': previewCsp }),
        isHead ? undefined : 'not found',
        { isHead },
      );
    }
    return;
  }

  const bytes = fs.readFileSync(result.filePath);
  respond.send(
    res,
    200,
    respond.previewHeaders({ 'Content-Type': contentTypeFor(result.filePath), 'Content-Security-Policy': previewCsp }),
    isHead ? undefined : bytes,
    { isHead },
  );
}

module.exports = { state, check, preview: previewHandler, servePreview };
