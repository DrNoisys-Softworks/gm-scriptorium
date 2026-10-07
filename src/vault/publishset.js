'use strict';

const path = require('path');
const read = require('./read');
const pinned = require('../generator/pinned');

/**
 * Track D3, Structural decision 8: the frontmatter offset a body/story
 * line number needs to point at the real source file, computed once per
 * file here (never re-derived by a check). `raw` is gray-matter's full
 * file text, `content` is its post-frontmatter body — a literal suffix of
 * `raw` (gray-matter/index.js:113-123, minus at most one leading `\r` and
 * one `\n`). The offset is the count of `\n` in the prefix gray-matter
 * consumed, so `bodyLineOffset + n` is file line `n` of `content` in the
 * real file; guarded by `raw.endsWith(content)` (Risk areas), falling
 * back to 0 rather than guessing when that does not hold.
 */
function computeLineOffset(raw, content) {
  if (typeof raw !== 'string' || typeof content !== 'string' || !raw.endsWith(content)) return 0;
  const prefix = raw.slice(0, raw.length - content.length);
  let count = 0;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === '\n') count++;
  }
  return count;
}

/*
 * Derives "what would this vault publish" from source, the way the pinned
 * generator's scanVault() + config.js + manifest.js + build.js's verdict
 * loop do, so the leak checks (src/checks/leak/*) never have to read built
 * output to know it. This is a re-port against the pin
 * (docs/decisions/0005-generator-pin.md), not a hand-mirror of a fixed
 * version: the pin's own PURE functions (decidePage, publishesPage,
 * slugify, mapFolder, vaultRelPath, canonicalNfc, parseManifest,
 * PUBLISH_DEFAULTS) are required unmodified through src/generator/pinned.js
 * and called directly; only the FILE I/O around them is ported here,
 * because the pin's own I/O entry points (loadPublishConfig, loadManifest,
 * scanVaultReport) bypass src/vault/read.js's read-only, abort-on-EIO
 * chokepoint and write warnings straight to stderr during `check`
 * (Track DEP-b, Structural decision 1).
 *
 * This is deliberately a SEPARATE traversal from src/vault/read.js's
 * walkVault(): the generator's scanVault() skips directories by an exact
 * vault-relative PATH-PREFIX match against vault.config.json's
 * `excludeDirs`, plus any directory starting with "." generically (not
 * just .git/.obsidian/node_modules). That is a different, narrower
 * inclusion policy than the one census/link checks need (which walk nearly
 * everything, see src/checks/census.js and src/checks/link.js), so it is
 * its own function here rather than a mode of walkVault(). Every actual
 * file read still routes through src/vault/read.js.
 */

// ---------------------------------------------------------------------------
// config.js merge (gm-apprentice-publish lib/config.js), ported subset
// ---------------------------------------------------------------------------

/**
 * Union two exclude lists case-insensitively, preserving first-seen
 * casing/order, falling back to `defaults` only when NEITHER source
 * supplies a list. Ported from the pin's (unexported) unionExcludeList as it stood at
 * publish-v1.11.44 (lib/config.js:107-121 there). At publish-v1.12.0 the pin does the same merge in
 * pick() (lib/config.js:192-246) and applies the defaults in list() (:396, :414-416): the vault
 * list first, then the site-file entries it lacks. One case differs, and this port is the stricter
 * reader of it: a vault-file key that is set but is not a list now yields the pin defaults plus the
 * site-file entries in the pin, and the site-file list alone here.
 */
