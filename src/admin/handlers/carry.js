'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const respond = require('../respond');
const body = require('../body');
const freshness = require('../freshness');
const { runExclusive, refreshSettingsLayout } = require('../context');
const machinedir = require('../../config/machinedir');
const pinned = require('../../generator/pinned');
const { readSettingsFiles } = require('../../vault/publishset');
const { planCarry, applyCarry, discardCarry } = require('../../vault/settingscarry');
const { writeCarriedPack } = require('../../vault/carrypack');
const { ScriptoriumError, VaultUnreachableError } = require('../../util/errors');

/*
 * The panel on a vault whose settings gm-apprentice moved to _meta/vault-config.yaml (ADR 0071).
 *
 * settingsView: the `?include=settings` part of GET /api/state. The title and tagline as the vault's
 * settings file sets them, shown read-only until editing them there arrives (rung 3c). A title the yaml
 * does not set is null, never the pack's: on a moved vault the build no longer reads the pack's title
 * (the carry's lines say when it would move).
 *
 * carry: POST /api/settings/carry, the panel's way to run `gm-scriptorium carry` (src/cli/carry.js).
 * `{ dryRun: true }` plans and returns the plan's lines with a baseSha256 over the pack and the yaml as
 * they were read; `{ dryRun: false, baseSha256 }` plans again and applies, under the write lock, only if
 * both files are still as they were when the lines were shown. Backups go to the per-machine folder
 * beside the config, never into the vault, as the command's do.
 */

const BASE_SHA_RE = /^[0-9a-f]{64}$/;
const ALLOWED_KEYS = ['dryRun', 'baseSha256'];
const YAML_REL = '_meta/vault-config.yaml';

const TITLE_MOVED =
  "This campaign's title is set in the vault's settings file (_meta/vault-config.yaml). Editing it here arrives in the next update; change it in that file for now.";
const NO_TITLE = "No site title is set in the vault's settings file (_meta/vault-config.yaml).";
const NOTHING = 'There is nothing to carry: the pack holds nothing the carry can move.';
const CHANGED =
  "The pack or the vault's settings file changed since these settings were shown. Nothing was written. Look at them again before carrying.";
const NO_BACKUP_FOLDER = "GM-Scriptorium's own folder can't hold backups, so the carry can't keep a copy of both files first. Nothing was written.";
// applyCarry's partial-failure messages name the command; in the panel the button does the same job.
const CLI_AGAIN = 'Run "gm-scriptorium carry" again';
const PANEL_AGAIN = 'Press "Carry these settings" again';
const inPanelWords = (message) => String(message).split(CLI_AGAIN).join(PANEL_AGAIN);
// applyCarry's own refusal when a file changed between its plan and its apply (src/vault/settingscarry.js).
const APPLY_CHANGED_RE = /changed since the carry was planned/;

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function shaOrAbsent(file) {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    throw err;
  }
}

/** One value standing for the pack and the yaml as they are now. */
function basisOf(ctx) {
  return sha256Hex(`${shaOrAbsent(path.resolve(ctx.siteConfigPath))}\n${shaOrAbsent(path.join(ctx.vaultPath, YAML_REL))}`);
}

function textOrNull(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * GET /api/state's `?include=settings` payload. Never throws.
 *
 * @param {object} ctx
 * @returns {null | { file: string, title: string|null, titleNote: string, tagline: string|null, error: string|null }}
 *   null unless the vault keeps its settings in _meta/vault-config.yaml
 */
function settingsView(ctx) {
  if (ctx.settingsLayout !== 'new') return null;
  try {
    const { values, origins } = pinned.readSettingValues(ctx.vaultPath, {}, readSettingsFiles(ctx.vaultPath));
    const site = (values && values.player_site) || {};
    const title = origins['player_site.title'] === 'file' ? textOrNull(site.title) : null;
    const tagline = origins['player_site.theme.tagline'] === 'file' ? textOrNull(site.theme && site.theme.tagline) : null;
    return { file: YAML_REL, title, titleNote: title === null ? NO_TITLE : TITLE_MOVED, tagline, error: null };
  } catch (err) {
    return { file: YAML_REL, title: null, titleNote: NO_TITLE, tagline: null, error: String(err.message).replace(/\s+/g, ' ') };
  }
}

/** A specific, already-decided HTTP response, thrown from inside the write-locked section. */
class HandlerRefusal extends Error {
  constructor(status, payload) {
    super('settings carry refusal');
    this.status = status;
    this.payload = payload;
  }
}

/** Plans (and, unless dryRun, applies) inside runExclusive. */
function planAndApply(ctx, { dryRun, baseSha256 }) {
  refreshSettingsLayout(ctx);
  const basis = basisOf(ctx);
  const planned = planCarry({ vaultPath: ctx.vaultPath, packConfigPath: path.resolve(ctx.siteConfigPath) });
  try {
    if (planned.state === 'blocked') {
      throw new HandlerRefusal(409, { error: 'blocked', message: planned.blockers.join(' ') });
    }
    if (dryRun) {
      return { status: 200, body: { ok: true, dryRun: true, state: planned.state, lines: planned.lines, baseSha256: basis } };
    }
    if (basis !== baseSha256) throw new HandlerRefusal(409, { error: 'changed', message: CHANGED });
    if (planned.state !== 'ready') throw new HandlerRefusal(409, { error: 'nothing', message: NOTHING });

    const machine = machinedir.resolveMachineDir({ configPath: ctx.ctxInfo && ctx.ctxInfo.configPath, vaultPath: ctx.vaultPath });
    // machine.reason is written for the vault-config.md editor, so the carry says it in its own words.
    if (!machine.ok) throw new HandlerRefusal(503, { error: 'io', message: NO_BACKUP_FOLDER });

    let done;
    try {
      done = applyCarry(planned, { machineDir: machine.dir, campaign: ctx.campaign, packWriter: writeCarriedPack });
    } catch (err) {
      if (err instanceof VaultUnreachableError && APPLY_CHANGED_RE.test(err.message)) {
        throw new HandlerRefusal(409, { error: 'changed', message: CHANGED });
      }
      if (err instanceof ScriptoriumError) throw new HandlerRefusal(503, { error: 'io', message: inPanelWords(err.message) });
      throw err;
    }
    // The vault's settings changed: anything the panel rebuilt from them is read again on demand.
    delete ctx.vaultArt;
    delete ctx.vaultConfigReview;
    return { status: 200, body: { ok: true, lines: done.lines, backups: done.backups } };
  } finally {
    discardCarry(planned);
  }
}

/** POST /api/settings/carry. */
async function carry(req, res, ctx) {
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
  if (typeof parsed.dryRun !== 'boolean') {
    sendJson(res, 400, { error: 'invalid', message: 'dryRun must be a boolean' });
    return;
  }
  if (!parsed.dryRun && (typeof parsed.baseSha256 !== 'string' || !BASE_SHA_RE.test(parsed.baseSha256))) {
    sendJson(res, 400, { error: 'invalid', message: 'baseSha256 must be 64 lowercase hex characters' });
    return;
  }

  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }

  let outcome;
  try {
    outcome = await runExclusive(ctx, 'write', () => planAndApply(ctx, { dryRun: parsed.dryRun, baseSha256: parsed.baseSha256 }));
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

module.exports = { carry, settingsView, TITLE_MOVED };
