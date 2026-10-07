'use strict';

// Structural regression guard for the character-header headline treatment
// (assets/site/scriptorium.css, "Character headers: headline placement"
// section). No layout engine here can actually compute flex geometry or
// :has() cascade winners (jsdom does not do real layout or CSS cascade
// resolution), so this is a source-level check, not a rendering one -- the
// rendering proof lives in the Engineer report's before/after Playwright
// measurements against a scratch build. What this guards against is someone
// silently deleting a rule, widening a selector past the character hooks
// (pc.js/npc.js only, per SD-7), reintroducing the Vellum lip on the
// character path, slipping a colour literal or !important into the
// product-layer file (forbidden by SD-8), or mirroring the pin's 600px
// breakpoint instead of beating it on specificity.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');
const MARKER = 'Character headers: headline placement';

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

// Removes /* ... */ comments so a comment mentioning a property or literal
// (e.g. this file's own header prose, or the target section's rationale)
// can never be mistaken for a declaration.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Slices from the marker line to the next top-level "/* ====" banner comment
// or end of file. Asserts the marker is present so every other test below
// fails loudly (not silently on an empty section) when the section is
// missing entirely -- the state at HEAD.
function section(css) {
  const markerIndex = css.indexOf(MARKER);
  assert.notEqual(markerIndex, -1, `expected the section marker "${MARKER}" in scriptorium.css`);
  const lineStart = css.lastIndexOf('\n', markerIndex) + 1;
  const nextBanner = css.indexOf('\n/* ====', markerIndex);
  const sectionEnd = nextBanner === -1 ? css.length : nextBanner;
  return css.slice(lineStart, sectionEnd);
}

