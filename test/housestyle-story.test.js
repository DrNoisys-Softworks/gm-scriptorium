'use strict';

// Structural regression guard for the "Story timeline" and "Connections lane" sections of
// assets/site/scriptorium.css, same house style as test/housestyle-bookleaves.test.js (whose
// helpers this file copies per that file's own instruction -- "Copy these helpers into your test
// file; do not import them from that file").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');
const LEAF = 'body:has(> .top-nav) > main.content:not(:has(> .landing-hero))';
// Full title lines, not bare substrings: "Connections lane" alone also appears inside the Story
// timeline banner's own "Engineering Brief:" prose line, so a bare substring match would find that
// occurrence first (mirrors the trap test/housestyle-bookleaves.test.js's distinctive markers avoid).
const TIMELINE_MARKER = '\n * Story timeline\n';
const CONNECTIONS_MARKER = '\n * Connections lane\n';

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

// -- Helpers copied from test/housestyle-bookleaves.test.js (itself copied from
// test/housestyle-character-header.test.js). ---------------------------------------------------

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

function extractContainerBlocks(sec) {
  const blocks = [];
  let outside = '';
  let lastIndex = 0;
  const containerRe = /@container\s*([^{]*)\{/g;
  let match;
  while ((match = containerRe.exec(sec))) {
    outside += sec.slice(lastIndex, match.index);
    const bodyStart = containerRe.lastIndex;
    let depth = 1;
    let j = bodyStart;
    while (depth > 0 && j < sec.length) {
      if (sec[j] === '{') depth++;
      else if (sec[j] === '}') depth--;
      j++;
    }
    blocks.push({ query: match[1].trim(), body: sec.slice(bodyStart, j - 1) });
    lastIndex = j;
    containerRe.lastIndex = j;
  }
  outside += sec.slice(lastIndex);
  return { blocks, outside };
}

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

  const { blocks: mediaBlocks, outside: afterMedia } = extractMediaBlocks(noKeyframes);
  const { blocks: containerBlocks, outside } = extractContainerBlocks(afterMedia);
  const out = [];
  const collect = (text) => {
    for (const m of text.matchAll(/([^{}]+)\{/g)) {
      const raw = m[1].trim();
      if (raw.startsWith('@')) continue;
      for (const sel of splitTopLevelCommas(raw)) {
        const trimmed = sel.trim().replace(/\s+/g, ' ');
        if (trimmed) out.push(trimmed);
      }
    }
  };
  collect(outside);
  for (const b of mediaBlocks) collect(b.body);
  for (const b of containerBlocks) collect(b.body);
  return out;
}

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
}

function css() {
  return readCss();
}

// -- 1. Both sections exist behind /* ==== banners -----------------------------------------------

test('both new sections exist, each behind its own "/* ====" banner', () => {
  const tlSec = sectionFor(css(), TIMELINE_MARKER);
  const cxSec = sectionFor(css(), CONNECTIONS_MARKER);
  assert.ok(tlSec.length > 0);
  assert.ok(cxSec.length > 0);
});

// -- 2/3. Selectors: LEAF or :root only -------------------------------------------------------

test('every selector in both sections starts with LEAF, or is a bare :root block', () => {
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    const sec = sectionFor(css(), marker);
    for (const sel of selectors(sec)) {
      const ok = sel.startsWith(LEAF) || sel === ':root';
      assert.ok(ok, `${marker}: selector "${sel}" is neither LEAF-scoped nor the :root token block`);
    }
  }
});

// -- classes are .sc-tl*/.sc-cx* only ----------------------------------------------------------

test('only .sc-tl*/.sc-cx* classes appear as selector class tokens', () => {
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    const sec = sectionFor(css(), marker);
    for (const sel of selectors(sec)) {
      const rest = sel.startsWith(LEAF) ? sel.slice(LEAF.length) : sel;
      for (const m of rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
        assert.match(m[1], /^sc-(tl|cx|leaf)/, `${marker}: unexpected class .${m[1]} in "${sel}"`);
      }
    }
  }
});

// -- Colour discipline ----------------------------------------------------------------------

test('Story timeline section: no colour literal, no campaign string', () => {
  assertColourDiscipline(sectionFor(css(), TIMELINE_MARKER), 'Story timeline');
});

test('Connections lane section: no colour literal, no campaign string', () => {
  assertColourDiscipline(sectionFor(css(), CONNECTIONS_MARKER), 'Connections lane');
});

