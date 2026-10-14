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

test('Section 9 appears once, and Section 10 (the tray helper) follows it', () => {
  const text = buildNoticesText();
  assert.equal(text.split('SECTION 9:').length - 1, 1);
  assert.ok(text.indexOf('SECTION 10:') > text.indexOf('SECTION 9:'));
});

/*
 * Section 10: the Windows tray helper is built with mingw-w64 and links its runtime statically
 * (docs/decisions/0057-windows-desktop-app.md, section 2). The expected facts are written out by hand.
 */

const MINGW_COPYRIGHT_FILE = path.join(__dirname, '..', 'scripts', 'vendor', 'mingw-w64-x86-64-dev-10.0.0-3-copyright.txt');

test('the vendored mingw-w64 copyright file is the Debian mingw-w64-x86-64-dev 10.0.0-3 copyright file, byte for byte', () => {
  // sha256 of /usr/share/doc/mingw-w64-x86-64-dev/copyright from the Debian package
  // mingw-w64-x86-64-dev 10.0.0-3, the version the release machine builds with; the same value is
  // recorded in docs/PROVENANCE.md.
  const hash = crypto.createHash('sha256').update(fs.readFileSync(MINGW_COPYRIGHT_FILE)).digest('hex');
  assert.equal(hash, 'f27a58667538b6913ea23cb9e07e270922761ebf7c22d94bda7f819aaf08ea08');
});

test('Section 10 is the last section, appears once, and names the helper, mingw-w64 and the GCC exception', () => {
  const text = buildNoticesText();
  assert.equal(text.split('SECTION 10:').length - 1, 1);
  assert.equal(text.includes('SECTION 11:'), false);
  const section = text.slice(text.indexOf('SECTION 10: THE WINDOWS TRAY HELPER (MINGW-W64)'));
  assert.ok(section.length > 0 && text.indexOf('SECTION 10: THE WINDOWS TRAY HELPER (MINGW-W64)') > 0);
  for (const needle of [
    'gm-scriptorium-tray-win-x64.exe',
    'gm-scriptorium-tray.exe',
    'mingw-w64',
    'mingw-w64-x86-64-dev 10.0.0-3',
    'gcc-mingw-w64-x86-64-win32',
    'Zope Public License 2.1',
    'GCC Runtime Library Exception',
    'libgcc',
    'License: ZPL-2.1',
  ]) {
    assert.equal(section.includes(needle), true, needle);
  }
  assert.equal(section.includes(fs.readFileSync(MINGW_COPYRIGHT_FILE, 'utf8').trim()), true, 'the whole mingw-w64 licence file is included');
});
