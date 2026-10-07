'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { NV } = require(path.join(__dirname, '..', 'assets', 'admin', 'nav.js'));
const { ST } = require(path.join(__dirname, '..', 'assets', 'admin', 'store.js'));

/*
 * V1e-2 (SD-10, SD-11, SD-12, AC-06), extended V1e-3 (SD-20, SD-21, SD-22). Pure model tests,
 * loaded via require() (the VB pattern). Independent literals throughout -- none of the expected
 * values below are derived from the code under test.
 */

// === NV.VIEWS literal ===========================================================================

test('NV.VIEWS: each of the 5 screens lists exactly its mock\'s options, id and name, in order', () => {
  assert.deepEqual(NV.VIEWS.overview, [
    { id: 'ov1', name: 'Docked preview' },
    { id: 'ov2', name: 'Split screen' },
    { id: 'ov3', name: 'Postcards' },
  ]);
  assert.deepEqual(NV.VIEWS.title, [
    { id: 'tt1', name: 'Title card' },
    { id: 'tt2', name: 'Where it shows' },
    { id: 'tt3', name: 'Site details' },
  ]);
  assert.deepEqual(NV.VIEWS.images, [
    { id: 'im1', name: 'Slot gallery' },
    { id: 'im2', name: 'On the page' },
    { id: 'im3', name: 'Library first' },
  ]);
  assert.deepEqual(NV.VIEWS.vocab, [
    { id: 'vo1', name: 'How-to rail' },
    { id: 'vo2', name: 'Live example' },
    { id: 'vo3', name: 'Friendly rows' },
  ]);
  assert.deepEqual(NV.VIEWS['vault-config'], [
    { id: 'vc1', name: 'Guarded dialog' },
    { id: 'vc2', name: 'Unlock and watch' },
    { id: 'vc3', name: 'Fields by risk' },
  ]);
  assert.deepEqual(Object.keys(NV.VIEWS).sort(), ['images', 'overview', 'title', 'vault-config', 'vocab']);
});

// === NV.viewFor (V1e-3: 3-arg, per viewport class) ==============================================

test('viewFor: a valid chosen value for the screen+viewport is returned unchanged', () => {
  assert.equal(NV.viewFor({ 'view.overview.wide': 'ov3' }, 'overview', 'wide'), 'ov3');
  assert.equal(NV.viewFor({ 'view.title.laptop': 'tt2' }, 'title', 'laptop'), 'tt2');
});

test('viewFor: class independence -- a value set for one viewport class never leaks into another', () => {
  const prefs = { 'view.title.laptop': 'tt2' };
  assert.equal(NV.viewFor(prefs, 'title', 'laptop'), 'tt2');
  assert.equal(NV.viewFor(prefs, 'title', 'wide'), 'tt1');
  assert.equal(NV.viewFor(prefs, 'title', 'phone'), 'tt1');
});

test('viewFor: a missing, null, or invalid-for-that-screen value falls back to that screen\'s own-class default', () => {
  assert.equal(NV.viewFor({}, 'overview', 'wide'), 'ov1');
  assert.equal(NV.viewFor(null, 'title', 'laptop'), 'tt1');
  assert.equal(NV.viewFor(undefined, 'vocab', 'phone'), 'vo1');
  assert.equal(NV.viewFor({ 'view.overview.wide': 'tt1' }, 'overview', 'wide'), 'ov1'); // another screen's id
  assert.equal(NV.viewFor({ 'view.overview.wide': 'ov9' }, 'overview', 'wide'), 'ov1');
});

test('viewFor: an unknown/omitted viewport is treated as "laptop"', () => {
  assert.equal(NV.viewFor({ 'view.title.laptop': 'tt2' }, 'title'), 'tt2');
  assert.equal(NV.viewFor({ 'view.title.laptop': 'tt2' }, 'title', 'widex'), 'tt2');
  assert.equal(NV.viewFor({ 'view.title.wide': 'tt3' }, 'title', 'widex'), 'tt1'); // wide's value must NOT be read
});

