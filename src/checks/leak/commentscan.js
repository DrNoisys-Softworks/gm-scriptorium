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
 * ADR 0045. HTML is read the way a browser tokenizes it, once, left to right, following the HTML
 * tokenizer's states for tags and attributes. Nothing is removed by pattern, so there is no stripped
 * result that can be rebuilt into a tag or that can hide text a reader would see.
 *
 *   - HTML whitespace is only tab, LF, FF, CR and space. A start tag is `<` + an ASCII letter; its
 *     name runs to whitespace, `/` or `>` (so `script<script` and   are part of a name).
 *   - Attributes follow the before-attribute-name / attribute-name / before-attribute-value states:
 *     a `=` first in a name position is part of a name, and a quote opens a value only when it is
 *     the first character after a real attribute name's `=`. A quoted value may hold `>`.
 *   - A tag that is not closed by a `>` before the end of the page (including one whose quoted value
 *     never closes) is dropped by a browser along with everything after it. Nothing is displayed, but
 *     here the remainder is treated as page text and searched (fail closed).
 *   - `<script>` and `<style>` are raw-text elements whose body is left out of the text reading and
 *     whose `<script>` JSON bodies are the islands. Their body runs to the next `</script` (or
 *     `</style`) followed by whitespace, `/` or `>`; a body with no end tag runs to the end of the page
 *     and is searched.
 *   - RCDATA and RAWTEXT elements (textarea, title, xmp, iframe, noembed, noframes) and `<plaintext>`
 *     show their content as text, markup included, so the content is searched as text. A CDATA
 *     section is text. An HTML comment is not displayed but is page source, so its text is searched.
 *   - `<pre>` and `<code>` are followed by name, and only the marks reading leaves their text out. If
 *     they never end, nothing is left out (fail closed).
 *   - Total work on tags that never close is bounded, so a hostile page cannot make the scan slow.
 */

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isAlpha = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/** Elements whose content a browser shows as text, markup and all. Searched, never skipped. */
const TEXT_ELEMENTS = new Set(['textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

/**
 * Reads the start or end tag whose `<` is at `i`, per the tokenizer's tag states. Returns null when
 * it is not a tag, or when no `>` ends it before the end of the page. `ctx` carries the position of
 * the last `>`, the last quote of each kind, and the budget for scans that fail.
 */
function readTag(raw, i, ctx) {
  const n = raw.length;
  let j = i + 1;
  const closing = raw[j] === '/';
  if (closing) j += 1;
  if (!isAlpha(raw[j])) return null;
  if (i > ctx.lastGt || ctx.budget <= 0) return null;
  const nameStart = j;
  while (j < n && !isWs(raw[j]) && raw[j] !== '/' && raw[j] !== '>') j += 1;
  const name = raw.slice(nameStart, j).toLowerCase();
  const attrs = [];
  const seen = new Set();
  for (;;) {
    while (j < n && (isWs(raw[j]) || raw[j] === '/')) j += 1;
    if (j >= n) break;
    if (raw[j] === '>') return { name, closing, attrs, end: j + 1 };
    const aStart = j;
    j += 1; // the first character is always part of the name (a leading "=" included)
    while (j < n && !isWs(raw[j]) && raw[j] !== '/' && raw[j] !== '>' && raw[j] !== '=') j += 1;
    const aName = raw.slice(aStart, j).toLowerCase();
    while (j < n && isWs(raw[j])) j += 1;
    let value = '';
    if (raw[j] === '=') {
      j += 1;
      while (j < n && isWs(raw[j])) j += 1;
      const q = raw[j];
      if (q === '"' || q === "'") {
        if (j >= (q === '"' ? ctx.lastDq : ctx.lastSq)) break; // no closing quote anywhere after
        const close = raw.indexOf(q, j + 1);
        value = raw.slice(j + 1, close);
        j = close + 1;
      } else {
        const vStart = j;
        while (j < n && !isWs(raw[j]) && raw[j] !== '>') j += 1;
        value = raw.slice(vStart, j);
      }
    }
    if (!seen.has(aName)) {
      seen.add(aName);
      attrs.push({ name: aName, value });
    }
  }
  ctx.budget -= n - i; // a tag that ran to the end of the page
  return null;
}

const NAMED_REFS = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", sol: '/', colon: ':', plus: '+', period: '.', hyphen: '-', dash: '-', lowbar: '_', nbsp: ' ', Tab: '\t', NewLine: '\n' };

/** Decodes numeric and the few named character references a MIME type can use. Unknown ones stay. */
function decodeAttribute(v) {
  return v.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));?/g, (whole, dec, hex, named) => {
    if (named !== undefined) return Object.prototype.hasOwnProperty.call(NAMED_REFS, named) ? NAMED_REFS[named] : whole;
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/**
 * True for application/json and application/*+json (ld+json, vnd.api+json), with parameters. A type
 * that still holds a character reference after decoding is counted as JSON (fail closed).
 */
function isJsonType(attrs) {
  const a = attrs.find((x) => x.name === 'type');
  if (!a) return false;
  const type = decodeAttribute(a.value).trim().toLowerCase();
  if (type.includes('&')) return true;
  const essence = type.split(';')[0].trim();
  return /^application\/(?:[a-z0-9.!#$&^_-]+\+)?json$/.test(essence);
}

/**
 * @param {string} raw
 * @param {{ budget?: number }} [opts] `budget` is the work allowed for tags that never close; a test can
 *   set it to 0 to prove that running out makes later `<` plain text (searched), never a swallowed tag.
 * @returns {{ kind: 'text'|'tag'|'raw', text?: string, name?: string, closing?: boolean,
 *   attrs?: {name:string,value:string}[], body?: string, closed?: boolean }[]}
 */
function tokenize(raw, { budget } = {}) {
  const out = [];
  const n = raw.length;
  const ctx = { lastGt: raw.lastIndexOf('>'), lastDq: raw.lastIndexOf('"'), lastSq: raw.lastIndexOf("'"), budget: budget === undefined ? 4 * n + 100000 : budget };
  let text = '';
  const flush = () => {
    if (text !== '') out.push({ kind: 'text', text });
    text = '';
  };
  // Finds the end tag of a raw-text or RCDATA element: `</name` then whitespace, `/` or `>`.
  const findEnd = (name, from) => {
    const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'ig');
    re.lastIndex = from;
    const e = re.exec(raw);
    if (!e) return null;
    const tag = readTag(raw, e.index, ctx);
    return tag ? { start: e.index, tag } : null;
  };
  let i = 0;
  while (i < n) {
    const lt = raw.indexOf('<', i);
    if (lt === -1) {
      text += raw.slice(i);
      break;
    }
    text += raw.slice(i, lt);
    if (raw.startsWith('<!--', lt)) {
      // An HTML comment is not displayed but is page source, so its text is searched.
      let bodyStart = lt + 4;
      let close;
      let next;
      if (raw[bodyStart] === '>') {
        close = bodyStart;
        next = bodyStart + 1;
      } else if (raw.startsWith('->', bodyStart)) {
        close = bodyStart;
        next = bodyStart + 2;
      } else {
        const a = raw.indexOf('-->', bodyStart);
        const b = raw.indexOf('--!>', bodyStart);
        if (a === -1 && b === -1) {
          close = n;
          next = n;
        } else if (b === -1 || (a !== -1 && a < b)) {
          close = a;
          next = a + 3;
        } else {
          close = b;
          next = b + 4;
        }
      }
      flush();
      out.push({ kind: 'tag', name: '!--', closing: false, attrs: [] });
      text += raw.slice(bodyStart, close);
      flush();
      i = next;
      continue;
    }
    if (raw.startsWith('<![CDATA[', lt)) {
      const close = raw.indexOf(']]>', lt + 9);
      text += raw.slice(lt + 9, close === -1 ? n : close);
      i = close === -1 ? n : close + 3;
      continue;
    }
    const tag = readTag(raw, lt, ctx);
    if (!tag) {
      text += '<';
      i = lt + 1;
      continue;
    }
    flush();
    if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
      const e = findEnd(tag.name, tag.end);
      out.push({ kind: 'raw', name: tag.name, attrs: tag.attrs, body: raw.slice(tag.end, e ? e.start : n), closed: Boolean(e) });
      i = e ? e.tag.end : n;
      continue;
    }
    out.push({ kind: 'tag', name: tag.name, closing: tag.closing, attrs: tag.attrs });
    i = tag.end;
    if (!tag.closing && tag.name === 'plaintext') {
      text += raw.slice(i);
      i = n;
    } else if (!tag.closing && TEXT_ELEMENTS.has(tag.name)) {
      const e = findEnd(tag.name, tag.end);
      text += raw.slice(tag.end, e ? e.start : n);
      flush();
      if (e) out.push({ kind: 'tag', name: e.tag.name, closing: true, attrs: e.tag.attrs });
      i = e ? e.tag.end : n;
    }
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
    if (t.kind !== 'raw' || t.name !== 'script' || !isJsonType(t.attrs)) continue;
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
  tokenize,
  needlesFor,
  scanCommentsInOutput,
  runCommentWithheld,
  runCommentUnterminated,
  runCommentInOutput,
};
