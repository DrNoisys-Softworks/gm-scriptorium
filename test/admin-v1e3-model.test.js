'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PV } = require(path.join(__dirname, '..', 'assets', 'admin', 'sitepane.js'));

/*
 * V1e-3 (SD-23, SD-24, AC-V3-*). Pure PV model tests, loaded via require() (the VB pattern).
 * Independent literals throughout -- none of the expected values below are derived from the code
 * under test. NV.viewKey/viewFor(3-arg)/placeFor and paneLayout's below/ownTrigger/D-16 swap
 * cases are covered in test/admin-v1e2-model.test.js (SD-26 extends that file for this slice; see
 * its own header comment) rather than duplicated here.
 */

// === PV.frameSrc =================================================================================

test('frameSrc: a valid host/port/rel builds the exact URL, percent-encoding each segment', () => {
  assert.equal(PV.frameSrc('127.0.0.1', 4100, 'index.html'), 'http://127.0.0.1:4100/index.html');
  assert.equal(PV.frameSrc('localhost', 80, 'a/b/c.html'), 'http://localhost:80/a/b/c.html');
  assert.equal(PV.frameSrc('127.0.0.1', 4100, 'a b.html'), 'http://127.0.0.1:4100/a%20b.html');
  assert.equal(PV.frameSrc('127.0.0.1', 4100, 'a#b.html'.replace('#', '')), 'http://127.0.0.1:4100/ab.html'); // sanity: no literal # reaches here
});

test('frameSrc: invalid hosts give null, including a string-prefix sibling (F10)', () => {
  assert.equal(PV.frameSrc('127.0.0.10', 4100, 'x.html'), null);
  assert.equal(PV.frameSrc('localhostx', 4100, 'x.html'), null);
  assert.equal(PV.frameSrc('evil.example', 4100, 'x.html'), null);
  assert.equal(PV.frameSrc(null, 4100, 'x.html'), null);
  assert.equal(PV.frameSrc(undefined, 4100, 'x.html'), null);
});

test('frameSrc: invalid ports give null (0, 65536, a float, a string)', () => {
  assert.equal(PV.frameSrc('127.0.0.1', 0, 'x.html'), null);
  assert.equal(PV.frameSrc('127.0.0.1', 65536, 'x.html'), null);
  assert.equal(PV.frameSrc('127.0.0.1', 80.5, 'x.html'), null);
  assert.equal(PV.frameSrc('127.0.0.1', '80', 'x.html'), null);
  assert.equal(PV.frameSrc('127.0.0.1', -1, 'x.html'), null);
  assert.equal(PV.frameSrc('127.0.0.1', null, 'x.html'), null);
});

test('frameSrc: rel table -- F11 ancestor-direction guards, forbidden characters, empty segments', () => {
  const cases = [
    ['', null], // empty
    ['/x.html', null], // leading slash
    ['..', null],
    ['../x.html', null], // F11: ancestor escape
    ['a/../b.html', null], // .. as a middle segment
    ['./x.html', null], // '.' segment
    ['a//b.html', null], // empty segment
    ['a\\b.html', null], // backslash
    ['a:b.html', null], // colon
    ['a?b.html', null], // question mark
    ['a#b.html', null], // hash
    ['index.html', 'http://127.0.0.1:4100/index.html'],
    ['people/a b.html', 'http://127.0.0.1:4100/people/a%20b.html'],
  ];
  for (const [rel, expected] of cases) {
    assert.equal(PV.frameSrc('127.0.0.1', 4100, rel), expected, `rel=${JSON.stringify(rel)}`);
  }
});

test('frameSrc: non-string rel gives null', () => {
  assert.equal(PV.frameSrc('127.0.0.1', 4100, null), null);
  assert.equal(PV.frameSrc('127.0.0.1', 4100, undefined), null);
  assert.equal(PV.frameSrc('127.0.0.1', 4100, 42), null);
});

// === PV.pageOptions ================================================================================

