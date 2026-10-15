'use strict';

const path = require('path');
const { createFinding } = require('../../report/finding');
const read = require('../../vault/read');
const { excludedDirUnion, excludedDirHit } = require('../../vault/exclusions');
const { deferredInfo } = require('./outputscan');
const { generatorImageCopies } = require('../../vault/imagecopies');

const COPY_SEVERITY = Object.freeze({ cover: 'warn', banner: 'warn', 'banner-link': 'warn', 'found-banner': 'error' });

function copyMessage(copy, o, h) {
  const s = copy.sourceRel;
  const d = copy.dir;
  if (copy.kind === 'cover') {
    return `${o} is the cover picture set in publish.theme.campaign_image, copied from ${s}, which is under excluded directory "${h}". It is published because the setting names it. To keep it hidden, move the picture out of that folder or change the setting.`;
  }
  if (copy.kind === 'banner') {
    return `${o} is the banner set for "${d}" in the banners setting, copied from ${s}, which is under excluded directory "${h}". It is published because the setting names it. To keep it hidden, move the picture out of that folder or change the setting.`;
  }
  if (copy.kind === 'banner-link') {
    return `${o} is the file the banner for "${d}" links to, set in the banners setting, copied from ${s}, which is under excluded directory "${h}". It is published because the setting names it. To keep it hidden, move the file out of that folder or change the setting.`;
  }
  return `${o} is the banner for "${d}", found automatically at ${s}, which is under excluded directory "${h}". No setting names it, so it is treated as a leak. Move it out of that folder, or set a banner for "${d}" in the banners setting.`;
}

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
 *
 * ADR 0060 (amending ADR 0009, FR-16): inside `build` the pre-build check defers this
 * check (one INFO) instead of judging the old output the build is about to replace.
 * src/build/outputgate.js's scanStagingOutput runs scanExcludedDirsInOutput below against the
 * staging tree instead. A standalone `check` is unchanged.
 */
function runExcludedDirInOutput(ctx) {
  if (ctx.deferOutputScan) return [deferredInfo('leak/l2-excluded-dir-in-output', ctx)];

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

  return scanExcludedDirsInOutput({
    outDir: ctx.outputPath,
    campaign: ctx.campaign,
    vaultPath: ctx.vaultPath,
    jsonConfig: ctx.jsonConfig,
    publishConfig: ctx.publishSet.publishConfig,
    allCandidatePages: ctx.allCandidatePages,
  });
}

/**
 * The scan itself, taking its inputs directly so `build` can point it at the staging tree (ADR
 * 0060) without a context that depends on an `index.html` being there. Returns unsorted findings.
 *
 * @param {object} opts
 * @param {string} opts.outDir absolute, the built tree to read
 * @param {string} opts.campaign
 * @param {string} opts.vaultPath absolute, the vault the site was built from (ADR 0061)
 * @param {object} opts.jsonConfig parsed vault.config.json
 * @param {object} opts.publishConfig the merged publish config (ctx.publishSet.publishConfig)
 * @param {Array<{relPath: string, outputPath: string}>} opts.allCandidatePages
 * @returns {import('../../report/finding').Finding[]}
 */
function scanExcludedDirsInOutput({ outDir, campaign, vaultPath, jsonConfig, publishConfig, allCandidatePages }) {
  const union = excludedDirUnion(jsonConfig, publishConfig);

  const findings = [];

  // Pages arm: every candidate page (allCandidatePages -- unfiltered by exclude_dirs, so a
  // vault- or json-excluded directory's pages are still candidates here; see its own doc comment
  // in src/vault/publishset.js) that landed under an excluded-dir prefix, and genuinely exists in
  // output. computePublishedSet's own publishedPages is not used here: it now correctly matches
  // what a FRESH build would produce (excluded dirs never become pages at all), but this check's
  // whole point is catching a STALE build that predates an exclusion being added.
  for (const page of allCandidatePages) {
    const hit = excludedDirHit(page.relPath, union);
    if (!hit) continue;
    const outFile = path.join(outDir, page.outputPath);
    if (!read.pathExists(outFile)) continue;
    findings.push(
      createFinding({
        id: 'leak/l2-excluded-dir-in-output',
        severity: 'error',
        category: 'leak',
        campaign,
        path: page.relPath,
        outputPath: page.outputPath,
        message: `${page.outputPath} is built from ${page.relPath}, which is under excluded directory "${hit}"`,
      }),
    );
  }

  // Images arm. A file the generator copied as the cover picture or a section banner (same
  // destination and identical bytes, src/vault/imagecopies.js) is judged by the file it was really
  // copied from (ADR 0061): nothing when that file is not hidden, a WARN when the GM named it in a
  // setting, an ERROR for an auto-found _banner.*. Every other file is reconstructed back to
  // <attachmentsDir>/<relPath> (scanAttachments' relPath shape) and judged exactly as before.
  const attachmentsDir = jsonConfig.attachmentsDir || '_attachments';
  const imagesDir = path.join(outDir, 'images');
  if (read.pathExists(imagesDir)) {
    const copies = generatorImageCopies(vaultPath, jsonConfig);
    (function walk(dir, relFromImages) {
      for (const entry of read.listDir(dir)) {
        const full = path.join(dir, entry.name);
        const rel = relFromImages ? `${relFromImages}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          walk(full, rel);
          continue;
        }
        const copy = copies.get(`images/${rel}`);
        if (copy && read.readBytes(full).equals(read.readBytes(copy.sourceAbs))) {
          const sourceHit = excludedDirHit(copy.sourceRel, union);
          if (sourceHit) {
            findings.push(
              createFinding({
                id: 'leak/l2-excluded-dir-in-output',
                severity: COPY_SEVERITY[copy.kind],
                category: 'leak',
                campaign,
                path: copy.sourceRel,
                outputPath: `images/${rel}`,
                message: copyMessage(copy, `images/${rel}`, sourceHit),
              }),
            );
          }
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
            campaign,
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

module.exports = { runExcludedDirInOutput, scanExcludedDirsInOutput };
