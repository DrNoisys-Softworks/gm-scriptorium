'use strict';

const path = require('path');
const read = require('./read');
const { classifyFrontmatterFence, renderTag, FENCE_HEAD_BYTES } = require('./fence');
const { toRelativePosix } = require('../util/paths');

/*
 * ADR 0034 / FR-FM-04. The guard's own walk, independent of and wider than the census walk
 * (src/vault/index.js), the check's own resolution walk, and every walk publishset.js mirrors:
 * every module.exports.read call below is a proven SUPERSET of the seven generator parse sites
 * this pin's build() can reach (see the ADR's walk-set table, sourced from lib/scanner.js:98-115,
 * lib/scanner.js:343-371, lib/scanner.js:379-413, lib/config.js:355-364, lib/manifest.js:92-96,
 * lib/manifest.js:33-34, and lib/build.js:1309-1310's own repeat of the first three via
 * manifest-cli.js). All of it deliberately: node_modules, every excludeDirs entry,
 * _meta/_Templates/_inbox/_publish, and dotfiles are all included, because
 * scanAllNotes (run by every build via pairHubs, lib/build.js:483) ignores excludeDirs and reads any
 * `.md` (any case) carrying an aliases:/gm_aliases: line or a session type: line, and
 * scanVaultReport itself descends into node_modules and reads dotfiles and file symlinks.
 *
 * Only directories whose OWN name starts with "." are skipped (Obsidian's .obsidian, git's .git,
 * an editor's dotfile-named cache dir); nothing else is ever skipped -- there is deliberately no
 * excludeDirs parameter here (Risk area 3, "guard-refused superset-of-read-refused" invariant:
 * threading excludeDirs through this walk would create vault locations a refused build could
 * still reach through scanAllNotes but the guard would never even see).
 *
 * Every read.* call below goes through the module object (`read.listDir`, not a destructured
 * `listDir`), so a test can inject a VaultReadError at any one of them (SD-5's own requirement).
 */

/**
 * Walks the whole vault (every subdirectory except a dot-named one) looking for `.md` files (any
 * case) whose opening frontmatter fence declares a non-YAML language, using a bounded
 * (FENCE_HEAD_BYTES) read so this never allocates a whole file just to classify its first line.
 *
 * @param {string} vaultPath absolute
 * @returns {Array<{ relPath: string, tag: string, reason: 'language'|'unterminated' }>} sorted by
 *   relPath ('<' order, the same comparator walkVault uses). `tag` is already rendered
 *   (src/vault/fence.js's renderTag) -- safe for a message, finding, or envelope.
 * @throws {VaultReadError} on any underlying read failure; nothing is ever returned partial
 */
function scanFrontmatterFences(vaultPath) {
  const results = [];

  function walk(dir) {
    const entries = read.listDir(dir);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory) {
        if (entry.name.startsWith('.')) continue;
        walk(abs);
        continue;
      }

      if (!entry.name.toLowerCase().endsWith('.md')) continue;

      let isFile = entry.isFile;
      if (entry.isSymbolicLink) {
        const stat = read.statOrNull(abs);
        if (stat === null) continue; // dangling symlink: skipped
        isFile = stat.isFile();
      }
      if (!isFile) continue;

      const { text, truncated } = read.readHead(abs, FENCE_HEAD_BYTES);
      const fence = classifyFrontmatterFence(text, { truncated });
      if (fence.status !== 'refused') continue;

      results.push({
        relPath: toRelativePosix(vaultPath, abs),
        tag: renderTag(fence.tag),
        reason: fence.reason,
      });
    }
  }

  walk(vaultPath);
  results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return results;
}

module.exports = { scanFrontmatterFences };
