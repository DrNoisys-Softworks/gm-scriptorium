'use strict';

const path = require('path');
const { resolveCampaignContext } = require('./args');
const { resolveVaultContext, runCheckForContext, asPackProblem } = require('./check');
const { siteVaultPathMismatchMessage, packShadowedMessage } = require('../checks/configdiv');
const { NON_YAML_LANGUAGE_ID } = require('../checks/frontmatter');
const { runAtomicBuild } = require('../build/run');
const { siteConfigOutputDirCollision } = require('../build/plan');
const { planThemeAssets } = require('../build/themeassets');
const { computePublishedSet } = require('../vault/publishset');
const { VaultUnreachableError } = require('../util/errors');
const { suggestedSlug } = require('../setup/foldermap');
const { EXIT_CODES } = require('../util/exitcodes');
const { SCHEMA_VERSION } = require('../report/json');
const pkg = require('../../package.json');

/**
 * Issue #104: a campaign registered without an output folder used to reach path.resolve(undefined)
 * and crash with a raw TypeError. Say what is missing and how to fix it instead. Issue #108: a
 * campaign problem, so exit 3.
 *
 * @throws {VaultUnreachableError}
 */
function requireOutputFolder(ctxInfo, command) {
  if (typeof ctxInfo.output === 'string' && ctxInfo.output.length > 0) return ctxInfo.output;
  throw new VaultUnreachableError(
    `campaign "${ctxInfo.campaign}" has no output folder, so "${command}" has nowhere to put the site. ` +
      `Pass --out <folder> for this run, or register one with: gm-scriptorium config add ${ctxInfo.campaign} ` +
      '--vault <vault folder> --out <output folder>',
    { path: null, campaign: ctxInfo.campaign, reason: 'no-output' },
  );
}

/**
 * Issue #103: one warning line per vault folder whose typed pages the generator drops because the
 * site config's folderMap has no entry for it. Same finding `check` reports as
 * vault/unmapped-directory, but build must say it too, including under --no-check.
 */
function unmappedDirectoryCounts(unmappedDirectory) {
  const byDir = new Map();
  for (const f of unmappedDirectory) {
    const idx = f.relPath.lastIndexOf('/');
    const dir = idx > 0 ? f.relPath.slice(0, idx) : f.relPath;
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
  }
  return byDir;
}

function unmappedDirectoryWarnings(byDir) {
  return [...byDir.keys()].sort().map((dir) => {
    const n = byDir.get(dir);
    return (
      `warning: ${n} page(s) in "${dir}" were not published: that folder has no folderMap entry in the site config. ` +
      `Add "${dir}" to folderMap (for example "${dir}": "${suggestedSlug(dir)}"), or list it in excludeDirs to leave it out on purpose.`
    );
  });
}

/**
 * Issue #30, FR-03: the generator's own unmapped-folder line (lib/scanner.js, "scanner: skipping
 * "<dir>" - not in publish.folder_map ...") points at _meta/vault-config.md, which contradicts the
 * folderMap advice unmappedDirectoryWarnings gives. Drop it for every folder Scriptorium already
 * reports, so each folder is named once.
 */
const GENERATOR_UNMAPPED_RE = /^scanner: skipping "(.*)" \u2014 not in publish\.folder_map/;
function withoutReportedUnmapped(generatorWarnings, reportedDirs) {
  return generatorWarnings.filter((line) => {
    const m = line.match(GENERATOR_UNMAPPED_RE);
    return !(m && reportedDirs.has(m[1]));
  });
}

/** FR-DEP-11: print a render error by its classifier `kind` (src/generator/bootstrap.js). */
function renderErrorLine(re) {
  if (re.kind === 'party-manifest') return `ERROR building party manifest: ${re.message}`;
  if (re.kind === 'roster') return `ERROR rendering roster ${re.outputPath}: ${re.message}`;
  return `ERROR rendering ${re.outputPath}: ${re.message}`;
}

function baseEnvelope(campaign, vaultPath, outputPath, vaultMismatch, generatedAt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'scriptorium', version: pkg.version },
    campaign,
    vaultPath,
    outputPath,
    vaultMismatch,
    generatedAt,
  };
}

