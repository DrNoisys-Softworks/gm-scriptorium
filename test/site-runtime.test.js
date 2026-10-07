'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SITE_JS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js');

// assets/site/scriptorium.js's IIFE exports {TL, CX, PT} via module.exports when running under
// plain node (no `document`/`window`), the same branch the site-runtime tests target.
const { TL, CX, PT } = require(SITE_JS_PATH);

test('CX.capFor: 599 is 6, 600 is 8', () => {
  assert.equal(CX.capFor(599), 6);
  assert.equal(CX.capFor(600), 8);
});

test('CX.visible: honours rank (filters to rank <= cap, preserves order)', () => {
  const items = [
    { name: 'a', rank: 3 },
    { name: 'b', rank: 1 },
    { name: 'c', rank: 8 },
    { name: 'd', rank: 9 },
  ];
  const vis = CX.visible(items, 3, false);
  assert.deepEqual(vis.map((i) => i.name), ['a', 'b']);
  assert.deepEqual(CX.visible(items, 3, true).map((i) => i.name), ['a', 'b', 'c', 'd']);
});

test('CX.restItem: returns the last tie, otherwise the first item', () => {
  const withTies = [
    { name: 'mention1', kind: 'mention' },
    { name: 'tie1', kind: 'tie' },
    { name: 'tie2', kind: 'tie' },
  ];
  assert.equal(CX.restItem(withTies).name, 'tie2');

  const noTies = [{ name: 'mention1', kind: 'mention' }, { name: 'named1', kind: 'named' }];
  assert.equal(CX.restItem(noTies).name, 'mention1');

  assert.equal(CX.restItem([]), null);
});

test('TL.points(lens): ghosts everything except backstory; learned inserted after its anchor', () => {
  const data = {
    points: [
      { id: 'p1', seg: 's1', s: 0, w: 2, k: 'backstory', t: 'Before', when: 'long ago', x: 'x' },
      { id: 'p2', seg: 's2', s: 1, w: 3, k: 'fight', t: 'Fight', when: 'week 1', x: 'y' },
    ],
    learned: [{ id: 'l1', after: 'p2', s: 1, t: 'Learned it', x: 'body', links: [] }],
  };
  const story = TL.points(data, false);
  assert.deepEqual(story.map((p) => p.id), ['p1', 'p2']);
  assert.ok(story.every((p) => p.ghost === false));

  const lens = TL.points(data, true);
  assert.deepEqual(lens.map((p) => p.id), ['p1', 'p2', 'l1']);
  assert.equal(lens.find((p) => p.id === 'p1').ghost, false); // backstory stays live
  assert.equal(lens.find((p) => p.id === 'p2').ghost, true); // everything else ghosts
  assert.equal(lens.find((p) => p.id === 'l1').k, 'learned');
});

test('TL.layout: the before-segment is 132 wide, the unit is 80, the ghost unit is 30', () => {
  const segs = [
    { id: 's1', tier: 'Before', label: 'long ago', before: true },
    { id: 's2', tier: 'The lane', label: 'Week 1', before: false },
  ];
  const points = [
    { id: 'p1', seg: 's1', ghost: false },
    { id: 'p2', seg: 's2', ghost: false },
    { id: 'p3', seg: 's2', ghost: true },
  ];
  const L = TL.layout(points, segs);
  assert.equal(L.beforeWidth || L.beforeW, 132);
  assert.equal(L.unit, 80);
  assert.equal(L.gunit, 30);
  assert.equal(L.segW.s1, 132);
});

test('TL.kindLine: "fight" + weight 3 is "A fight, a turning point"', () => {
  assert.equal(TL.kindLine({ k: 'fight', w: 3 }), 'A fight, a turning point');
  assert.equal(TL.kindLine({ k: 'learned', w: 2 }), 'What the party learned');
  assert.equal(TL.kindLine({ k: 'backstory', w: 2 }), 'Backstory');
  assert.equal(TL.kindLine({ k: '', w: 2 }), 'A scene');
  assert.equal(TL.kindLine({ k: '', w: 1 }), 'An aside');
});

