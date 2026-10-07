'use strict';

const fs = require('fs');
const path = require('path');
const respond = require('../respond');
const body = require('../body');
const packfiles = require('../packfiles');
const packedit = require('../packedit');
const { runExclusive } = require('../context');
const preview = require('../preview');
const variants = require('../variants');
const freshness = require('../freshness');
const pack = require('./pack');
const vocabHandler = require('./vocab');
const { parsePackToml } = require('../../build/packtoml');
const { validateTheme } = require('../../setup/validate');
const { resolveStaticPath, contentTypeFor } = require('../../serve/static');
const { ConfigError, ScriptoriumError, VaultUnreachableError } = require('../../util/errors');
const { EXIT_CODES } = require('../../util/exitcodes');

// V1e-8 (ADR 0039 addendum, SD-70): the same body.js-free body literals runSave's own step 1
// uses (handlers/pack.js:231-251), copied exactly so POST /api/variants/vocab's refusals match
// POST /api/pack/vocab's refusals for the same body.
const BASE_SHA_RE = /^[0-9a-f]{64}$/;
const VOCAB_ALLOWED_KEYS = ['labels', 'timeline', 'recaps', 'baseSha256'];
const VOCAB_REQUIRE_AT_LEAST_ONE_OF = ['labels', 'timeline', 'recaps'];

/*
 * V1e-7 (ADR 0039, SD-62, SD-63). POST /api/variants/theme builds a private, never-written copy
 * of the site in a registry theme, from the save path's OWN dry run (so the candidate text is
 * byte-for-byte what Save would write). GET traffic for the built copies is served from the
 * preview listener's reserved `/:variant/<id>/` prefix, dispatched from views.js's servePreview
 * before its own "no preview has been built yet" branch.
 */

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

/** A local copy of views.js's exitCodeForThrow (SD-62: "using a local copy of views.js:185-187"). */
function exitCodeForThrow(err) {
  return err instanceof VaultUnreachableError ? EXIT_CODES.VAULT_UNREACHABLE : EXIT_CODES.SCRIPTORIUM_ERROR;
}

/** Fails closed unless `dry` is exactly the shape a successful dry run produces. */
function candidateOf(dry) {
  if (!dry || dry.status !== 200 || !dry.body || dry.body.dryRun !== true || typeof dry.body.after !== 'string') {
    throw new ScriptoriumError('preview copy: the dry-run candidate was not in the expected shape');
  }
  return dry.body.after;
}

/**
 * Steps 4a-4c of buildTheme, run inside runExclusive(ctx, 'build', ...). The candidate text is
 * the save path's own dry run (pack.buildAndWrite with the literal `dryRun: true`): same read,
 * same sha precondition, same on-disk validation, same edit function, same candidate validation
 * -- nothing here duplicates any of that. A campaign with no pack.toml on disk yet can never get
 * a candidate (the read overlay doesn't answer read.pathExists), so that case is refused here,
 * before buildAndWrite, with its own clear message (Amendment A / DV-E76).
 */
function themeVariant(ctx, theme) {
  const cur = packfiles.readPackFile(ctx, 'pack.toml');
  if (!cur.exists) {
    throw new pack.HandlerRefusal(400, {
      error: 'invalid',
      message: 'Save a theme first; that creates pack.toml. Theme previews need it.',
    });
  }
  const dry = pack.buildAndWrite(ctx, {
    name: 'pack.toml',
    fields: { theme },
    baseSha256: cur.sha256,
    dryRun: true,
    buildCandidate: (raw) => packedit.editPackTomlTheme(raw, theme),
    productParse: (text) => parsePackToml(text, { tomlPath: path.join(ctx.packDir, 'pack.toml'), campaign: ctx.campaign }),
  });
  const after = candidateOf(dry);
  return variants.buildVariant(ctx, theme, after);
}

