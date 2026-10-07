'use strict';

const pinned = require('../generator/pinned');
const { loadPublishConfig, scanForPublish } = require('../vault/publishset');

/*
 * What `init` adds to the generated site config's folderMap so the site is not silently missing
 * pages (issue #103). The generator's scaffold template maps only the standard entity folders.
 * It has no Sessions entry, and it cannot know about any folder this particular vault added. A
 * typed page in an unmapped folder is dropped by the generator without a word, so a fresh `init`
 * followed by `build` published a site with no session pages.
 *
 * Two additions, both read-only against the vault:
 *   1. `Sessions` > `sessions`, always (the sample vault maps it, the generator's sessions index
 *      expects that output folder, and a session folder may be empty today and filled tomorrow).
 *   2. Every folder that holds a typed page and that no entry covers yet, mapped to the slug of
 *      its own path, found with the same scan `check` uses, so the two can never disagree.
 */

/** The output folder for a vault folder: each path segment slugified, as the generator suggests. */
function suggestedSlug(dir) {
  return dir.split('/').map((seg) => pinned.slugify(seg)).join('/');
}

/**
 * @param {string} vaultAbs
 * @param {object} baseConfig the site config as composed from the scaffold template (folderMap, excludeDirs)
 * @returns {Record<string, string>} folderMap entries to add, in a stable order
 */
function deriveFolderMapAdditions(vaultAbs, baseConfig) {
  const folderMap = { ...(baseConfig.folderMap || {}) };
  const additions = {};
  if (pinned.mapFolder('Sessions', folderMap) === null) {
    additions.Sessions = 'sessions';
    folderMap.Sessions = 'sessions';
  }

  const { publishConfig } = loadPublishConfig(vaultAbs, { ...baseConfig, folderMap });
  const scanConfig = pinned.scanConfigFor({ ...baseConfig, folderMap }, publishConfig);
  const { unmappedDirectory } = scanForPublish(vaultAbs, scanConfig);
  const dirs = new Set();
  for (const f of unmappedDirectory) {
    const idx = f.relPath.lastIndexOf('/');
    if (idx > 0) dirs.add(f.relPath.slice(0, idx));
  }
  for (const dir of [...dirs].sort()) {
    if (pinned.mapFolder(dir, { ...folderMap, ...additions }) === null) additions[dir] = suggestedSlug(dir);
  }
  return additions;
}

module.exports = { deriveFolderMapAdditions, suggestedSlug };