test('viewFor: "constructor" and "__proto__" as the screen argument never resolve via the prototype chain', () => {
  assert.equal(NV.viewFor({}, 'constructor', 'wide'), null);
  assert.equal(NV.viewFor({}, '__proto__', 'wide'), null);
  assert.equal(NV.viewFor({}, 'toString', 'wide'), null);
  assert.equal(NV.viewFor({}, 'hasOwnProperty', 'wide'), null);
});

test('viewFor: "constructor" and "__proto__" as the CHOSEN VALUE never match any real option, so it falls back', () => {
  assert.equal(NV.viewFor({ 'view.overview.wide': 'constructor' }, 'overview', 'wide'), 'ov1');
  assert.equal(NV.viewFor({ 'view.overview.wide': '__proto__' }, 'overview', 'wide'), 'ov1');
});

test('viewFor: an unknown screen id returns null (no default exists for it)', () => {
  assert.equal(NV.viewFor({}, 'nonexistent-screen', 'wide'), null);
});

// === NV.viewKey ===================================================================================

test('viewKey: a known screen and viewport gives the exact dotted key; an unknown screen or viewport gives null', () => {
  assert.equal(NV.viewKey('title', 'laptop'), 'view.title.laptop');
  assert.equal(NV.viewKey('vault-config', 'phone'), 'view.vault-config.phone');
  assert.equal(NV.viewKey('nonexistent', 'wide'), null);
  assert.equal(NV.viewKey('title', 'widex'), null); // P16: a string-prefix sibling must never match
  assert.equal(NV.viewKey('title', 'constructor'), null);
  assert.equal(NV.viewKey('constructor', 'wide'), null);
});

// P17: an argument-swap mutation (viewKey(viewport, screen)) must go red against this table.
test('P17 guard: viewKey(screen, viewport) is order-sensitive -- the swapped call never gives the same key', () => {
  assert.notEqual(NV.viewKey('laptop', 'title'), NV.viewKey('title', 'laptop'));
  assert.equal(NV.viewKey('laptop', 'title'), null); // 'laptop' is not a known screen id
});

// === NV.placeFor ===================================================================================

test('placeFor: laptop and phone default to "below" (owner decision, 2026-09-30); wide is always "overlay"', () => {
  assert.equal(NV.placeFor({}, 'laptop'), 'below');
  assert.equal(NV.placeFor({}, 'phone'), 'below');
  assert.equal(NV.placeFor({}, 'wide'), 'overlay');
  assert.equal(NV.placeFor({ 'pane.place.laptop': 'below', 'pane.place.phone': 'below' }, 'wide'), 'overlay');
});

test('placeFor: an explicit choice per class is honoured; classes are independent', () => {
  assert.equal(NV.placeFor({ 'pane.place.laptop': 'overlay' }, 'laptop'), 'overlay');
  assert.equal(NV.placeFor({ 'pane.place.laptop': 'overlay' }, 'phone'), 'below'); // untouched class keeps its own default
});

test('placeFor: an unlisted value falls back to the default; an unknown viewport is always "overlay"', () => {
  assert.equal(NV.placeFor({ 'pane.place.laptop': 'bogus' }, 'laptop'), 'below');
  assert.equal(NV.placeFor({ 'pane.place.laptop': 'below' }, 'phonex'), 'overlay');
});

// === NV.viewportClass ============================================================================

test('viewportClass: laptop is the space between the phone and wide breakpoints; 699 and 1800 are typed literals', () => {
  assert.equal(NV.viewportClass(699), 'phone');
  assert.equal(NV.viewportClass(700), 'laptop');
  assert.equal(NV.viewportClass(1799), 'laptop');
  assert.equal(NV.viewportClass(1800), 'wide');
  assert.equal(NV.viewportClass(390), 'phone');
  assert.equal(NV.viewportClass(1280), 'laptop');
  assert.equal(NV.viewportClass(2400), 'wide');
});