// -- No !important, no view-transition-name, no display on the four hidden-toggled classes ------

test('no !important in either new section', () => {
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    assert.doesNotMatch(stripComments(sectionFor(css(), marker)), /!important/, marker);
  }
});

test('no view-transition-name in either new section', () => {
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    assert.doesNotMatch(stripComments(sectionFor(css(), marker)), /view-transition-name/, marker);
  }
});

test('no "display" property set on .sc-tl-src, .sc-tl-card, .sc-cx-static or .sc-cx-live, except the shared [hidden] rule', () => {
  const whole = css();
  const hiddenRuleIdx = whole.indexOf('[hidden]:is(.sc-tl-src, .sc-tl-card, .sc-cx-static, .sc-cx-live)');
  assert.notEqual(hiddenRuleIdx, -1, 'expected the shared [hidden] rule');
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    const sec = sectionFor(css(), marker);
    const stripped = stripComments(sec);
    for (const cls of ['.sc-tl-src', '.sc-tl-card', '.sc-cx-static', '.sc-cx-live']) {
      const re = new RegExp(`([^{}]*)${cls.replace('.', '\\.')}[^{}]*\\{[^}]*\\bdisplay\\s*:`, 'g');
      for (const m of stripped.matchAll(re)) {
        // The preceding selector-list text back to the last rule boundary (';' or '}' or start).
        const lastBoundary = Math.max(m[1].lastIndexOf(';'), m[1].lastIndexOf('}'));
        const precedingSelectorText = m[1].slice(lastBoundary + 1);
        assert.ok(precedingSelectorText.includes('[hidden]'), `${marker}: a non-[hidden] rule sets display on ${cls}`);
      }
    }
  }
});

// -- reduced motion block exists -------------------------------------------------------------

test('a @media (prefers-reduced-motion: reduce) block exists in each section, with transition/animation: none', () => {
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    const sec = sectionFor(css(), marker);
    const { blocks } = extractMediaBlocks(sec);
    const rm = blocks.find((b) => b.query.includes('prefers-reduced-motion'));
    assert.ok(rm, `${marker}: expected a prefers-reduced-motion block`);
    assert.match(rm.body, /transition:\s*none/);
    assert.match(rm.body, /animation:\s*none/);
  }
});

// -- container-type on .sc-cx, and the reflow is a real @container rule -------------------------

test('.sc-cx has container-type: inline-size, and the reflow (the a1 lane vs. the spine) uses @container at the 600px breakpoint', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  assert.match(sec, /\.sc-cx\s*\{[^}]*container-type:\s*inline-size/);
  const { blocks } = extractContainerBlocks(sec);
  assert.ok(blocks.some((b) => /(?:min|max)-width:\s*600px/.test(b.query)));
});

// -- fonts: only the two tokens, no literal family -------------------------------------------

test('font-family only ever uses var(--sc-leaf-font-sc) or var(--font-heading)', () => {
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    const sec = stripComments(sectionFor(css(), marker));
    for (const m of sec.matchAll(/font-family:\s*([^;]+);/g)) {
      const value = m[1].trim();
      assert.ok(
        value === 'var(--sc-leaf-font-sc)' || value === 'var(--font-heading)',
        `${marker}: unexpected font-family value "${value}"`,
      );
    }
  }
});

// -- the shared [hidden] rule exists, LEAF-scoped -----------------------------------------------

test('the shared [hidden]:is(...) display:none rule exists, LEAF-scoped', () => {
  const whole = css();
  const re = new RegExp(
    `${LEAF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[hidden\\]:is\\(\\.sc-tl-src, \\.sc-tl-card, \\.sc-cx-static, \\.sc-cx-live\\)\\s*\\{\\s*display:\\s*none;?\\s*\\}`,
  );
  assert.match(whole, re);
});

// -- Connections ornament (AC-13/FR-C4, coordinator rework 2026-09-24): studs, double rules, ---
// -- fleurons, and the hub seal, all keyed to the product tokens rather than a literal. --------

test('the hub seal uses the --sc-cx-seal token and --sc-on-named ink', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const rule = sec.match(/\.sc-cx-hub-seal\s*\{[^}]*\}/);
  assert.ok(rule, 'expected a .sc-cx-hub-seal rule');
  assert.match(rule[0], /background:\s*var\(--sc-cx-seal\)/);
  assert.match(rule[0], /color:\s*var\(--sc-on-named\)/);
  assert.match(rule[0], /border-radius:\s*50%/);
});

