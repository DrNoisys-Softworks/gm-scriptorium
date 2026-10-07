'use strict';

const { JSON_BODY_CAP } = require('./body');

/*
 * V1e-9 (ADR 0033 addendum, SD-95): pure candidate builders for the two V1e-9 operations --
 * (b) a whole-frontmatter text replace, and (d) a restore from a backup -- plus bodyGuard, the
 * byte-level proof (independent of either builder's own output) that the body is unchanged.
 *
 * Deliberately minimal requires (only ./body, for JSON_BODY_CAP): this file carries its own tiny
 * stripEol rather than requiring src/admin/vaultconfigedit.js for it.
 */

function stripEol(line) {
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  if (line.endsWith('\n')) return line.slice(0, -1);
  return line;
}

const EDITOR_REASON = Object.freeze({
  'not-utf8': "vault-config.md isn't valid UTF-8 text, so the panel won't edit it.",
  'no-open': "vault-config.md doesn't start with a plain --- line, so the panel won't edit it. Edit it by hand.",
  'no-close': "vault-config.md's frontmatter has no closing --- line, so the panel won't edit it. Edit it by hand.",
  'mixed-eol': "vault-config.md mixes line endings in its frontmatter, so the panel won't edit it. Edit it by hand.",
  'too-large': "vault-config.md's frontmatter is larger than the 64 KiB the panel can edit.",
  'lone-cr':
    "Line <N> of vault-config.md has a stray carriage return that the browser's editor would change, so the panel won't edit it. Edit it by hand.",
  'request-too-large': "vault-config.md's frontmatter is too large to send back from the browser in one save (the limit is 64 KiB). Edit it by hand.",
});

/**
 * @param {{lines: string[]}} split splitFileDetailed's result
 * @returns {number|null} the file line (index + 2) of the first frontmatter line whose EOL-
 *   stripped text still contains a stray \r, else null
 */
function loneCrLine(split) {
  for (let i = 0; i < split.lines.length; i++) {
    if (stripEol(split.lines[i]).includes('\r')) return i + 2;
  }
  return null;
}

/**
 * @param {{lines: string[]}} split splitFileDetailed's result
 * @returns {string} the frontmatter lines with their own EOL stripped, joined by '\n', no
 *   trailing newline
 */
function editorText(split) {
  return split.lines.map(stripEol).join('\n');
}

/**
 * @param {string} text the candidate editorText
 * @returns {boolean} true iff the JSON body carrying `text` back from the browser fits JSON_BODY_CAP
 */
function requestFits(text) {
  return (
    Buffer.byteLength(
      JSON.stringify({ frontmatterText: text, baseSha256: '0'.repeat(64), dryRun: false, saveAnyway: true, reviewedSha256: '0'.repeat(64) }),
      'utf8',
    ) <= JSON_BODY_CAP
  );
}

/** Shared final assembly step: `lines` + split.eol each, then split.head/.tail unchanged. */
function assemble(split, lines) {
  const frontmatterText = lines.map((l) => l + split.eol).join('');
  return { frontmatterText, bytes: Buffer.from(split.head + frontmatterText + split.tail, 'utf8') };
}

/**
 * Builds operation (b)'s candidate from the browser's own plain-line-break text.
 *
 * @param {{head:string, eol:string, tail:string}} split splitFileDetailed's result for the
 *   CURRENT file
 * @param {string} text the browser's edited text (editorText's own shape: \n-joined, no EOLs)
 * @returns {{ok:true, bytes:Buffer, frontmatterText:string} | {ok:false, line:number|null, message:string}}
 */
function buildTextCandidate(split, text) {
  if (typeof text !== 'string') {
    return { ok: false, line: null, message: "The edited text isn't valid text." };
  }
  if (text.includes('\r')) {
    return { ok: false, line: null, message: 'The edited text must use plain line breaks.' };
  }
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) {
    return { ok: false, line: null, message: "The edited text isn't valid text." };
  }

  let lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('---')) {
      return { ok: false, line: i + 2, message: 'This line starts with ---, which would end the frontmatter early.' };
    }
  }

  const { frontmatterText, bytes } = assemble(split, lines);
  return { ok: true, bytes, frontmatterText };
}

/**
 * Builds operation (d)'s candidate: the backup's own frontmatter lines (EOL stripped), rejoined
 * with the CURRENT file's own line ending (restore only ever changes the frontmatter; the file's
 * own EOL style is never changed by a restore).
 *
 * @param {{head:string, eol:string, tail:string}} split splitFileDetailed's result for the
 *   CURRENT file
 * @param {{lines:string[], eol:string}} backupSplit splitFileDetailed's result for the backup
 * @returns {{ok:true, bytes:Buffer, frontmatterText:string, eolChanged:boolean}}
 */
function buildRestoreCandidate(split, backupSplit) {
  const lines = backupSplit.lines.map(stripEol);
  const { frontmatterText, bytes } = assemble(split, lines);
  return { ok: true, bytes, frontmatterText, eolChanged: backupSplit.eol !== split.eol };
}

/**
 * A byte-level proof, independent of either builder above, that the body (and the opening/
 * closing fence lines) are unchanged: valid because splitFileDetailed already proved the UTF-8
 * round trip of `curBytes` (the current file), so slicing it at the same byte offsets `split.head`/
 * `split.tail` occupied is safe.
 *
 * @param {Buffer} curBytes the CURRENT file's whole bytes
 * @param {{head:string, tail:string}} split splitFileDetailed's result for curBytes
 * @param {Buffer} candBytes the candidate's whole bytes
 * @returns {boolean}
 */
function bodyGuard(curBytes, split, candBytes) {
  const h = Buffer.byteLength(split.head, 'utf8');
  const t = Buffer.byteLength(split.tail, 'utf8');
  return (
    candBytes.length >= h + t &&
    curBytes.subarray(0, h).equals(candBytes.subarray(0, h)) &&
    curBytes.subarray(curBytes.length - t).equals(candBytes.subarray(candBytes.length - t))
  );
}

module.exports = {
  EDITOR_REASON,
  loneCrLine,
  editorText,
  requestFits,
  buildTextCandidate,
  buildRestoreCandidate,
  bodyGuard,
};