// === NV.paneLayout ===============================================================================
//
// Fixtures below are typed independently from each screen's mock behaviour (overview.js,
// vocab.js), not derived from nav.js's own implementation. AC-06's per-view table:
//   ov1 dock/drawer/sheet, ov2 dock/inline/inline, ov3 dock/inline/inline,
//   vo1 and vo2 dock/dock/inline, the rest none.

const OV1_SPEC = {
  label: 'Site preview',
  presentation: { wide: 'dock', laptop: 'drawer', phone: 'sheet' },
  hideable: true,
  hiddenPref: 'pane.hidden',
  hiddenAs: 'edge',
};
const OV2_SPEC = { label: 'Player site', presentation: { wide: 'dock', laptop: 'inline', phone: 'inline' }, hideable: false, hiddenPref: null, hiddenAs: 'none' };
const OV3_SPEC = { label: 'Snapshots', presentation: { wide: 'dock', laptop: 'inline', phone: 'inline' }, hideable: false, hiddenPref: null, hiddenAs: 'none' };
const VO1_SPEC = { label: 'How to use', presentation: { wide: 'dock', laptop: 'dock', phone: 'inline' }, hideable: true, hiddenPref: 'rail.hidden', hiddenAs: 'edge' };
const VO2_SPEC = { label: 'How it will look', presentation: { wide: 'dock', laptop: 'dock', phone: 'inline' }, hideable: true, hiddenPref: 'rail.hidden', hiddenAs: 'edge' };
const TITLE_SPEC_NONE = { label: 'nothing', presentation: { wide: null, laptop: null, phone: null }, hideable: false, hiddenPref: null, hiddenAs: 'none' };

const EMPTY_RESULT = { dock: null, below: null, edges: [], overlay: null, inline: null };

test('paneLayout: null specs everywhere gives an all-empty result at every viewport (below: null too)', () => {
  for (const vp of ['wide', 'laptop', 'phone']) {
    assert.deepEqual(NV.paneLayout(vp, null, null, {}), EMPTY_RESULT);
  }
});

test('paneLayout table: ov1 is dock at wide; at laptop/phone it is an edge-triggered overlay by DEFAULT -- but the owner default is "below", so a spec must opt IN with belowable to get an overlay at all here (a non-belowable spec, per SD-21, still overlays)', () => {
  const wide = NV.paneLayout('wide', OV1_SPEC, null, {});
  assert.deepEqual(wide.dock, { owner: 'screen', spec: OV1_SPEC });
  assert.equal(wide.below, null);
  assert.equal(wide.overlay, null);
  assert.deepEqual(wide.edges, []);

  // OV1_SPEC here has no `belowable` flag, so SD-21's below branch never applies regardless of
  // placeFor's own default -- it always overlays, exactly as V1e-2 built it.
  const laptop = NV.paneLayout('laptop', OV1_SPEC, null, {});
  assert.equal(laptop.dock, null);
  assert.equal(laptop.below, null);
  assert.deepEqual(laptop.overlay, { owner: 'screen', spec: OV1_SPEC, kind: 'drawer' });
  assert.deepEqual(laptop.edges, [{ owner: 'screen', spec: OV1_SPEC, action: 'open' }]);

  const phone = NV.paneLayout('phone', OV1_SPEC, null, {});
  assert.equal(phone.dock, null);
  assert.equal(phone.below, null);
  assert.deepEqual(phone.overlay, { owner: 'screen', spec: OV1_SPEC, kind: 'sheet' });
  assert.deepEqual(phone.edges, [{ owner: 'screen', spec: OV1_SPEC, action: 'open' }]);
});

