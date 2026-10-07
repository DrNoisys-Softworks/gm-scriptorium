'use strict';

const fs = require('fs');
const path = require('path');
const { createFinding } = require('../../report/finding');
const { scanObsidianComments } = require('../../vault/comments');
const read = require('../../vault/read');
const { normaliseEmitted, noBuildInfo, deferredInfo } = require('./outputscan');

/*
 * ADR 0044: the Obsidian `%%comment%%` guard's check side. Two views of the same scan
 * (src/vault/comments.js, the function the build's read shim also uses):
 *
 *   leak/l6-comment-withheld     INFO, one per published file with comments: they are being withheld.
 *   leak/l6-comment-unterminated WARN, a `%%` with no closing `%%`: withheld to the end of the file.
 *   leak/l6-comment-in-output    ERROR, comment text (or a literal `%%` outside code) reached the
 *                                built output. Runs on the real output via `check`, and on the
 *                                staging tree before the swap during `build`, where `--force`
 *                                cannot override it. ADR 0045: JSON data islands (`<script
 *                                type="application/json">`) are searched too, and one that does
 *                                not parse is an error (`arm: 'island-unparsable'`), never skipped.
 */

// Output needles shorter than this are not searched: a very short comment ("todo") would also match
// ordinary published prose. A literal `%%` in the output is still caught whatever the comment said.
const MIN_NEEDLE = 8;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.mp3', '.mp4', '.webm', '.ogg', '.wav',
]);

function fileSources(page) {
  const sources = [{ relPath: page.relPath, markdown: page.markdown, offset: page.bodyLineOffset || 0 }];
  if (typeof page.storyMarkdown === 'string') {
    sources.push({ relPath: page.storyRelPath || page.relPath, markdown: page.storyMarkdown, offset: page.storyLineOffset || 0 });
  }
  return sources;
}

/** Every Obsidian comment in every published page body and paired story, with file-relative line numbers. */
function collectComments(ctx) {
  const rows = [];
  for (const page of ctx.publishSet.publishedPages) {
    for (const src of fileSources(page)) {
      const { comments } = scanObsidianComments(String(src.markdown || '').replace(/\r\n?/g, '\n'));
      for (const c of comments) {
        rows.push({ relPath: src.relPath, line: c.line + src.offset, endLine: c.endLine + src.offset, text: c.text, unterminated: c.unterminated });
      }
    }
  }
  return rows;
}

function lineRange(c) {
  return c.endLine > c.line ? `${c.line}-${c.endLine}` : String(c.line);
}

function runCommentWithheld(ctx) {
  const byFile = new Map();
  for (const c of collectComments(ctx)) {
    if (!byFile.has(c.relPath)) byFile.set(c.relPath, []);
    byFile.get(c.relPath).push(c);
  }
  const findings = [];
  for (const [relPath, list] of byFile) {
    findings.push(
      createFinding({
        id: 'leak/l6-comment-withheld',
        severity: 'info',
        category: 'leak',
        campaign: ctx.campaign,
        path: relPath,
        line: list[0].line,
        message: `${relPath}: ${list.length} Obsidian %% comment(s) withheld from the published site (lines ${list.map(lineRange).join(', ')})`,
        data: { count: list.length },
      }),
    );
  }
  return findings;
}

function runCommentUnterminated(ctx) {
  return collectComments(ctx)
    .filter((c) => c.unterminated)
    .map((c) =>
      createFinding({
        id: 'leak/l6-comment-unterminated',
        severity: 'warn',
        category: 'leak',
        campaign: ctx.campaign,
        path: c.relPath,
        line: c.line,
        message: `${c.relPath}:${c.line}: a %% comment is never closed, so everything from it to the end of the file is withheld from the published site; add the closing %% where the comment should end`,
      }),
    );
}

