'use strict';

// Structural regression guard for the "Book leaves (Track B)" and "Page motion (Track B)"
// sections of assets/site/scriptorium.css. No layout engine here can compute :has()/cascade
// winners or run a real view transition (jsdom does no real CSS cascade resolution, and there is
// no cross-document navigation to drive from node:test) -- this is a source-level check, not a
// rendering one. The rendering proof lives in the Engineer report's Playwright/Chrome-headless
// screenshots against a scratch build of the real vault.
//
// Engineering Brief: "Book leaves + motion" (docs/agent-runs/bookleaves-engineering-brief-2026-09-24.md),
// AMENDMENT 1 (E-7 extends this file's own required checks once the B slot is filled with b2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');
const LEAF = 'body:has(> .top-nav) > main.content:not(:has(> .landing-hero))';
const LEAF_MARKER = 'Book leaves (Track B)';
const MOTION_MARKER = 'Page motion (Track B)';
const SLOT_START = 'Page turn slot (B): b2 Folded verso, Track B';
const SLOT_END = 'End Page turn slot (B)';

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

// -- Helpers copied from test/housestyle-character-header.test.js per the brief's instruction
// ("Copy these helpers into your test file; do not import them from that file"). --------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function sectionFor(css, marker) {
  const markerIndex = css.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected the section marker "${marker}" in scriptorium.css`);
  const bannerIndex = css.lastIndexOf('\n/* ====', markerIndex);
  assert.notEqual(bannerIndex, -1, `expected a "/* ====" banner before the "${marker}" marker`);
  const nextBanner = css.indexOf('\n/* ====', markerIndex);
  const sectionEnd = nextBanner === -1 ? css.length : nextBanner;
  return css.slice(bannerIndex + 1, sectionEnd);
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
    blocks.push({ query: match[1].trim(), body: sec.slice(bodyStart, j - 1) });
    lastIndex = j;
    mediaRe.lastIndex = j;
  }
  outside += sec.slice(lastIndex);
  return { blocks, outside };
}

// Collects every top-level selector list in `sec` (both outside and inside @media blocks, one
// level deep), comments stripped, @keyframes stops excluded (a "from"/"to"/"50%" selector inside
// a keyframe is not a real CSS selector).
function selectors(sec) {
  const stripped = stripComments(sec);
  let noKeyframes = '';
  let i = 0;
  const kfRe = /@(?:-webkit-)?keyframes\s+[^{]+\{/g;
  let kfMatch;
  while ((kfMatch = kfRe.exec(stripped))) {
    noKeyframes += stripped.slice(i, kfMatch.index);
    let depth = 1;
    let j = kfRe.lastIndex;
    while (depth > 0 && j < stripped.length) {
      if (stripped[j] === '{') depth++;
      else if (stripped[j] === '}') depth--;
      j++;
    }
    i = j;
    kfRe.lastIndex = j;
  }
  noKeyframes += stripped.slice(i);

  const { blocks, outside } = extractMediaBlocks(noKeyframes);
  const out = [];
  const collect = (text) => {
    for (const m of text.matchAll(/([^{}]+)\{/g)) {
      // Skip @property and other at-rules that aren't real selectors.
      const raw = m[1].trim();
      if (raw.startsWith('@')) continue;
      for (const sel of splitTopLevelCommas(raw)) {
        const trimmed = sel.trim().replace(/\s+/g, ' ');
        if (trimmed) out.push(trimmed);
      }
    }
  };
  collect(outside);
  for (const b of blocks) collect(b.body);
  return out;
}

// Splits a selector list on "," only at paren-depth 0, so a comma inside :is(...)/:not(...)/:has(...)
// never splits a single selector into two malformed fragments.
function splitTopLevelCommas(str) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function css() {
  return readCss();
}

// -- 1. Both sections exist behind /* ==== banners ----------------------------------------------

test('both Track B sections exist, each behind its own "/* ====" banner', () => {
  const leafSec = sectionFor(css(), LEAF_MARKER);
  const motionSec = sectionFor(css(), MOTION_MARKER);
  assert.ok(leafSec.length > 0);
  assert.ok(motionSec.length > 0);
});

// -- 2/3. Leaf-section selectors: LEAF or :root only, no global tag selectors -------------------

test('every Book leaves selector starts with LEAF, or is a bare :root block', () => {
  const sec = sectionFor(css(), LEAF_MARKER);
  for (const sel of selectors(sec)) {
    const ok = sel.startsWith(LEAF) || sel === ':root';
    assert.ok(ok, `selector "${sel}" is neither LEAF-scoped nor the :root token block`);
  }
});

test('no global body|html|a|img|*|p|li selector in the Book leaves section', () => {
  const sec = sectionFor(css(), LEAF_MARKER);
  const forbidden = /^(body|html|a|img|\*|p|li)(\s|::?|,|$)/;
  for (const sel of selectors(sec)) {
    if (sel === ':root' || sel.startsWith(LEAF)) continue; // LEAF itself legitimately starts with "body"
    assert.doesNotMatch(sel, forbidden, `selector "${sel}" looks like a bare global tag selector`);
  }
});

// -- 4. Colour discipline (SD-8) ------------------------------------------------------------------

const NAMED_COLOURS = ['red', 'blue', 'green', 'black', 'white', 'yellow', 'orange', 'purple', 'gold', 'silver', 'brown'];

function assertColourDiscipline(sectionText, label) {
  const stripped = stripComments(sectionText);
  for (const m of stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const hex = m[0];
    assert.ok(hex === '#000' || hex === '#fff', `${label}: unexpected hex literal ${hex}`);
    const before = stripped.slice(Math.max(0, m.index - 40), m.index);
    assert.match(before, /color-mix\(\s*in\s+srgb,\s*$/, `${label}: ${hex} must sit directly inside color-mix(in srgb, ...)`);
  }
  assert.doesNotMatch(stripped, /\brgb\(/, `${label}: no rgb()`);
  assert.doesNotMatch(stripped, /\brgba\(/, `${label}: no rgba()`);
  assert.doesNotMatch(stripped, /\bhsl\(/, `${label}: no hsl()`);
  for (const name of NAMED_COLOURS) {
    assert.doesNotMatch(stripped, new RegExp(`:\\s*${name}\\b`), `${label}: named colour "${name}"`);
  }
  assert.doesNotMatch(stripped, /IM Fell/, `${label}: no literal font family name`);
  // No single-name check here: the shipped-asset scanner covers every withheld term, not one.
  assert.doesNotMatch(stripped, /factions\//, `${label}: no vault path string`);
}

test('Book leaves section: no colour literal, no campaign string', () => {
  assertColourDiscipline(sectionFor(css(), LEAF_MARKER), 'Book leaves');
});

test('Page motion section: no colour literal, no campaign string', () => {
  assertColourDiscipline(sectionFor(css(), MOTION_MARKER), 'Page motion');
});

// -- 5. Frame/accordion guarantees ----------------------------------------------------------------

test('no .back-to-top selector anywhere in the Book leaves section', () => {
  assert.doesNotMatch(sectionFor(css(), LEAF_MARKER), /\.back-to-top/);
});

test('.accordion-body never gets a display declaration (the open state stays with .open)', () => {
  const sec = stripComments(sectionFor(css(), LEAF_MARKER));
  const m = sec.match(/\.accordion-body\s*\{([^}]*)\}/);
  assert.ok(m, 'expected a .accordion-body rule');
  assert.doesNotMatch(m[1], /display\s*:/);
});

// #96: the b1 "Framed miniature" box (padding + desk background + brass border + outline + shadow)
// around portrait images was removed for every theme. Expected values are stated here, not read
// from the CSS: no rule in the product stylesheet or either theme may put a frame on these two
// selectors.
test('#96: no frame (border, outline, box-shadow, background, padding) on .char-header img.portrait or .hero-cinematic-img', () => {
  const files = [
    CSS_PATH,
    path.join(__dirname, '..', 'assets', 'themes', 'gloam', 'theme.css'),
    path.join(__dirname, '..', 'assets', 'themes', 'haze', 'theme.css'),
  ];
  const FRAME = /(^|[;{\s])(border|outline|outline-offset|box-shadow|background|background-color|padding)\s*:/;
  const offenders = [];
  for (const f of files) {
    const text = stripComments(fs.readFileSync(f, 'utf8')).replace(/@media[^{]*\{/g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1].split(',').map((x) => x.trim());
      const hits = sels.filter((x) => /(\.char-header\s+img\.portrait|\.char-header\s+\.portrait|\.hero-cinematic-img)\b/.test(x));
      if (hits.length && FRAME.test(m[2])) offenders.push(`${path.basename(f)}: ${hits.join(', ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('#96: the b1 frame rule is gone from the leaf block', () => {
  const sec = stripComments(sectionFor(css(), LEAF_MARKER));
  assert.doesNotMatch(sec, /img\.portrait/);
});

