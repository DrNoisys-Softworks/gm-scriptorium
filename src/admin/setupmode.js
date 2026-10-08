'use strict';

const { resolveCampaignContext } = require('../cli/args');
const { resolveVaultSite } = require('../cli/check');
const { createAdminContext } = require('./context');
const { CAMPAIGN_FIELDS } = require('./campaignstate');

/*
 * Browser setup mode (docs/decisions/0028-installer-and-first-run.md, sections 1 and 4). When
 * `serve --admin` starts with no campaign, the one context object the handlers closed over carries
 * `ctx.setup = { active: true, ... }` and the router lets only the routes below through; every
 * other route answers 409 with a fixed body, never a 500. After the setup commit, applyHandover
 * mutates that SAME context into the normal campaign context and clears `active`, so the ports,
 * the token and the cookie are unchanged and nothing restarts.
 */

/** The only routes that answer while setup is active (assets are allowed by their prefix route). */
const SETUP_MODE_ROUTES = Object.freeze([
  'GET /auth',
  'GET /api/session',
  'GET /setup',
  'GET /api/setup/state',
  'GET /api/setup/check',
  'POST /api/setup/commit',
  // ADR 0049: the folder picker's listing and its one create-only folder write.
  'GET /api/folders',
  'POST /api/folders/create',
]);

const FENCE_BODY = JSON.stringify({ error: 'setup', message: 'There is no campaign yet. Finish setup first.' });

/** @param {object} ctx */
function isSetupActive(ctx) {
  return Boolean(ctx && ctx.setup && ctx.setup.active === true);
}

/**
 * What the router does with a matched route while setup is active.
 *
 * @param {object} ctx
 * @param {string} method GET or POST (HEAD already folded into GET)
 * @param {string} pathname
 * @returns {'allow'|'page'|'refuse'}
 */
function fence(ctx, method, pathname) {
  if (!isSetupActive(ctx)) return 'allow';
  if (method === 'GET' && pathname === '/') return 'page';
  return SETUP_MODE_ROUTES.includes(`${method} ${pathname}`) ? 'allow' : 'refuse';
}

// The eight fields the handover copies are the campaign's resolved fields (src/admin/campaignstate.js).
const HANDOVER_FIELDS = CAMPAIGN_FIELDS.resolved;

/**
 * Resolves a campaign from the config into a fresh context, reading the disk (the vault, its
 * vault-config.md, the pack and the site config) synchronously. Shared by the setup handover and by
 * a campaign switch (ADR 0050 section 1); throws the resolver's own error and changes nothing.
 *
 * @param {string} configPath
 * @param {string} name
 * @param {string} token
 */
function resolveFresh(configPath, name, token) {
  const ctxInfo = resolveCampaignContext({ config: configPath }, name);
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  return createAdminContext({ ctxInfo, vaultPath, site, token });
}

/**
 * Turns the setup context into the normal campaign context, in place. Runs once.
 *
 * @param {object} ctx
 * @param {{ name: string }} where
 * @throws {Error} when setup is not active, or when the new campaign cannot be resolved (nothing
 *   on the context has changed in that case)
 */
function applyHandover(ctx, { name }) {
  if (!isSetupActive(ctx)) throw new Error('setup is already finished');
  const fresh = resolveFresh(ctx.setup.configPath, name, ctx.token);
  for (const field of HANDOVER_FIELDS) ctx[field] = fresh[field];
  ctx.setup.active = false;
  ctx.setup.remoteDeferred = null;
}

module.exports = { SETUP_MODE_ROUTES, FENCE_BODY, isSetupActive, fence, resolveFresh, applyHandover };