function collapse(s) {
  return normaliseEmitted(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The needles one comment contributes: its whole text, and each of its lines. Short ones dropped. */
function needlesFor(comment) {
  const out = new Set();
  const whole = collapse(comment.text);
  if (whole.length >= MIN_NEEDLE) out.add(whole);
  for (const line of comment.text.split('\n')) {
    const n = collapse(line);
    if (n.length >= MIN_NEEDLE) out.add(n);
  }
  return [...out];
}

function collectJsonStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectJsonStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectJsonStrings(v, out));
}

/*
 * ADR 0045. HTML is read the way a browser tokenizes it, once, left to right. Nothing here removes
 * text by pattern, so there is no stripped result that can be rebuilt into a tag or that can hide
 * text a reader would see (the earlier strip-based reading missed `<script<script>A</script> text
 * </script>`, where `script<script` is just an unknown element name and "text" is displayed).
 *
 *   - A start tag is `<` + a letter; its name runs to whitespace, `/` or `>`. Quoted attribute values
 *     (after `=`) may contain `>`. A quote that never closes is ignored, and a tag with no `>` is
 *     plain text.
 *   - `<script>` and `<style>` are raw-text elements: their body runs to the next `</script` (or
 *     `</style`) followed by whitespace, `/` or `>`. A body with no end tag runs to the end of the page
 *     and counts as page text (fail closed).
 *   - `<pre>` and `<code>` are followed by depth, and only the marks reading leaves their text out.
 *     If they never balance, nothing is left out (fail closed).
 */

const NAME_END = /[\s/>]/;

/** Reads the start or end tag whose `<` is at `i`. Returns null when it is not a tag (so the `<` is text). */
function readTag(raw, i) {
  let j = i + 1;
  const closing = raw[j] === '/';
  if (closing) j += 1;
  if (!/[A-Za-z]/.test(raw[j] || '')) return null;
  const nameStart = j;
  while (j < raw.length && !NAME_END.test(raw[j])) j += 1;
  const name = raw.slice(nameStart, j).toLowerCase();
  const attrStart = j;
  let afterEquals = false;
  while (j < raw.length && raw[j] !== '>') {
    const c = raw[j];
    if (c === '=') {
      afterEquals = true;
      j += 1;
    } else if (/\s/.test(c)) {
      j += 1;
    } else if (afterEquals && (c === '"' || c === "'")) {
      const close = raw.indexOf(c, j + 1);
      if (close === -1) {
        afterEquals = false;
        j += 1; // unclosed quote: ignore it rather than swallow the page
      } else {
        j = close + 1;
        afterEquals = false;
      }
    } else {
      afterEquals = false;
      j += 1;
    }
  }
  if (j >= raw.length) return null; // no closing ">"
  return { name, closing, attrs: raw.slice(attrStart, j), end: j + 1 };
}

/** The first `type` attribute's value, lower-cased and trimmed; null when there is none. */
function typeAttribute(attrs) {
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(attrs))) {
    if (m[1].toLowerCase() === 'type') {
      const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      return v === undefined ? '' : v.trim().toLowerCase();
    }
  }
  return null;
}