// -- 6/11. .tab-bar absolute positioning and --sc-vt-over:56px only inside (min-width: 84rem) ----

test('.tab-bar gets position:absolute only inside @media (min-width: 84rem)', () => {
  const sec = sectionFor(css(), LEAF_MARKER);
  const { blocks, outside } = extractMediaBlocks(stripComments(sec));
  assert.doesNotMatch(outside, /\.tab-bar\s*\{[^}]*position:\s*absolute/);
  for (const b of blocks) {
    if (/\.tab-bar\s*\{[^}]*position:\s*absolute/.test(b.body)) {
      assert.equal(b.query.replace(/\s+/g, ' ').trim(), '(min-width: 84rem)', `.tab-bar absolute positioning found in unexpected @media ${b.query}`);
    }
  }
});

test('--sc-vt-over: 56px appears only inside @media (min-width: 84rem)', () => {
  const full = stripComments(css());
  const occurrences = [...full.matchAll(/--sc-vt-over:\s*56px/g)];
  assert.ok(occurrences.length >= 1);
  const { blocks, outside } = extractMediaBlocks(full);
  assert.doesNotMatch(outside, /--sc-vt-over:\s*56px/);
  for (const b of blocks) {
    if (/--sc-vt-over:\s*56px/.test(b.body)) {
      assert.equal(b.query.replace(/\s+/g, ' ').trim(), '(min-width: 84rem)');
    }
  }
});

