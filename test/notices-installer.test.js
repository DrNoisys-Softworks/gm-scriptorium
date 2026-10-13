'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { buildNoticesText } = require('../scripts/generate-notices');

/*
 * Section 9 of THIRD-PARTY-NOTICES.txt: the Windows installer is built with NSIS
 * (docs/decisions/0053-windows-installer.md). The expected facts are written out by hand.
 */

const COPYRIGHT_FILE = path.join(__dirname, '..', 'scripts', 'vendor', 'nsis-3.08-copyright.txt');

test('the vendored NSIS copyright file is the Debian nsis 3.08 package copyright file, byte for byte', () => {
  // sha256 of /usr/share/doc/nsis/copyright from the Debian package nsis 3.08-3+deb12u1, the version
  // the release machine builds with; the same value is recorded in docs/PROVENANCE.md.
  const hash = crypto.createHash('sha256').update(fs.readFileSync(COPYRIGHT_FILE)).digest('hex');
  assert.equal(hash, 'd2b03d11801736ff4fda2a1e215a13c324dca7fd76eb948ae7d835000fe339d3');
});

test('Section 9 comes after Section 8 and names NSIS, its licences and the files that carry it', () => {
  const text = buildNoticesText();
  const s8 = text.indexOf('SECTION 8: THE STARTER FOR NEW VAULTS');
  const s9 = text.indexOf('SECTION 9: THE WINDOWS INSTALLER (NSIS)');
  assert.ok(s8 > 0 && s9 > s8, 'Section 9 follows Section 8');
  const section = text.slice(s9);
  for (const needle of [
    'NSIS 3.08',
    'zlib/libpng',
    'Common Public Licence',
    'bzip2',
    'gm-scriptorium-setup-win-x64.exe',
    'Uninstall GM-Scriptorium.exe',
    'compression off',
    'License: Zlib',
    'License: lzma-cpl-exception',
  ]) {
    assert.equal(section.includes(needle), true, needle);
  }
  assert.equal(section.includes(fs.readFileSync(COPYRIGHT_FILE, 'utf8').trim()), true, 'the whole NSIS licence file is included');
});

test('Section 9 is the last section and appears once', () => {
  const text = buildNoticesText();
  assert.equal(text.split('SECTION 9:').length - 1, 1);
  assert.equal(text.includes('SECTION 10:'), false);
});