test('pageOptions: labels come from ROLE_LABELS; recap/character append ": <title>" only when title is non-empty', () => {
  const pages = [
    { role: 'landing', rel: 'index.html', title: 'Landing page' },
    { role: 'recap', rel: 'episodes/ep2.html', title: 'Episode 02' },
    { role: 'recap', rel: 'episodes/ep2.html', title: '' },
    { role: 'character', rel: 'people/a.html', title: 'Sera Wick' },
    { role: 'timeline', rel: 'chronicle.html', title: 'Chronology' }, // timeline never appends title
    { role: 'notfound', rel: '404.html', title: 'Not-found page' },
  ];
  assert.deepEqual(PV.pageOptions(pages), [
    { rel: 'index.html', role: 'landing', text: 'Landing page' },
    { rel: 'episodes/ep2.html', role: 'recap', text: 'Latest recap: Episode 02' },
    { rel: 'episodes/ep2.html', role: 'recap', text: 'Latest recap' },
    { rel: 'people/a.html', role: 'character', text: 'A character: Sera Wick' },
    { rel: 'chronicle.html', role: 'timeline', text: 'Timeline' },
    { rel: '404.html', role: 'notfound', text: 'Not-found page' },
  ]);
});

test('pageOptions: an empty or missing array gives []', () => {
  assert.deepEqual(PV.pageOptions([]), []);
  assert.deepEqual(PV.pageOptions(null), []);
  assert.deepEqual(PV.pageOptions(undefined), []);
});

// === PV.registrationFor ============================================================================

test('registrationFor: the full table', () => {
  assert.deepEqual(PV.registrationFor('wide', 'ov1'), { screen: 'ov1', global: null });
  assert.deepEqual(PV.registrationFor('laptop', 'ov1'), { screen: 'ov1', global: null });
  assert.deepEqual(PV.registrationFor('phone', 'ov1'), { screen: 'ov1', global: null });
  assert.deepEqual(PV.registrationFor('wide', 'ov3'), { screen: 'ov3', global: null });
  assert.deepEqual(PV.registrationFor('laptop', 'ov3'), { screen: 'ov3', global: null });
  assert.deepEqual(PV.registrationFor('wide', 'ov2'), { screen: null, global: 'ov2' });
  assert.deepEqual(PV.registrationFor('laptop', 'ov2'), { screen: null, global: null });
  assert.deepEqual(PV.registrationFor('phone', 'ov2'), { screen: null, global: null });
  assert.deepEqual(PV.registrationFor('wide', 'nonexistent'), { screen: null, global: null });
});

// === PV.followRole (SD-24) =========================================================================

test('followRole: overview, theme, title and vault-config always give "landing"', () => {
  for (const screen of ['overview', 'theme', 'title', 'vault-config']) {
    assert.equal(PV.followRole(screen, null), 'landing');
    assert.equal(PV.followRole(screen, { screen, role: 'timeline' }), 'landing', 'landing screens never read the hint role');
  }
});

test('followRole: images follows "notfound" only with a matching hint, else "landing"', () => {
  assert.equal(PV.followRole('images', { screen: 'images', role: 'notfound' }), 'notfound');
  assert.equal(PV.followRole('images', { screen: 'images', role: 'landing' }), 'landing');
  assert.equal(PV.followRole('images', null), 'landing');
  assert.equal(PV.followRole('images', { screen: 'vocab', role: 'notfound' }), 'landing', 'a hint for the WRONG screen is ignored');
});

test('followRole: vocab follows the hint role when it is timeline/character/recap and matches, else "timeline"', () => {
  assert.equal(PV.followRole('vocab', { screen: 'vocab', role: 'timeline' }), 'timeline');
  assert.equal(PV.followRole('vocab', { screen: 'vocab', role: 'character' }), 'character');
  assert.equal(PV.followRole('vocab', { screen: 'vocab', role: 'recap' }), 'recap');
  assert.equal(PV.followRole('vocab', { screen: 'vocab', role: 'landing' }), 'timeline', 'an unlisted role falls back to timeline');
  assert.equal(PV.followRole('vocab', null), 'timeline');
  assert.equal(PV.followRole('vocab', { screen: 'images', role: 'timeline' }), 'timeline', 'a hint for the WRONG screen is ignored');
});

