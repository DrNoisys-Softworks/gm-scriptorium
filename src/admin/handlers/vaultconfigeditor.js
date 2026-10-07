'use strict';

const crypto = require('crypto');
const respond = require('../respond');
const body = require('../body');
const { runExclusive } = require('../context');
// Every dependency below is called through its module object (never destructured at require
// time), so a test can inject a throw or a wrong value deterministically at exactly one call
// site (the same convention src/admin/handlers/vaultconfig.js already follows).
const vaultconfigwrite = require('../../vault/vaultconfigwrite');
const vaultconfigedit = require('../vaultconfigedit');
const vaultconfigcandidate = require('../vaultconfigcandidate');
const vaultconfigeffects = require('../vaultconfigeffects');
const vaultconfigfields = require('../vaultconfigfields');
const candidatecheck = require('../candidatecheck');
const checkcli = require('../../cli/check');
const publishset = require('../../vault/publishset');
const vaultindex = require('../../vault/index');
const pinned = require('../../generator/pinned');
const machinedir = require('../../config/machinedir');
const backups = require('../../config/backups');
const read = require('../../vault/read');
const freshness = require('../freshness');
const fence = require('../../vault/fence');
const { ConfigError, ScriptoriumError } = require('../../util/errors');

/*
 * V1e-9 (ADR 0033 addendum, ADR 0041, SD-98): the guarded vault-config.md editor's whole server
 * side. Every write still goes through src/vault/vaultconfigwrite.js's unchanged chokepoint, with
 * a backup first (src/config/backups.js). This file never imports handlers/vaultconfig.js (the
 * tagline chokepoint stays a separate, narrower writer) and defines its own HandlerRefusal.
 */

const BASE_SHA_RE = /^[0-9a-f]{64}$/;
const KEEP = 20;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

/** A specific, already-decided HTTP response, thrown from inside the write-locked section. */
class HandlerRefusal extends Error {
  constructor(status, payload) {
    super('vault-config editor refusal');
    this.status = status;
    this.payload = payload;
  }
}

function loneCrReason(line) {
  return vaultconfigcandidate.EDITOR_REASON['lone-cr'].replace('<N>', String(line));
}

/**
 * GET /api/state's `?include=vaultconfigeditor` payload (FR-39, FR-32). Never throws, and never
 * returns the body. Read-only campaigns still get `text` (FR-39's read view).
 */
function editorView(ctx) {
  const empty = { exists: false, sha256: null, text: null, eol: null, lineCount: null, canEdit: false, reason: null, parse: null, backupDir: null, keep: KEEP };

  let target;
  try {
    ({ target } = vaultconfigwrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    return { ...empty, reason: err.message };
  }

  const machineDirResult = machinedir.resolveMachineDir({ configPath: ctx.ctxInfo && ctx.ctxInfo.configPath, vaultPath: ctx.vaultPath });
  const backupDir = machineDirResult.ok ? backups.backupDirFor(machineDirResult.dir, ctx.campaign) : null;

  let bytes;
  try {
    bytes = read.readBytes(target);
  } catch (err) {
    return { ...empty, exists: true, reason: err.message, backupDir };
  }
  const sha256 = sha256Hex(bytes);

  const split = vaultconfigedit.splitFileDetailed(bytes);
  if (!split.ok) {
    return { ...empty, exists: true, sha256, reason: vaultconfigcandidate.EDITOR_REASON[split.code], backupDir };
  }

  const text = vaultconfigcandidate.editorText(split);
  const eol = split.eol === '\r\n' ? 'crlf' : 'lf';
  const lineCount = split.lines.length;

  const detailed = vaultconfigedit.parseWithBothDetailed(bytes.toString('utf8'));
  const parse = detailed.ok ? { ok: true } : { ok: false, line: detailed.line, message: detailed.reason };

  const loneCr = vaultconfigcandidate.loneCrLine(split);
  const fits = vaultconfigcandidate.requestFits(text);

  let reason = null;
  if (!ctx.writable) reason = ctx.readOnlyReason;
  else if (!machineDirResult.ok) reason = machineDirResult.reason;
  else if (loneCr !== null) reason = loneCrReason(loneCr);
  else if (!fits) reason = vaultconfigcandidate.EDITOR_REASON['request-too-large'];

  const canEdit = ctx.writable && machineDirResult.ok && loneCr === null && fits;

  return { exists: true, sha256, text, eol, lineCount, canEdit, reason, parse, backupDir, keep: KEEP };
}

/** Shared request validation for every POST route here. Returns before any lock. */
async function readAndValidateBody(req, allowedKeys) {
  const bodyResult = await body.readBody(req, body.JSON_BODY_CAP);
  if (!bodyResult.ok) {
    return { ok: false, status: 413 };
  }
  let parsed;
  try {
    parsed = body.parseJson(bodyResult.body);
  } catch {
    return { ok: false, status: 400, payload: { error: 'invalid', message: 'the request body is not valid JSON' } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, payload: { error: 'invalid', message: 'the request body must be a JSON object' } };
  }
  const unknown = Object.keys(parsed).filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    return { ok: false, status: 400, payload: { error: 'invalid', message: `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` } };
  }
  if (typeof parsed.baseSha256 !== 'string' || !BASE_SHA_RE.test(parsed.baseSha256)) {
    return { ok: false, status: 400, payload: { error: 'invalid', message: 'baseSha256 must be 64 lowercase hex characters' } };
  }
  const dryRun = Object.prototype.hasOwnProperty.call(parsed, 'dryRun') ? parsed.dryRun : false;
  if (typeof dryRun !== 'boolean') {
    return { ok: false, status: 400, payload: { error: 'invalid', message: 'dryRun must be a boolean' } };
  }
  const saveAnyway = Object.prototype.hasOwnProperty.call(parsed, 'saveAnyway') ? parsed.saveAnyway : false;
  if (typeof saveAnyway !== 'boolean') {
    return { ok: false, status: 400, payload: { error: 'invalid', message: 'saveAnyway must be a boolean' } };
  }
  if (dryRun === false) {
    if (typeof parsed.reviewedSha256 !== 'string' || !BASE_SHA_RE.test(parsed.reviewedSha256)) {
      return { ok: false, status: 400, payload: { error: 'invalid', message: 'reviewedSha256 must be 64 lowercase hex characters' } };
    }
  }
  return { ok: true, body: parsed, dryRun, saveAnyway };
}

