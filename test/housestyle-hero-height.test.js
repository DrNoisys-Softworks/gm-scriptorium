'use strict';

// P3b, S2b: --sc-hero-h fallback in the "Full-bleed hero" section. Mirrors the house style of
// test/housestyle-story.test.js: read the real product stylesheet, assert on its literal text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');

function css() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

test('the .landing-hero rule under "Full-bleed hero" declares height with the --sc-hero-h fallback, exactly once', () => {
  const text = css();
  const bannerIdx = text.indexOf('Full-bleed hero');
  assert.notEqual(bannerIdx, -1, 'expected a "Full-bleed hero" banner comment');
  const ruleIdx = text.indexOf('.landing-hero {', bannerIdx);
  assert.notEqual(ruleIdx, -1, 'expected a .landing-hero rule after the banner');
  const closeIdx = text.indexOf('}', ruleIdx);
  const rule = text.slice(ruleIdx, closeIdx);

  const matches = rule.match(/height:\s*var\(--sc-hero-h,\s*calc\(var\(--sc-space-8\)\s*\*\s*7\)\);/g) || [];
  assert.equal(matches.length, 1, 'expected exactly one height declaration with the --sc-hero-h fallback');
});

test('--sc-hero-h is never declared in scriptorium.css (consumed by the product only, SD-7)', () => {
  const text = css();
  assert.doesNotMatch(text, /--sc-hero-h\s*:/);
});
