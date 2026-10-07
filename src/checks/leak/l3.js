'use strict';

const { createFinding } = require('../../report/finding');
const { extractWikiLinks, stripBrackets } = require('../../vault/links');
const { deriveRenderedText, buildPublishedNameIndex } = require('./textmodel');
const pinned = require('../../generator/pinned');
const { hubBodyWithheld } = require('../sessionmodel');

/**
 * L3: a published page wiki-links (or relationship-targets) an entity that
 * is not published. Input is source markdown of published pages after
 * stripGmOnly/filterSections, so a link only under "## GM Notes" is
 * correctly not a finding, plus relationships[].target, which bypasses
 * section filtering entirely. resolveWikiLinks drops an unmapped target to
 * plain display text rather than a hyperlink, so this is real even though
 * grepping built output for `<a href>` will not find it.
 *
 * Decisions Addendum section 1 narrows severity from the Engineering
 * Brief's flat ERROR: WARN unless the target carries `withheld: true`, in
 * which case ERROR. Most unmet NPCs are not secrets; only a name the GM
 * deliberately withheld is a leak.
 */
function runUnpublishedLink(ctx) {
  const publishedByName = buildPublishedNameIndex(ctx.publishSet.publishedPages);
  const findings = [];
  const seen = new Set(); // avoid duplicate findings for the same (page, target) pair

  function checkTarget(page, targetRaw, line) {
    const target = targetRaw.trim();
    if (target === '') return;
    const key = target.toLowerCase();
    if (!ctx.index.resolves(target)) return; // does not exist at all: link/unresolved's business
    // publishedByName is keyed NFC-canonicalized (textmodel.js's
    // buildPublishedNameIndex); ctx.index's own keys are not (link-index
    // NFC is out of scope for Track DEP-b), so the two lookups use
    // different normal forms on purpose.
    if (publishedByName.has(pinned.canonicalNfc(target).toLowerCase())) return; // it is published: fine

    const claims = ctx.index.claims.get(key) || [];
    const markdownClaim = claims.find((c) => c.kind === 'title' || c.kind === 'alias');
    const sourceFile = markdownClaim && ctx.index.files.find((f) => f.relPath === markdownClaim.relPath);
    const withheld = Boolean(sourceFile && sourceFile.ok && sourceFile.data.withheld === true);

    const dedupeKey = `${page.relPath} ${key}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    findings.push(
      createFinding({
        id: 'leak/l3-unpublished-link',
        severity: withheld ? 'error' : 'warn',
        category: 'leak',
        campaign: ctx.campaign,
        path: page.relPath,
        line,
        message: `${page.relPath}: links "${target}", which is not published${
          withheld ? ' and is withheld: true (a leak, rendered as plain text where a link was intended)' : ''
        }`,
        data: { target, withheld },
      }),
    );
  }

  for (const page of ctx.publishSet.publishedPages) {
    const rendered = deriveRenderedText(page, ctx.publishSet.publishConfig, { bodyWithheld: hubBodyWithheld(ctx, page) });
    // Deliberately no { ignoreCode: true } (#77): resolveWikiLinks collapses
    // an unmapped target to plain display text identically whether it was
    // written in prose or inside a code span, so a withheld name "documented"
    // as a syntax example still leaks onto the rendered page. Excluding code
    // spans here would shrink leak coverage, which #77 explicitly forbids.
    for (const link of extractWikiLinks(rendered.strippedBody)) {
      checkTarget(page, link.target, link.line);
    }
    // rendered.publishedFrontmatter.relationships is the pin's own
    // publishedFrontmatter() output (lib/processor.js:1099-1132): gm_only edges
    // are already dropped, so a link only reachable through a gm_only edge
    // is correctly not checked here at all (l4's frontmatter arm is what
    // catches a withheld name leaking through one).
    const rels = Array.isArray(rendered.publishedFrontmatter.relationships)
      ? rendered.publishedFrontmatter.relationships
      : [];
    for (const r of rels) {
      if (!r.target) continue;
      checkTarget(page, stripBrackets(r.target), null);
    }
  }

  return findings;
}

module.exports = { runUnpublishedLink };
