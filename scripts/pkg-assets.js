'use strict';

/*
 * DEP-a2 Finding 2 regression gate.
 *
 * @yao-pkg/pkg only reads a `pkg` field from package.json when package.json
 * itself is the build input (node_modules/@yao-pkg/pkg/lib-es5/config.js's
 * resolveInput()/resolveConfigFile(), :511-591). With `bin/scriptorium.js`
 * as input (the invocation both v0.1.0 and v0.1.1 shipped with), pkg.assets
 * is silently never read: only files pkg's own static require-graph walk
 * finds make it into the exe (walker.js's appendFilesFromConfig only runs
 * off marker.config.pkg, and that marker is `{}` for a plain-script input).
 * scripts/package.js fixes the invocation (package.json as input, no -c);
 * this module is the gate that proves the fix actually landed every
 * expected asset, both for a real `--debug` build and, negatively, against
 * the old invocation's debug log.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..');

/*
 * Scriptorium's own first-party site AND theme assets (SD-1/SD-2 of the P3a Engineering Brief;
 * extended by P3b's SD-2 to include the built-in haze theme's two files). Unlike the pin's files
 * below, these have no manifest to expand from, so this is a hand-maintained literal, NOT a walk
 * of assets/site/ or assets/themes/ on disk: walking the same tree pkg.assets' glob expands
 * would make the expectation and the thing it is meant to check derive
 * from the same source, so a silently deleted file would be absent from
 * both sides and this gate would pass vacuously -- the exact tautology
 * CLAUDE.md warns about. The literal list IS the manifest;
 * test/package-config.test.js carries a separate change-detector that
 * walks assets/site/, assets/themes/ and assets/admin/ and fails loudly if a maintainer adds a
 * file here without also adding it to this literal.
 *
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md) adds the 9
 * assets/admin/ files: the GM-only admin panel UI, embedded in the exe and served only on
 * 127.0.0.1 by `serve --admin` (docs/PROVENANCE.md section 17). Same rejected-second-list
 * reasoning as above: they join this one literal rather than a separate
 * FIRST_PARTY_ADMIN_ASSETS list (ADR 0023 section 12's precedent).
 *
 * Panel v2 V1a adds tokens.css, store.js, icons.js, nav.js, frame.js and the 8 embedded font
 * files under assets/admin/fonts/ -- 13 entries to 26, same literal, same reasoning. Panel v2
 * V1b adds diff.js, outcome.js and slip.js in sorted position -- 26 to 29, same literal, same
 * reasoning. ADR 0032 (base theme slice) adds the gloam theme's 5 vendored font files (29 to
 * 34), landing ahead of C3's theme.json/theme.css/NOTICE.txt (34 to 37).
 */
const FIRST_PARTY_SITE_ASSETS = [
  'assets/site/scriptorium.css',
  'assets/site/scriptorium.js',
  'assets/themes/gloam/NOTICE.txt',
  'assets/themes/gloam/fonts/CormorantGaramond-Italic-wght.woff2',
  'assets/themes/gloam/fonts/CormorantGaramond-wght.woff2',
  'assets/themes/gloam/fonts/IMFeENit28P.woff2',
  'assets/themes/gloam/fonts/IMFeENrm28P.woff2',
  'assets/themes/gloam/fonts/IMFeENsc28P.woff2',
  'assets/themes/gloam/theme.css',
  'assets/themes/gloam/theme.json',
  'assets/themes/haze/theme.css',
  'assets/themes/haze/theme.json',
  'assets/admin/admin.css',
  'assets/admin/alive.js',
  'assets/admin/app.js',
  'assets/admin/campaigns.js',
  'assets/admin/diff.js',
  'assets/admin/favicon-32.png',
  'assets/admin/favicon.svg',
  'assets/admin/fonts/AlegreyaSans-Bold.ttf',
  'assets/admin/fonts/AlegreyaSans-Italic.ttf',
  'assets/admin/fonts/AlegreyaSans-Medium.ttf',
  'assets/admin/fonts/AlegreyaSans-Regular.ttf',
  'assets/admin/fonts/IBMPlexMono-Regular.woff2',
  'assets/admin/fonts/IBMPlexMono-SemiBold.woff2',
  'assets/admin/fonts/IMFeENrm28P.ttf',
  'assets/admin/fonts/IMFeENsc28P.ttf',
  'assets/admin/frame.js',
  'assets/admin/icons.js',
  'assets/admin/images.js',
  'assets/admin/index.html',
  'assets/admin/launch-locked.html',
  'assets/admin/launch.html',
  'assets/admin/launch.js',
  'assets/admin/locked.html',
  'assets/admin/nav.js',
  'assets/admin/outcome.js',
  'assets/admin/pack.js',
  'assets/admin/remote.js',
  'assets/admin/setup.html',
  'assets/admin/setup.js',
  'assets/admin/signin.html',
  'assets/admin/signin.js',
  'assets/admin/sitepane.js',
  'assets/admin/slip.js',
  'assets/admin/store.js',
  'assets/admin/tokens.css',
  'assets/admin/variants.js',
  'assets/admin/vaultcfg.js',
  'assets/admin/views.js',
  'assets/admin/vocab.js',
  'assets/admin/welcome.js',
];

