'use strict';

/*
 * Wiki-link extraction, mirroring the syntax gm-apprentice-publish's
 * resolveWikiLinks() (lib/processor.js) understands: [[target]],
 * [[target|alias]], [[target#heading]], [[target#heading|alias]], and the
 * embed form ![[target]] / ![[target|alt]].
 *
 * `opts.ignoreCode` (#77): resolveWikiLinks() itself does NOT special-case
 * backticks — confirmed empirically against the pin (lib/processor.js +
 * lib/markdown.js): a [[wikilink]] inside an inline code span or a fenced
 * code block gets the exact same regex substitution as one in prose, and
 * with no `linkMap` entry it collapses to plain display text either way.
 * What differs is what a READER sees: outside code, an unresolved link
 * silently degrades to inert text; inside code, it was never a link
 * candidate in the reader's eyes to begin with — it is `<code>`, i.e.
 * documented syntax (`` `[[Note]]` `` as a worked example). Flagging that
 * as an ERROR the GM must fix is a false positive. `ignoreCode: true` masks
 * inline code spans and fenced code blocks out of the scan text before
 * matching, so occurrences inside them are never extracted at all — not
 * treated as resolved, not treated as unresolved, simply not a link.
 *
 * Callers that care whether a name merely APPEARS as literal text on a
 * published page (leak/l3-unpublished-link) must NOT pass this: the leak is
 * the name showing up in the rendered page at all, and resolveWikiLinks
 * collapses an unmapped code-span target to plain text exactly the same as
 * everywhere else, so the leak is identical regardless of backtick context.
 * l3 deliberately calls extractWikiLinks() with no options.
 *
 * `opts.onlyCode` (#77 follow-up, link/in-code): the exact complement of
 * ignoreCode — extracts EVERY in-code wikilink, resolving or not. The
 * resolution filter (only a non-resolving in-code link is worth an INFO;
 * Leaflet marker/image syntax and a GM changelog quoting an old value both
 * resolve and are normal, expected content) lives in the check
 * (src/checks/link.js's runInCode), not here: this primitive answers "is
 * this wikilink in code", nothing about whether it is a problem.
 */

const { rewriteTableRowSegment, isTableRow } = require('../util/tablepipes');

const WIKI_LINK_RE = /(!?)\[\[([^\]]+)\]\]/g;

// CommonMark-shaped fence rule: 0-3 leading spaces, then a run of 3+ of the
// same fence character (backtick or tilde; the two never mix in one fence).
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function parseInner(inner) {
  let rest = inner;
  let alias = null;
  const pipeIdx = rest.indexOf('|');
  if (pipeIdx !== -1) {
    alias = rest.slice(pipeIdx + 1).trim();
    rest = rest.slice(0, pipeIdx);
  }
  let heading = null;
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    heading = rest.slice(hashIdx + 1).trim();
    rest = rest.slice(0, hashIdx);
  }
  return { target: rest.trim(), alias, heading };
}

/**
 * Which lines are entirely inside (or are) a fenced code block, matching on
 * the opening fence's character and run length per CommonMark: the closing
 * fence must reuse the same character, at a run length >= the opener's, and
 * carry nothing else but leading/trailing whitespace. An opened-but-never-closed
 * fence runs to end of file — everything after it is code, same as a real
 * unterminated fence renders (the alternative, treating it as prose, would
 * un-mask a fence's contents on a truncated file, which is the wrong way to
 * fail here: it's a display omission, not a safety check, but consistency
 * with "ambiguous stays covered" below is worth more than the edge case).
 *
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function computeFenceLineMask(lines) {
  const inFence = new Array(lines.length).fill(false);
  let fenceChar = null;
  let fenceLen = 0;
  let open = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m) {
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        open = true;
        inFence[i] = true;
      }
      continue;
    }
    inFence[i] = true;
    const closeRe = fenceChar === '`' ? /^ {0,3}(`{3,})\s*$/ : /^ {0,3}(~{3,})\s*$/;
    const closeMatch = closeRe.exec(line);
    if (closeMatch && closeMatch[1].length >= fenceLen) {
      open = false;
      fenceChar = null;
      fenceLen = 0;
    }
  }
  return inFence;
}

/**
 * Finds inline code spans on a single line: backtick runs of equal opening
 * /closing length, per CommonMark backtick-string matching — a differing
 * -length inner run of backticks is literal content, not a close. A
 * backtick run with no matching close on the SAME line is NOT a span: fail
 * closed, per #77's acceptance criterion — an unterminated backtick must
 * not swallow a real link later in the line into "code".
 *
 * Residual gap, written down rather than left for someone to rediscover: a
 * genuine CommonMark inline code span CAN span multiple lines inside one
 * paragraph. This only ever looks within a single line. A wikilink written
 * as syntax documentation split across a code span that wraps a line break
 * will still be flagged as prose (#77) / not flagged as in-code (#77
 * follow-up, link/in-code). Narrower miss than the bug this closes, and no
 * vault under test exercises it.
 *
 * @param {string} line
 * @returns {[number, number][]} half-open [start, end) ranges, left to right, non-overlapping
 */
