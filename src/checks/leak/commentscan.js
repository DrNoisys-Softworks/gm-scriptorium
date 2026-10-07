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
 *                                cannot override it.
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

/** The text views of one output file that a comment could surface in. */
function haystacksFor(ext, raw) {
  if (ext === '.html' || ext === '.htm') {
    const noScript = raw.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    return [collapse(noScript.replace(/<[^>]*>/g, ' ')), collapse(noScript.replace(/<[^>]*>/g, ''))];
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

/** True when an HTML page carries a literal `%%` in prose, i.e. outside <code>/<pre>/<script>/<style> and tags. */
function htmlHasLiteralMarks(raw) {
  const prose = raw
    .replace(/<(script|style|pre|code)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return normaliseEmitted(prose).includes('%%');
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
