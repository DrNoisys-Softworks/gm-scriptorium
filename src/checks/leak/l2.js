'use strict';

const path = require('path');
const { createFinding } = require('../../report/finding');
const read = require('../../vault/read');
const { excludedDirUnion, excludedDirHit } = require('../../vault/exclusions');

/**
 * L2: an output file whose source lies inside a directory listed in the
 * UNION of vault.config.json:excludeDirs and
 * _meta/vault-config.md:publish.exclude_dirs. The union is the whole
 * point: `_attachments/maps` appears only in the vault file, whose
 * exclude_dirs is read by nothing (Correction 1), so those three map
 * files reach the built site regardless of anyone's intent. This check
 * reads the ACTUAL built output on disk (not a source-side simulation),
 * so it also catches drift between a stale build and the current config.
 * When no build exists, it emits INFO rather than silently passing.
 *
 * "No build exists" covers two distinct states, and both must emit the
 * INFO rather than silently returning nothing: the output directory not
 * existing at all, and the output directory existing but empty (no
 * `index.html`, the marker `build()` always writes last on success). The
 * second case matters in practice: the migration layout
 * (retained in the private archive at `b5b48b4`) pre-creates `{vault,site,out,sessions}` for every
 * campaign, so a freshly set-up campaign's `out/` exists and is empty,
 * and that is exactly the state the very first `check` a user runs sees.
 * ctx.outputPath (from src/checks/context.js) is only set when a real
 * build was found; ctx.outputPathConfigured is set whenever the output
 * path is merely configured, whether or not anything has been built
 * there, which is what lets the two INFO messages below tell a user
 * whether they need to create the directory or just run `build`.
 */
function runExcludedDirInOutput(ctx) {
  if (!ctx.outputPath) {
    const configuredButEmpty = Boolean(ctx.outputPathConfigured) && read.pathExists(ctx.outputPathConfigured);
    return [
      createFinding({
        id: 'leak/l2-excluded-dir-in-output',
        severity: 'info',
        category: 'leak',
        campaign: ctx.campaign,
        message: configuredButEmpty
          ? `the output directory (${ctx.outputPathConfigured}) exists but has no build in it; leak/l2 cannot check built output yet, run "build" first`
          : 'no output directory exists at the configured path; leak/l2 cannot check built output yet',
      }),
    ];
  }

  const union = excludedDirUnion(ctx.jsonConfig, ctx.publishSet.publishConfig);

  const findings = [];

  // Pages arm: every candidate page (ctx.allCandidatePages -- unfiltered by exclude_dirs, so a
  // vault- or json-excluded directory's pages are still candidates here; see its own doc comment
  // in src/vault/publishset.js) that landed under an excluded-dir prefix, and genuinely exists in
  // output. computePublishedSet's own publishedPages is not used here: it now correctly matches
  // what a FRESH build would produce (excluded dirs never become pages at all), but this check's
  // whole point is catching a STALE build that predates an exclusion being added.
  for (const page of ctx.allCandidatePages) {
    const hit = excludedDirHit(page.relPath, union);
    if (!hit) continue;
    const outFile = path.join(ctx.outputPath, page.outputPath);
    if (!read.pathExists(outFile)) continue;
    findings.push(
      createFinding({
        id: 'leak/l2-excluded-dir-in-output',
        severity: 'error',
        category: 'leak',
        campaign: ctx.campaign,
        path: page.relPath,
        outputPath: page.outputPath,
        message: `${page.outputPath} is built from ${page.relPath}, which is under excluded directory "${hit}"`,
      }),
    );
  }

  // Images arm: everything under <output>/images, reconstructed back to
  // <attachmentsDir>/<relPath> (scanAttachments' relPath shape). The
  // campaign_image special case (images/<basename>, source outside
  // attachmentsDir) is not reconstructed here; it is a rarer path and not
  // part of the real vault's known leak.
  const attachmentsDir = ctx.jsonConfig.attachmentsDir || '_attachments';
  const imagesDir = path.join(ctx.outputPath, 'images');
  if (read.pathExists(imagesDir)) {
    (function walk(dir, relFromImages) {
      for (const entry of read.listDir(dir)) {
        const full = path.join(dir, entry.name);
        const rel = relFromImages ? `${relFromImages}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          walk(full, rel);
          continue;
        }
        const sourceRel = `${attachmentsDir}/${rel}`;
        const hit = excludedDirHit(sourceRel, union);
        if (!hit) continue;
        findings.push(
          createFinding({
            id: 'leak/l2-excluded-dir-in-output',
            severity: 'error',
            category: 'leak',
            campaign: ctx.campaign,
            path: sourceRel,
            outputPath: `images/${rel}`,
            message: `images/${rel} is copied from ${sourceRel}, which is under excluded directory "${hit}"`,
          }),
        );
      }
    })(imagesDir, '');
  }

  return findings;
}

module.exports = { runExcludedDirInOutput };
