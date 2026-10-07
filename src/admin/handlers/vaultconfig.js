'use strict';

const crypto = require('crypto');
const respond = require('../respond');
const body = require('../body');
const { runExclusive } = require('../context');
const { validateTagline } = require('../../setup/validate');
// Every step below is called through its module object (never destructured at require time), so
// an injection test can patch exactly one of them deterministically (SD-6).
const vaultconfigwrite = require('../../vault/vaultconfigwrite');
const vaultconfigedit = require('../vaultconfigedit');
const machinedir = require('../../config/machinedir');
const backups = require('../../config/backups');
const read = require('../../vault/read');
const { ConfigError, ScriptoriumError } = require('../../util/errors');
const freshness = require('../freshness');

/*
 * V1e-1 (ADR 0033, SD-6): POST /api/vault-config/tagline and readView() (the ?include=vaultconfig
 * payload GET /api/state uses). Follows src/admin/handlers/pack.js's runSave order (body ->
 * writable -> fields -> lock -> read -> existence/sha -> on-disk validation -> edit -> candidate
 * validation -> dry run -> write), but is its own standalone flow rather than a reuse of runSave:
 * this write goes through vaultconfigwrite.replaceVaultConfigMd, not packreplace.replacePackFile,
 * and carries a mandatory backup and two independent guards runSave has no equivalent of.
 */

const BASE_SHA_RE = /^[0-9a-f]{64}$/;
const ALLOWED_KEYS = ['tagline', 'baseSha256', 'dryRun'];

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function unsupportedMessage(form) {
  return `publish.theme.tagline is written in a form the panel can't edit safely (${form}). Change it in _meta/vault-config.md by hand.`;
}

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

