'use strict';

const fs = require('fs');
const path = require('path');
const pinned = require('../generator/pinned');
const { computePublishedSet } = require('../vault/publishset');

/*
 * Engineering Brief: "Book leaves + motion" (docs/agent-runs/bookleaves-engineering-brief-2026-09-24.md),
 * FR-07 / Structural decision 6.
 *
 * base.js:151 emits metadata badges positionally: `<span class="metadata-badge">value</span>`,
 * with no field name anywhere in the markup, in the fixed order
 * ['session_number','play_date','status','stage'] (base.js:151), skipping empty fields. CSS alone
 * cannot key on "the status badge" or "the session number badge" once a field is missing (a
 * `:first-child`/`:last-child` selector is simply wrong whenever the fields present differ from
 * the full four). This transform re-derives the exact badge block the pin would have emitted (via
 * the pinned facade's own metadataBadgesFor, never re-implemented) and, only when it finds that
 * exact string in the built page, rewrites it with a data-field attribute per span.
 */

const SESSION_BADGE_FIELDS = ['session_number', 'play_date', 'status', 'stage'];
// base.js:157 -- the one fallback relevant to the session badge fields.
const BADGE_FIELD_FALLBACKS = { play_date: 'actual_date' };

const BADGE_MARKER = 'data-scriptorium-badges';

/**
 * Mirrors base.js:165-172 exactly: a field is present if its raw value (or, when the raw value is
 * empty, its fallback's raw value) is non-null/undefined/'' and, after stripping wiki-link
 * brackets and trimming, non-empty.
 *
 * @param {object} publishedFm
 * @returns {string[]} the SESSION_BADGE_FIELDS present, in order
 */
function presentFields(publishedFm) {
  const out = [];
  for (const field of SESSION_BADGE_FIELDS) {
    let raw = publishedFm[field];
    if ((raw === undefined || raw === null || raw === '') && BADGE_FIELD_FALLBACKS[field]) {
      raw = publishedFm[BADGE_FIELD_FALLBACKS[field]];
    }
    if (raw === undefined || raw === null || raw === '') continue;
    const value = String(raw).replace(/\[\[|\]\]/g, '').trim();
    if (!value) continue;
    out.push(field);
  }
  return out;
}

/**
 * Computes the patched HTML for one session page, or null if it should be left untouched.
 *
 * @param {string} html
 * @param {object} publishedFm the page's published frontmatter (post exclude_fields/overrides)
 * @returns {string | null}
 */
function annotateSessionBadges(html, publishedFm) {
  if (html.includes(BADGE_MARKER)) return null; // idempotent, checked first

  const expected = pinned.metadataBadgesFor(publishedFm);
  if (!expected) return null;

  const occurrences = html.split(expected).length - 1;
  if (occurrences !== 1) return null;

  const fields = presentFields(publishedFm);
  const spanCount = (expected.match(/<span class="metadata-badge">/g) || []).length;
  if (spanCount !== fields.length) return null;

  let i = 0;
  let patchedBlock = expected.replace('<div class="metadata-badges">', `<div class="metadata-badges" ${BADGE_MARKER}>`);
  patchedBlock = patchedBlock.replace(/<span class="metadata-badge">/g, () => {
    const field = fields[i];
    i++;
    return `<span class="metadata-badge" data-field="${field}">`;
  });

  return html.replace(expected, patchedBlock);
}

/**
 * Walks the published set for `type === 'session'` pages, derives each one's published
 * frontmatter the same way the leak checks do (src/checks/leak/textmodel.js:208-210), and
 * annotates the matching block in the built page under siteRoot. A page whose block does not
 * match byte-for-byte (frontmatter drift) is left untouched and reported in `unmatched`.
 *
 * @param {string} siteRoot the staging output directory
 * @param {{ vaultPath: string, jsonConfig: object }} opts
 * @returns {{ pagesAnnotated: number, unmatched: string[] }}
 */
function applySessionBadgeFields(siteRoot, { vaultPath, jsonConfig }) {
  const { publishedPages, publishConfig } = computePublishedSet(vaultPath, jsonConfig);

  let pagesAnnotated = 0;
  const unmatched = [];

  for (const page of publishedPages) {
    if (page.frontmatter.type !== 'session') continue;

    const overridesForFile = (publishConfig.overrides && publishConfig.overrides.fields && publishConfig.overrides.fields[page.rel]) || {};
    const publishedFm = pinned.publishedFrontmatter(page.frontmatter, publishConfig.exclude_fields, overridesForFile);

    const fullPath = path.join(siteRoot, page.outputPath);
    if (!fs.existsSync(fullPath)) {
      unmatched.push(page.outputPath);
      continue;
    }

    const html = fs.readFileSync(fullPath, 'utf8');
    const patched = annotateSessionBadges(html, publishedFm);
    if (patched === null) {
      if (!html.includes(BADGE_MARKER)) unmatched.push(page.outputPath);
      continue;
    }

    fs.writeFileSync(fullPath, patched);
    pagesAnnotated++;
  }

  return { pagesAnnotated, unmatched };
}

module.exports = {
  SESSION_BADGE_FIELDS,
  BADGE_FIELD_FALLBACKS,
  BADGE_MARKER,
  presentFields,
  annotateSessionBadges,
  applySessionBadgeFields,
};
