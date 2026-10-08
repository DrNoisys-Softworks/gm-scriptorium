'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runBuildForContext } = require('../cli/build');
const { ScriptoriumError } = require('../util/errors');
const gmlink = require('./gmlink');
const { EXIT_CODES } = require('../util/exitcodes');

/*
 * Phase 8 slice S2, Structural decisions 1 and 3 (docs/agent-runs/admin-s2-engineering-brief-
 * 2026-09-28.md). Preview builds run in-process, against the ctxInfo bound at launch (FR03):
 * runPreviewBuild below is the one function the NFR02 fallback seam (Architect output section
 * 1.7) would swap for a child process if that evidence had failed. The preview root is never a
 * sibling of the configured output (Risk area 2), so a concurrent CLI build's sweepStaleSiblings
 * (src/build/swap.js) can never reach it, and it is created lazily so a campaign that never
 * builds a preview never touches the filesystem for this at all.
 */

/**
 * Creates ctx.previewRoot/ctx.previewDir on the first call; idempotent after that. The caller
 * holds runExclusive around the build that follows, not around this.
 *
 * @param {object} ctx an admin context (context.js)
 * @returns {string} ctx.previewDir
 * @throws {ScriptoriumError} SD-3's fail-closed check: the real path of the new preview root
 *   must never equal the real (or, if not yet created, lexical) parent of the configured output
 */
function ensurePreviewRoot(ctx) {
  if (ctx.previewRoot) return ctx.previewDir;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-preview-'));

  const configuredOutput = ctx.ctxInfo && ctx.ctxInfo.output ? path.resolve(ctx.ctxInfo.output) : null;
  if (configuredOutput) {
    const configuredParent = path.dirname(configuredOutput);
    const realRoot = realOrLexical(root);
    const realConfiguredParent = realOrLexical(configuredParent);
    if (realRoot === realConfiguredParent) {
      throw new ScriptoriumError(
        `refusing to use ${root} as the preview root: it is the same directory as the configured output's parent (${configuredParent})`,
      );
    }
  }

  ctx.previewRoot = root;
  ctx.previewDir = path.join(root, 'site');
  return ctx.previewDir;
}

function realOrLexical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Runs the same pipeline `scriptorium build` uses (pre-check refusal on any ERROR, output-leak
 * scan, atomic swap), against the launch-bound ctxInfo with only `output` overridden to the
 * preview dir. No `force`, no `no-check` (FR29): the panel offers neither. The caller holds
 * runExclusive around this call.
 *
 * @param {object} ctx an admin context, with ctx.previewDir already set by ensurePreviewRoot
 * @returns {{ exitCode: number, human: string, envelope: object }}
 */
function runPreviewBuild(ctx) {
  return runBuildForContext({ ...ctx.ctxInfo, output: ctx.previewDir }, {});
}

/**
 * FR33/SD-5: runs the same build runPreviewBuild does, then, only on a successful build, adds
 * the GM link to every preview page (src/admin/gmlink.js). The GM link is deliberately never
 * added inside runPreviewBuild itself -- test/admin-preview.test.js's own NFR02 and FR29 tests
 * call runPreviewBuild directly and assert against an unpatched tree -- and it is added strictly
 * AFTER runBuildForContext returns, i.e. after FR34(b)'s unconditional output-gate marker check
 * has already run (src/build/run.js) against the staged tree that became this preview: the link
 * is never present anywhere the gate itself inspects.
 *
 * @param {object} ctx an admin context, with ctx.previewDir/ctx.previewRoot already set by
 *   ensurePreviewRoot and ctx.adminPort already bound
 * @returns {{ exitCode: number, human: string, envelope: object }} unchanged from runPreviewBuild
 */
function buildPreviewWithGmLink(ctx) {
  const result = runPreviewBuild(ctx);
  if (result.exitCode === EXIT_CODES.OK) {
    gmlink.injectGmLinks(ctx);
  }
  return result;
}

/**
 * Best-effort, swallowed (precedent: src/build/run.js:182-186's cleanup-after-refusal). A locked
 * file (Windows) or any other removal failure must never change SIGINT's exit code (NFR07); see
 * docs/decisions/0022-gm-admin-panel.md, "Preview builds".
 *
 * @param {object} ctx
 */
function removePreviewRoot(ctx) {
  if (!ctx.previewRoot) return;
  try {
    fs.rmSync(ctx.previewRoot, { recursive: true, force: true });
  } catch {
    // best-effort only; see doc comment above
  }
  ctx.previewRoot = null;
  ctx.previewDir = null;
}

/**
 * ADR 0050 section 3: stop removes the current campaign's root and every stashed campaign's root.
 * Best-effort and swallowed, like removePreviewRoot; tolerates a context with no campaigns state.
 *
 * @param {object} ctx
 */
function removeAllPreviewRoots(ctx) {
  removePreviewRoot(ctx);
  if (!ctx.campaigns) return;
  for (const slot of ctx.campaigns.slots.values()) {
    if (!slot.previewRoot) continue;
    try {
      fs.rmSync(slot.previewRoot, { recursive: true, force: true });
    } catch {
      // best-effort only, as above
    }
  }
  ctx.campaigns.slots.clear();
}

/**
 * Drops one stashed campaign's preview: its root is removed (best-effort) and its slot forgotten.
 * Used when a campaign is removed from the list, and when a switch finds that a stashed campaign
 * now points at another vault.
 *
 * @param {object} ctx
 * @param {string} name
 */
function dropCampaignPreview(ctx, name) {
  if (!ctx.campaigns) return;
  const slot = ctx.campaigns.slots.get(name);
  if (!slot) return;
  if (slot.previewRoot) {
    try {
      fs.rmSync(slot.previewRoot, { recursive: true, force: true });
    } catch {
      // best-effort only, as above
    }
  }
  ctx.campaigns.slots.delete(name);
}

module.exports = { ensurePreviewRoot, runPreviewBuild, buildPreviewWithGmLink, removePreviewRoot, removeAllPreviewRoots, dropCampaignPreview };
