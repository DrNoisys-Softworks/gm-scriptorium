'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildInvocation, TARGETS, DEFAULT_TARGET, DEFAULT_OUT, DEFAULT_OUT_DIR, defaultOutPathFor, PACKAGE_JSON_PATH, ROOT } = require('../scripts/package');
const { expectedAssets, FIRST_PARTY_SITE_ASSETS } = require('../scripts/pkg-assets');

const GENERATOR_DIR = path.join(ROOT, 'node_modules', 'gm-apprentice-publish');

// -- 1. the invocation uses package.json as input, with no -c/--config --

test('buildInvocation() uses package.json as the pkg input, never bin/scriptorium.js', () => {
  const argv = buildInvocation({ target: 'node22-win-x64', out: '/tmp/does-not-matter.exe' });
  assert.equal(argv[argv.length - 1], PACKAGE_JSON_PATH);
  assert.ok(!argv.some((a) => String(a).endsWith(path.join('bin', 'scriptorium.js'))));
});

test('buildInvocation() never passes -c or --config (pkg rejects package.json input plus -c)', () => {
  const argv = buildInvocation({ target: 'node22-linux-x64', out: '/tmp/does-not-matter' });
  assert.ok(!argv.includes('-c'));
  assert.ok(!argv.includes('--config'));
});

test('buildInvocation() passes the requested target and output path', () => {
  const argv = buildInvocation({ target: 'node22-linux-x64', out: '/tmp/scriptorium-linux' });
  assert.deepEqual(
    argv.slice(argv.indexOf('-t'), argv.indexOf('-t') + 4),
    ['-t', 'node22-linux-x64', '-o', '/tmp/scriptorium-linux'],
  );
});

// -- 1b. P5a-FR01/FR02, D-12: the default target plan is exactly win-x64 and linux-x64 --

test('S3/P5a-FR01: TARGETS is exactly win-x64 (.exe) and linux-x64 (no extension), gm-scriptorium-* names, in that order', () => {
  assert.deepEqual(TARGETS, [
    { target: 'node22-win-x64', assetName: 'gm-scriptorium-win-x64.exe' },
    { target: 'node22-linux-x64', assetName: 'gm-scriptorium-linux-x64' },
  ]);
});

test('DEFAULT_TARGET/DEFAULT_OUT still name the win-x64 asset (single-target override backward-compat)', () => {
  assert.equal(DEFAULT_TARGET, 'node22-win-x64');
  assert.equal(path.basename(DEFAULT_OUT), 'gm-scriptorium-win-x64.exe');
  assert.equal(path.dirname(DEFAULT_OUT), DEFAULT_OUT_DIR);
});

test('defaultOutPathFor() maps each known target to its own asset name under DEFAULT_OUT_DIR', () => {
  assert.equal(defaultOutPathFor('node22-win-x64'), path.join(DEFAULT_OUT_DIR, 'gm-scriptorium-win-x64.exe'));
  assert.equal(defaultOutPathFor('node22-linux-x64'), path.join(DEFAULT_OUT_DIR, 'gm-scriptorium-linux-x64'));
});

test('defaultOutPathFor() falls back to a generic gm-scriptorium-<target> name for an unlisted target, rather than throwing', () => {
  assert.equal(defaultOutPathFor('node22-macos-x64'), path.join(DEFAULT_OUT_DIR, 'gm-scriptorium-node22-macos-x64'));
});

// -- 2. expectedAssets() equals the PIN.json-derived set --

