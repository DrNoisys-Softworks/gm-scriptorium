'use strict';

const crypto = require('crypto');
const respond = require('../respond');
const { JSON_BODY_CAP } = require('../body');
// Every dependency below is called through its module object (never destructured at require
// time), so a test can inject a throw or a wrong value at exactly one call site, as the
// vault-config.md editor's handlers do.
const vaultsettingswrite = require('../../vault/vaultsettingswrite');
const vaultsettingscandidate = require('../vaultsettingscandidate');
const vaultsettingseffects = require('../vaultsettingseffects');
const vaultsettingsplan = require('../vaultsettingsplan');
const vaultconfigfields = require('../vaultconfigfields');
const vaultconfigeffects = require('../vaultconfigeffects');
const candidatecheck = require('../candidatecheck');
const checkcli = require('../../cli/check');
const publishset = require('../../vault/publishset');
const vaultindex = require('../../vault/index');
const pinned = require('../../generator/pinned');
const machinedir = require('../../config/machinedir');
const backups = require('../../config/backups');
const read = require('../../vault/read');
const settingsfile = require('../settingsfile');
const { ConfigError, ScriptoriumError } = require('../../util/errors');

/*
 * The settings editor's server side for a vault whose settings live in _meta/vault-config.yaml:
 * the twin of the vault-config.md editor in vaultconfigeditor.js, with the same review, backups and
 * conflict checks. The whole file is edited, as text or through the seven fields. Every write goes
 * through src/vault/vaultsettingswrite.js, with a backup outside the vault first; nothing else here
 * writes. Field and put-back edits are planned by the pinned generator's own writer, which keeps
 * the GM's comments.
 */

const KEEP = 20;
const FILE = settingsfile.FILE_YAML;
const TARGET_REL = candidatecheck.VAULT_SETTINGS_REL;

const CHANGED = 'vault-config.yaml changed outside the panel. Reload before saving.';
const REQUEST_TOO_LARGE = 'vault-config.yaml is too large to send back from the browser in one save (the limit is 64 KiB). Edit it by hand.';
const EDIT_AS_TEXT = 'Use "Edit as text instead".';
const PUT_BACK_UNAVAILABLE = "Put it back isn't available here. Edit the text instead.";
const BACKUP_UNREADABLE = "That backup can't be read, so the panel won't restore it.";

