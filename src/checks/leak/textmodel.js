'use strict';

const { stripBrackets } = require('../../vault/links');
const pinned = require('../../generator/pinned');
const { stripObsidianComments } = require('../../vault/comments');
const htmltext = require('../../build/htmltext');

/*
 * Section 7.0's "rendered text" derivation, re-ported against the pin
 * (docs/decisions/0005-generator-pin.md, Track DEP-b). Every strip step
 * below is the pin's OWN function, required unmodified through
 * src/generator/pinned.js and called directly — this file only
 * orchestrates them in the sequence build.js does, from SOURCE markdown
 * (before any page has necessarily been built), which is why it exists
 * separately from the pin's own processContent (that one needs a built
 * link/image map; deriveRenderedText only needs to know what text a
 * published page's rendered body/frontmatter would contain).
 *
 * Structural decision 2 (Track DEP-b): playerSafeMarkdown is NOT used here.
 * The body renders through processContent's own order (lib/build.js:836,
 * lib/processor.js:969-1023), which strips the leading H1 before callouts and
 * sections; that is the rendered superset for PC pages too (fail-closed),
 * so this is the one chain for every page, not a PC-only alternate path.
 */

/** Strip functions return `string` or `{text, warnings}` (lib/processor.js:596, 693) — normalise to the latter. */
function applyStrip(fn, text) {
  const result = fn(text);
  if (typeof result === 'string') return { text: result, warnings: [] };
  return { text: result.text, warnings: Array.isArray(result.warnings) ? result.warnings : [] };
}

/**
 * ADR 0044 first removes Obsidian %% comments (done by the build's read shim, before processContent).
 * processContent's strip order (lib/processor.js:969-1021), minus the parts that
 * need a link/image map (resolveImageEmbeds, resolveWikiLinks, md.render):
 * stripDataview > stripGmOnly > stripSpoiler > stripHtmlComments >
 * stripLeadingH1 > stripCallouts > filterSections. CRLF is normalised
 * first, matching processContent's own `page.markdown.replace(/\r/g, '')`.
 *
 * @param {string} markdown
 * @param {object} publishConfig
 * @param {'body'|'story'} source
 * @param {{source:string, message:string}[]} warningsOut
 * @param {object} [frontmatter] the page's own frontmatter, for body text only. filterSections
 *   reads its `type`: on a document page the pin withholds the handout's Keeper sections whatever
 *   exclude_sections says (lib/processor.js:106-149), and a real build passes the page's frontmatter
 *   for the body (lib/build.js:583, lib/processor.js:1014). Story text is different: the build
 *   renders it from a page object whose frontmatter is `{}` (lib/build.js:857-861, :1246), so the
 *   rule never applies to it, and the story chain is called without this argument to match.
 */
function renderChain(markdown, publishConfig, source, warningsOut, frontmatter) {
  let text = String(markdown == null ? '' : markdown).replace(/\r/g, '');
  // ADR 0044: the build removes Obsidian %% comments before the generator reads a note, so this
  // source-side view does the same first; text inside a comment is never rendered.
  text = stripObsidianComments(text);
  text = pinned.stripDataview(text);

  let r = applyStrip(pinned.stripGmOnly, text);
  text = r.text;
  for (const message of r.warnings) warningsOut.push({ source, message });

  r = applyStrip(pinned.stripSpoiler, text);
  text = r.text;
  for (const message of r.warnings) warningsOut.push({ source, message });

  r = applyStrip(pinned.stripHtmlComments, text);
  text = r.text;
  for (const message of r.warnings) warningsOut.push({ source, message });

  text = pinned.stripLeadingH1(text);
  text = pinned.stripCallouts(text, publishConfig.exclude_callouts);
  text = pinned.filterSections(text, publishConfig.exclude_sections, frontmatter);
  return text;
}

/** Every heading in markdown, normalised (trimmed, casefolded), as they'd render (tags/markdown syntax aside). */
function extractHeadings(markdown) {
  const headings = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), line: i + 1 });
  }
  return headings;
}

/**
 * ADR 0045. Every heading in `text` as the pinned generator reads it, one entry per line.
 * Two readings are merged: the parser's (pinned.findHeadings, lib/processor.js:180-209: ATX at any
 * indent the parser accepts, closed ATX, setext, headings nested in a blockquote or list) and the
 * margin pattern extractHeadings uses, which the generator also treats as a section start, even
 * inside code. `titles` holds each distinct raw title, parser title first. Unlike
 * extractHeadings this is not normalised, and it does not change that function.
 *
 * `parseError` is true when the parser threw; the margin headings are still returned, and the
 * caller must fail closed. The error text is never kept (it can quote the input).
 *
 * @param {string} text
 * @returns {{ headings: {line:number, level:number, titles:string[], nested:boolean}[], parseError: boolean }}
 */