// -- 7/8. Scaffold -----------------------------------------------------------------------------

test('@view-transition appears exactly once', () => {
  const full = stripComments(css());
  assert.equal((full.match(/@view-transition\s*\{/g) || []).length, 1);
});

test('every view-transition-name rule selector starts with :root:active-view-transition', () => {
  const sec = sectionFor(css(), MOTION_MARKER);
  const { blocks, outside } = extractMediaBlocks(stripComments(sec));
  const check = (text) => {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/view-transition-name\s*:/.test(m[2])) continue;
      for (const sel of m[1].split(',')) {
        assert.match(sel.trim(), /^:root:active-view-transition/, `"${sel.trim()}" sets view-transition-name but does not start with :root:active-view-transition`);
      }
    }
  };
  check(outside);
  for (const b of blocks) check(b.body);
});

// -- 9. No 3D rotate leaked from the rejected b options -------------------------------------------

test('no rotateY, perspective(, or "leaf-turn" anywhere in the Page motion section', () => {
  const sec = sectionFor(css(), MOTION_MARKER);
  assert.doesNotMatch(sec, /rotateY/);
  assert.doesNotMatch(sec, /perspective\(/);
  assert.doesNotMatch(sec, /leaf-turn/);
});

// -- 10. The B slot (b2 Folded verso, AMENDMENT E-2/E-4) ------------------------------------------

function slotSection() {
  const motionSec = sectionFor(css(), MOTION_MARKER);
  const startMarkerAt = motionSec.indexOf(SLOT_START);
  assert.notEqual(startMarkerAt, -1, 'expected the slot start marker');
  // The marker text sits inside the slot's own banner comment; start the real CSS slice after
  // that comment's closing "*/", not mid-comment (a truncated comment has no opening "/*" for
  // stripComments to match, so its own prose would otherwise be scanned as CSS).
  const bannerCommentEnd = motionSec.indexOf('*/', startMarkerAt) + 2;
  const endAt = motionSec.indexOf(SLOT_END, bannerCommentEnd);
  assert.notEqual(endAt, -1, 'expected the slot end marker');
  return motionSec.slice(bannerCommentEnd, endAt);
}

test('the slot: every duration is at most 400ms (380 and 260 present)', () => {
  const slot = stripComments(slotSection());
  const durations = [...slot.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(durations.length > 0);
  assert.ok(durations.includes(380));
  assert.ok(durations.includes(260));
  for (const d of durations) assert.ok(d <= 400, `duration ${d}ms exceeds 400ms`);
});

test('the slot: every rule selector names only leaf or leaf-fx, no :only-child, specificity <= (0,2,1)', () => {
  const slot = slotSection();
  const allowed = /^:root:active-view-transition(-type\([a-z, ]+\))?::view-transition-(old|new)\((leaf|leaf-fx)\)$/;
  for (const sel of selectors(slot)) {
    assert.doesNotMatch(sel, /:only-child/, `slot selector "${sel}" must not use :only-child`);
    assert.match(sel, allowed, `slot selector "${sel}" is outside the allowed shape (implies specificity > (0,2,1) or names something other than leaf/leaf-fx)`);
  }
});

test('the slot declares @property --sc-turn-fold with syntax \'<number>\'', () => {
  const slot = stripComments(slotSection());
  assert.match(slot, /@property\s+--sc-turn-fold\s*\{[^}]*syntax:\s*'<number>'/);
});

// -- 12. The scrolled guard (AMENDMENT E-6) --------------------------------------------------------

test('the four scrolled rules exist, with 150ms durations, after the slot and after A\'s cover rules', () => {
  const sec = sectionFor(css(), MOTION_MARKER);
  const slotEndAt = sec.indexOf(SLOT_END);
  const coverRuleAt = sec.indexOf('::view-transition-old(cover)'); // A's cover rule
  const scrolledAt = sec.indexOf('active-view-transition-type(scrolled)');
  assert.notEqual(scrolledAt, -1);
  assert.ok(scrolledAt > slotEndAt, 'the scrolled rules must sit after the slot');
  assert.ok(scrolledAt > coverRuleAt, 'the scrolled rules must sit after A\'s cover rules');

  const stripped = stripComments(sec);
  const scrolledBlock = stripped.slice(stripped.indexOf('active-view-transition-type(scrolled)'));
  const durations = [...scrolledBlock.matchAll(/(\d+)ms/g)].map((m) => Number(m[1])).slice(0, 2);
  for (const d of durations) assert.equal(d, 150);

  for (const target of ['::view-transition-old(leaf)', '::view-transition-new(leaf)', '::view-transition-old(leaf-fx)', '::view-transition-new(leaf-fx)']) {
    assert.match(scrolledBlock, new RegExp(`active-view-transition-type\\(scrolled\\)${target.replace(/[()]/g, '\\$&')}`));
  }
  // Each of the two dedicated animation rules (old(leaf) fade-out, new(leaf) fade-in) must exist
  // as its own rule, not merely be named inside the shared four-selector clip/background rule.
  assert.match(
    scrolledBlock,
    /active-view-transition-type\(scrolled\)::view-transition-old\(leaf\)\s*\{\s*animation:\s*sc-vt-fade-out\s+150ms/,
  );
  assert.match(
    scrolledBlock,
    /active-view-transition-type\(scrolled\)::view-transition-new\(leaf\)\s*\{\s*animation:\s*sc-vt-fade-in\s+150ms/,
  );
});

// -- 13. leaf-fx cover isolation -------------------------------------------------------------------

test('the leaf-fx :only-child cover-isolation rule exists', () => {
  const sec = sectionFor(css(), MOTION_MARKER);
  assert.match(sec, /::view-transition-old\(leaf-fx\):only-child/);
  assert.match(sec, /::view-transition-new\(leaf-fx\):only-child/);
});

// -- 14/16. D block: !important only here, clip-path/background none, durations <=150ms -----------

test('!important appears only inside the reduced-motion block, and every duration there is <=150ms', () => {
  const raw = css();
  const leafSecRaw = sectionFor(raw, LEAF_MARKER);
  const motionSecRaw = sectionFor(raw, MOTION_MARKER);
  // Track B's own reduced-motion block: there are pre-existing (raw|html)(prefers-reduced-motion)
  // blocks elsewhere in the file (unrelated, pre-Track-B), so this must be scoped to the Page
  // motion section specifically, not the whole file.
  const { blocks } = extractMediaBlocks(motionSecRaw);
  const reducedBlock = blocks.find((b) => b.query.replace(/\s+/g, ' ').trim() === '(prefers-reduced-motion: reduce)');
  assert.ok(reducedBlock, 'expected a (prefers-reduced-motion: reduce) block in the Page motion section');

  // No !important anywhere OUTSIDE that block, in either Track B section (comments stripped --
  // this file's own prose legitimately discusses "!important" as a word, e.g. the decision-10
  // comment explaining that rule does NOT use it).
  const motionSecOutside = motionSecRaw.replace(reducedBlock.body, '');
  assert.doesNotMatch(stripComments(leafSecRaw), /!important/);
  assert.doesNotMatch(stripComments(motionSecOutside), /!important/);

  const durations = [...reducedBlock.body.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(durations.length > 0);
  for (const d of durations) assert.ok(d <= 150, `reduced-motion duration ${d}ms exceeds 150ms`);

  assert.match(reducedBlock.body, /clip-path:\s*none\s*!important/);
  assert.match(reducedBlock.body, /background:\s*none\s*!important/);
});

// -- 17. Brand timings -----------------------------------------------------------------------------

test('the brand group is 700ms, and 420ms inside (max-width: 700px)', () => {
  const sec = sectionFor(css(), MOTION_MARKER);
  const { blocks, outside } = extractMediaBlocks(stripComments(sec));
  assert.match(outside, /::view-transition-group\(brand\)\s*\{[^}]*animation-duration:\s*700ms/);
  const phoneBlock = blocks.find((b) => b.query.replace(/\s+/g, ' ').trim() === '(max-width: 700px)' && /::view-transition-group\(brand\)/.test(b.body));
  assert.ok(phoneBlock, 'expected a (max-width: 700px) block with the brand group override');
  assert.match(phoneBlock.body, /::view-transition-group\(brand\)\s*\{[^}]*animation-duration:\s*420ms/);
});

// -- B-3 (Reviewer rework): the product .metadata-badge rule must never set `display` -------------
//
// Regression guard: a first draft of B-3's de-pilling rule set `display: inline-block` on the
// product-layer `.metadata-badge` rule. Because that rule is LEAF-scoped ((0,3,2) plus the class),
// its specificity on `display` beat the campaign layer's `.metadata-badge[data-field="status"] {
// display: none; }` ((0,1,0)) outright, silently un-hiding the GM's "reviewed" status badge --
// caught by screenshot, not by any test, which is why this test now exists.
test('the product .metadata-badge rule never declares display (would outrank the campaign status hide)', () => {
  const sec = sectionFor(css(), LEAF_MARKER);
  const stripped = stripComments(sec);
  const m = stripped.match(/\.metadata-badge\s*\{([^}]*)\}/);
  assert.ok(m, 'expected a bare .metadata-badge rule');
  assert.doesNotMatch(m[1], /\bdisplay\s*:/);
});

// -- Mutation proofs (recorded manually in the Engineer report; this suite is the gate) -----------
// add body{} to the leaf section: "no global tag selector" test goes red.
// ungate one view-transition-name rule (drop :root:active-view-transition): the scaffold test
//   goes red.
// add rotateY to the slot: the "no rotateY/perspective/leaf-turn" test goes red.
// set the reduced duration to 200ms: the "!important only in reduced-motion, <=150ms" test goes
//   red.
// put a #c9a55a in the product file: the colour-discipline test goes red.
// fold duration to 420ms: the "slot durations <=400ms" test goes red.
// move --sc-vt-over to (min-width: 82.5rem): the "--sc-vt-over only inside 84rem" test goes red.
// delete a scrolled rule: the "four scrolled rules exist" test goes red.
// delete the leaf-fx :only-child isolation rule: that test goes red.
