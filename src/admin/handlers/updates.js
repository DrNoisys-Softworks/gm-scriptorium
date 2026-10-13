'use strict';

const respond = require('../respond');
const body = require('../body');
const { runExclusive } = require('../context');
const register = require('../../setup/register');

/*
 * The panel's update notice routes (docs/decisions/0028-installer-and-first-run.md, addendum "The
 * update notice"): the state the Overview shows, Not now, and the one setting route behind the
 * Updates card's switch and channel. All three work over remote access like the campaign routes,
 * and the two POSTs are audited by the router. None sets auditNote.affected: the audit line names
 * no campaign and no version.
 *
 * This is the third module that requires src/setup/register.js, the only panel-side route to the
 * config writer. It holds no write of its own (test/update-notice-structure.test.js proves it): the
 * setting is written by register.setUpdateFromPanel, behind the sha256 compare, and then handed to
 * the controller (ctx.updateNotice), which acts on it at once.
 */

const SHA_RE = /^[0-9a-f]{64}$/;
const CONFIG_CHANGED = 'Your settings changed outside the panel. Reload and try again.';
const FILE_HELD_MESSAGE = 'Your settings file is open in another program. Close it and try again.';
// On Windows a rename over a file that another program holds open fails with one of these; the
// writer has already retried for a few seconds and cleaned up.
const HELD_OPEN_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function writeFailureMessage(err) {
  if (err && err.syscall === 'rename' && HELD_OPEN_CODES.has(err.code)) return FILE_HELD_MESSAGE;
  return (err && err.message) || 'the settings could not be saved';
}

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

function invalid(res, message) {
  sendJson(res, 400, { error: 'invalid', message });
}

/**
 * Reads the JSON body as an object. `check(parsed)` returns an error message, or null when the
 * shape is right.
 * @returns {Promise<object|null>} the object, or null after a response was sent
 */
async function readObject(req, res, check) {
  const result = await body.readBody(req, body.JSON_BODY_CAP);
  if (!result.ok) {
    respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
    return null;
  }
  let parsed;
  try {
    parsed = body.parseJson(result.body);
  } catch {
    invalid(res, 'the request body is not valid JSON');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    invalid(res, 'the request body must be a JSON object');
    return null;
  }
  const problem = check(parsed);
  if (problem !== null) {
    invalid(res, problem);
    return null;
  }
  return parsed;
}

function sameKeys(parsed, keys) {
  const got = Object.keys(parsed).sort();
  return got.length === keys.length && got.join() === [...keys].sort().join();
}

/** GET /api/update: the notice state, plus what the page needs to save a setting. */
function state(req, res, ctx) {
  const configPath = ctx.ctxInfo.configPath;
  let configSha256 = null;
  try {
    configSha256 = register.readConfigSnapshot(configPath, { lenient: false }).sha256;
  } catch {
    configSha256 = null;
  }
  sendJson(res, 200, { ...ctx.updateNotice.snapshot(), configPath, configSha256 });
}

/** POST /api/update/dismiss (audited by the router). Body: { version }, the tag being shown. */
async function dismiss(req, res, ctx) {
  const parsed = await readObject(req, res, (p) => {
    if (!sameKeys(p, ['version'])) return 'the request body must have exactly: version';
    if (typeof p.version !== 'string') return 'version must be text';
    return null;
  });
  if (parsed === null) return;
  if (ctx.updateNotice.snapshot().latestTag !== parsed.version) {
    invalid(res, 'that is not the version being shown');
    return;
  }
  try {
    ctx.updateNotice.dismiss(parsed.version);
  } catch (err) {
    sendJson(res, 503, { error: 'io', message: writeFailureMessage(err) });
    return;
  }
  sendJson(res, 200, { ok: true });
}

function settingShape(p) {
  if (typeof p.configSha256 !== 'string' || !SHA_RE.test(p.configSha256)) return 'configSha256 must be 64 lowercase hex characters';
  if (sameKeys(p, ['check', 'configSha256'])) return typeof p.check === 'boolean' ? null : 'check must be true or false';
  if (sameKeys(p, ['channel', 'configSha256'])) return p.channel === 'stable' || p.channel === 'beta' ? null : 'channel must be "stable" or "beta"';
  return 'the request body must have exactly: check or channel, and configSha256';
}

/** POST /api/update/setting (audited by the router). Body: { check, configSha256 } or { channel, configSha256 }. */
async function setting(req, res, ctx) {
  const parsed = await readObject(req, res, settingShape);
  if (parsed === null) return;
  const key = 'check' in parsed ? 'check' : 'channel';
  const value = parsed[key];
  const configPath = ctx.ctxInfo.configPath;
  const ran = await runExclusive(ctx, 'write', async () => {
    try {
      const outcome = register.setUpdateFromPanel({ key, value, configSha256: parsed.configSha256 }, { configPath });
      if (outcome.ok) void ctx.updateNotice.applySetting(key, value);
      return outcome;
    } catch (err) {
      return { io: writeFailureMessage(err) };
    }
  });
  if (!ran.ok) {
    sendJson(res, 409, { error: 'busy', busy: ran.busy });
    return;
  }
  const outcome = ran.value;
  if (outcome.ok) sendJson(res, 200, { ok: true, configSha256: outcome.configSha256, update: ctx.updateNotice.snapshot() });
  else if (outcome.io !== undefined) sendJson(res, 503, { error: 'io', message: outcome.io });
  else if (outcome.refused === 'config-changed') sendJson(res, 409, { error: 'config-changed', message: CONFIG_CHANGED });
  else sendJson(res, 409, { error: outcome.refused, message: outcome.message });
}

module.exports = { state, dismiss, setting };
