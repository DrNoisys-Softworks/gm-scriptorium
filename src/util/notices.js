'use strict';

const fs = require('fs');
const path = require('path');

/*
 * The executable's own THIRD-PARTY-NOTICES.txt, for `--version`'s status line and the
 * `--notices` flag (bin/scriptorium.js).
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
 * `--version` used to write a copy beside the executable and name it. That line was wrong
 * whenever the write did not happen or the file was later moved or deleted, and writing a file
 * from a version query surprised people (issue #49). It now only points at `--notices`, which
 * always works. NOTICES_FILENAME stays because `update` still clears an old copy that an earlier
 * release left beside the executable (src/update/replace.js).
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
 * The single line `--version` prints about third-party notices. Writes nothing.
 *
 * @param {{ isPkg?: boolean }} [opts]
 * @returns {string}
 */
function noticesLine({ isPkg = typeof process.pkg !== 'undefined' } = {}) {
  if (!isPkg) {
    // Running from source: the committed file is sitting in the repo.
    return `third-party notices: ${EMBEDDED_NOTICES_PATH} (run from source; run --notices to print them)`;
  }
  return 'third-party notices: run gm-scriptorium --notices to print them';
}

module.exports = { NOTICES_FILENAME, EMBEDDED_NOTICES_PATH, getNoticesText, noticesLine };