test('followRole: any other screen gives null (stay on the current page)', () => {
  for (const screen of ['check', 'preview', 'publish', 'sessions', 'ai', 'storage', 'memory']) {
    assert.equal(PV.followRole(screen, null), null);
  }
});

test('followRole: "constructor" and "__proto__" as the screen argument never resolve via the prototype chain', () => {
  assert.equal(PV.followRole('constructor', null), null);
  assert.equal(PV.followRole('__proto__', null), null);
  assert.equal(PV.followRole('toString', null), null);
});

test('followRole: a hint whose own screen does not match the given screen is ignored, even for the images/vocab special cases', () => {
  assert.equal(PV.followRole('images', { screen: 'overview', role: 'notfound' }), 'landing');
  assert.equal(PV.followRole('vocab', { screen: 'title', role: 'character' }), 'timeline');
});

// === PV.freshnessLine ==============================================================================

const FIXED_TIME_OF = (iso) => (iso === '2026-09-30T12:04:00.000Z' ? '12:04' : 'XX:XX');

test('freshnessLine: not built gives the exact "none" literal, unaffected by pending', () => {
  assert.deepEqual(PV.freshnessLine(null, [], FIXED_TIME_OF), { state: 'none', text: 'Nothing built yet.' });
  assert.deepEqual(PV.freshnessLine({ built: false }, [], FIXED_TIME_OF), { state: 'none', text: 'Nothing built yet.' });
});

test('freshnessLine: fresh gives the exact literal, with a pending suffix when there are pending links', () => {
  const info = { built: true, builtAt: '2026-09-30T12:04:00.000Z', stale: false, savedSince: [], panelSavesSince: 0 };
  assert.deepEqual(PV.freshnessLine(info, [], FIXED_TIME_OF), { state: 'fresh', text: 'Built 12:04 from everything saved.' });
  assert.deepEqual(PV.freshnessLine(info, [{ id: 'vocab', text: '2 unsaved changes in Vocabulary' }], FIXED_TIME_OF), {
    state: 'fresh',
    text: 'Built 12:04 from everything saved. Not in any build: 2 unsaved changes in Vocabulary.',
  });
});

test('freshnessLine: stale names the kind of save via SAVED_WORDS, joining multiple with ", "', () => {
  const info1 = { built: true, builtAt: '2026-09-30T12:04:00.000Z', stale: true, savedSince: ['vault-config.md'], panelSavesSince: 1 };
  assert.deepEqual(PV.freshnessLine(info1, [], FIXED_TIME_OF), {
    state: 'stale',
    text: 'Built 12:04. Saved since: the tagline or vault settings.',
  });

  const info2 = { built: true, builtAt: '2026-09-30T12:04:00.000Z', stale: true, savedSince: ['pack.toml', 'vault.config.json'], panelSavesSince: 2 };
  assert.deepEqual(PV.freshnessLine(info2, [], FIXED_TIME_OF), {
    state: 'stale',
    text: 'Built 12:04. Saved since: theme, images or words, the site title.',
  });
});

test('freshnessLine: counter-only staleness (savedSince empty, panelSavesSince > 0) gives the exact "other changes" words', () => {
  const info = { built: true, builtAt: '2026-09-30T12:04:00.000Z', stale: true, savedSince: [], panelSavesSince: 1 };
  assert.deepEqual(PV.freshnessLine(info, [], FIXED_TIME_OF), {
    state: 'stale',
    text: 'Built 12:04. Saved since: other changes saved in the panel.',
  });
});

// === STATUS_PILL_TEXT / RESIDUAL_FINE_PRINT / FRAME_SANDBOX literals ============================

test('STATUS_PILL_TEXT and RESIDUAL_FINE_PRINT are the exact typed literals', () => {
  assert.deepEqual(PV.STATUS_PILL_TEXT, { none: 'not built yet', fresh: 'up to date', stale: 'out of date' });
  assert.equal(
    PV.RESIDUAL_FINE_PRINT,
    "Edits to your vault's notes made outside the panel don't show as out of date here. Rebuild to be sure.",
  );
});