test('expectedAssets() is exactly the 32 PIN.json paths under css/, js/, templates-scaffold/, plus lunr.js, THIRD-PARTY-NOTICES.txt and FIRST_PARTY_SITE_ASSETS (85 total, ADR 0028 adding assets/admin/alive.js, launch-locked.html, launch.html and launch.js to the 81, Lantern branding adding assets/admin/favicon-32.png to the 80, and before that setup.html, setup.js and welcome.js to the 77; V1.5a adding assets/admin/remote.js, signin.html and signin.js to the 74 on main; publish-v1.14.0 added js/dnd-live.js and js/dnd-party.js; issue #84 added 6 haze font/NOTICE files and its follow-up removed them again, haze now shares gloam\'s via fontsFrom: the base theme slice adds the gloam theme\'s 5 vendored font files (C2) plus its theme.json/theme.css/NOTICE.txt (C3) to the 61 panel v2 V1b total, then V1e-3 adds assets/admin/sitepane.js, then V1e-9 adds assets/admin/vaultcfg.js, then V1e-7 adds assets/admin/variants.js)', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'gm-apprentice-publish', 'PIN.json'), 'utf8'));
  const pinPaths = Object.keys(pin.files);
  const cssRel = pinPaths.filter((rel) => rel.startsWith('css/'));
  const jsRel = pinPaths.filter((rel) => rel.startsWith('js/'));
  const scaffoldRel = pinPaths.filter((rel) => rel.startsWith('templates-scaffold/'));
  const fromPin = [...cssRel, ...jsRel, ...scaffoldRel].map((rel) => `node_modules/gm-apprentice-publish/${rel}`);
  const expected = [
    ...fromPin,
    'node_modules/gm-apprentice-publish/node_modules/lunr/lunr.js',
    'THIRD-PARTY-NOTICES.txt',
    ...FIRST_PARTY_SITE_ASSETS,
  ].sort();

  assert.deepEqual(expectedAssets(ROOT), expected);
  assert.equal(expectedAssets(ROOT).length, 85);

  assert.equal(cssRel.length, 6);
  assert.equal(jsRel.length, 14);
  assert.equal(scaffoldRel.length, 12);

  // SD-2 (P3b): the built-in haze theme's two files, added to the same hand-maintained literal
  // as assets/site/scriptorium.{css,js} -- no separate FIRST_PARTY_THEME_ASSETS list (rejected
  // in the Engineering Brief; a second list for the same gate). Phase 8 slice S1 adds the 9
  // assets/admin/ files to this same literal for the same reason (ADR 0023 section 12's
  // precedent, restated in the admin skeleton doc section 1.4). Panel v2 V1a adds
  // tokens.css, store.js, icons.js, nav.js, frame.js and the 8 embedded font files (13 entries
  // to 26), same literal, same reasoning. Panel v2 V1b adds diff.js, outcome.js and slip.js in
  // sorted position (26 -> 29), same literal, same reasoning. ADR 0032 (base theme slice) adds
  // the gloam theme's 5 vendored font files (C2, 29 -> 34) and its theme.json/theme.css/
  // NOTICE.txt (C3, 34 -> 37), same literal, same reasoning. V1e-3 (SD-26) adds
  // assets/admin/sitepane.js in sorted position (37 -> 38), same literal, same reasoning.
  // V1e-9 (SD-100) adds assets/admin/vaultcfg.js in sorted position (38 -> 39), same literal,
  // same reasoning. V1e-7 (SD-69) adds assets/admin/variants.js in sorted position (39 -> 40),
  // same literal, same reasoning -- re-measured at the V1e-7 rebase onto main. V1.5a (ADR 0029) adds
  // assets/admin/remote.js, signin.html and signin.js in sorted position (74 -> 77), same literal. ADR 0028 adds assets/admin/setup.html,
  // setup.js and welcome.js in sorted position (77 -> 80), same literal. ADR 0028 (launch mode) adds assets/admin/alive.js,
  // launch-locked.html, launch.html and launch.js in sorted position (81 -> 85), same literal.
  assert.deepEqual(FIRST_PARTY_SITE_ASSETS, [
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
  ]);
});

// -- 2b. FIRST_PARTY_SITE_ASSETS change detector: SD-6 forbids expectedAssets() itself from
// walking assets/site/ or assets/themes/ (that would derive the expectation from the same thing
// pkg.assets' glob expands, and a silently deleted file would be absent from both sides). This
// test is where the disk walk is allowed to happen instead: a human-facing alarm, not the
// packaging gate itself, so a maintainer who adds a file under either directory without updating
// the literal finds out here rather than having the packaging gate pass vacuously.