// -- FR-C2/AC-12 (the a1 lane): declared ties then "Named by" on the LEFT, mentions grouped on
// the RIGHT (Lead Requirements doc, timeline-connections-lead-requirements-2026-09-24.md:144).
// Expected values are the brief's own group keys, stated independently here -- not read back off
// CX.LEFT_GROUPS/CX.RIGHT_GROUPS, which is the thing under test.

test('CX.side: tie and named are on the left; every mention group is on the right', () => {
  assert.equal(CX.side('tie'), 'L');
  assert.equal(CX.side('named'), 'L');
  for (const mentionGroup of ['pc', 'npc', 'faction', 'location', 'thing', 'event', 'other']) {
    assert.equal(CX.side(mentionGroup), 'R', mentionGroup);
  }
});

// -- Coordinator rework 3: on initial layout, a lane wider than its container centres the hub
// -- (never scrolling the page itself -- this is the lane's own scrollLeft).

test('CX.centerScrollLeft: centres the hub in the scroller, clamped to [0, scrollWidth-clientWidth]', () => {
  // A lane 1000px wide in a 400px container, hub sitting at [460, 540] (80px wide, centred in
  // the full lane) -- centring it means scrollLeft 300 (so the hub's own centre, 500, lands on
  // the viewport's centre, 200, i.e. viewport [300,700)).
  assert.equal(CX.centerScrollLeft(460, 80, 400, 1000), 300);

  // Hub near the left edge: the naive centred position would be negative, clamp to 0.
  assert.equal(CX.centerScrollLeft(20, 80, 400, 1000), 0);

  // Hub near the right edge: the naive centred position would overshoot, clamp to the max
  // scrollable offset (scrollWidth - clientWidth).
  assert.equal(CX.centerScrollLeft(940, 80, 400, 1000), 600);

  // The lane already fits inside its container: nothing to scroll.
  assert.equal(CX.centerScrollLeft(50, 80, 400, 380), null);
  assert.equal(CX.centerScrollLeft(50, 80, 400, 400), null);
});

// -- lane-centre-fix: the connections lane's one-time initial centring races a webfont swap (ADR
// -- 0017 residual, found by the private QC screenshot harness's H8 step -- see that step's
// -- README for the reproduction). CX.scrollGuard distinguishes a real user scroll from this
// -- file's own programmatic writes; CX.recentreOnFontsReady is the one-time post-fonts
// -- correction itself, gated on "nothing has moved the lane on since the initial render".

test('CX.scrollGuard: swallows the echo of a programmatic write, reports every other scroll as real', () => {
  const guard = CX.scrollGuard();
  assert.equal(guard.onScroll(120), true); // no markProgrammatic call at all: a real scroll

  guard.markProgrammatic(300, 0);
  assert.equal(guard.onScroll(300), false); // this one's an echo of our own write
  assert.equal(guard.onScroll(300), true); // the mark was consumed; the next one is real again

  guard.markProgrammatic(300, 0);
  guard.markProgrammatic(300, 0); // marking twice in a row still only swallows one echo
  assert.equal(guard.onScroll(300), false);
  assert.equal(guard.onScroll(300), true);
});

test('CX.scrollGuard: a coalesced user scroll (observed position is not the written one) is real, issue #22', () => {
  const guard = CX.scrollGuard();
  guard.markProgrammatic(300, 0);
  // The user scrolled in the same tick as our write: one merged event, at a position we never wrote.
  assert.equal(guard.onScroll(340), true);
  // The mark is spent, so a following genuine echo-looking position is not swallowed either.
  assert.equal(guard.onScroll(300), true);
});

test('CX.scrollGuard: a write that leaves the position unchanged does not stay armed, issue #22', () => {
  const guard = CX.scrollGuard();
  guard.markProgrammatic(300, 300); // no scroll event will follow
  assert.equal(guard.onScroll(450), true); // the next real scroll must not be swallowed
  guard.markProgrammatic(300, 299.6); // within 1px counts as unchanged as well
  assert.equal(guard.onScroll(450), true);
});

