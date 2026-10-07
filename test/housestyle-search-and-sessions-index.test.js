'use strict';

// R1b (repin CSS follow-up): source-level regression guard for two changes to
// assets/site/scriptorium.css --
//   1. the UI-10 phone search un-hide now only fires when the header has no
//      .nav-search-icon-btn, so phones get exactly one search control instead of two;
//   2. a new "Sessions index: no list controls" section hides the breadcrumb, count,
//      sort menu, type-filter pills and name filter on any generic index page whose
//      cards are typed exactly "session".
//
// LIMIT, stated up front per CLAUDE.md's testing standards: T1-T3 below are source-level.
// They prove how the rules are WRITTEN -- the selector text, the section's shape, the
// declarations used -- not how a real browser RENDERS or computes them. T4-T6 build real
// sites and check the emitted HTML's shape, which proves the CSS has something concrete to
// grab hold of, but still not what a browser paints or reports through the accessibility
// tree. That rendering proof is the out-of-repo Playwright browser gate; it is not run as
// part of `npm test`.
//
// Helpers below (stripComments, sectionFor, extractMediaBlocks, extractContainerBlocks,
// selectors, splitTopLevelCommas) are copied from test/housestyle-story.test.js per that
// file's own stated convention: "Copy these helpers into your test file; do not import them
// from that file."

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function css() {
  return readCss();
}