test('paneLayout table: ov2 and ov3 are dock at wide, inline (no pane at all) at laptop and phone', () => {
  for (const spec of [OV2_SPEC, OV3_SPEC]) {
    const wide = NV.paneLayout('wide', spec, null, {});
    assert.deepEqual(wide.dock, { owner: 'screen', spec: spec });
    assert.equal(wide.inline, null);

    for (const vp of ['laptop', 'phone']) {
      const r = NV.paneLayout(vp, spec, null, {});
      assert.equal(r.dock, null);
      assert.equal(r.below, null);
      assert.equal(r.overlay, null);
      assert.deepEqual(r.edges, []);
      assert.deepEqual(r.inline, { owner: 'screen', spec: spec });
    }
  }
});

test('paneLayout table: vo1/vo2 dock at wide and laptop, inline at phone', () => {
  for (const spec of [VO1_SPEC, VO2_SPEC]) {
    for (const vp of ['wide', 'laptop']) {
      const r = NV.paneLayout(vp, spec, null, {});
      assert.deepEqual(r.dock, { owner: 'screen', spec: spec });
    }
    const phone = NV.paneLayout('phone', spec, null, {});
    assert.equal(phone.dock, null);
    assert.deepEqual(phone.inline, { owner: 'screen', spec: spec });
  }
});

test('paneLayout table: a screen with no presentation values ("the rest are none") shows nothing at any width', () => {
  for (const vp of ['wide', 'laptop', 'phone']) {
    assert.deepEqual(NV.paneLayout(vp, TITLE_SPEC_NONE, null, {}), EMPTY_RESULT);
  }
});

test('paneLayout: hidden-with-edge -- pane.hidden true on a hideable dock spec with hiddenAs "edge" collapses to an edge tab, dock empty', () => {
  const r = NV.paneLayout('wide', OV1_SPEC, null, { 'pane.hidden': true });
  assert.equal(r.dock, null);
  assert.deepEqual(r.edges, [{ owner: 'screen', spec: OV1_SPEC, action: 'reveal' }]);
});

test('paneLayout: hidden-with-none -- a hidden hideable dock spec with hiddenAs "none" shows nothing, not even an edge tab', () => {
  const noneSpec = Object.assign({}, OV1_SPEC, { hiddenAs: 'none' });
  const r = NV.paneLayout('wide', noneSpec, null, { 'pane.hidden': true });
  assert.equal(r.dock, null);
  assert.deepEqual(r.edges, []);
});

test('paneLayout: a non-hideable spec ignores prefs[hiddenPref] entirely and stays docked', () => {
  const r = NV.paneLayout('wide', OV2_SPEC, null, { 'pane.hidden': true, 'ov2.hidden': true });
  assert.deepEqual(r.dock, { owner: 'screen', spec: OV2_SPEC });
});

// === V1e-3: below (SD-21) ==========================================================================

const OV1_BELOWABLE = Object.assign({}, OV1_SPEC, { belowable: true });

test('below: a belowable drawer/sheet spec at laptop/phone with placeFor "below" gives result.below, no overlay, no open edge', () => {
  const laptop = NV.paneLayout('laptop', OV1_BELOWABLE, null, { 'pane.place.laptop': 'below' });
  assert.deepEqual(laptop.below, { owner: 'screen', spec: OV1_BELOWABLE });
  assert.equal(laptop.overlay, null);
  assert.deepEqual(laptop.edges, []);
  assert.equal(laptop.dock, null);

  const phone = NV.paneLayout('phone', OV1_BELOWABLE, null, { 'pane.place.phone': 'below' });
  assert.deepEqual(phone.below, { owner: 'screen', spec: OV1_BELOWABLE });
  assert.equal(phone.overlay, null);
  assert.deepEqual(phone.edges, []);
});

