'use strict';

const path = require('path');
const read = require('./read');
const pinned = require('../generator/pinned');
const { readSettingsFiles } = require('./publishset');
const { toRelativePosix } = require('../util/paths');

/*
 * ADR 0061: where the pinned generator copies the cover picture and section banners into a built
 * site's images/ folder, and from which vault file, so leak/l2-excluded-dir-in-output can judge
 * each copy by its real source. The pin's pure helpers come through the facade; the file I/O, the
 * destinations, the slug rule and the two-file config merge are hand-ported (re-check on every pin
 * move: lib/build.js:1135-1155 (the cover image) and :1624-1692 (the section banners),
 * lib/banners.js:40-65, and the two-file merge in lib/settings/legacy.js:86-139 with
 * lib/config.js:156-161). test/banner-cover-sources.test.js builds a real site and checks the literal
 * destinations, so a pin that moves them fails it.
 */

const isPlainMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// On a moved vault the pin's own reading of the yaml: the cover picture, the banners and the folder
// map as the vault's settings resolved them (the pack's carried copies are gone there).
function readMoved(vaultRoot) {
  const { md, yaml } = readSettingsFiles(vaultRoot);
  const pc = pinned.resolveSiteConfig(vaultRoot, {}, { md, yaml }).publishConfig;
  return { theme: { campaign_image: pc.theme && pc.theme.campaign_image }, banners: pc.banners, folder_map: pc.folder_map };
}

function readPublish(vaultRoot) {
  if (pinned.settingsLayoutOf(vaultRoot) === 'new') return readMoved(vaultRoot);
  const file = path.join(vaultRoot, '_meta', 'vault-config.md');
  if (!read.pathExists(file)) return {};
  const result = read.readFrontmatter(file);
  return result.ok && result.data && result.data.publish ? result.data.publish : {};
}

// lib/settings/legacy.js:86-139 (pick, for a key merged per sub-key: :78 and :121-128). A value that
// is not a map reads as unset (lib/settings/types.js, the map type).
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

// lib/settings/legacy.js:95 (the vault file wins outright; a value that is not a map reads as the
// default {}), then lib/config.js:318-322 (config.folderMap).
function effectiveFolderMap(publish, jsonConfig) {
  const value = publish.folder_map !== undefined ? publish.folder_map : jsonConfig.folderMap;
  return isPlainMap(value) ? value : {};
}

// lib/build.js:1141-1145 and :1626-1642 (resolveVaultAsset): inside the vault (never the root itself) and present.
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
