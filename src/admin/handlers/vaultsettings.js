'use strict';

const crypto = require('crypto');
const respond = require('../respond');
const body = require('../body');
const freshness = require('../freshness');
const { runExclusive } = require('../context');
// Every dependency below is called through its module object (never destructured at require
// time), so a test can inject a throw or a wrong value at exactly one call site.
const vaultsettingswrite = require('../../vault/vaultsettingswrite');
const vaultsettingsplan = require('../vaultsettingsplan');
const vaultsettingscandidate = require('../vaultsettingscandidate');
const settingsfile = require('../settingsfile');
const pinned = require('../../generator/pinned');
const machinedir = require('../../config/machinedir');
const backups = require('../../config/backups');
const read = require('../../vault/read');
const { readSettingsFiles } = require('../../vault/publishset');
const { validateTitle, validateTagline } = require('../../setup/validate');
const { ConfigError, ScriptoriumError } = require('../../util/errors');

/*
 * The Title & tagline view of a vault whose settings live in _meta/vault-config.yaml: the view's
 * server data (settingsView, the `?include=settings` part of GET /api/state) and the one route that
 * saves the title and the tagline together (POST /api/vault-config/title). Both values go to the
 * yaml in a single planned edit and a single file write, with a backup outside the vault first.
 * No check runs on this save, as for the vault-config.md tagline (ADR 0033 section 6).
 */

const BASE_SHA_RE = /^[0-9a-f]{64}$/;
const ALLOWED_KEYS = ['file', 'baseSha256', 'title', 'tagline', 'dryRun'];
const FILE = settingsfile.FILE_YAML;
const YAML_REL = '_meta/vault-config.yaml';
const CHANGED = 'vault-config.yaml changed outside the panel. Reload before saving.';

const TITLE_SAVED_NOTE = "Saved in the vault's settings file, _meta/vault-config.yaml.";
const NO_TITLE_NOTE = 'No site title is set in _meta/vault-config.yaml yet. Saving one adds it there.';

/** A specific, already-decided HTTP response, thrown from inside the write-locked section. */
class TitleRefusal extends Error {
  constructor(status, payload) {
    super('vault-config.yaml title refusal');
    this.status = status;
    this.payload = payload;
  }
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const textOrNull = (v) => (typeof v === 'string' ? v : null);

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

/**
 * GET /api/state's `?include=settings` payload. Never throws.
 *
 * @param {object} ctx
 * @returns {null | { file: string, sha256: string|null, title: string|null, titleNote: string, tagline: string|null,
 *   editable: boolean, reason: string|null, backupDir: string|null, error: string|null }}
 *   null unless the vault keeps its settings in _meta/vault-config.yaml
 */
function settingsView(ctx) {
  if (ctx.settingsLayout !== 'new') return null;
  const view = { file: YAML_REL, sha256: null, title: null, titleNote: NO_TITLE_NOTE, tagline: null, editable: false, reason: null, backupDir: null, error: null };

  const machine = machinedir.resolveMachineDir({ configPath: ctx.ctxInfo && ctx.ctxInfo.configPath, vaultPath: ctx.vaultPath });
  if (machine.ok) view.backupDir = backups.backupDirFor(machine.dir, ctx.campaign);

  let reason = null;
  if (!ctx.writable) reason = ctx.readOnlyReason;
  else if (!machine.ok) reason = machine.reason;

  try {
    const { target } = vaultsettingswrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign });
    view.sha256 = sha256Hex(read.readBytes(target));
    const { values, origins } = pinned.readSettingValues(ctx.vaultPath, {}, readSettingsFiles(ctx.vaultPath));
    const site = (values && values.player_site) || {};
    view.title = origins['player_site.title'] === 'file' ? textOrNull(site.title) : null;
    view.tagline = origins['player_site.theme.tagline'] === 'file' ? textOrNull(site.theme && site.theme.tagline) : null;
    view.titleNote = view.title === null ? NO_TITLE_NOTE : TITLE_SAVED_NOTE;
  } catch (err) {
    view.error = String(err.message).replace(/\s+/g, ' ');
    if (reason === null) reason = view.error;
  }
  view.editable = reason === null;
  view.reason = reason;
  return view;
}

/** The campaign id the live stats and the inbox are keyed on, before and after, when the title change moves it. */
function campaignIdChange(ctx, curBytes, candBytes) {
  const read1 = (bytes) => pinned.readSettingValues(ctx.vaultPath, {}, { md: null, yaml: bytes.toString('utf8') }).values.player_site || {};
  const cur = read1(curBytes);
  const features = cur.features || {};
  if (features.live_stats !== true && features.inbox !== true) return null;
  const before = pinned.slugify(cur.title || 'campaign');
  const after = pinned.slugify(read1(candBytes).title || 'campaign');
  return before === after ? null : { before, after };
}

