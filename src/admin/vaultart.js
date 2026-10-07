'use strict';

const path = require('path');
const read = require('../vault/read');
const check = require('../cli/check');
const publishset = require('../vault/publishset');
const exclusions = require('../vault/exclusions');
const themeassets = require('../build/themeassets');
const packimages = require('./packimages');
const paths = require('../util/paths');

/*
 * V1e-5 (ADR 0038, SD-50 to SD-52). The two new read-only routes' chokepoint: listing the GM's
 * own vault attachments folder and serving a byte from it, both contained strictly inside that
 * one folder. Every require above is called through its module object (never destructured), so
 * a test can patch a single function (e.g. read.realPath) without touching the others -- the
 * same convention src/admin/handlers/images.js's own comment explains for packwrite.
 *
 * The house rule this mirrors is packimages.js's own: membership first (a request must name an
 * exact entry of the LAST listing, cached on ctx.vaultArt), then a real-path re-check at request
 * time -- never a path-taking route that is merely checked for safety afterwards (ADR 0022 §4;
 * ADR 0038 §6 records that rejection).
 */

const VAULT_ART_LIMIT = 2000;
const VAULT_ART_VISIT_LIMIT = 20000;
const DEFAULT_ATTACHMENTS_DIR = '_attachments';

const REASONS = Object.freeze({
  R_CONFIG: () => "vault.config.json couldn't be read, so the panel can't find your vault's art folder.",
  R_NOT_TEXT: () => "attachmentsDir in vault.config.json isn't text, so the panel can't find your vault's art folder.",
  R_OUTSIDE: (folder) => `Your vault's art folder (${folder}) isn't inside the vault, so the panel won't list it.`,
  R_NOT_FOLDER: (folder) => `Your vault's art folder (${folder}) isn't a folder.`,
  R_READ: (folder) => `The panel couldn't read your vault's art folder (${folder}).`,
});

/** The `missing`/`unavailable` envelope: always `entries: []`, `truncated: false`. */
function emptyResult(status, folder, reason) {
  return { status, folder, reason, truncated: false, limit: VAULT_ART_LIMIT, entries: [] };
}

/** Sets ctx.vaultArt to the "nothing listed" shape and returns an `unavailable` envelope. */
function unavailable(ctx, reasonKey, folder) {
  ctx.vaultArt = { folderAbs: null, rels: new Set() };
  return emptyResult('unavailable', folder, REASONS[reasonKey](folder));
}

/** Sets ctx.vaultArt to the "nothing listed" shape and returns a `missing` envelope. */
function missingResult(ctx, folder) {
  ctx.vaultArt = { folderAbs: null, rels: new Set() };
  return emptyResult('missing', folder, null);
}

/**
 * SD-51: lists the image files under `<vault>/<attachmentsDir or _attachments>`. Never throws;
 * every failure mode is data, not an exception. Sets `ctx.vaultArt` as a side effect, so
 * `readVaultArt` below always re-checks against the LAST listing this function produced.
 *
 * @param {object} ctx an admin context (src/admin/context.js); gains `vaultArt` dynamically,
 *   the same way `ctx.previewRoot` does (src/admin/context.js's own comment)
 * @returns {{ status: 'listed'|'missing'|'unavailable', folder: string|null, reason: string|null,
 *   truncated: boolean, limit: number, entries: { rel: string, name: string, usable: boolean,
 *   excludedBy: string|null }[] }}
 */
