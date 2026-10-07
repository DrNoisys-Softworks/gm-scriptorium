'use strict';

const { createFinding } = require('../../report/finding');
const pinned = require('../../generator/pinned');
const htmltext = require('../../build/htmltext');
const { deriveRenderedText, readRenderedHeadings, displayTextOf, alignStrippedToSource } = require('./textmodel');
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

/**
 * Removes every `<...>` run (a `<`, one or more characters that are not `>`, then `>`), to a fixpoint so
 * a tag rebuilt by the first pass ("<<b>b>") is removed too. Scanned by hand, not by regex: this is
 * the exact behaviour of `replace(/<[^>]+>/g, '')` and gives a static analyser nothing to flag.
 */
function stripTags(input) {
  let s = String(input);
  for (let prev = null; prev !== s; ) {
    prev = s;
    let out = '';
    let i = 0;
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt === -1) {
        out += s.slice(i);
        break;
      }
      const gt = s.indexOf('>', lt + 1);
      if (gt === -1) {
        out += s.slice(i);
        break;
      }
      if (gt === lt + 1) {
        out += s.slice(i, lt + 1); // "<>" is not a tag; look again after the "<"
        i = lt + 1;
      } else {
        out += s.slice(i, lt);
        i = gt + 1;
      }
    }
    s = out;
  }
  return s;
}

function normalise(title) {
  return stripTags(title).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** ADR 0045: NFC, typographer-folded, then normalised. The one comparison form for entries and headings. */
function keyOf(s) {
  return normalise(pinned.canonicalNfc(htmltext.foldTypographer(String(s))));
}

/** Entry keys: the raw entry and its rendered display text. Empty keys are dropped (they would match every heading). */
function entryKeys(entry) {
  return [...new Set([keyOf(entry), keyOf(displayTextOf(entry))])].filter((k) => k !== '');
}

/**
 * Heading keys for one raw title: the raw key, the rendered display key, and the display key with
 * leading symbols (an emoji or a bullet) removed. Empty keys are dropped.
 */
function headingKeys(title) {
  const display = keyOf(displayTextOf(title));
  const leadStripped = display.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return [...new Set([keyOf(title), display, leadStripped])].filter((k) => k !== '');
}

/** The first exclusion (an { key } from the union) that one of the heading's titles equals or starts with. */
function matchHeading(heading, entries) {
  for (const title of heading.titles) {
    const keys = headingKeys(title);
    for (const entry of entries) {
      if (keys.some((k) => k === entry || k.startsWith(entry))) return { entry, title };
    }
  }
  return null;
}

/**
 * L5: a heading, as the pinned generator reads and renders it, equals or starts with an entry in
 * the union of both exclude_sections surfaces. filterSections (lib/processor.js:284, required via
 * src/generator/pinned.js) withholds a section only when the raw title equals an entry
 * (case-insensitive), so "## GM Notes (spoilers)" or "## **GM Notes**" is published and fails
 * silently; the "starts with" arm and the display-text keys are why this check exists at all.
 * ADR 0045: headings come from readRenderedHeadings (the parser's reading plus the margin
 * reading, so indented, setext, closed and nested forms count), are compared by key (NFC,
 * typographer-folded, rendered display text, and a leading-symbol-stripped form), and are read in
 * both the page body and the paired _Story.md. If the parser throws, the source reports one error
 * and the margin headings are still checked. Also flags a surviving <!-- gm-only --> (or
 * <!-- spoiler -->, or an unclosed HTML comment) marker: any warning deriveRenderedText's strip
 * chain produced, tagged by whether it came from the page body or its paired _Story.md. ADR 0044
 * adds a `type: document` handout's Keeper headings (Context, Clues..., Prop Notes, Delivery): a
 * heading still rendered is reported.
 */
function runGmHeadingSurvives(ctx) {
  const jsonSections = ctx.jsonConfig.excludeSections || [];
  const vaultSections = ctx.publishSet.publishConfig.exclude_sections || [];
  const entries = [...new Set([...jsonSections, ...vaultSections].flatMap(entryKeys))];

  const findings = [];

  for (const page of ctx.publishSet.publishedPages) {
    const rendered = deriveRenderedText(page, ctx.publishSet.publishConfig, { bodyWithheld: hubBodyWithheld(ctx, page) });

    const arms = [
      { source: 'body', text: rendered.bodyText, path: page.relPath },
      { source: 'story', text: rendered.storyText, path: page.storyRelPath || page.relPath },
    ];
    let bodyHeadings = [];

    for (const arm of arms) {
      if (!arm.text) continue;
      const { headings, parseError } = readRenderedHeadings(arm.text);
      if (arm.source === 'body') bodyHeadings = headings;

      if (parseError) {
        // Fail closed (ADR 0045): the parser could not read this text, so its headings cannot be
        // trusted. A fixed message only: the parser's error can quote the page.
        findings.push(
          createFinding({
            id: 'leak/l5-gm-heading-survives',
            severity: 'error',
            category: 'leak',
            campaign: ctx.campaign,
            path: arm.path,
            message: `${arm.path}: the ${arm.source} text could not be parsed for headings, so excluded sections cannot be confirmed withheld`,
            data: { source: arm.source, parseError: true },
          }),
        );
      }

      let alignment = null;
      for (const heading of headings) {
        const hit = matchHeading(heading, entries);
        if (!hit) continue;
        let line = heading.line;
        if (arm.source === 'story') {
          if (alignment === null) alignment = alignStrippedToSource(page.storyMarkdown, arm.text);
          const mapped = alignment[heading.line - 1];
          line = mapped == null ? null : (page.storyLineOffset || 0) + mapped;
        }
        const display = displayTextOf(hit.title);
        findings.push(
          createFinding({
            id: 'leak/l5-gm-heading-survives',
            severity: 'error',
            category: 'leak',
            campaign: ctx.campaign,
            path: arm.path,
            line,
            message: `${arm.path}: heading "${heading.titles[0]}" survives filterSections (matches excluded section "${hit.entry}" by equals-or-starts-with on the rendered heading, but filterSections only compares exact equality)`,
            data: { heading: heading.titles[0], display, matchedExclusion: hit.entry, source: arm.source },
          }),
        );
      }
    }

    if (isHandout(page)) {
      for (const heading of bodyHeadings) {
        const shown = heading.titles[0];
        const keeper = handoutKeeperMatch({ level: heading.level, title: shown });
        if (!keeper) continue;
        findings.push(
          createFinding({
            id: 'leak/l5-gm-heading-survives',
            severity: 'error',
            category: 'leak',
            campaign: ctx.campaign,
            path: page.relPath,
            line: heading.line,
            message: `${page.relPath}: handout Keeper heading "${shown}" survives into the rendered page (a type: document page's "${keeper}" section is Keeper-only; the pinned generator should have withheld it and did not)`,
            data: { heading: shown, matchedExclusion: keeper, handoutKeeper: true },
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
