'use strict';

const respond = require('../respond');
const body = require('../body');
const { runExclusive } = require('../context');
const { createFolder } = require('../foldercreate');
const folders = require('../../setup/folders');
const { AUDIT_REFUSAL_BODY } = require('./remote');

/*
 * ADR 0049: the folder picker's two routes. Both need a signed-in session of any kind (loopback
 * token or remote session), both are admitted while setup is active and after it, and neither is
 * ever a 403 or a 500 from here: a filesystem outcome is a normal answer.
 *
 *   GET  /api/folders          child FOLDER names only. A remote-kind listing is audited (one
 *                              `folders` line, written BEFORE anything is read; if it cannot be
 *                              written the answer is 503 and nothing is listed). A loopback
 *                              listing writes nothing.
 *   POST /api/folders/create   one create-only, single-level folder (src/admin/foldercreate.js).
 *                              The router brackets it with request and response lines; this
 *                              A remote request with an unwritable log gets the router's 503.
 *
 * ctx.folderDeps is the test seam: { fsp, timeoutMs, platform, homedir, now, deadlineMs }.
 * Production never sets it. ctx.folderDrives remembers the Windows drives that did not answer.
 */

const MAX_BODY_FIELDS = ['parent', 'name'];

function sendJson(res, status, payload, { isHead = false } = {}) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload), { isHead });
}

function refuseUnrecorded(res) {
  respond.send(res, 503, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), AUDIT_REFUSAL_BODY);
}

function platformOf(ctx) {
  return (ctx.folderDeps && ctx.folderDeps.platform) || process.platform;
}

/**
 * @param {object} ctx
 * @param {object} entry
 * @returns {boolean} true when the line was written
 */
function record(ctx, entry) {
  if (!ctx.audit) return false;
  try {
    ctx.audit.append(entry);
    return true;
  } catch {
    return false;
  }
}

/** Reads the query. @returns {{ ok: true, ... } | { ok: false, reason: 'path'|'filter'|'params' }} */
function parseQuery(query, platform) {
  for (const key of ['path', 'start', 'filter', 'hidden', 'refresh']) {
    if (query.getAll(key).length > 1) return { ok: false, reason: 'params' };
  }
  if (query.has('path') && query.has('start')) return { ok: false, reason: 'params' };
  const filter = query.get('filter');
  if (filter !== null && filter.length > folders.MAX_FILTER) return { ok: false, reason: 'filter' };
  const parsed = { ok: true, filter: filter === null ? '' : filter, hidden: query.get('hidden') === '1', refresh: query.get('refresh') === '1' };
  if (query.has('path')) {
    try {
      parsed.path = folders.validateFolderPath(query.get('path'), platform);
    } catch {
      return { ok: false, reason: 'path' };
    }
  } else if (query.has('start')) {
    const start = query.get('start');
    if (start.length > folders.MAX_PATH || start.includes('\u0000')) return { ok: false, reason: 'path' };
    parsed.start = start;
  }
  return parsed;
}

/** GET /api/folders */
async function list(req, res, ctx, { kind, query, isHead, pathname, clientAddress }) {
  const platform = platformOf(ctx);
  const parsed = parseQuery(query, platform);
  if (!parsed.ok) {
    sendJson(res, 400, { error: 'invalid', reason: parsed.reason }, { isHead });
    return;
  }
  if (kind === 'remote') {
    const written = record(ctx, {
      event: 'folders',
      method: 'GET',
      route: pathname,
      via: kind,
      from: clientAddress,
      campaign: ctx.campaign,
    });
    if (!written) {
      refuseUnrecorded(res);
      return;
    }
  }
  const deps = ctx.folderDeps || {};
  let result;
  if (parsed.path !== undefined) {
    result = await folders.listFolder(parsed.path, { hidden: parsed.hidden, filter: parsed.filter }, deps);
  } else if (parsed.start !== undefined) {
    result = await folders.startFolder(parsed.start, deps);
  } else {
    if (!(ctx.folderDrives instanceof Set)) ctx.folderDrives = new Set();
    result = await folders.listRoots({ memory: ctx.folderDrives, refresh: parsed.refresh }, deps);
  }
  sendJson(res, 200, result, { isHead });
}

function badBody(res, field, message) {
  sendJson(res, 400, { error: 'invalid', field, message });
}

/** @returns {Promise<{ parent: string, name: string }|null>} null after a 400 or 413 was sent */
async function readCreateBody(req, res) {
  const read = await body.readBody(req, body.JSON_BODY_CAP);
  if (!read.ok) {
    respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
    return null;
  }
  let parsed;
  try {
    parsed = body.parseJson(read.body);
  } catch {
    badBody(res, 'body', 'the request body is not valid JSON');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    badBody(res, 'body', 'the request body must be a JSON object');
    return null;
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== MAX_BODY_FIELDS.length || keys.join(',') !== [...MAX_BODY_FIELDS].sort().join(',')) {
    badBody(res, 'body', 'the request body must hold exactly parent and name');
    return null;
  }
  if (typeof parsed.parent !== 'string' || parsed.parent.length > folders.MAX_PATH) {
    badBody(res, 'parent', 'parent must be text of at most 2048 characters');
    return null;
  }
  if (typeof parsed.name !== 'string' || parsed.name.length > 128) {
    badBody(res, 'name', 'name must be text of at most 128 characters');
    return null;
  }
  return { parent: parsed.parent, name: parsed.name };
}

/** Every registered campaign's vault, and each profile's vault for it (what the vault refusal protects). */
function vaultsOf(ctx) {
  const config = ctx.ctxInfo && ctx.ctxInfo.config;
  const campaigns = config && typeof config.campaigns === 'object' && config.campaigns !== null ? config.campaigns : {};
  const out = [];
  for (const campaign of Object.values(campaigns)) {
    if (campaign && typeof campaign.vault === 'string' && campaign.vault.length > 0) out.push(campaign.vault);
    const profiles = campaign && campaign.paths && typeof campaign.paths === 'object' ? campaign.paths : {};
    for (const table of Object.values(profiles)) {
      if (table && typeof table.vault === 'string' && table.vault.length > 0) out.push(table.vault);
    }
  }
  return out;
}

/** POST /api/folders/create (audited by the router) */
async function create(req, res, ctx, { kind, pathname, clientAddress }) {
  const input = await readCreateBody(req, res);
  if (input === null) return;
  const platform = platformOf(ctx);
  try {
    folders.validateFolderPath(input.parent, platform);
  } catch (err) {
    badBody(res, 'parent', err.message);
    return;
  }
  try {
    folders.validateFolderName(input.name);
  } catch (err) {
    badBody(res, 'name', err.message);
    return;
  }
  const ran = await runExclusive(ctx, 'folder', () =>
    createFolder(input, { configDir: ctx.remote.paths.configDir, panelDir: ctx.remote.paths.panelDir, vaults: vaultsOf(ctx), deps: ctx.folderDeps || {} }),
  );
  if (!ran.ok) {
    sendJson(res, 409, { error: 'busy', busy: ran.busy });
    return;
  }
  const outcome = ran.value;
  if (outcome.ok) sendJson(res, 200, { created: true, path: outcome.path });
  else sendJson(res, 409, { error: outcome.error, ...(outcome.path !== undefined ? { path: outcome.path } : {}) });
}

module.exports = { list, create };
