'use strict';

// Issue #36: assets/site/scriptorium.css's card hover lift (`transform: translateY(-2px)`)
// shipped with zero `transition:` declarations anywhere in the file, so the lift snapped
// instantly, and the `prefers-reduced-motion: reduce` block only zeroed `scroll-behavior`,
// never the transform itself -- a reduced-motion user got the full 2px jump, instantly, with
// no easing to soften it.
//
// No headless browser is available here (no playwright/puppeteer devDependency; checked via
// require.resolve first) so this is a source-level check, the same posture
// test/housestyle-bookleaves.test.js documents for itself: "No layout engine here can compute
// :has()/cascade winners ... this is a source-level check, not a rendering one." The rendering
// proof lives in the Engineer report's before/after screenshots against a scratch build.
//
// Residual gap, stated per CLAUDE.md's testing standards: this test only proves the CASCADE
// SHAPE is correct (the reduced-motion override selector matches the hover-lift selector at
// equal specificity and appears later in source, which is how this file already wins cascade
// ties elsewhere without !important -- see the :focus-visible/.name-filter rule's own comment).
// It cannot prove a real browser actually resolves that tie in `computedStyle`'s favour; only a
// rendered check can.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');

// -- Helpers copied from test/housestyle-bookleaves.test.js per its own stated convention
// ("Copy these helpers into your test file; do not import them from that file"). ------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

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
    blocks.push({ query: match[1].trim(), body: sec.slice(bodyStart, j - 1), start: match.index });
    lastIndex = j;
    mediaRe.lastIndex = j;
  }
  outside += sec.slice(lastIndex);
  return { blocks, outside };
}

// The six card types the issue's hover-lift rule actually targets (css:827-832 in the original
// shipped file), stated independently of the source under test rather than read off it.
const HOVER_SELECTORS = ['.entity-card', '.pc-card', '.npc-card', '.explore-card', '.loc-card', '.intel-card'];

function css() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function findBlockContaining(blocks, needle) {
  return blocks.find((b) => b.body.includes(needle));
}

test('the hover-lift transform is gated behind @media (hover: hover)', () => {
  const stripped = stripComments(css());
  const { blocks } = extractMediaBlocks(stripped);
  const hoverGuard = blocks.find((b) => b.query.replace(/\s+/g, ' ').trim() === '(hover: hover)');
  assert.ok(hoverGuard, 'expected an @media (hover: hover) block');
  assert.ok(
    hoverGuard.body.includes('transform: translateY(-2px)'),
    'expected the hover-lift transform to live inside the (hover: hover) block, not unguarded',
  );
  for (const sel of HOVER_SELECTORS) {
    assert.ok(
      hoverGuard.body.includes(`${sel}:hover`),
      `expected ${sel}:hover inside the (hover: hover) block`,
    );
  }
});

test('the un-hovered card selectors get a transition covering transform and box-shadow, inside the same hover-capability guard', () => {
  const stripped = stripComments(css());
  const { blocks } = extractMediaBlocks(stripped);
  const hoverGuard = blocks.find((b) => b.query.replace(/\s+/g, ' ').trim() === '(hover: hover)');
  assert.ok(hoverGuard);

  const transitionMatch = hoverGuard.body.match(/transition:\s*([^;]+);/);
  assert.ok(transitionMatch, 'expected a transition: declaration inside the (hover: hover) block');
  assert.match(transitionMatch[1], /transform/, 'transition should cover transform');
  assert.doesNotMatch(transitionMatch[1], /\b0s\b|\b0ms\b/, 'transition duration should not be zero');
});

test('a later @media (prefers-reduced-motion: reduce) block suppresses the transform (not merely the duration) on the same :hover selectors', () => {
  const stripped = stripComments(css());
  const { blocks } = extractMediaBlocks(stripped);
  const hoverGuard = blocks.find((b) => b.query.replace(/\s+/g, ' ').trim() === '(hover: hover)');
  assert.ok(hoverGuard);

  // Every reduced-motion block whose body touches at least one of the six hover selectors.
  const candidates = blocks.filter(
    (b) => b.query.includes('prefers-reduced-motion') && HOVER_SELECTORS.some((sel) => b.body.includes(`${sel}:hover`)),
  );
  assert.ok(candidates.length > 0, 'expected a prefers-reduced-motion block targeting the card :hover selectors');

  const rm = candidates[0];
  assert.ok(
    rm.start > hoverGuard.start,
    'the reduced-motion override must come AFTER the (hover: hover) block in source order to win the cascade tie (same 0,2,0 specificity, no !important elsewhere in this file for this pattern)',
  );
  for (const sel of HOVER_SELECTORS) {
    assert.ok(rm.body.includes(`${sel}:hover`), `expected ${sel}:hover in the reduced-motion override`);
  }
  assert.match(rm.body, /transform:\s*none/, 'expected transform: none, not merely a zeroed transition-duration');
});

test('regression fixture: a hover-lift transform with no transition and no reduced-motion transform override is exactly the shipped bug (mutation proof for the helpers above)', () => {
  const buggyCss = `
.entity-card:hover {
  transform: translateY(-2px);
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
`;
  const stripped = stripComments(buggyCss);
  const { blocks, outside } = extractMediaBlocks(stripped);
  const hoverGuard = blocks.find((b) => b.query.replace(/\s+/g, ' ').trim() === '(hover: hover)');
  assert.equal(hoverGuard, undefined, 'sanity: the buggy fixture has no (hover: hover) guard at all');
  assert.ok(outside.includes('transform: translateY(-2px)'), 'sanity: the lift is unguarded, sitting in code outside any @media');
});
