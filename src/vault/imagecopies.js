'use strict';

const path = require('path');
const read = require('./read');
const pinned = require('../generator/pinned');
const { toRelativePosix } = require('../util/paths');

/*
 * ADR 0061: where the pinned generator copies the cover picture and section banners into a built
 * site's images/ folder, and from which vault file, so leak/l2-excluded-dir-in-output can judge
 * each copy by its real source. The pin's pure helpers come through the facade; the file I/O, the
 * destinations, the slug rule and the two-file config merge are hand-ported (re-check on every pin
 * move: lib/build.js:887-907 and :1112-1175, lib/banners.js:40-60, lib/config.js:246-300, :405,
 * :447, :506-514). test/banner-cover-sources.test.js builds a real site and checks the literal
 * destinations, so a pin that moves them fails it.
 */

const isPlainMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readPublish(vaultRoot) {
  const file = path.join(vaultRoot, '_meta', 'vault-config.md');
  if (!read.pathExists(file)) return {};
  const result = read.readFrontmatter(file);
  return result.ok && result.data && result.data.publish ? result.data.publish : {};
}

// lib/config.js:246-300 (pick, for a MERGED_MAPS key) and :447 (asMap).
function effectiveBanners(publish, jsonConfig) {
  const fromVault = publish.banners;
  const fromSite = jsonConfig.banners;
  let value = fromVault !== undefined ? fromVault : fromSite;
  if (fromVault !== undefined && fromSite !== undefined && isPlainMap(fromSite)) {
    const base = isPlainMap(fromVault) ? fromVault : {};
    const extra = Object.keys(fromSite).filter((k) => !(k in base));
    if (extra.length) value = { ...base, ...Object.fromEntries(extra.map((k) => [k, fromSite[k]])) };
  }
  return isPlainMap(value) ? { ...value } : {};
}

// lib/config.js:258 and :405 (the vault file wins outright, then asMap), :509-511 (config.folderMap).
function effectiveFolderMap(publish, jsonConfig) {
  const value = publish.folder_map !== undefined ? publish.folder_map : jsonConfig.folderMap;
  return isPlainMap(value) ? value : {};
}

// lib/build.js:893-897 and :1112-1124: inside the vault (never the root itself) and present.
function vaultFile(vaultRoot, value) {
  const full = path.resolve(vaultRoot, String(value));
  const rel = path.relative(vaultRoot, full);
  if (rel === '' || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return null;
  return read.pathExists(full) ? full : null;
}

// lib/banners.js:40-47, ported so the existence test goes through src/vault/read.js.
function findConventionBanner(vaultRoot, folder) {
  if (!folder) return null;
  for (const ext of pinned.BANNER_EXTS) {
    const rel = `${folder}/_banner.${ext}`;
    if (read.pathExists(path.join(vaultRoot, rel))) return rel;
  }
  return null;
}

/**
 * @param {string} vaultPath
 * @param {object} jsonConfig parsed vault.config.json
 * @returns {Map<string, {outputPath: string, sourceAbs: string, sourceRel: string,
 *   kind: 'cover'|'banner'|'banner-link'|'found-banner', dir: string|null}>} keyed by outputPath, in
 *   the generator's write order; a later copy to the same outputPath replaces the earlier one.
 */
function generatorImageCopies(vaultPath, jsonConfig) {
  const vaultRoot = path.resolve(vaultPath);
  const publish = readPublish(vaultRoot);
  const copies = new Map();
  const add = (outputPath, sourceAbs, kind, dir) =>
    copies.set(outputPath, { outputPath, sourceAbs, sourceRel: toRelativePosix(vaultRoot, sourceAbs), kind, dir });

  const imgVal = publish.theme ? publish.theme.campaign_image : null;
  if (typeof imgVal === 'string' && imgVal !== '' && !/^https?:\/\//.test(imgVal)) {
    const full = vaultFile(vaultRoot, imgVal);
    if (full) add(`images/${path.basename(imgVal)}`, full, 'cover', null);
  }

  const banners = effectiveBanners(publish, jsonConfig);
  const folderMap = effectiveFolderMap(publish, jsonConfig);
  for (const dir of Object.keys(pinned.DIR_LABELS)) {
    const configured = pinned.normalizeEntry(banners[dir]);
    let entry = configured;
    if (!entry) {
      const found = findConventionBanner(vaultRoot, pinned.sourceFolderFor(dir, folderMap));
      entry = found ? { image: found, link: null } : null;
    }
    if (!entry) continue;
    const imageFull = vaultFile(vaultRoot, entry.image);
    if (!imageFull) continue;
    if (pinned.isSvg(imageFull) && !entry.link) continue;
    const slug = String(dir).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    if (entry.link) {
      const linkFull = vaultFile(vaultRoot, entry.link);
      if (linkFull) add(`images/banners/${slug}/${path.basename(linkFull)}`, linkFull, 'banner-link', dir);
    }
    add(`images/banners/${slug}/${path.basename(imageFull)}`, imageFull, configured ? 'banner' : 'found-banner', dir);
  }
  return copies;
}

module.exports = { generatorImageCopies };
