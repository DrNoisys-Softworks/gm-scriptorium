'use strict';

/*
 * ADR 0050, sections 1 to 4. Which fields of the one shared admin context belong to a campaign and
 * which to the process, and how a switch moves the campaign's fields. Pure data and plain object
 * moves: this module requires nothing, touches no disk and starts nothing, so it can be read as the
 * whole answer to "what does a switch carry over". test/admin-campaign-fields.test.js scans the
 * source for every ctx.<name> and fails when one is missing from the lists below.
 *
 * test/admin-context.test.js is frozen, so createAdminContext's literal is not edited; the fields
 * the context gains later (previews, variants, the remote stores) are classified here instead.
 */

const CAMPAIGN_FIELDS = Object.freeze({
  // Set from a fresh resolve of the target campaign (the same eight the setup handover copies).
  resolved: Object.freeze(['campaign', 'ctxInfo', 'vaultPath', 'siteSource', 'siteConfigPath', 'packDir', 'writable', 'readOnlyReason']),
  // One set per campaign: stashed on the way out and restored on the way back in.
  kept: Object.freeze(['previewRoot', 'previewDir', 'previewStamp', 'previewPages', 'variants', 'panelSaves']),
  // Rebuilt from the vault on demand: dropped on every switch, and deleted, never set to null
  // (readVaultArt tests for undefined).
  reset: Object.freeze(['vaultArt', 'vaultConfigReview']),
});

const PROCESS_FIELDS = Object.freeze([
  'token', 'adminPort', 'previewPort', 'busy', 'access', 'remote', 'sessions', 'audit', 'lockout', 'tickets', 'clock', 'signinBusy',
  'lastHashMs', 'setup', 'launchCodes', 'campaigns', 'folderDrives',
]);

/** The request header a page sends on every change, naming the campaign it was loaded for. */
const CAMPAIGN_HEADER = 'x-scriptorium-campaign';

/** Audited POSTs the stale-tab check skips: setup has no campaign yet. */
const CAMPAIGN_CHECK_EXEMPT = Object.freeze(['/api/setup/commit']);

/** @param {{ audit?: boolean, method: string, path?: string }} route */
function isCampaignBound(route) {
  return route.audit === true && route.method === 'POST' && !CAMPAIGN_CHECK_EXEMPT.includes(route.path);
}

/**
 * Whether a request's header names the campaign the panel is on. A request with no header passes
 * until the first switch: a stale tab can only exist after one.
 *
 * @param {object} ctx
 * @param {unknown} raw the header value, undefined when absent
 */
function pageMatches(ctx, raw) {
  if (raw === undefined) return !(ctx.campaigns && ctx.campaigns.switches > 0);
  if (typeof raw !== 'string') return false;
  try {
    return decodeURIComponent(raw) === ctx.campaign;
  } catch {
    return false;
  }
}

/** A request that passed the check is counted until it finishes. No-ops when there is no state. */
function enter(ctx) {
  if (ctx.campaigns) ctx.campaigns.inFlight++;
}

function leave(ctx) {
  if (ctx.campaigns) ctx.campaigns.inFlight--;
}

/** @param {{ lockedReason?: string|null }} [opts] */
function createCampaignsState({ lockedReason = null } = {}) {
  return { slots: new Map(), switches: 0, inFlight: 0, lockedReason, probeDeps: undefined };
}

function vaultFlagReason(name) {
  return `This panel was started with --vault, which changes the folder for "${name}" only, so switching campaigns is off. Restart without --vault to switch.`;
}

/** @returns {object|null} the stashed per-campaign fields, or null */
function slotFor(ctx, name) {
  return (ctx.campaigns && ctx.campaigns.slots.get(name)) || null;
}

/**
 * Moves the shared context from its current campaign to the one in `fresh` (a context built by
 * setupmode.resolveFresh). Synchronous, so nothing can run between its steps.
 *
 * @param {object} ctx
 * @param {object} fresh
 */
function applySwitch(ctx, fresh) {
  // 1. Stash what belongs to the campaign being left.
  const slot = { vaultPath: ctx.vaultPath };
  for (const f of CAMPAIGN_FIELDS.kept) {
    if (f in ctx) slot[f] = ctx[f];
  }
  ctx.campaigns.slots.set(ctx.campaign, slot);

  // 2. The target's resolved fields.
  for (const f of CAMPAIGN_FIELDS.resolved) ctx[f] = fresh[f];

  // 3. The target's own slot comes back only if it was stashed for the same vault; anything else
  // gets exactly what a brand-new context has (previewDir null, every other kept field absent).
  const back = ctx.campaigns.slots.get(fresh.campaign);
  ctx.campaigns.slots.delete(fresh.campaign);
  for (const f of CAMPAIGN_FIELDS.kept) delete ctx[f];
  ctx.previewDir = null;
  if (back && back.vaultPath === fresh.vaultPath) {
    for (const f of CAMPAIGN_FIELDS.kept) {
      if (f in back) ctx[f] = back[f];
    }
  }

  // 4. Never carried over.
  for (const f of CAMPAIGN_FIELDS.reset) delete ctx[f];
}

module.exports = {
  CAMPAIGN_FIELDS,
  PROCESS_FIELDS,
  CAMPAIGN_HEADER,
  CAMPAIGN_CHECK_EXEMPT,
  isCampaignBound,
  pageMatches,
  enter,
  leave,
  createCampaignsState,
  vaultFlagReason,
  slotFor,
  applySwitch,
};
