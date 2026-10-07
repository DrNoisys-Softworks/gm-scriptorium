'use strict';

const { createFinding } = require('../report/finding');
const { extractWikiLinks } = require('../vault/links');

/**
 * link/unresolved: every [[target]]/[[target|alias]]/[[target#heading]]
 * must resolve. Scans the RAW file (frontmatter included), not just the
 * post-frontmatter body: frontmatter fields routinely carry wiki-links too
 * (location, first_appearance, alliances, relationships[].target, ...),
 * and the 5109-link baseline (Requirements section 3.1 item 4 / criterion
 * 5) only reproduces when those are counted. Confirmed empirically: body
 * only gives 3147 links; raw gives exactly 5109.
 *
 * `ignoreCode: true` (#77): a [[wikilink]] written inside an inline code
 * span or a fenced code block (e.g. documenting the pin syntax) is never a
 * link candidate in the reader's eyes — see src/vault/links.js's module doc
 * block for why this is a false positive here but must NOT be applied to
 * leak/l3's own extractWikiLinks() call.
 */
function runUnresolved(ctx) {
  const findings = [];
  for (const f of ctx.index.files) {
    if (!f.ok) continue;
    const links = extractWikiLinks(f.raw, { ignoreCode: true });
    for (const link of links) {
      if (ctx.index.resolves(link.target)) continue;
      findings.push(
        createFinding({
          id: 'link/unresolved',
          severity: 'error',
          category: 'link',
          campaign: ctx.campaign,
          path: f.relPath,
          line: link.line,
          message: `${f.relPath}:${link.line}: [[${link.target}]] does not resolve`,
          detail: link.raw,
        }),
      );
    }
  }
  return findings;
}

/**
 * link/in-code (#77 follow-up, Orchestrator decision, narrowed a second
 * time): a [[wikilink]] found ONLY inside an inline code span or fenced
 * code block, AND whose target does not resolve. link/unresolved (above)
 * stopped treating these as ERRORs; the first cut of this check reported
 * EVERY in-code wikilink at INFO regardless of resolution, which on the
 * real campaign vault was 42 findings for 2 genuine signals — Leaflet
 * fences legitimately carry `marker:`/`image:` wikilinks the Obsidian
 * plugin reads, and a GM changelog note quoting an old value in backticks
 * is normal prose, not something to flag every single check run. Resolving
 * in-code links now stay silent; only a broken one (the case that matters —
 * e.g. a Leaflet marker pointing at a renamed note) still surfaces, at
 * INFO, which never affects check's exit code (INFO never sets
 * envelope.counts.error; src/cli/check.js).
 */
function runInCode(ctx) {
  const findings = [];
  for (const f of ctx.index.files) {
    if (!f.ok) continue;
    const links = extractWikiLinks(f.raw, { onlyCode: true });
    for (const link of links) {
      if (ctx.index.resolves(link.target)) continue; // resolving in-code links stay silent
      findings.push(
        createFinding({
          id: 'link/in-code',
          severity: 'info',
          category: 'link',
          campaign: ctx.campaign,
          path: f.relPath,
          line: link.line,
          message: `${f.relPath}:${link.line}: [[${link.target}]] does not resolve, and inside code it would not render as a link either way`,
          detail: link.raw,
        }),
      );
    }
  }
  return findings;
}

/** link/ambiguous-target: two files resolving the same [[name]]. One ERROR per ambiguous name. */
function runAmbiguousTarget(ctx) {
  return ctx.index.ambiguousNames.map((entry) =>
    createFinding({
      id: 'link/ambiguous-target',
      severity: 'error',
      category: 'link',
      campaign: ctx.campaign,
      message: `"${entry.name}" resolves to ${new Set(entry.sources.map((s) => s.relPath)).size} different files: ${[
        ...new Set(entry.sources.map((s) => s.relPath)),
      ].join(', ')}`,
      data: { name: entry.name, sources: entry.sources },
    }),
  );
}

module.exports = { runUnresolved, runInCode, runAmbiguousTarget };