// Splits a section into { blocks: [{ query, body }], outside } where
// `blocks` are the (balanced-brace) bodies of top-level @media rules and
// `outside` is everything else with those blocks removed. Handles nested
// braces inside a media body (one level of rule nesting) by brace-counting
// rather than a single non-greedy regex, which would stop at the first `}`
// inside the block.
function extractMediaBlocks(sec) {
  const blocks = [];
  let outside = '';
  let lastIndex = 0;
  const mediaRe = /@media\s*([^{]*)\{/g;
  let match;
  while ((match = mediaRe.exec(sec))) {
    outside += sec.slice(lastIndex, match.index);
    const bodyStart = mediaRe.lastIndex;
    let depth = 1;
    let j = bodyStart;
    while (depth > 0 && j < sec.length) {
      if (sec[j] === '{') depth++;
      else if (sec[j] === '}') depth--;
      j++;
    }
    blocks.push({ query: match[1].trim(), body: sec.slice(bodyStart, j - 1) });
    lastIndex = j;
    mediaRe.lastIndex = j;
  }
  outside += sec.slice(lastIndex);
  return { blocks, outside };
}

// Whitespace-normalises a comma-separated selector list so multi-line
// selectors ("a,\nb {") and single-line selectors ("a, b {") compare equal.
function normalizeSelectorList(str) {
  return str
    .split(',')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .join(', ');
}

// Collects every selector list in `sec`, with @media preludes stripped out
// (so the prelude's own "(min-width: 1024px)" text is never mistaken for a
// selector) and comments removed. Returns individual selectors (already
// split on ",") as a flat list, whitespace-normalised.
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

function findRuleBody(text, exactSelectorList) {
  const target = normalizeSelectorList(exactSelectorList);
  const noComments = stripComments(text);
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (normalizeSelectorList(m[1]) === target) return m[2];
  }
  return null;
}

// Finds the rule body whose whitespace-normalised selector list matches
// `exactSelectorList` exactly, either outside every @media block (default)
// or inside the @media block whose prelude equals `opts.inMedia` exactly.
function ruleBody(sec, exactSelectorList, opts = {}) {
  // Comments must be stripped before brace-matching: this section's own
  // header prose discusses "@media (max-width: 600px)" in plain English
  // (decision 3), and a naive brace scan run on raw text would mistake that
  // prose for a real @media prelude.
  const { blocks, outside } = extractMediaBlocks(stripComments(sec));
  if (opts.inMedia) {
    const target = opts.inMedia.replace(/\s+/g, ' ').trim();
    const block = blocks.find((b) => b.query.replace(/\s+/g, ' ').trim() === target);
    assert.ok(block, `expected an @media ${opts.inMedia} block in the section`);
    const body = findRuleBody(block.body, exactSelectorList);
    assert.notEqual(body, null, `expected rule "${exactSelectorList}" inside @media ${opts.inMedia}`);
    return body;
  }
  const body = findRuleBody(outside, exactSelectorList);
  assert.notEqual(body, null, `expected rule "${exactSelectorList}" outside @media`);
  return body;
}

test('T1: .hero-cinematic loses the card and becomes a centred column', () => {
  const sec = section(readCss());
  const body = ruleBody(sec, '.hero-cinematic');
  assert.match(body, /flex-direction:\s*column\b/);
  assert.match(body, /align-items:\s*center\b/);
  assert.match(body, /background:\s*none\b/);
  assert.match(body, /border:\s*(none|0)\b/);
  assert.match(body, /border-radius:\s*0\b/);
  assert.match(body, /padding:\s*0\b/);
  assert.match(body, /box-shadow:\s*none\b/);
});

test('T2: .hero-banner-no-img with a direct .pc-portrait child loses the card', () => {
  const sec = section(readCss());
  const body = ruleBody(sec, '.hero-banner-no-img:has(> .pc-portrait)');
  assert.match(body, /background:\s*none\b/);
  assert.match(body, /min-height:\s*0\b/);
  assert.match(body, /padding:\s*0\b/);
  assert.match(body, /border-radius:\s*0\b/);
  assert.match(body, /box-shadow:\s*none\b/);
  assert.match(body, /align-items:\s*center\b/);
});

test('T3: every selector in the section is scoped to the character hooks (SD-7)', () => {
  const sec = section(readCss());
  const sels = selectors(sec);
  assert.ok(sels.length > 0, 'expected at least one selector in the section');
  for (const sel of sels) {
    assert.ok(
      sel.startsWith('.hero-cinematic') || sel.startsWith('.hero-banner-no-img:has(> .pc-portrait)'),
      `selector "${sel}" does not start with .hero-cinematic or .hero-banner-no-img:has(> .pc-portrait)`
    );
    assert.doesNotMatch(sel, /\.char-header/, `selector "${sel}" must not touch .char-header (out of scope)`);
    assert.doesNotMatch(sel, /\.pc-card/, `selector "${sel}" must not touch .pc-card (landing cards, out of scope)`);
    assert.doesNotMatch(sel, /\.landing/, `selector "${sel}" must not touch .landing (out of scope)`);
    assert.notEqual(sel, '.hero-banner', 'must not be a bare .hero-banner selector (locations would be caught too)');
    assert.notEqual(
      sel,
      '.hero-banner-no-img',
      'must not be a bare .hero-banner-no-img selector (location-without-art has no .pc-portrait and must be excluded)'
    );
    assert.notEqual(sel, '.hero-banner-img', 'must not touch .hero-banner-img (location-with-art, out of scope)');
    assert.notEqual(sel, '.pc-portrait', 'must not target .pc-portrait on its own (would reach the landing party cards too)');
  }
});

test('T4: the Vellum lip rule on .hero-banner/.hero-banner-no-img is untouched (guard against editing 845-848 instead of appending)', () => {
  const css = readCss();
  const idx = css.indexOf('.hero-banner,\n.hero-banner-no-img {');
  assert.notEqual(idx, -1, 'expected the unedited ".hero-banner,\\n.hero-banner-no-img {" rule to still exist verbatim');
  const openBrace = css.indexOf('{', idx);
  const closeBrace = css.indexOf('}', openBrace);
  const body = css.slice(openBrace, closeBrace);
  assert.match(body, /inset 0 1px 0 var\(--sc-lip\)/, 'expected the Vellum lip box-shadow to survive so locations keep it');
});

test('T5: .hero-cinematic-img is fixed height, preserves the whole image, never wider than its container', () => {
  const sec = section(readCss());
  const selectorList = '.hero-cinematic > .hero-cinematic-img';

  const body = ruleBody(sec, selectorList);
  assert.match(body, /width:\s*auto\b/);
  assert.match(body, /height:\s*calc\(var\(--sc-space-8\)\s*\*\s*4\.5\)/, 'expected 18rem (288px) via calc(var(--sc-space-8) * 4.5)');
  assert.match(body, /max-width:\s*100%/);
  assert.match(body, /object-fit:\s*contain\b/);
  assert.doesNotMatch(body, /\bcover\b/, 'must not crop with object-fit: cover');

  const bodyAt1024 = ruleBody(sec, selectorList, { inMedia: '(min-width: 1024px)' });
  assert.match(bodyAt1024, /height:\s*calc\(var\(--sc-space-8\)\s*\*\s*6\)/, 'expected 24rem (384px) via calc(var(--sc-space-8) * 6)');
});

test('T6: the image rule neutralises the pin\'s 600px breakpoint by specificity, not by mirroring it', () => {
  const sec = section(readCss());
  const imageSelector = '.hero-cinematic > .hero-cinematic-img';
  const classCount = (imageSelector.match(/\.[a-zA-Z-]+/g) || []).length;
  assert.ok(
    classCount >= 2,
    `expected the image selector to carry at least 2 class selectors for (0,2,0) specificity against the pin's (0,1,0) media rule, got ${classCount}`
  );
  const body = ruleBody(sec, imageSelector);
  assert.match(body, /\bwidth\s*:/, 'expected width to be declared unconditionally');
  assert.match(body, /\bheight\s*:/, 'expected height to be declared unconditionally');
  // Comments are stripped before this check: decision 3 requires the header
  // comment to discuss the pin's "@media (max-width: 600px)" block by name,
  // which would otherwise self-defeat this assertion.
  assert.doesNotMatch(stripComments(sec), /max-width:\s*600px/, 'must not add a mirror @media (max-width: 600px) block');
});

test('T7: the section introduces no colour literal and no !important (SD-8)', () => {
  // Comments are stripped before these checks: decision 8 requires the
  // header comment to name "the rejected !important" as prose (decision 5),
  // which would otherwise self-defeat the !important assertion below. The
  // checks themselves are about the CSS the section actually ships, not its
  // documentation of a rejected alternative.
  const codeOnly = stripComments(section(readCss()));
  assert.doesNotMatch(codeOnly, /#[0-9a-fA-F]{3,8}\b/, 'expected no hex colour literal');
  assert.doesNotMatch(codeOnly, /\brgba?\(/, 'expected no rgb()/rgba() colour literal');
  assert.doesNotMatch(codeOnly, /\bcolor-mix\(/, 'expected no color-mix() (this section has no colour to mix)');
  assert.doesNotMatch(codeOnly, /!important/, 'expected no !important (the badge decision explicitly rejects it)');
});

test('T8: the h1 uses .page-title\'s type step (1.75rem base, var(--sc-step-3) at >=1024)', () => {
  const sec = section(readCss());
  const selectorList = '.hero-cinematic h1, .hero-banner-no-img:has(> .pc-portrait) > h1';

  const body = ruleBody(sec, selectorList);
  const fontSizeMatch = body.match(/font-size:\s*([^;]+);/);
  assert.ok(fontSizeMatch, 'expected a font-size declaration in the base h1 rule');
  assert.match(fontSizeMatch[1], /var\(--sc-space-4\)/, 'expected the base size expressed via var(--sc-space-4)');
  assert.match(fontSizeMatch[1], /1\.75/, 'expected the 1.75 multiplier (1.75rem = 28px)');

  const bodyAt1024 = ruleBody(sec, selectorList, { inMedia: '(min-width: 1024px)' });
  assert.match(bodyAt1024, /font-size:\s*var\(--sc-step-3\)/, 'expected var(--sc-step-3) (33px) at >=1024px');
});

test('T9: all lengths in the section are tokens, calc() over tokens, 0, or percentages -- no bare length literal', () => {
  const sec = section(readCss());
  const stripped = stripComments(sec).replace(/@media[^{]*\{/g, '');
  assert.doesNotMatch(
    stripped,
    /\d(?:\.\d+)?(rem|px|em|vh|vw)\b/,
    'expected every length to be a token (--sc-space-*/--sc-step-*), 0, or a percentage -- no bare unit literal'
  );
});