/**
 * `build`: runs `check` first by default and refuses on any ERROR (exit 2,
 * writes nothing). `--no-check` skips checking entirely and says so.
 * `--force` builds anyway and prints every overridden finding.
 *
 * Returns `{ exitCode, human, envelope }`. `envelope` follows the same
 * schemaVersion/tool/campaign/vaultPath/outputPath/generatedAt shape as
 * `check`'s (src/report/json.js), plus build-specific fields, so `--json`
 * carries the same determinism contract: two runs against an unchanged
 * vault and an unchanged (or absent) build produce byte-identical output
 * except `generatedAt` and `elapsedMs` (a build's own wall-clock time,
 * which is not meaningful to hold deterministic the way a finding set is).
 * The nested `check` envelope carries `check`'s own determinism guarantee
 * unchanged: two builds of an unchanged vault produce byte-identical
 * `check.findings`. When `check` ran as part of the build, its own
 * envelope is embedded under `check` rather than summarised, so nothing
 * is lost between `scriptorium check --json` and `scriptorium build --json`.
 */
/**
 * Phase 8 slice S2 (Structural decision 2): the body of runBuildCommand, taking an already-
 * resolved `ctxInfo` instead of resolving it itself. src/admin/preview.js's runPreviewBuild
 * calls this with the launch-bound `ctxInfo` (only `output` overridden to the preview dir), so a
 * preview build resolves the vault and site source ZERO times after launch (FR03). The pre-build
 * check below now calls runCheckForContext with the SAME ctxInfo instead of re-resolving it via
 * runCheckCommand, which is the one behavioural change this extraction makes: a build now
 * resolves config.toml once instead of twice, equivalent to the old two-resolution behaviour
 * unless config.toml changes mid-build (Structural decision 2's residual). Every early-return
 * envelope below is otherwise byte-identical to before this extraction (Risk area 1).
 *
 * @param {object} ctxInfo return value of resolveCampaignContext (args.js:69-76)
 * @param {object} flags parsed CLI flags for `build`
 */
