'use strict';

const fs = require('fs');
const path = require('path');
const read = require('../vault/read');
const cliBuild = require('../cli/build');
const { THEMES } = require('../build/themes');
const freshness = require('./freshness');
const pageroles = require('./pageroles');
const { ScriptoriumError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');

/*
 * V1e-7 (ADR 0039, SD-61, amended 2026-10-01 by Amendment A: the candidate seam of V1e-7's own
 * is withdrawn in favour of reusing V1e-9's read overlay, src/vault/read.js's
 * withCandidateFile). Builds, contains, caps, removes and reports on private copies of the
 * site, one per registry theme plus the Vocabulary candidate, built through the EXACT SAME
 * pipeline a real `build` uses (src/cli/build.js's runBuildForContext), from an in-memory
 * pack.toml that is never written to disk.
 *
 * How the candidate reaches the build: `pack.toml` is read, in a build and its own pre-check
 * alike, only through src/build/packtoml.js's loadPackToml -> read.readText (and
 * read.pathExists for its own existence check, which the overlay does NOT answer -- a campaign
 * with no on-disk pack.toml can never get a candidate; see themeVariant's upfront guard in
 * src/admin/handlers/variants.js). Keying the overlay on the exact path loadPackToml reads
 * means neither this file nor anything it calls has to carry a second "candidate" parameter
 * through src/cli/check.js or src/cli/build.js: the overlay is the one and only candidate
 * mechanism (docs/decisions/0041-check-an-edited-copy.md, V1e-9).
 *
 * Why `takeStamp`/the record/`enforceDiskCap` all run OUTSIDE `withCandidateFile`'s `fn`:
 * `freshness.readTrackedShas` reads pack.toml's sha256 through `packfiles.readPackFile`, which
 * is itself routed through `read.readBytes` -- running it inside the overlay would hash the
 * CANDIDATE's bytes instead of the real on-disk file, corrupting the "saved since" signal for
 * every other preview consumer. `pageroles.resolvePageRoles` and `enforceDiskCap`/`treeBytes`
 * read the BUILT TREE with plain fs, never pack.toml, so where they run doesn't matter for
 * correctness, but keeping them outside the overlay too keeps "the overlay is active" synonymous
 * with "the build/pre-check call that must observe the candidate is in flight", which is the
 * easiest invariant to audit.
 */

const VARIANT_PREFIX = '/:variant/';
const VOCAB_VARIANT_ID = 'vocab';
const VARIANT_IDS = Object.freeze([...Object.keys(THEMES), VOCAB_VARIANT_ID]);
const VARIANT_TOTAL_CAP_BYTES = 1073741824; // 1 GiB. Read only as module.exports.VARIANT_TOTAL_CAP_BYTES.

/** @param {unknown} id @returns {boolean} an exact member of VARIANT_IDS, never a prefix/substring match */
function isVariantId(id) {
  return typeof id === 'string' && VARIANT_IDS.includes(id);
}

/**
 * The static.js:71-73 rule, plus a refusal when `rel === ''` (base === target). Callers pass
 * REAL (realpath'd) paths -- this function does no resolution of its own.
 *
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
function isStrictlyInside(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {object} ctx an admin context
 * @param {string} id a VARIANT_IDS member
 * @returns {string} ctx.previewRoot/variants/<id>/site
 * @throws {ScriptoriumError} an invalid id, or ctx.previewRoot not yet set
 */
function variantDirFor(ctx, id) {
  if (!isVariantId(id)) {
    throw new ScriptoriumError(`variantDirFor: "${id}" is not a known variant id`);
  }
  if (!ctx.previewRoot) {
    throw new ScriptoriumError('variantDirFor: ctx.previewRoot is not set yet');
  }
  return path.join(ctx.previewRoot, 'variants', id, 'site');
}

/**
 * Creates `<root>/variants` and `<root>/variants/<id>` (mode 0700) if absent, and refuses
 * (fail-closed) unless both are, right now, plain real directories strictly inside the preview
 * root.
 *
 * @param {object} ctx
 * @param {string} id
 * @throws {ScriptoriumError}
 */
function ensureVariantParent(ctx, id) {
  const root = ctx.previewRoot;
  const variantsDir = path.join(root, 'variants');
  const idDir = path.join(variantsDir, id);

  for (const dir of [variantsDir, idDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      throw new ScriptoriumError(`ensureVariantParent: could not stat ${dir}: ${err.message}`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ScriptoriumError(`ensureVariantParent: ${dir} must be a plain directory, not a symlink`);
    }
  }

  const realRoot = fs.realpathSync(root);
  const realIdDir = fs.realpathSync(idDir);
  if (!isStrictlyInside(realRoot, realIdDir)) {
    throw new ScriptoriumError(`ensureVariantParent: ${idDir} escapes the preview root`);
  }
}

/**
 * A readdirSync({withFileTypes:true}) walk that recurses only into isDirectory() entries and
 * sums lstatSync(file).size for isFile() entries (symlinks are neither, so they contribute
 * nothing and are never followed). Errors (a missing directory, a mid-walk ENOENT/EACCES) count
 * as 0 rather than throwing: this is a best-effort disk measurement, not a correctness check.
 *
 * @param {string} dir
 * @returns {number}
 */
function treeBytes(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += treeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.lstatSync(full).size;
      } catch {
        // counts as 0
      }
    }
  }
  return total;
}

