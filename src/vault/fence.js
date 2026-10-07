'use strict';

/*
 * ADR 0034: the one predicate that decides whether a note's opening frontmatter fence names YAML
 * or something else. Pure: no fs, no requires, so every caller (src/vault/read.js's full-text
 * layer, src/vault/fencescan.js's bounded-head walk) can share the exact same decision without a
 * second, possibly drifting copy.
 *
 * This mirrors gray-matter 4.0.3's own fence-language detection step by step, not by calling
 * gray-matter itself (matter.language() does not strip a BOM, does not implement the `---`/4th-
 * character opening-delimiter rule, and FR-FM-02 requires a refused file to never reach
 * gray-matter at all). Citations are to the bundled copy Scriptorium vendors at this pin
 * (node_modules/gm-apprentice-publish/node_modules/gray-matter/), whose source is identical to
 * Scriptorium's own top-level gray-matter dependency at the same 4.0.3 version:
 *
 *   - BOM strip: to-file.js:39 (gray-matter's lib/) -> utils.js:43-49 -> strip-bom-string (one leading
 *     U+FEFF only).
 *   - Opening delimiter and 4th-character check: index.js:69-79 (matter.test / the
 *     str.charAt(openLen) === '-' guard against "----" not being a fence).
 *   - The tag: index.js:82 slices off the opening "---", then matter.language() (index.js:205-
 *     218) finds the first `\r?\n` and slices up to it; with no `\n` at all, index.js:213's
 *     `search()` returns -1 and `slice(0, -1)` drops the LAST character of the remaining text
 *     (a real gray-matter quirk, not a bug in this predicate) rather than returning the whole
 *     remainder.
 *   - JS `String.prototype.trim()` on the tag (index.js:216): Unicode WhiteSpace and
 *     LineTerminator code points, but NOT U+200B (zero width space), which trim() leaves alone.
 *   - Allowed tags: empty, or "yaml"/"yml" in any case (engine.js:4 + engines.js:23-25 --
 *     'yaml' and 'yml' are literally the only two aliases that resolve to the yaml engine).
 *     Everything else -- json, coffee, an unregistered tag, a prototype-property name -- is
 *     refused, even when the fenced block is itself empty (index.js:101-106's "empty block"
 *     skip only ever applies to a YAML-tagged fence; it is not a reason to allow a non-YAML tag).
 *
 * Rejected alternatives (ADR 0034 section 5): a regex (it cannot express the bare-CR-before-\n
 * quirk below without becoming this same state machine); calling gray-matter's own
 * matter.language() (misses the BOM and opening-delimiter steps, and FR-FM-02 forbids reaching
 * gray-matter at all for a refused file); a denylist of known-dangerous tags (a future engine
 * gray-matter or the generator's bundled copy adds would silently pass a denylist).
 */

const FENCE_HEAD_BYTES = 65536;
const RENDERED_TAG_MAX = 32;

/**
 * Decide the frontmatter fence's declared language exactly the way gray-matter 4.0.3 would,
 * without ever invoking gray-matter.
 *
 * @param {string} text the file's content (full text, or a bounded prefix -- see `truncated`)
 * @param {{ truncated?: boolean }} [options] `truncated: true` means `text` may have been cut
 *   short of the real file (src/vault/fencescan.js's bounded head read); with no `\n` anywhere in
 *   `text`, this predicate then fails closed (`status: 'refused', reason: 'unterminated'`)
 *   instead of guessing what lies beyond the bound.
 * @returns {{status:'no-fence'} | {status:'yaml', tag:string} |
 *           {status:'refused', reason:'language'|'unterminated', tag:string}} `tag` is the RAW,
 *   attacker-controlled tag text (untrimmed of dangerous code points): callers must pass it
 *   through `renderTag()` before it can appear in any message, finding, or envelope.
 */
function classifyFrontmatterFence(text, { truncated = false } = {}) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  if (s.slice(0, 3) !== '---') return { status: 'no-fence' };
  if (s.charAt(3) === '-') return { status: 'no-fence' };

  const rest = s.slice(3);
  const nl = rest.indexOf('\n');
  let raw;
  if (nl === -1) {
    if (truncated) return { status: 'refused', reason: 'unterminated', tag: rest.trim() };
    // gray-matter's own quirk (index.js:213): `str.search(/\r?\n/)` is -1, and
    // `str.slice(0, -1)` drops the trailing character rather than returning the whole
    // remainder. Mirrored here exactly so a file with no closing newline at all classifies
    // the same way gray-matter itself would tag it.
    raw = rest.slice(0, -1);
  } else {
    // /\r?\n/ only matches a \r that sits IMMEDIATELY before the matched \n -- a bare \r
    // earlier in the tag (or anywhere not adjacent to this particular \n) is not stripped.
    raw = rest.slice(0, nl > 0 && rest.charCodeAt(nl - 1) === 0x0d ? nl - 1 : nl);
  }

  const name = raw.trim();
  if (name === '') return { status: 'yaml', tag: '' };
  const lower = name.toLowerCase();
  if (lower === 'yaml' || lower === 'yml') return { status: 'yaml', tag: name };
  return { status: 'refused', reason: 'language', tag: name };
}

// SD-2: code points escaped as \u{HEX} (uppercase hex) in a rendered tag, beyond backslash
// (escaped as \\). Chosen so a bidi-override, a lone surrogate, or an ordinary control character
// can never rearrange or corrupt terminal/log/JSON output that later embeds the rendered tag.
function needsEscape(cp) {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x061c) return true; // Arabic Letter Mark
  if (cp >= 0x200e && cp <= 0x200f) return true; // LRM/RLM
  if (cp >= 0x2028 && cp <= 0x202e) return true; // line/para separators, bidi embeds/overrides
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  if (cp === 0xfeff) return true; // BOM / zero width no-break space
  if (cp >= 0xd800 && cp <= 0xdfff) return true; // lone surrogate (code-point iteration already
  // only ever yields a lone surrogate for unpaired input; a valid pair is a single cp >= 0x10000)
  return false;
}

function escapeCodePoint(cp) {
  return `\\u{${cp.toString(16).toUpperCase()}}`;
}

/**
 * SD-2: render an attacker-controlled fence tag safely for a message, finding, or envelope.
 * Escapes `\` and a fixed set of dangerous/invisible code points, then bounds the result to
 * RENDERED_TAG_MAX (32) UTF-16 code units, always ending on a whole escaped piece or whole
 * character -- never splitting an escape sequence or a surrogate pair.
 *
 * @param {string} tag raw tag text, as returned by classifyFrontmatterFence
 * @returns {string} `.length <= RENDERED_TAG_MAX`
 */
function renderTag(tag) {
  const pieces = [];
  for (const ch of String(tag)) {
    if (ch === '\\') {
      pieces.push('\\\\');
      continue;
    }
    const cp = ch.codePointAt(0);
    pieces.push(needsEscape(cp) ? escapeCodePoint(cp) : ch);
  }
  const whole = pieces.join('');
  if (whole.length <= RENDERED_TAG_MAX) return whole;

  let out = '';
  for (const piece of pieces) {
    if (out.length + piece.length > RENDERED_TAG_MAX - 3) break;
    out += piece;
  }
  return `${out}...`;
}

module.exports = {
  FENCE_HEAD_BYTES,
  RENDERED_TAG_MAX,
  classifyFrontmatterFence,
  renderTag,
};