/** A specific, already-decided HTTP response, thrown from inside the write-locked section. */
class HandlerRefusal extends Error {
  constructor(status, payload) {
    super('vault-config tagline write refusal');
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Read-only path used by both `readView` (GET, via ?include=vaultconfig) and `saveTagline`
 * (before any write). Never throws.
 *
 * @param {object} ctx
 * @returns {{ exists: boolean, sha256: string|null, frontmatterText: string|null, tagline: string|null, editable: boolean, reason: string|null, backupDir: string|null }}
 */
function readView(ctx) {
  const empty = { exists: false, sha256: null, frontmatterText: null, tagline: null, editable: false, reason: null, backupDir: null };

  if (!ctx.writable) {
    return { ...empty, reason: ctx.readOnlyReason };
  }

  const machineDirResult = machinedir.resolveMachineDir({
    configPath: ctx.ctxInfo && ctx.ctxInfo.configPath,
    vaultPath: ctx.vaultPath,
  });
  if (!machineDirResult.ok) {
    return { ...empty, reason: machineDirResult.reason };
  }
  const backupDir = backups.backupDirFor(machineDirResult.dir, ctx.campaign);

  let target;
  try {
    ({ target } = vaultconfigwrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    return { ...empty, backupDir, reason: err.message };
  }

  let bytes;
  try {
    bytes = read.readBytes(target);
  } catch (err) {
    return { exists: true, sha256: null, frontmatterText: null, tagline: null, editable: false, reason: err.message, backupDir };
  }
  const sha256 = sha256Hex(bytes);

  const split = vaultconfigedit.splitFile(bytes);
  if (!split.ok) {
    return { exists: true, sha256, frontmatterText: null, tagline: null, editable: false, reason: split.reason, backupDir };
  }

  const parsed = vaultconfigedit.parseWithBoth(bytes.toString('utf8'));
  if (!parsed.ok) {
    return { exists: true, sha256, frontmatterText: split.frontmatterText, tagline: null, editable: false, reason: parsed.reason, backupDir };
  }

  const plan = vaultconfigedit.locateTagline(split, parsed.scriptorium.data);
  if (!plan.ok) {
    return { exists: true, sha256, frontmatterText: split.frontmatterText, tagline: null, editable: false, reason: unsupportedMessage(plan.form), backupDir };
  }

  return { exists: true, sha256, frontmatterText: split.frontmatterText, tagline: plan.currentValue, editable: true, reason: null, backupDir };
}

/** Steps 5 onward, run inside runExclusive: covers both dryRun and confirm. */
function readEditWrite(ctx, { tagline, baseSha256, dryRun, machineDirResult, backupDir }) {
  let target;
  try {
    ({ target } = vaultconfigwrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    if (err instanceof vaultconfigwrite.VaultConfigChangedError) {
      throw new HandlerRefusal(409, { error: 'changed', message: err.message });
    }
    throw new HandlerRefusal(422, { error: 'unsupported', message: err.message });
  }

  const currentBytes = read.readBytes(target);
  const currentSha = sha256Hex(currentBytes);
  if (currentSha !== baseSha256) {
    throw new HandlerRefusal(409, { error: 'changed', message: 'vault-config.md changed outside the panel. Reload before saving.' });
  }

  const split = vaultconfigedit.splitFile(currentBytes);
  if (!split.ok) {
    throw new HandlerRefusal(422, { error: 'unsupported', message: split.reason });
  }

  const currentText = currentBytes.toString('utf8');
  const curParsed = vaultconfigedit.parseWithBoth(currentText);
  if (!curParsed.ok) {
    throw new HandlerRefusal(422, { error: 'invalid-on-disk', message: curParsed.reason });
  }

  const plan = vaultconfigedit.locateTagline(split, curParsed.scriptorium.data);
  if (!plan.ok) {
    throw new HandlerRefusal(422, { error: 'unsupported', message: unsupportedMessage(plan.form) });
  }

  const candidateBytes = vaultconfigedit.applyTagline(split, plan, tagline);

  if (candidateBytes.equals(currentBytes)) {
    return { status: 200, body: { ok: true, unchanged: true, dryRun, file: 'vault-config.md', sha256: currentSha, warnings: [] } };
  }

  const candidateText = candidateBytes.toString('utf8');
  const candParsed = vaultconfigedit.parseWithBoth(candidateText);
  if (!candParsed.ok) {
    throw new HandlerRefusal(400, { error: 'invalid', message: candParsed.reason });
  }

  const candSplit = vaultconfigedit.splitFile(candidateBytes);
  if (!candSplit.ok) {
    throw new HandlerRefusal(422, { error: 'unsupported', message: unsupportedMessage('an unusual layout') });
  }

  const semS = vaultconfigedit.semanticGuard(curParsed.scriptorium.data, candParsed.scriptorium.data, tagline);
  const semG = vaultconfigedit.semanticGuard(curParsed.generator.data, candParsed.generator.data, tagline);
  const txt = vaultconfigedit.textualGuard(split, candSplit);
  if (!semS || !semG || !txt) {
    throw new HandlerRefusal(422, {
      error: 'unsupported',
      message: "The panel couldn't change only the tagline safely, so nothing was written. Change it in _meta/vault-config.md by hand.",
    });
  }

  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        file: 'vault-config.md',
        before: split.frontmatterText,
        after: candSplit.frontmatterText,
        backupDir,
        warnings: [],
      },
    };
  }

  try {
    const result = vaultconfigwrite.replaceVaultConfigMd(ctx.vaultPath, candidateBytes, {
      expectedSha256: currentSha,
      campaign: ctx.campaign,
      backup: (currentFileBytes) =>
        backups.backupThenPrune({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, bytes: currentFileBytes }),
    });
    return { status: 200, body: { ok: true, file: 'vault-config.md', sha256: result.sha256, backupPath: result.backup.path, warnings: [] } };
  } catch (err) {
    if (err instanceof vaultconfigwrite.VaultConfigChangedError) {
      throw new HandlerRefusal(409, { error: 'changed', message: err.message });
    }
    if (err instanceof backups.BackupError) {
      throw new HandlerRefusal(503, { error: 'io', message: err.message });
    }
    if (err instanceof ConfigError) {
      throw new HandlerRefusal(422, { error: 'unsupported', message: err.message });
    }
    if (err instanceof ScriptoriumError) {
      throw new HandlerRefusal(503, { error: 'io', message: err.message });
    }
    throw err;
  }
}

/** POST /api/vault-config/tagline (SD-6, FR-03(a), FR-06, FR-07-09). */
async function saveTagline(req, res, ctx) {
  const bodyResult = await body.readBody(req, body.JSON_BODY_CAP);
  if (!bodyResult.ok) {
    respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
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

  const unknown = Object.keys(parsed).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unknown.length > 0) {
    sendJson(res, 400, { error: 'invalid', message: `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` });
    return;
  }

  if (typeof parsed.tagline !== 'string') {
    sendJson(res, 400, { error: 'invalid', message: 'tagline must be a string' });
    return;
  }
  let tagline;
  try {
    tagline = validateTagline(parsed.tagline);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid', message: err.message });
    return;
  }

  const baseSha256 = parsed.baseSha256;
  if (typeof baseSha256 !== 'string' || !BASE_SHA_RE.test(baseSha256)) {
    sendJson(res, 400, { error: 'invalid', message: 'baseSha256 must be 64 lowercase hex characters' });
    return;
  }

  const dryRun = Object.prototype.hasOwnProperty.call(parsed, 'dryRun') ? parsed.dryRun : false;
  if (typeof dryRun !== 'boolean') {
    sendJson(res, 400, { error: 'invalid', message: 'dryRun must be a boolean' });
    return;
  }

  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }

  const machineDirResult = machinedir.resolveMachineDir({
    configPath: ctx.ctxInfo && ctx.ctxInfo.configPath,
    vaultPath: ctx.vaultPath,
  });
  if (!machineDirResult.ok) {
    sendJson(res, 503, { error: 'unavailable', message: machineDirResult.reason });
    return;
  }
  const backupDir = backups.backupDirFor(machineDirResult.dir, ctx.campaign);

  let outcome;
  try {
    outcome = await runExclusive(ctx, 'write', () => readEditWrite(ctx, { tagline, baseSha256, dryRun, machineDirResult, backupDir }));
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
  // V1e-3 (SD-17): a dry run and an unchanged confirm never write, so noteSaveIfWritten's own
  // checks (body.dryRun !== true, body.unchanged !== true) leave the counter untouched for both.
  freshness.noteSaveIfWritten(ctx, outcome.value);
  sendJson(res, outcome.value.status, outcome.value.body);
}

module.exports = { readView, saveTagline, HandlerRefusal };
