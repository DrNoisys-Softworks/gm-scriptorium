'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { IC } = require(path.join(__dirname, '..', 'assets', 'admin', 'icons.js'));
const labels = require(path.join(__dirname, '..', 'src', 'build', 'labels'));

/*
 * V1b SD-11: IC.GLYPHS/GLYPH_NAMES/PATH_DATA_RE are transcribed copies of
 * assets/site/scriptorium.js's TL_GLYPH/PATH_DATA_RE and src/build/labels.js's GLYPH_NAMES.
 * Each copy gets its own drift test here, parsed independently from the source files' raw text
 * (never by requiring scriptorium.js's own internals -- it has no module.exports guard and is
 * frozen/site-side) so a hand-edited IC.GLYPHS that silently diverges from the site's own glyphs
 * is caught.
 */

const SCRIPTORIUM_JS = fs.readFileSync(path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js'), 'utf8');

/** Parses one `<tag attr="v" attr2="v2".../>` element into a [tag, {attr:v,...}] tuple. */
function parseElement(raw) {
  const m = /^<(\w+)\s+([^>]*)\/>$/.exec(raw.trim());
  assert.ok(m, `expected a self-closing element, got: ${raw}`);
  const tag = m[1];
  const attrs = {};
  const attrRe = /([\w-]+)="([^"]*)"/g;
  let am;
  while ((am = attrRe.exec(m[2]))) {
    attrs[am[1]] = am[2];
  }
  return [tag, attrs];
}

/** Parses a TL_GLYPH value ("<tag.../><tag.../>...") into an array of [tag, attrs] tuples. */
function parseGlyphMarkup(markup) {
  const elements = markup.match(/<\w+[^>]*\/>/g) || [];
  return elements.map(parseElement);
}

/** Parses assets/site/scriptorium.js's own `var TL_GLYPH = {...};` literal (lines 50-58) into
 * {name: [[tag,attrs],...]}, independently of IC.GLYPHS's own construction. */
function parseTlGlyph(src) {
  const m = /var TL_GLYPH = \{([\s\S]*?)\n {2}\};/.exec(src);
  assert.ok(m, 'expected a "var TL_GLYPH = {...};" block in assets/site/scriptorium.js');
  const body = m[1];
  const entryRe = /(\S+|'[^']*'):\s*'((?:[^'\\]|\\.)*)',/g;
  const out = {};
  let em;
  while ((em = entryRe.exec(body))) {
    let key = em[1];
    if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1);
    out[key] = parseGlyphMarkup(em[2]);
  }
  return out;
}

test('IC.GLYPHS equals TL_GLYPH parsed independently from assets/site/scriptorium.js:50-58 (7 entries)', () => {
  const expected = parseTlGlyph(SCRIPTORIUM_JS);
  assert.equal(Object.keys(expected).length, 7);
  assert.deepEqual(IC.GLYPHS, expected);
});

test('IC.PATH_DATA_RE.source equals src/build/labels.js PATH_DATA_RE.source', () => {
  assert.equal(IC.PATH_DATA_RE.source, labels.PATH_DATA_RE.source);
});

test('IC.PATH_DATA_RE.source equals the literal at assets/site/scriptorium.js:62', () => {
  const m = /var PATH_DATA_RE = (\/.*\/);/.exec(SCRIPTORIUM_JS);
  assert.ok(m, 'expected a "var PATH_DATA_RE = /.../;" line in assets/site/scriptorium.js');
  // eslint-disable-next-line no-eval
  const literalRe = eval(m[1]);
  assert.equal(IC.PATH_DATA_RE.source, literalRe.source);
});

test('IC.GLYPH_NAMES equals the export from src/build/labels.js (6 entries)', () => {
  assert.deepEqual(IC.GLYPH_NAMES, labels.GLYPH_NAMES);
  assert.equal(IC.GLYPH_NAMES.length, 6);
});