test('studs (tie/named/mention beads) use the --sc-cx-stud/--sc-cx-named/--sc-cx-iron tokens, both live and static', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const studRule = sec.match(/\.sc-cx-stud\s*\{[^}]*\}/);
  assert.ok(studRule, 'expected a .sc-cx-stud rule (the live, icon-in-bead JS enhancement)');
  assert.match(studRule[0], /background:\s*var\(--sc-cx-stud\)/);

  const namedStudRule = sec.match(/\.sc-cx-kind-named \.sc-cx-stud\s*\{[^}]*\}/);
  assert.ok(namedStudRule);
  assert.match(namedStudRule[0], /background:\s*var\(--sc-cx-named\)/);

  const mentionStudRule = sec.match(/\.sc-cx-kind-mention \.sc-cx-stud\s*\{[^}]*\}/);
  assert.ok(mentionStudRule);
  assert.match(mentionStudRule[0], /background:\s*var\(--sc-cx-iron\)/);

  // The no-JS static fallback (the brief's own literal markup has no icon element) gets an
  // equivalent ::before bead, scoped to .sc-cx-static so the live version never shows two.
  assert.match(sec, /\.sc-cx-static \.sc-cx-list li::before\s*\{[^}]*background:\s*var\(--sc-cx-stud\)/);
});

test('group headings and the tray both carry a 3px double rule (not the leaf\'s default 1px)', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const ghRule = sec.match(/\.sc-cx-gh\s*\{[^}]*\}/);
  assert.ok(ghRule);
  assert.match(ghRule[0], /border-bottom:\s*3px double var\(--sc-leaf-rule\)/);

  const trayRule = sec.match(/\.sc-cx-tray\s*\{[^}]*\}/);
  assert.ok(trayRule);
  assert.match(trayRule[0], /border-top:\s*3px double var\(--sc-leaf-rule\)/);
});

test('a fleuron glyph is emitted between groups, coloured with --sc-leaf-brass', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const rule = sec.match(/\.sc-cx-fleuron\s*\{[^}]*\}/);
  assert.ok(rule, 'expected a .sc-cx-fleuron rule');
  assert.match(rule[0], /color:\s*var\(--sc-leaf-brass\)/);

  const js = fs.readFileSync(path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js'), 'utf8');
  assert.match(js, /sc-cx-fleuron/);
  assert.match(js, /&#10086;/); // U+2766, the mock's own fleuron glyph (conn-work/cx.css)

  const build = fs.readFileSync(path.join(__dirname, '..', 'src', 'build', 'connections.js'), 'utf8');
  assert.match(build, /sc-cx-fleuron/);
});

test('relation words are coloured by kind through their own tokens (#85), not a bare generator var', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  assert.match(sec, /\.sc-cx-kind-tie \.sc-cx-rel\s*\{[^}]*color:\s*var\(--sc-cx-rel-tie\)/);
  assert.match(sec, /\.sc-cx-kind-named \.sc-cx-rel\s*\{[^}]*color:\s*var\(--sc-cx-rel-named\)/);
});

test('item names (list links and the tray heading link) use the heading font, not the default body face', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  assert.match(sec, /\.sc-cx-list a,[\s\S]{0,80}\.sc-cx-nolink\s*\{[^}]*font-family:\s*var\(--font-heading\)/);
});

// -- Story timeline ornament (R-2): tier grouping below the axis, a fleuron between tiers, and --
// -- the pan-affordance fade on the horizontal scroller. ----------------------------------------

test('the ruler scroller has an edge fade (mask-image), not a hard clip', () => {
  const sec = sectionFor(css(), TIMELINE_MARKER);
  assert.match(sec, /\.sc-tl-scroll\s*\{[^}]*mask-image:/);
});

test('.sc-tl-t1 (tier) and .sc-tl-t2 (segment) labels sit below the axis line, not overlapping the title lanes above it', () => {
  const sec = sectionFor(css(), TIMELINE_MARKER);
  const t2 = sec.match(/\.sc-tl-t2\s*\{[^}]*\}/);
  const t1 = sec.match(/\.sc-tl-t1\s*\{[^}]*\}/);
  assert.ok(t2 && t1);
  // Both must be positioned at/after the 186px line, never at the top (0) where the title lanes
  // (ty 6/56/106) render -- the collision the coordinator's rework flagged.
  assert.doesNotMatch(t2[0], /[^-]top:\s*0\b/);
  assert.doesNotMatch(t1[0], /[^-]top:\s*0\b/);
  assert.match(t2[0], /186px/);
  assert.match(t1[0], /186px/);
});