/**
 * Removes `<root>/variants/<id>` best-effort, and ALWAYS clears its record from `ctx.variants`
 * (even when the directory removal itself is skipped or fails) -- a stale record pointing at a
 * tree that may or may not still exist is worse than no record at all.
 *
 * Containment, in order: `id` must be an exact VARIANT_IDS member; both `variants/` and the
 * target are lstat'd (never realpath'd first) and refused if either is a symlink or isn't a
 * plain directory; only then is `isStrictlyInside` checked on their REAL paths; only then does
 * `fs.rmSync` run, inside its own try/catch (the run.js:182-186 swallowed-cleanup pattern) so a
 * removal failure (a locked file on Windows, EBUSY) never escapes and never changes the caller's
 * HTTP response.
 *
 * @param {object} ctx
 * @param {string} id
 */
function removeVariant(ctx, id) {
  if (!isVariantId(id)) return;
  const root = ctx.previewRoot;
  if (root) {
    const variantsDir = path.join(root, 'variants');
    const target = path.join(variantsDir, id);
    try {
      const variantsStat = fs.lstatSync(variantsDir);
      const targetStat = fs.lstatSync(target);
      const safe =
        variantsStat.isDirectory() &&
        !variantsStat.isSymbolicLink() &&
        targetStat.isDirectory() &&
        !targetStat.isSymbolicLink();
      if (safe && isStrictlyInside(fs.realpathSync(root), fs.realpathSync(target))) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch {
          // best-effort only (run.js:182-186's pattern): a removal failure must never change
          // the response or the exit code a user sees.
        }
      }
    } catch {
      // lstat failed (e.g. ENOENT): nothing to remove.
    }
  }
  if (ctx.variants) ctx.variants.delete(id);
}

/**
 * @param {object} ctx
 * @param {string} id
 * @returns {string|null} the built directory iff ctx.variants has `id`, ctx.previewRoot is set,
 *   the directory exists and is strictly inside the preview root by real path. Never throws.
 */
function builtDirFor(ctx, id) {
  try {
    if (!ctx.previewRoot || !ctx.variants || !ctx.variants.has(id)) return null;
    const dir = variantDirFor(ctx, id);
    if (!fs.existsSync(dir)) return null;
    const realRoot = fs.realpathSync(ctx.previewRoot);
    const realDir = fs.realpathSync(dir);
    if (!isStrictlyInside(realRoot, realDir)) return null;
    return dir;
  } catch {
    return null;
  }
}

/**
 * SD-65: at most VARIANT_IDS.length trees, 1 GiB total, oldest (by builtAtMs) evicted first.
 * Sizes come from `module.exports.treeBytes` (through the module object, so a test can inject
 * fixed sizes without writing gigabytes of fixtures).
 *
 * @param {object} ctx
 * @param {string} justBuiltId the id that was just successfully built (never itself evicted
 *   except by the "too large on its own" branch)
 * @returns {{ evicted: string[], tooLarge: boolean }}
 */
function enforceDiskCap(ctx, justBuiltId) {
  const records = ctx.variants || new Map();
  const cap = module.exports.VARIANT_TOTAL_CAP_BYTES;
  const sizes = {};
  for (const id of records.keys()) {
    const dir = variantDirFor(ctx, id);
    if (fs.existsSync(dir)) sizes[id] = module.exports.treeBytes(dir);
  }

  if (sizes[justBuiltId] !== undefined && sizes[justBuiltId] > cap) {
    removeVariant(ctx, justBuiltId);
    return { evicted: [], tooLarge: true };
  }

  function total() {
    return Object.keys(sizes).reduce((sum, id) => sum + sizes[id], 0);
  }

  const evicted = [];
  while (total() > cap) {
    let victim = null;
    for (const id of VARIANT_IDS) {
      if (id === justBuiltId) continue;
      if (sizes[id] === undefined || !records.has(id)) continue;
      if (victim === null || records.get(id).builtAtMs < records.get(victim).builtAtMs) {
        victim = id;
      }
    }
    if (victim === null) break; // nothing left to evict -- defensive, should be unreachable
    removeVariant(ctx, victim);
    delete sizes[victim];
    evicted.push(victim);
  }

  return { evicted, tooLarge: false };
}