test('CX.scrollGuard: a write the browser clamps or rounds (within 1px) is still recognised as its echo, issue #22', () => {
  const guard = CX.scrollGuard();
  guard.markProgrammatic(300.4, 0);
  assert.equal(guard.onScroll(300), false);
  guard.markProgrammatic(300.5, 0);
  assert.equal(guard.onScroll(301), false);
  guard.markProgrammatic(300, 0);
  assert.equal(guard.onScroll(302), true); // 2px away is a real scroll
  guard.markProgrammatic(300, 0);
  assert.equal(guard.onScroll(), true); // no observed position: cannot be classified as an echo
});

test('CX.recentreOnFontsReady: reproduces + fixes the race -- never measures before fonts.ready resolves, then measures exactly once against the fresh (post-swap) layout', async () => {
  // The pre-swap centring already happened elsewhere (synchronously, at the first
  // ResizeObserver callback) -- not this function's job. Its own job is the one-time
  // correction once the *real*, final fonts are in, which is why measure() must never run
  // before fontsObj.ready settles: doing so would just reproduce the frozen pre-swap race this
  // fix exists to close.
  let resolveReady;
  const fontsObj = { ready: new Promise((resolve) => { resolveReady = resolve; }) };
  let measureCalls = 0;
  const measure = () => {
    measureCalls++;
    return 156; // the post-swap centring value -- different from whatever the pre-swap layout produced
  };
  const applied = [];

  CX.recentreOnFontsReady(fontsObj, () => false, measure, (v) => applied.push(v));

  assert.equal(measureCalls, 0);
  assert.deepEqual(applied, []);

  resolveReady();
  await fontsObj.ready;
  await Promise.resolve(); // let recentreOnFontsReady's own .then() callback run

  assert.equal(measureCalls, 1); // measured exactly once, after the real fonts are in
  assert.deepEqual(applied, [156]);
});

test('CX.recentreOnFontsReady: measure() returning null (the lane fits after all) applies nothing', async () => {
  const fontsObj = { ready: Promise.resolve() };
  const applied = [];
  CX.recentreOnFontsReady(fontsObj, () => false, () => null, (v) => applied.push(v));
  await fontsObj.ready;
  await Promise.resolve();
  assert.deepEqual(applied, []);
});

test('CX.recentreOnFontsReady: isSettled() true -- the reader already scrolled, clicked or roamed -- never measures or applies (must not yank a chosen position)', async () => {
  const fontsObj = { ready: Promise.resolve() };
  let measureCalls = 0;
  const applied = [];
  CX.recentreOnFontsReady(
    fontsObj,
    () => true,
    () => { measureCalls++; return 999; },
    (v) => applied.push(v),
  );
  await fontsObj.ready;
  await Promise.resolve();
  assert.equal(measureCalls, 0);
  assert.deepEqual(applied, []);
});

test('CX.recentreOnFontsReady: an absent or malformed fontsObj (no document.fonts, no .ready, a non-promise .ready) is a safe no-op', () => {
  assert.doesNotThrow(() => CX.recentreOnFontsReady(undefined, () => false, () => 1, () => {}));
  assert.doesNotThrow(() => CX.recentreOnFontsReady({}, () => false, () => 1, () => {}));
  assert.doesNotThrow(() => CX.recentreOnFontsReady({ ready: 'not-a-promise' }, () => false, () => 1, () => {}));
});

// -- Reviewer HIGH item: the lane's own aria-label promises "Use arrow keys to move between
// -- points" (FR-C2); CX.roam is the index arithmetic behind that (plus Home/End, from the
// -- mock's own handler, conn-work/cx.js:301-313).

test('CX.roam: ArrowRight/ArrowDown +1, ArrowLeft/ArrowUp -1, clamped to [0, count-1]', () => {
  assert.equal(CX.roam(2, 5, 'ArrowRight'), 3);
  assert.equal(CX.roam(2, 5, 'ArrowDown'), 3);
  assert.equal(CX.roam(2, 5, 'ArrowLeft'), 1);
  assert.equal(CX.roam(2, 5, 'ArrowUp'), 1);
  assert.equal(CX.roam(4, 5, 'ArrowRight'), 4); // already last, stays put
  assert.equal(CX.roam(0, 5, 'ArrowLeft'), 0); // already first, stays put
});