// -- Helpers copied from test/housestyle-story.test.js ------------------------------------

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function sectionFor(text, marker) {
  const markerIndex = text.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected the section marker "${marker}" in scriptorium.css`);
  const bannerIndex = text.lastIndexOf('\n/* ====', markerIndex);
  assert.notEqual(bannerIndex, -1, `expected a "/* ====" banner before the "${marker}" marker`);
  const nextBanner = text.indexOf('\n/* ====', markerIndex);
  const sectionEnd = nextBanner === -1 ? text.length : nextBanner;
  return text.slice(bannerIndex + 1, sectionEnd);
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

// -- New helpers for this file -------------------------------------------------------------

// A small, hand-rolled, depth-tracking rule walker. No postcss devDependency is available
// here (see test/css-comment-integrity.test.js's identical note), so this is not a real CSS
// parser: it assumes declaration bodies never contain unescaped braces, which holds for
// every rule in this file. Returns a flat list of { selector, body, media } for every plain
// rule in `text`, descending into @media and @container (but not @keyframes, which never
// carries a `display` declaration relevant to this file's navigation/index rules).
function parseBlocks(text) {
  const rules = [];
  const atRules = [];
  let i = 0;
  while (i < text.length) {
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) break;
    const prelude = text.slice(i, braceIdx).trim();
    let depth = 1;
    let j = braceIdx + 1;
    while (depth > 0 && j < text.length) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const inner = text.slice(braceIdx + 1, j - 1);
    if (prelude.startsWith('@')) {
      atRules.push({ prelude, inner });
    } else if (prelude) {
      rules.push({ selector: prelude.replace(/\s+/g, ' '), body: inner });
    }
    i = j;
  }
  return { rules, atRules };
}

function flattenRules(text, mediaContext) {
  const stripped = stripComments(text);
  const { rules, atRules } = parseBlocks(stripped);
  const out = rules.map((r) => ({ ...r, media: mediaContext || null }));
  for (const ar of atRules) {
    if (/^@(-webkit-)?keyframes/.test(ar.prelude)) continue;
    if (/^@(media|container|supports)/.test(ar.prelude)) {
      const nextContext = mediaContext ? `${mediaContext} > ${ar.prelude}` : ar.prelude;
      out.push(...flattenRules(ar.inner, nextContext));
    }
  }
  return out;
}

// Splits a selector into combinator-aware, top-level-whitespace-separated parts (depth-aware,
// so a space inside a functional pseudo-class like :not(:has(...)) never splits the compound
// it belongs to). Returns only the compound-selector parts, combinators dropped.
function selectorParts(sel) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else if ((ch === '>' || ch === '+' || ch === '~') && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function declaredDisplay(body) {
  const m = stripComments(body).match(/display\s*:\s*([^;]+);?/);
  return m ? m[1].trim() : null;
}

const UI10_SELECTOR = '.top-nav:not(:has(.nav-search-icon-btn)) .nav-search-btn';

const SESSIONS_MARKER = '\n * Sessions index: no list controls\n';

const SESSIONS_SELECTORS = [
  'main.content:has(> .card-grid > .entity-card[data-entity-type="session"]) > .breadcrumbs',
  'main.content:has(> .card-grid > .entity-card[data-entity-type="session"]) > .index-header > .index-count',
  'main.content:has(> .card-grid > .entity-card[data-entity-type="session"]) > .index-header > .sort-control',
  'main.content:has(> .card-grid > .entity-card[data-entity-type="session"]) > .pill-filters',
  'main.content:has(> .card-grid > .entity-card[data-entity-type="session"]) > .name-filter',
];

// ============================================================================================
// T1: exactly one rule gives .nav-search-btn a display other than none, and it carries the
// UI-10 scope.
// ============================================================================================

test('T1: the only rule giving .nav-search-btn a display other than none has exactly the UI-10 selector, scoped to no .nav-search-icon-btn present', () => {
  const rules = flattenRules(readCss(), null);

  const navSearchBtnDisplayRules = rules.filter((r) => {
    const parts = selectorParts(r.selector);
    const rightmost = parts[parts.length - 1];
    if (rightmost !== '.nav-search-btn') return false;
    const display = declaredDisplay(r.body);
    return display !== null && display !== 'none';
  });

  assert.equal(
    navSearchBtnDisplayRules.length,
    1,
    `expected exactly one rule un-hiding .nav-search-btn, found ${navSearchBtnDisplayRules.length}: ${JSON.stringify(navSearchBtnDisplayRules.map((r) => r.selector))}`,
  );

  const [rule] = navSearchBtnDisplayRules;
  assert.equal(rule.selector, UI10_SELECTOR);
  assert.ok(rule.media, 'expected the un-hide rule to sit inside a media query');
  assert.match(rule.media, /max-width:\s*767px/, 'expected the un-hide rule inside @media (max-width: 767px)');
  // No @media print exists anywhere in the file that could hide a second, unscoped rule from
  // the sweep above; assert that directly so a future addition of one doesn't quietly slip
  // an unscoped rule past this test's `rules` list (flattenRules already descends into every
  // @media block, print included, so this is a belt-and-braces literal check).
  assert.doesNotMatch(readCss(), /@media\s+print/, 'expected no @media print block in this file');
});

// ============================================================================================
// T2: the Sessions marker section exists, its selectors equal the five independently-written
// selectors, and its only declaration is display: none.
// ============================================================================================

test('T2: the Sessions index section exists with exactly the five selectors and only display: none', () => {
  const sec = sectionFor(css(), SESSIONS_MARKER);
  const sels = selectors(sec);
  assert.deepEqual(sels, SESSIONS_SELECTORS);

  const stripped = stripComments(sec);
  const bodyMatch = stripped.match(/\{([^}]*)\}/);
  assert.ok(bodyMatch, 'expected exactly one rule body in the Sessions index section');
  const declarations = bodyMatch[1].trim().replace(/;\s*$/, '');
  assert.equal(declarations, 'display: none');

  // Only one rule (one brace pair) exists in the section -- otherwise a second declaration
  // block could sit alongside the five-selector one unnoticed by the check above.
  const braceCount = (stripped.match(/\{/g) || []).length;
  assert.equal(braceCount, 1, 'expected exactly one rule in the Sessions index section');
});

// ============================================================================================
// T3: every selector in the section uses the exact-match hook and the full child chain.
// ============================================================================================

test('T3: every Sessions-index selector uses [data-entity-type="session"] (exact match) and the > .card-grid > .entity-card chain', () => {
  const sec = sectionFor(css(), SESSIONS_MARKER);
  const sels = selectors(sec);
  assert.ok(sels.length > 0);
  for (const sel of sels) {
    assert.ok(sel.includes('[data-entity-type="session"]'), `${sel}: missing exact-match data-entity-type hook`);
    assert.ok(sel.includes('> .card-grid > .entity-card'), `${sel}: missing the > .card-grid > .entity-card chain`);
    assert.doesNotMatch(sel, /\[data-entity-type\s*[\^*|~$]=/, `${sel}: must not use a partial-match attribute operator`);
  }
});

// ============================================================================================
// Real-build change detectors (T4-T6). These pass today and would keep passing even if the
// CSS above were deleted entirely -- they prove the generator's markup still has the shape the
// CSS selectors above depend on, not that the CSS itself is correct.
// ============================================================================================

function buildFixture(name, campaign) {
  const vaultPath = path.join(__dirname, 'fixtures', name);
  const siteConfig = require(path.join(__dirname, 'fixtures', `${name}-site-config.json`));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-r1b-${name}-`));
  const siteDir = path.join(scratch, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const finalOut = path.join(scratch, 'out');
  const userJsonConfig = { ...siteConfig, vaultPath };

  // Both fixtures used here are also built with force: true elsewhere in this suite (e.g.
  // test/session-wrap-guard.test.js for wrapup-vault, test/build-sessions-index.test.js for
  // story-vault) -- force: true is the loud, greppable statement that a leak-scan hit, if any,
  // is expected and not what this test is about; these tests are about search/Sessions-index
  // housestyle, not the leak scan.
  const result = runAtomicBuild({
    vaultPath,
    userJsonConfig,
    finalOut,
    siteDir,
    campaign,
    force: true,
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
  return { scratch, finalOut };
}

function walkHtmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

test('T4: a real build of wrapup-vault gives sessions/index.html the expected control order', () => {
  const { scratch, finalOut } = buildFixture('wrapup-vault', 'r1b-t4-wrapup');
  try {
    const indexPath = path.join(finalOut, 'sessions', 'index.html');
    assert.ok(fs.existsSync(indexPath), 'expected sessions/index.html to exist');
    const html = fs.readFileSync(indexPath, 'utf8');

    const iMain = html.indexOf('<main class="content">');
    assert.notEqual(iMain, -1);
    const iBreadcrumb = html.indexOf('<nav class="breadcrumbs"', iMain);
    assert.notEqual(iBreadcrumb, -1, 'expected nav.breadcrumbs inside main.content');
    const iHeader = html.indexOf('class="index-header"', iBreadcrumb);
    assert.notEqual(iHeader, -1, 'expected .index-header after the breadcrumb');
    const iCount = html.indexOf('class="index-count"', iHeader);
    assert.notEqual(iCount, -1, 'expected .index-count inside .index-header');
    const iSort = html.indexOf('class="sort-control"', iCount);
    assert.notEqual(iSort, -1, 'expected .sort-control inside .index-header, after .index-count');
    const iHeaderClose = html.indexOf('</div>', iSort);
    assert.notEqual(iHeaderClose, -1);
    const iPills = html.indexOf('class="pill-filters"', iHeaderClose);
    assert.notEqual(iPills, -1, 'expected .pill-filters after .index-header (wrapup-vault has two session note types)');
    const iNameFilter = html.indexOf('class="name-filter"', iPills);
    assert.notEqual(iNameFilter, -1, 'expected .name-filter after .pill-filters');
    const iCardGrid = html.indexOf('class="card-grid"', iNameFilter);
    assert.notEqual(iCardGrid, -1, 'expected .card-grid after .name-filter');
    const iSessionCard = html.indexOf('data-entity-type="session"', iCardGrid);
    assert.notEqual(iSessionCard, -1, 'expected a data-entity-type="session" card inside .card-grid');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('T5: a real build of story-vault has no session-typed card on any generic index page other than sessions/index.html', () => {
  const { scratch, finalOut } = buildFixture('story-vault', 'r1b-t5-story');
  try {
    const htmlFiles = walkHtmlFiles(finalOut);
    let sortControlPagesChecked = 0;
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      if (!html.includes('class="sort-control"')) continue;
      const rel = path.relative(finalOut, file).split(path.sep).join('/');
      sortControlPagesChecked++;
      if (rel === 'sessions/index.html') continue;
      assert.doesNotMatch(
        html,
        /data-entity-type="session"/,
        `${rel}: a generic index page other than sessions/index.html must not carry a session-typed card`,
      );
    }
    assert.ok(sortControlPagesChecked > 0, 'expected at least one generic index page (with a sort-control) in story-vault\'s build');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('T6: a real build of story-vault gives every top-nav header both the text and icon search buttons', () => {
  const { scratch, finalOut } = buildFixture('story-vault', 'r1b-t6-story');
  try {
    const htmlFiles = walkHtmlFiles(finalOut);
    let navPagesChecked = 0;
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      if (!html.includes('class="top-nav"')) continue;
      navPagesChecked++;
      const rel = path.relative(finalOut, file).split(path.sep).join('/');
      assert.ok(
        html.includes('class="nav-search-btn"'),
        `${rel}: expected class="nav-search-btn" in the header. If this goes red, the pin's ` +
        'header markup changed -- re-run the browser gate\'s missing-icon check (H3) before ' +
        'assuming the CSS fix still works.',
      );
      assert.ok(
        html.includes('class="nav-search-icon-btn"'),
        `${rel}: expected class="nav-search-icon-btn" in the header. If this goes red, the pin's ` +
        'header markup changed -- re-run the browser gate\'s missing-icon check (H3) before ' +
        'assuming the CSS fix still works.',
      );
    }
    assert.ok(navPagesChecked > 0, 'expected at least one page with a top-nav header in story-vault\'s build');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