test('below: the SAME belowable spec with placeFor "overlay" (an explicit choice) goes back to a normal overlay + open edge', () => {
  const r = NV.paneLayout('laptop', OV1_BELOWABLE, null, { 'pane.place.laptop': 'overlay' });
  assert.equal(r.below, null);
  assert.deepEqual(r.overlay, { owner: 'screen', spec: OV1_BELOWABLE, kind: 'drawer' });
  assert.deepEqual(r.edges, [{ owner: 'screen', spec: OV1_BELOWABLE, action: 'open' }]);
});

test('below: P18 -- below is ignored at wide (there is no below option there) even if belowable and "below" is somehow set', () => {
  // OV1_BELOWABLE's own wide mode is 'dock', so below never even applies -- this proves placeFor
  // itself is wide-safe too (placeFor always returns 'overlay' at wide).
  assert.equal(NV.placeFor({ 'pane.place.laptop': 'below' }, 'wide'), 'overlay');
});

test('below: a non-belowable spec (no `belowable: true`) never goes below, even with placeFor "below"', () => {
  const r = NV.paneLayout('laptop', OV1_SPEC, null, { 'pane.place.laptop': 'below' });
  assert.equal(r.below, null);
  assert.deepEqual(r.overlay, { owner: 'screen', spec: OV1_SPEC, kind: 'drawer' });
});

// === V1e-3: ownTrigger (SD-21) ======================================================================

test('ownTrigger: a drawer/sheet spec with ownTrigger:true gets NO open edge (the consumer draws its own trigger)', () => {
  const spec = Object.assign({}, OV1_SPEC, { ownTrigger: true });
  const r = NV.paneLayout('laptop', spec, null, { 'pane.place.laptop': 'overlay' });
  assert.deepEqual(r.overlay, { owner: 'screen', spec: spec, kind: 'drawer' });
  assert.deepEqual(r.edges, [], 'ownTrigger must suppress the open edge entirely');
});

test('ownTrigger: a "reveal" edge (the hidden-dock case) is unaffected by ownTrigger', () => {
  const spec = Object.assign({}, OV1_SPEC, { ownTrigger: true });
  const r = NV.paneLayout('wide', spec, null, { 'pane.hidden': true });
  assert.deepEqual(r.edges, [{ owner: 'screen', spec: spec, action: 'reveal' }]);
});

// === D-16 (V1e-3: swap, not the V1e-2 dead reveal) ================================================

test('D-16 swap: screen-and-global at wide -- the screen spec docks, and a distinct global dock-at-wide spec collapses to a SWAP edge naming the screen\'s own hiddenPref', () => {
  const r = NV.paneLayout('wide', VO1_SPEC, OV2_SPEC, {});
  assert.deepEqual(r.dock, { owner: 'screen', spec: VO1_SPEC });
  assert.deepEqual(r.edges, [{ owner: 'global', spec: OV2_SPEC, action: 'swap', pref: 'rail.hidden' }]);
});

test('D-16: with no hideable screen spec (no hiddenPref), there is deliberately NO dead edge -- not a "reveal" that does nothing', () => {
  const notHideable = Object.assign({}, VO1_SPEC, { hideable: false, hiddenPref: null });
  const r = NV.paneLayout('wide', notHideable, OV2_SPEC, {});
  assert.deepEqual(r.dock, { owner: 'screen', spec: notHideable });
  assert.deepEqual(r.edges, [], 'no hideable screen spec means no edge for the outranked global at all');
});

test('D-16: with no screen spec, the global spec alone wins and behaves exactly as a screen spec would (owner "global")', () => {
  const r = NV.paneLayout('wide', null, OV2_SPEC, {});
  assert.deepEqual(r.dock, { owner: 'global', spec: OV2_SPEC });
  assert.deepEqual(r.edges, []); // no second, distinct global spec to add an edge for
});

test('D-16: the global-swap-edge rule only fires at wide, never at laptop or phone', () => {
  for (const vp of ['laptop', 'phone']) {
    const r = NV.paneLayout(vp, VO1_SPEC, OV2_SPEC, {});
    assert.deepEqual(
      r.edges.filter((e) => e.owner === 'global'),
      [],
    );
  }
});

