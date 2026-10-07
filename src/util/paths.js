'use strict';

const path = require('path');

/**
 * Convert an absolute path under `root` into a root-relative path using
 * POSIX ('/') separators, regardless of host platform. Finding.path and
 * Finding.outputPath are documented as vault-relative / output-relative
 * POSIX paths (Engineering Brief section 9) so that a finding produced on
 * Windows and one produced on Linux against the same vault are byte-
 * identical, which the determinism requirement in section 9 depends on.
 */
function toRelativePosix(root, absolutePath) {
  const rel = path.relative(root, absolutePath);
  return rel.split(path.sep).join('/');
}

module.exports = { toRelativePosix };