test('CX.roam: Home jumps to 0, End jumps to the last index', () => {
  assert.equal(CX.roam(2, 5, 'Home'), 0);
  assert.equal(CX.roam(2, 5, 'End'), 4);
  assert.equal(CX.roam(0, 5, 'Home'), 0);
  assert.equal(CX.roam(4, 5, 'End'), 4);
});

test('CX.roam: an unrelated key, or zero studs, leaves the index unchanged', () => {
  assert.equal(CX.roam(2, 5, 'Escape'), 2);
  assert.equal(CX.roam(2, 5, 'Tab'), 2);
  assert.equal(CX.roam(0, 0, 'ArrowRight'), 0);
});

test('CX.LEFT_GROUPS/CX.RIGHT_GROUPS partition CX.GROUP_ORDER exactly, ties/named first', () => {
  assert.deepEqual(CX.GROUP_ORDER.slice(0, 2), ['tie', 'named']);
  assert.deepEqual(CX.LEFT_GROUPS, ['tie', 'named']);
  assert.deepEqual(CX.RIGHT_GROUPS, CX.GROUP_ORDER.slice(2));
  // No group key is on both sides, or on neither.
  const all = CX.LEFT_GROUPS.concat(CX.RIGHT_GROUPS).slice().sort();
  assert.deepEqual(all, CX.GROUP_ORDER.slice().sort());
});

// -- Issue #51: the PC page tab strip (.tab-bar/.pc-tab, the pin's own lib/templates/pc.js) can
// -- overflow at phone width, and switchTab() -- also the pin's, never touched here -- toggles
// -- .active on click and once on load (from location.hash) without ever scrolling the newly
// -- active tab into view, so its underline can sit at or past the strip's visible edge with no
// -- affordance that more is off-screen. PT.nearestScrollLeft is the pure "how far to scroll"
// -- computation (mirrors Element.scrollIntoView({inline:'nearest'})'s own semantics); the DOM
// -- wiring (not exported, matching TL/CX's own convention of keeping DOM boot private) also
// -- reuses CX.recentreOnFontsReady, already exhaustively covered above, for the identical
// -- webfont-swap race H8 found for the Connections lane -- not re-tested here.

test('PT.nearestScrollLeft: tab already fully visible -- null, nothing to do', () => {
  // Bar is 400 wide, scrolled to 100 (visible range [100,500)). A tab at [150,250) sits
  // entirely inside that range already.
  assert.equal(PT.nearestScrollLeft(150, 100, 400, 1000, 100), null);
});

test('PT.nearestScrollLeft: tab off-screen to the right -- scrolls exactly enough to reveal its right edge', () => {
  // Bar 400 wide, scrolled to 0 (visible [0,400)). Tab at [500, 591) is entirely past 400, so the
  // minimal scroll that reveals it puts its right edge (591) exactly at the visible edge:
  // scrollLeft = tabLeft + tabWidth - clientWidth = 500 + 91 - 400 = 191.
  assert.equal(PT.nearestScrollLeft(500, 91, 400, 1000, 0), 191);
});

test('PT.nearestScrollLeft: tab off-screen to the left -- scrolls exactly enough to reveal its left edge', () => {
  // Bar 400 wide, scrolled to 500 (visible [500,900)). Tab at [200,300) is entirely before 500,
  // so the minimal scroll puts its left edge (200) exactly at the visible edge: scrollLeft = 200.
  assert.equal(PT.nearestScrollLeft(200, 100, 400, 1000, 500), 200);
});