test('D-16: when the global spec\'s own wide mode is not "dock", no edge tab is added for it', () => {
  const globalInline = Object.assign({}, OV2_SPEC, { presentation: { wide: 'inline', laptop: 'inline', phone: 'inline' } });
  const r = NV.paneLayout('wide', VO1_SPEC, globalInline, {});
  assert.deepEqual(
    r.edges.filter((e) => e.owner === 'global'),
    [],
  );
});

// P19 guard: a mutation that made "swap" set the GLOBAL's own pref (V1e-2's do-nothing "reveal"
// behaviour) instead of the SCREEN's pref must go red against the literal edge shape above.
test('P19 guard: the swap edge names the SCREEN spec\'s hiddenPref, never the global spec\'s own', () => {
  const r = NV.paneLayout('wide', VO1_SPEC, OV2_SPEC, {});
  const swapEdge = r.edges.find((e) => e.action === 'swap');
  assert.equal(swapEdge.pref, VO1_SPEC.hiddenPref);
  assert.notEqual(swapEdge.pref, OV2_SPEC.hiddenPref);
});

// === ST.withPref =================================================================================

test('ST.withPref: a pure merge, original object untouched', () => {
  const before = { 'view.overview.wide': 'ov1', 'pane.hidden': false };
  const after = ST.withPref(before, 'pane.hidden', true);
  assert.deepEqual(after, { 'view.overview.wide': 'ov1', 'pane.hidden': true });
  assert.deepEqual(before, { 'view.overview.wide': 'ov1', 'pane.hidden': false }, 'withPref must not mutate its input');
});

test('ST.withPref: starting from an empty/undefined object still produces a valid merge', () => {
  assert.deepEqual(ST.withPref({}, 'view.title.wide', 'tt2'), { 'view.title.wide': 'tt2' });
});

// === Drift: NV.VIEWS/NV.PREF_DEFAULTS against src/admin/prefs.js's PREF_SCHEMA =================

const { PREF_SCHEMA, defaults, VIEWPORTS: SERVER_VIEWPORTS } = require(path.join(__dirname, '..', 'src', 'admin', 'prefs.js'));

const SCREEN_FOR_PREF_PREFIX = {
  'view.overview': 'overview',
  'view.title': 'title',
  'view.images': 'images',
  'view.vocab': 'vocab',
  'view.vault-config': 'vault-config',
};

test('drift: NV.VIEWPORTS equals src/admin/prefs.js\'s own VIEWPORTS export', () => {
  assert.deepEqual(NV.VIEWPORTS, SERVER_VIEWPORTS);
  assert.deepEqual(NV.VIEWPORTS, ['wide', 'laptop', 'phone']);
});

test('drift: every view.*.<class> PREF_SCHEMA allowedValues list equals NV.VIEWS[screen]\'s ids, in order, for every class', () => {
  for (const [key, allowed] of PREF_SCHEMA) {
    const lastDot = key.lastIndexOf('.');
    const prefix = key.slice(0, lastDot);
    const vp = key.slice(lastDot + 1);
    const screen = SCREEN_FOR_PREF_PREFIX[prefix];
    if (!screen) continue;
    assert.ok(NV.VIEWPORTS.includes(vp), `${key} must end in a known viewport class`);
    const ids = NV.VIEWS[screen].map((v) => v.id);
    assert.deepEqual(ids, allowed, `${key} vs NV.VIEWS.${screen}`);
  }
});