function readRenderedHeadings(text) {
  const source = String(text == null ? '' : text);
  const byLine = new Map(); // 1-based line > entry
  let parseError = false;

  try {
    const { headingAt } = pinned.findHeadings(source);
    for (const [zeroBased, h] of headingAt) {
      const title = String(h.title || '').trim();
      byLine.set(zeroBased + 1, { line: zeroBased + 1, level: h.level, titles: title ? [title] : [], nested: Boolean(h.nested) });
    }
  } catch {
    parseError = true;
  }

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    const title = m[2].trim();
    const existing = byLine.get(i + 1);
    if (existing) {
      if (title && !existing.titles.includes(title)) existing.titles.push(title);
    } else {
      byLine.set(i + 1, { line: i + 1, level: m[1].length, titles: title ? [title] : [], nested: false });
    }
  }

  const headings = [...byLine.values()].filter((h) => h.titles.length > 0).sort((a, b) => a.line - b.line);
  return { headings, parseError };
}

/**
 * ADR 0045. The text a reader sees for an inline-markdown string, the way the build renders it:
 * `[[x|Alias]]` becomes `Alias`, emphasis and link markup drop, the typographer applies and entities
 * decode. The link map is null-prototype on purpose: a plain object would resolve `[[constructor]]`
 * to a prototype function.
 *
 * @param {string} inlineMarkdown
 * @returns {string}
 */
function displayTextOf(inlineMarkdown) {
  const linked = pinned.resolveWikiLinks(String(inlineMarkdown), Object.create(null), '');
  return htmltext.textOf(pinned.renderInline(linked));
}

/**
 * Track D3, Structural decision 5: aligns each line of `strippedText` (some
 * pin strip step's output, e.g. `deriveRenderedText`'s `bodyText`) back to
 * its 1-based line number in `sourceMarkdown` (the RAW, un-stripped body —
 * Structural decision 7 — never the stub-reduced text). A monotone
 * two-pointer walk, not sentinel instrumentation: injecting a per-line
 * marker into the text before stripping would itself change what
 * `filterSections` matches as a heading title (lib/processor.js:180-240),
 * the callout pattern (`:623`), and fence info strings (`:515-530`) —
 * changing what gets stripped, unacceptable in a leak check.
 *
 * Sound because every step in the strip chain either deletes whole lines,
 * collapses a block to one blank line (`lib/processor.js:579`), or
 * shortens a line in place by removing an inline comment (`:646-696`) —
 * none of them introduce new text, so a surviving stripped line's trimmed
 * text is always exactly, or a substring of, some source line's trimmed
 * text, in the same relative order.
 *
 * A blank stripped line never advances the cursor (usually the remnant of
 * a whole removed block, not a real source line) and maps to `null`. A
 * non-blank stripped line advances the cursor to the first source line at
 * or after it whose trimmed text equals or contains the stripped line's
 * trimmed text; on a match the cursor moves past it. A search that
 * reaches the end of source with no match maps to `null` AND restores the
 * cursor, so one anomaly cannot desynchronise every line after it
 * (Structural decision 6: a mapping failure never suppresses a finding —
 * callers must emit `line: null`, not drop the finding).
 *
 * @param {string} sourceMarkdown raw, un-stripped source body
 * @param {string} strippedText output of the strip chain
 * @returns {(number|null)[]} one entry per line of strippedText
 */
function alignStrippedToSource(sourceMarkdown, strippedText) {
  const sourceLines = String(sourceMarkdown == null ? '' : sourceMarkdown)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const strippedLines = String(strippedText == null ? '' : strippedText)
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const result = [];
  let cursor = 0;

  for (const line of strippedLines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      result.push(null);
      continue;
    }

    let matchIndex = -1;
    for (let i = cursor; i < sourceLines.length; i++) {
      const srcTrimmed = sourceLines[i].trim();
      if (srcTrimmed === trimmed || srcTrimmed.includes(trimmed)) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      result.push(null); // cursor deliberately left untouched — Structural decision 5
      continue;
    }

    result.push(matchIndex + 1);
    cursor = matchIndex + 1;
  }

  return result;
}

/** publishedFrontmatter's fields as flat text: every value, plus every VISIBLE relationship edge's target/description (gm_only edges are already dropped by publishedFrontmatter itself). */
function frontmatterTextFrom(publishedFm) {
  const parts = [];
  for (const [key, value] of Object.entries(publishedFm)) {
    if (value == null) continue;
    if (key === 'relationships') {
      if (!Array.isArray(value)) continue;
      for (const r of value) {
        if (r.target) parts.push(stripBrackets(r.target));
        if (r.description) parts.push(String(r.description));
      }
      continue;
    }
    parts.push(Array.isArray(value) ? value.join(' ') : String(value));
  }
  return parts.join('\n');
}