test('FRAME_SANDBOX and POSTCARD_ROLES/ROLE_LABELS are the exact typed literals', () => {
  assert.equal(PV.FRAME_SANDBOX, 'allow-scripts allow-same-origin');
  assert.deepEqual(PV.POSTCARD_ROLES, ['landing', 'recap', 'timeline']);
  assert.deepEqual(PV.ROLE_LABELS, {
    landing: 'Landing page',
    recap: 'Latest recap',
    character: 'A character',
    timeline: 'Timeline',
    notfound: 'Not-found page',
  });
});

// === B1: busy contract -- an exact, independently counted literal =================================
//
// sitepane.js funnels every Rebuild/Build control through one shared buildRebuildBtn() helper
// (which sets `.disabled = store.isBusy()` exactly once, internally) rather than repeating the
// assignment at each call site (V1c's own pack.js pattern instead repeats the assignment per
// button; sitepane.js centralises it). The literal below is a MEASURED count of call sites to
// that helper (grep, not derived from reading the function's own behaviour): the empty state, ov1
// pane, ov2 bar, ov3 foot, and the ov3 lightbox head -- 5. B1's mutation (Rebuild ignores isBusy)
// is caught by removing the one `store.isBusy()` read inside the shared helper, which is
// equivalent to breaking every call site at once.

test('B1: sitepane.js calls buildRebuildBtn() exactly 5 times (measured), and the shared helper reads store.isBusy() exactly once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'sitepane.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const callSites = (stripped.match(/buildRebuildBtn\(\{/g) || []).length;
  assert.equal(callSites, 5, 'every Rebuild/Build control must funnel through the one shared helper');

  const disabledAssignments = (stripped.match(/\.disabled\s*=\s*store\.isBusy\(\)/g) || []).length;
  assert.equal(disabledAssignments, 1, 'exactly one place reads store.isBusy() for the disabled state (inside the shared helper)');

  // The one busy-only central reassignment loop (P20/B1 precedent: pack.js:600-604's own
  // "re-evaluate disabled on a busy change alone" subscription).
  assert.match(stripped, /reevaluateBusy/, 'a central busy-only reassignment function must exist');
  assert.match(stripped, /querySelectorAll\(\s*'\[data-role="preview-rebuild"\]'\s*\)/, 'the reassignment loop must re-query every live rebuild button');
});

// === placementLabel: SD-23's three placement-button copy literals (re-review finding) ============
//
// Found in re-review of 9421960 (REPORT-reviewer-20261001T001539Z.md, "out-of-scope finding"):
// sitepane.js:457's ternary had identical branches (` Show as a drawer` on both sides), so the
// button never said "Show full screen" at phone width per SD-23. Pulled the decision out into a
// pure PV function so each of the three copy literals is independently asserted, with no DOM.

test('placementLabel: below + laptop gives "Show as a drawer" (the laptop overlay kind is a drawer)', () => {
  assert.equal(PV.placementLabel('below', 'laptop'), 'Show as a drawer');
});

test('placementLabel: below + phone gives "Show full screen" (the phone overlay kind is a sheet) -- the reported defect', () => {
  assert.equal(PV.placementLabel('below', 'phone'), 'Show full screen');
});

test('placementLabel: overlay (not below) gives "Show below the Overview", at both laptop and phone', () => {
  assert.equal(PV.placementLabel('overlay', 'laptop'), 'Show below the Overview');
  assert.equal(PV.placementLabel('overlay', 'phone'), 'Show below the Overview');
});

test('placementLabel: any place other than exactly "below" takes the overlay-label branch (matches NV.placeFor\'s own two-value contract)', () => {
  assert.equal(PV.placementLabel(undefined, 'laptop'), 'Show below the Overview');
  assert.equal(PV.placementLabel('bogus', 'phone'), 'Show below the Overview');
});
