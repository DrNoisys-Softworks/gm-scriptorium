'use strict';

/*
 * ADR 0044, addendum on dataview blocks (issue 202). The build's read shim (src/generator/bootstrap.js)
 * removes dataview blocks from every vault note before the generator reads it.
 *
 * Why: at the pinned generator the text it builds the search index, "Mentioned in" links, recency and
 * the recaps from keeps dataview blocks (the page itself does not; lib/processor.js:525-527 is the
 * one pattern both would use). Removing them here keeps query text out of all of those.
 *
 * Rules:
 *  - The only matcher is the pin's own stripDataview (via src/generator/pinned.js), so this cannot
 *    drift from what the generator removes from a page. There is no pattern of our own in this file.
 *  - A leading YAML frontmatter block is returned byte for byte. The block is found with the same rule
 *    the comment strip uses (frontmatterLineCount), and split by character offset, never by re-joining
 *    lines, so CRLF and a file that is only frontmatter come back exact.
 *  - `_meta/publish-manifest.md` is returned unchanged. The generator reads it line by line
 *    (lib/manifest.js:92-96), so removing a fence that holds an Excluded heading would move the
 *    entries below it into Publishing for the build but not for `check`.
 *  - Line counts are not kept, so a generator warning's line number after a block can shift.
 *  - A non-string is returned as it is.
 */

const path = require('path');
const pinned = require('../generator/pinned');
const { frontmatterLineCount } = require('./comments');

/** True for a file named publish-manifest.md directly inside a folder named _meta. */
function isPublishManifest(file) {
  return typeof file === 'string' && path.basename(file) === 'publish-manifest.md' && path.basename(path.dirname(file)) === '_meta';
}

/**
 * @param {string} markdown
 * @param {string} [file] the path the read shim was asked for
 * @returns {string}
 */
function stripDataviewBlocks(markdown, file) {
  if (typeof markdown !== 'string') return markdown;
  if (isPublishManifest(file)) return markdown;
  const lines = markdown.split('\n');
  const frontmatterLines = frontmatterLineCount(lines);
  let offset = 0;
  for (let i = 0; i < frontmatterLines; i++) offset += lines[i].length + 1;
  return markdown.slice(0, offset) + pinned.stripDataview(markdown.slice(offset));
}

module.exports = { stripDataviewBlocks };
