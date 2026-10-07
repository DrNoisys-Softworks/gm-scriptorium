'use strict';

const { resolveCampaignContext } = require('../cli/args');
const { resolveVaultSite } = require('../cli/check');
const { createAdminContext } = require('./context');

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

const HANDOVER_FIELDS = ['campaign', 'ctxInfo', 'vaultPath', 'siteSource', 'siteConfigPath', 'packDir', 'writable', 'readOnlyReason'];

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
  const ctxInfo = resolveCampaignContext({ config: ctx.setup.configPath }, name);
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  const fresh = createAdminContext({ ctxInfo, vaultPath, site, token: ctx.token });
  for (const field of HANDOVER_FIELDS) ctx[field] = fresh[field];
  ctx.setup.active = false;
  ctx.setup.remoteDeferred = null;
}

module.exports = { SETUP_MODE_ROUTES, FENCE_BODY, isSetupActive, fence, applyHandover };