test('PT.nearestScrollLeft: partially clipped on the right -- still resolves to the tab\'s own left-aligned target, clamped', () => {
  // Bar 400 wide, scrolled to 300 (visible [300,700)). Tab at [650,741) starts inside the visible
  // range but its right edge (741) sticks out past 700 -- exactly issue #51's shape (the active
  // tab is PARTLY visible, its underline partly cut off). Target = 650 + 91 - 400 = 341, within
  // the scrollWidth-clientWidth (600) clamp.
  assert.equal(PT.nearestScrollLeft(650, 91, 400, 1000, 300), 341);
});

test('PT.nearestScrollLeft: clamps to [0, scrollWidth-clientWidth] even if the raw target would overshoot', () => {
  // A tab whose own right edge sits past scrollWidth entirely (shouldn't happen with real
  // layout, but the clamp must hold regardless) never asks for more than the bar can scroll.
  assert.equal(PT.nearestScrollLeft(950, 200, 400, 1000, 0), 600); // max = 1000-400
});

test('PT.nearestScrollLeft: the bar does not overflow at all -- null regardless of tab position', () => {
  assert.equal(PT.nearestScrollLeft(50, 80, 400, 380, 0), null);
  assert.equal(PT.nearestScrollLeft(50, 80, 400, 400, 0), null);
});

test('PT.nearestScrollLeft + CX.recentreOnFontsReady composed exactly as initPcTabs wires them: reproduces + fixes issue #51\'s font-swap race for the tab strip', async () => {
  // Mirrors test above ("CX.recentreOnFontsReady: reproduces + fixes the race") but through PT's
  // own measure function, proving the SAME composition assets/site/scriptorium.js's initPcTabs
  // actually uses (not a re-implementation): a tab whose PRE-swap layout fits, but whose
  // POST-swap (wider) label pushes it off the visible edge, gets corrected exactly once, only
  // after fonts settle.
  let resolveReady;
  const fontsObj = { ready: new Promise((resolve) => { resolveReady = resolve; }) };

  // Pre-swap: tab at [300,371) (71 wide, e.g. "Story") already fits in a 400-wide bar scrolled to
  // 0 -- nearestScrollLeft would return null right now.
  // Post-swap: the label grew, so the SAME tab is now [300,391) sitting right at the edge of a
  // clientWidth that also shifted slightly (399) -- still fits (391 < 399), covered by the
  // "already visible" test above; here we simulate the label growing enough to actually clip
  // (right edge 410 > clientWidth 400), which must trigger a correction.
  let postSwap = false;
  const measure = () => {
    const tabLeft = 300;
    const tabWidth = postSwap ? 110 : 71; // grew after the swap
    return PT.nearestScrollLeft(tabLeft, tabWidth, 400, 1000, 0);
  };

  const applied = [];
  const settled = false;
  CX.recentreOnFontsReady(fontsObj, () => settled, measure, (v) => applied.push(v));

  assert.deepEqual(applied, []); // never measures before fonts.ready resolves

  postSwap = true; // the "real" (post-swap) layout is now live
  resolveReady();
  await fontsObj.ready;
  await Promise.resolve();

  assert.deepEqual(applied, [PT.nearestScrollLeft(300, 110, 400, 1000, 0)]);
  assert.equal(applied[0], 10); // 300 + 110 - 400, stated independently of the composed call above
});

// -- Reviewer CORRECTIONS pass on issue #51: initPcTabs set `settled` on a tab click only. A user
// -- who swipes/drags the tab strip by hand before document.fonts.ready resolves was never caught
// -- by anything, so the one-time recentreOnFontsReady correction could still fire afterwards and
// -- silently snap the strip back, overwriting a scroll position the reader just chose themselves
// -- -- the exact "never yank a position the reader already chose" rule CX.recentreOnFontsReady's
// -- own comment states, which the Connections lane already keeps by pairing its own recentre call
// -- with CX.scrollGuard() + a 'scroll' listener (initConnections, ~L943-953). initPcTabs now
// -- reuses that same CX.scrollGuard (not a copy) the same way.
//
// The old single-boolean guard could not tell a coalesced scroll from its own echo (issue #22,
// formerly noted as #59). CX.scrollGuard now compares positions, so initPcTabs inherits the fix
// with no change of its own beyond the new call shape.