/** A specific, already-decided HTTP response, thrown from inside the write-locked section. */
class VaultSettingsRefusal extends Error {
  constructor(status, payload) {
    super('vault-config.yaml editor refusal');
    this.status = status;
    this.payload = payload;
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

function loneCrReason(line) {
  return vaultsettingscandidate.YAML_EDITOR_REASON['lone-cr'].replace('<N>', String(line));
}

/** Whether the browser can send `text` back in one save: its largest save request must fit the limit. */
function requestFits(text) {
  const request = { file: FILE, frontmatterText: text, baseSha256: '0'.repeat(64), dryRun: false, saveAnyway: true, reviewedSha256: '0'.repeat(64) };
  return Buffer.byteLength(JSON.stringify(request), 'utf8') <= JSON_BODY_CAP;
}

function lineMessage(line, message) {
  return line === null || line === undefined ? message : `Line ${line}: ${message}`;
}

function machineDirFor(ctx) {
  return machinedir.resolveMachineDir({ configPath: ctx.ctxInfo && ctx.ctxInfo.configPath, vaultPath: ctx.vaultPath });
}

function getAt(data, name) {
  let cur = data;
  for (const seg of name.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** The three hide lists, as field entries: `path` the yaml's name, `key` the old one. */
function privacyLists() {
  return vaultsettingsplan.YAML_FIELD_SCHEMA.filter((f) => vaultconfigeffects.PRIVACY_LIST_PATHS.includes(f.key));
}

/** The OLD names of the hide lists the candidate holds as a list, so a fix can put an entry back. */
function computeFixable(candData) {
  const fixable = new Set();
  for (const f of privacyLists()) {
    if (Array.isArray(getAt(candData, f.path))) fixable.add(f.key);
  }
  return fixable;
}

/**
 * GET /api/state's `?include=vaultconfigeditor` payload on the yaml. Never throws.
 *
 * @param {object} ctx
 * @returns {{exists, file, sha256, text, eol, lineCount, canEdit, reason, parse, backupDir, keep}}
 */
function editorViewYaml(ctx) {
  const empty = { exists: false, file: FILE, sha256: null, text: null, eol: null, lineCount: null, canEdit: false, reason: null, parse: null, backupDir: null, keep: KEEP };

  let target;
  try {
    ({ target } = vaultsettingswrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    return { ...empty, reason: err.message };
  }

  const machineDirResult = machineDirFor(ctx);
  const backupDir = machineDirResult.ok ? backups.backupDirFor(machineDirResult.dir, ctx.campaign) : null;

  let bytes;
  try {
    bytes = read.readBytes(target);
  } catch (err) {
    return { ...empty, exists: true, reason: err.message, backupDir };
  }
  const sha256 = sha256Hex(bytes);

  const split = vaultsettingscandidate.splitYamlFile(bytes);
  if (!split.ok) {
    return { ...empty, exists: true, sha256, reason: vaultsettingscandidate.YAML_EDITOR_REASON[split.code], backupDir };
  }

  const text = vaultsettingscandidate.yamlEditorText(split);
  const eol = split.eol === '\r\n' ? 'crlf' : 'lf';
  const lineCount = split.lines.length;

  const parsed = pinned.parseSettingsText(ctx.vaultPath, bytes);
  const parse = parsed.ok ? { ok: true } : { ok: false, line: parsed.line, message: parsed.message };

  const loneCr = vaultsettingscandidate.yamlLoneCrLine(split);
  const fits = requestFits(text);

  let reason = null;
  if (!ctx.writable) reason = ctx.readOnlyReason;
  else if (!machineDirResult.ok) reason = machineDirResult.reason;
  else if (loneCr !== null) reason = loneCrReason(loneCr);
  else if (!fits) reason = REQUEST_TOO_LARGE;

  const canEdit = ctx.writable && machineDirResult.ok && loneCr === null && fits;

  return { exists: true, file: FILE, sha256, text, eol, lineCount, canEdit, reason, parse, backupDir, keep: KEEP };
}

/**
 * The `fields` route's `set` on the yaml, checked before any lock: 1 to 7 keys, each an exact
 * member of the yaml's field names, each value valid for its kind.
 *
 * @returns {{edits: object} | {refusal: {status: number, payload: object}}}
 */
function validateYamlFieldsBody(reqBody) {
  const set = reqBody.set;
  const bad = (message) => ({ refusal: { status: 400, payload: { error: 'invalid', message } } });
  const max = vaultsettingsplan.YAML_FIELD_SCHEMA.length;
  if (typeof set !== 'object' || set === null || Array.isArray(set)) return bad('set must be an object of settings to change');
  const keys = Object.keys(set);
  if (keys.length < 1 || keys.length > max) return bad('set must name 1 to ' + max + ' settings');
  for (const key of keys) {
    if (!vaultsettingsplan.YAML_FIELD_BY_PATH.has(key)) return bad('unknown setting: ' + key);
  }
  const edits = {};
  for (const key of keys) {
    const entry = vaultsettingsplan.YAML_FIELD_BY_PATH.get(key);
    const problem = vaultconfigfields.validateFieldValue(vaultconfigfields.FIELD_BY_PATH.get(entry.key), set[key]);
    if (problem !== null) return bad(problem);
    edits[key] = set[key];
  }
  return { edits };
}

/** A SettingsPlanError from a field plan, as the response it gives. */
function planRefusal(err) {
  if (err.kind === 'unreadable') {
    return new VaultSettingsRefusal(400, { error: 'invalid', message: lineMessage(err.line, err.message), line: err.line });
  }
  if (err.kind === 'refused' || err.kind === 'not-made') {
    const message = err.message.includes(EDIT_AS_TEXT) ? err.message : `${err.message} ${EDIT_AS_TEXT}`;
    return new VaultSettingsRefusal(422, { error: 'unsupported', message });
  }
  return new VaultSettingsRefusal(422, { error: 'unsupported', message: err.message });
}

function buildCandidate(ctx, { op, reqBody, split, curBytes, edits, machineDirResult }) {
  if (op === 'text') {
    const result = vaultsettingscandidate.buildYamlTextCandidate(split, reqBody.frontmatterText);
    if (!result.ok) throw new VaultSettingsRefusal(400, { error: 'invalid', message: lineMessage(result.line, result.message), line: result.line });
    return { bytes: result.bytes };
  }
  if (op === 'fields') {
    try {
      return { bytes: vaultsettingsplan.planFieldEdits(ctx.vaultPath, curBytes, edits).bytes };
    } catch (err) {
      if (err instanceof pinned.SettingsPlanError) throw planRefusal(err);
      throw err;
    }
  }
  let backupBytes;
  try {
    backupBytes = backups.readBackup({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, id: reqBody.backupId, kind: 'yaml' });
  } catch (err) {
    if (err instanceof backups.BackupNotListedError) throw new VaultSettingsRefusal(400, { error: 'invalid', message: err.message });
    if (err instanceof backups.BackupTooLargeError) throw new VaultSettingsRefusal(422, { error: 'unsupported', message: err.message });
    throw new VaultSettingsRefusal(503, { error: 'io', message: err.message });
  }
  const result = vaultsettingscandidate.buildYamlRestoreCandidate(split, backupBytes);
  if (!result.ok) throw new VaultSettingsRefusal(422, { error: 'unsupported', message: BACKUP_UNREADABLE });
  return { bytes: result.bytes, eolChanged: result.eolChanged, backupId: reqBody.backupId };
}

function buildNotes({ op, split, cand }) {
  const notes = [];
  if (split.eol === '\r\n') notes.push("Saved with this file's own Windows (CRLF) line endings.");
  if (op === 'restore' && cand.eolChanged) notes.push("The backup's line endings are changed to match this file.");
  return notes;
}

/**
 * The review pipeline for the yaml (dry run and confirm alike), run inside runExclusive.
 *
 * @param {object} ctx
 * @param {{op: 'text'|'fields'|'restore', reqBody: object, dryRun: boolean, machineDirResult: object, edits?: object}} opts
 * @returns {{status: number, body: object}}
 * @throws {VaultSettingsRefusal}
 */
function reviewYamlInner(ctx, { op, reqBody, dryRun, machineDirResult, edits }) {
  let target;
  try {
    ({ target } = vaultsettingswrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    if (err instanceof vaultsettingswrite.VaultSettingsChangedError) throw new VaultSettingsRefusal(409, { error: 'changed', message: err.message });
    throw new VaultSettingsRefusal(422, { error: 'unsupported', message: err.message });
  }

  const curBytes = read.readBytes(target);
  const curSha = sha256Hex(curBytes);
  if (curSha !== reqBody.baseSha256) throw new VaultSettingsRefusal(409, { error: 'changed', message: CHANGED });

  const split = vaultsettingscandidate.splitYamlFile(curBytes);
  if (!split.ok) throw new VaultSettingsRefusal(422, { error: 'unsupported', message: vaultsettingscandidate.YAML_EDITOR_REASON[split.code] });
  const loneCr = vaultsettingscandidate.yamlLoneCrLine(split);
  if (loneCr !== null) throw new VaultSettingsRefusal(422, { error: 'unsupported', message: loneCrReason(loneCr) });

  const cand = buildCandidate(ctx, { op, reqBody, split, curBytes, edits, machineDirResult });

  if (cand.bytes.equals(curBytes)) {
    return { status: 200, body: { ok: true, unchanged: true, dryRun, op, file: FILE, sha256: curSha, warnings: [] } };
  }

  // The pin's own reading of the candidate comes first: one it cannot read never reaches the check.
  const candParsed = pinned.parseSettingsText(ctx.vaultPath, cand.bytes);
  if (!candParsed.ok) {
    throw new VaultSettingsRefusal(400, { error: 'invalid', message: lineMessage(candParsed.line, candParsed.message), line: candParsed.line });
  }
  const curParsed = pinned.parseSettingsText(ctx.vaultPath, curBytes);
  const curData = curParsed.ok ? curParsed.data : null;
  const candData = candParsed.data;

  const commands = vaultsettingseffects.commandSettingsChanged(curData, candData);
  if (commands.length > 0) {
    throw new VaultSettingsRefusal(422, { error: 'unsupported', message: vaultsettingseffects.COMMAND_REFUSAL(commands) });
  }

  const candidateSha256 = sha256Hex(cand.bytes);
  const cached = ctx.vaultConfigReview;
  const cacheMatches =
    !dryRun && cached && cached.file === FILE && cached.op === op && cached.baseSha256 === curSha && cached.candidateSha256 === candidateSha256;

  let rv;
  let check;
  let publishDiff;
  try {
    if (cacheMatches) {
      rv = candidatecheck.runReview(ctx, { candidateBytes: cand.bytes, withCheck: false, targetRel: TARGET_REL });
      check = cached.check;
      publishDiff = cached.publishDiff;
    } else {
      rv = candidatecheck.runReview(ctx, { candidateBytes: cand.bytes, withCheck: true, targetRel: TARGET_REL });
      check = rv.check;
      publishDiff = rv.publishDiff;
    }
  } catch (err) {
    if (err instanceof candidatecheck.CandidateCheckError) throw new VaultSettingsRefusal(503, { error: 'io', message: err.message });
    throw err;
  }

  const effects = vaultsettingseffects.effectsForYaml({
    cur: curData,
    cand: candData,
    curPublish: rv.curPublish,
    candPublish: rv.candPublish,
    jsonConfig: rv.jsonConfig,
    publishSet: rv.candPublishSet,
    fixable: computeFixable(candData),
    publishDiff,
  });

  if (check.ran && check.unforceable.length > 0) {
    throw new VaultSettingsRefusal(422, {
      error: 'refused-by-check',
      message: `The check on the edited copy refuses this file: ${check.unforceable[0].message}. Nothing was written, and Save anyway can't override this.`,
      check,
    });
  }

  const reasons = candidatecheck.computeReasons({ effects, check, curData, publishDiff });
  const needsAck = reasons.length > 0;
  const notes = buildNotes({ op, split, cand });

  if (dryRun) {
    ctx.vaultConfigReview = { file: FILE, op, baseSha256: curSha, candidateSha256, check, reasons, publishDiff };
    const dryBody = {
      ok: true,
      dryRun: true,
      op,
      file: FILE,
      before: vaultsettingscandidate.yamlEditorText(split),
      after: vaultsettingscandidate.yamlEditorText(vaultsettingscandidate.splitYamlFile(cand.bytes)),
      backupDir: machineDirResult.ok ? backups.backupDirFor(machineDirResult.dir, ctx.campaign) : null,
      effects,
      check,
      needsAck,
      reasons,
      notes,
      candidateSha256,
      warnings: [],
    };
    if (op === 'restore') dryBody.backup = { id: cand.backupId, takenAt: backups.takenAtFor(cand.backupId) };
    return { status: 200, body: dryBody };
  }

  if (reqBody.reviewedSha256 !== candidateSha256) {
    throw new VaultSettingsRefusal(409, { error: 'changed', message: 'vault-config.yaml or the backup changed since you reviewed it. Review again.' });
  }
  if (needsAck && reqBody.saveAnyway !== true) {
    throw new VaultSettingsRefusal(422, { error: 'needs-ack', message: 'Tick "Save anyway" to save this. Nothing was written.', reasons });
  }
  ctx.vaultConfigReview = null;

  try {
    const result = vaultsettingswrite.replaceVaultSettingsYaml(ctx.vaultPath, cand.bytes, {
      expectedSha256: curSha,
      campaign: ctx.campaign,
      backup: (currentFileBytes) =>
        backups.backupThenPrune({ machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, bytes: currentFileBytes, file: FILE }),
    });
    return { status: 200, body: { ok: true, op, file: FILE, sha256: result.sha256, backupPath: result.backup.path, warnings: [] } };
  } catch (err) {
    if (err instanceof vaultsettingswrite.VaultSettingsChangedError) throw new VaultSettingsRefusal(409, { error: 'changed', message: err.message });
    if (err instanceof backups.BackupError) throw new VaultSettingsRefusal(503, { error: 'io', message: err.message });
    if (err instanceof ConfigError) throw new VaultSettingsRefusal(422, { error: 'unsupported', message: err.message });
    if (err instanceof ScriptoriumError) throw new VaultSettingsRefusal(503, { error: 'io', message: err.message });
    throw err;
  }
}

/** A put-back request, or null when it does not name one of the three hide lists and a plain entry. */
function validPutBack(pb) {
  if (typeof pb !== 'object' || pb === null) return null;
  const list = privacyLists().find((f) => f.path === pb.path);
  if (!list || typeof pb.entry !== 'string' || pb.entry.length < 1 || pb.entry.length > 200 || /[\u0000-\u001f]/.test(pb.entry)) return null;
  return { path: pb.path, entry: pb.entry };
}

/**
 * POST /api/vault-config/effects on the yaml: no lock (read-only). The caller has already checked
 * the request's shape, that the campaign is writable and that it names this file.
 *
 * @param {object} ctx
 * @param {{frontmatterText: string, baseSha256: string, putBack?: object}} parsed the request body
 * @param {object} res
 */
function effectsYaml(ctx, parsed, res) {
  let target;
  try {
    ({ target } = vaultsettingswrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    if (err instanceof vaultsettingswrite.VaultSettingsChangedError) {
      sendJson(res, 409, { error: 'changed', message: err.message });
      return;
    }
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
  if (sha256Hex(curBytes) !== parsed.baseSha256) {
    sendJson(res, 409, { error: 'changed', message: CHANGED });
    return;
  }
  const split = vaultsettingscandidate.splitYamlFile(curBytes);
  if (!split.ok) {
    sendJson(res, 422, { error: 'unsupported', message: vaultsettingscandidate.YAML_EDITOR_REASON[split.code] });
    return;
  }

  let putBack = null;
  if (parsed.putBack !== undefined) {
    putBack = validPutBack(parsed.putBack);
    if (putBack === null) {
      sendJson(res, 400, { error: 'invalid', message: 'putBack must name an existing privacy list and a plain entry' });
      return;
    }
  }

  const parseFailed = (line, message) => sendJson(res, 200, { ok: true, parse: { ok: false, line, message }, effects: [], needsAck: false });

  const candResult = vaultsettingscandidate.buildYamlTextCandidate(split, parsed.frontmatterText);
  if (!candResult.ok) {
    parseFailed(candResult.line, candResult.message);
    return;
  }
  let candBytes = candResult.bytes;
  let candParsed = pinned.parseSettingsText(ctx.vaultPath, candBytes);
  if (!candParsed.ok) {
    parseFailed(candParsed.line, candParsed.message);
    return;
  }

  let nextText;
  if (putBack) {
    const list = getAt(candParsed.data, putBack.path);
    const already = Array.isArray(list) && list.some((x) => String(x).toLowerCase() === putBack.entry.toLowerCase());
    if (!already) {
      try {
        candBytes = vaultsettingsplan.planPutBack(ctx.vaultPath, candBytes, putBack).bytes;
      } catch (err) {
        if (!(err instanceof pinned.SettingsPlanError)) throw err;
        sendJson(res, 422, { error: 'unsupported', message: PUT_BACK_UNAVAILABLE });
        return;
      }
      candParsed = pinned.parseSettingsText(ctx.vaultPath, candBytes);
      const nextSplit = vaultsettingscandidate.splitYamlFile(candBytes);
      if (!candParsed.ok || !nextSplit.ok) {
        sendJson(res, 422, { error: 'unsupported', message: PUT_BACK_UNAVAILABLE });
        return;
      }
    }
    nextText = vaultsettingscandidate.yamlEditorText(vaultsettingscandidate.splitYamlFile(candBytes));
  }

  const curParsed = pinned.parseSettingsText(ctx.vaultPath, curBytes);
  const curData = curParsed.ok ? curParsed.data : null;

  let rv;
  try {
    rv = candidatecheck.runReview(ctx, { candidateBytes: candBytes, withCheck: false, targetRel: TARGET_REL, publishDiffWhenItCanChange: true });
  } catch (err) {
    sendJson(res, 503, { error: 'io', message: err.message });
    return;
  }

  const effectsList = vaultsettingseffects.effectsForYaml({
    cur: curData,
    cand: candParsed.data,
    curPublish: rv.curPublish,
    candPublish: rv.candPublish,
    jsonConfig: rv.jsonConfig,
    publishSet: null,
    fixable: computeFixable(candParsed.data),
    publishDiff: rv.publishDiff,
  });

  const body = { ok: true, parse: { ok: true }, effects: effectsList, needsAck: effectsList.some((e) => e.level === 'bad') || curData === null };
  if (nextText !== undefined) body.frontmatterText = nextText;
  sendJson(res, 200, body);
}

/** The yaml's tree from bytes, in the old file's shape, or null when the pin cannot read it. */
function oldShapeOf(ctx, bytes) {
  if (!bytes) return null;
  const parsed = pinned.parseSettingsText(ctx.vaultPath, bytes);
  return parsed.ok ? vaultsettingseffects.toOldShape(parsed.data).old : null;
}

/**
 * GET /api/vault-config/backups on the yaml: no lock (read-only). The caller has already checked
 * that the campaign is writable and that its machine folder can hold backups.
 *
 * @returns {{status: number, body: object}}
 */
function listBackupsYaml(ctx, machineDirResult) {
  const where = { machineDir: machineDirResult.dir, campaign: ctx.campaign, vaultPath: ctx.vaultPath, kind: 'yaml' };
  const listing = backups.listBackups(where);
  if (!listing.ok) {
    return { status: 200, body: { ok: true, available: false, reason: listing.reason, dir: null, keep: KEEP, items: [] } };
  }

  const readOrNull = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  // "before" compares each backup with the one after it: the next newer copy, or the file itself
  // for the newest (the list is already newest-first).
  const items = listing.items.map((item, i) => {
    let restorable = true;
    let reasonText = null;
    let before = 'before a save';

    if (item.size > backups.BACKUP_MAX_BYTES) {
      restorable = false;
      reasonText = "That backup is larger than 4 MiB, so the panel won't restore it.";
    }

    const successorBytes =
      i === 0
        ? readOrNull(() => read.readBytes(vaultsettingswrite.targetPathFor(ctx.vaultPath)))
        : readOrNull(() => backups.readBackup({ ...where, id: listing.items[i - 1].id }));
    const thisBytes = readOrNull(() => backups.readBackup({ ...where, id: item.id }));

    if (thisBytes === null) {
      restorable = false;
      reasonText = reasonText || BACKUP_UNREADABLE;
    } else {
      if (successorBytes) before = vaultconfigeffects.summarizeChange(oldShapeOf(ctx, thisBytes), oldShapeOf(ctx, successorBytes));
      if (!vaultsettingscandidate.splitYamlFile(thisBytes).ok) {
        restorable = false;
        reasonText = reasonText || BACKUP_UNREADABLE;
      }
    }

    return { id: item.id, takenAt: item.takenAt, size: item.size, before, restorable, reason: restorable ? null : reasonText };
  });

  return { status: 200, body: { ok: true, available: true, reason: null, dir: listing.dir, keep: KEEP, items } };
}

const DEFAULT_LISTS = ['exclude_fields', 'exclude_sections'];

function containsCI(list, x) {
  const lower = String(x).toLowerCase();
  return list.some((y) => String(y).toLowerCase() === lower);
}

/**
 * GET /api/vault-config/fields on the yaml: no lock, read-only. The caller has already checked
 * that the campaign is writable. The same response as the vault-config.md one, with each row named
 * by the yaml's own name (`path`) and by its old one (`key`), and what the generator says it does.
 *
 * @returns {{status: number, body: object}}
 */
function getFieldsYaml(ctx) {
  let target;
  try {
    ({ target } = vaultsettingswrite.checkTarget(ctx.vaultPath, { campaign: ctx.campaign }));
  } catch (err) {
    return { status: 422, body: { error: 'unsupported', message: err.message } };
  }
  let bytes;
  try {
    bytes = read.readBytes(target);
  } catch (err) {
    return { status: 503, body: { error: 'io', message: err.message } };
  }
  const split = vaultsettingscandidate.splitYamlFile(bytes);
  if (!split.ok) {
    return { status: 422, body: { error: 'unsupported', message: vaultsettingscandidate.YAML_EDITOR_REASON[split.code] } };
  }
  const parsed = pinned.parseSettingsText(ctx.vaultPath, bytes);
  if (!parsed.ok) {
    return { status: 422, body: { error: 'unsupported', message: `vault-config.yaml doesn't read, so the fields can't be shown. ${EDIT_AS_TEXT}` } };
  }
  const data = parsed.data;

  const fields = vaultsettingsplan.YAML_FIELD_SCHEMA.map((f) => {
    const value = getAt(data, f.path);
    const info = pinned.settingFieldInfo(f.path);
    return {
      path: f.path,
      key: f.key,
      kind: f.kind,
      group: f.group,
      label: f.label,
      value: value === undefined ? null : value,
      shape: value === undefined ? null : Array.isArray(value) ? 'list' : 'scalar',
      form: null,
      does: info.does,
      leftOut: info.leftOut,
    };
  });

  // YAML_DISPLAY_PATHS is DISPLAY_PATHS renamed, in the same order, so the old name is the one at the same place.
  const display = [];
  vaultsettingsplan.YAML_DISPLAY_PATHS.forEach((d, i) => {
    const value = getAt(data, d.path);
    if (d.showIfSet && value === undefined) return;
    display.push({ path: d.path, key: vaultconfigfields.DISPLAY_PATHS[i].path, group: d.group, label: d.label, value: value === undefined ? null : value });
  });

  // The player_site keys a field or a display row covers.
  const covered = new Set();
  for (const p of [...vaultsettingsplan.YAML_FIELD_SCHEMA, ...vaultsettingsplan.YAML_DISPLAY_PATHS].map((e) => e.path)) {
    const segs = p.split('.');
    if (segs[0] === 'player_site' && segs.length > 1) covered.add(segs[1]);
  }
  const unknown = [];
  for (const k of Object.keys(data)) if (k !== 'player_site') unknown.push(k);
  const site = data.player_site;
  if (site && typeof site === 'object' && !Array.isArray(site)) {
    for (const k of Object.keys(site)) if (!covered.has(k)) unknown.push(`player_site.${k}`);
  }

  let jsonConfig = null;
  try {
    jsonConfig = checkcli.resolveVaultContext(ctx.ctxInfo).jsonConfig;
  } catch {
    jsonConfig = null;
  }
  const effective = publishset.loadPublishConfig(ctx.vaultPath, jsonConfig || {}).publishConfig;

  const hiddenFields = getAt(data, 'player_site.hide.fields');
  const rawFields = Array.isArray(hiddenFields) ? hiddenFields.filter((x) => typeof x === 'string') : [];
  const names = Array.from(new Set(rawFields.concat(pinned.PUBLISH_DEFAULTS.exclude_fields || [])));
  const counts = new Map(names.map((name) => [name, 0]));
  const index = vaultindex.buildResolutionIndex(ctx.vaultPath, jsonConfig || {});
  for (const f of index.files) {
    if (!f.ok || !f.data || typeof f.data !== 'object') continue;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(f.data, name)) counts.set(name, counts.get(name) + 1);
    }
  }

  const missingDefaults = {};
  for (const listKey of DEFAULT_LISTS) {
    const eff = Array.isArray(effective[listKey]) ? effective[listKey] : [];
    missingDefaults[listKey] = (pinned.PUBLISH_DEFAULTS[listKey] || []).filter((d) => !containsCI(eff, d));
  }

  return { status: 200, body: { ok: true, sha256: sha256Hex(bytes), fields, display, unknown, usage: Object.fromEntries(counts), missingDefaults } };
}

module.exports = {
  KEEP,
  VaultSettingsRefusal,
  editorViewYaml,
  validateYamlFieldsBody,
  reviewYamlInner,
  effectsYaml,
  getFieldsYaml,
  listBackupsYaml,
};
