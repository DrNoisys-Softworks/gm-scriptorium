'use strict';

const path = require('path');
const respond = require('../respond');
const body = require('../body');
const packfiles = require('../packfiles');
const packedit = require('../packedit');
const { runExclusive } = require('../context');
const { replacePackFile, PackChangedError } = require('../../vault/packreplace');
// Called through the module object (packwrite.createPackEntries), not destructured, so a test
// can patch it to simulate the FR22 EEXIST race deterministically (the same reason
// src/vault/packreplace.js's own rename loop always calls fs.renameSync through the fs object).
const packwrite = require('../../vault/packwrite');
const { parsePackToml } = require('../../build/packtoml');
const { parsePackConfigText } = require('../../cli/check');
const { validateTheme, validateTitle, composePackToml } = require('../../setup/validate');
const { ConfigError, ScriptoriumError } = require('../../util/errors');
// V1e-4 (SD-30, D-6): required as a module object (never destructured), the same reason
// packwrite above is -- through the facade only, so `pinned.slugify` is the one and only place
// this file computes a campaign id, and a test can patch it deterministically if it ever needs
// to.
const pinned = require('../../generator/pinned');
const freshness = require('../freshness');

/*
 * Phase 8 slice S3 (FR15-FR24, SD-5 through SD-10). The panel's only edit path: POST
 * /api/pack/theme and POST /api/pack/settings, both following the exact handler order the S3
 * brief specifies (body -> writable -> fields -> lock -> read -> existence/sha -> on-disk
 * validation -> edit -> candidate validation -> dry run -> write). Everything that decides a
 * specific HTTP response short-circuits through `HandlerRefusal`, thrown from inside the
 * `runExclusive`-guarded section and caught once, in `runSave`, so FR31's mutex covers every
 * refusal that depends on the file's live state (steps 5-11) without needing its own try/catch
 * at every call site.
 */

const BASE_SHA_RE = /^[0-9a-f]{64}$/;

/** A specific, already-decided HTTP response, thrown from inside the write-locked section. */
class HandlerRefusal extends Error {
  constructor(status, payload) {
    super('admin pack write refusal');
    this.status = status;
    this.payload = payload;
  }
}

function changedMessage(name) {
  return `${name} changed outside the panel. Reload before saving.`;
}

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

function sendInvalid(res, message) {
  sendJson(res, 400, { error: 'invalid', message });
}

/** The absolute path readPackFile would resolve for `name` (packfiles.js keeps its own copy private). */
function pathForFile(ctx, name) {
  return name === 'vault.config.json' ? ctx.siteConfigPath : path.join(ctx.packDir, 'pack.toml');
}

/**
 * FR22: pack.toml did not exist when it was read. A theme save is the only way to create it; a
 * non-null baseSha256 against a file that does not exist is already stale by definition.
 */
function writeMissingPackToml(ctx, { fields, baseSha256, dryRun }) {
  if (baseSha256 !== null) {
    throw new HandlerRefusal(409, { error: 'changed', message: changedMessage('pack.toml') });
  }

  const candidate = composePackToml(fields.theme);

  if (dryRun) {
    return {
      status: 200,
      body: { ok: true, dryRun: true, file: 'pack.toml', before: null, after: candidate, commentsLost: false, warnings: [] },
    };
  }

  try {
    packwrite.createPackEntries(ctx.vaultPath, [{ rel: 'pack.toml', kind: 'file', data: candidate }], { campaign: ctx.campaign });
  } catch (err) {
    if (err instanceof ConfigError) {
      const nowExists = packfiles.readPackFile(ctx, 'pack.toml').exists;
      if (nowExists) {
        throw new HandlerRefusal(409, { error: 'changed', message: changedMessage('pack.toml') });
      }
      throw new HandlerRefusal(400, { error: 'invalid', message: err.message });
    }
    throw new HandlerRefusal(503, { error: 'io', message: err.message });
  }

  const sha256 = packfiles.sha256Hex(Buffer.from(candidate, 'utf8'));
  return { status: 200, body: { ok: true, file: 'pack.toml', sha256, warnings: [] } };
}

