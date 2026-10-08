'use strict';

const path = require('path');
const respond = require('../respond');
const body = require('../body');
const { runExclusive } = require('../context');
// Called through the module object so a test can patch exactly one export.
const setupmode = require('../setupmode');
const campaignstate = require('../campaignstate');
const preview = require('../preview');
const register = require('../../setup/register');
const probe = require('../../setup/probe');
const { resolveCampaignContext } = require('../../cli/args');
const { resolveCampaign } = require('../../config/resolve');

/*
 * Several campaigns in one panel (docs/decisions/0050-several-campaigns.md): the list, the switch,
 * set as default, and remove from GM-Scriptorium. Every handler runs after the router's gate has
 * authenticated the request, and none refuses a remote-kind request: all four work over remote
 * access, and the three POSTs are audited by the router. The only value a handler hands back to the
 * audit log is the affected campaign's name (auditNote.affected).
 *
 * This file is the second module that requires src/setup/register.js, the only panel-side route to
 * the config writer. It holds no write of its own (test/campaigns-structure.test.js proves it).
 */

const MAX_NAME = 200;
const SHA_RE = /^[0-9a-f]{64}$/;
const CONFIG_CHANGED = 'Your settings changed outside the panel. Reload and try again.';
const ACTIVE_MESSAGE = 'Switch to another campaign first.';
const BUSY_PROBE = 'The panel is already waiting on other folders. Try again in a moment.';

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

function invalid(res, message) {
  sendJson(res, 400, { error: 'invalid', message });
}

/**
 * Reads the JSON body and checks it is an object with exactly the given keys.
 * @returns {Promise<object|null>} the parsed object, or null after a response was sent
 */
async function readExact(req, res, keys) {
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
  const got = Object.keys(parsed).sort();
  if (got.length !== keys.length || got.join() !== [...keys].sort().join()) {
    invalid(res, `the request body must have exactly: ${keys.join(', ')}`);
    return null;
  }
  if (typeof parsed.name !== 'string' || parsed.name.length === 0 || parsed.name.length > MAX_NAME) {
    invalid(res, 'name must be text of 1 to 200 characters');
    return null;
  }
  if (keys.includes('configSha256') && (typeof parsed.configSha256 !== 'string' || !SHA_RE.test(parsed.configSha256))) {
    invalid(res, 'configSha256 must be 64 lowercase hex characters');
    return null;
  }
  return parsed;
}

function readOnlyOf(config, name) {
  try {
    const resolved = resolveCampaign(config, name);
    return [resolved.site_config, resolved.pack].some((v) => typeof v === 'string' && v.length > 0);
  } catch {
    return null;
  }
}

/** GET /api/campaigns: reads config.toml only. It never probes or stats a vault. */
function list(req, res, ctx) {
  let snap;
  try {
    snap = register.readConfigSnapshot(ctx.ctxInfo.configPath, { lenient: true });
  } catch (err) {
    if (err && err.name === 'ConfigError') {
      sendJson(res, 409, { error: 'config-invalid', message: err.message });
      return;
    }
    sendJson(res, 503, { error: 'io', message: err.message });
    return;
  }
  const names = Object.keys(snap.config.campaigns || {});
  const campaigns = names.map((name) => ({
    name,
    active: name === ctx.campaign,
    isDefault: snap.config.default_campaign === name,
    readOnly: readOnlyOf(snap.config, name),
    missing: false,
  }));
  if (typeof ctx.campaign === 'string' && !names.includes(ctx.campaign)) {
    campaigns.push({ name: ctx.campaign, active: true, isDefault: false, readOnly: Boolean(ctx.readOnlyReason), missing: true });
  }
  const lockedReason = (ctx.campaigns && ctx.campaigns.lockedReason) || null;
  sendJson(res, 200, { campaigns, configSha256: snap.sha256, switchable: lockedReason === null, lockedReason });
}

function probeMessage(state, { name, target, current, timeoutMs }) {
  if (state === 'timeout') {
    return `campaign "${name}": ${target} did not answer within ${timeoutMs / 1000} seconds, so the panel stayed on "${current}".`;
  }
  if (state === 'busy') return BUSY_PROBE;
  return `campaign "${name}": ${target} could not be read, so the panel stayed on "${current}".`;
}

/**
 * The body of a switch, run under runExclusive. Order is fixed (ADR 0050 section 1): the config is
 * read (no vault is touched), every path the resolver is about to stat is probed under a bound, and
 * only then does the synchronous resolver run. Nothing on ctx changes until applySwitch.
 *
 * @returns {Promise<{ fail: string } | { changed: true } | { busy: string } | { switched: true }>}
 */