/**
 * One published page's rendered-text view.
 *
 * Order: publish:stub's keepOnlySections reduction (lib/build.js:515-529)
 * first, against the RAW page.markdown/storyMarkdown (page objects stay
 * raw — Structural decision 3), then the strip chain (renderChain) on each
 * of body and story, exactly mirroring build.js's own order of operations.
 * publishedFrontmatter (lib/processor.js:1099-1132) computes the frontmatter
 * view directly, dropping gm_only relationship edges, applying
 * exclude_fields with any per-file override, and stripping control fields —
 * so frontmatterText's relationships are already the visible-only set,
 * never the raw ones.
 *
 * Track D3: `bodyText`/`storyText` are what L4's body/story arms now
 * search (never `page.markdown`/`page.storyMarkdown` directly). A caller
 * that needs a real source line number pairs `bodyText`/`storyText` with
 * `alignStrippedToSource(page.markdown, bodyText)` /
 * `alignStrippedToSource(page.storyMarkdown, storyText)` itself — this
 * function does not align, it only derives what would render.
 *
 * ADR 0036: `bodyWithheld` (default false, byte-identical to before) mirrors what a real build
 * does for a published hub paired with a Wrap-Up (lib/build.js:514, and then the stub reduction
 * at :465): the body source is blanked BEFORE the stub step, never after, so a withheld hub that
 * also happens to be `publish: stub` still ends up with an empty body rather than a stub-reduced
 * one. Story and frontmatter are unaffected, and `page` itself is never mutated.
 *
 * @param {object} page
 * @param {object} publishConfig
 * @param {{ bodyWithheld?: boolean }} [opts]
 * @returns {{ bodyText: string, storyText: string, strippedBody: string,
 *   headings: object[], publishedFrontmatter: object, frontmatterText: string,
 *   warnings: {source:'body'|'story', message:string}[], fullText: string }}
 */
function deriveRenderedText(page, publishConfig, { bodyWithheld = false } = {}) {
  const warnings = [];
  let bodySource = page.markdown || '';
  let storySource = page.storyMarkdown || '';

  if (bodyWithheld) bodySource = '';

  if (pinned.publishMode(page.frontmatter) === 'stub') {
    const include = Array.isArray(page.frontmatter.publish_include_sections)
      ? page.frontmatter.publish_include_sections
      : [];
    bodySource = pinned.keepOnlySections(bodySource, include, publishConfig.exclude_sections);
    if (storySource) storySource = pinned.keepOnlySections(storySource, include, publishConfig.exclude_sections);
  }

  const bodyText = renderChain(bodySource, publishConfig, 'body', warnings, page.frontmatter);
  const storyText = storySource ? renderChain(storySource, publishConfig, 'story', warnings) : '';
  const headings = extractHeadings(bodyText);

  const overridesForFile =
    (publishConfig.overrides && publishConfig.overrides.fields && publishConfig.overrides.fields[page.rel]) || {};
  const publishedFm = pinned.publishedFrontmatter(page.frontmatter, publishConfig.exclude_fields, overridesForFile);
  const frontmatterText = frontmatterTextFrom(publishedFm);

  return {
    bodyText,
    storyText,
    strippedBody: [bodyText, storyText].filter(Boolean).join('\n'),
    headings,
    publishedFrontmatter: publishedFm,
    frontmatterText,
    warnings,
    fullText: [bodyText, storyText, frontmatterText].filter(Boolean).join('\n'),
  };
}

/**
 * Case-insensitive lookup of "is this name actually published, and how",
 * keyed by NFC-canonicalized-then-lowercased title and every alias, for
 * the leak checks. Callers must canonicalize their own query the same way
 * (`pinned.canonicalNfc(x).toLowerCase()`) before looking up here — this
 * index does NOT share normal form with src/vault/index.js's link-index
 * (out of scope for Track DEP-b; it fails closed via link/unresolved).
 *
 * Track D1: each value is `{ page, via, matchedOn }` — `page` (the whole
 * published page object, as before), `via` ("title" or "alias", which
 * kind of claim matched), and `matchedOn` (the exact title/alias string
 * that matched, in its own casing, for a collision message to quote).
 * Additive: l3.js and l4.js's existing call sites only ever call `.has()`
 * on this map, never read a value, so this shape change cannot affect
 * them.
 */
function buildPublishedNameIndex(publishedPages) {
  const byName = new Map();
  for (const page of publishedPages) {
    byName.set(pinned.canonicalNfc(page.title).toLowerCase(), { page, via: 'title', matchedOn: page.title });
    const aliases = Array.isArray(page.frontmatter.aliases) ? page.frontmatter.aliases : [];
    for (const alias of aliases) {
      const key = pinned.canonicalNfc(String(alias)).toLowerCase();
      if (!byName.has(key)) byName.set(key, { page, via: 'alias', matchedOn: String(alias) });
    }
  }
  return byName;
}

module.exports = {
  extractHeadings,
  readRenderedHeadings,
  displayTextOf,
  alignStrippedToSource,
  deriveRenderedText,
  buildPublishedNameIndex,
};
