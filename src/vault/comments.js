'use strict';

/*
 * ADR 0044. Obsidian comments: `%%text%%` inline, or a `%%` ... `%%` block over several lines.
 * Obsidian hides them from reading view, so a GM uses them for private notes; the pinned generator
 * knows nothing about them and would publish them as written (upstream issue 305, a leak).
 *
 * scanObsidianComments() is the one reader of this syntax. The build's read shim
 * (src/generator/bootstrap.js) uses its `text`; `check` and the build's output gate use its
 * `comments`. One function, so what check reports is exactly what the build removes.
 *
 * Rules (each one fails closed, so an ambiguous `%%` withholds text rather than publishes it):
 *  - A `%%` inside a fenced code block or an inline code span is code, never a comment opener.
 *    Code is recognised with the same helpers the link scan uses (src/vault/links.js).
 *  - A leading YAML frontmatter block is left alone. Obsidian does not treat `%%` there as a comment
 *    and stripping could corrupt the YAML. The output gate still refuses a build that publishes `%%`.
 *  - Once a comment is open, everything is comment text up to the next `%%`, even a line that looks
 *    like a fence. A fence marker inside a comment does not open a fence.
 *  - A `%%` with no closing `%%` runs to the end of the file (unterminated). It is withheld to the end.
 *  - Line count is preserved (removed text leaves its newlines), so line numbers still match source.
 */

const { findInlineCodeSpans, FENCE_OPEN_RE } = require('./links');

const FRONTMATTER_CLOSE_RE = /^(?:---|\.\.\.)\s*$/;

/** Number of leading lines that are a YAML frontmatter block (0 when the file has none). */
function frontmatterLineCount(lines) {
  if (lines.length === 0 || !/^---\s*$/.test(lines[0])) return 0;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_CLOSE_RE.test(lines[i])) return i + 1;
  }
  return 0;
}

/**
 * @param {string} markdown
 * @returns {{ text: string, comments: { line: number, endLine: number, text: string, unterminated: boolean }[] }}
 *   `text` is the markdown with every comment removed. `comments` lists them in source order
 *   (1-based lines; `text` is the comment's inner text, without the `%%` marks).
 */
function scanObsidianComments(markdown) {
  if (typeof markdown !== 'string' || !markdown.includes('%%')) return { text: markdown, comments: [] };

  const lines = markdown.split('\n');
  const out = [];
  const comments = [];
  let fence = null; // { char, len } while inside a fenced code block
  let open = null; // { line, parts: [] } while inside a comment

  const closeComment = (endLine, unterminated) => {
    comments.push({ line: open.line, endLine, text: open.parts.join('\n'), unterminated });
    open = null;
  };

  // Scans one stretch of prose for comment openers. Returns the kept text. May leave `open` set.
  const scanProse = (s, lineNo) => {
    const spans = findInlineCodeSpans(s);
    const inSpan = (i) => spans.some(([a, b]) => i >= a && i < b);
    let kept = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '%' && s[i + 1] === '%' && !inSpan(i)) {
        const close = s.indexOf('%%', i + 2);
        if (close === -1) {
          open = { line: lineNo, parts: [s.slice(i + 2)] };
          return kept;
        }
        comments.push({ line: lineNo, endLine: lineNo, text: s.slice(i + 2, close), unterminated: false });
        i = close + 2;
        continue;
      }
      kept += s[i];
      i++;
    }
    return kept;
  };

  const fmCount = frontmatterLineCount(lines);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const lineNo = n + 1;
    if (n < fmCount) {
      out.push(line);
      continue;
    }
    if (open) {
      const p = line.indexOf('%%');
      if (p === -1) {
        open.parts.push(line);
        out.push('');
        continue;
      }
      open.parts.push(line.slice(0, p));
      closeComment(lineNo, false);
      out.push(scanProse(line.slice(p + 2), lineNo));
      continue;
    }
    if (fence) {
      out.push(line);
      const closeRe = fence.char === '`' ? /^ {0,3}(`{3,})\s*$/ : /^ {0,3}(~{3,})\s*$/;
      const m = closeRe.exec(line);
      if (m && m[1].length >= fence.len) fence = null;
      continue;
    }
    const f = FENCE_OPEN_RE.exec(line);
    if (f) {
      fence = { char: f[1][0], len: f[1].length };
      out.push(line);
      continue;
    }
    out.push(scanProse(line, lineNo));
  }

  if (open) closeComment(lines.length, true);
  return { text: out.join('\n'), comments };
}

/** The markdown with every Obsidian comment removed (what the build's read shim returns). */
function stripObsidianComments(markdown) {
  return scanObsidianComments(markdown).text;
}

module.exports = { scanObsidianComments, stripObsidianComments };