function unionExcludeList(primary, fallback, defaults) {
  const sources = [primary, fallback].filter(Array.isArray);
  if (sources.length === 0) return [...defaults];
  const seen = new Set();
  const out = [];
  for (const list of sources) {
    for (const item of list) {
      const key = String(item).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * A single publish.overrides.fields[path] entry is malformed if it is not a
 * map, or has a non-array/non-string-array "include". Ported from the
 * pin's (unexported) overrideEntryProblem, lib/config.js:285-297,
 * unmodified.
 */
function overrideEntryProblem(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return true;
  if (!('include' in value)) return false;
  if (!Array.isArray(value.include)) return true;
  if (!value.include.every((f) => typeof f === 'string')) return true;
  return false;
}

/**
 * Canonicalizes publish.overrides.fields keys to NFC and drops malformed
 * entries. Ported from the pin's (unexported) canonicalizeOverrideFieldKeys,
 * lib/config.js:253-279 — minus the console.warn calls, which would write
 * to stderr during `check` (rejected in Structural decision 1); a dropped
 * entry is still dropped, just silently from Scriptorium's side.
 */
function canonicalizeOverrideFieldKeys(fields) {
  if (fields == null) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (overrideEntryProblem(value)) continue;
    out[pinned.canonicalNfc(key)] = value;
  }
  return out;
}

/**
 * The subset of loadPublishConfig() (lib/config.js:355-477) Scriptorium
 * needs: mode, system, exclude_drafts, exclude_callouts, the three unioned
 * exclude lists, and overrides.fields. Also returns `configSources`: the
 * RAW (un-defaulted, un-unioned) list each surface supplied, or undefined —
 * config/exclude-dirs-divergence needs the vault's raw exclude_dirs, never
 * the merged union, because PUBLISH_DEFAULTS.exclude_dirs entries are not
 * vault entries (see checks/configdiv.js).
 *
 * @returns {{ publishConfig: object, configSources: object }}
 */
function loadPublishConfig(vaultPath, jsonConfig = {}) {
  const configFile = path.join(vaultPath, '_meta', 'vault-config.md');
  let publish = {};

  if (read.pathExists(configFile)) {
    const result = read.readFrontmatter(configFile);
    if (result.ok && result.data.publish) {
      publish = result.data.publish;
    }
  }

  const asList = (v) => (Array.isArray(v) ? v : undefined);

  const publishConfig = {
    mode: publish.mode || pinned.PUBLISH_DEFAULTS.mode,
    system: publish.system || null,
    exclude_drafts: publish.exclude_drafts ?? pinned.PUBLISH_DEFAULTS.exclude_drafts,
    exclude_callouts: publish.exclude_callouts ?? jsonConfig.excludeCallouts ?? pinned.PUBLISH_DEFAULTS.exclude_callouts,
    exclude_sections: unionExcludeList(
      publish.exclude_sections,
      jsonConfig.excludeSections,
      pinned.PUBLISH_DEFAULTS.exclude_sections,
    ),
    exclude_fields: unionExcludeList(
      publish.exclude_fields,
      jsonConfig.excludeFields,
      pinned.PUBLISH_DEFAULTS.exclude_fields,
    ),
    exclude_dirs: unionExcludeList(
      publish.exclude_dirs,
      jsonConfig.excludeDirs,
      pinned.PUBLISH_DEFAULTS.exclude_dirs,
    ),
    overrides: {
      fields: canonicalizeOverrideFieldKeys(
        (publish.overrides && publish.overrides.fields) ?? pinned.PUBLISH_DEFAULTS.overrides.fields,
      ),
    },
  };

  const configSources = {
    vault: {
      exclude_sections: asList(publish.exclude_sections),
      exclude_fields: asList(publish.exclude_fields),
      exclude_dirs: asList(publish.exclude_dirs),
    },
    json: {
      excludeSections: asList(jsonConfig.excludeSections),
      excludeFields: asList(jsonConfig.excludeFields),
      excludeDirs: asList(jsonConfig.excludeDirs),
    },
  };

  return { publishConfig, configSources };
}

// ---------------------------------------------------------------------------
// manifest.js (gm-apprentice-publish lib/manifest.js)
// ---------------------------------------------------------------------------

/**
 * loadManifest() in lib/manifest.js:92-97, ported to route its read through
 * src/vault/read.js: null if _meta/publish-manifest.md is absent or its
 * frontmatter fails to parse (frontmatter/parse-error already reports the
 * latter separately). The raw file content is handed to the pin's own
 * parseManifest(raw) (lib/manifest.js:99), required unmodified via
 * src/generator/pinned.js.
 */
function loadManifest(vaultPath) {
  const manifestPath = path.join(vaultPath, '_meta', 'publish-manifest.md');
  if (!read.pathExists(manifestPath)) return null;
  const result = read.readFrontmatter(manifestPath);
  if (!result.ok) return null;
  return pinned.parseManifest(result.raw);
}

// ---------------------------------------------------------------------------
// scanner.js (gm-apprentice-publish lib/scanner.js), ported I/O
// ---------------------------------------------------------------------------

/**
 * Mirrors the walk's directory-skip test, lib/scanner.js:105
 * (`dirIsExcluded(relPath, excludeDirs) || entry.name.startsWith('.')`). The excludeDirs half is
 * required through the facade's `dirIsExcluded` (the pin's own case-insensitive matcher, lib/
 * scanner.js's matchExcludedDir) rather than hand-re-implemented, so this can never drift from
 * the pin's own casing rule (Δ: excludeDirs entries are matched case-insensitively, deliberately,
 * because the filesystem the scanner walks may or may not be).
 */
function isExcludedDir(relPath, name, excludeDirs) {
  return name.startsWith('.') || pinned.dirIsExcluded(relPath, excludeDirs);
}

/**
 * The walk (lib/scanner.js:76-172, scanVaultReport), ported to route every read
 * through src/vault/read.js. Every .md file with a frontmatter `type` in a
 * folderMap-mapped directory (or the vault root) becomes a page. A file
 * whose folder is unmapped is silently dropped by the generator
 * (lib/scanner.js:119-129); this function records those in `unmappedDirectory`
 * instead of dropping them, so vault/unmapped-directory can report them. A
 * file with no `type:` (lib/scanner.js:117) or unparseable frontmatter is
 * likewise recorded nowhere here — frontmatter/parse-error and
 * frontmatter/missing-type report those separately from ctx.index, not
 * from this module.
 *
 * `outputDir`/`slug`/`outputPath` use the pin's own mapFolder/slugify
 * (required via src/generator/pinned.js) directly, so this can never drift
 * from what the real build would compute. `folderMap` is defaulted to `{}`
 * before calling mapFolder: the pin's own mapFolder throws on an undefined
 * one (Track DEP-b, Risk areas).
 *
 * `rel` is the pin's own vaultRelPath (NFC-canonicalized posix); `relPath`
 * keeps the filesystem's own bytes (posix), for callers where the raw
 * on-disk form matters (e.g. matching an on-disk file directly).
 *
 * @returns {{ pages: object[], unmappedDirectory: object[] }}
 */
function scanForPublish(vaultPath, jsonConfig) {
  const excludeDirs = jsonConfig.excludeDirs || [];
  const folderMap = jsonConfig.folderMap || {};
  const pages = [];
  const unmappedDirectory = [];

  function walk(absDir, relDir) {
    for (const entry of read.listDir(absDir)) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const absPath = path.join(absDir, entry.name);

      if (entry.isDirectory) {
        if (isExcludedDir(relPath, entry.name, excludeDirs)) continue;
        walk(absPath, relPath);
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith('.md')) continue;

      const result = read.readFrontmatter(absPath);
      if (!result.ok) continue; // frontmatter/parse-error reports this separately
      if (!result.data.type) continue; // frontmatter/missing-type reports this separately

      const outputDir = pinned.mapFolder(relDir, folderMap);
      if (!outputDir && relDir !== '') {
        unmappedDirectory.push({ absPath, relPath });
        continue;
      }

      const baseName = path.basename(entry.name, '.md');
      // displayTitle: frontmatter title wins, else the stem with
      // underscores turned to spaces — lib/scanner.js:134, exactly. The old
      // mirror took the stem unconditionally (Track DEP-b, "the mirror
      // code today"), which is the drift this re-port fixes.
      const displayTitle = result.data.title || baseName.replace(/_/g, ' ');
      const slug = pinned.slugify(baseName);
      const outputPath = outputDir ? `${outputDir}/${slug}.html` : `${slug}.html`;

      pages.push({
        sourcePath: absPath,
        relPath,
        rel: pinned.vaultRelPath(vaultPath, absPath),
        title: baseName,
        displayTitle,
        slug,
        outputPath,
        outputDir: outputDir || '',
        frontmatter: result.data,
        markdown: result.content,
        bodyLineOffset: computeLineOffset(result.raw, result.content),
        storyMarkdown: undefined,
        storySourcePath: undefined,
        storyRelPath: undefined,
        storyLineOffset: undefined,
        storyOutputPath: undefined,
        verdict: null,
      });
    }
  }

  walk(vaultPath, '');
  pairStoryFiles(pages);
  return { pages, unmappedDirectory };
}

/**
 * Every candidate page scanForPublish would find with directory exclusion switched off --
 * i.e. it also walks into vault- and json-excluded directories. Used only by the leak and
 * config-divergence checks (leak/l2, config/exclude-dirs-divergence) for defense-in-depth
 * against a STALE build: at this pin, lib/build.js's own scan now honours the merged
 * (vault + json + defaults) exclude_dirs via its own scanConfigFor (Δ, #209 follow-up), so
 * computePublishedSet's scanForPublish call correctly matches a real, fresh build and must
 * NOT include these (src/vault/publishset.js's computePublishedSet uses scanConfigFor and
 * stays a faithful predictor). But a build made before an exclusion was added to
 * _meta/vault-config.md can still have the excluded content sitting in `out/`, and the leak
 * checks must still be able to name that against the *current* config, which this function
 * makes possible by never filtering on excludeDirs in the first place.
 */
function scanAllCandidatePages(vaultPath, jsonConfig) {
  const { pages } = scanForPublish(vaultPath, { ...jsonConfig, excludeDirs: [] });
  return pages;
}

/**
 * pairStoryFiles() in lib/scanner.js:343-371, ported to route its reads through
 * src/vault/read.js and to operate on this module's page shape. Splices a
 * PC's paired `<Name>_Story.md` out of `pages` (whether or not its own
 * frontmatter is parseable or typed `character-story`, matching the pin
 * exactly) and, when it IS a real character-story file, attaches its body
 * as `pc.storyMarkdown` / `pc.storySourcePath`. From publish-v1.12.3 the pin splices only when
 * the note at that path has a `type:` (isStoryCompanion, lib/scanner.js:339-341). `pages` holds
 * typed notes only, here and in the pin, so the result is the same and this port has no gate.
 *
 * Track D3 additions, only set when a real story is attached:
 * `storyRelPath` (vault-relative, posix, alongside `pc.relPath`'s own
 * directory — derived from `pc.relPath` rather than `vaultPath`, since
 * this function is never given one), `storyLineOffset` (the story file's
 * own frontmatter offset, `computeLineOffset`), and `storyOutputPath`
 * (`story/characters/<slug>.html`, mirroring `lib/build.js:1254`'s own
 * `story/characters/${slugify(pc.title)}.html` exactly — required via
 * `pinned.slugify` so this can never drift from what the real build
 * writes).
 */
function pairStoryFiles(pages) {
  const pcPages = pages.filter((p) => p.frontmatter.type === 'pc');
  const removeIndices = new Set();

  for (const pc of pcPages) {
    const pcDir = path.dirname(pc.sourcePath);
    const pcBase = path.basename(pc.sourcePath, '.md');
    const storyPath = path.join(pcDir, `${pcBase}_Story.md`);

    const idx = pages.findIndex((p) => p.sourcePath === storyPath);
    if (idx !== -1) removeIndices.add(idx);

    if (read.pathExists(storyPath)) {
      const result = read.readFrontmatter(storyPath);
      if (!result.ok) continue;
      if (result.data.type !== 'character-story') continue;
      pc.storyMarkdown = result.content;
      pc.storySourcePath = storyPath;
      pc.storyLineOffset = computeLineOffset(result.raw, result.content);
      const pcDirRel = pc.relPath.includes('/') ? pc.relPath.slice(0, pc.relPath.lastIndexOf('/')) : '';
      pc.storyRelPath = pcDirRel ? `${pcDirRel}/${pcBase}_Story.md` : `${pcBase}_Story.md`;
      pc.storyOutputPath = `story/characters/${pinned.slugify(pc.title)}.html`;
    }
  }

  for (const idx of [...removeIndices].sort((a, b) => b - a)) {
    pages.splice(idx, 1);
  }
}

// ---------------------------------------------------------------------------
// build.js's verdict loop (gm-apprentice-publish lib/published-pages.js:10-17, called from
// lib/build.js:420-422; up to publish-v1.12.2 the loop sat in lib/build.js itself)
// ---------------------------------------------------------------------------

/**
 * The full published-set derivation: scan, then one verdict per page from
 * the pin's own decidePage (lib/published-pages.js:14 — called with `rel`,
 * `publishConfig`, `manifest`, and deliberately NO `pageIndex`: the build
 * never passes one either, so a STORY_COMPANION verdict — which needs
 * pageIndex — is never produced here, matching the build exactly), then
 * publishesPage (lib/published-pages.js:16) to bucket into published/unpublished.
 *
 * @returns {{
 *   publishedPages: object[],
 *   unpublishedPages: object[],
 *   unmappedDirectory: object[],
 *   publishConfig: object,
 *   manifest: object|null,
 *   configSources: object,
 * }}
 */
function computePublishedSet(vaultPath, jsonConfig) {
  const { publishConfig, configSources } = loadPublishConfig(vaultPath, jsonConfig);
  const manifest = loadManifest(vaultPath);
  // lib/config.js's scanConfigFor(config, publishConfig): the scan must see the already-merged,
  // already-unioned exclude_dirs (vault-config.md's publish.exclude_dirs unioned with the site
  // config's own excludeDirs and the pin defaults), not the raw site-config-only list -- passing
  // jsonConfig.excludeDirs directly here was exactly the silent-drift bug COLLABORATING.md warns
  // this file is the single largest place for: it walked into (and published) any directory a
  // vault-config.md-only exclusion named, because the walk never saw it.
  const scanConfig = pinned.scanConfigFor(jsonConfig, publishConfig);
  const { pages: allPages, unmappedDirectory } = scanForPublish(vaultPath, scanConfig);

  const publishedPages = [];
  const unpublishedPages = [];
  for (const page of allPages) {
    const verdict = pinned.decidePage(page, { rel: page.rel, publishConfig, manifest });
    page.verdict = { bucket: verdict.bucket, code: verdict.code, reason: verdict.reason };
    if (pinned.publishesPage(verdict)) publishedPages.push(page);
    else unpublishedPages.push(page);
  }

  return {
    publishedPages,
    unpublishedPages,
    unmappedDirectory,
    publishConfig,
    manifest,
    configSources,
  };
}

module.exports = {
  PUBLISH_DEFAULTS: pinned.PUBLISH_DEFAULTS,
  loadPublishConfig,
  loadManifest,
  scanForPublish,
  scanAllCandidatePages,
  computePublishedSet,
};