/** Steps 5-11 of the handler order, run inside runExclusive. */
function buildAndWrite(ctx, spec) {
  const { name, baseSha256, dryRun, buildCandidate, productParse, candidateCheck, dryRunExtras } = spec;

  // 5. Read the current file.
  let current;
  try {
    current = packfiles.readPackFile(ctx, name);
  } catch (err) {
    throw new HandlerRefusal(503, { error: 'io', message: err.message });
  }

  if (!current.exists) {
    if (name !== 'pack.toml') {
      // ctx.writable implies siteSource === 'convention', which requires vault.config.json to
      // have existed at launch for the campaign to resolve at all (SD-9); its absence now means
      // it was removed outside the panel.
      throw new HandlerRefusal(409, { error: 'changed', message: changedMessage(name) });
    }
    return writeMissingPackToml(ctx, spec);
  }

  // 6. Existence and sha.
  if (baseSha256 === null || current.sha256 !== baseSha256) {
    throw new HandlerRefusal(409, { error: 'changed', message: changedMessage(name) });
  }

  const raw = current.raw.toString('utf8');

  // 7. On-disk validation.
  try {
    productParse(raw);
  } catch (err) {
    throw new HandlerRefusal(422, { error: 'invalid-on-disk', message: err.message });
  }

  // 8. Edit.
  const candidate = buildCandidate(raw);

  // 9. Candidate validation.
  let parseResult;
  try {
    parseResult = productParse(candidate);
  } catch (err) {
    throw new HandlerRefusal(400, { error: 'invalid', message: err.message });
  }
  const warnings = (parseResult && parseResult.warnings) || [];

  // 9b. Candidate-only check (SD-3, phase 8 slice S5): an optional endpoint hook that runs after
  // the candidate's own productParse, on the CANDIDATE ONLY -- never on `current`/on-disk above.
  // That is what lets a slot that is already broken on disk still be cleared: this hook never
  // sees the on-disk text at all, only the edited candidate. Absent for S3's saveTheme/saveSettings
  // (endpoint.candidateCheck undefined), so their behaviour is unchanged.
  if (candidateCheck) {
    try {
      candidateCheck(candidate, parseResult);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new HandlerRefusal(400, { error: 'invalid', message: err.message });
      }
      if (err instanceof ScriptoriumError) {
        throw new HandlerRefusal(503, { error: 'io', message: err.message });
      }
      throw err;
    }
  }

  // 10. Dry run. `dryRunExtras` (SD-30) is an optional endpoint hook that adds extra keys to the
  // dry-run body only -- Object.assign with an empty object when the endpoint defines none, so
  // every endpoint but the one that opts in stays byte-identical to before this hook existed.
  if (dryRun) {
    return {
      status: 200,
      body: Object.assign(
        {
          ok: true,
          dryRun: true,
          file: name,
          before: raw,
          after: candidate,
          commentsLost: name === 'pack.toml' && packedit.tomlHasComment(raw),
          warnings,
        },
        dryRunExtras ? dryRunExtras(raw, candidate) : {},
      ),
    };
  }

  // 11. Write.
  try {
    const result = replacePackFile(ctx.vaultPath, name, candidate, { expectedSha256: baseSha256, campaign: ctx.campaign });
    return { status: 200, body: { ok: true, file: name, sha256: result.sha256, warnings } };
  } catch (err) {
    if (err instanceof PackChangedError) {
      throw new HandlerRefusal(409, { error: 'changed', message: err.message });
    }
    if (err instanceof ScriptoriumError) {
      throw new HandlerRefusal(503, { error: 'io', message: err.message });
    }
    throw err;
  }
}

/**
 * Steps 1-4: parse the body, check writability, validate the fields, then take the write lock
 * around steps 5-11 (buildAndWrite). `endpoint` describes what differs between the two routes.
 */
