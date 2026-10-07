'use strict';

const respond = require('../respond');
const body = require('../body');
// Called through the module object (never destructured at require time), matching
// handlers/vaultconfig.js's own reasoning: an injection test can then patch exactly one export.
const machinedir = require('../../config/machinedir');
const prefsStore = require('../prefs');

/*
 * V1e-2 (ADR 0033 SS7, SD-10): GET and POST /api/prefs. GET never fails -- an unavailable
 * machine dir just means "defaults, not persisted", same as a corrupt file. POST is the only
 * path that can 503 (FR-12: it must actually write somewhere), and D-18 does not apply here:
 * this is never a vault write, so it is allowed for read-only campaigns.
 */

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

function machineDirFor(ctx) {
  return machinedir.resolveMachineDir({
    configPath: ctx.ctxInfo && ctx.ctxInfo.configPath,
    vaultPath: ctx.vaultPath,
  });
}

/** GET /api/prefs. */
async function getPrefs(req, res, ctx) {
  const result = prefsStore.readPrefs(machineDirFor(ctx));
  sendJson(res, 200, result);
}

/** POST /api/prefs, body exactly `{ key, value }`. */
async function postPrefs(req, res, ctx) {
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

  const ALLOWED_KEYS = ['key', 'value'];
  const unknown = Object.keys(parsed).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unknown.length > 0) {
    sendJson(res, 400, { error: 'invalid', message: `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` });
    return;
  }

  if (typeof parsed.key !== 'string') {
    sendJson(res, 400, { error: 'invalid', message: 'key must be a string' });
    return;
  }
  // Exact array membership (never an object/property lookup): the schema is PREF_SCHEMA itself,
  // not an object keyed by parsed.key, so a key of "constructor" or "__proto__" can never resolve
  // to anything but "not found" here.
  const entry = prefsStore.PREF_SCHEMA.find((e) => e[0] === parsed.key);
  if (!entry) {
    sendJson(res, 400, { error: 'invalid', message: `unknown preference: ${parsed.key}` });
    return;
  }

  const allowedValues = entry[1];
  if (!allowedValues.includes(parsed.value)) {
    sendJson(res, 400, { error: 'invalid', message: `${parsed.key} can't be ${JSON.stringify(parsed.value)}` });
    return;
  }

  const machineDirResult = machineDirFor(ctx);
  if (!machineDirResult.ok) {
    sendJson(res, 503, { error: 'unavailable', message: machineDirResult.reason });
    return;
  }

  const prefs = prefsStore.writePref(machineDirResult, parsed.key, parsed.value);
  sendJson(res, 200, { ok: true, prefs });
}

module.exports = { getPrefs, postPrefs };
