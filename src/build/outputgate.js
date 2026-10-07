'use strict';

const { buildCheckContext } = require('../checks/context');
const { collectWithheldNames } = require('../checks/leak/l4');
const { scanOutputTree, scanSearchIndex } = require('../checks/leak/outputscan');
const { collectComments, scanCommentsInOutput } = require('../checks/leak/commentscan');
const { createFinding, sortFindings } = require('../report/finding');
const { GM_LINK_MARKER, findGmLinkMarker } = require('./gmmarker');

/*
 * Track D2, Structural decisions 3-5: the gate `runAtomicBuild` calls
 * between the generator run and `swapIntoPlace` (src/build/run.js). This is
 * deliberately NOT `runChecks` against the registry — it scans directly, so
 * there is no id-enable/disable surface, no `--graph`, nothing a caller can
 * turn off. It runs unconditionally, against the STAGING tree the command
 * is actually about to publish, every single build, with no way to skip it
 * (only `runAtomicBuild`'s `force` argument can override the RESULT, never
 * the scan itself).
 */

/**
 * @param {object} opts
 * @param {string} opts.vaultPath absolute
 * @param {object} opts.jsonConfig parsed vault.config.json, vaultPath already resolved
 * @param {string} opts.stagingOut absolute, the fully-built staging tree (after the
 *   generator run, the sessions-index write, the NOTICE pass, the house-style
 *   write+link pass, and the ADR 0019 theme/image-slot asset pass — i.e. exactly
 *   what would be swapped into finalOut)
 * @param {string} opts.campaign
 * @returns {import('../report/finding').Finding[]} sorted, may be empty
 */
function scanStagingOutput({ vaultPath, jsonConfig, stagingOut, campaign }) {
  const ctx = buildCheckContext({ campaign, vaultPath, jsonConfig, outputPath: stagingOut });
  const withheld = collectWithheldNames(ctx);
  const findings = [
    ...scanOutputTree({ outDir: stagingOut, campaign, withheld }),
    ...scanSearchIndex({ outDir: stagingOut, campaign, withheld }),
  ];
  return sortFindings(findings);
}

/*
 * Phase 8 slice S6, Structural decision 2 (docs/agent-runs/admin-s6-engineering-brief-
 * 2026-09-28.md): a SEPARATE scan from scanStagingOutput above, deliberately -- its findings must
 * never be able to reach `force`'s override path (src/build/run.js:171's `scanHasError && !force`
 * decision applies only to scanStagingOutput's own findings). run.js calls this one on its own,
 * before, and entirely outside, that force handling, so a hit here can never be overridden by
 * any parameter of runAtomicBuild. See run.js for the call site and the unconditional refusal.
 */

/**
 * @param {object} opts
 * @param {string} opts.stagingOut absolute, the fully-staged build tree about to be swapped in
 * @param {string} opts.campaign
 * @returns {import('../report/finding').Finding[]} sorted, may be empty
 */
function scanGmLinkMarker({ stagingOut, campaign }) {
  const hits = findGmLinkMarker(stagingOut);
  const findings = hits.map((rel) =>
    createFinding({
      id: 'build/gm-link-marker',
      severity: 'error',
      category: 'build',
      campaign,
      outputPath: rel,
      message: `${rel} contains the admin panel's GM link marker "${GM_LINK_MARKER}"; a GM link is never published, and --force cannot override this`,
    }),
  );
  return sortFindings(findings);
}

/**
 * ADR 0044: a SEPARATE scan, like scanGmLinkMarker, so it can never reach `force`'s override. The
 * GM wrote %%...%% to hide text; a build that publishes it is refused whatever --force says.
 *
 * @param {object} opts same as scanStagingOutput
 * @returns {import('../report/finding').Finding[]} sorted, may be empty
 */
function scanCommentSurvivors({ vaultPath, jsonConfig, stagingOut, campaign }) {
  const ctx = buildCheckContext({ campaign, vaultPath, jsonConfig, outputPath: stagingOut });
  return sortFindings(scanCommentsInOutput({ outDir: stagingOut, campaign, comments: collectComments(ctx) }));
}

module.exports = { scanStagingOutput, scanGmLinkMarker, scanCommentSurvivors };
