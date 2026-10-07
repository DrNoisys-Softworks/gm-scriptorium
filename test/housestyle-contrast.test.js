'use strict';

// R6 (#85, #86): source-level regression guard for the Connections lane relation-word fix, the
// haze token override, and the two "readable button" product-file sections (404, story landing).
//
// These source checks prove how the rules are written: that the right selectors read the right
// tokens, that no colour literal crept back in, and that nothing else in the file quietly widens
// the fix. They do NOT prove the resulting colours are actually readable -- only a browser,
// rendering the real cascade against a real theme and preset, can measure a computed contrast
// ratio. That proof is the browser gate ($G/contrast-gate.js), run separately and logged in
// $G/red-log.md; the numbers here are structural, not colorimetric.
//
// Helpers below are COPIED from test/housestyle-story.test.js (itself copied from
// test/housestyle-bookleaves.test.js), per that file's own instruction: copy, don't import.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');
const HAZE_CSS_PATH = path.join(__dirname, '..', 'assets', 'themes', 'haze', 'theme.css');
const LEAF = 'body:has(> .top-nav) > main.content:not(:has(> .landing-hero))';
const CONNECTIONS_MARKER = '\n * Connections lane\n';
const SESSIONS_MARKER = '\n * Sessions index: no list controls\n';
const FOUR_OH_FOUR_MARKER = '\n * 404 page: a readable home button\n';
const STORY_BEGIN_MARKER = '\n * Story landing: a readable begin-reading button\n';

function css() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function hazeCss() {
  return fs.readFileSync(HAZE_CSS_PATH, 'utf8');
}

// -- Helpers copied from test/housestyle-story.test.js:28-40 ------------------------------------

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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -- T1 -------------------------------------------------------------------------------------

test('T1: every color: declaration in the Connections section reads inherit, currentColor, or a --sc-leaf/cx/on-* token, never a bare generator variable', () => {
  const sec = stripComments(sectionFor(css(), CONNECTIONS_MARKER));
  const decls = [...sec.matchAll(/(?<![a-zA-Z-])color\s*:\s*([^;]+);/g)];
  assert.ok(decls.length > 0, 'sanity: expected at least one color: declaration in the section');
  for (const m of decls) {
    const value = m[1].trim();
    const ok =
      value === 'inherit' ||
      value === 'currentColor' ||
      /^var\(--sc-(?:leaf|cx|on)-[a-z0-9-]+\)$/.test(value);
    assert.ok(ok, `unexpected color value "${value}" (must be inherit, currentColor, or var(--sc-leaf/cx/on-*))`);
  }
});

// -- T2 -------------------------------------------------------------------------------------

test('T2: the tie and named kind rules read exactly the two new relation tokens', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  assert.match(
    sec,
    new RegExp(`${escapeRe(LEAF)} \\.sc-cx-kind-tie \\.sc-cx-rel\\s*\\{\\s*color:\\s*var\\(--sc-cx-rel-tie\\);\\s*\\}`),
  );
  assert.match(
    sec,
    new RegExp(`${escapeRe(LEAF)} \\.sc-cx-kind-named \\.sc-cx-rel\\s*\\{\\s*color:\\s*var\\(--sc-cx-rel-named\\);\\s*\\}`),
  );
});

// -- T3 -------------------------------------------------------------------------------------

test('T3: the Connections :root block defaults both relation tokens to body ink, and the lane container carries body ink', () => {
  const sec = sectionFor(css(), CONNECTIONS_MARKER);
  const rootMatch = sec.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootMatch, 'expected a :root token block in the Connections section');
  assert.match(rootMatch[1], /--sc-cx-rel-tie:\s*var\(--sc-leaf-ink\);/);
  assert.match(rootMatch[1], /--sc-cx-rel-named:\s*var\(--sc-leaf-ink\);/);

  const cxRuleRe = new RegExp(`${escapeRe(LEAF)} \\.sc-cx \\{([^}]*)\\}`);
  const cxMatch = sec.match(cxRuleRe);
  assert.ok(cxMatch, 'expected a LEAF .sc-cx rule');
  assert.match(cxMatch[1], /color:\s*var\(--sc-leaf-ink\);/);
});