async function performSwitch(ctx, name) {
  const configPath = ctx.ctxInfo.configPath;
  let info;
  try {
    info = resolveCampaignContext({ config: configPath }, name);
  } catch (err) {
    return { fail: err.message };
  }

  const deps = (ctx.campaigns && ctx.campaigns.probeDeps) || {};
  const timeoutMs = deps.timeoutMs === undefined ? probe.DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  if (typeof info.vault === 'string' && info.vault.length > 0) {
    const vault = path.resolve(info.vault);
    const targets = [vault, path.join(vault, '_meta', 'vault-config.md')];
    if (typeof info.pack === 'string' && info.pack.length > 0) targets.push(path.resolve(info.pack));
    if (typeof info.site_config === 'string' && info.site_config.length > 0) targets.push(path.resolve(info.site_config));
    for (const target of targets) {
      const state = await probe.probePath(target, deps);
      if (state === 'ok') continue;
      if (state === 'missing') {
        // The resolver reports a missing vault or vault-config.md in its own words; any later
        // path is then never reached by it.
        if (target === vault || target === targets[1]) break;
        continue;
      }
      return { fail: probeMessage(state, { name, target, current: ctx.campaign, timeoutMs }) };
    }
  }

  // From here everything is synchronous: nothing can run between the resolve and the apply.
  let fresh;
  try {
    fresh = setupmode.resolveFresh(configPath, name, ctx.token);
  } catch (err) {
    return { fail: err.message };
  }
  if (typeof info.vault === 'string' && fresh.vaultPath !== path.resolve(info.vault)) return { changed: true };
  if (ctx.campaigns.inFlight > 1) return { busy: 'request' };

  const stashed = campaignstate.slotFor(ctx, name);
  if (stashed && stashed.vaultPath !== fresh.vaultPath) preview.dropCampaignPreview(ctx, name);
  campaignstate.applySwitch(ctx, fresh);
  ctx.campaigns.switches++;
  return { switched: true };
}

/** POST /api/campaigns/switch (audited by the router). Body: { name }. */
async function switchCampaign(req, res, ctx) {
  const parsed = await readExact(req, res, ['name']);
  if (parsed === null) return;
  const name = parsed.name;
  const lockedReason = ctx.campaigns && ctx.campaigns.lockedReason;
  if (lockedReason) {
    sendJson(res, 409, { error: 'switch-off', message: lockedReason });
    return;
  }
  if (name === ctx.campaign) {
    sendJson(res, 200, { switched: false, campaign: ctx.campaign });
    return;
  }
  const ran = await runExclusive(ctx, 'switch', () => performSwitch(ctx, name));
  if (!ran.ok) {
    sendJson(res, 409, { error: 'busy', busy: ran.busy });
    return;
  }
  const out = ran.value;
  if (out.fail !== undefined) sendJson(res, 422, { error: 'cannot-switch', message: out.fail });
  else if (out.changed) sendJson(res, 409, { error: 'config-changed', message: CONFIG_CHANGED });
  else if (out.busy !== undefined) sendJson(res, 409, { error: 'busy', busy: out.busy });
  else sendJson(res, 200, { switched: true, campaign: ctx.campaign });
}

/** The two config writes. Synchronous from the snapshot to the write; the body was read before. */
function sendWriteOutcome(res, outcome) {
  if (outcome.ok) {
    sendJson(res, 200, { ok: true, configSha256: outcome.configSha256 });
  } else if (outcome.io !== undefined) {
    sendJson(res, 503, { error: 'io', message: outcome.io });
  } else if (outcome.refused === 'config-changed') {
    sendJson(res, 409, { error: 'config-changed', message: CONFIG_CHANGED });
  } else if (outcome.refused === 'active') {
    sendJson(res, 409, { error: 'active', message: ACTIVE_MESSAGE });
  } else {
    sendJson(res, 409, { error: outcome.refused, message: outcome.message });
  }
}

async function writeCampaign(req, res, ctx, { auditNote }, change) {
  const parsed = await readExact(req, res, ['name', 'configSha256']);
  if (parsed === null) return;
  const ran = await runExclusive(ctx, 'write', async () => {
    try {
      return change(parsed);
    } catch (err) {
      return { io: err.message };
    }
  });
  if (!ran.ok) {
    sendJson(res, 409, { error: 'busy', busy: ran.busy });
    return;
  }
  if (ran.value.ok) {
    if (auditNote) auditNote.affected = parsed.name;
  }
  sendWriteOutcome(res, ran.value);
}

/** POST /api/campaigns/default (audited by the router). Body: { name, configSha256 }. */
function setDefault(req, res, ctx, opts) {
  const configPath = ctx.ctxInfo.configPath;
  return writeCampaign(req, res, ctx, opts, ({ name, configSha256 }) => register.setDefaultFromPanel({ name, configSha256 }, { configPath }));
}

/** POST /api/campaigns/remove (audited by the router). Body: { name, configSha256 }. */
function removeCampaign(req, res, ctx, opts) {
  const configPath = ctx.ctxInfo.configPath;
  const panelDir = ctx.remote && ctx.remote.paths && ctx.remote.paths.panelDir;
  return writeCampaign(req, res, ctx, opts, ({ name, configSha256 }) => {
    const outcome = register.removeFromPanel({ name, configSha256, activeCampaign: ctx.campaign }, { configPath, panelDir });
    if (outcome.ok) preview.dropCampaignPreview(ctx, name);
    return outcome;
  });
}

module.exports = { list, switchCampaign, setDefault, removeCampaign };
