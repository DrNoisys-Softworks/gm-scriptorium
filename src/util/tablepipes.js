'use strict';

/*
 * Issue #48. The vault format writes a wikilink alias inside a markdown table cell as
 * `[[Target\|Label]]`: the pipe is escaped so the table does not read it as a column delimiter.
 * The pinned generator's wikilink readers (resolveWikiLinks, backlinks, recency, search index)
 * all split on a bare `|` only, so they read the target as `Target\` and never resolve it.
 *
 * src/vault/links.js's rewriteEscapedPipeLinksOutsideCode() (the code-aware caller) turns `\|` into `|` inside a wikilink on a TABLE ROW only (a line
 * whose first non-space character is `|`), the one place the escape is meaningful. Outside a
 * table a backslash-pipe is left alone. Both the check's link scan (src/vault/links.js) and the
 * build's read shim (src/generator/bootstrap.js) call this one function, so check and build
 * cannot disagree about what such a link means. The unescaped pipe is safe for the build because
 * the generator replaces the whole wikilink (with `[Label](href)` or plain Label) before the
 * markdown table parser ever sees the row.
 */

const TABLE_ROW_RE = /^\s*\|/;
const ESCAPED_PIPE_LINK_RE = /\[\[([^\]|\n]*?)\\\|([^\]\n]*)\]\]/g;

/** Rewrites one line (no newline); a non-table line is returned as is. */
function rewriteTableRowSegment(segment) {
  return segment.replace(ESCAPED_PIPE_LINK_RE, '[[$1|$2]]');
}

function isTableRow(line) {
  return TABLE_ROW_RE.test(line);
}

module.exports = { rewriteTableRowSegment, isTableRow };
