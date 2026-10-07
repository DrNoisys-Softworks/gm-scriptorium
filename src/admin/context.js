'use strict';

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-panel-skeleton-2026-09-28.md section 1.1). The admin
 * request context: everything gate.js, session.js and the handlers need for one launch, bound
 * once at startup (FR03: "resolved once, at launch, and stay fixed for the life of the
 * process"). `runExclusive` is the FR31 mutex ("only one build, check or write runs at a
 * time"): S1 lands and tests it even though nothing in this slice calls it yet, so S2/S3 share
 * one seam instead of inventing their own.
 */

const READ_ONLY_REASON = Object.freeze({
  site_config:
    'This campaign builds from a site_config file, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.',
  pack:
    "This campaign's pack key points at a folder of its own, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.",
});

function readOnlyReasonFor(siteSource) {
  if (siteSource === 'site_config') return READ_ONLY_REASON.site_config;
  if (siteSource === 'pack') return READ_ONLY_REASON.pack;
  return null;
}

/**
 * @param {{ ctxInfo: object, vaultPath: string, site: { siteSource: string, siteConfigPath: string, siteDir: string }, token: string }} args
 */
function createAdminContext({ ctxInfo, vaultPath, site, token }) {
  return {
    campaign: ctxInfo.campaign,
    ctxInfo,
    vaultPath,
    siteSource: site.siteSource,
    siteConfigPath: site.siteConfigPath,
    packDir: site.siteDir,
    writable: site.siteSource === 'convention',
    readOnlyReason: readOnlyReasonFor(site.siteSource),
    token,
    adminPort: null,
    previewPort: null,
    previewDir: null,
    busy: null,
    // Phase 8 slice S2 (Structural decision 3): NOT part of the literal above on purpose --
    // test/admin-context.test.js (S1, frozen, never edited by this slice) asserts
    // createAdminContext's return value with a literal deepEqual that predates this field.
    // ctx.previewRoot is instead added dynamically, the first time src/admin/preview.js's
    // ensurePreviewRoot runs (an ordinary, unexceptional thing to do to a plain object): reading
    // an never-yet-set ctx.previewRoot is `undefined`, which every truthiness check in this
    // slice (`if (ctx.previewRoot)`) treats identically to an explicit `null`. See
    // docs/decisions/0022-gm-admin-panel.md, "Preview builds", for the residual this leaves.
  };
}

/**
 * FR31: only one build, check or write runs at a time. `ctx.busy` is set to `label` for the
 * duration of `fn`, cleared in a `finally` so it clears on a throw too.
 *
 * @param {object} ctx
 * @param {string} label
 * @param {() => Promise<any>} fn
 * @returns {Promise<{ ok: true, value: any } | { ok: false, busy: string }>}
 */
async function runExclusive(ctx, label, fn) {
  if (ctx.busy) {
    return { ok: false, busy: ctx.busy };
  }
  ctx.busy = label;
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    ctx.busy = null;
  }
}

module.exports = { createAdminContext, runExclusive, READ_ONLY_REASON };
