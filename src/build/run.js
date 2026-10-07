'use strict';

const fs = require('fs');
const path = require('path');
const { planBuild } = require('./plan');
const { writeStagedConfig, mirrorSiteInputs } = require('./stage');
const { swapIntoPlace, sweepStaleSiblings } = require('./swap');
const { runGeneratorBuild } = require('../generator/bootstrap');
const { writeSiteNotice } = require('./notice');
const { writeHouseStyle } = require('./housestyle');
const { writeThemeAssets } = require('./themeassets');
const { writeSessionsIndex } = require('./sessions-index');
const { applySessionBadgeFields } = require('./sessionbadges');
const { applyDateFormat } = require('./dates');
const { applyAccordionOpen } = require('./accordions');
const { applyTimeline } = require('./timeline');
const { applyConnections } = require('./connections');
const { writeSiteScript } = require('./sitescript');
const { applyStoryFocus } = require('./storyfocus');
const { applyPageTurn } = require('./pageturn');
const { captureWithheldHubs, compareSessionPairs } = require('./sessionmodel');
const { scanStagingOutput, scanGmLinkMarker, scanCommentSurvivors } = require('./outputgate');
const { ScriptoriumError } = require('../util/errors');
const { nonYamlLanguageFindings } = require('../checks/frontmatter');
const { computePublishedSet } = require('../vault/publishset');
const sessionpairs = require('../vault/sessionpairs');

/**
 * The atomic build: plan -> stage -> run the generator against the
 * staging config -> scan the staged output for a withheld-name leak
 * (Track D2) -> swap on success. On any throw, finalOut is left untouched
 * and the staging tree is kept (with its absolute path in the error)
 * rather than cleaned up, so a failed build is diagnosable (Engineering
 * Brief section 3, step 8).
 *
 * Track D2, Structural decision 5: the output-leak scan (src/build/outputgate.js)
 * always runs here, unconditionally — there is no parameter, callback, or
 * code path that can build without scanning. `force` only overrides the
 * RESULT of a hit (swap anyway, and say what was overridden); it never
 * skips the scan itself. Every caller of runAtomicBuild — product
 * (src/cli/build.js) and the three non-product callers that deliberately
 * build leaky vaults (scripts/equivalence-check.js,
 * scripts/l4-render-audit.js, test/publish-equivalence.test.js) — must now
 * pass `campaign` and, for the three leaky-vault callers, `force: true`,
 * which is a loud, greppable statement of exactly what they are overriding.
 *
 * @param {object} opts
 * @param {string} opts.vaultPath absolute
 * @param {object} opts.userJsonConfig parsed vault.config.json
 * @param {string} opts.finalOut absolute output dir, from Scriptorium's own config
 * @param {string} opts.siteDir absolute, the user's site config's own directory (FR-DEP-10)
 * @param {string} opts.campaign
 * @param {boolean} [opts.force] override a scan hit and swap anyway
 * @param {object|null} [opts.themePlan] ADR 0019: the pre-validated theme/image-slot plan from
 *   src/build/themeassets.js's planThemeAssets, or null/omitted for a build with no pack.toml
 *   (byte-identical to a build before ADR 0019 -- writeThemeAssets touches nothing for a null
 *   or empty plan).
 * @param {object} [opts.vocab] ADR 0020: the resolved [labels]/[timeline]/[recaps] object
 *   (src/build/labels.js), or omitted for the default vocabulary.
 * @returns {{ ok: true, finalOut: string, pagesWritten: number, elapsedMs: number, staleOldDir: string|null, redactions: { id: string, calls: number }[], outputScan: { findings: object[], overridden: boolean } } |
 *           { ok: false, refusedByFrontmatter: true, findings: object[], stagingRoot: null } |
 *           { ok: false, refusedByScan: true, findings: object[], stagingRoot: null } |
 *           { ok: false, error: Error, stagingRoot: string, renderErrors: object[] }}
 * @throws {ScriptoriumError} if siteDir is not an absolute string, or campaign is missing
 */