/** application/json and any application/*+json (ld+json, vnd.api+json), with optional parameters. */
function isJsonType(type) {
  if (type === null) return false;
  const essence = type.split(';')[0].trim();
  return /^application\/(?:[a-z0-9.!#$&^_-]+\+)?json$/.test(essence);
}

/**
 * @param {string} raw
 * @returns {{ kind: 'text'|'tag'|'raw', text?: string, name?: string, closing?: boolean,
 *   attrs?: string, body?: string, closed?: boolean }[]}
 */
function tokenize(raw) {
  const out = [];
  let text = '';
  const flush = () => {
    if (text !== '') out.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < raw.length) {
    const lt = raw.indexOf('<', i);
    if (lt === -1) {
      text += raw.slice(i);
      break;
    }
    text += raw.slice(i, lt);
    if (raw.startsWith('<!--', lt)) {
      // An HTML comment is not displayed but is part of the page source, so its text is searched.
      const close = raw.indexOf('-->', lt + 4);
      flush();
      out.push({ kind: 'tag', name: '!--', closing: false, attrs: '' });
      text += raw.slice(lt + 4, close === -1 ? raw.length : close);
      flush();
      i = close === -1 ? raw.length : close + 3;
      continue;
    }
    if (raw[lt + 1] === '!' || raw[lt + 1] === '?') {
      const gt = raw.indexOf('>', lt);
      if (gt === -1) {
        text += raw.slice(lt);
        break;
      }
      flush();
      out.push({ kind: 'tag', name: raw[lt + 1], closing: false, attrs: '' });
      i = gt + 1;
      continue;
    }
    const tag = readTag(raw, lt);
    if (!tag) {
      text += '<';
      i = lt + 1;
      continue;
    }
    flush();
    if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
      const endRe = new RegExp(`</${tag.name}(?=[\\s/>])`, 'ig');
      endRe.lastIndex = tag.end;
      const e = endRe.exec(raw);
      let bodyEnd = raw.length;
      let next = raw.length;
      let closed = false;
      if (e) {
        const gt = raw.indexOf('>', e.index);
        if (gt !== -1) {
          bodyEnd = e.index;
          next = gt + 1;
          closed = true;
        }
      }
      out.push({ kind: 'raw', name: tag.name, attrs: tag.attrs, body: raw.slice(tag.end, bodyEnd), closed });
      i = next;
      continue;
    }
    out.push({ kind: 'tag', name: tag.name, closing: tag.closing, attrs: tag.attrs });
    i = tag.end;
  }
  flush();
  return out;
}

/**
 * The text a reader of the page could see, as one piece per run of text (tags separate pieces).
 * `leaveOut` names elements whose content is not wanted: raw-text blocks that end properly, and
 * `pre`/`code` content up to the first end tag of the same name (a nested start tag does not extend
 * it, so text after the first end tag is still searched). A `pre`/`code` that never ends, and a
 * raw-text block with no end tag, are kept (fail closed).
 */
function visibleText(raw, leaveOut) {
  const kept = [];
  const all = [];
  let inside = null;
  for (const t of tokenize(raw)) {
    if (t.kind === 'text') {
      all.push(t.text);
      if (inside === null) kept.push(t.text);
    } else if (t.kind === 'raw') {
      all.push(t.body);
      if (!t.closed || !leaveOut.has(t.name)) {
        if (inside === null) kept.push(t.body);
      }
    } else if ((t.name === 'pre' || t.name === 'code') && leaveOut.has(t.name)) {
      if (inside === null && !t.closing) inside = t.name;
      else if (inside === t.name && t.closing) inside = null;
    }
  }
  return inside === null ? kept : all;
}

/**
 * ADR 0045. Every `<script type="application/json">` data island (or any `application/*+json`) in an
 * HTML page. Scriptorium's own pages carry `sc-tl-data` and `sc-cx-data` islands and the generator's
 * carry id-keyed ones; the attributes may come in any order. A parsed island contributes its strings.
 * An island that does not parse, or that has no end tag, is kept as raw body text and counted, and
 * the caller fails closed on it. No parser message is kept: Node's JSON error quotes the input.
 *
 * @param {string} raw
 * @returns {{ strings: string[], unparsableBodies: string[] }}
 */
function readIslands(raw) {
  const strings = [];
  const unparsableBodies = [];
  for (const t of tokenize(raw)) {
    if (t.kind !== 'raw' || t.name !== 'script' || !isJsonType(typeAttribute(t.attrs))) continue;
    try {
      if (!t.closed) throw new Error('unterminated');
      collectJsonStrings(JSON.parse(t.body), strings);
    } catch {
      unparsableBodies.push(t.body);
    }
  }
  return { strings, unparsableBodies };
}

/** The text views of one output file that a comment could surface in. */
function haystacksFor(ext, raw) {
  if (ext === '.html' || ext === '.htm') {
    const pieces = visibleText(raw, new Set(['script', 'style']));
    const hays = [collapse(pieces.join(' ')), collapse(pieces.join(''))];
    const { strings, unparsableBodies } = readIslands(raw);
    if (strings.length > 0) hays.push(collapse(strings.join('\n')));
    for (const body of unparsableBodies) hays.push(collapse(body));
    return hays;
  }
  if (ext === '.json') {
    try {
      const strings = [];
      collectJsonStrings(JSON.parse(raw), strings);
      return [collapse(strings.join('\n'))];
    } catch {
      return [collapse(raw)];
    }
  }
  return [collapse(raw)];
}

/**
 * True when an HTML page carries a literal `%%` in prose, i.e. outside <code>/<pre>/<script>/<style>
 * and tags, or inside a JSON data island (a string there, or the raw body of an island that does not
 * parse).
 */
function htmlHasLiteralMarks(raw) {
  const prose = visibleText(raw, new Set(['script', 'style', 'pre', 'code'])).join(' ');
  if (normaliseEmitted(prose).includes('%%')) return true;
  const { strings, unparsableBodies } = readIslands(raw);
  return strings.some((x) => normaliseEmitted(x).includes('%%')) || unparsableBodies.some((x) => normaliseEmitted(x).includes('%%'));
}

/**
 * @param {{ outDir: string, campaign: string, comments: ReturnType<typeof collectComments> }} opts
 */
function scanCommentsInOutput({ outDir, campaign, comments }) {
  const needles = [];
  for (const c of comments) for (const n of needlesFor(c)) needles.push({ needle: n, c });

  const findings = [];
  for (const file of read.walkVault(outDir)) {
    const ext = path.extname(file.relPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const raw = fs.readFileSync(file.absPath, 'utf8');

    if ((ext === '.html' || ext === '.htm') && htmlHasLiteralMarks(raw)) {
      findings.push(
        createFinding({
          id: 'leak/l6-comment-in-output',
          severity: 'error',
          category: 'leak',
          campaign,
          outputPath: file.relPath,
          message: `${file.relPath}: a literal %% appears in the published text (an Obsidian comment was not removed, or a stray %% was published)`,
          data: { arm: 'marks' },
        }),
      );
    }

    if ((ext === '.html' || ext === '.htm') && readIslands(raw).unparsableBodies.length > 0) {
      // Fail closed (ADR 0045): an island we cannot read cannot be shown clean. A fixed message only,
      // no island text and no parser message. The raw body is still searched below.
      findings.push(
        createFinding({
          id: 'leak/l6-comment-in-output',
          severity: 'error',
          category: 'leak',
          campaign,
          outputPath: file.relPath,
          message: `${file.relPath}: a JSON data island could not be parsed, so it cannot be confirmed free of withheld comment text`,
          data: { arm: 'island-unparsable' },
        }),
      );
    }

    const hays = haystacksFor(ext, raw);
    const seen = new Set();
    for (const { needle, c } of needles) {
      const key = `${c.relPath}:${c.line}`;
      if (seen.has(key)) continue;
      if (!hays.some((h) => h.includes(needle))) continue;
      seen.add(key);
      const shown = needle.length > 40 ? `${needle.slice(0, 40)}...` : needle;
      findings.push(
        createFinding({
          id: 'leak/l6-comment-in-output',
          severity: 'error',
          category: 'leak',
          campaign,
          path: c.relPath,
          line: c.line,
          outputPath: file.relPath,
          message: `${file.relPath}: text from the %% comment at ${c.relPath}:${c.line} appears in built output ("${shown}")`,
          data: { arm: 'text' },
        }),
      );
    }
  }
  return findings;
}

function runCommentInOutput(ctx) {
  const id = 'leak/l6-comment-in-output';
  if (ctx.deferOutputScan) return [deferredInfo(id, ctx)];
  if (!ctx.outputPath) return [noBuildInfo(id, ctx)];
  return scanCommentsInOutput({ outDir: ctx.outputPath, campaign: ctx.campaign, comments: collectComments(ctx) });
}

module.exports = {
  collectComments,
  needlesFor,
  scanCommentsInOutput,
  runCommentWithheld,
  runCommentUnterminated,
  runCommentInOutput,
};
