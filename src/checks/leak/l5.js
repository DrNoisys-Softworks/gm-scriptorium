'use strict';

const { createFinding } = require('../../report/finding');
const { deriveRenderedText } = require('./textmodel');
const { hubBodyWithheld } = require('../sessionmodel');

// ADR 0044. A `type: document` (or `handout`) page's Keeper sections. Since publish 1.12.x the
// generator withholds these `##` sections itself, and this check reads the already-stripped
// headings, so on a working pin it reports nothing. It is a safety net: if the pin ever stops
// withholding them (or the strip chain is bypassed), the heading shows up here. Same shape as the
// generator's own rule: level 2 only (a `### Delivery` inside the handout text is the handout),
// whole heading, "Clues" as a prefix word. "Innkeeper Notes" or "Contextual Detail" never match.
const HANDOUT_KEEPER_RE = /^(context|clues\b.*|(physical )?prop notes|delivery( notes)?)$/i;

function handoutKeeperMatch(heading) {
  if (heading.level !== 2) return null;
  const t = normalise(heading.title).replace(/[*_:]/g, '').trim();
  return HANDOUT_KEEPER_RE.test(t) ? t : null;
}

function isHandout(page) {
  const t = page.frontmatter && page.frontmatter.type;
  const v = typeof t === 'string' ? t.trim().toLowerCase() : '';
  return v === 'document' || v === 'handout';
}

function normalise(title) {
  return title
    .replace(/<[^>]+>/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * L5: a heading equals or starts with an entry in the union of both
 * exclude_sections surfaces, after the built site would render it.
 * filterSections (lib/processor.js:284, required via src/generator/pinned.js)
 * only compares for exact case-insensitive equality, so "## GM Notes
 * (spoilers)" is not stripped and fails silently; the "starts with" arm is
 * why this check exists at all. Also flags a surviving <!-- gm-only -->
 * (or <!-- spoiler -->, or an unclosed HTML comment) marker — any warning
 * deriveRenderedText's strip chain produced, tagged by whether it came
 * from the page body or its paired _Story.md. ADR 0044 adds a `type: document` handout's Keeper
 * headings (Context, Clues..., Prop Notes, Delivery): a heading still rendered is reported.
 */
function runGmHeadingSurvives(ctx) {
  const jsonSections = ctx.jsonConfig.excludeSections || [];
  const vaultSections = ctx.publishSet.publishConfig.exclude_sections || [];
  const union = [...new Set([...jsonSections, ...vaultSections].map(normalise))];

  const findings = [];

  for (const page of ctx.publishSet.publishedPages) {
    const rendered = deriveRenderedText(page, ctx.publishSet.publishConfig, { bodyWithheld: hubBodyWithheld(ctx, page) });

    for (const heading of rendered.headings) {
      const normalised = normalise(heading.title);
      const match = union.find((s) => normalised === s || normalised.startsWith(s));
      if (!match) continue;
      findings.push(
        createFinding({
          id: 'leak/l5-gm-heading-survives',
          severity: 'error',
          category: 'leak',
          campaign: ctx.campaign,
          path: page.relPath,
          line: heading.line,
          message: `${page.relPath}: heading "${heading.title}" survives filterSections (matches excluded section "${match}" by equals-or-starts-with, but filterSections only compares exact equality)`,
          data: { heading: heading.title, matchedExclusion: match },
        }),
      );
    }

    if (isHandout(page)) {
      for (const heading of rendered.headings) {
        const keeper = handoutKeeperMatch(heading);
        if (!keeper) continue;
        findings.push(
          createFinding({
            id: 'leak/l5-gm-heading-survives',
            severity: 'error',
            category: 'leak',
            campaign: ctx.campaign,
            path: page.relPath,
            line: heading.line,
            message: `${page.relPath}: handout Keeper heading "${heading.title}" survives into the rendered page (a type: document page's "${keeper}" section is Keeper-only; the pinned generator should have withheld it and did not)`,
            data: { heading: heading.title, matchedExclusion: keeper, handoutKeeper: true },
          }),
        );
      }
    }

    for (const warning of rendered.warnings) {
      const location = warning.source === 'story' ? `${page.relPath} (story)` : page.relPath;
      findings.push(
        createFinding({
          id: 'leak/l5-gm-heading-survives',
          severity: 'error',
          category: 'leak',
          campaign: ctx.campaign,
          path: page.relPath,
          message: `${location}: ${warning.message}`,
        }),
      );
    }
  }

  return findings;
}

module.exports = { runGmHeadingSurvives };