test('buttons inside .sc-tl and .sc-cx inherit the page font (no system-ui leak from the UA button default)', () => {
  for (const marker of [TIMELINE_MARKER, CONNECTIONS_MARKER]) {
    const sec = sectionFor(css(), marker);
    assert.match(sec, /button\s*\{[^}]*font:\s*inherit/, `${marker}: expected a button font-reset rule`);
  }
});

// -- FR-C2/AC-12 (a1 lane, coordinator rework 2): the three-column lane at 600px+ of the lane's
// -- own container, collapsing to the existing vertical spine below that -- same markup, only
// -- the container query changes. --------------------------------------------------------------

test('the lane row layout (flex-direction: row) lives inside a container query at the 600px breakpoint, not at the base (mobile-first: base is the spine)', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const { blocks, outside } = extractContainerBlocks(sec);
  const baseLaneRule = outside.match(/\.sc-cx-lane\s*\{[^}]*\}/);
  assert.ok(baseLaneRule, 'expected a base .sc-cx-lane rule');
  assert.match(baseLaneRule[0], /flex-direction:\s*column/, 'the base (narrow/no-container-support) layout must be the column spine');

  const laneBlock = blocks.find((b) => /600px/.test(b.query) && /\.sc-cx-lane\s*\{/.test(b.body));
  assert.ok(laneBlock, 'expected a @container ...600px... block with a .sc-cx-lane row rule');
  assert.match(laneBlock.body, /\.sc-cx-lane\s*\{[^}]*flex-direction:\s*row/);
});

test('the lane has a connecting line (the mock\'s brass bar) only in the 600px+ row layout', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const { blocks } = extractContainerBlocks(sec);
  const laneBlock = blocks.find((b) => /600px/.test(b.query) && /\.sc-cx-lane::before/.test(b.body));
  assert.ok(laneBlock, 'expected .sc-cx-lane::before (the connecting line) inside the 600px+ container block');
  assert.match(laneBlock.body, /border-top:\s*1px solid var\(--sc-leaf-brass\)/);
});

test('the hub sits first at the base (spine) via order:-1, and resets to DOM order (between the left and right groups) at 600px+', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const { blocks, outside } = extractContainerBlocks(sec);
  const baseHubRule = outside.match(/\.sc-cx-hub\s*\{[^}]*\}/);
  assert.ok(baseHubRule);
  assert.match(baseHubRule[0], /order:\s*-1/);

  const laneBlock = blocks.find((b) => /600px/.test(b.query) && /\.sc-cx-hub\s*\{/.test(b.body));
  assert.ok(laneBlock, 'expected a .sc-cx-hub rule inside the 600px+ block');
  assert.match(laneBlock.body, /\.sc-cx-hub\s*\{[^}]*order:\s*0/);
});

test('"Declared here" / "Mentioned elsewhere" side labels are hidden at the base and shown at 600px+', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const { blocks, outside } = extractContainerBlocks(sec);
  const baseSideRule = outside.match(/\.sc-cx-side\s*\{[^}]*\}/);
  assert.ok(baseSideRule);
  assert.match(baseSideRule[0], /display:\s*none/);

  const laneBlock = blocks.find((b) => /600px/.test(b.query) && /\.sc-cx-side\s*\{/.test(b.body));
  assert.ok(laneBlock);
  assert.match(laneBlock.body, /\.sc-cx-side\s*\{[^}]*display:\s*flex/);
});

test('hub session numerals read as small brass chips, not a grey pill (a border-radius under the fully-round threshold, brass ink)', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const rule = sec.match(/\.sc-cx-sess a\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /color:\s*var\(--sc-leaf-brass\)/);
  assert.doesNotMatch(rule[0], /border-radius:\s*50%/, 'a fully round chip reads as a pill, not a numeral chip');
});

test('the lane scroller has an edge fade too, matching the ruler\'s pan affordance', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const { blocks } = extractContainerBlocks(sec);
  const laneScrollBlock = blocks.find((b) => /600px/.test(b.query) && /\.sc-cx-lane-scroll\s*\{[^}]*mask-image:/.test(b.body));
  assert.ok(laneScrollBlock, 'expected a mask-image fade on .sc-cx-lane-scroll inside the 600px+ block');
});