// -- Reviewer re-pass on eebd2b2: the previous version of this test only checked that the token
// -- `scrollGuard.onScroll()` appeared inside the scroll listener's body, not that its RETURN
// -- VALUE actually gated `settled = true`. `scrollGuard.onScroll();` (called, result discarded)
// -- matched that regex just as well as `if (scrollGuard.onScroll()) settled = true;` and is
// -- exactly the bug this commit exists to fix -- caught because the two "behavioural" tests
// -- below it hand-rolled the wiring themselves rather than ever calling the real initPcTabs, so
// -- neither one could catch a real regression in initPcTabs's own source.
//
// Fixed by calling the REAL initPcTabs (now exported as PT.initPcTabs -- see its own comment in
// scriptorium.js for why that's safe: a hoisted function declaration, referenced before its own
// textual definition, no runtime behaviour change) against a minimal hand-built fake .tab-bar. No
// jsdom devDependency here, so the fake only implements the exact surface initPcTabs touches:
// querySelector('.pc-tab.active'), clientWidth/scrollWidth/scrollLeft, and
// addEventListener/dispatch for 'scroll'. initPcTabs also reads the global `document.fonts`
// directly (not a parameter), so each test installs a throwaway `global.document` and removes it
// in a `finally` -- this repo's own convention for a mutated global (see the Connections lane's
// unrelated tests for the same cleanup-in-finally shape).

function fakeTabBar({ active, clientWidth, scrollWidth, scrollLeft = 0 }) {
  const listeners = {};
  return {
    scrollLeft,
    clientWidth,
    scrollWidth,
    querySelector(sel) {
      return sel === '.pc-tab.active' ? active : null;
    },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    dispatch(type) {
      (listeners[type] || []).forEach((fn) => fn({}));
    },
  };
}

/** Installs a throwaway `global.document.fonts`, runs `fn(fontsObj, resolveReady)`, then removes it. */
async function withFakeDocumentFonts(fn) {
  let resolveReady;
  const fontsObj = { ready: new Promise((resolve) => { resolveReady = resolve; }) };
  global.document = { fonts: fontsObj };
  try {
    await fn(fontsObj, resolveReady);
  } finally {
    delete global.document;
  }
}

test('PT.initPcTabs: a genuine user scroll before fonts.ready is preserved, not yanked by the one-time correction', async () => {
  await withFakeDocumentFonts(async (fontsObj, resolveReady) => {
    // Active tab at [300, 371), already fully visible in a 400-wide bar scrolled to 0 --
    // PT.nearestScrollLeft(300, 71, 400, 1000, 0) is null, so the initial placement writes
    // nothing (no echo to worry about; this test is about the user's OWN scroll only).
    const active = { offsetLeft: 300, offsetWidth: 71 };
    const bar = fakeTabBar({ active, clientWidth: 400, scrollWidth: 1000, scrollLeft: 0 });

    PT.initPcTabs(bar);
    assert.equal(bar.scrollLeft, 0, 'sanity: nothing written at boot -- the tab already fit');

    // The reader drags the strip by hand to 600 (not perfectly aligned with the active tab --
    // e.g. mid-browse of other tabs), before fonts.ready resolves.
    bar.scrollLeft = 600;
    bar.dispatch('scroll');

    resolveReady();
    await fontsObj.ready;
    await Promise.resolve();
    await Promise.resolve(); // recentreOnFontsReady's own .then() chain adds a microtask

    assert.equal(bar.scrollLeft, 600, "the reader's own scroll position must survive the fonts-ready correction");
  });
});

