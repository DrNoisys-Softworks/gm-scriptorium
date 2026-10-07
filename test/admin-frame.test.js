'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { NV } = require(path.join(__dirname, '..', 'assets', 'admin', 'nav.js'));
const { ST } = require(path.join(__dirname, '..', 'assets', 'admin', 'store.js'));
const { IC } = require(path.join(__dirname, '..', 'assets', 'admin', 'icons.js'));

/*
 * Panel v2 V1a, commit C4. NV/ST/IC are pure (the VB pattern), loaded via require() the same way
 * test/admin-vocab-kindentry.test.js loads vocab.js. frame.js itself is browser-only (shared
 * design 1.1's module table) and is exercised by the QA Playwright harness, not here. Independent
 * literals throughout.
 */

// -- NV: NAV triples, groups, order, BOTTOM_BAR, soon/readOnly sets, all as literals ------------

const EXPECTED_NAV = [
  { id: 'overview', group: 'Site', label: 'Overview', short: 'Home' },
  { id: 'theme', group: 'Site', label: 'Theme', short: 'Theme' },
  { id: 'title', group: 'Site', label: 'Title & tagline', short: 'Title & tagline' },
  { id: 'images', group: 'Site', label: 'Images', short: 'Images' },
  { id: 'vocab', group: 'Words', label: 'Vocabulary', short: 'Vocab' },
  { id: 'check', group: 'Run', label: 'Check', short: 'Check' },
  { id: 'preview', group: 'Run', label: 'Preview', short: 'Preview' },
  { id: 'vault-config', group: 'Advanced', label: 'vault-config.md', short: 'vault-config.md' },
  { id: 'memory', group: 'Coming later', label: 'Memory', short: 'Memory' },
  { id: 'publish', group: 'Coming later', label: 'Publish', short: 'Publish' },
  { id: 'sessions', group: 'Coming later', label: 'Sessions', short: 'Sessions' },
  { id: 'ai', group: 'Coming later', label: 'AI console', short: 'AI console' },
  { id: 'storage', group: 'Coming later', label: 'Storage', short: 'Storage' },
];

const EXPECTED_GROUP_ORDER = ['Site', 'Words', 'Run', 'Advanced', 'Coming later'];
const EXPECTED_BOTTOM_BAR = ['overview', 'vocab', 'check', 'preview'];
const EXPECTED_SOON = ['memory', 'publish', 'sessions', 'ai', 'storage'];
// V1e-9 (SD-102, D-5): vault-config.md moves off the static readOnly flag entirely (it is now
// guarded, with NV.guardMarker deciding "guarded"/"editing"/"read-only" at runtime); the set is
// empty.
const EXPECTED_READONLY = [];

test('NV.NAV: ids, groups, labels, shorts and order equal the independent literal', () => {
  const actual = NV.NAV.map((n) => ({ id: n.id, group: n.group, label: n.label, short: n.short }));
  assert.deepEqual(actual, EXPECTED_NAV);
});

test('NV.GROUP_ORDER equals the independent literal', () => {
  assert.deepEqual(NV.GROUP_ORDER, EXPECTED_GROUP_ORDER);
});

test('NV.BOTTOM_BAR equals the independent literal (Home, Vocab, Check, Preview, then More)', () => {
  assert.deepEqual(NV.BOTTOM_BAR, EXPECTED_BOTTOM_BAR);
});

// M12 positive control: the sequence assertion above actually distinguishes a swap.
test('positive control: swapping two Run items breaks the sequence assertion shape', () => {
  const swapped = NV.NAV.map((n) => n.id);
  const i = swapped.indexOf('check');
  const j = swapped.indexOf('preview');
  [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
  assert.notDeepEqual(swapped, NV.NAV.map((n) => n.id));
});

test('the soon set is exactly {memory, publish, sessions, ai, storage}', () => {
  const soon = NV.NAV.filter((n) => n.soon).map((n) => n.id).sort();
  assert.deepEqual(soon, EXPECTED_SOON.slice().sort());
});

test('the readOnly set is empty (V1e-9: vault-config.md is guarded, not statically read-only)', () => {
  const readOnly = NV.NAV.filter((n) => n.readOnly).map((n) => n.id).sort();
  assert.deepEqual(readOnly, EXPECTED_READONLY.slice().sort());
});

test('NV.SOON_SENTENCE and NV.SOON_STATUS equal the fixed placeholder copy', () => {
  assert.equal(NV.SOON_SENTENCE, 'Not built yet. It is on the roadmap, so nothing here does anything today.');
  assert.equal(NV.SOON_STATUS, 'Roadmap, not built yet');
});

test('NV.ids() returns every NAV id, in NAV order', () => {
  assert.deepEqual(NV.ids(), EXPECTED_NAV.map((n) => n.id));
});

test('NV.item(id) returns the matching entry; an unknown id returns null', () => {
  assert.equal(NV.item('vocab').label, 'Vocabulary');
  assert.equal(NV.item('nope'), null);
});

// -- parseFragment: every id round-trips through hrefFor; malformed and sibling cases -----------

test('every NAV id round-trips through hrefFor() -> parseFragment()', () => {
  for (const id of NV.ids()) {
    const href = NV.hrefFor(id);
    assert.equal(href, '#/' + id);
    assert.deepEqual(NV.parseFragment(href), { screen: id, sub: null });
  }
});

test('hrefFor(id, sub) round-trips with a sub-fragment', () => {
  const href = NV.hrefFor('vocab', 'kinds');
  assert.equal(href, '#/vocab/kinds');
  assert.deepEqual(NV.parseFragment(href), { screen: 'vocab', sub: 'kinds' });
});

const MALFORMED_FRAGMENTS = ['', '#', '#/', '#/themes', '#/Theme', '#/theme/', '#//theme', '#/a/b/c', '#main', '#/theme%20', '#/vocab%2Fkinds'];

test('malformed fragments all fall back to { screen: "overview", sub: null }', () => {
  for (const hash of MALFORMED_FRAGMENTS) {
    assert.deepEqual(NV.parseFragment(hash), { screen: 'overview', sub: null }, `hash: ${JSON.stringify(hash)}`);
  }
});

test('non-string input falls back to Overview and never throws', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.deepEqual(NV.parseFragment(bad), { screen: 'overview', sub: null });
  }
});