test('the tray no longer double-quotes an already-quoted relationship description (stripWrappingQuotes is wired into traySay)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js'), 'utf8');
  assert.match(js, /function stripWrappingQuotes/);
  const traySayMatch = js.match(/function traySay\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(traySayMatch, 'expected a traySay function');
  assert.match(traySayMatch[0], /stripWrappingQuotes\(it\.line\)/);
});

// -- Reviewer MEDIUM item: the live (JS-enhanced) hub markup must carry the same block-boundary
// -- fix as the static renderer (build-connections.test.js's own renderLane test). A plain space
// -- between <span>s was confirmed, via a live canon-check run against a scratch build, NOT
// -- enough -- canon-check's phrase-boundary insertion only fires on block-tag closes, and its
// -- name-run regex spans a bare space (including into a trailing roman-numeral session number).
// -- The seal and name must render as <div>s, not <span>s, or canon-check still glues the seal
// -- onto the name once JS has rendered over the static fallback.

test('the live hub markup renders the seal and name as <div>s (a block-tag close, not a bare space, is what stops canon-check gluing them together), and still spaces session numerals', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js'), 'utf8');
  const hubHtmlMatch = js.match(/var hubHtml =\s*\n([\s\S]*?);/);
  assert.ok(hubHtmlMatch, 'expected a hubHtml assignment');
  const body = hubHtmlMatch[1];
  assert.match(body, /'<div class="sc-cx-hub"><div class="sc-cx-hub-seal" aria-hidden="true">'/);
  assert.match(body, /'<\/div><div class="sc-cx-hub-name">'/, 'expected the seal to close as a </div>, giving canon-check a phrase boundary before the name');
  assert.doesNotMatch(body, /<span class="sc-cx-hub-seal"|<span class="sc-cx-hub-name"/, 'the seal/name must not be <span>s: canon-check does not treat a span close as a boundary');
  assert.match(js, /\.join\(' '\) \+ '<\/span>'/, 'expected the session numeral <a> tags to be joined with a space');
});

// -- Reviewer LOW item: initConnections's render() must never destroy .sc-cx-static (it used to,
// -- via `section.innerHTML = ...`, making the "hide the static fallback" line after it dead
// -- code -- .sc-cx-static could never be found again to hide). It renders into a dedicated
// -- mount instead, mirroring the timeline's own root-is-separate-from-.sc-tl-src pattern.

test('initConnections never replaces the whole section (which would destroy .sc-cx-static); it renders into its own dedicated mount', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js'), 'utf8');
  const initFn = js.match(/function initConnections\(section\) \{[\s\S]*?\n  \}\n\n  function wireConnections/);
  assert.ok(initFn, 'expected an initConnections function');
  const body = initFn[0];

  assert.doesNotMatch(body, /section\.innerHTML\s*=/, 'render() must never reassign section.innerHTML (that destroys .sc-cx-static)');
  assert.match(body, /var liveMount = document\.createElement\(/, 'expected a dedicated live-render mount, created once');
  assert.match(body, /liveMount\.innerHTML\s*=\s*body/, 'expected render() to write into the mount, not the section');

  // The mount must actually be inserted relative to .sc-cx-static (a sibling, not a destroyer).
  assert.match(body, /querySelector\('\.sc-cx-static'\)/);
  assert.match(body, /insertBefore\(liveMount, staticAnchor\)/);
});

// -- P3b, SD-8: the token renamed from "--sc-on-" + "haze" to --sc-on-named, no alias (D-15). ---
// The old name is never written literally in this file (built at runtime below), so this test
// itself does not trip the NFR-11(f)/AC-09 grep for the old token across src/assets/test.

const OLD_ON_HAZE_TOKEN = ['--sc-on', 'haze'].join('-');

test('SD-8: the pre-rename token appears in neither scriptorium.css nor the haze theme; --sc-on-named is used instead', () => {
  const productCss = css();
  const themeCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'themes', 'haze', 'theme.css'), 'utf8');
  const oldTokenRe = new RegExp(`${OLD_ON_HAZE_TOKEN}\\b`);
  assert.doesNotMatch(productCss, oldTokenRe);
  assert.doesNotMatch(themeCss, oldTokenRe);
  assert.match(productCss, /--sc-on-named\s*:/);
  assert.match(themeCss, /--sc-on-named\s*:/);
});