/** `op === 'text'`: builds the candidate from `reqBody.frontmatterText`. */
function buildTextCandidateFor(ctx, split, reqBody) {
  const result = vaultconfigcandidate.buildTextCandidate(split, reqBody.frontmatterText);
  if (!result.ok) {
    const message = result.line === null ? result.message : `Line ${result.line}: ${result.message}`;
    throw new HandlerRefusal(400, { error: 'invalid', message, line: result.line });
  }
  return result;
}

/**
 * V1e-10 (SD-112): `op === 'fields'`. Validates `set` BEFORE any lock (a 400 never takes one):
 * a plain object of 1 to 7 keys, each an EXACT member of FIELD_SCHEMA's paths, each value valid
 * for its kind. Returns {edits} or {refusal}.
 */
function validateFieldsBody(reqBody) {
  const set = reqBody.set;
  const bad = (message) => ({ refusal: { status: 400, payload: { error: 'invalid', message } } });
  if (typeof set !== 'object' || set === null || Array.isArray(set)) return bad('set must be an object of settings to change');
  const keys = Object.keys(set);
  if (keys.length < 1 || keys.length > vaultconfigfields.FIELD_SCHEMA.length) {
    return bad('set must name 1 to ' + vaultconfigfields.FIELD_SCHEMA.length + ' settings');
  }
  const edits = {};
  for (const key of keys) {
    if (!vaultconfigfields.FIELD_BY_PATH.has(key)) return bad('unknown setting: ' + key);
  }
  for (const key of keys) {
    const entry = vaultconfigfields.FIELD_BY_PATH.get(key);
    const problem = vaultconfigfields.validateFieldValue(entry, set[key]);
    if (problem !== null) return bad(problem);
    edits[key] = set[key];
  }
  return { edits };
}

/** `op === 'fields'`: builds the candidate through operation (c); a refusal maps to 422. */
function buildFieldsCandidateFor(ctx, split, edits) {
  const parsed = vaultconfigedit.parseWithBothDetailed(split.head + split.frontmatterText + split.tail);
  if (!parsed.ok) {
    throw new HandlerRefusal(422, {
      error: 'unsupported',
      message: 'The frontmatter in vault-config.md doesn\'t read, so the fields can\'t be changed. Use "Edit as text instead".',
    });
  }
  const result = vaultconfigfields.applyFieldEdits(split, parsed.scriptorium.data, edits);
  if (!result.ok) {
    const entry = vaultconfigfields.FIELD_BY_PATH.get(result.path);
    const label = entry ? entry.label : result.path;
    throw new HandlerRefusal(422, {
      error: 'unsupported',
      message: label + " is written in a form the panel can't change safely (" + result.form + '). Use "Edit as text instead".',
    });
  }
  const candSplit = vaultconfigedit.splitFileDetailed(result.bytes);
  return { ok: true, bytes: result.bytes, frontmatterText: candSplit.ok ? candSplit.frontmatterText : '', notes: result.notes };
}

