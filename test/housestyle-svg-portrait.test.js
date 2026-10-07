'use strict';

// Structural regression guard for the .char-header SVG-portrait fix
// (assets/site/scriptorium.css). No layout engine here can actually compute
// aspect-ratio/object-fit (jsdom does not do real layout; a jsdom-driven
// getBoundingClientRect on this property would just read 0s back), so this
// is a source-level check, not a rendering one -- the rendering proof lives
// in the Engineer report's before/after Playwright measurements against a
// scratch build. What this guards against is someone silently deleting the
// rule, loosening its selector to catch raster portraits too, or slipping
// a colour literal into the product-layer file (forbidden by SD-8,
// docs/agent-runs/redesign-engineering-brief-2026-09-20.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

// Isolates the rule body so assertions below can't accidentally match some
// unrelated part of the file that happens to also mention "object-fit".
function ruleBody(css) {
  const selectorIndex = css.indexOf('.char-header .portrait[src$=".svg"');
  assert.notEqual(selectorIndex, -1, 'expected a .char-header .portrait[src$=".svg"...] rule in scriptorium.css');
  const openBrace = css.indexOf('{', selectorIndex);
  const closeBrace = css.indexOf('}', openBrace);
  return css.slice(selectorIndex, closeBrace + 1);
}

test('scriptorium.css declares the SVG char-header portrait rule with a case-insensitive extension match', () => {
  const css = readCss();
  const selectorIndex = css.indexOf('.char-header .portrait[src$=".svg"');
  assert.notEqual(selectorIndex, -1);
  const selectorLine = css.slice(selectorIndex, css.indexOf('{', selectorIndex));
  // [src$=".svg" i] (with the case-insensitivity flag), not a bare
  // [src$=".svg"] -- portraitImg() lowercases nothing on the way in.
  assert.match(selectorLine, /\[src\$=["']\.svg["']\s+i\]/);
});

test('the SVG char-header portrait rule squares the box and does not crop', () => {
  const rule = ruleBody(readCss());
  assert.match(rule, /aspect-ratio:\s*1\s*\/\s*1/, 'expected a 1/1 aspect-ratio to match the sigils\' square content');
  assert.match(rule, /object-fit:\s*contain/, 'expected object-fit:contain so a non-square sigil is not cropped either way');
});

test('the SVG char-header portrait rule caps width using a spacing token, not a bare rem literal', () => {
  const rule = ruleBody(readCss());
  const maxWidthMatch = rule.match(/max-width:\s*([^;]+);/);
  assert.ok(maxWidthMatch, 'expected a max-width declaration');
  assert.match(maxWidthMatch[1], /var\(--sc-space-\d\)/, 'expected the cap to be expressed via an --sc-space-* token per SD-8');
  assert.doesNotMatch(maxWidthMatch[1], /\d+rem/, 'expected no bare rem literal in the max-width value');
});

test('the SVG char-header portrait rule introduces no colour value (SD-8)', () => {
  const rule = ruleBody(readCss());
  // SD-8's permitted colour syntax is var(--...), color-mix() over a var,
  // currentColor, transparent, and #000/#fff only inside a mask/gradient
  // alpha ramp. This rule needs none of that -- it is pure geometry -- so
  // the simplest correct check is that no colour syntax appears at all.
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b/, 'expected no hex colour literal');
  assert.doesNotMatch(rule, /\brgba?\(/, 'expected no rgb()/rgba() colour literal');
  assert.doesNotMatch(rule, /\bcolor-mix\(/, 'expected no color-mix() (this rule has no colour to mix)');
});

test('the SVG char-header portrait rule is scoped to .char-header and does not touch the hero-cinematic or hero-banner portrait paths', () => {
  const css = readCss();
  // PCs and NPCs render through hero-cinematic-img (lib/templates/pc.js,
  // npc.js); locations through hero-banner-img (lib/templates/location.js).
  // Both carry the same raster-shaped assumption as .char-header .portrait
  // did, but nothing in this vault gives either of them an SVG portrait
  // today, so this fix deliberately leaves them alone -- widening the
  // selector to cover them is a scope change, not a fix, and would need its
  // own verification against those templates.
  assert.doesNotMatch(css, /\.hero-cinematic-img\[src\$=/);
  assert.doesNotMatch(css, /\.hero-banner-img\[src\$=/);
});
