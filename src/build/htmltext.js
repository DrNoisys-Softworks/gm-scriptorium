'use strict';

const path = require('path');
const pinned = require('../generator/pinned');

/*
 * Engineering Brief: "Story timeline + Connections lane" (docs/agent-runs/
 * timeline-connections-engineering-brief-2026-09-24.md), "Interfaces and contracts: htmltext.js".
 *
 * Pure string helpers shared by recaps.js, timeline.js and connections.js. Nothing here touches
 * the filesystem. This module deliberately duplicates a few small pieces of logic that already
 * exist elsewhere in the codebase (foldTypographer mirrors src/checks/leak/outputscan.js:83-90) so
 * that this build-transform layer never has to reach into the leak-scan module for a helper.
 */

// -- decodeEntities ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  larr: '←',
  rarr: '→',
  lsaquo: '‹',
  rsaquo: '›',
};

const ENTITY_RE = new RegExp(`&(${Object.keys(NAMED_ENTITIES).join('|')}|#\\d+|#x[0-9a-fA-F]+);`, 'g');

/**
 * A single pass over `amp lt gt quot apos nbsp mdash ndash lsquo rsquo ldquo rdquo hellip larr
 * rarr lsaquo rsaquo` plus numeric/hex character references.
 *
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return String(s).replace(ENTITY_RE, (whole, body) => {
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

/**
 * Replace tags with '', decode entities, collapse whitespace runs to a single space, trim.
 *
 * @param {string} html
 * @returns {string}
 */
function textOf(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escapes `& < > "` only (matches the pin's own escapeHtml, lib/processor.js).
 *
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Mirrors src/checks/leak/outputscan.js:83-90 exactly.
 *
 * @param {string} text
 * @returns {string}
 */
function foldTypographer(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '--')
    .replace(/—/g, '---')
    .replace(/…/g, '...');
}

/**
 * pinned.canonicalNfc(foldTypographer(textOf(s))).toLowerCase(), whitespace collapsed, then
 * trailing punctuation stripped. Used to match a recap's learned-item lead against a timeline
 * anchor's "Learned"/"After" text regardless of curly-vs-straight quotes, case, or a trailing
 * full stop/colon/etc.
 *
 * @param {string} s raw HTML (tags stripped by textOf) or plain text
 * @returns {string}
 */
function foldKey(s) {
  let t = pinned.canonicalNfc(foldTypographer(textOf(s))).toLowerCase();
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[\s.,;:!?'"]+$/, '');
  return t;
}

/**
 * Resolves an `href="..."` attribute value (as published, verbatim from the page's own HTML)
 * against the output path of the page it was found on, to another page's own output path.
 *
 * - Entities are decoded first.
 * - `#...` and `?...` are dropped.
 * - Absolute (scheme://, protocol-relative //) hrefs resolve to null (out of scope: they can
 *   never resolve to a site page).
 * - Each remaining path segment is percent-decoded (defensively; a malformed % sequence is left
 *   as-is rather than throwing).
 *
 * @param {string} fromOutputPath e.g. 'characters/npcs/mira.html'
 * @param {string} raw the raw href attribute value
 * @returns {string | null}
 */
function resolveHref(fromOutputPath, raw) {
  let h = decodeEntities(String(raw));
  h = h.split('#')[0].split('?')[0];
  if (h === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  if (h.startsWith('//')) return null;

  const decodedSegments = h.split('/').map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  const v = decodedSegments.join('/');
  const dir = path.posix.dirname(fromOutputPath);
  return path.posix.normalize(path.posix.join(dir, v));
}

/**
 * Given `html` and the index of an opening `<tag ...>` inside it, returns the index just past
 * the matching `</tag>` (balanced on nested `<tag` / `</tag>` occurrences), or -1 if unbalanced.
 *
 * @param {string} html
 * @param {number} openIdx
 * @param {string} tag e.g. 'div'
 * @returns {number}
 */
function sliceBalanced(html, openIdx, tag) {
  const tokenRe = new RegExp(`<${tag}\\b|<\\/${tag}>`, 'g');
  tokenRe.lastIndex = openIdx;
  let depth = 0;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[0].charAt(1) === '/') {
      depth--;
      if (depth === 0) return tokenRe.lastIndex;
    } else {
      depth++;
    }
  }
  return -1;
}

// Tags/classes proseRegion strips out, in the sequence the brief lists them.
const PROSE_STRIP = [
  ['div', 'relationship-graph'],
  ['aside', 'context-sidebar'],
  ['ul', 'relationship-list'],
  ['nav', 'breadcrumbs'],
  ['div', 'story-nav'],
  ['div', 'metadata-badges'],
  ['div', 'whos-here'],
];

/**
 * Removes every balanced `<tag class="cls" ...>...</tag>` block from `html`, where the open tag
 * is matched on `<tag class="cls` followed by `>`, a space, or `"` (so a page whose class
 * attribute carries other classes too, or none, both match correctly).
 *
 * @param {string} html
 * @param {string} tag
 * @param {string} cls
 * @returns {string}
 */
function removeBalancedBlocks(html, tag, cls) {
  const openRe = new RegExp(`<${tag}\\s+class="${cls}(?=[ ">])[^>]*>`, 'g');
  let result = html;
  let searchFrom = 0;
  for (;;) {
    openRe.lastIndex = searchFrom;
    const m = openRe.exec(result);
    if (!m) break;
    const start = m.index;
    const endIdx = sliceBalanced(result, start, tag);
    if (endIdx === -1) {
      searchFrom = start + 1;
      continue;
    }
    result = result.slice(0, start) + result.slice(endIdx);
    searchFrom = start; // continue scanning from where the removed block used to start
  }
  return result;
}

/**
 * Takes the text from `<main class="content">` to its first `</main>`, then strips the
 * non-prose blocks (graph, sidebar, relationship-list, breadcrumbs, story-nav, metadata-badges,
 * whos-here) out of it, balanced. Deliberately does not know about `.sc-cx` (collect-then-write
 * is the guarantee; T-C9 proves it).
 *
 * @param {string} html
 * @returns {string}
 */
function proseRegion(html) {
  const openTag = '<main class="content">';
  const mainOpenIdx = html.indexOf(openTag);
  if (mainOpenIdx === -1) return '';
  const contentStart = mainOpenIdx + openTag.length;
  const mainCloseIdx = html.indexOf('</main>', contentStart);
  if (mainCloseIdx === -1) return '';
  let region = html.slice(contentStart, mainCloseIdx);
  for (const [tag, cls] of PROSE_STRIP) {
    region = removeBalancedBlocks(region, tag, cls);
  }
  return region;
}

const ROMAN_TABLE = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

/**
 * @param {number} n 1-3999
 * @returns {string}
 */
function toRoman(n) {
  let num = n;
  let out = '';
  for (const [value, symbol] of ROMAN_TABLE) {
    while (num >= value) {
      out += symbol;
      num -= value;
    }
  }
  return out;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function cmpCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = {
  decodeEntities,
  textOf,
  escapeHtml,
  foldTypographer,
  foldKey,
  resolveHref,
  sliceBalanced,
  proseRegion,
  removeBalancedBlocks,
  toRoman,
  cmpCodeUnit,
};