/**
 * Issue #30: the generator's `warn`-level console lines for a successful build, as the user
 * should read them. Leading whitespace is trimmed (the generator indents its own WARNING lines).
 * NFR-01: the generator is pointed at the per-build staging tree, so any line that names it would
 * differ on every build. Rewrite the staged output folder to the final one (where the site ends
 * up) and any other staging path to a fixed token, so two builds of an unchanged vault agree.
 * Residual: only these two literal paths are rewritten; a generator line carrying a different
 * spelling of the staging path (for example a realpath through a symlink) would not be.
 */
function generatorWarningLines(detail, { stagingRoot, stagingOut, finalOut }) {
  const swap = (text, from, to) => (from ? text.split(from).join(to) : text);
  return (detail || [])
    .filter((entry) => entry.level === 'warn')
    .map((entry) => swap(swap(entry.text, stagingOut, finalOut), stagingRoot, '<staging>').replace(/^\s+/, ''));
}

function runAtomicBuild({ vaultPath, userJsonConfig, finalOut, siteDir, campaign, force = false, themePlan = null, vocab }) {
  if (typeof siteDir !== 'string' || siteDir.length === 0 || !path.isAbsolute(siteDir)) {
    throw new ScriptoriumError(`siteDir must be an absolute path, got: ${siteDir}`);
  }
  if (typeof campaign !== 'string' || campaign.length === 0) {
    throw new ScriptoriumError(`campaign must be a non-empty string, got: ${campaign}`);
  }

  // ADR 0034: unconditional; no parameter of runAtomicBuild can skip or override it; runs before
  // anything is written. Uses the SAME predicate and walk set check's frontmatter/non-yaml-
  // language finding does (src/checks/frontmatter.js), so a clean `check` means this passes too.
  const fenceFindings = nonYamlLanguageFindings({ vaultPath, campaign });
  if (fenceFindings.length > 0) {
    return { ok: false, refusedByFrontmatter: true, findings: fenceFindings, stagingRoot: null };
  }

  sweepStaleSiblings(finalOut);
  const { stagingRoot, stagingOut } = planBuild(vaultPath, finalOut);
  const configPath = writeStagedConfig(userJsonConfig, vaultPath, stagingRoot, stagingOut);
  mirrorSiteInputs(siteDir, stagingRoot);

  const start = process.hrtime.bigint();
  const { error, renderErrors, detail, redactions } = runGeneratorBuild(configPath);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  // Treat any captured render error as a build failure even if build()
  // itself did not throw (Engineering Brief section 2: build() throws
  // with err.errorCount set after writing everything, but the caller
  // should not swap a site that had per-page render errors).
  if (error || renderErrors.length > 0) {
    return {
      ok: false,
      error: error || new ScriptoriumError(`build completed with ${renderErrors.length} render error(s)`),
      renderErrors,
      detail,
      stagingRoot,
    };
  }

  // ADR 0036, SD-1: which output pages the pin itself withheld-and-replaced for a paired session
  // Wrap-Up (src/build/sessionmodel.js). Read straight off the generator's own raw output, before
  // any Scriptorium transform below touches a page, so this can never see a transform's own
  // output mistaken for the pin's, and FR-02 (build-side pairing equals what the generator did)
  // holds by construction.
  const { wrapUpByHub, unreadable } = captureWithheldHubs(stagingOut);

  // SD-1's proof (e): the check-side pairing, recomputed independently through the pin's own
  // pairHubs, compared at runtime against what was just read off the real pages above. Any
  // disagreement is named in a human-only `warning: sessions:` line below (SD-7) -- recaps,
  // timeline and Connections always follow `wrapUpByHub` (what the site actually shows),
  // never this recomputation.
  const sessionPublishSet = computePublishedSet(vaultPath, userJsonConfig);
  const sessionPairing = sessionpairs.computeSessionPairing({ vaultPath, publishSet: sessionPublishSet });
  const sessionPairDivergence = compareSessionPairs(wrapUpByHub, sessionPairing);

  // UI-01 / issue 214 (docs/decisions/0006-post-build-page-writer.md): the generator never writes
  // sessions/index.html, so Scriptorium writes it here, before the notice footer pass below picks
  // it up like any other page.
  const sessionsIndex = writeSessionsIndex(stagingOut, { siteTitle: userJsonConfig.siteTitle });

  // The fourth licence-provenance fix (docs/PROVENANCE.md B4): every site
  // gm-apprentice-publish builds redistributes lunr.js and its own CSS/JS
  // under MIT without a complete notice. Write NOTICE.txt and link it from
  // every page's footer before the swap, so it ships as part of the same
  // atomic build rather than as a separate, skippable step.
  const searchEnabled = userJsonConfig.searchEnabled !== false;
  const notice = writeSiteNotice(stagingOut, { searchEnabled });

  // SD-2/SD-5 (Engineering Brief, "Scriptorium house stylesheet + desktop redesign",
  // 2026-09-20): writes the embedded product stylesheet to css/scriptorium.css and links it
  // on every page, after the notice pass (so the cloned sessions index gets the link like any
  // other page) and before the leak scan (so the scanned tree is exactly the tree that swaps).
  const houseStyle = writeHouseStyle(stagingOut);

  // ADR 0019 ("Themes, image slots and the asset step"): the theme/image-slot asset pass runs
  // immediately after writeHouseStyle (so it can anchor its <link> on the housestyle tag every
  // page already carries, SD-2) and before every other post-build transform, so its own output
  // (css/scriptorium-theme.css, scriptorium/**) is part of the exact tree those transforms and
  // the leak scan below see. A throw here (E-COLLISION) must not leave a stray staging tree
  // behind, so cleanup follows the same best-effort, swallowed pattern as the scan-refusal path
  // below rather than propagating a cleanup failure over the real error.
  let themeAssets;
  try {
    themeAssets = writeThemeAssets(stagingOut, themePlan);
  } catch (err) {
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      /* best-effort, as the scan-refusal path */
    }
    throw err;
  }

  // The Story nav split toggle transform (src/build/storynav.js, ADR 0014) is retired: upstream's
  // publish-v1.12.4 renders the grouped Story toggle as a <button> that only opens the menu, with
  // "Story so far" as the menu's first entry. See docs/decisions/0014-story-nav-split-toggle.md's addendum.

  // Downstream shim pending upstream (ADR 0014 final addendum): Escape inside the Story dropdown returns
  // focus to its toggle. Before the leak scan, so the scanned tree is the tree that swaps.
  const storyFocus = applyStoryFocus(stagingOut);

  // FR-20/SD-20 (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md): retired.
  // recap-emphasis.js turned the landing recap's wrapping *...* into <em>...</em> by hand,
  // superseded by upstream's own #269 fix -- at publish-v1.11.40 the pin itself renders that
  // emphasis as real HTML (extractRecapHtml), so Scriptorium's transform would now be a no-op at
  // best (its own marker check already made it self-skip once the recap held <em>) and dead
  // weight at worst. See docs/decisions/0015-haze-home-and-recap-emphasis.md's addendum.

  // Engineering Brief "Book leaves + motion" (2026-09-24), FR-07/FR-08/FR-12/FR-11 (plus
  // AMENDMENT 1 E-3/E-6): session badge field-keying, the #40 date transform, PC accordions
  // open-on-arrival, and the page-turn head script (+ .vt-fx). After writeHouseStyle (so the
  // cloned sessions index gets patched like any other page) and before the leak scan (so the
  // scanned tree is exactly the tree that swaps). Badges run before dates because they match the
  // raw Date string inside the badge block.
  const sessionBadges = applySessionBadgeFields(stagingOut, { vaultPath, jsonConfig: userJsonConfig });
  const dates = applyDateFormat(stagingOut);
  const accordions = applyAccordionOpen(stagingOut);

  // Engineering Brief "Story timeline + Connections lane" (2026-09-24), Structural decision 2:
  // after applySessionBadgeFields/applyDateFormat (so copied text and badge values are final,
  // FR-C8) and before the leak scan. Timeline runs before Connections so it reads recaps before
  // any recap is rewritten (though today neither transform actually rewrites a recap page).
  // writeSiteScript runs after both, once the true count of pages that linked the asset is known.
  const timeline = applyTimeline(stagingOut, { vaultPath, jsonConfig: userJsonConfig, vocab, wrapUpByHub });
  const connections = applyConnections(stagingOut, { vaultPath, jsonConfig: userJsonConfig, vocab, wrapUpByHub });
  const siteScript = writeSiteScript(stagingOut, { linkedPages: timeline.pagesPatched + connections.lanes + connections.hubOnly });

  const pageTurn = applyPageTurn(stagingOut);

  // FR34(b), ADR 0022 section 8: unconditional. Runs before, and entirely outside, the leak
  // scan's force handling below; no parameter or flag of runAtomicBuild can skip or override it.
  const gmLinkFindings = scanGmLinkMarker({ stagingOut, campaign });
  if (gmLinkFindings.length > 0) {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best-effort, as the scan-refusal path below */ }
    return { ok: false, refusedByScan: true, findings: gmLinkFindings, stagingRoot: null };
  }

  // ADR 0044: a %% comment's text in the staged tree refuses the build, unconditionally, like the GM
  // link marker above: `force` is never consulted.
  const commentFindings = scanCommentSurvivors({ vaultPath, jsonConfig: userJsonConfig, stagingOut, campaign });
  if (commentFindings.some((f) => f.severity === 'error')) {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best-effort, as above */ }
    return { ok: false, refusedByScan: true, findings: commentFindings, stagingRoot: null };
  }

  // Track D2: the output-leak scan, against the fully-staged tree, BEFORE
  // the swap. A hit without `force` refuses the build: no swap, finalOut
  // stays byte-unchanged, the staging tree is removed (exit 2's frozen
  // meaning, src/util/exitcodes.js:12-13, is "refused and wrote nothing" —
  // keeping a leaky staging tree around for inspection, the render-error
  // path's behaviour, would contradict that).
  const scanFindings = scanStagingOutput({ vaultPath, jsonConfig: userJsonConfig, stagingOut, campaign });
  const scanHasError = scanFindings.some((f) => f.severity === 'error');
  if (scanHasError && !force) {
    // Reporting the refusal and its findings must not depend on this cleanup
    // succeeding: on Windows, a file handle held anywhere inside the staging
    // tree (e.g. a preview browser tab) makes fs.rmSync throw EBUSY, which
    // used to propagate out of runAtomicBuild uncaught — crashing the whole
    // process (exit 1, "Scriptorium itself failed") before the caller ever
    // got the chance to print the refusal or the leak finding it exists to
    // report. A leftover staging tree here is survivable: it matches the
    // .scriptorium-build-* pattern sweepStaleSiblings() clears at the start
    // of the next build (line 52), so best-effort cleanup with a swallowed
    // failure is enough — the return below must still always happen.
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      // best-effort only; see comment above
    }
    return { ok: false, refusedByScan: true, findings: scanFindings, stagingRoot: null };
  }

  const pagesWritten = countFiles(stagingOut);
  const { staleOldDir } = swapIntoPlace(finalOut, stagingOut);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  return {
    ok: true,
    finalOut,
    pagesWritten,
    elapsedMs,
    staleOldDir,
    detail,
    generatorWarnings: generatorWarningLines(detail, { stagingRoot, stagingOut, finalOut }),
    notice,
    houseStyle,
    storyFocus,
    themeAssets,
    sessionPairs: { wrapUpByHub, unreadable, divergence: sessionPairDivergence },
    sessionBadges,
    dates,
    accordions,
    timeline,
    connections,
    siteScript,
    pageTurn,
    sessionsIndex,
    redactions,
    outputScan: { findings: scanFindings, overridden: scanHasError && force },
  };
}

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(require('path').join(dir, entry.name));
    else count++;
  }
  return count;
}

module.exports = { runAtomicBuild, generatorWarningLines };