function findInlineCodeSpans(line) {
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === '`') j++;
    const openLen = j - i;

    let k = j;
    let closeStart = -1;
    while (k < line.length) {
      if (line[k] !== '`') {
        k++;
        continue;
      }
      let k2 = k;
      while (k2 < line.length && line[k2] === '`') k2++;
      if (k2 - k === openLen) {
        closeStart = k;
        break;
      }
      k = k2;
    }

    if (closeStart === -1) {
      // Unterminated on this line: fail closed, not a span, keep scanning
      // normally right after the opening run.
      i = j;
      continue;
    }

    const spanEnd = closeStart + openLen;
    spans.push([i, spanEnd]);
    i = spanEnd;
  }
  return spans;
}

/** Blanks the given [start,end) ranges out of `line` with spaces (length-preserving), keeping everything else. */
function blankRanges(line, ranges) {
  let result = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    result += line.slice(cursor, start);
    result += ' '.repeat(end - start);
    cursor = end;
  }
  result += line.slice(cursor);
  return result;
}

/** Inverse of blankRanges: keeps only the given [start,end) ranges, blanking everything else (length-preserving). */
function keepOnlyRanges(line, ranges) {
  let result = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    result += ' '.repeat(start - cursor);
    result += line.slice(start, end);
    cursor = end;
  }
  result += ' '.repeat(line.length - cursor);
  return result;
}

/** Blanks a line's inline code spans, keeping prose. */
function maskInlineCode(line) {
  return blankRanges(line, findInlineCodeSpans(line));
}

/** Inverse of maskInlineCode: keeps only a line's inline code spans, blanking prose. */
function maskInlineProse(line) {
  return keepOnlyRanges(line, findInlineCodeSpans(line));
}

/** Full-markdown mask: fenced-block lines become blank, then each remaining line has its inline code spans blanked. Length- and line-count-preserving, so line numbers off the masked text still match the original. */
function maskCodeForLinks(markdown) {
  const lines = markdown.split('\n');
  const inFence = computeFenceLineMask(lines);
  return lines.map((line, i) => (inFence[i] ? ' '.repeat(line.length) : maskInlineCode(line))).join('\n');
}

/**
 * Complement of maskCodeForLinks (#77 follow-up, link/in-code): keeps ONLY
 * fenced-block lines and inline-code-span content, blanking every other
 * character. Feeding this to extractWikiLinks() surfaces exactly the
 * wikilink occurrences that live inside code — the ones ignoreCode makes
 * invisible to link/unresolved — so they can be reported instead of going
 * silent.
 */
function maskProseForLinks(markdown) {
  const lines = markdown.split('\n');
  const inFence = computeFenceLineMask(lines);
  return lines.map((line, i) => (inFence[i] ? line : maskInlineProse(line))).join('\n');
}

/**
 * Issue #48 (ADR 0043). In table rows that are not inside a fenced block, rewrites `[[T\\|L]]` to
 * `[[T|L]]`, leaving inline code spans untouched. Shared by check and the build's read shim so the
 * two agree. Line- and length-wise safe: only a backslash is removed, no line is added or dropped.
 *
 * @param {string} markdown
 * @returns {string}
 */
function rewriteEscapedPipeLinksOutsideCode(markdown) {
  if (typeof markdown !== 'string' || !markdown.includes('\\|')) return markdown;
  const lines = markdown.split('\n');
  const inFence = computeFenceLineMask(lines);
  return lines
    .map((line, i) => {
      if (inFence[i] || !isTableRow(line)) return line;
      let out = '';
      let cursor = 0;
      for (const [start, end] of findInlineCodeSpans(line)) {
        out += rewriteTableRowSegment(line.slice(cursor, start)) + line.slice(start, end);
        cursor = end;
      }
      return out + rewriteTableRowSegment(line.slice(cursor));
    })
    .join('\n');
}

/**
 * @param {string} markdown
 * @param {{ ignoreCode?: boolean, onlyCode?: boolean }} [opts]
 *   ignoreCode (#77): skip wikilinks inside inline code spans / fenced code
 *   blocks. See the module doc block above for why leak/l3 must never pass
 *   this. onlyCode (#77 follow-up, link/in-code): the complement — extract
 *   ONLY the wikilinks that live inside code, so they can be reported
 *   instead of going silent. Mutually exclusive with ignoreCode; onlyCode
 *   wins if both are somehow set (defensive, not a documented combination).
 * @returns {{ raw: string, target: string, alias: string|null, heading: string|null, isEmbed: boolean, line: number }[]}
 *          1-based line numbers.
 */
function extractWikiLinks(markdown, opts = {}) {
  // #48: a table-row `[[T\|L]]` outside code means alias L, exactly as the build reads it.
  let scanText = rewriteEscapedPipeLinksOutsideCode(markdown);
  if (opts.onlyCode) scanText = maskProseForLinks(scanText);
  else if (opts.ignoreCode) scanText = maskCodeForLinks(scanText);
  const lines = scanText.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    WIKI_LINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKI_LINK_RE.exec(line))) {
      const isEmbed = m[1] === '!';
      const { target, alias, heading } = parseInner(m[2]);
      results.push({ raw: m[0], target, alias, heading, isEmbed, line: i + 1 });
    }
  }
  return results;
}

/** Strip [[ ]] wrapper from a raw frontmatter relationship-target string, e.g. relationships[].target. */
function stripBrackets(value) {
  return String(value == null ? '' : value).replace(/\[\[|\]\]/g, '').trim();
}

module.exports = { extractWikiLinks, stripBrackets, rewriteEscapedPipeLinksOutsideCode, findInlineCodeSpans, FENCE_OPEN_RE };
