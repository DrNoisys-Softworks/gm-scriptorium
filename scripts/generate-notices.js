#!/usr/bin/env node
'use strict';

/*
 * Generates THIRD-PARTY-NOTICES.txt. Run: node scripts/generate-notices.js
 *
 * This is the mechanical half of the licence provenance audit at
 * docs/PROVENANCE.md, specifically section 11's specification. It does
 * not hand-list packages: the source of truth is Scriptorium's own
 * package-lock.json, walked including nested node_modules (a flat
 * top-level scan misses markdown-it/node_modules/argparse@2.0.1, which is
 * exactly how that Python-2.0 dependency went unnoticed in an earlier
 * pass). Re-run this whenever package-lock.json changes; the output is
 * committed, not generated at install or build time.
 *
 * Determinism: given the same package-lock.json, the same installed
 * node_modules tree, the same vendored files under scripts/vendor/, and
 * the same package.json version, this produces byte-identical output
 * except for the "Generated" line's date, which states the lockfile hash
 * it was generated from so a stale copy is detectable without a git diff.
 *
 * Issue #26: the section-0 header also stamps package.json's own version
 * ("Scriptorium version: <version>"), so a THIRD-PARTY-NOTICES.txt found
 * sitting beside a packaged executable can be checked for staleness by
 * reading it -- the running old binary that ships an `update` cannot
 * produce the NEW binary's notices text, so `update` deletes the stale
 * copy on success rather than writing content it cannot vouch for
 * (docs/decisions/0011-notices-beside-the-executable.md). This version
 * line is deliberately part of the byte-for-byte comparison
 * scripts/notices-freshness.js runs before every `npm run package`: a
 * version bump changes this line, so cutting a release that bumps
 * package.json's version WILL fail that gate until "npm run notices" is
 * re-run and the regenerated file is committed. This is a feature, not
 * friction -- it forces per-release regeneration, which is exactly the
 * staleness class Issue #26 exists to close -- but it is a trap for
 * whoever cuts the next release if it is not written down here: see also
 * README.md's "Third-party notices" section and docs/decisions/0011.
 *
 * Fails loudly (non-zero exit, no output file written) rather than
 * warning if any production package resolves to zero licence files,
 * because a silently incomplete notices file is worse than a build
 * failure (docs/PROVENANCE.md section 11: "Fail the build, do not warn").
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');
const PKG_PATH = path.join(ROOT, 'package.json');
const OUT_PATH = path.join(ROOT, 'THIRD-PARTY-NOTICES.txt');
const VENDOR_DIR = path.join(__dirname, 'vendor');
const PIN_PATH = path.join(ROOT, 'vendor', 'gm-apprentice-publish', 'PIN.json');

// Determined via @yao-pkg/pkg-fetch's own resolution: `pkg-fetch.satisfyingNodeVersion('22')`
// returns this exact version for the node22 target family, matching the
// version phase 0's actual pkg-built binary reported at runtime
// (nodeVersion: "v22.23.2"). Per docs/PROVENANCE.md section 8 / B1: after
// the FIRST successful pkg build, confirm this is still the resolved
// version and re-fetch scripts/vendor/node-v<version>-LICENSE.txt if it
// changed, from https://raw.githubusercontent.com/nodejs/node/v<version>/LICENSE
const EMBEDDED_NODE_VERSION = 'v22.23.2';
const NODE_LICENSE_PATH = path.join(VENDOR_DIR, `node-${EMBEDDED_NODE_VERSION}-LICENSE.txt`);

// 0005: the pin's label (tools/publish's own package.json version, NOT the tag; tags can move and
// don't track the tool version) and full commit SHA are read from vendor/gm-apprentice-publish/PIN.json,
// the single source of truth for which upstream commit is shipped.
const PIN = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
const GM_APPRENTICE_PUBLISH_VERSION = PIN.labels.packageVersion;
const GM_APPRENTICE_PUBLISH_COMMIT = PIN.commit;
const GM_APPRENTICE_PUBLISH_LICENSE_PATH = path.join(VENDOR_DIR, 'gm-apprentice-publish-LICENSE-CODE.txt');

const LICENSE_FILENAME_RE = /^(licen[cs]e|copying|notice)/i;

const SEPARATOR = '='.repeat(78);
const SUBSEPARATOR = '-'.repeat(78);

// Panel v2 V1a: the admin panel's embedded fonts (docs/PROVENANCE.md section 18). Unlike every
// other section above, this reads scripts/vendor/fonts/FONTS.json rather than package-lock.json:
// these are files, not npm packages. sha256 is always computed fresh from the checked-in
// assets/admin/fonts/ copy (never trusted from the manifest), so a changed font trips this gate
// the same way a changed dependency trips notices-freshness.
const FONTS_MANIFEST_PATH = path.join(__dirname, 'vendor', 'fonts', 'FONTS.json');
const FONTS_LICENSE_DIR = path.join(__dirname, 'vendor', 'fonts');
const ADMIN_FONTS_DIR = path.join(ROOT, 'assets', 'admin', 'fonts');
const GLOAM_FONTS_MANIFEST_PATH = path.join(__dirname, 'vendor', 'fonts', 'gloam-FONTS.json');
const GLOAM_FONTS_DIR = path.join(ROOT, 'assets', 'themes', 'gloam', 'fonts');
const OFL_MARKER = 'SIL OPEN FONT LICENSE Version 1.1';

/*
 * ADR 0032 (base theme slice): parameterised out of the admin-fonts-only builder this function
 * used to be, so Section 6 (admin panel fonts) and Section 7 (gloam theme fonts) share one
 * implementation. Section 6's own output is byte-identical to before this change; a test
 * confirms it.
 */
