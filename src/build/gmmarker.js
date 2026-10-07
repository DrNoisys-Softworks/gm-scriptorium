'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Phase 8 slice S6 (docs/agent-runs/admin-s6-engineering-brief-2026-09-28.md, SD-1). The GM-link
 * marker constant, defined ONCE here, and its detector. src/admin/gmlink.js's writer and
 * src/build/outputgate.js's gate both go through this module rather than each holding their own
 * copy of the literal: test/gm-link-structure.test.js pins that the literal string appears
 * nowhere under src/ except this file, so a future writer cannot introduce a second marker that
 * would escape the structural containment test.
 *
 * The detector covers every regular file, not only .html: the pin's own search-index.json
 * carries raw page text (Track D2's existing scanSearchIndex arm proves that shape of leak is
 * real), so a marker that only reached the search index would still have to refuse the build.
 * It never follows a symlink, in either direction the walk could reach one (a symlinked
 * directory it might otherwise recurse into, or a symlinked file it might otherwise read):
 * `readdirSync(dir, { withFileTypes: true })` reports the entry's own type from the directory
 * listing itself, so a symlink is neither `isDirectory()` nor `isFile()` and is simply skipped.
 */

const GM_LINK_MARKER = 'data-scriptorium-gm-link';

const MARKER_BYTES = Buffer.from(GM_LINK_MARKER, 'utf8');

/**
 * @param {string} dir absolute path to a directory (typically a staged or preview build tree)
 * @returns {string[]} sorted, POSIX-relative paths (relative to `dir`) of every file whose bytes
 *   contain the marker. Empty when there is no hit.
 */
function findGmLinkMarker(dir) {
  const hits = [];

  (function walk(current, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks and anything else: never followed, never read
      const bytes = fs.readFileSync(abs);
      if (bytes.includes(MARKER_BYTES)) hits.push(rel);
    }
  })(dir, '');

  hits.sort();
  return hits;
}

module.exports = { GM_LINK_MARKER, findGmLinkMarker };