function listVaultArt(ctx) {
  // 1. jsonConfig.
  let jsonConfig;
  try {
    jsonConfig =
      ctx.siteSource === 'site_config' ? check.loadSiteConfig(ctx.siteConfigPath) : check.loadPackConfig(ctx.siteConfigPath, ctx.campaign);
  } catch {
    return unavailable(ctx, 'R_CONFIG', null);
  }

  // 2. The folder setting.
  let v = jsonConfig.attachmentsDir;
  if (v === undefined || v === null || v === '') {
    v = DEFAULT_ATTACHMENTS_DIR;
  } else if (typeof v !== 'string') {
    return unavailable(ctx, 'R_NOT_TEXT', null);
  }
  const folderAbs = path.join(ctx.vaultPath, v);
  const folder = paths.toRelativePosix(ctx.vaultPath, folderAbs);

  // 3. Missing folder.
  if (!read.pathExists(folderAbs)) return missingResult(ctx, folder);

  // 4-7: the root rule, the folder check, the exclusion union and the walk. Any throw from here
  // on is R_READ; the specific reasons below (R_OUTSIDE, R_NOT_FOLDER) are explicit returns
  // inside this same try, never routed through the catch-all.
  try {
    const realVault = read.realPath(ctx.vaultPath);
    const realRoot = read.realPath(folderAbs);

    // 4. Root rule (strict, both directions).
    if (!themeassets.isInsideReal(realVault, realRoot)) return unavailable(ctx, 'R_OUTSIDE', folder);

    // 5. Not a folder.
    const rootStat = read.statOrNull(realRoot);
    if (!rootStat || !rootStat.isDirectory()) return unavailable(ctx, 'R_NOT_FOLDER', folder);

    // 6. The exclusion union.
    const { publishConfig } = publishset.loadPublishConfig(ctx.vaultPath, jsonConfig);
    const union = exclusions.excludedDirUnion(jsonConfig, publishConfig);
    const foldCase = exclusions.platformFoldsCase();

    // 7. The walk, depth-first in read.listDir order.
    const entries = [];
    let truncated = false;
    let visited = 0;

    function walk(dirAbs, relDir, realDir) {
      const dirEntries = read.listDir(dirAbs);
      for (const entry of dirEntries) {
        if (truncated) return;

        visited++;
        if (visited > VAULT_ART_VISIT_LIMIT) {
          truncated = true;
          return;
        }

        if (entry.isSymbolicLink) continue; // never followed, never listed

        if (entry.isDirectory) {
          if (entry.name.charAt(0) === '.') continue; // dot-folders never descended
          const childAbs = path.join(dirAbs, entry.name);
          const childReal = read.realPath(childAbs);
          if (!themeassets.isInsideReal(realRoot, childReal)) continue; // the per-folder containment check
          walk(childAbs, `${relDir}/${entry.name}`, childReal);
          continue;
        }

        if (!entry.isFile || !themeassets.IMAGE_EXT_RE.test(entry.name)) continue; // no folder or non-image names ever listed

        if (entries.length >= VAULT_ART_LIMIT) {
          truncated = true;
          return;
        }

        const rel = `${relDir}/${entry.name}`;
        const relReal = paths.toRelativePosix(realVault, path.join(realDir, entry.name));
        const excludedBy =
          exclusions.excludedDirHit(rel, union, { foldCase }) ||
          exclusions.excludedSegmentHit(rel, union, { foldCase }) ||
          exclusions.excludedDirHit(relReal, union, { foldCase }) ||
          exclusions.excludedSegmentHit(relReal, union, { foldCase }) ||
          null;
        entries.push({ rel, name: entry.name, usable: excludedBy === null, excludedBy });
      }
    }
    walk(folderAbs, folder, realRoot);

    ctx.vaultArt = { folderAbs, rels: new Set(entries.map((e) => e.rel)) };
    return { status: 'listed', folder, reason: null, truncated, limit: VAULT_ART_LIMIT, entries };
  } catch {
    return unavailable(ctx, 'R_READ', folder);
  }
}

/**
 * SD-52: the bytes for one already-listed vault-art entry. Never throws; every refusal is a
 * plain `null`.
 *
 * @param {object} ctx
 * @param {unknown} name must be an exact member of the LAST listing's `rels` (ctx.vaultArt);
 *   `listVaultArt(ctx)` runs first if nothing has listed yet
 * @returns {{ contentType: string, bytes: Buffer } | null}
 */
function readVaultArt(ctx, name) {
  if (typeof name !== 'string') return null;

  if (ctx.vaultArt === undefined) listVaultArt(ctx);
  if (!ctx.vaultArt.rels.has(name)) return null;

  // Re-resolve now: the root folder itself may have been swapped (e.g. for a link out) since
  // the listing that put `name` in ctx.vaultArt.rels.
  let realVault;
  let realRoot;
  try {
    realVault = read.realPath(ctx.vaultPath);
    realRoot = read.realPath(ctx.vaultArt.folderAbs);
  } catch {
    return null;
  }
  if (!themeassets.isInsideReal(realVault, realRoot)) return null;

  // The listed file itself may have been swapped for a link pointing outside the folder.
  let realFile;
  try {
    realFile = read.realPath(path.join(ctx.vaultPath, ...name.split('/')));
  } catch {
    return null;
  }
  if (!themeassets.isInsideReal(realRoot, realFile)) return null;

  // The content type comes from the REAL extension, never the requested name.
  const ext = path.extname(realFile).toLowerCase();
  const contentType = packimages.IMAGE_CONTENT_TYPES[ext];
  if (!contentType) return null;

  const st = read.statOrNull(realFile);
  if (!st || !st.isFile() || st.size > themeassets.MAX_IMAGE_BYTES) return null;

  let bytes;
  try {
    bytes = read.readBytes(realFile);
  } catch {
    return null;
  }
  if (bytes.length > themeassets.MAX_IMAGE_BYTES) return null;

  return { contentType, bytes };
}

module.exports = {
  VAULT_ART_LIMIT,
  VAULT_ART_VISIT_LIMIT,
  DEFAULT_ATTACHMENTS_DIR,
  listVaultArt,
  readVaultArt,
};