/** POST /api/variants/theme (SD-62, FR-35, FR-37). */
async function buildTheme(req, res, ctx) {
  // 1. Read the body.
  const bodyResult = await body.readBody(req, body.JSON_BODY_CAP);
  if (!bodyResult.ok) {
    respond.send(
      res,
      413,
      respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }),
      'refused: too large',
    );
    return;
  }

  let parsed;
  try {
    parsed = body.parseJson(bodyResult.body);
  } catch {
    sendJson(res, 400, { error: 'invalid', message: 'the request body is not valid JSON' });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'invalid', message: 'the request body must be a JSON object' });
    return;
  }
  const unknown = Object.keys(parsed).filter((k) => k !== 'theme');
  if (unknown.length > 0) {
    sendJson(res, 400, { error: 'invalid', message: `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` });
    return;
  }

  // 2. Writable.
  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }

  // 3. Fields.
  let theme;
  try {
    theme = validateTheme(parsed.theme);
  } catch (err) {
    if (err instanceof ConfigError) {
      sendJson(res, 400, { error: 'invalid', message: err.message });
      return;
    }
    throw err;
  }

  // 4. Build.
  preview.ensurePreviewRoot(ctx);
  let outcome;
  try {
    outcome = await runExclusive(ctx, 'build', () => themeVariant(ctx, theme));
  } catch (err) {
    if (err instanceof pack.HandlerRefusal) {
      sendJson(res, err.status, err.payload);
      return;
    }
    sendJson(res, 200, { exitCode: exitCodeForThrow(err), error: err.message });
    return;
  }

  // 5. Busy.
  if (!outcome.ok) {
    sendJson(res, 409, { error: 'busy', busy: outcome.busy });
    return;
  }

  // 6. Too large on its own.
  if (outcome.value.tooLarge) {
    sendJson(res, 503, {
      error: 'too-large',
      message: 'This site is too big to keep a preview copy of here (over 1 GiB). Build preview still works.',
    });
    return;
  }

  // 7. Success.
  const { exitCode, human, envelope } = outcome.value.result;
  sendJson(res, 200, {
    exitCode,
    human,
    envelope,
    variant: variants.variantItem(ctx, theme, freshness.readTrackedShas(ctx)),
    evicted: outcome.value.evicted,
  });
}

/**
 * Steps 4a-4c of buildVocab, run inside runExclusive(ctx, 'build', ...). The candidate text is
 * the save path's own dry run (pack.buildAndWrite with the literal `dryRun: true`), exactly the
 * SD-70 shape: same allowed-keys/requireAtLeastOneOf/baseSha256 checks as runSave would apply,
 * the same validateVocabEdits shape check, the same editPackTomlVocab edit, the same sha
 * precondition (buildAndWrite step 6) -- nothing here duplicates any of that logic, only the
 * call. Never written: dryRun is the literal `true`, never derived from the body.
 */
function vocabVariant(ctx, fields, baseSha256) {
  const dry = pack.buildAndWrite(ctx, {
    name: 'pack.toml',
    fields,
    baseSha256,
    dryRun: true,
    buildCandidate: (raw) => vocabHandler.editPackTomlVocab(raw, fields),
    productParse: (text) => parsePackToml(text, { tomlPath: path.join(ctx.packDir, 'pack.toml'), campaign: ctx.campaign }),
  });
  const after = candidateOf(dry);
  return variants.buildVariant(ctx, variants.VOCAB_VARIANT_ID, after);
}

/** POST /api/variants/vocab (SD-70, FR-33). Never writes pack.toml: the candidate is always the
 * save path's own dry-run preview of the body, through the exact same read overlay every other
 * variant copy uses (Amendment A). */