test('FIRST_PARTY_SITE_ASSETS matches exactly what is on disk under assets/site/ and assets/themes/ (change detector)', () => {
  const onDisk = [];
  function walkInto(rootDir, rootLabel) {
    (function walk(dir, rel) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), entryRel);
        } else {
          onDisk.push(`${rootLabel}/${entryRel}`);
        }
      }
    })(rootDir, '');
  }
  walkInto(path.join(ROOT, 'assets', 'site'), 'assets/site');
  walkInto(path.join(ROOT, 'assets', 'themes'), 'assets/themes');
  walkInto(path.join(ROOT, 'assets', 'admin'), 'assets/admin');

  assert.deepEqual(onDisk.slice().sort(), FIRST_PARTY_SITE_ASSETS.slice().sort());
});

// -- 3. change detector: every path.join(__dirname, '../<dir>...') read on the pin's build
// path sits under a declared pkg.assets glob. If a future pin changes what it reads from
// __dirname, this fails loudly instead of silently under-bundling the way the old
// bin/scriptorium.js invocation did (docs/decisions/0005-generator-pin.md).

function coveredPrefixes() {
  const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  return pkgJson.pkg.assets
    // A glob (css/**/*, js/**/*, templates-scaffold/**/*), not the single literal bundled-lunr
    // asset path (FR-17/SD-17): that one is a specific file, not a __dirname-read-covering prefix.
    .filter((glob) => glob.startsWith('node_modules/gm-apprentice-publish/') && glob.includes('*'))
    .map((glob) => glob.slice('node_modules/gm-apprentice-publish/'.length).split('*')[0].replace(/\/$/, ''));
}

/** Extracts the literal path segments from `path.join(__dirname, ...)` at `file:line` (1-based). */
function dirnameJoinTargetAt(absFile, line) {
  const lines = fs.readFileSync(absFile, 'utf8').split('\n');
  const text = lines[line - 1];
  const match = text.match(/path\.join\(__dirname,\s*([\s\S]*?)\)/);
  assert.ok(match, `${absFile}:${line} no longer matches a path.join(__dirname, ...) read: "${text}"`);

  const parts = match[1].split(',').map((s) => s.trim());
  const literals = parts.map((part) => {
    // Strip the surrounding quote/backtick and any ${...} template interpolation content;
    // what's left is the literal text pkg's static analysis could also see.
    const unquoted = part.replace(/^['"`]|['"`]$/g, '');
    return unquoted.replace(/\$\{[^}]*\}/g, '');
  });

  const joined = literals.join('/');
  const segments = joined.split('/').filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
  return segments[0];
}

test('every __dirname-relative build-path read in the pin sits under a pkg.assets glob (change detector)', () => {
  const covered = coveredPrefixes();
  assert.deepEqual(covered.sort(), ['css', 'js', 'templates-scaffold']);

  const sites = [
    { file: path.join(GENERATOR_DIR, 'lib', 'build.js'), line: 152, label: 'build.js:152 (copyCSS)' },
    { file: path.join(GENERATOR_DIR, 'lib', 'build.js'), line: 169, label: 'build.js:169 (copyGenreCSS)' },
    { file: path.join(GENERATOR_DIR, 'lib', 'build.js'), line: 201, label: 'build.js:201 (copyJS)' },
    { file: path.join(GENERATOR_DIR, 'lib', 'init.js'), line: 8, label: 'init.js:8 (TEMPLATES_DIR)' },
    { file: path.join(GENERATOR_DIR, 'lib', 'sync-functions.js'), line: 4, label: 'sync-functions.js:4 (SCAFFOLD_FUNCTIONS_DIR)' },
    // New at this pin (Δ): lib/fonts.js's presetFamiliesFor reads css/themes/<preset>.css directly,
    // same __dirname-relative shape and same covered prefix as copyGenreCSS above.
    { file: path.join(GENERATOR_DIR, 'lib', 'fonts.js'), line: 256, label: 'fonts.js:256 (presetFamiliesFor)' },
  ];

  for (const site of sites) {
    const firstSegment = dirnameJoinTargetAt(site.file, site.line);
    assert.ok(
      covered.includes(firstSegment),
      `${site.label} reads "${firstSegment}/...", which is not under any of pkg.assets' covered prefixes [${covered.join(', ')}]`,
    );
  }
});