/** `op === 'restore'`: reads the backup (outside the vault) and builds the candidate from it. */
function buildRestoreCandidateFor(ctx, split, reqBody, machineDirResult) {
  let backupBytes;
  try {
    backupBytes = backups.readBackup({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, id: reqBody.backupId });
  } catch (err) {
    if (err instanceof backups.BackupNotListedError) {
      throw new HandlerRefusal(400, { error: 'invalid', message: err.message });
    }
    if (err instanceof backups.BackupTooLargeError) {
      throw new HandlerRefusal(422, { error: 'unsupported', message: err.message });
    }
    throw new HandlerRefusal(503, { error: 'io', message: err.message });
  }
  const backupSplit = vaultconfigedit.splitFileDetailed(backupBytes);
  if (!backupSplit.ok) {
    throw new HandlerRefusal(422, { error: 'unsupported', message: "That backup's frontmatter can't be read, so the panel won't restore it." });
  }
  const result = vaultconfigcandidate.buildRestoreCandidate(split, backupSplit);
  return { ...result, backupId: reqBody.backupId };
}

/** The ISO-8601 moment a backup id's own stamp encodes (backups.js's BACKUP_NAME_RE shape), or
 * null if it doesn't match -- defensive only, since this id already passed readBackup above. */
function takenAtFromId(id) {
  const m = /^vault-config-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}

/** The 7 PRIVACY_LIST_PATHS present as a flow/block list in the candidate (FR-43's "Put it back"). */
function computeFixable(candSplit, candData) {
  const fixable = new Set();
  for (const dotPath of vaultconfigeffects.PRIVACY_LIST_PATHS) {
    const segments = dotPath.split('.');
    const plan = vaultconfigfields.locatePath(candSplit, candData, segments);
    if (plan.ok && (plan.shape === 'flow' || plan.shape === 'block')) fixable.add(dotPath);
  }
  return fixable;
}

const REASON_ORDER = ['privacy', 'new-errors', 'check-did-not-run', 'current-unreadable'];

function computeReasons({ effects, check, curData }) {
  const present = new Set();
  if (effects.some((e) => e.level === 'bad')) present.add('privacy');
  if (check.ran && check.newErrorCount > 0) present.add('new-errors');
  if (!check.ran) present.add('check-did-not-run');
  if (curData === null) present.add('current-unreadable');
  return REASON_ORDER.filter((r) => present.has(r));
}

function buildNotes({ op, split, cand }) {
  const notes = ['Only the frontmatter is saved. Your notes below it stay exactly as they are.'];
  if (split.eol === '\r\n') notes.push("Saved with this file's own Windows (CRLF) line endings.");
  if (Array.isArray(cand.notes)) notes.push(...cand.notes);
  if (op === 'restore') {
    notes.push('Only the frontmatter is restored. Your notes below it stay as they are now, not as they were in the backup.');
    if (cand.eolChanged) notes.push("The backup's line endings are changed to match this file.");
  }
  return notes;
}

/**
 * The shared review pipeline (dry run and confirm alike), run inside runExclusive. `buildCandidate`
 * is one of buildTextCandidateFor/buildRestoreCandidateFor, already bound to its own op's inputs.
 */