async function buildVocab(req, res, ctx) {
  // 1. Read the body (SD-62's reading/parsing/object checks, plus SD-70's own allowed-keys,
  // requireAtLeastOneOf and baseSha256 literals -- pack.js:231-251's, copied exactly).
  const bodyResult = await body.readBody(req, body.JSON_BODY_CAP);
  if (!bodyResult.ok) {
    respond.send(
      res,
      413,
      respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }),
      'refused: too large',
    );
    return;
  }

  let parsed;
  try {
    parsed = body.parseJson(bodyResult.body);
  } catch {
    sendJson(res, 400, { error: 'invalid', message: 'the request body is not valid JSON' });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'invalid', message: 'the request body must be a JSON object' });
    return;
  }
  const unknown = Object.keys(parsed).filter((k) => !VOCAB_ALLOWED_KEYS.includes(k));
  if (unknown.length > 0) {
    sendJson(res, 400, { error: 'invalid', message: `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` });
    return;
  }
  const present = VOCAB_REQUIRE_AT_LEAST_ONE_OF.some((k) => Object.prototype.hasOwnProperty.call(parsed, k));
  if (!present) {
    sendJson(res, 400, { error: 'invalid', message: `at least one of ${VOCAB_REQUIRE_AT_LEAST_ONE_OF.join(' or ')} must be present` });
    return;
  }
  const baseSha256 = Object.prototype.hasOwnProperty.call(parsed, 'baseSha256') ? parsed.baseSha256 : undefined;
  if (typeof baseSha256 !== 'string' || !BASE_SHA_RE.test(baseSha256)) {
    sendJson(res, 400, { error: 'invalid', message: 'baseSha256 must be 64 lowercase hex characters' });
    return;
  }

  // 2. Writable.
  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }

  // 3. Fields.
  let fields;
  try {
    fields = vocabHandler.validateVocabEdits(parsed);
  } catch (err) {
    if (err instanceof ConfigError) {
      sendJson(res, 400, { error: 'invalid', message: err.message });
      return;
    }
    throw err;
  }

  // 4. Build.
  preview.ensurePreviewRoot(ctx);
  let outcome;
  try {
    outcome = await runExclusive(ctx, 'build', () => vocabVariant(ctx, fields, baseSha256));
  } catch (err) {
    if (err instanceof pack.HandlerRefusal) {
      sendJson(res, err.status, err.payload);
      return;
    }
    sendJson(res, 200, { exitCode: exitCodeForThrow(err), error: err.message });
    return;
  }

  // 5. Busy.
  if (!outcome.ok) {
    sendJson(res, 409, { error: 'busy', busy: outcome.busy });
    return;
  }

  // 6. Too large on its own.
  if (outcome.value.tooLarge) {
    sendJson(res, 503, {
      error: 'too-large',
      message: 'This site is too big to keep a preview copy of here (over 1 GiB). Build preview still works.',
    });
    return;
  }

  // 7. Success.
  const { exitCode, human, envelope } = outcome.value.result;
  sendJson(res, 200, {
    exitCode,
    human,
    envelope,
    variant: variants.variantItem(ctx, variants.VOCAB_VARIANT_ID, freshness.readTrackedShas(ctx)),
    evicted: outcome.value.evicted,
  });
}

function send404(res, csp, isHead) {
  respond.send(
    res,
    404,
    respond.previewHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': csp }),
    isHead ? undefined : 'not found',
    { isHead },
  );
}

/**
 * Dispatched from views.js's servePreview, directly after the previewCsp line and before the
 * "no preview has been built yet" branch, on req.url.startsWith(variants.VARIANT_PREFIX) --
 * raw, never decoded. `id` is matched raw too; only the remainder goes through
 * resolveStaticPath, which decodes it exactly once (SD-63).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx
 * @param {{ isHead: boolean, csp: string }} opts
 */
function serveVariant(req, res, ctx, { isHead, csp }) {
  const rest = req.url.slice(variants.VARIANT_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    send404(res, csp, isHead);
    return;
  }
  const id = rest.slice(0, slash);
  if (!variants.isVariantId(id)) {
    send404(res, csp, isHead);
    return;
  }
  const dir = variants.builtDirFor(ctx, id);
  if (dir === null) {
    send404(res, csp, isHead);
    return;
  }

  const result = resolveStaticPath(dir, rest.slice(slash));
  if (!result.ok) {
    if (result.status === 404) {
      const notFoundPath = path.join(dir, '404.html');
      if (fs.existsSync(notFoundPath)) {
        const bytes = fs.readFileSync(notFoundPath);
        respond.send(
          res,
          404,
          respond.previewHeaders({ 'Content-Type': contentTypeFor(notFoundPath), 'Content-Security-Policy': csp }),
          isHead ? undefined : bytes,
          { isHead },
        );
        return;
      }
    }
    send404(res, csp, isHead);
    return;
  }

  const bytes = fs.readFileSync(result.filePath);
  respond.send(
    res,
    200,
    respond.previewHeaders({ 'Content-Type': contentTypeFor(result.filePath), 'Content-Security-Policy': csp }),
    isHead ? undefined : bytes,
    { isHead },
  );
}

module.exports = { buildTheme, buildVocab, serveVariant };