/** Steps after the lock is taken: runs for both the dry run and the confirm. */
function readPlanWrite(ctx, { fields, baseSha256, dryRun, machineDirResult, backupDir }) {
  const moved = settingsfile.fileMismatch(ctx, FILE);
  if (moved) throw new TitleRefusal(moved.status, moved.payload);

  let target;
  try {
    ({ target } = vaultsettingswrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    if (err instanceof vaultsettingswrite.VaultSettingsChangedError) throw new TitleRefusal(409, { error: 'changed', message: err.message });
    throw new TitleRefusal(422, { error: 'unsupported', message: err.message });
  }

  const curBytes = read.readBytes(target);
  const curSha = sha256Hex(curBytes);
  if (curSha !== baseSha256) throw new TitleRefusal(409, { error: 'changed', message: CHANGED });

  let plan;
  try {
    plan = vaultsettingsplan.planTitleTagline(ctx.vaultPath, curBytes, fields);
  } catch (err) {
    if (err instanceof pinned.SettingsPlanError) throw new TitleRefusal(422, { error: 'unsupported', message: err.message });
    throw err;
  }

  if (plan.bytes.equals(curBytes)) {
    return { status: 200, body: { ok: true, unchanged: true, dryRun, file: FILE, sha256: curSha, warnings: [] } };
  }

  if (dryRun) {
    const out = {
      ok: true,
      dryRun: true,
      file: FILE,
      before: vaultsettingscandidate.yamlEditorText(vaultsettingscandidate.splitYamlFile(curBytes)),
      after: vaultsettingscandidate.yamlEditorText(vaultsettingscandidate.splitYamlFile(plan.bytes)),
      changed: plan.changed,
      backupDir,
      warnings: [],
    };
    let id = null;
    try {
      id = campaignIdChange(ctx, curBytes, plan.bytes);
    } catch {
      // A file the pin cannot read gives no campaign id to compare; the plan itself already succeeded.
    }
    if (id) out.campaignId = id;
    return { status: 200, body: out };
  }

  try {
    const result = vaultsettingswrite.replaceVaultSettingsYaml(ctx.vaultPath, plan.bytes, {
      expectedSha256: curSha,
      campaign: ctx.campaign,
      backup: (currentFileBytes) =>
        backups.backupThenPrune({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, bytes: currentFileBytes, file: FILE }),
    });
    return { status: 200, body: { ok: true, file: FILE, sha256: result.sha256, backupPath: result.backup.path, warnings: [] } };
  } catch (err) {
    if (err instanceof vaultsettingswrite.VaultSettingsChangedError) throw new TitleRefusal(409, { error: 'changed', message: err.message });
    if (err instanceof backups.BackupError) throw new TitleRefusal(503, { error: 'io', message: err.message });
    if (err instanceof ConfigError) throw new TitleRefusal(422, { error: 'unsupported', message: err.message });
    if (err instanceof ScriptoriumError) throw new TitleRefusal(503, { error: 'io', message: err.message });
    throw err;
  }
}

/** POST /api/vault-config/title. */
async function saveTitleTagline(req, res, ctx) {
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
  if (parsed.file !== FILE) {
    sendJson(res, 400, { error: 'invalid', message: `file must be "${FILE}"` });
    return;
  }
  if (typeof parsed.baseSha256 !== 'string' || !BASE_SHA_RE.test(parsed.baseSha256)) {
    sendJson(res, 400, { error: 'invalid', message: 'baseSha256 must be 64 lowercase hex characters' });
    return;
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(parsed, k);
  if (!has('title') && !has('tagline')) {
    sendJson(res, 400, { error: 'invalid', message: 'give a title or a tagline to save' });
    return;
  }
  const fields = {};
  try {
    if (has('title')) {
      if (typeof parsed.title !== 'string') throw new ConfigError('title must be a string');
      fields.title = validateTitle(parsed.title);
    }
    if (has('tagline')) {
      if (typeof parsed.tagline !== 'string') throw new ConfigError('tagline must be a string');
      fields.tagline = validateTagline(parsed.tagline);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      sendJson(res, 400, { error: 'invalid', message: err.message });
      return;
    }
    throw err;
  }
  const dryRun = has('dryRun') ? parsed.dryRun : false;
  if (typeof dryRun !== 'boolean') {
    sendJson(res, 400, { error: 'invalid', message: 'dryRun must be a boolean' });
    return;
  }

  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }
  const mismatch = settingsfile.fileMismatch(ctx, FILE);
  if (mismatch) {
    sendJson(res, mismatch.status, mismatch.payload);
    return;
  }
  const machineDirResult = machinedir.resolveMachineDir({ configPath: ctx.ctxInfo && ctx.ctxInfo.configPath, vaultPath: ctx.vaultPath });
  if (!machineDirResult.ok) {
    sendJson(res, 503, { error: 'unavailable', message: machineDirResult.reason });
    return;
  }
  const backupDir = backups.backupDirFor(machineDirResult.dir, ctx.campaign);

  let outcome;
  try {
    outcome = await runExclusive(ctx, 'write', () => readPlanWrite(ctx, { fields, baseSha256: parsed.baseSha256, dryRun, machineDirResult, backupDir }));
  } catch (err) {
    if (err instanceof TitleRefusal) {
      sendJson(res, err.status, err.payload);
      return;
    }
    throw err;
  }
  if (!outcome.ok) {
    sendJson(res, 409, { error: 'busy', busy: outcome.busy });
    return;
  }
  // A dry run and an unchanged confirm never write, so noteSaveIfWritten leaves the counter alone for both.
  freshness.noteSaveIfWritten(ctx, outcome.value);
  sendJson(res, outcome.value.status, outcome.value.body);
}

module.exports = { saveTitleTagline, settingsView, TITLE_SAVED_NOTE, NO_TITLE_NOTE };
