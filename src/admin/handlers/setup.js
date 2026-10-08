'use strict';

const respond = require('../respond');
const body = require('../body');
const assets = require('../assets');
const welcome = require('../welcome');
// Called through the module object so a test can patch exactly one export (the handover failure test).
const setupmode = require('../setupmode');
const { runExclusive } = require('../context');
const register = require('../../setup/register');
const checks = require('../../setup/checks');

/*
 * Browser setup's routes (docs/decisions/0028-installer-and-first-run.md). Every handler runs only
 * after the router's gate has authenticated the request, and every one refuses a remote-kind
 * request with 403 (setup is loopback only; the gate never lets a remote request reach these in
 * setup mode, and this is the defence in depth). This file and src/admin/handlers/campaigns.js
 * (ADR 0050) are the only admin modules that require src/setup/register.js, which is the only
 * panel-side importer of the config writer, and the commit route is the only caller of the
 * setup commit (test/setup-structure.test.js proves both).
 */


function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

function refuseRemote(res) {
  sendJson(res, 403, { error: 'forbidden', message: 'Setup is only available on the machine running GM-Scriptorium.' });
  return true;
}

function setupDone(res) {
  sendJson(res, 409, { error: 'setup-done' });
}

function panelDirOf(ctx) {
  return ctx.remote.paths.panelDir;
}

/** GET /setup, and GET / while setup is active. */
function setupPage(req, res, ctx, { kind, isHead }) {
  if (kind === 'remote') return refuseRemote(res);
  if (!setupmode.isSetupActive(ctx)) {
    respond.send(res, 303, respond.adminHeaders({ Location: '/#/overview' }));
    return undefined;
  }
  respond.send(res, 200, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8' }), assets.readAdminAsset('setup.html'), { isHead });
  return undefined;
}

/** GET /api/setup/state. Works before and after the handover (the Overview welcome reads it). */
function state(req, res, ctx, { kind }) {
  if (kind === 'remote') return refuseRemote(res);
  const active = setupmode.isSetupActive(ctx);
  let showWelcome = false;
  if (!active && typeof ctx.campaign === 'string') {
    try {
      showWelcome = welcome.readPending(panelDirOf(ctx)).includes(ctx.campaign);
    } catch {
      showWelcome = false;
    }
  }
  const facts = checks.setupFacts(ctx.setup && ctx.setup.probeDeps ? ctx.setup.probeDeps : {});
  sendJson(res, 200, {
    active,
    configPath: ctx.ctxInfo ? ctx.ctxInfo.configPath : null,
    campaign: ctx.campaign === undefined ? null : ctx.campaign,
    themes: facts.themes,
    defaultTheme: facts.defaultTheme,
    remoteDeferred: ctx.setup && ctx.setup.active ? ctx.setup.remoteDeferred || null : null,
    welcome: showWelcome,
    sep: facts.sep,
    newVault: facts.newVault,
  });
  return undefined;
}

/** GET /api/setup/check?field=...&value=...&commit=0|1&name=...&vault=... : read-only, a GET, no audit. */
async function check(req, res, ctx, { kind, query }) {
  if (kind === 'remote') return refuseRemote(res);
  if (!setupmode.isSetupActive(ctx)) return setupDone(res);
  const q = checks.parseCheckQuery(query);
  if (!q.ok) {
    sendJson(res, 400, { error: 'invalid', message: q.message });
    return undefined;
  }
  const result = await checks.runCheck(q, { configPath: ctx.setup.configPath, panelDir: panelDirOf(ctx) }, ctx.setup.probeDeps || {});
  sendJson(res, 200, result);
  return undefined;
}

function badBody(res, message) {
  sendJson(res, 400, { error: 'invalid', message });
}

/** Parses and shape-checks the commit body. @returns {object|null} answers, or null after a 400 was sent */
async function readAnswers(req, res) {
  const result = await body.readBody(req, body.JSON_BODY_CAP);
  if (!result.ok) {
    respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
    return null;
  }
  let parsed;
  try {
    parsed = body.parseJson(result.body);
  } catch {
    badBody(res, 'the request body is not valid JSON');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    badBody(res, 'the request body must be a JSON object');
    return null;
  }
  const problem = checks.answersProblem(parsed);
  if (problem !== null) {
    badBody(res, problem);
    return null;
  }
  return parsed;
}

/** POST /api/setup/commit (audited by the router): the one place setup writes anything. */
async function commit(req, res, ctx, { kind }) {
  if (kind === 'remote') return refuseRemote(res);
  if (!setupmode.isSetupActive(ctx)) return setupDone(res);
  const answers = await readAnswers(req, res);
  if (answers === null) return undefined;

  const ran = await runExclusive(ctx, 'setup', async () => {
    const outcome = await register.commitSetup(answers, { configPath: ctx.setup.configPath, panelDir: panelDirOf(ctx) }, ctx.setup.probeDeps || {});
    if (!outcome.created) return { outcome };
    // The registration stands whatever happens next; a failed handover is reported, not rolled back.
    try {
      setupmode.applyHandover(ctx, { name: answers.name.trim() });
      return { outcome, handover: 'ok' };
    } catch (err) {
      return { outcome, handover: 'failed', message: err.message };
    }
  });
  if (!ran.ok) {
    sendJson(res, 409, { error: 'busy', busy: ran.busy });
    return undefined;
  }
  const { outcome, handover, message } = ran.value;
  if (outcome.refused === 'taken') sendJson(res, 409, { error: 'taken' });
  else if (outcome.invalid) sendJson(res, 400, { error: 'invalid', field: outcome.invalid.field, rule: outcome.invalid.rule });
  else sendJson(res, 200, { ...outcome, handover, ...(message !== undefined ? { message } : {}) });
  return undefined;
}

/** POST /api/welcome/dismiss (audited by the router). The body is ignored. */
async function welcomeDismiss(req, res, ctx, { kind }) {
  if (kind === 'remote') return refuseRemote(res);
  if (setupmode.isSetupActive(ctx)) {
    sendJson(res, 409, JSON.parse(setupmode.FENCE_BODY));
    return undefined;
  }
  const drained = await body.readBody(req, body.JSON_BODY_CAP);
  if (!drained.ok) {
    respond.send(res, 413, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }), 'refused: too large');
    return undefined;
  }
  if (typeof ctx.campaign === 'string') {
    try {
      welcome.removePending(panelDirOf(ctx), ctx.campaign);
    } catch (err) {
      sendJson(res, 503, { error: 'unavailable', message: `The welcome could not be saved as dismissed: ${err.message}` });
      return undefined;
    }
  }
  sendJson(res, 200, { ok: true });
  return undefined;
}

module.exports = { setupPage, state, check, commit, welcomeDismiss };
