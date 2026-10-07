'use strict';

// Structural regression guard for the "Into the Haze home" product-layer shell section
// (assets/site/scriptorium.css, "Landing shell: full-bleed below 1024" section), following the
// pattern of test/housestyle-character-header.test.js (helpers copied verbatim from there). No
// layout engine here can actually compute cascade winners (jsdom does not do real CSS cascade
// resolution), so this is a source-level check, not a rendering one -- the rendering proof lives
// in the Engineer report's before/after Playwright measurements against a scratch build. What
// this guards against is someone widening a selector past main.content:has(> .landing-hero)
// (SD-2's product/campaign split), slipping a colour literal or !important into the product-layer
// file (forbidden by SD-8), or moving the section's banner comment so it no longer starts with
// "/* ====" (the same trap test/housestyle-character-header.test.js's T3 proves is real).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');
const MARKER = 'Landing shell: full-bleed below 1024';

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

// Removes /* ... */ comments so a comment mentioning a property or literal can never be mistaken
// for a declaration.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Slices from the section's own "/* ====" banner opener (the marker text sits a couple of lines
// into the same comment, not on the opener's own line -- unlike housestyle-character-header's
// single-line banner) to the next top-level "/* ====" banner comment or end of file. Asserts the
// marker is present so every other test below fails loudly (not silently on an empty section)
// when the section is missing entirely.
function section(css) {
  const markerIndex = css.indexOf(MARKER);
  assert.notEqual(markerIndex, -1, `expected the section marker "${MARKER}" in scriptorium.css`);
  const bannerIndex = css.lastIndexOf('\n/* ====', markerIndex);
  assert.notEqual(bannerIndex, -1, 'expected a "/* ====" banner before the marker');
  const lineStart = bannerIndex + 1;
  const nextBanner = css.indexOf('\n/* ====', markerIndex);
  const sectionEnd = nextBanner === -1 ? css.length : nextBanner;
  return css.slice(lineStart, sectionEnd);
}

// Collects every selector list in `sec`, with @media preludes stripped out and comments removed.
function selectors(sec) {
  const noComments = stripComments(sec);
  const withoutMediaPreludes = noComments.replace(/@media[^{]*\{/g, '');
  const out = [];
  for (const m of withoutMediaPreludes.matchAll(/([^{}]+)\{/g)) {
    for (const sel of m[1].split(',')) {
      const trimmed = sel.trim().replace(/\s+/g, ' ');
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

test('T1: the section exists, banner starts with "/* ====" (character-header T3 trap)', () => {
  const css = readCss();
  const markerIndex = css.indexOf(MARKER);
  assert.notEqual(markerIndex, -1);
  const bannerIndex = css.lastIndexOf('\n/* ====', markerIndex);
  assert.notEqual(bannerIndex, -1);
  assert.equal(css.slice(bannerIndex + 1, bannerIndex + 1 + 7), '/* ====', 'the section banner must start with "/* ===="');
});

test('T2: every selector in the section starts with "main.content:has(> .landing-hero)"', () => {
  const sec = section(readCss());
  const sels = selectors(sec);
  assert.ok(sels.length > 0, 'expected at least one selector in the section');
  for (const sel of sels) {
    assert.ok(
      sel.startsWith('main.content:has(> .landing-hero)'),
      `selector "${sel}" does not start with main.content:has(> .landing-hero)`
    );
  }
});

test('T3: the exact three rules from the Engineering Brief are present', () => {
  const sec = stripComments(section(readCss())).replace(/\s+/g, ' ');
  assert.match(sec, /main\.content:has\(> \.landing-hero\)\s*\{\s*max-width:\s*none;\s*padding-inline:\s*0;\s*padding-top:\s*0;\s*\}/);
  assert.match(sec, /@media \(max-width: ?1023px\)/);
  assert.match(
    sec,
    /main\.content:has\(> \.landing-hero\) > \.dashboard-section\s*\{\s*padding-inline:\s*var\(--sc-space-4\);\s*\}/
  );
  assert.match(
    sec,
    /main\.content:has\(> \.landing-hero\) > \.landing-hero\s*\{\s*border-radius:\s*0;\s*\}/
  );
});

test('T4: no colour literal and no !important (SD-8)', () => {
  const codeOnly = stripComments(section(readCss()));
  assert.doesNotMatch(codeOnly, /#[0-9a-fA-F]{3,8}\b/, 'expected no hex colour literal');
  assert.doesNotMatch(codeOnly, /\brgba?\(/, 'expected no rgb()/rgba() colour literal');
  assert.doesNotMatch(codeOnly, /\bcolor-mix\(/, 'expected no color-mix()');
  assert.doesNotMatch(codeOnly, /!important/, 'expected no !important');
});

test('T5: no bare length literal outside an @media prelude', () => {
  const sec = section(readCss());
  const stripped = stripComments(sec).replace(/@media[^{]*\{/g, '');
  assert.doesNotMatch(
    stripped,
    /\d(?:\.\d+)?(rem|px|em|vh|vw)\b/,
    'expected every length to be a token, 0, or a percentage -- no bare unit literal outside @media preludes'
  );
});
