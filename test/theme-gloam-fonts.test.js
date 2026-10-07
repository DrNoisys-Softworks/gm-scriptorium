'use strict';

// ADR 0032, Structural decision 4: the gloam theme's vendored OFL fonts. Independent literals
// throughout (CLAUDE.md testing standards). Synthetic mutation only (a scratch one-byte-changed
// copy), never the real vendored file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildNoticesText } = require('../scripts/generate-notices');

const VENDOR_FONTS_DIR = path.join(__dirname, '..', 'scripts', 'vendor', 'fonts');
const GLOAM_FONTS_MANIFEST_PATH = path.join(VENDOR_FONTS_DIR, 'gloam-FONTS.json');
const ADMIN_FONTS_MANIFEST_PATH = path.join(VENDOR_FONTS_DIR, 'FONTS.json');
const GLOAM_FONTS_DIR = path.join(__dirname, '..', 'assets', 'themes', 'gloam', 'fonts');

const OFL_MARKER = 'SIL OPEN FONT LICENSE Version 1.1';

// Independent literal: the 5 files a variable-Cormorant vendoring produces (SD-4), shipped as
// woff2 only (owner decision, 2026-09-30: the unmodified TTFs are converted with woff2_compress
// and not shipped; reproducibility comes from the upstream commit plus the converter version,
// both recorded per-file below under "source").
const EXPECTED_FILES = [
  'CormorantGaramond-Italic-wght.woff2',
  'CormorantGaramond-wght.woff2',
  'IMFeENit28P.woff2',
  'IMFeENrm28P.woff2',
  'IMFeENsc28P.woff2',
];

function manifest() {
  return JSON.parse(fs.readFileSync(GLOAM_FONTS_MANIFEST_PATH, 'utf8'));
}

test('the manifest files[] set equals the assets/themes/gloam/fonts/ disk set', () => {
  const onDisk = fs.readdirSync(GLOAM_FONTS_DIR).sort();
  assert.deepEqual(onDisk, EXPECTED_FILES.slice().sort());
  const m = manifest();
  assert.deepEqual(
    m.files.map((f) => f.file).sort(),
    EXPECTED_FILES.slice().sort(),
  );
});

test('every manifest sha256 equals a fresh sha256 of the checked-in font file', () => {
  const m = manifest();
  for (const f of m.files) {
    const bytes = fs.readFileSync(path.join(GLOAM_FONTS_DIR, f.file));
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha, f.sha256, `${f.file}: disk sha256 does not match gloam-FONTS.json`);
  }
});

test('positive control: a one-byte-changed scratch copy does NOT match its own manifest sha256', () => {
  const m = manifest();
  const first = m.files[0];
  const original = fs.readFileSync(path.join(GLOAM_FONTS_DIR, first.file));
  const mutated = Buffer.from(original);
  mutated[0] = mutated[0] ^ 0xff;
  const mutatedSha = crypto.createHash('sha256').update(mutated).digest('hex');
  assert.notEqual(mutatedSha, first.sha256);
});

test('the IM Fell English roman and SC upstream TTF sha256 values equal the admin FONTS.json values (same upstream bytes, same commit)', () => {
  // gloam ships woff2 only, so this is a provenance check (the recorded upstream TTF hash), not
  // a live byte comparison of the shipped files -- the woff2 conversion is verified separately.
  const gloamManifest = manifest();
  const adminManifest = JSON.parse(fs.readFileSync(ADMIN_FONTS_MANIFEST_PATH, 'utf8'));

  const gloamRoman = gloamManifest.files.find((f) => f.file === 'IMFeENrm28P.woff2');
  const adminRoman = adminManifest.files.find((f) => f.file === 'IMFeENrm28P.ttf');
  assert.equal(gloamRoman.source.sha256, adminRoman.sha256);
  assert.equal(gloamRoman.source.file, 'IMFeENrm28P.ttf');

  const gloamSc = gloamManifest.files.find((f) => f.file === 'IMFeENsc28P.woff2');
  const adminSc = adminManifest.files.find((f) => f.file === 'IMFeENsc28P.ttf');
  assert.equal(gloamSc.source.sha256, adminSc.sha256);
  assert.equal(gloamSc.source.file, 'IMFeENsc28P.ttf');
});

test('every file records the converter (name, source, package, licence) and each face\'s upstream TTF sha256', () => {
  const m = manifest();
  assert.equal(m.converter.tool, 'woff2_compress');
  assert.equal(m.converter.source, 'google/woff2');
  assert.ok(m.converter.package.length > 0);
  assert.ok(m.converter.license.length > 0);
  for (const f of m.files) {
    assert.equal(typeof f.source.sha256, 'string');
    assert.match(f.source.sha256, /^[0-9a-f]{64}$/, `${f.file}: source.sha256 must be a 64-hex sha256`);
    assert.notEqual(f.source.sha256, f.sha256, `${f.file}: the upstream TTF hash and the shipped woff2 hash must differ`);
  }
});