// -- T4 -------------------------------------------------------------------------------------

test('T4: haze declares both relation tokens, reading its own brass/glow colours, inside a custom-property-only :root block', () => {
  const haze = stripComments(hazeCss());
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let found = null;
  while ((m = ruleRe.exec(haze))) {
    if (m[1].trim() !== ':root') continue;
    const decls = m[2]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
    if (decls.length === 0) continue;
    const allCustom = decls.every((d) => d.startsWith('--'));
    if (allCustom && m[2].includes('--sc-cx-rel-tie')) {
      found = m[2];
      break;
    }
  }
  assert.ok(found, 'expected a custom-property-only :root block declaring --sc-cx-rel-tie in haze');
  assert.match(found, /--sc-cx-rel-tie:\s*var\(--sc-th-brass\);/);
  assert.match(found, /--sc-cx-rel-named:\s*var\(--sc-th-glow\);/);
});

// -- T5 -------------------------------------------------------------------------------------

function assertOneRuleSection(wholeCss, marker, precedingMarker, expectedSelector, expectedDecls, buttonClass) {
  const markerIdx = wholeCss.indexOf(marker);
  assert.notEqual(markerIdx, -1, `expected the section marker "${marker}"`);
  if (precedingMarker) {
    const precedingIdx = wholeCss.indexOf(precedingMarker);
    assert.notEqual(precedingIdx, -1, `expected the preceding section marker "${precedingMarker}"`);
    assert.ok(markerIdx > precedingIdx, `"${marker}" must come after "${precedingMarker}"`);
  }

  const sec = sectionFor(wholeCss, marker);
  const strippedSec = stripComments(sec);
  const rules = [...strippedSec.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.equal(rules.length, 1, `expected exactly one rule in the "${marker.trim()}" section`);
  const [, selector, body] = rules[0];
  assert.equal(selector.trim(), expectedSelector);
  const decls = body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  assert.deepEqual(decls, expectedDecls);
  assert.doesNotMatch(body, /!important/);

  const strippedWhole = stripComments(wholeCss);
  const nameHits = [...strippedWhole.matchAll(new RegExp(`\\.${escapeRe(buttonClass)}\\b`, 'g'))];
  assert.equal(nameHits.length, 1, `expected exactly one selector naming .${buttonClass} in the whole file`);
}

test('T5: the 404 section has exactly one rule on the exact markup selector, after the Sessions-index section, and nothing else in the file names the button or declares the hook variables', () => {
  const wholeCss = css();
  assertOneRuleSection(
    wholeCss,
    FOUR_OH_FOUR_MARKER,
    SESSIONS_MARKER,
    'main.content > .four-oh-four-hero > .four-oh-four-home',
    ['background: var(--text)', 'color: var(--bg)'],
    'four-oh-four-home',
  );
  const strippedWhole = stripComments(wholeCss);
  assert.doesNotMatch(strippedWhole, /--theme-accent\s*:/, 'the product file must never declare --theme-accent');
  assert.doesNotMatch(strippedWhole, /--white\s*:/, 'the product file must never declare --white');
});

// -- T5b (owner addition alongside #86: the same fix for .story-begin) ------------------------

test('T5b: the story-landing section has exactly one rule on the exact markup selector, after the 404 section, and nothing else in the file names the button', () => {
  const wholeCss = css();
  assertOneRuleSection(
    wholeCss,
    STORY_BEGIN_MARKER,
    FOUR_OH_FOUR_MARKER,
    'main.content > .story-branch > p > .story-begin',
    ['background: var(--text)', 'color: var(--bg)'],
    'story-begin',
  );
});

// -- T6 (change detector) ----------------------------------------------------------------------

test('T6 (change detector): a real build of grapheme-vault keeps the 404 markup and generator style block this fix depends on', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contrast-t6-'));
  try {
    const vaultPath = path.join(__dirname, 'fixtures', 'grapheme-vault');
    const siteConfig = require(path.join(__dirname, 'fixtures', 'grapheme-vault-site-config.json'));
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const result = runAtomicBuild({
      vaultPath,
      userJsonConfig: { ...siteConfig, vaultPath },
      finalOut,
      siteDir,
      campaign: 'contrast-t6',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error && result.error.message));

    const html = fs.readFileSync(path.join(finalOut, '404.html'), 'utf8');
    const REPIN_MSG = 're-run the browser gate after a repin -- this checks an assumption about the vendored generator, not our own fix';

    const heroMatch = html.match(/<main class="content">\s*<div class="four-oh-four-hero">([\s\S]*?)<\/div>\s*<\/main>/);
    assert.ok(heroMatch, `expected main.content > div.four-oh-four-hero as a direct child; ${REPIN_MSG}`);
    const anchorIdx = heroMatch[1].indexOf('<a href');
    assert.ok(anchorIdx !== -1, `expected an <a ...> inside the hero div; ${REPIN_MSG}`);
    const beforeAnchor = heroMatch[1].slice(0, anchorIdx);
    assert.equal(
      (beforeAnchor.match(/<div|<section/g) || []).length,
      0,
      `expected no wrapper element between the hero div and the button, i.e. a direct child; ${REPIN_MSG}`,
    );
    assert.match(heroMatch[1].slice(anchorIdx), /^<a href="[^"]*" class="four-oh-four-home">/, REPIN_MSG);

    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(styleMatch, `expected a page-local <style> block on the 404 page; ${REPIN_MSG}`);
    const selectorsNamingButton = [...styleMatch[1].matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((sel) => sel.includes('.four-oh-four-home'));
    assert.deepEqual(selectorsNamingButton, ['.four-oh-four-home', '.four-oh-four-home:hover'], REPIN_MSG);
    const buttonBody = styleMatch[1].match(/\.four-oh-four-home\s*\{([^}]*)\}/)[1];
    assert.match(buttonBody, /background:\s*var\(--theme-accent,\s*var\(--accent\)\);/, REPIN_MSG);
    assert.match(buttonBody, /color:\s*var\(--white,\s*#fff\);/, REPIN_MSG);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// -- T7 (change detector) ----------------------------------------------------------------------

test('T7 (change detector): a real build of story-vault keeps static .sc-cx-kind-tie items carrying a .sc-cx-rel', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contrast-t7-'));
  try {
    const vaultPath = path.join(__dirname, 'fixtures', 'story-vault');
    const siteConfig = require(path.join(__dirname, 'fixtures', 'story-vault-site-config.json'));
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const result = runAtomicBuild({
      vaultPath,
      userJsonConfig: { ...siteConfig, vaultPath },
      finalOut,
      siteDir,
      campaign: 'contrast-t7',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error && result.error.message));

    const htmlFiles = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.html')) htmlFiles.push(full);
      }
    })(finalOut);

    let tieWithRel = 0;
    let namedCount = 0;
    const REPIN_MSG = 're-run the browser gate after a repin -- this checks the fixture, not our own fix';
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      tieWithRel += (html.match(/class="sc-cx-kind-tie"><a[^>]*>[^<]*<\/a> <span class="sc-cx-rel">/g) || []).length;
      namedCount += (html.match(/class="sc-cx-kind-named"/g) || []).length;
    }
    assert.ok(tieWithRel > 0, `expected at least one static .sc-cx-kind-tie item with a .sc-cx-rel; ${REPIN_MSG}`);

    // Named count recorded at PARENT (f45fa17): 0. story-vault's declared relationships are all
    // one-directional frontmatter entries with no reciprocal body-text wikilink, so no hub page's
    // own hop1 graph currently surfaces a "named" item from this fixture. The browser gate's own
    // scratch copies of this vault add one declared back-relationship (a body-text mention plus
    // the other page's own declared relationship) to get a real "named" example to measure --
    // that edit lives only in scratch, never in this committed fixture.
    assert.equal(namedCount, 0, `story-vault's named count changed from the PARENT recording of 0; ${REPIN_MSG}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