test('drift: NV.PREF_DEFAULTS equals PREF_SCHEMA\'s defaults(), and both equal an independent 21-key literal typed from the mock OPTS plus the owner\'s placement decision', () => {
  // Typed independently from panel-v3-mockups/r3-src/*.js OPTS[0].id for each screen (the mock's
  // first option in each list, applied at every viewport class per D-15), never derived from
  // PREF_SCHEMA or NV.VIEWS. pane.place.laptop/phone: the owner's decision (2026-09-30, Part 10 of
  // the V1e-3/4/6 architect run) overriding the Architect's own drawer/sheet default.
  const fromMockOpts = {
    'view.overview.wide': 'ov1',
    'view.overview.laptop': 'ov1',
    'view.overview.phone': 'ov1',
    'view.title.wide': 'tt1',
    'view.title.laptop': 'tt1',
    'view.title.phone': 'tt1',
    'view.images.wide': 'im1',
    'view.images.laptop': 'im1',
    'view.images.phone': 'im1',
    'view.vocab.wide': 'vo1',
    'view.vocab.laptop': 'vo1',
    'view.vocab.phone': 'vo1',
    'view.vault-config.wide': 'vc1',
    'view.vault-config.laptop': 'vc1',
    'view.vault-config.phone': 'vc1',
    'pane.place.laptop': 'below',
    'pane.place.phone': 'below',
    'pane.hidden': false,
    'rail.hidden': false,
    'ov2.follow': true,
    'preview.device': 'desktop',
  };
  assert.equal(PREF_SCHEMA.length, 21);
  assert.deepEqual(defaults(), fromMockOpts);
  assert.deepEqual(NV.PREF_DEFAULTS, fromMockOpts);
});

// === NV.pickFocusTarget (V1e-3 rework, Reviewer finding 2026-09-30: lost focus on overlay close) ==
//
// Reproduces the exact bug shape: frame.js's closeOverlay() fallback used to be
// document.querySelector('[data-pane-trigger="<owner>"]'), the FIRST DOM match regardless of
// visibility. At laptop width the hidden phone top-bar trigger sorts before the visible hero
// trigger in document order, so focus silently fell through to <body>. These fixtures are typed
// independently from that exact scenario, never derived from pickFocusTarget's own body.

test('pickFocusTarget: the original trigger, connected and visible, wins at index 0', () => {
  const descriptors = [
    { connected: true, visible: true }, // the original trigger -- still good
    { connected: true, visible: false }, // the hidden phone top-bar trigger, sorts second here
  ];
  assert.equal(NV.pickFocusTarget(descriptors), 0);
});

test('pickFocusTarget: THE BUG SHAPE -- original trigger gone (stale), hidden phone trigger sorts first in the DOM, visible hero trigger sorts second -- must pick the visible one, index 1, never the hidden index-0 one', () => {
  const descriptors = [
    { connected: true, visible: false }, // hidden phone top-bar trigger: first DOM match, but not focusable
    { connected: true, visible: true }, // visible hero trigger: what focus must land on
  ];
  assert.equal(NV.pickFocusTarget(descriptors), 1, 'must skip the hidden first match and pick the visible second one');
});

test('pickFocusTarget: a disconnected (isConnected === false) candidate is skipped even if it reports visible', () => {
  const descriptors = [
    { connected: false, visible: true }, // removed from the document (e.g. a hero re-render)
    { connected: true, visible: true },
  ];
  assert.equal(NV.pickFocusTarget(descriptors), 1);
});

test('pickFocusTarget: no connected+visible candidate anywhere gives -1 (caller must then leave focus alone, never force it to <body>)', () => {
  assert.equal(NV.pickFocusTarget([{ connected: false, visible: true }, { connected: true, visible: false }]), -1);
  assert.equal(NV.pickFocusTarget([]), -1);
  assert.equal(NV.pickFocusTarget([null, undefined]), -1);
});

test('pickFocusTarget: a candidate missing a key entirely (not exactly true) is treated as not usable', () => {
  assert.equal(NV.pickFocusTarget([{ connected: true }, { connected: true, visible: true }]), 1);
  assert.equal(NV.pickFocusTarget([{ visible: true }, { connected: true, visible: true }]), 1);
});