test('PT.initPcTabs: the initial placement\'s own echo is correctly swallowed, so the fonts-ready correction still fires normally afterwards', async () => {
  await withFakeDocumentFonts(async (fontsObj, resolveReady) => {
    // Active tab at [500, 591) needs the bar (400 wide, 1000 scrollWidth) scrolled to
    // PT.nearestScrollLeft(500, 91, 400, 1000, 0) = 191 at boot -- a real initial-placement write,
    // whose own 'scroll' echo this test dispatches itself (a fake bar's plain scrollLeft property
    // does not auto-fire listeners the way a real element does).
    const active = { offsetLeft: 500, offsetWidth: 91 };
    const bar = fakeTabBar({ active, clientWidth: 400, scrollWidth: 1000, scrollLeft: 0 });

    PT.initPcTabs(bar);
    assert.equal(bar.scrollLeft, 191, 'sanity: the initial placement wrote the expected value');
    bar.dispatch('scroll'); // the initial write's own echo

    // Simulate a webfont swap widening the label between boot and fonts.ready: the fresh
    // measurement at fonts.ready time must differ from the initial one, so this test can tell
    // whether the correction actually ran (vs was wrongly suppressed by the echo above).
    active.offsetWidth = 110;

    resolveReady();
    await fontsObj.ready;
    await Promise.resolve();
    await Promise.resolve();

    // PT.nearestScrollLeft(500, 110, 400, 1000, 191) = 210, stated independently of the composed
    // call, not read back off initPcTabs. If the echo above had been misread as a real
    // interaction (an unconditional listener, ignoring the guard), the correction would have been
    // suppressed and scrollLeft would have stayed at 191.
    assert.equal(PT.nearestScrollLeft(500, 110, 400, 1000, 191), 210);
    assert.equal(bar.scrollLeft, 210, "the initial write's own echo must not have disabled the fonts-ready correction");
  });
});

// -- Residual, stated rather than left for someone to rediscover: a THIRD mutation the Reviewer
// -- named -- dropping the second markProgrammatic() call (the one guarding the fonts-ready
// -- correction's own scrollLeft write) -- has NO observable effect on either behavioural test
// -- above, or on bar.scrollLeft at all, given initPcTabs's current one-shot design. Verified
// -- empirically before writing this: both tests above still pass with that call deleted. Once
// -- CX.recentreOnFontsReady's own isSettled() check has run (exactly once, synchronously inside
// -- its single .then()), nothing in initPcTabs ever reads `settled` again -- a later click just
// -- assigns it unconditionally, never reads it -- so whether that one write's own echo gets
// -- misclassified as a real interaction changes nothing any caller can observe. A behavioural
// -- test genuinely cannot catch this given the function's current scope; only a structural check
// -- of the source can, which is exactly what the test below is for and the only reason it still
// -- exists as a source-level check rather than being folded into the two behavioural tests above.

test('initPcTabs (source-level): every direct bar.scrollLeft write is preceded by scrollGuard.markProgrammatic()', () => {
  // No jsdom here and initPcTabs only runs in a browser -- same posture test/housestyle-
  // story.test.js already documents for initConnections's own wiring ("initConnections never
  // replaces the whole section..."), which this test's own regex-extraction technique is copied
  // from. Source-level check, not a rendering one -- kept deliberately narrow (see the residual
  // note above): the two behavioural tests above already cover the guard's actual effect on
  // scroll classification; this one covers only the mutation neither of them can.
  const js = fs.readFileSync(SITE_JS_PATH, 'utf8');
  const initFn = js.match(/function initPcTabs\(bar\) \{[\s\S]*?\n  \}\n\n  function bootPcTabs/);
  assert.ok(initFn, 'expected an initPcTabs function');
  const body = initFn[0];

  assert.match(body, /CX\.scrollGuard\(\)/, 'expected initPcTabs to reuse CX.scrollGuard(), not a hand-rolled copy');

  const assignments = [...body.matchAll(/([\s\S]{0,80})bar\.scrollLeft\s*=/g)];
  assert.ok(assignments.length >= 2, `expected at least 2 direct bar.scrollLeft assignments (initial + corrected), found ${assignments.length}`);
  for (const m of assignments) {
    assert.match(m[1], /scrollGuard\.markProgrammatic\(\w+, bar\.scrollLeft\);\s*$/, `expected markProgrammatic(<value>, bar.scrollLeft) immediately before this scrollLeft write: ...${m[1].slice(-60)}`);
  }
});
