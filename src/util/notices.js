'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Delivers the executable's own THIRD-PARTY-NOTICES.txt, for `--version`'s status line and
 * the `--notices` flag (bin/scriptorium.js).
 *
 * The file is embedded via package.json's `pkg.assets` (a plain root-relative entry, no
 * glob needed since it is a single file) and read here the same way the pinned generator
 * reads its own bundled assets: `path.join(__dirname, ...)`, which resolves correctly both
 * under plain node (this file's real on-disk location) and inside a pkg snapshot (pkg
 * mirrors the repo's relative directory structure, so the same relative walk lands on the
 * embedded copy -- see node_modules/gm-apprentice-publish/lib/build.js's copyCSS/copyJS for
 * the existing precedent this follows, and test/package-config.test.js's change detector for
 * why that pattern matters to pkg's static asset walk).
 *
 * Before this module existed, `--version` printed a path next to the executable that nothing
 * ever wrote (THIRD-PARTY-NOTICES.txt was not in pkg.assets at all, so it was not even
 * embedded). deliverNotices() is the fix: on a packaged binary it actually writes the file
 * next to the executable before naming that path, and the printed line always describes what
 * really happened, including when the write fails.
 */

const NOTICES_FILENAME = 'THIRD-PARTY-NOTICES.txt';
const REPO_ROOT = path.join(__dirname, '..', '..');
const EMBEDDED_NOTICES_PATH = path.join(REPO_ROOT, NOTICES_FILENAME);

/**
 * Reads the notices text: the repo's own committed file under plain node, or the embedded
 * copy pkg.assets bundled at the same relative path when running as a packaged binary.
 *
 * @returns {string}
 */
function getNoticesText() {
  return fs.readFileSync(EMBEDDED_NOTICES_PATH, 'utf8');
}

/**
 * Decides what `--version` should print about third-party notices, and, for a packaged
 * binary, actually writes the file next to the executable first.
 *
 * Dependency-injected (isPkg, execPath, readNoticesText, writeFileSync) so this is
 * unit-testable without mutating global `process` state or touching the real filesystem.
 *
 * @param {{
 *   isPkg?: boolean,
 *   execPath?: string,
 *   readNoticesText?: () => string,
 *   writeFileSync?: (path: string, data: string) => void,
 * }} [opts]
 * @returns {string} the single line `--version` should print
 */
function deliverNotices({
  isPkg = typeof process.pkg !== 'undefined',
  execPath = process.execPath,
  readNoticesText = getNoticesText,
  writeFileSync = fs.writeFileSync,
} = {}) {
  if (!isPkg) {
    // Running from source: there is no separate "executable" to write next to (execPath is
    // the node binary itself, not something Scriptorium ships), and the committed file is
    // already sitting in the repo. Say so rather than writing into a node install directory.
    return `third-party notices: ${EMBEDDED_NOTICES_PATH} (run from source; run --notices to print them)`;
  }

  const destPath = path.join(path.dirname(execPath), NOTICES_FILENAME);
  try {
    const text = readNoticesText();
    writeFileSync(destPath, text);
    return `third-party notices: ${destPath}`;
  } catch (err) {
    const detail = err && err.code ? err.code : (err && err.message) || String(err);
    return `third-party notices: could not write ${destPath} (${detail}); run with --notices to print them instead`;
  }
}

module.exports = { NOTICES_FILENAME, EMBEDDED_NOTICES_PATH, getNoticesText, deliverNotices };
