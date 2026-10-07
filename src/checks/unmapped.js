'use strict';

const { createFinding } = require('../report/finding');

/**
 * vault/unmapped-directory: a directory has no folderMap entry and is not
 * the vault root, so scanVault silently drops every typed file under it
 * (lib/scanner.js:119-129). Fires today on Adventures/.
 */
function runUnmappedDirectory(ctx) {
  return ctx.publishSet.unmappedDirectory.map((f) =>
    createFinding({
      id: 'vault/unmapped-directory',
      severity: 'warn',
      category: 'frontmatter',
      campaign: ctx.campaign,
      path: f.relPath,
      message: `${f.relPath}: directory has no folderMap entry; the generator silently drops this file`,
    }),
  );
}

module.exports = { runUnmappedDirectory };