async function runSave(req, res, ctx, endpoint) {
  // 1. Body.
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
    sendInvalid(res, 'the request body is not valid JSON');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'the request body must be a JSON object');
    return;
  }

  const unknown = Object.keys(parsed).filter((k) => !endpoint.allowedKeys.includes(k));
  if (unknown.length > 0) {
    sendInvalid(res, `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    return;
  }

  if (endpoint.requireAtLeastOneOf) {
    const present = endpoint.requireAtLeastOneOf.some((k) => Object.prototype.hasOwnProperty.call(parsed, k));
    if (!present) {
      sendInvalid(res, `at least one of ${endpoint.requireAtLeastOneOf.join(' or ')} must be present`);
      return;
    }
  }

  const baseSha256 = Object.prototype.hasOwnProperty.call(parsed, 'baseSha256') ? parsed.baseSha256 : undefined;
  const baseOk =
    (endpoint.baseShaAllowsNull && baseSha256 === null) || (typeof baseSha256 === 'string' && BASE_SHA_RE.test(baseSha256));
  if (!baseOk) {
    sendInvalid(res, `baseSha256 must be 64 lowercase hex characters${endpoint.baseShaAllowsNull ? ' or null' : ''}`);
    return;
  }

  const dryRun = Object.prototype.hasOwnProperty.call(parsed, 'dryRun') ? parsed.dryRun : false;
  if (typeof dryRun !== 'boolean') {
    sendInvalid(res, 'dryRun must be a boolean');
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
    fields = endpoint.validateFields(parsed);
  } catch (err) {
    if (err instanceof ConfigError) {
      sendInvalid(res, err.message);
      return;
    }
    throw err;
  }

  // 4. Lock, then steps 5-11.
  let outcome;
  try {
    outcome = await runExclusive(ctx, 'write', () =>
      buildAndWrite(ctx, {
        name: endpoint.name,
        fields,
        baseSha256,
        dryRun,
        buildCandidate: (raw) => endpoint.buildCandidate(raw, fields),
        productParse: (text) => endpoint.productParse(text, ctx),
        // One-property pass-through (SD-3): only present when the endpoint itself defines one, so
        // saveTheme/saveSettings below are byte-for-byte the same call they always were.
        ...(endpoint.candidateCheck ? { candidateCheck: (text, pr) => endpoint.candidateCheck(text, pr, ctx) } : {}),
        // Same one-property pass-through pattern (V1e-4 SD-30): present only for the one endpoint
        // (saveSettings) that defines it, so saveTheme, saveVocab and saveSlots are unaffected.
        ...(endpoint.dryRunExtras ? { dryRunExtras: (raw, candidate) => endpoint.dryRunExtras(raw, candidate) } : {}),
      }),
    );
  } catch (err) {
    if (err instanceof HandlerRefusal) {
      sendJson(res, err.status, err.payload);
      return;
    }
    throw err;
  }

  if (!outcome.ok) {
    sendJson(res, 409, { error: 'busy', busy: outcome.busy });
    return;
  }
  // V1e-3 (SD-17): covers theme, settings, vocab and slots -- every write this handler serves.
  freshness.noteSaveIfWritten(ctx, outcome.value);
  sendJson(res, outcome.value.status, outcome.value.body);
}

/** POST /api/pack/theme (FR23). */
async function saveTheme(req, res, ctx) {
  await runSave(req, res, ctx, {
    name: 'pack.toml',
    allowedKeys: ['theme', 'baseSha256', 'dryRun'],
    baseShaAllowsNull: true,
    validateFields: (parsed) => ({ theme: validateTheme(parsed.theme) }),
    buildCandidate: (raw, fields) => packedit.editPackTomlTheme(raw, fields.theme),
    productParse: (text, ctx2) => parsePackToml(text, { tomlPath: pathForFile(ctx2, 'pack.toml'), campaign: ctx2.campaign }),
  });
}

/**
 * POST /api/pack/settings (FR24, D03). V1e-1 (ADR 0033, D-20): `landingTagline` is never written
 * again -- the site never read it (`landing.js:63`; only `publish.theme.tagline` in
 * _meta/vault-config.md, FR-03(a) now owns that key). An unknown-field 400 refuses it explicitly
 * rather than silently accepting and ignoring it.
 */
/**
 * V1e-4 (SD-30, D-6, FR-23): the campaign-id slug warning. `vault.config.json`'s own
 * `backend.statusBar`/`backend.inbox` (never vault-config.md's `publish.backend`, and never a
 * deployed-backend detection -- a residual, recorded in ADR 0022) gates whether the dry-run body
 * gains a `campaignId` key at all; the id itself is computed only through the pinned facade
 * (`lib/build.js:827,865`'s own `slugify(config.siteTitle || 'campaign')`), never re-implemented
 * client-side, so it can never drift from what a real build actually names the campaign.
 * `raw`/`candidate` have already passed `productParse` by the time this runs (buildAndWrite step
 * 9 precedes step 10), so both are valid JSON here.
 */
function settingsDryRunExtras(raw, candidate) {
  const cur = JSON.parse(raw);
  const cand = JSON.parse(candidate);
  const flag = !!cur.backend && typeof cur.backend === 'object' && (cur.backend.statusBar === true || cur.backend.inbox === true);
  if (!flag) return {};
  const before = pinned.slugify(cur.siteTitle || 'campaign');
  const after = pinned.slugify(cand.siteTitle || 'campaign');
  return before !== after ? { campaignId: { before, after } } : {};
}

async function saveSettings(req, res, ctx) {
  await runSave(req, res, ctx, {
    name: 'vault.config.json',
    allowedKeys: ['siteTitle', 'baseSha256', 'dryRun'],
    baseShaAllowsNull: false,
    requireAtLeastOneOf: ['siteTitle'],
    validateFields: (parsed) => {
      const fields = {};
      if (Object.prototype.hasOwnProperty.call(parsed, 'siteTitle')) fields.siteTitle = validateTitle(parsed.siteTitle);
      return fields;
    },
    buildCandidate: (raw, fields) => packedit.editVaultConfigJson(raw, fields),
    productParse: (text, ctx2) => parsePackConfigText(text, pathForFile(ctx2, 'vault.config.json'), ctx2.campaign),
    dryRunExtras: settingsDryRunExtras,
  });
}

module.exports = { saveTheme, saveSettings, runSave, buildAndWrite, HandlerRefusal };