// M2 positive control: '#/themes' is the exact string-prefix-sibling case a startsWith-based
// implementation would wrongly resolve to 'theme'.
test("positive control: '#/themes' is a real screen-id string-prefix sibling of 'theme'", () => {
  assert.ok(NV.ids().includes('theme'));
  assert.ok('themes'.startsWith('theme'));
  assert.deepEqual(NV.parseFragment('#/themes'), { screen: 'overview', sub: null });
});

// M3 positive control: '#/constructor' is the exact object-property-lookup trap.
test("positive control: '#/constructor' would resolve via a plain object's prototype chain, but not via array membership", () => {
  assert.ok(!NV.ids().includes('constructor'));
  assert.ok(Object.prototype.constructor !== undefined, 'sanity: constructor exists on Object.prototype');
  assert.deepEqual(NV.parseFragment('#/constructor'), { screen: 'overview', sub: null });
});

test('#/vocab/kinds resolves to { screen: "vocab", sub: "kinds" } (not malformed)', () => {
  assert.deepEqual(NV.parseFragment('#/vocab/kinds'), { screen: 'vocab', sub: 'kinds' });
});

// -- ST: patch wins, prev untouched, subscribers get (next, prev), unsubscribe, get() -----------

test('ST.createStore: set() has the patch win over stale fields, and get() returns the new next', () => {
  const store = ST.createStore({ a: 1, b: 2 });
  const next = store.set({ b: 3 });
  assert.deepEqual(next, { a: 1, b: 3 });
  assert.deepEqual(store.get(), { a: 1, b: 3 });
});

// M4 positive control: Object.assign({}, patch, current) would make the STALE current win.
test('positive control: patch-wins is not the same as current-wins (would fail under an argument swap)', () => {
  const patchWins = Object.assign({}, { a: 1, b: 2 }, { b: 3 });
  const currentWins = Object.assign({}, { b: 3 }, { a: 1, b: 2 });
  assert.notDeepEqual(patchWins, currentWins);
});

test('ST.createStore: prev is never mutated by set()', () => {
  const store = ST.createStore({ a: 1 });
  const prevRef = store.get();
  store.set({ a: 2 });
  assert.deepEqual(prevRef, { a: 1 });
});

test('ST.createStore: subscribers are called with (next, prev), from a snapshot of the list', () => {
  const store = ST.createStore({ a: 1 });
  const calls = [];
  store.subscribe((next, prev) => calls.push([next, prev]));
  store.set({ a: 2 });
  store.set({ a: 3 });
  assert.deepEqual(calls, [
    [{ a: 2 }, { a: 1 }],
    [{ a: 3 }, { a: 2 }],
  ]);
});

test('ST.createStore: unsubscribe stops further notifications', () => {
  const store = ST.createStore({ a: 1 });
  const calls = [];
  const unsubscribe = store.subscribe((next) => calls.push(next));
  store.set({ a: 2 });
  unsubscribe();
  store.set({ a: 3 });
  assert.deepEqual(calls, [{ a: 2 }]);
});

// M5 positive control: a store that computes next but never assigns it would fail this.
test('positive control: get() after set() must reflect the computed next, not the pre-set value', () => {
  const store = ST.createStore({ a: 1 });
  store.set({ a: 99 });
  assert.notEqual(store.get().a, 1);
  assert.equal(store.get().a, 99);
});

// -- ST.stateFromResponse: accept/reject shapes --------------------------------------------------

