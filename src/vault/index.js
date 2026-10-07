'use strict';

const path = require('path');
const read = require('./read');

/*
 * The name/alias/image resolution index used by the link checks
 * (src/checks/link.js) and the leak checks. This is deliberately a
 * broader walk than publishset.js's scanForPublish(): it is "the full
 * vault index" (Engineering Brief section 3.1 item 4 / section 10 "the
 * seed checker"), not the published subset, so a link to an unpublished
 * (but real) entity resolves here even though it would not appear in
 * built output; whether that is itself a finding is link/l3's job, not
 * this module's.
 *
 * To reproduce the 5109/2 baseline (section 10, "Link-check parity") the
 * walk must skip exactly: _Templates, _publish, .obsidian, _inbox,
 * node_modules. Image basenames under attachmentsDir are indexed
 * alongside markdown filename stems, because ![[x.webp]] embeds count as
 * links in that baseline.
 */

const CENSUS_SKIP_DIRS = new Set([
  '_Templates',
  '_publish',
  '.obsidian',
  '_inbox',
  'node_modules',
  '.git',
]);

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;

function censusWalk(vaultPath) {
  return read.walkMarkdownFiles(vaultPath, { skipDirs: CENSUS_SKIP_DIRS });
}

/** Mirrors scanAttachments()'s walk (scanner.js), for basename lookup only. */
function scanAttachmentBasenames(vaultPath, attachmentsDir) {
  const root = path.join(vaultPath, attachmentsDir || '_attachments');
  const basenames = new Map(); // basename -> relPath under attachmentsDir (last wins)
  if (!read.pathExists(root)) return basenames;

  (function walk(dir) {
    for (const entry of read.listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        walk(full);
        continue;
      }
      if (IMAGE_EXT_RE.test(entry.name)) {
        basenames.set(entry.name, path.relative(root, full).split(path.sep).join('/'));
      }
    }
  })(root);

  return basenames;
}

/**
 * @param {string} vaultPath
 * @param {{ attachmentsDir?: string }} [jsonConfig]
 * @returns {{
 *   files: object[],
 *   resolves: (target: string) => boolean,
 *   ambiguousNames: { name: string, sources: { relPath: string, kind: string }[] }[],
 * }}
 */
function buildResolutionIndex(vaultPath, jsonConfig = {}) {
  const files = censusWalk(vaultPath);
  const claims = new Map();

  function addClaim(name, relPath, kind) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!claims.has(key)) claims.set(key, []);
    const list = claims.get(key);
    if (!list.some((c) => c.relPath === relPath)) list.push({ relPath, kind });
  }

  for (const f of files) {
    if (!f.ok) continue; // a file that fails to parse contributes no name; frontmatter/parse-error reports it
    const title = path.basename(f.relPath, '.md');
    addClaim(title, f.relPath, 'title');
    const aliases = Array.isArray(f.data.aliases) ? f.data.aliases : [];
    for (const alias of aliases) addClaim(alias, f.relPath, 'alias');
  }

  const imageBasenames = scanAttachmentBasenames(vaultPath, jsonConfig.attachmentsDir);
  for (const basename of imageBasenames.keys()) {
    addClaim(basename, `<attachments>/${basename}`, 'image');
  }

  const ambiguousNames = [];
  for (const [key, list] of claims) {
    const distinctSources = new Set(list.map((c) => c.relPath));
    if (distinctSources.size > 1) {
      ambiguousNames.push({ name: key, sources: list });
    }
  }
  ambiguousNames.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  function resolves(target) {
    const trimmed = String(target || '').trim();
    if (trimmed === '') return true; // "treat empty targets as resolved" (section 10)
    return claims.has(trimmed.toLowerCase());
  }

  return { files, claims, ambiguousNames, resolves };
}

module.exports = { censusWalk, scanAttachmentBasenames, buildResolutionIndex, CENSUS_SKIP_DIRS };