/**
 * The 81 files @yao-pkg/pkg's config-asset walker (walker.js:410-451)
 * should embed for this project's package.json `pkg.assets` globs (61 at
 * this file's own prior baseline, +8 for the gloam theme's full set
 * including C3's theme.json/theme.css/NOTICE.txt, +1 for V1e-3's
 * sitepane.js, +1 for V1e-9's vaultcfg.js, +1 for V1e-7's variants.js --
 * re-measured at the V1e-7 rebase onto main; then ADR 0028 and V1.5a took it to 80, and Lantern
 * branding's assets/admin/favicon-32.png makes 81).
 *
 * Two different derivations feed this list, deliberately: the pin's 30
 * files (6 css + 12 js + 12 templates-scaffold, each prefixed
 * node_modules/gm-apprentice-publish/) are EXPANDED OVER DISK from
 * vendor/gm-apprentice-publish/PIN.json's file list, because the pin has a
 * manifest to expand against; FIRST_PARTY_SITE_ASSETS above is not (see its
 * own comment for why) -- it now carries 34 entries (9 site/theme -- 2
 * site, 5 gloam fonts, 3 haze (css + json; issue #84 follow-up: haze shares gloam's fonts and NOTICE via theme.json fontsFrom) -- and 24 admin, panel v2 V1a). Plus the
 * separately globbed bundled
 * node_modules/gm-apprentice-publish/node_modules/lunr/lunr.js (v1.11.40
 * bundles its own lunr; it is no longer hoisted to a top-level
 * node_modules/lunr), plus the repo's own root-level THIRD-PARTY-NOTICES.txt
 * (src/util/notices.js reads this embedded copy for `--version` and
 * `--notices`).
 *
 * @param {string} [root] repo root (defaults to this script's own repo)
 * @returns {string[]} sorted, root-relative, forward-slashed paths
 */
function expectedAssets(root = DEFAULT_ROOT) {
  const pinPath = path.join(root, 'vendor', 'gm-apprentice-publish', 'PIN.json');
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  const generatorAssets = Object.keys(pin.files)
    .filter((rel) => rel.startsWith('css/') || rel.startsWith('js/') || rel.startsWith('templates-scaffold/'))
    .map((rel) => `node_modules/gm-apprentice-publish/${rel}`);
  return [
    ...generatorAssets,
    'node_modules/gm-apprentice-publish/node_modules/lunr/lunr.js',
    'THIRD-PARTY-NOTICES.txt',
    ...FIRST_PARTY_SITE_ASSETS,
  ].sort();
}

function normalizeAssetPath(rawPath, root) {
  let assetPath = String(rawPath).trim().split(path.sep).join('/');
  const normalizedRoot = root.split(path.sep).join('/');
  if (assetPath.startsWith(`${normalizedRoot}/`)) {
    assetPath = assetPath.slice(normalizedRoot.length + 1);
  }
  return assetPath;
}

// Matches the ANSI-coloured "> [debug]  Adding asset : .... " line
// log.debug(' Adding asset : .... ', asset) (walker.js:439) renders via
// @yao-pkg/pkg-fetch's Log#debug/#lines, ignoring any ANSI escape codes
// picocolors may have inserted around "[debug]" itself. The asset path is
// printed as its OWN line immediately after (Log#lines' single-string
// path: `console.log('  ' + lines)`), not on the same line.
const ADDING_ASSET_MARKER = 'Adding asset : .... ';

/**
 * Parses pkg `--debug` output for the config-asset lines walker.js:439
 * emits -- only printed for pkg.assets-driven files, not pkg's separate
 * static-require walk (which uses a different message entirely).
 *
 * @param {string} debugText
 * @param {string} [root]
 * @returns {string[]} every embedded asset path found, in file order (not de-duplicated)
 */
function parseEmbeddedAssets(debugText, root = DEFAULT_ROOT) {
  const lines = String(debugText).split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(ADDING_ASSET_MARKER)) continue;
    const next = lines[i + 1];
    if (next === undefined) continue;
    found.push(normalizeAssetPath(next, root));
  }
  return found;
}

/**
 * @param {string} debugText pkg's captured `--debug` stdout
 * @param {string} [root]
 * @returns {{ ok: boolean, missing: string[] }} missing is expectedAssets()
 *   minus whatever parseEmbeddedAssets() found, in expectedAssets() order
 */
function assertAssetsEmbedded(debugText, root = DEFAULT_ROOT) {
  const expected = expectedAssets(root);
  const embedded = new Set(parseEmbeddedAssets(debugText, root));
  const missing = expected.filter((asset) => !embedded.has(asset));
  return { ok: missing.length === 0, missing };
}

module.exports = { expectedAssets, parseEmbeddedAssets, assertAssetsEmbedded, FIRST_PARTY_SITE_ASSETS };