function runBuildForContext(ctxInfo, flags) {
  const generatedAt = new Date().toISOString();
  const { vaultPath, jsonConfig, vaultMismatch, siteDir, packShadowed, packToml } = resolveVaultContext(ctxInfo);
  // ADR 0019, Structural decision 4: the asset step's FILE checks (P3a-FR06) run here, before
  // runAtomicBuild, so a refusal writes nothing -- sweepStaleSiblings never runs, and --force
  // never reaches planThemeAssets (only pack.toml's own SYNTAX validation, inside
  // resolveVaultContext above, and this planning step, ever refuse the asset step; nothing
  // about --force can skip either).
  const themePlan = asPackProblem(
    () => planThemeAssets({ vaultPath, jsonConfig, siteDir, packToml, campaign: ctxInfo.campaign }),
    ctxInfo.campaign,
  );
  const finalOut = path.resolve(requireOutputFolder(ctxInfo, 'build'));
  const forced = Boolean(flags.force);
  const checkSkipped = Boolean(flags['no-check']);

  const lines = [];
  if (vaultMismatch) {
    lines.push(`note: ${siteVaultPathMismatchMessage(vaultMismatch)}`);
  }
  if (packShadowed) {
    lines.push(`note: ${packShadowedMessage(packShadowed)}`);
  }
  // Structural decision 11: pack.toml and asset-step warnings are human-only, never in the
  // JSON envelope.
  for (const w of [...packToml.warnings, ...themePlan.warnings]) lines.push(`warning: ${w}`);

  // Issue #21, defect 1: refuse (overridable by --force) a build whose
  // resolved output equals the site config's own outputDir, so a campaign
  // registered to publish there by accident cannot silently clobber
  // whatever already lives there. See src/build/plan.js for the full
  // reasoning; this is intentionally not an assertSafeOutputDir-style
  // absolute refusal, because that exact directory is a legitimate publish
  // target for plenty of real setups.
  const siteOutputCollision = siteConfigOutputDirCollision(finalOut, siteDir, jsonConfig.outputDir);
  if (siteOutputCollision && !forced) {
    return {
      exitCode: EXIT_CODES.CHECK_FAILED,
      human: [
        ...lines,
        `refusing to build: the resolved output directory is the same directory the site config's own "outputDir" points at (${siteOutputCollision}).`,
        'That can be exactly where you want to publish, so this is not a hard block, but GM-Scriptorium will not write there without confirmation.',
        'If this is genuinely where you want to publish, rerun with --force. Nothing was written.',
      ].join('\n'),
      envelope: {
        ...baseEnvelope(ctxInfo.campaign, vaultPath, finalOut, vaultMismatch, generatedAt),
        ok: false,
        checkSkipped,
        forced,
        check: null,
        refused: true,
        siteOutputDirCollision: siteOutputCollision,
        overriddenFindings: [],
        pagesWritten: null,
        elapsedMs: null,
        notice: null,
        staleOldDir: null,
        error: `resolved output directory matches the site config's own outputDir (${siteOutputCollision}); refusing without --force`,
        renderErrors: [],
        stagingRoot: null,
      },
    };
  }
  if (siteOutputCollision) {
    lines.push(`--force: building into the site config's own outputDir (${siteOutputCollision}) despite the collision guard.`);
  }

  let checkEnvelope = null;
  let overriddenFindings = [];

  if (!checkSkipped) {
    // Track D2, FR-16: this is the pre-build `check`, judging the OLD
    // finalOut `build` is about to replace. deferOutputScan: true makes
    // leak/l4-output-name and leak/l4-index-term each emit one INFO instead
    // of judging that stale tree; the real scan runs below, against this
    // build's own staging tree, via runAtomicBuild -> src/build/outputgate.js.
    const checkResult = runCheckForContext(ctxInfo, flags, { deferOutputScan: true });
    checkEnvelope = checkResult.envelope;
    if (checkEnvelope.counts.error > 0) {
      if (!forced) {
        return {
          exitCode: EXIT_CODES.CHECK_FAILED,
          human: [
            `check found ${checkEnvelope.counts.error} error(s); refusing to build. Nothing was written.`,
            '',
            checkResult.human,
          ].join('\n'),
          envelope: {
            ...baseEnvelope(ctxInfo.campaign, vaultPath, finalOut, vaultMismatch, generatedAt),
            ok: false,
            checkSkipped,
            forced,
            check: checkEnvelope,
            refused: true,
            pagesWritten: null,
            elapsedMs: null,
            notice: null,
            staleOldDir: null,
            error: `check found ${checkEnvelope.counts.error} error(s); refusing to build`,
            renderErrors: [],
            stagingRoot: null,
          },
        };
      }
      // ADR 0034: frontmatter/non-yaml-language is never forceable, so it is excluded from what
      // --force can claim to override here. For a vault with no tagged fences this filter is a
      // no-op and the output is byte-identical to before this slice.
      overriddenFindings = checkEnvelope.findings.filter((f) => f.severity === 'error' && f.id !== NON_YAML_LANGUAGE_ID);
      if (overriddenFindings.length > 0) {
        lines.push(`--force: overriding ${overriddenFindings.length} error finding(s):`);
        for (const f of overriddenFindings) lines.push(`  OVERRIDDEN ${f.id} ${f.path || ''} ${f.message}`);
      }
    }
  } else {
    // FR-15: the staging output scan is not part of `check` at all (it only
    // exists inside `build`, against the staging tree), so `--no-check`
    // cannot skip it — it still runs below, via runAtomicBuild, and can
    // still refuse the build.
    lines.push('--no-check: skipped running check entirely (the staging output scan still ran; see below).');
  }

  const result = runAtomicBuild({
    vaultPath,
    userJsonConfig: jsonConfig,
    finalOut,
    siteDir,
    campaign: ctxInfo.campaign,
    force: forced,
    themePlan,
    vocab: packToml.vocab,
  });

  if (result.refusedByFrontmatter) {
    lines.push(
      `refusing to build: ${result.findings.length} file(s) declare a frontmatter language other than YAML. ` +
        'Scriptorium will not read or build them, and neither --force nor --no-check overrides this. Nothing was written.',
    );
    for (const f of result.findings) lines.push(`  ERROR ${f.id} ${f.path} ${f.message}`);
    return {
      exitCode: EXIT_CODES.CHECK_FAILED,
      human: lines.join('\n'),
      envelope: {
        ...baseEnvelope(ctxInfo.campaign, vaultPath, finalOut, vaultMismatch, generatedAt),
        ok: false,
        checkSkipped,
        forced,
        check: checkEnvelope,
        refused: true,
        refusedByFrontmatter: true,
        frontmatterFindings: result.findings,
        overriddenFindings: [],
        pagesWritten: null,
        elapsedMs: null,
        notice: null,
        staleOldDir: null,
        error: `${result.findings.length} file(s) declare a non-YAML frontmatter language; refusing to build (not overridable)`,
        renderErrors: [],
        stagingRoot: null,
      },
    };
  }

  if (result.refusedByScan) {
    lines.push(`the output-leak scan found ${result.findings.length} error finding(s) in the staged build; refusing to swap. Nothing was written.`);
    for (const f of result.findings) lines.push(`  ${f.severity.toUpperCase()} ${f.id} ${f.outputPath || f.path || ''} ${f.message}`);
    return {
      exitCode: EXIT_CODES.CHECK_FAILED,
      human: lines.join('\n'),
      envelope: {
        ...baseEnvelope(ctxInfo.campaign, vaultPath, finalOut, vaultMismatch, generatedAt),
        ok: false,
        checkSkipped,
        forced,
        check: checkEnvelope,
        refused: true,
        refusedByScan: true,
        outputScanFindings: result.findings,
        overriddenFindings: [],
        pagesWritten: null,
        elapsedMs: null,
        notice: null,
        staleOldDir: null,
        error: `the output-leak scan found ${result.findings.length} error finding(s); refusing to build`,
        renderErrors: [],
        stagingRoot: null,
      },
    };
  }

  if (!result.ok) {
    lines.push(`build failed: ${result.error.message}`);
    for (const re of result.renderErrors) lines.push(`  ${renderErrorLine(re)}`);
    lines.push(`staging tree kept for inspection at: ${result.stagingRoot}`);
    return {
      exitCode: EXIT_CODES.SCRIPTORIUM_ERROR,
      human: lines.join('\n'),
      envelope: {
        ...baseEnvelope(ctxInfo.campaign, vaultPath, finalOut, vaultMismatch, generatedAt),
        ok: false,
        checkSkipped,
        forced,
        check: checkEnvelope,
        refused: false,
        overriddenFindings: forced ? overriddenFindings : [],
        pagesWritten: null,
        elapsedMs: null,
        notice: null,
        staleOldDir: null,
        error: result.error.message,
        renderErrors: result.renderErrors,
        stagingRoot: result.stagingRoot,
      },
    };
  }

  // Track D2: `force` overrides both the pre-build check's ERROR findings
  // AND a staging-scan hit; the staging-scan findings join the SAME
  // overriddenFindings array, so it stays the complete record of what was
  // overridden (Structural decision 5, file map note on src/cli/build.js).
  if (result.outputScan && result.outputScan.overridden) {
    overriddenFindings = [...overriddenFindings, ...result.outputScan.findings];
    lines.push(`--force: overriding ${result.outputScan.findings.length} output-leak scan finding(s):`);
    for (const f of result.outputScan.findings) lines.push(`  OVERRIDDEN ${f.id} ${f.outputPath || f.path || ''} ${f.message}`);
  }

  lines.push(`built ${result.pagesWritten} file(s) in ${result.elapsedMs.toFixed(1)}ms -> ${result.finalOut}`);
  const unmappedByDir = unmappedDirectoryCounts(computePublishedSet(vaultPath, jsonConfig).unmappedDirectory);
  // Issue #30, FR-01: the generator's own warn-level lines, human and JSON alike. Human-only
  // Scriptorium warnings below are unchanged. A zero-warning build prints nothing extra.
  const generatorWarnings = withoutReportedUnmapped(result.generatorWarnings || [], unmappedByDir);
  if (generatorWarnings.length > 0) {
    lines.push(`${generatorWarnings.length} generator warning(s):`);
    for (const w of generatorWarnings) lines.push(w);
  }
  for (const w of unmappedDirectoryWarnings(unmappedByDir)) lines.push(w);
  // Engineering Brief "Story timeline + Connections lane" (2026-09-24), Structural decision 11:
  // each apply's warnings are human-only, printed after "built N file(s)", never in the JSON
  // envelope (residual).
  for (const w of (result.timeline && result.timeline.warnings) || []) lines.push(`warning: timeline: ${w}`);
  for (const w of (result.connections && result.connections.warnings) || []) lines.push(`warning: connections: ${w}`);
  // ADR 0036, SD-7: human-only, same convention as the two lines above, so these still print with
  // --no-check (:132-169 above prints only errors from the pre-build check, which --no-check
  // skips entirely -- these warnings are not from that check). `unreadable` names a hub the site
  // withheld but whose Wrap-Up link this build could not itself read back off the page; `divergence`
  // names a hub where check's own recomputed pairing disagrees with what the site actually built --
  // recaps/timeline/Connections always follow the site, never this recomputation.
  for (const hub of (result.sessionPairs && result.sessionPairs.unreadable) || []) {
    lines.push(
      `warning: sessions: ${hub}: the site shows this session's Wrap-Up recap, but Scriptorium ` +
        "couldn't tell which Wrap-Up it is, so the timeline and Connections treat it as a session without one.",
    );
  }
  for (const d of (result.sessionPairs && result.sessionPairs.divergence) || []) {
    lines.push(
      `warning: sessions: ${d.hub}: check reads this session's Wrap-Up link differently from the site ` +
        `(site: ${d.site || 'none'}, check: ${d.check || 'none'}). The timeline and Connections follow the site; ` +
        "check's leak results for this session may not match it.",
    );
  }
  const degraded = (result.redactions || []).filter((r) => r.calls > 0);
  if (degraded.length > 0) {
    lines.push(
      `note: ${degraded.length} rules-content redaction(s) degraded this build (${degraded
        .map((r) => `${r.id}: ${r.calls}`)
        .join(', ')}). See THIRD-PARTY-NOTICES.txt.`,
    );
  }
  if (result.notice) {
    lines.push(
      `wrote NOTICE.txt (${result.notice.pagesLinked} page(s) linked to it). It lists the third-party ` +
        'code in your site. Keep it when you publish.',
    );
  }
  if (result.staleOldDir) {
    lines.push(`warning: could not remove the previous site backup at ${result.staleOldDir}; it was left in place`);
  }

  return {
    exitCode: EXIT_CODES.OK,
    human: lines.join('\n'),
    envelope: {
      ...baseEnvelope(ctxInfo.campaign, vaultPath, finalOut, vaultMismatch, generatedAt),
      ok: true,
      checkSkipped,
      forced,
      check: checkEnvelope,
      refused: false,
      refusedByScan: false,
      overriddenFindings: forced ? overriddenFindings : [],
      pagesWritten: result.pagesWritten,
      elapsedMs: result.elapsedMs,
      notice: result.notice || null,
      redactions: result.redactions || [],
      staleOldDir: result.staleOldDir || null,
      outputScan: result.outputScan,
      generatorWarnings,
      error: null,
      renderErrors: [],
      stagingRoot: null,
    },
  };
}

/**
 * @param {object} flags parsed CLI flags for `build`
 * @param {string} [campaignArg]
 */
function runBuildCommand(flags, campaignArg) {
  const ctxInfo = resolveCampaignContext(flags, campaignArg);
  return runBuildForContext(ctxInfo, flags);
}

module.exports = { runBuildCommand, runBuildForContext, requireOutputFolder };
