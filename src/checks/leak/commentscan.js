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

// A start tag is `<name` followed by whitespace, `/` or `>`; an end tag is `</name` followed by anything
// up to `>` (the HTML tokenizer accepts `</script \t\nfoo>`). Case-insensitive throughout.
const SCRIPT_RE = /<script(?=[\s/>])([^>]*)>([\s\S]*?)(?:(<\/script(?=[\s/>])[^>]*>)|$)/gi;
const BLOCK_RE_CACHE = new Map();

/**
 * Replaces each CLOSED `<tag ...>...</tag ...>` block (tags given as an alternation) with a space, to
 * a fixpoint so text that a removal brings together cannot rebuild a tag. An unclosed block is left
 * in place, so its text is still searched (fail closed).
 */
function stripBlocks(html, tags) {
  if (!BLOCK_RE_CACHE.has(tags)) {
    BLOCK_RE_CACHE.set(tags, new RegExp(`<(${tags})(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/\\1(?=[\\s/>])[^>]*>`, 'gi'));
  }
  const re = BLOCK_RE_CACHE.get(tags);
  let out = String(html);
  for (let prev = null; prev !== out; ) {
    prev = out;
    out = out.replace(re, ' ');
  }
  return out;
}

/** Removes every tag, to a fixpoint (`<<b>i>` must not leave a tag behind). */
function stripTags(html, replacement) {
  let out = String(html);
  for (let prev = null; prev !== out; ) {
    prev = out;
    out = out.replace(/<[^>]*>/g, replacement);
  }
  return out;
}
const JSON_TYPE_RE = /\btype\s*=\s*["']?\s*application\/json\b/i;

/**
 * ADR 0045. Every `<script type="application/json">` data island in an HTML page, read from the raw
 * HTML before the script strip. Scriptorium's own pages carry `sc-tl-data` and `sc-cx-data` islands
 * and the generator's carry id-keyed ones; both forms are matched (attribute order is free). A parsed
 * island contributes its strings; an island that does not parse is kept as raw body text and counted,
 * and the caller fails closed on it. No parser message is kept: Node's JSON error quotes the input.
 *
 * @param {string} raw
 * @returns {{ strings: string[], unparsableBodies: string[] }}
 */
function readIslands(raw) {
  const strings = [];
  const unparsableBodies = [];
  SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_RE.exec(raw))) {
    if (!JSON_TYPE_RE.test(m[1])) continue;
    // An island with no end tag runs to the end of the page; it cannot be trusted, so it is
    // reported as unparsable whatever the text holds.
    const closed = m[3] !== undefined;
    try {
      if (!closed) throw new Error('unterminated');
      collectJsonStrings(JSON.parse(m[2]), strings);
    } catch {
      unparsableBodies.push(m[2]);
    }
  }
  return { strings, unparsableBodies };
}

/** The text views of one output file that a comment could surface in. */
function haystacksFor(ext, raw) {
  if (ext === '.html' || ext === '.htm') {
    const noScript = stripBlocks(raw, 'script|style');
    const hays = [collapse(stripTags(noScript, ' ')), collapse(stripTags(noScript, ''))];
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
 * and tags, or inside a JSON data island (ADR 0045: a string there, or the raw body of an island
 * that does not parse).
 */
function htmlHasLiteralMarks(raw) {
  const prose = stripTags(stripBlocks(raw, 'script|style|pre|code'), ' ');
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