test('stateFromResponse accepts /api/state and /api/state?include=vocab (GET, ok, non-null body)', () => {
  const body = { session: 'x' };
  assert.deepEqual(ST.stateFromResponse('/api/state', undefined, { ok: true, status: 200, body }), body);
  assert.deepEqual(ST.stateFromResponse('/api/state', 'GET', { ok: true, status: 200, body }), body);
  assert.deepEqual(ST.stateFromResponse('/api/state?include=vocab', 'GET', { ok: true, status: 200, body }), body);
});

test('stateFromResponse rejects /api/statefoo, /api/state/x, POST, !ok and a null body', () => {
  const body = { session: 'x' };
  assert.equal(ST.stateFromResponse('/api/statefoo', 'GET', { ok: true, status: 200, body }), null);
  assert.equal(ST.stateFromResponse('/api/state/x', 'GET', { ok: true, status: 200, body }), null);
  assert.equal(ST.stateFromResponse('/api/state', 'POST', { ok: true, status: 200, body }), null);
  assert.equal(ST.stateFromResponse('/api/state', 'GET', { ok: false, status: 500, body }), null);
  assert.equal(ST.stateFromResponse('/api/state', 'GET', { ok: true, status: 200, body: null }), null);
});

// M6 positive control: a startsWith('/api/state')-only check would wrongly accept '/api/statefoo'.
test("positive control: '/api/statefoo' is a real string-prefix sibling of '/api/state'", () => {
  assert.ok('/api/statefoo'.startsWith('/api/state'));
  assert.equal(ST.stateFromResponse('/api/statefoo', 'GET', { ok: true, status: 200, body: {} }), null);
});

// -- IC: only allowlisted tags/attributes, no "<", every NAV icon exists -------------------------

test('every IC.ICONS spec uses only IC.TAGS and IC.ATTRS', () => {
  for (const [name, spec] of Object.entries(IC.ICONS)) {
    for (const [tag, attrs] of spec) {
      assert.ok(IC.TAGS.includes(tag), `${name}: tag "${tag}" not in IC.TAGS`);
      for (const attr of Object.keys(attrs)) {
        assert.ok(IC.ATTRS.includes(attr), `${name}: attr "${attr}" not in IC.ATTRS`);
      }
    }
  }
});

test('the serialised IC contains no "<"', () => {
  assert.ok(!JSON.stringify(IC).includes('<'));
});

test('every NAV item names an icon that exists in IC.ICONS, plus the More button icon', () => {
  for (const item of NV.NAV) {
    assert.ok(Object.prototype.hasOwnProperty.call(IC.ICONS, item.icon), `NAV "${item.id}" names unknown icon "${item.icon}"`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(IC.ICONS, 'more'));
});

// M14 positive control: an onload attribute is exactly what the allowlist must reject.
test('positive control: "onload" is not in IC.ATTRS (the allowlist actually excludes event handlers)', () => {
  assert.ok(!IC.ATTRS.includes('onload'));
});

// -- Issue #109: roadmap grouping, descriptions and the unknown-route state -----------------------

test('#109: every soon item is in the Coming later group, and nothing else is', () => {
  for (const n of NV.NAV) assert.equal(n.group === 'Coming later', n.soon === true, n.id);
  assert.equal(NV.ROADMAP_GROUP, 'Coming later');
  assert.equal(NV.GROUP_ORDER[NV.GROUP_ORDER.length - 1], 'Coming later');
});

test('#109: every soon item carries a one-line plain description, no dates, no em dashes', () => {
  for (const n of NV.NAV.filter((x) => x.soon)) {
    assert.equal(typeof n.lede, 'string', n.id);
    assert.ok(n.lede.length > 20 && n.lede.length < 160, n.id);
    assert.ok(!/\u2014|\u2013/.test(n.lede), n.id);
    assert.ok(!/\b(20\d\d|soon|next (week|month|release)|Q[1-4])\b/i.test(n.lede), n.id);
  }
});

test('#109: resolveRoute sends unknown #/ fragments to notfound, and keeps empty and anchor hashes on Overview', () => {
  for (const h of ['#/nonsense', '#/themes', '#/constructor', '#/Theme', '#/theme/', '#//theme', '#/a/b/c']) {
    assert.deepEqual(NV.resolveRoute(h), { screen: 'notfound', sub: null }, h);
  }
  for (const h of ['', '#', '#/', '#main', null, undefined, 42]) {
    assert.deepEqual(NV.resolveRoute(h), { screen: 'overview', sub: null }, String(h));
  }
  assert.deepEqual(NV.resolveRoute('#/vocab/kinds'), { screen: 'vocab', sub: 'kinds' });
  for (const id of NV.ids()) assert.equal(NV.resolveRoute('#/' + id).screen, id);
  assert.ok(!NV.ids().includes('notfound'));
});
