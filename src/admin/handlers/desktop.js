'use strict';

const respond = require('../respond');
const body = require('../body');
const { runExclusive } = require('../context');
const register = require('../../setup/register');

/*
 * The desktop app's ports card (docs/decisions/0057-windows-desktop-app.md, section 8): the Overview's
 * "This PC's addresses" card reads GET /api/desktop and saves through POST /api/desktop/ports. The
 * save is the panel's fifth write on the one fenced chain: register.setDesktopPortsFromPanel, behind
 * the same sha256 compare as the campaign routes, changes only the `[desktop]` table. After a good
 * save the panel asks the desktop host to restart on the new ports, once the reply is on its way.
 *
 * The card exists only under the desktop app (ctx.desktop is set by the host) and is read-only in a
 * remote mode, where the `[remote]` ports apply and this module never touches them. The POST is
 * audited by the router; it sets no auditNote.affected, so the audit line names no campaign.
 */

const SHA_RE = /^[0-9a-f]{64}$/;
const CONFIG_CHANGED = 'Your settings changed outside the panel. Reload and try again.';
const FILE_HELD_MESSAGE = 'Your settings file is open in another program. Close it and try again.';
const NOT_DESKTOP = 'This is only available in the desktop app.';
const REMOTE_MODE = 'Remote access uses its own ports. Change them with gm-scriptorium remote set.';
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

function modeOf(ctx) {
  return ctx.remote && ctx.remote.settings ? ctx.remote.settings.mode : 'local';
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

function portsShape(p) {
  const got = Object.keys(p).sort();
  if (got.join() !== ['configSha256', 'port', 'previewPort'].join()) return 'the request body must have exactly: port, previewPort, configSha256';
  if (!Number.isInteger(p.port) || !Number.isInteger(p.previewPort)) return 'port and previewPort must be whole numbers';
  if (typeof p.configSha256 !== 'string' || !SHA_RE.test(p.configSha256)) return 'configSha256 must be 64 lowercase hex characters';
  return null;
}

/** GET /api/desktop: what the card shows. Outside the desktop app it says so and nothing else. */
function state(req, res, ctx) {
  if (!ctx.desktop) {
    sendJson(res, 200, { desktop: false });
    return;
  }
  const mode = modeOf(ctx);
  let configSha256 = null;
  try {
    configSha256 = register.readConfigSnapshot(ctx.ctxInfo.configPath, { lenient: false }).sha256;
  } catch {
    configSha256 = null;
  }
  const scheme = (ctx.access && ctx.access.loopbackScheme) || 'http';
  sendJson(res, 200, {
    desktop: true,
    mode,
    editable: mode === 'local',
    port: ctx.adminPort,
    previewPort: ctx.previewPort,
    panelUrl: `${scheme}://127.0.0.1:${ctx.adminPort}`,
    previewUrl: `${scheme}://127.0.0.1:${ctx.previewPort}`,
    configSha256,
  });
}

/** POST /api/desktop/ports (audited by the router). Body: { port, previewPort, configSha256 }. */
async function savePorts(req, res, ctx) {
  const parsed = await readObject(req, res, portsShape);
  if (parsed === null) return;
  if (!ctx.desktop) {
    sendJson(res, 409, { error: 'not-desktop', message: NOT_DESKTOP });
    return;
  }
  if (modeOf(ctx) !== 'local') {
    sendJson(res, 409, { error: 'remote-mode', message: REMOTE_MODE });
    return;
  }
  const configPath = ctx.ctxInfo.configPath;
  const ran = await runExclusive(ctx, 'write', async () => {
    try {
      return register.setDesktopPortsFromPanel({ port: parsed.port, previewPort: parsed.previewPort, configSha256: parsed.configSha256 }, { configPath });
    } catch (err) {
      return { io: writeFailureMessage(err) };
    }
  });
  if (!ran.ok) {
    sendJson(res, 409, { error: 'busy', busy: ran.busy });
    return;
  }
  const outcome = ran.value;
  if (outcome.ok) {
    sendJson(res, 200, { ok: true, configSha256: outcome.configSha256, port: parsed.port, previewPort: parsed.previewPort, restarting: true });
    // After the reply is on its way: the restart closes the listener this reply is leaving by.
    setImmediate(() => {
      try {
        void Promise.resolve(ctx.desktop.requestRestart({ open: true })).catch(() => {});
      } catch {
        // swallowed deliberately: the ports are saved, and the host logs a restart that fails.
      }
    });
  } else if (outcome.io !== undefined) sendJson(res, 503, { error: 'io', message: outcome.io });
  else if (outcome.refused === 'config-changed') sendJson(res, 409, { error: 'config-changed', message: CONFIG_CHANGED });
  else sendJson(res, 409, { error: outcome.refused, message: outcome.message });
}

module.exports = { state, savePorts };
