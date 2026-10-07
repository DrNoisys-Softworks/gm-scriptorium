'use strict';

// Issue #47: the landing-hero's tagline/date text (css/style.css's
// `.landing-hero .hero-tagline { color: var(--text-on-header, var(--text)); }`) sat on two
// scrims this file adds for legibility -- a bottom-up gradient (.landing-hero::after, "Full-bleed
// hero") and a centred radial pool (.landing-hero::before, "Hero: vignette instead of a flat
// scrim") -- both of which tinted toward `var(--bg)`, the PAGE's general background token.
//
// `--text-on-header` and `--bg`, though, are computed independently by the pin
// (gm-apprentice-publish/lib/theme.js): `--text-on-header` is chosen from the luminance of
// `primary` (which also becomes `--bg-hero`), while `--bg` is chosen from the luminance of
// `background`. A vault is free to set these to different schemes (a light parchment page with a
// dark navy hero banner, say) -- and in that shape, `--bg`-based scrims tint LIGHT while
// `--text-on-header` ALSO resolves light (because it was chosen against dark `--bg-hero`, not
// light `--bg`), so light text sits on a light pool: the tagline goes near-invisible. The fix
// mixes toward `--bg-hero` instead, the token that actually drove the text-colour choice.
//
// No headless browser is available here (no playwright/puppeteer devDependency; checked via
// require.resolve first), so this proves the TOKEN CHOICE is correct, not the rendered pixel:
// it feeds two independent synthetic palettes through the pin's own, already-tested
// generateThemeCSS (ground truth for what a real build would emit; test/theme-scheme.test.js
// already deep-requires the pin the same way for its own parity matrix), and checks that
// whichever token this file's scrims reference lands on the OPPOSITE light/dark side of the
// luminance threshold from --text-on-header, for both a same-scheme (background and primary both
// dark, the haze/dark-campaign shape) and a divergent-scheme (background light, primary dark, the
// bug-triggering shape) palette. The rendered proof lives in the Engineer report's before/after
// screenshots against a scratch build of a light-palette campaign.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { generateThemeCSS } = require('gm-apprentice-publish/lib/theme');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Extracts the body of the first top-level rule (outside any @media wrapper's own selector, but
// this file's target rules are the FIRST thing matching `selector {` after the marker text, brace
// depth tracked so a nested color-mix()/radial-gradient() paren never confuses it) whose selector
// exactly equals `selector`.
function ruleBody(css, selector) {
  const stripped = stripComments(css);
  const needle = `${selector} {`;
  const start = stripped.indexOf(needle);
  assert.notEqual(start, -1, `expected to find "${needle}" in scriptorium.css`);
  const bodyStart = start + needle.length;
  let depth = 1;
  let j = bodyStart;
  while (depth > 0 && j < stripped.length) {
    if (stripped[j] === '{') depth++;
    else if (stripped[j] === '}') depth--;
    j++;
  }
  return stripped.slice(bodyStart, j - 1);
}

// Independently authored (not a copy of anything in src/ or the pin): the standard
// ITU-R BT.601 luma weights, the same formula family lib/theme.js's own luminance() uses, applied
// to hex strings parsed here from scratch.
function relativeLuma(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function isLight(hex) {
  return relativeLuma(hex) > 0.5;
}

function themeVars(palette) {
  const cssText = generateThemeCSS({ palette });
  const vars = {};
  for (const m of cssText.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

// Two synthetic palettes (not any real campaign's values, per NFR-11). "sameScheme": primary and
// background both dark, the haze/dark-campaign shape this fix must not visibly change. "divergent":
// a light background with a dark primary/hero, the exact shape issue #47 reports.
const PALETTES = {
  sameScheme: { primary: '#14120f', accent: '#7a6a4f', background: '#1c1a16', text: '#e5ded0' },
  divergent: { primary: '#101820', accent: '#889900', background: '#fdf6e3', text: '#222222' },
};

// The token this file's two hero scrims are expected to reference post-fix. Extracted from the
// CSS text itself (not hardcoded) so a future rename of the property is exercised too, but the
// SELECTION between --bg and --bg-hero is exactly what issue #47 is about.
function scrimToken(body) {
  const m = body.match(/color-mix\(in srgb, var\((--[a-z-]+)\)/);
  assert.ok(m, `expected a color-mix(in srgb, var(--...)) in: ${body.slice(0, 120)}`);
  return m[1];
}

for (const selector of ['.landing-hero::after', '.landing-hero::before']) {
  test(`${selector}: does not tint toward --bg (issue #47's exact defect shape)`, () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const body = ruleBody(css, selector);
    assert.doesNotMatch(
      body,
      /color-mix\(in srgb, var\(--bg\)/,
      `${selector} should not mix toward --bg (the page background token); it should mix toward --bg-hero`,
    );
  });

  test(`${selector}: the token it mixes toward lands opposite --text-on-header's light/dark side, for both a same-scheme and a divergent-scheme palette`, () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const body = ruleBody(css, selector);
    const token = scrimToken(body).replace(/^--/, '');

    for (const [name, palette] of Object.entries(PALETTES)) {
      const vars = themeVars(palette);
      assert.ok(vars['text-on-header'], `${name}: expected --text-on-header in generateThemeCSS output`);
      assert.ok(vars[token], `${name}: expected --${token} in generateThemeCSS output`);

      const textLight = isLight(vars['text-on-header']);
      const scrimLight = isLight(vars[token]);
      assert.notEqual(
        textLight,
        scrimLight,
        `${name}: --text-on-header (${vars['text-on-header']}, light=${textLight}) and --${token} ` +
          `(${vars[token]}, light=${scrimLight}) should be on opposite sides for readable contrast`,
      );
    }
  });
}

test('regression fixture: mixing toward --bg (not --bg-hero) fails the contrast check on the divergent palette (mutation proof for the helpers above)', () => {
  const vars = themeVars(PALETTES.divergent);
  const textLight = isLight(vars['text-on-header']);
  const bgLight = isLight(vars['bg']);
  assert.equal(textLight, bgLight, 'sanity: on the divergent palette, --text-on-header and --bg land on the SAME side (both light) -- exactly the invisible-tagline shape');
});
