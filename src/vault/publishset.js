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

/**
 * uncycle() in lib/frontmatter.js:22-30, ported because the pin does not export it. A YAML alias
 * can make a value hold itself (`tags: &a [x, *a]`); the pin replaces the repeat with null before
 * anything walks the values. Works on a clone, since the parse result may be shared with other readers.
 *
 * @param {object} data parsed frontmatter
 * @returns {object} a copy with no cycles
 */
function uncycled(data) {
  const copy = structuredClone(data);
  (function walk(value, above) {
    if (!value || typeof value !== 'object' || value instanceof Date) return;
    above.push(value);
    for (const key of Object.keys(value)) {
      if (above.includes(value[key])) value[key] = null;
      else walk(value[key], above);
    }
    above.pop();
  })(copy, []);
  return copy;
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
// The vault's settings, read by the pin's own loader (lib/config.js loadPublishConfig)
// ---------------------------------------------------------------------------

/**
 * The site config as the build hands it to the pin, for reading settings. The build always
 * replaces outputDir with its own staging folder (src/build/stage.js), so the GM's outputDir is never
 * judged by the pin's output-folder rule; leaving it out here keeps `check` from reporting a fault the
 * build can never hit.
 */
function siteConfigForSettings(jsonConfig) {
  const site = { ...(jsonConfig || {}) };
  delete site.outputDir;
  return site;
}

/**
 * The vault's settings files, read through src/vault/read.js (so a failing disk still aborts and the
 * panel's edited copy is still what is read, ADR 0041). `layout` is the pin's own reading of which
 * file the vault keeps its settings in ('new' for _meta/vault-config.yaml, which wins when both
 * files are there; 'legacy' for _meta/vault-config.md; 'none').
 *
 * @param {string} vaultPath
 * @returns {{ layout: 'new'|'legacy'|'none', md: string|null, yaml: string|null }}
 */
function readSettingsFiles(vaultPath) {
  const textOf = (name) => {
    const file = path.join(vaultPath, '_meta', name);
    return read.pathExists(file) ? read.readText(file) : null;
  };
  return { layout: pinned.settingsLayoutOf(vaultPath), md: textOf('vault-config.md'), yaml: textOf('vault-config.yaml') };
}

/**
 * Is this the pin's "not valid YAML" error for _meta/vault-config.yaml (lib/settings/read.js
 * parseNewFile)? The pin throws a plain Error, so its text is the only handle. Anything else the
 * pin throws is not a broken yaml and must not be reported as one.
 */
function isYamlParseError(err) {
  return Boolean(err) && /^_meta\/vault-config\.yaml is not valid YAML/.test(String(err.message));
}

/**
 * The vault's settings as the pinned build reads them. Up to publish-v1.21.0 this was a hand port
 * of the pin's config merge. At publish-v1.26.0 the pin's reader changed in ways a port would have
 * to follow line by line (a site-file hiding list now adds to the built-in list, upstream #371;
 * `no`, `off`, `yes` and `on` are switch words; and a hiding setting it cannot read stops the
 * build), so `check` now asks the pin's own loader, through src/generator/pinned.js's
 * readPublishSettings, and hands it the settings file's text read here through src/vault/read.js
 * (so a failing disk still aborts, and the panel's edited copy is still what is read, ADR 0041).
 * The build's read shim strips Obsidian comments and dataview blocks from a note's body only, never
 * its frontmatter (src/vault/comments.js, src/vault/dataview.js), so the text is handed over as read.
 *
 * Returns the subset Scriptorium reads (mode, system, the hiding switches and lists, the field
 * exceptions), with the pin's `layout` and `withheld_words` carried as non-enumerable fields as the
 * pin carries them. Also returns:
 *   - `configSources`: the RAW (un-defaulted, un-merged) list each file supplied, or undefined.
 *     config/exclude-*-divergence needs the vault's own list, never the merged one.
 *   - `switchWords`: each of publish.exclude_drafts and publish.exclude_callouts that the vault's file
 *     writes as TEXT the pin reads as off (`no`, `off`, "false"), as {setting, raw}. At
 *     publish-v1.21.0 any text counted as on. config/switch-word-now-off reports them.
 *   - `stops`: the pin's stop-level faults, each with its `message`, exactly the faults that make
 *     the build refuse to run (lib/config.js assertNoStops). config/settings-fault reports them.
 *
 * A settings file the pin cannot parse makes the pin throw; the build then stops with that error.
 * Here it is read as if the file held no settings (as the port did). A vault-config.md is then
 * reported by frontmatter/parse-error; a vault-config.yaml, which no index covers, is added to `stops`
 * with the pin's message, so config/settings-fault reports it.
 *
 * @returns {{ publishConfig: object, configSources: object, stops: object[], switchWords: object[] }}
 */
function loadPublishConfig(vaultPath, jsonConfig = {}, rawSiteConfig = undefined) {
  const { layout, md, yaml } = readSettingsFiles(vaultPath);
  const moved = layout === 'new';
  let publish = {};
  if (!moved && md !== null) {
    const parsed = read.parseFrontmatterText(md);
    if (parsed.ok && parsed.data && parsed.data.publish && typeof parsed.data.publish === 'object') {
      publish = parsed.data.publish;
    }
  }

  // On the moved layout the pin is handed the pack as read, so a hiding key left in it is the stop
  // the pin makes of it (the moved keys are no longer read there, and what they hid would publish).
  const siteConfig = moved && rawSiteConfig ? rawSiteConfig : jsonConfig;
  const site = siteConfigForSettings(siteConfig);
  let settings;
  let unreadable = null;
  try {
    settings = pinned.readPublishSettings(vaultPath, site, { md, yaml });
  } catch (err) {
    if (md === null && yaml === null) throw err;
    if (moved && !isYamlParseError(err)) throw err;
    settings = pinned.readPublishSettings(vaultPath, site, { md: null, yaml: null });
    // A broken vault-config.md is reported by frontmatter/parse-error, which indexes every note. The
    // yaml is no note, so nothing else would name it: it becomes a stop, reported by config/settings-fault.
    if (moved) unreadable = { name: 'vault-config.yaml', setting: null, kind: 'unreadable', level: 'stop', message: String(err.message) };
  }
  const pc = settings.config;

  const publishConfig = {
    mode: pc.mode,
    system: pc.system == null ? null : pc.system,
    exclude_drafts: pc.exclude_drafts,
    exclude_callouts: pc.exclude_callouts,
    exclude_sections: pc.exclude_sections,
    exclude_fields: pc.exclude_fields,
    exclude_dirs: pc.exclude_dirs,
    overrides: { fields: (pc.overrides && pc.overrides.fields) || {} },
  };
  // decidePage names a setting as this vault's file writes it (lib/publish-decision.js), from `layout`.
  Object.defineProperty(publishConfig, 'layout', { value: pc.layout, enumerable: false });
  Object.defineProperty(publishConfig, 'withheld_words', { value: pc.withheld_words, enumerable: false });

  const asList = (v) => (Array.isArray(v) ? v : undefined);
  // The vault's own lists. On the moved layout the pin reports where each came from, so a list the
  // yaml does not write is undefined, as an absent md list is.
  const ownList = (setting, value) => (pc.origins && pc.origins[setting] === 'file' ? asList(value) : undefined);
  const configSources = {
    vault: moved
      ? {
          exclude_sections: ownList('player_site.hide.sections', pc.exclude_sections),
          exclude_fields: ownList('player_site.hide.fields', pc.exclude_fields),
          exclude_dirs: ownList('player_site.hide.folders', pc.exclude_dirs),
        }
      : {
          exclude_sections: asList(publish.exclude_sections),
          exclude_fields: asList(publish.exclude_fields),
          exclude_dirs: asList(publish.exclude_dirs),
        },
    // The site file's own lists. On the moved layout jsonConfig is the pack resolved against the yaml,
    // so its lists would be the yaml's (or the defaults); the pack as read is what the site file holds.
    json: {
      excludeSections: asList(siteConfig.excludeSections),
      excludeFields: asList(siteConfig.excludeFields),
      excludeDirs: asList(siteConfig.excludeDirs),
    },
  };

  // The switch settings whose old meaning was "any text is on": see config/switch-word-now-off.
  const switchWords = [];
  for (const key of ['exclude_drafts', 'exclude_callouts']) {
    const raw = publish[key];
    if (typeof raw === 'string' && pinned.readSwitch(raw) === false) switchWords.push({ setting: `publish.${key}`, raw });
  }

  return { publishConfig, configSources, stops: unreadable ? [...settings.stops, unreadable] : settings.stops, switchWords };
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
 * Mirrors the walk's directory-skip test, lib/scanner.js:113
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
 * The walk (lib/scanner.js:81-192, scanVaultReport), ported to route every read
 * through src/vault/read.js. Every .md file with a frontmatter `type` in a
 * folderMap-mapped directory (or the vault root) becomes a page. A file
 * whose folder is unmapped is silently dropped by the generator
 * (lib/scanner.js:138-148); this function records those in `unmappedDirectory`
 * instead of dropping them, so vault/unmapped-directory can report them. A
 * file with no `type:` (lib/scanner.js:136) or unparseable frontmatter is
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
      // The pin's own reading of the values: cycles broken, comments cut, then wrong types shaped or left
      // unread (lib/scanner.js:127-129), so a `type:` it cannot read publishes nothing here either.
      const frontmatter = pinned.shapeFrontmatter(pinned.cutValueComments(uncycled(result.data))).frontmatter;
      if (!frontmatter.type) continue; // frontmatter/missing-type reports this separately

      const outputDir = pinned.mapFolder(relDir, folderMap);
      if (!outputDir && relDir !== '') {
        unmappedDirectory.push({ absPath, relPath });
        continue;
      }

      const baseName = path.basename(entry.name, '.md');
      // displayTitle: frontmatter title wins, read as a string with any wikilink
      // printed by its label, else the stem with underscores turned to spaces —
      // lib/scanner.js:155, exactly (publish-v1.17.0 added the string and the label).
      const displayTitle = (frontmatter.title ? pinned.labelsForLinks(String(frontmatter.title)) : '') || baseName.replace(/_/g, ' ');
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
        frontmatter,
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
 * pairStoryFiles() in lib/scanner.js:378-406, ported to route its reads through
 * src/vault/read.js and to operate on this module's page shape. Splices a
 * PC's paired `<Name>_Story.md` out of `pages` (whether or not its own
 * frontmatter is parseable or typed `character-story`, matching the pin
 * exactly) and, when it IS a real character-story file, attaches its body
 * as `pc.storyMarkdown` / `pc.storySourcePath`. From publish-v1.12.3 the pin splices only when
 * the note at that path has a `type:` (isStoryCompanion, lib/scanner.js:374-376). `pages` holds
 * typed notes only, here and in the pin, so the result is the same and this port has no gate.
 *
 * Track D3 additions, only set when a real story is attached:
 * `storyRelPath` (vault-relative, posix, alongside `pc.relPath`'s own
 * directory — derived from `pc.relPath` rather than `vaultPath`, since
 * this function is never given one), `storyLineOffset` (the story file's
 * own frontmatter offset, `computeLineOffset`), and `storyOutputPath`
 * (`story/characters/<slug>.html`, mirroring `lib/build.js:1809`'s own
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
// build.js's verdict loop (gm-apprentice-publish lib/published-pages.js:12-25, called from
// lib/build.js:654-657; up to publish-v1.12.2 the loop sat in lib/build.js itself)
// ---------------------------------------------------------------------------

/**
 * The full published-set derivation: scan, then one verdict per page from
 * the pin's own decidePage (lib/published-pages.js:20 — called with `rel`,
 * `publishConfig`, `manifest`, and deliberately NO `pageIndex`: the build
 * never passes one either, so a STORY_COMPANION verdict — which needs
 * pageIndex — is never produced here, matching the build exactly), then
 * publishesPage (lib/published-pages.js:22) to bucket into published/unpublished.
 *
 * @returns {{
 *   publishedPages: object[],
 *   unpublishedPages: object[],
 *   unmappedDirectory: object[],
 *   publishConfig: object,
 *   manifest: object|null,
 *   configSources: object,
 *   stops: object[],
 *   switchWords: object[],
 * }}
 */
function computePublishedSet(vaultPath, jsonConfig, rawSiteConfig = undefined) {
  const { publishConfig, configSources, stops, switchWords } = loadPublishConfig(vaultPath, jsonConfig, rawSiteConfig);
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
    stops,
    switchWords,
  };
}

module.exports = {
  PUBLISH_DEFAULTS: pinned.PUBLISH_DEFAULTS,
  loadPublishConfig,
  isYamlParseError,
  readSettingsFiles,
  loadManifest,
  scanForPublish,
  scanAllCandidatePages,
  computePublishedSet,
};