function buildFontsNoticeSection({ manifestPath, fontsDir, title, intro }) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`FAIL: ${manifestPath} does not exist. Cannot build the fonts notices section.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const out = [];
  out.push(SEPARATOR);
  out.push(title);
  out.push(SEPARATOR);
  out.push('');
  out.push(intro);
  out.push('');

  for (const family of manifest.families) {
    const licensePath = path.join(FONTS_LICENSE_DIR, family.licenseFile);
    if (!fs.existsSync(licensePath)) {
      throw new Error(`FAIL: ${licensePath} does not exist (family "${family.family}"). Refusing to produce an incomplete notices file.`);
    }
    const licenseText = fs.readFileSync(licensePath, 'utf8').trimEnd();
    if (!licenseText.includes(OFL_MARKER)) {
      throw new Error(`FAIL: ${licensePath} does not contain "${OFL_MARKER}". Refusing to produce an incomplete notices file.`);
    }

    const files = manifest.files.filter((f) => f.family === family.family);

    out.push(SUBSEPARATOR);
    out.push(`${family.family} (${family.license})`);
    out.push(SUBSEPARATOR);
    out.push('');
    out.push(`Source: ${family.source.repository} at commit ${family.source.commit} (${family.source.path})`);
    out.push(`Reserved Font Name: ${family.reservedFontName}`);
    out.push('Files:');
    for (const f of files) {
      const filePath = path.join(fontsDir, f.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`FAIL: ${filePath} does not exist (manifest entry for "${f.file}"). Refusing to produce an incomplete notices file.`);
      }
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      out.push(`  - ${f.file} (sha256 ${sha256})`);
    }
    out.push('');
    out.push(licenseText);
    out.push('');
  }

  return out;
}

function buildFontsSectionLines() {
  return buildFontsNoticeSection({
    manifestPath: FONTS_MANIFEST_PATH,
    fontsDir: ADMIN_FONTS_DIR,
    title: 'SECTION 6: FONTS EMBEDDED IN THE ADMIN PANEL',
    intro:
      'The admin panel embeds the font files listed below. They are unmodified from their upstream ' +
      "publishers, served only to the GM's own browser on 127.0.0.1 by `scriptorium serve --admin`, " +
      'and never copied into a built, previewed or published site.',
  });
}

function buildGloamFontsSectionLines() {
  return buildFontsNoticeSection({
    manifestPath: GLOAM_FONTS_MANIFEST_PATH,
    fontsDir: GLOAM_FONTS_DIR,
    title: 'SECTION 7: FONTS COPIED INTO SITES BUILT WITH THE GLOAM OR HAZE THEME',
    intro:
      'The gloam and haze themes share the font files listed below (haze names the gloam copy via theme.json fontsFrom, issue #84), repackaged as WOFF2 from their ' +
      "upstream publishers' unmodified TTF files (no change to the font data itself; converted " +
      'with woff2_compress, Debian package woff2 1.0.2-2, upstream google/woff2, Expat/MIT ' +
      'licence -- a build-time tool, not itself redistributed). Every site built with the gloam ' +
      "or haze theme copies these files into scriptorium/theme/fonts/ and lists them, with this same " +
      "licence text, in that site's own NOTICE.txt.",
  });
}

/**
 * Section 8 (docs/decisions/0048-new-campaign-vault.md, section 4): the starter that new vaults are
 * made from is the output of gm-apprentice's vault scaffold, licensed CC BY-SA 4.0. Built from the
 * template manifest and the licence text copied from upstream at the pinned commit.
 */
function buildStarterSectionLines() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'vault-template', 'manifest.json'), 'utf8'));
  const licenseText = fs.readFileSync(path.join(__dirname, 'vendor', 'gm-apprentice-LICENSE-CC-BY-SA-4.0.txt'), 'utf8').trim();
  const stored = new Map();
  for (const system of Object.values(manifest.systems)) for (const entry of Object.values(system.files)) stored.set(entry.store, entry);
  const own = new Set();
  for (const system of Object.values(manifest.systems)) for (const [rel, entry] of Object.entries(system.files)) if (entry.origin === 'scriptorium') own.add(rel);
  const up = manifest.upstream;
  const lines = [];
  lines.push(SEPARATOR);
  lines.push('SECTION 8: THE STARTER FOR NEW VAULTS');
  lines.push(SEPARATOR);
  lines.push('');
  lines.push(
    `When a user starts a new campaign, Scriptorium creates a vault from a starter template embedded in the executable. ` +
      `Most of the starter is the output of the vault scaffold in gm-apprentice (${up.repository}) by AntTheLimey, ` +
      `captured at commit ${up.commit} (plugin version ${up.pluginVersion}, script ${up.script}). That output is licensed ` +
      `under ${manifest.license} (Creative Commons Attribution-ShareAlike 4.0 International): ` +
      'https://creativecommons.org/licenses/by-sa/4.0/legalcode. The complete licence text follows. Each new vault carries a _meta/NOTICE.txt that says the same, so the notice travels with the files.',
  );
  lines.push('');
  lines.push(
    'Changes made to the scaffold output: in _meta/vault-config.md the line "  site: false" is changed to "  site: true"; the campaign name and the creation date are filled in where the scaffold writes them. ' +
      `Files written by Scriptorium and not taken from gm-apprentice: ${[...own].sort().join(', ')}.`,
  );
  lines.push('');
  lines.push('Stored files (the starter keeps files shared by every game system once):');
  for (const [store, entry] of [...stored.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    lines.push(`  ${store} (sha256 ${entry.sha256})`);
  }
  lines.push('');
  lines.push(licenseText);
  lines.push('');
  return lines;
}

function isProdPackage(meta) {
  return !meta.dev && !meta.devOptional && !meta.optional;
}

function nameFromLockPath(lockPath) {
  const parts = lockPath.split('node_modules/');
  return parts[parts.length - 1];
}

function findLicenseFiles(pkgDir) {
  if (!fs.existsSync(pkgDir)) return [];
  return fs
    .readdirSync(pkgDir)
    .filter((f) => fs.statSync(path.join(pkgDir, f)).isFile() && LICENSE_FILENAME_RE.test(f))
    .sort();
}

function readPackageJson(pkgDir) {
  const p = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Collects every distinct (name, version) production dependency, walking nested node_modules via the lockfile. */
function collectProductionEntries() {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const seen = new Map(); // "name@version" -> entry

  for (const [lockPath, meta] of Object.entries(lock.packages)) {
    if (lockPath === '') continue; // the root package itself
    if (!isProdPackage(meta)) continue;

    const name = nameFromLockPath(lockPath);
    if (name === 'gm-apprentice-publish') continue; // Section 1's hardcoded override, not walked here

    const version = meta.version;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;

    const pkgDir = path.join(ROOT, lockPath);
    const pkgJson = readPackageJson(pkgDir);
    const licenseFiles = findLicenseFiles(pkgDir);

    if (licenseFiles.length === 0) {
      throw new Error(
        `FAIL: no LICEN[CS]E*/COPYING*/NOTICE* file found for production dependency ` +
          `${name}@${version} at ${pkgDir}. Add a hardcoded override entry in this script ` +
          `(like gm-apprentice-publish's) or resolve the package's actual licence text before ` +
          `regenerating notices. Refusing to produce an incomplete THIRD-PARTY-NOTICES.txt.`,
      );
    }

    seen.set(key, {
      name,
      version,
      spdx: meta.license || pkgJson.license || 'UNKNOWN',
      lockPath,
      licenseFiles,
      licenseTexts: licenseFiles.map((f) => fs.readFileSync(path.join(pkgDir, f), 'utf8').trimEnd()),
    });
  }

  return [...seen.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

/** PSF clause 3 (argparse 2.0.1): reproduce or point at the "Difference with original" changes summary. */
function extractArgparseChangesSummary(entry) {
  const pkgDir = path.join(ROOT, entry.lockPath);
  const readmePath = path.join(pkgDir, 'README.md');
  if (!fs.existsSync(readmePath)) return null;
  const readme = fs.readFileSync(readmePath, 'utf8');
  const m = readme.match(/\*\*Difference with original\.\*\*([\s\S]*?)\n\n(?:More details|$)/);
  if (!m) return null;
  return `**Difference with original.**${m[1]}`.trim();
}

function lockfileHash() {
  const raw = fs.readFileSync(LOCK_PATH);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Read fresh via fs.readFileSync, consistent with LOCK_PATH above -- avoids the require cache. */
function scriptoriumVersion() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version;
}

function renderEntry(entry) {
  const lines = [];
  lines.push(SUBSEPARATOR);
  lines.push(`${entry.name} ${entry.version} (${entry.spdx})`);
  lines.push(SUBSEPARATOR);
  lines.push('');
  for (const text of entry.licenseTexts) {
    lines.push(text);
    lines.push('');
  }
  if (entry.name === 'argparse' && entry.version === '2.0.1') {
    const summary = extractArgparseChangesSummary(entry);
    lines.push(
      'PSF License Agreement clause 3 requires a brief summary of changes made to Python for any ' +
        'derivative work. This package\'s own README states it (reproduced here verbatim):',
    );
    lines.push('');
    lines.push(
      summary ||
        '(README changes-summary section not found at generation time; see the argparse package README.)',
    );
    lines.push('');
  }
  return lines.join('\n');
}

function buildNoticesText() {
  const entries = collectProductionEntries();
  const gmApprenticeLicense = fs.readFileSync(GM_APPRENTICE_PUBLISH_LICENSE_PATH, 'utf8').trimEnd();
  const nodeLicense = fs.readFileSync(NODE_LICENSE_PATH, 'utf8').trimEnd();
  const hash = lockfileHash();
  const generatedAt = new Date().toISOString();
  const version = scriptoriumVersion();

  const out = [];

  // Section 0: header
  out.push(SEPARATOR);
  out.push('Scriptorium: Third-Party Notices');
  out.push(SEPARATOR);
  out.push('');
  out.push(
    'Scriptorium incorporates the third-party software listed below. Each component is provided ' +
      'under its own licence, reproduced in full.',
  );
  out.push('');
  out.push(`Scriptorium version: ${version}`);
  out.push(`Generated: ${generatedAt}`);
  out.push(`Generated from package-lock.json sha256: ${hash}`);
  out.push(`Generated by: scripts/generate-notices.js`);
  out.push('');

  // Section 1: the generator
  out.push(SEPARATOR);
  out.push('SECTION 1: THE GENERATOR');
  out.push(SEPARATOR);
  out.push('');
  out.push(SUBSEPARATOR);
  out.push(`gm-apprentice-publish ${GM_APPRENTICE_PUBLISH_VERSION} (MIT)`);
  out.push(SUBSEPARATOR);
  out.push('');
  out.push(
    `Scriptorium vendors tools/publish from the ${PIN.repository} repository, pinned to commit ` +
      `${GM_APPRENTICE_PUBLISH_COMMIT} (docs/decisions/0005-generator-pin.md). That directory has no ` +
      'licence file of its own. Its package.json declares MIT. The text below is reproduced from ' +
      `LICENSE-CODE at the repository root at the same commit.`,
  );
  out.push('');
  out.push(gmApprenticeLicense);
  out.push('');

  // Section 2: the npm dependency tree
  out.push(SEPARATOR);
  out.push(`SECTION 2: THE NPM DEPENDENCY TREE (${entries.length} packages)`);
  out.push(SEPARATOR);
  out.push('');
  for (const entry of entries) {
    out.push(renderEntry(entry));
  }

  // Section 3: the embedded Node.js runtime
  out.push(SEPARATOR);
  out.push('SECTION 3: THE EMBEDDED NODE.JS RUNTIME');
  out.push(SEPARATOR);
  out.push('');
  out.push(
    `The packaged executable embeds a Node.js ${EMBEDDED_NODE_VERSION} runtime (via @yao-pkg/pkg / ` +
      '@yao-pkg/pkg-fetch), which statically links OpenSSL, ICU, V8, zlib, and roughly 40 other ' +
      'components. The following is the complete, unedited Node.js LICENSE file for this version, ' +
      'covering all of them. It is not summarised or extracted: Apache-2.0 section 4(a) requires a ' +
      'copy of the licence, and this file is the canonical aggregate.',
  );
  out.push('');
  out.push(
    'Note on GPL text within this file (Node.js LICENSE, ICU4C build-scaffolding section): that text ' +
      'covers ICU4C build-time-only files (aclocal.m4\'s pkg.m4 macro, config.guess, install-sh), each ' +
      'accompanied by the Autoconf Exception. These are source-tree build scaffolding, not linked into ' +
      'a compiled ICU binary, and do not exist in a Node.js binary. There is no GPL obligation on ' +
      'Scriptorium from this.',
  );
  out.push('');
  out.push(nodeLicense);
  out.push('');

  // Section 4: trademark and attribution notices
  out.push(SEPARATOR);
  out.push('SECTION 4: TRADEMARK AND ATTRIBUTION NOTICES');
  out.push(SEPARATOR);
  out.push('');
  out.push(
    'GURPS is a trademark of Steve Jackson Games Incorporated, and its rules and art are copyrighted ' +
      'by Steve Jackson Games Incorporated. All rights are reserved by Steve Jackson Games ' +
      'Incorporated. Scriptorium is not affiliated with, endorsed by, or sponsored by Steve Jackson ' +
      'Games Incorporated. Scriptorium formats GURPS character data supplied by the user. The ' +
      'upstream generator Scriptorium is built from carries a static rules-reference appendix ' +
      'reproducing two combat reference tables from GURPS Basic Set 4th Edition; Scriptorium removes ' +
      'that module when it packages the executable and never executes it, so neither this executable ' +
      'nor any site it builds contains those tables or their page citations. See ' +
      'docs/decisions/0007-rules-content-redaction.md.',
  );
  out.push('');
  out.push(
    'Call of Cthulhu is a trademark of Chaosium Inc. The upstream generator also carries a hardcoded ' +
      'Call of Cthulhu 7th Edition skill list with starting percentages; Scriptorium removes that ' +
      "module the same way. Skill rows on a Call of Cthulhu character page come only from the user's " +
      'own character sheet.',
  );
  out.push('');
  out.push(
    "This work includes material from the System Reference Document 5.2 ('SRD 5.2') by Wizards of " +
      'the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the ' +
      'Creative Commons Attribution 4.0 International License, available at ' +
      'https://creativecommons.org/licenses/by/4.0/legalcode.',
  );
  out.push('');
  out.push(
    'Dungeons & Dragons, Call of Cthulhu, Blades in the Dark, Pathfinder and GURPS are trademarks of ' +
      'their respective owners. Scriptorium is not affiliated with, endorsed by or sponsored by any ' +
      'of them.',
  );
  out.push('');

  // Section 5: pointer for site owners
  out.push(SEPARATOR);
  out.push('SECTION 5: FOR SITE OWNERS');
  out.push(SEPARATOR);
  out.push('');
  out.push(
    'Sites generated by Scriptorium include third-party code (see NOTICE.txt in the generated site). ' +
      'Scriptorium writes that file into every site it builds, listing what is in it. Keep NOTICE.txt ' +
      'when you publish the site.',
  );
  out.push('');

  // Section 6: the admin panel's embedded fonts (panel v2, V1a)
  out.push(...buildFontsSectionLines());

  // Section 7: the gloam theme's embedded fonts (ADR 0032, base theme slice)
  out.push(...buildGloamFontsSectionLines());

  // Section 8: the starter for new vaults (ADR 0048)
  out.push(...buildStarterSectionLines());

  return out.join('\n');
}

/**
 * @param {{ writeFileSync?: Function, statSync?: Function, log?: Function }} [deps]
 *   Overridable for test/notices-main.test.js so a test can point the write/stat pair at a
 *   scratch file instead of the real, committed THIRD-PARTY-NOTICES.txt -- defaults are the
 *   real fs/console calls this script has always made.
 */
function main({ writeFileSync = fs.writeFileSync, statSync = fs.statSync, log = console.log } = {}) {
  const text = buildNoticesText();
  writeFileSync(OUT_PATH, text);
  // #29: text.length is the JS string's UTF-16 code-unit count, not the byte
  // count of what actually landed on disk -- any multi-byte UTF-8 character
  // (an em dash, a curly quote, ...) makes the two diverge. Read the size
  // back from the file writeFileSync just wrote, so this number cannot
  // drift from the file it describes.
  const bytesWritten = statSync(OUT_PATH).size;
  log(`wrote ${OUT_PATH} (${bytesWritten} bytes)`);
}

if (require.main === module) {
  main();
}

module.exports = { collectProductionEntries, buildNoticesText, main };