function reviewInner(ctx, { op, reqBody, dryRun, saveAnyway, machineDirResult, buildCandidate }) {
  let target;
  try {
    ({ target } = vaultconfigwrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    if (err instanceof vaultconfigwrite.VaultConfigChangedError) {
      throw new HandlerRefusal(409, { error: 'changed', message: err.message });
    }
    throw new HandlerRefusal(422, { error: 'unsupported', message: err.message });
  }

  const curBytes = read.readBytes(target);
  const curSha = sha256Hex(curBytes);
  if (curSha !== reqBody.baseSha256) {
    throw new HandlerRefusal(409, { error: 'changed', message: 'vault-config.md changed outside the panel. Reload before saving.' });
  }

  const split = vaultconfigedit.splitFileDetailed(curBytes);
  if (!split.ok) {
    throw new HandlerRefusal(422, { error: 'unsupported', message: vaultconfigcandidate.EDITOR_REASON[split.code] });
  }
  const loneCr = vaultconfigcandidate.loneCrLine(split);
  if (loneCr !== null) {
    throw new HandlerRefusal(422, { error: 'unsupported', message: loneCrReason(loneCr) });
  }

  const cand = buildCandidate(split);

  if (cand.bytes.equals(curBytes)) {
    return { status: 200, body: { ok: true, unchanged: true, dryRun, op, file: 'vault-config.md', sha256: curSha, warnings: [] } };
  }

  const candSplit = vaultconfigedit.splitFileDetailed(cand.bytes);
  if (!candSplit.ok || candSplit.frontmatterText !== cand.frontmatterText) {
    throw new HandlerRefusal(400, { error: 'invalid', message: 'vault-config.md must start with a plain --- line.' });
  }

  if (!vaultconfigcandidate.bodyGuard(curBytes, split, cand.bytes)) {
    throw new HandlerRefusal(422, { error: 'unsupported', message: "The panel couldn't keep the rest of the note unchanged, so nothing was written." });
  }

  const candText = cand.bytes.toString('utf8');
  if (fence.classifyFrontmatterFence(candText).status !== 'yaml') {
    // Unreachable by construction (splitFileDetailed above already proved a plain --- opening);
    // defence in depth only.
    throw new HandlerRefusal(400, { error: 'invalid', message: 'vault-config.md must start with a plain --- line.' });
  }

  const candParsed = vaultconfigedit.parseWithBothDetailed(candText);
  if (!candParsed.ok) {
    const message = candParsed.line === null ? candParsed.reason : `Line ${candParsed.line}: ${candParsed.reason}`;
    throw new HandlerRefusal(400, { error: 'invalid', message, line: candParsed.line });
  }
  const curText = curBytes.toString('utf8');
  const curParsed = vaultconfigedit.parseWithBothDetailed(curText);
  const curData = curParsed.ok ? curParsed.scriptorium.data : null;
  const candData = candParsed.scriptorium.data;

  const candidateSha256 = sha256Hex(cand.bytes);
  const cached = ctx.vaultConfigReview;
  const cacheMatches = !dryRun && cached && cached.op === op && cached.baseSha256 === curSha && cached.candidateSha256 === candidateSha256;

  let rv;
  let check;
  try {
    if (cacheMatches) {
      rv = candidatecheck.runReview(ctx, { candidateBytes: cand.bytes, withCheck: false });
      check = cached.check;
    } else {
      rv = candidatecheck.runReview(ctx, { candidateBytes: cand.bytes, withCheck: true });
      check = rv.check;
    }
  } catch (err) {
    if (err instanceof candidatecheck.CandidateCheckError) {
      throw new HandlerRefusal(503, { error: 'io', message: err.message });
    }
    throw err;
  }

  const fixable = computeFixable(candSplit, candData);
  const effects = vaultconfigeffects.computeEffects({
    cur: curData,
    cand: candData,
    curPublish: rv.curPublish,
    candPublish: rv.candPublish,
    jsonConfig: rv.jsonConfig,
    publishSet: rv.candPublishSet,
    fixable,
  });

  if (check.ran && check.unforceable.length > 0) {
    throw new HandlerRefusal(422, {
      error: 'refused-by-check',
      message: `The check on the edited copy refuses this file: ${check.unforceable[0].message}. Nothing was written, and Save anyway can't override this.`,
      check,
    });
  }

  const reasons = computeReasons({ effects, check, curData });
  const needsAck = reasons.length > 0;
  const notes = buildNotes({ op, split, cand });

  if (dryRun) {
    ctx.vaultConfigReview = { op, baseSha256: curSha, candidateSha256, check, reasons };
    const dryBody = {
      ok: true,
      dryRun: true,
      op,
      file: 'vault-config.md',
      before: split.frontmatterText,
      after: candSplit.frontmatterText,
      backupDir: machineDirResult.ok ? backups.backupDirFor(machineDirResult.dir, ctx.campaign) : null,
      effects,
      check,
      needsAck,
      reasons,
      notes,
      candidateSha256,
      warnings: [],
    };
    if (op === 'restore') dryBody.backup = { id: cand.backupId, takenAt: takenAtFromId(cand.backupId) };
    return { status: 200, body: dryBody };
  }

  if (reqBody.reviewedSha256 !== candidateSha256) {
    throw new HandlerRefusal(409, { error: 'changed', message: 'vault-config.md or the backup changed since you reviewed it. Review again.' });
  }
  if (needsAck && reqBody.saveAnyway !== true) {
    throw new HandlerRefusal(422, { error: 'needs-ack', message: 'Tick "Save anyway" to save this. Nothing was written.', reasons });
  }
  ctx.vaultConfigReview = null;

  try {
    const result = vaultconfigwrite.replaceVaultConfigMd(ctx.vaultPath, cand.bytes, {
      expectedSha256: curSha,
      campaign: ctx.campaign,
      backup: (currentFileBytes) =>
        backups.backupThenPrune({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, bytes: currentFileBytes }),
    });
    return { status: 200, body: { ok: true, op, file: 'vault-config.md', sha256: result.sha256, backupPath: result.backup.path, warnings: [] } };
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

/** Shared POST handling for both /text and /restore: validates, locks, runs the pipeline, responds. */
async function runSave(req, res, ctx, { op, allowedKeys, candidateKey, validate }) {
  const parsed = await readAndValidateBody(req, allowedKeys);
  if (!parsed.ok) {
    if (parsed.status === 413) {
      respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
    } else {
      sendJson(res, parsed.status, parsed.payload);
    }
    return;
  }
  const reqBody = parsed.body;

  if (candidateKey && typeof reqBody[candidateKey] !== 'string') {
    sendJson(res, 400, { error: 'invalid', message: `${candidateKey} must be a string` });
    return;
  }

  let validated = null;
  if (validate) {
    validated = validate(reqBody);
    if (validated.refusal) {
      sendJson(res, validated.refusal.status, validated.refusal.payload);
      return;
    }
  }

  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }

  const machineDirResult = machinedir.resolveMachineDir({ configPath: ctx.ctxInfo && ctx.ctxInfo.configPath, vaultPath: ctx.vaultPath });
  if (!machineDirResult.ok) {
    sendJson(res, 503, { error: 'unavailable', message: machineDirResult.reason });
    return;
  }

  const buildCandidate =
    op === 'text'
      ? (split) => buildTextCandidateFor(ctx, split, reqBody)
      : op === 'fields'
        ? (split) => buildFieldsCandidateFor(ctx, split, validated.edits)
        : (split) => buildRestoreCandidateFor(ctx, split, reqBody, machineDirResult);

  let outcome;
  try {
    outcome = await runExclusive(ctx, parsed.dryRun ? 'check' : 'write', () =>
      reviewInner(ctx, { op, reqBody, dryRun: parsed.dryRun, saveAnyway: parsed.saveAnyway, machineDirResult, buildCandidate }),
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
  freshness.noteSaveIfWritten(ctx, outcome.value);
  sendJson(res, outcome.value.status, outcome.value.body);
}

/** POST /api/vault-config/text (op 'text'). */
async function saveText(req, res, ctx) {
  return runSave(req, res, ctx, { op: 'text', allowedKeys: ['frontmatterText', 'baseSha256', 'dryRun', 'saveAnyway', 'reviewedSha256'], candidateKey: 'frontmatterText' });
}

/** POST /api/vault-config/fields (op 'fields'): guarded structured edits of the seven FIELD_SCHEMA settings. */
async function saveFields(req, res, ctx) {
  return runSave(req, res, ctx, {
    op: 'fields',
    allowedKeys: ['set', 'baseSha256', 'dryRun', 'saveAnyway', 'reviewedSha256'],
    candidateKey: null,
    validate: validateFieldsBody,
  });
}

/** POST /api/vault-config/restore (op 'restore'). */
async function restore(req, res, ctx) {
  return runSave(req, res, ctx, { op: 'restore', allowedKeys: ['backupId', 'baseSha256', 'dryRun', 'saveAnyway', 'reviewedSha256'], candidateKey: 'backupId' });
}

/** POST /api/vault-config/effects: no lock (synchronous, read-only). */
async function effects(req, res, ctx) {
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
  const allowedKeys = ['frontmatterText', 'baseSha256', 'putBack'];
  const unknown = Object.keys(parsed).filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    sendJson(res, 400, { error: 'invalid', message: `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` });
    return;
  }
  if (typeof parsed.frontmatterText !== 'string') {
    sendJson(res, 400, { error: 'invalid', message: 'frontmatterText must be a string' });
    return;
  }
  if (typeof parsed.baseSha256 !== 'string' || !BASE_SHA_RE.test(parsed.baseSha256)) {
    sendJson(res, 400, { error: 'invalid', message: 'baseSha256 must be 64 lowercase hex characters' });
    return;
  }
  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }

  let target;
  try {
    ({ target } = vaultconfigwrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    sendJson(res, 422, { error: 'unsupported', message: err.message });
    return;
  }
  let curBytes;
  try {
    curBytes = read.readBytes(target);
  } catch (err) {
    sendJson(res, 503, { error: 'io', message: err.message });
    return;
  }
  const curSha = sha256Hex(curBytes);
  if (curSha !== parsed.baseSha256) {
    sendJson(res, 409, { error: 'changed', message: 'vault-config.md changed outside the panel. Reload before saving.' });
    return;
  }
  const split = vaultconfigedit.splitFileDetailed(curBytes);
  if (!split.ok) {
    sendJson(res, 422, { error: 'unsupported', message: vaultconfigcandidate.EDITOR_REASON[split.code] });
    return;
  }

  let text = parsed.frontmatterText;
  let candResult = vaultconfigcandidate.buildTextCandidate(split, text);
  let candidateSha256 = null;
  let nextFrontmatterText;

  if (!candResult.ok) {
    sendJson(res, 200, { ok: true, parse: { ok: false, line: candResult.line, message: candResult.message }, effects: [], needsAck: false });
    return;
  }

  if (parsed.putBack) {
    const pb = parsed.putBack;
    if (typeof pb !== 'object' || pb === null || !vaultconfigeffects.PRIVACY_LIST_PATHS.includes(pb.path) || typeof pb.entry !== 'string' || pb.entry.length < 1 || pb.entry.length > 200 || /[\u0000-\u001f]/.test(pb.entry)) {
      sendJson(res, 400, { error: 'invalid', message: 'putBack must name an existing privacy list and a plain entry' });
      return;
    }
    const candSplitForPutBack = vaultconfigedit.splitFileDetailed(candResult.bytes);
    const candParsedForPutBack = vaultconfigedit.parseWithBothDetailed(candResult.bytes.toString('utf8'));
    if (!candSplitForPutBack.ok || !candParsedForPutBack.ok) {
      sendJson(res, 422, { error: 'unsupported', message: "Put it back isn't available here. Edit the text instead." });
      return;
    }
    const segments = pb.path.split('.');
    const plan = vaultconfigfields.locatePath(candSplitForPutBack, candParsedForPutBack.scriptorium.data, segments);
    if (!plan.ok || (plan.shape !== 'flow' && plan.shape !== 'block')) {
      sendJson(res, 422, { error: 'unsupported', message: "Put it back isn't available here. Edit the text instead." });
      return;
    }
    const currentRaw = vaultconfigfields.getPath(curParsedDataFor(curBytes), segments) || [];
    const candidateList = vaultconfigfields.getPath(candParsedForPutBack.scriptorium.data, segments) || [];
    const already = candidateList.some((x) => String(x).toLowerCase() === pb.entry.toLowerCase());
    let nextList = candidateList.slice();
    if (!already) {
      const idx = currentRaw.findIndex((x) => String(x).toLowerCase() === pb.entry.toLowerCase());
      if (idx === -1 || idx > nextList.length) nextList.push(pb.entry);
      else nextList.splice(idx, 0, pb.entry);
    }
    const setResult = vaultconfigfields.setList(candSplitForPutBack, candParsedForPutBack.scriptorium.data, segments, nextList);
    if (!setResult.ok) {
      sendJson(res, 422, { error: 'unsupported', message: "Put it back isn't available here. Edit the text instead." });
      return;
    }
    const nextSplit = vaultconfigedit.splitFileDetailed(setResult.bytes);
    if (!nextSplit.ok) {
      sendJson(res, 422, { error: 'unsupported', message: "Put it back isn't available here. Edit the text instead." });
      return;
    }
    const leaf = segments[segments.length - 1];
    const textualOk = vaultconfigfields.listTextualGuard(candSplitForPutBack, nextSplit, leaf);
    const pathsOk = vaultconfigfields.pathsGuard(candParsedForPutBack.scriptorium.data, vaultconfigedit.parseWithBothDetailed(setResult.bytes.toString('utf8')).scriptorium.data, [
      { segments, value: nextList },
    ]);
    if (!textualOk || !pathsOk) {
      sendJson(res, 422, { error: 'unsupported', message: "Put it back isn't available here. Edit the text instead." });
      return;
    }
    candResult = { ok: true, bytes: setResult.bytes, frontmatterText: nextSplit.frontmatterText };
    text = nextSplit.frontmatterText;
    nextFrontmatterText = vaultconfigcandidate.editorText(nextSplit);
  }

  const candSplit = vaultconfigedit.splitFileDetailed(candResult.bytes);
  const candParsed = candSplit.ok ? vaultconfigedit.parseWithBothDetailed(candResult.bytes.toString('utf8')) : { ok: false, reason: 'unreadable', line: null };
  if (!candParsed.ok) {
    sendJson(res, 200, { ok: true, parse: { ok: false, line: candParsed.line, message: candParsed.reason }, effects: [], needsAck: false });
    return;
  }

  const curParsed = vaultconfigedit.parseWithBothDetailed(curBytes.toString('utf8'));
  const curData = curParsed.ok ? curParsed.scriptorium.data : null;
  const candData = candParsed.scriptorium.data;

  let rv;
  try {
    rv = candidatecheck.runReview(ctx, { candidateBytes: candResult.bytes, withCheck: false });
  } catch (err) {
    sendJson(res, 503, { error: 'io', message: err.message });
    return;
  }

  const fixable = computeFixable(candSplit, candData);
  const effectsList = vaultconfigeffects.computeEffects({
    cur: curData,
    cand: candData,
    curPublish: rv.curPublish,
    candPublish: rv.candPublish,
    jsonConfig: rv.jsonConfig,
    publishSet: null,
    fixable,
  });

  const responseBody = {
    ok: true,
    parse: { ok: true },
    effects: effectsList,
    needsAck: effectsList.some((e) => e.level === 'bad') || curData === null,
  };
  if (nextFrontmatterText !== undefined) responseBody.frontmatterText = nextFrontmatterText;
  sendJson(res, 200, responseBody);
}

/** Parses the CURRENT on-disk bytes, for Put it back's "current raw list" lookup. */
function curParsedDataFor(curBytes) {
  const parsed = vaultconfigedit.parseWithBothDetailed(curBytes.toString('utf8'));
  return parsed.ok ? parsed.scriptorium.data : {};
}

/** GET /api/vault-config/backups: no lock (read-only). */
function listBackups(req, res, ctx) {
  const notAvailable = (reason) => sendJson(res, 200, { ok: true, available: false, reason, dir: null, keep: KEEP, items: [] });

  if (!ctx.writable) {
    notAvailable(ctx.readOnlyReason);
    return;
  }
  const machineDirResult = machinedir.resolveMachineDir({ configPath: ctx.ctxInfo && ctx.ctxInfo.configPath, vaultPath: ctx.vaultPath });
  if (!machineDirResult.ok) {
    notAvailable(machineDirResult.reason);
    return;
  }
  const listing = backups.listBackups({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath });
  if (!listing.ok) {
    notAvailable(listing.reason);
    return;
  }

  // "before" is derived by comparing each backup with its successor: B_{i-1}, or the current
  // file for i === 0 (the list is already newest-first).
  const items = listing.items.map((item, i) => {
    let restorable = true;
    let reasonText = null;
    let before = 'before a save';

    if (item.size > backups.BACKUP_MAX_BYTES) {
      restorable = false;
      reasonText = "That backup is larger than 4 MiB, so the panel won't restore it.";
    }

    let successorBytes = null;
    if (i === 0) {
      try {
        successorBytes = read.readBytes(vaultconfigwrite.targetPathFor(ctx.vaultPath));
      } catch {
        successorBytes = null;
      }
    } else {
      try {
        successorBytes = backups.readBackup({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, id: listing.items[i - 1].id });
      } catch {
        successorBytes = null;
      }
    }

    let thisBytes = null;
    try {
      thisBytes = backups.readBackup({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, id: item.id });
    } catch (err) {
      restorable = false;
      reasonText = reasonText || "That backup's frontmatter can't be read, so the panel won't restore it.";
    }

    if (thisBytes && successorBytes) {
      const thisParsed = parseForSplitOk(thisBytes);
      const successorParsed = parseForSplitOk(successorBytes);
      before = vaultconfigeffects.summarizeChange(thisParsed, successorParsed);
    }
    if (thisBytes) {
      const split = vaultconfigedit.splitFileDetailed(thisBytes);
      if (!split.ok) {
        restorable = false;
        reasonText = reasonText || "That backup's frontmatter can't be read, so the panel won't restore it.";
      }
    }

    return { id: item.id, takenAt: item.takenAt, size: item.size, before, restorable, reason: restorable ? null : reasonText };
  });

  sendJson(res, 200, { ok: true, available: true, reason: null, dir: listing.dir, keep: KEEP, items });
}

/** read.parseFrontmatterText on split-ok text, else null (for backup labels). */
function parseForSplitOk(bytes) {
  const split = vaultconfigedit.splitFileDetailed(bytes);
  if (!split.ok) return null;
  const parsed = read.parseFrontmatterText(bytes.toString('utf8'));
  return parsed.ok ? parsed.data : null;
}

const DEFAULT_LISTS = ['exclude_fields', 'exclude_sections'];

function containsCI(list, x) {
  const lower = String(x).toLowerCase();
  return list.some((y) => String(y).toLowerCase() === lower);
}

/**
 * GET /api/vault-config/fields (V1e-10, SD-110): no lock, read-only. The frontmatter as the field
 * layout needs it: each editable setting's value and located shape, the read-only display values,
 * the keys the layout doesn't cover, how many census pages carry each hidden-field name, and the
 * pin defaults the effective lists no longer include.
 */
function getFields(req, res, ctx) {
  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }
  let target;
  try {
    ({ target } = vaultconfigwrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    sendJson(res, 422, { error: 'unsupported', message: err.message });
    return;
  }
  let bytes;
  try {
    bytes = read.readBytes(target);
  } catch (err) {
    sendJson(res, 503, { error: 'io', message: err.message });
    return;
  }
  const split = vaultconfigedit.splitFileDetailed(bytes);
  if (!split.ok) {
    sendJson(res, 422, { error: 'unsupported', message: vaultconfigcandidate.EDITOR_REASON[split.code] });
    return;
  }
  const parsed = vaultconfigedit.parseWithBothDetailed(bytes.toString('utf8'));
  if (!parsed.ok) {
    sendJson(res, 422, { error: 'unsupported', message: 'The frontmatter in vault-config.md doesn\'t read, so the fields can\'t be shown. Use "Edit as text instead".' });
    return;
  }
  const data = parsed.scriptorium.data;

  const fields = vaultconfigfields.FIELD_SCHEMA.map((f) => {
    const segments = f.path.split('.');
    const value = vaultconfigfields.getPath(data, segments);
    const plan = vaultconfigfields.locatePath(split, data, segments);
    return {
      path: f.path,
      kind: f.kind,
      group: f.group,
      label: f.label,
      value: value === undefined ? null : value,
      shape: plan.ok ? plan.shape : null,
      form: plan.ok ? null : plan.form,
    };
  });
  const display = vaultconfigfields.DISPLAY_PATHS.map((d) => {
    const value = vaultconfigfields.getPath(data, d.path.split('.'));
    return { path: d.path, group: d.group, label: d.label, value: value === undefined ? null : value };
  });

  // Keys the layout covers neither as a field nor as a display value.
  const coveredPublish = new Set(['exclude_fields', 'exclude_sections', 'exclude_dirs', 'landing', 'four_oh_four', 'mode', 'theme', 'banners']);
  const coveredTheme = new Set(['palette', 'fonts', 'campaign_image', 'genre']);
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const unknown = [];
  for (const k of Object.keys(data)) if (k !== 'publish') unknown.push(k);
  const publish = own(data, 'publish') && data.publish && typeof data.publish === 'object' && !Array.isArray(data.publish) ? data.publish : null;
  if (publish) {
    for (const k of Object.keys(publish)) if (!coveredPublish.has(k)) unknown.push('publish.' + k);
    const theme = own(publish, 'theme') && publish.theme && typeof publish.theme === 'object' && !Array.isArray(publish.theme) ? publish.theme : null;
    if (theme) for (const k of Object.keys(theme)) if (!coveredTheme.has(k)) unknown.push('publish.theme.' + k);
  }

  let jsonConfig = null;
  try {
    jsonConfig = checkcli.resolveVaultContext(ctx.ctxInfo).jsonConfig;
  } catch {
    jsonConfig = null;
  }
  const effective = publishset.loadPublishConfig(ctx.vaultPath, jsonConfig || {}).publishConfig;

  const rawFields = publish && Array.isArray(publish.exclude_fields) ? publish.exclude_fields.filter((x) => typeof x === 'string') : [];
  const names = Array.from(new Set(rawFields.concat(pinned.PUBLISH_DEFAULTS.exclude_fields || [])));
  const counts = new Map(names.map((name) => [name, 0]));
  const index = vaultindex.buildResolutionIndex(ctx.vaultPath, jsonConfig || {});
  for (const f of index.files) {
    if (!f.ok || !f.data || typeof f.data !== 'object') continue;
    for (const name of names) {
      if (own(f.data, name)) counts.set(name, counts.get(name) + 1);
    }
  }

  const missingDefaults = {};
  for (const listKey of DEFAULT_LISTS) {
    const eff = Array.isArray(effective[listKey]) ? effective[listKey] : [];
    missingDefaults[listKey] = (pinned.PUBLISH_DEFAULTS[listKey] || []).filter((d) => !containsCI(eff, d));
  }

  sendJson(res, 200, { ok: true, sha256: sha256Hex(bytes), fields, display, unknown, usage: Object.fromEntries(counts), missingDefaults });
}

module.exports = { editorView, effects, listBackups, saveText, saveFields, getFields, restore, HandlerRefusal };
