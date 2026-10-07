'use strict';

// Issue #84: no shipped theme CSS may reach a third-party font origin. Walks every directory under
// assets/themes (and the composed CSS loadTheme returns), so a newly added theme is covered with
// no edit here. Independent literals; the synthetic cases prove the detector can fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { THEMES, loadTheme } = require('../src/build/themes');

const THEMES_DIR = path.join(__dirname, '..', 'assets', 'themes');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Returns offending constructs: any @import of an absolute/protocol-relative URL, and any
 * absolute or protocol-relative url() (fonts or otherwise) in theme CSS. */
function remoteRefs(css) {
  const c = stripComments(css);
  const out = [];
  for (const m of c.matchAll(/@import\s+(?:url\(\s*)?['"]?\s*((?:https?:)?\/\/[^'")\s;]+)/gi)) out.push(m[1]);
  for (const m of c.matchAll(/url\(\s*['"]?\s*((?:https?:)?\/\/[^'")\s]+)/gi)) out.push(m[1]);
  for (const m of c.matchAll(/https?:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^\s'")]*/gi)) out.push(m[0]);
  return out;
}

test('every shipped theme.css (raw and composed) has no remote @import, no remote url()', () => {
  const dirs = fs.readdirSync(THEMES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(dirs.includes('haze') && dirs.includes('gloam'));
  for (const d of dirs) {
    const raw = fs.readFileSync(path.join(THEMES_DIR, d, 'theme.css'), 'utf8');
    assert.deepEqual(remoteRefs(raw), [], `${d}/theme.css references a remote origin`);
  }
  for (const name of Object.keys(THEMES)) {
    if (THEMES[name].dir === null) continue;
    assert.deepEqual(remoteRefs(loadTheme(name).css), [], `composed CSS of ${name} references a remote origin`);
  }
});

test('positive control: the detector flags a Google Fonts @import and a gstatic url()', () => {
  assert.deepEqual(remoteRefs("@import url('https://fonts.googleapis.com/css2?family=X');").length > 0, true);
  assert.deepEqual(remoteRefs('@import "//fonts.example/x.css";').length > 0, true);
  assert.ok(remoteRefs('@font-face{src:url(https://fonts.gstatic.com/s/x.woff2)}').length > 0);
  assert.deepEqual(remoteRefs('/* @import url(https://fonts.googleapis.com/x); */ a{b:c}'), []);
  assert.deepEqual(remoteRefs('@font-face{src:url("../scriptorium/theme/fonts/a.woff2")}'), []);
});

test('haze shares gloam\'s 5 font files and NOTICE (one copy on disk), sha256 matching gloam-FONTS.json', () => {
  const crypto = require('crypto');
  assert.ok(!fs.existsSync(path.join(THEMES_DIR, 'haze', 'fonts')), 'haze must not carry its own fonts/');
  assert.ok(!fs.existsSync(path.join(THEMES_DIR, 'haze', 'NOTICE.txt')), 'haze must not carry its own NOTICE.txt');
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vendor', 'fonts', 'gloam-FONTS.json'), 'utf8'));
  const { loadTheme } = require('../src/build/themes');
  const haze = loadTheme('haze');
  const gloam = loadTheme('gloam');
  assert.equal(haze.fonts.length, 5);
  assert.deepEqual(haze.fonts, gloam.fonts);
  assert.deepEqual(haze.fonts.map((f) => f.rel).sort(), m.files.map((f) => f.file).sort());
  for (const f of m.files) {
    const font = haze.fonts.find((x) => x.rel === f.file);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(font.abs)).digest('hex'), f.sha256, f.file);
  }
  assert.ok(haze.notice.includes('SIL OPEN FONT LICENSE Version 1.1'));
  assert.equal(haze.notice, gloam.notice);
});