/**
 * Builds one variant through the exact same pipeline `build` uses, from an in-memory candidate
 * pack.toml that is NEVER written to disk. One copy per call; the caller (handlers/variants.js)
 * holds `runExclusive(ctx, 'build', ...)` around this.
 *
 * @param {object} ctx an admin context, with ctx.previewRoot already set (preview.ensurePreviewRoot)
 * @param {string} id a VARIANT_IDS member
 * @param {string} packTomlText the exact text a save would write (the save path's own dry run)
 * @returns {{ result: object, evicted: string[], tooLarge: boolean, candidateReads: number }}
 * @throws {ScriptoriumError} the build never actually read the candidate (fail closed): the copy
 *   is removed and no record is kept
 */
function buildVariant(ctx, id, packTomlText) {
  const nowMs = Date.now();
  // OUTSIDE the overlay: reads the on-disk pack.toml/vault.config.json/vault-config.md shas, not
  // the candidate's.
  const stamp = freshness.takeStamp(ctx, nowMs);

  ensureVariantParent(ctx, id);
  const dir = variantDirFor(ctx, id);
  const tomlPath = path.join(ctx.packDir, 'pack.toml'); // exactly loadPackToml's path (packtoml.js)

  const { value: result, hits } = read.withCandidateFile(tomlPath, Buffer.from(packTomlText, 'utf8'), () =>
    cliBuild.runBuildForContext({ ...ctx.ctxInfo, output: dir }, {}),
  );

  if (hits < 1) {
    // The tree may have been built from the real on-disk file instead of the candidate: fail
    // closed rather than ever serve a copy that might not reflect the candidate.
    removeVariant(ctx, id);
    throw new ScriptoriumError('preview copy: the build did not read the candidate pack.toml, so the copy was removed');
  }

  if (result.exitCode !== EXIT_CODES.OK) {
    // The previous record and tree are untouched: the atomic swap inside the build keeps the
    // old tree on a refusal/failure.
    return { result, evicted: [], tooLarge: false, candidateReads: hits };
  }

  let pages;
  try {
    pages = pageroles.resolvePageRoles(dir);
  } catch {
    pages = [];
  }
  ctx.variants = ctx.variants || new Map();
  ctx.variants.set(id, { stamp, pages, builtAtMs: nowMs });

  return { result, ...enforceDiskCap(ctx, id), candidateReads: hits };
}

/**
 * @param {object} ctx
 * @param {string} id
 * @param {object} shasNow freshness.readTrackedShas(ctx), read once by the caller
 * @returns {object} the SD-64 item shape
 */
function variantItem(ctx, id, shasNow) {
  const theme = id === VOCAB_VARIANT_ID ? null : id;
  const dir = builtDirFor(ctx, id);
  if (dir === null) {
    return { id, theme, built: false, builtAt: null, stale: null, savedSince: [], panelSavesSince: 0, pages: [] };
  }
  const record = ctx.variants.get(id);
  const cmp = freshness.compareStamp(record.stamp, shasNow, ctx.panelSaves || 0);
  return {
    id,
    theme,
    built: true,
    builtAt: record.stamp.builtAt,
    stale: cmp.stale,
    savedSince: cmp.savedSince,
    panelSavesSince: cmp.panelSavesSince,
    pages: record.pages,
  };
}

/** @param {object} ctx @returns {{ items: object[] }} every VARIANT_IDS member, in order. Never throws. */
function variantsInfo(ctx) {
  const shasNow = freshness.readTrackedShas(ctx);
  return { items: VARIANT_IDS.map((id) => variantItem(ctx, id, shasNow)) };
}

module.exports = {
  VARIANT_PREFIX,
  VOCAB_VARIANT_ID,
  VARIANT_IDS,
  VARIANT_TOTAL_CAP_BYTES,
  isVariantId,
  isStrictlyInside,
  variantDirFor,
  ensureVariantParent,
  treeBytes,
  removeVariant,
  builtDirFor,
  enforceDiskCap,
  buildVariant,
  variantItem,
  variantsInfo,
};