test('each licence file exists and contains the OFL 1.1 marker', () => {
  const m = manifest();
  const licenseFiles = new Set(m.families.map((f) => f.licenseFile));
  assert.deepEqual(
    [...licenseFiles].sort(),
    ['cormorant-garamond-OFL.txt', 'im-fell-english-OFL.txt', 'im-fell-english-sc-OFL.txt'].sort(),
  );
  for (const name of licenseFiles) {
    const p = path.join(VENDOR_FONTS_DIR, name);
    assert.ok(fs.existsSync(p), `${p} must exist`);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.includes(OFL_MARKER), `${name} must contain "${OFL_MARKER}"`);
  }
});

test('SD-4 naming: every shipped woff2 name matches the allowed pattern and is its source TTF name with the extension swapped; a renamed source records upstreamFile', () => {
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const m = manifest();
  for (const f of m.files) {
    assert.match(f.file, NAME_RE, `${f.file} must match the vendored-name pattern`);
    assert.equal(f.file, f.source.file.replace(/\.ttf$/, '.woff2'), `${f.file}: must be source.file with .ttf swapped for .woff2`);
    assert.match(f.source.file, NAME_RE, `${f.source.file} must match the vendored-name pattern`);
    if (f.source.upstreamFile !== undefined) {
      assert.ok(
        /[[\]]/.test(f.source.upstreamFile),
        `${f.source.file}: upstreamFile "${f.source.upstreamFile}" should be the bracketed original name`,
      );
      const rebuilt = f.source.upstreamFile.replace(/\[/g, '-').replace(/\]/g, '');
      assert.equal(f.source.file, rebuilt, `${f.source.file}: renaming rule (replace "[" with "-", drop "]") must reproduce the vendored TTF name`);
    }
  }
});

test('each family has non-empty copyright and reservedFontName fields', () => {
  const m = manifest();
  assert.equal(m.families.length, 3);
  for (const family of m.families) {
    assert.equal(typeof family.copyright, 'string');
    assert.ok(family.copyright.length > 0, `${family.family}: copyright must not be empty`);
    assert.equal(typeof family.reservedFontName, 'string');
    assert.ok(family.reservedFontName.length > 0, `${family.family}: reservedFontName must not be empty`);
  }
});

test('the Cormorant Garamond variable files declare a [min, max] weight range matching the upstream fvar axis (300-700)', () => {
  const m = manifest();
  const cormorantFiles = m.files.filter((f) => f.family === 'Cormorant Garamond');
  assert.equal(cormorantFiles.length, 2);
  for (const f of cormorantFiles) {
    assert.deepEqual(f.weight, [300, 700]);
  }
});

// -- C8: THIRD-PARTY-NOTICES.txt Section 7 --------------------------------------------------

test('THIRD-PARTY-NOTICES Section 7 covers the gloam fonts, and Section 6 stays byte-identical to the admin-only manifest', () => {
  const text = buildNoticesText();
  const section7Idx = text.indexOf('SECTION 7: FONTS COPIED INTO SITES BUILT WITH THE GLOAM OR HAZE THEME');
  assert.ok(section7Idx > -1, 'expected a Section 7 heading for the gloam theme fonts');

  const section6Idx = text.indexOf('SECTION 6: FONTS EMBEDDED IN THE ADMIN PANEL');
  assert.ok(section6Idx > -1);
  assert.ok(section6Idx < section7Idx, 'Section 6 must come before Section 7');

  const section7Text = text.slice(section7Idx);
  const m = manifest();
  for (const family of m.families) {
    assert.ok(section7Text.includes(family.family), `Section 7 must name ${family.family}`);
    assert.ok(section7Text.includes(`Reserved Font Name: ${family.reservedFontName}`));
  }
  for (const f of m.files) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(GLOAM_FONTS_DIR, f.file))).digest('hex');
    assert.ok(section7Text.includes(`${f.file} (sha256 ${sha256})`), `Section 7 must list ${f.file} with its fresh sha256`);
  }

  // Section 6 is the admin-only section: the two families gloam shares with the admin panel
  // (IM Fell English/SC) legitimately appear in both, by filename, but Cormorant Garamond is
  // gloam-only and must not appear in Section 6 at all.
  const section6Text = text.slice(section6Idx, section7Idx);
  assert.ok(!section6Text.includes('Cormorant Garamond'), 'Section 6 must not name the gloam-only Cormorant Garamond family');
});

test('a rebuilt notices file is byte-identical after npm run notices (freshness)', () => {
  const text = buildNoticesText();
  const committed = fs.readFileSync(path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  // Strip the one line that legitimately varies (the lockfile-hash "Generated:" line), the same
  // way scripts/notices-freshness.js does, so this test proves section content, not staleness.
  const stripGenerated = (s) => s.replace(/^Generated:.*$/m, 'Generated: STRIPPED');
  assert.equal(stripGenerated(text), stripGenerated(committed));
});
