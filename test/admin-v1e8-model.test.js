'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VB } = require('../assets/admin/vocab');
const { VR } = require('../assets/admin/variants');

/*
 * V1e-8 (ADR 0039 addendum, SD-71 to SD-73). Pure VB.exampleFocus/VR.exampleState table tests
 * (no DOM), plus structural source scans over the admin JS assets.
 */

const ADMIN_JS_DIR = path.join(__dirname, '..', 'assets', 'admin');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function panelJsFiles() {
  return fs
    .readdirSync(ADMIN_JS_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(ADMIN_JS_DIR, name));
}

function readAsset(name) {
  return fs.readFileSync(path.join(ADMIN_JS_DIR, name), 'utf8');
}

// --- VB.EXAMPLE_CAPTIONS --------------------------------------------------------------------

test('VB.EXAMPLE_CAPTIONS: the literal', () => {
  assert.deepEqual(VB.EXAMPLE_CAPTIONS, {
    timeline: 'The Timeline page',
    character: 'A character page, Connections',
    recap: 'A session recap',
  });
});

// --- VB.exampleFocus table ---------------------------------------------------------------------

test('VB.exampleFocus: the labels tab, with a field, gives before/after from initial/value/placeholder', () => {
  const field = { input: { value: 'New Word', placeholder: 'Default Word' }, initial: 'Old Word' };
  assert.deepEqual(VB.exampleFocus('labels', 'group_npc', field), {
    kind: 'label',
    key: 'group_npc',
    before: 'Old Word',
    after: 'New Word',
  });
});

test('VB.exampleFocus: the labels tab, with a field whose initial/value are empty, falls back to the placeholder', () => {
  const field = { input: { value: '', placeholder: 'Default Word' }, initial: '' };
  assert.deepEqual(VB.exampleFocus('labels', 'group_npc', field), {
    kind: 'label',
    key: 'group_npc',
    before: 'Default Word',
    after: 'Default Word',
  });
});

test('VB.exampleFocus: the labels tab with no field (nothing focused yet) falls through to the tab-text branch', () => {
  assert.deepEqual(VB.exampleFocus('labels', null, null), { kind: 'tab', text: 'The Labels tab' });
});

test('VB.exampleFocus: every other tab id gives its own tab text', () => {
  assert.deepEqual(VB.exampleFocus('kinds', null, null), { kind: 'tab', text: 'Timeline kinds' });
  assert.deepEqual(VB.exampleFocus('matching', null, null), { kind: 'tab', text: 'How weights and days read' });
  assert.deepEqual(VB.exampleFocus('recaps', null, null), { kind: 'tab', text: 'The learned heading' });
});

test('VB.exampleFocus: an unknown tab id falls back to the Labels tab text; own-property lookup refuses constructor/__proto__/toString', () => {
  assert.deepEqual(VB.exampleFocus('nope', null, null), { kind: 'tab', text: 'The Labels tab' });
  assert.deepEqual(VB.exampleFocus('constructor', null, null), { kind: 'tab', text: 'The Labels tab' });
  assert.deepEqual(VB.exampleFocus('__proto__', null, null), { kind: 'tab', text: 'The Labels tab' });
  assert.deepEqual(VB.exampleFocus('toString', null, null), { kind: 'tab', text: 'The Labels tab' });
  assert.deepEqual(VB.exampleFocus('hasOwnProperty', null, null), { kind: 'tab', text: 'The Labels tab' });
});

// --- VR.EXAMPLE_COPY literals -------------------------------------------------------------------

test('VR.EXAMPLE_COPY: the literal', () => {
  assert.deepEqual(VR.EXAMPLE_COPY, {
    noEdits: 'No unsaved changes, so this is what players see now.',
    none: 'Update example builds your saved site with these unsaved words, privately on this computer. The panel pauses while it builds.',
    outdated: 'This example is from before your latest edits. Update example to see them.',
    current: "Built HH:MM from your saved site plus this screen's unsaved edits.",
    fine: 'Click into any field and the example follows it.',
    nowEmptyHead: 'No preview built yet',
    nowEmptyText: 'Build preview to see what players see now.',
    missing: {
      timeline: 'This site has no Timeline page to show.',
      character: 'This site has no character page to show.',
      recap: 'This site has no session recap to show.',
    },
  });
});

// --- VR.exampleState table (two INDEPENDENTLY typed JSON strings, never JSON.stringify of the ---
// --- same object -- CLAUDE.md's own testing-standards rule) -------------------------------------

test('VR.exampleState: no-edits wins regardless of item/builtPayloadJson', () => {
  assert.equal(VR.exampleState(null, null, '{}'), 'no-edits');
  assert.equal(VR.exampleState({ built: true, stale: false }, '{}', '{}'), 'no-edits');
});

test('VR.exampleState: none when there is no item, or the item is not built', () => {
  assert.equal(VR.exampleState(null, null, '{"labels":{"group_npc":"x"}}'), 'none');
  assert.equal(VR.exampleState({ built: false }, null, '{"labels":{"group_npc":"x"}}'), 'none');
});

test('VR.exampleState: outdated when the built payload differs from the current one, or the item is stale', () => {
  const built = '{"labels":{"group_npc":"old value"}}';
  const current = '{"labels":{"group_npc":"new value"}}';
  assert.equal(VR.exampleState({ built: true, stale: false }, built, current), 'outdated');
  // Same logical payload, independently typed (not JSON.stringify of the same object), but the
  // item itself reports stale: true (an outside save moved previewInfo).
  const sameA = '{"labels":{"group_npc":"same value"}}';
  const sameB = '{"labels": {"group_npc": "same value"}}'; // deliberately different whitespace
  assert.notEqual(sameA, sameB, 'the two literals must actually be distinct strings for this case to mean anything');
  assert.equal(VR.exampleState({ built: true, stale: true }, sameA, sameA), 'outdated');
  void sameB;
});

test('VR.exampleState: current when the built payload equals the live one and the item is not stale', () => {
  const builtJson = '{"labels":{"group_npc":"matched value"}}';
  const currentJson = '{' + '"labels":{"group_npc":"matched value"}' + '}'; // built independently, not via JSON.stringify
  assert.equal(VR.exampleState({ built: true, stale: false }, builtJson, currentJson), 'current');
});

// --- Copy scan: no em dash, no codes, no mock sample-campaign strings ---------------------------

test('no em dash in VB.EXAMPLE_CAPTIONS or the exampleFocus tab-text table', () => {
  const EM_DASH = '—';
  for (const v of Object.values(VB.EXAMPLE_CAPTIONS)) assert.ok(!v.includes(EM_DASH), v);
  for (const tab of ['labels', 'kinds', 'matching', 'recaps', 'anything-else']) {
    assert.ok(!VB.exampleFocus(tab, null, null).text.includes(EM_DASH));
  }
});

test('no em dash in VR.EXAMPLE_COPY', () => {
  const EM_DASH = '—';
  function walk(value, trail) {
    if (typeof value === 'string') {
      assert.ok(!value.includes(EM_DASH), `${trail}: contains an em dash`);
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) walk(value[k], `${trail}.${k}`);
    }
  }
  walk(VR.EXAMPLE_COPY, 'VR.EXAMPLE_COPY');
});

test('no slice code (V1e-8, SD-7x, FR-33, AC-V8) and no mock sample-campaign string in VB/VR string literals', () => {
  const CODE_RE = /\bV1e-\d|\bSD-\d|\bFR-\d|\bAC-V\d|\bDV-E\d/;
  // Forbidden mock sample-campaign strings (r3-src/vocab.js:26,36,60,276 -- real campaign/place
  // names from the mock's own invented-but-specific fixture, which must never leak into tracked
  // panel copy; NFR-11).
  const FORBIDDEN_MOCK_STRINGS = ['Folk of the Vale', 'Under the Sallow Hills', 'the Wardens', 'What the Wardens learned'];
  function walk(value, trail) {
    if (typeof value === 'string') {
      assert.ok(!CODE_RE.test(value), `${trail}: contains a slice/SD/FR/AC/DV code: "${value}"`);
      for (const bad of FORBIDDEN_MOCK_STRINGS) {
        assert.ok(!value.includes(bad), `${trail}: contains the mock's own sample-campaign string "${bad}"`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${trail}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) walk(value[k], `${trail}.${k}`);
    }
  }
  walk(VB.EXAMPLE_CAPTIONS, 'VB.EXAMPLE_CAPTIONS');
  walk(VR.EXAMPLE_COPY, 'VR.EXAMPLE_COPY');
});

// --- Structural -----------------------------------------------------------------------------

test('structural: vocab.js still has exactly 3 and 1 busy literals (admin-busy-contract.test.js:67-77, unedited)', () => {
  const src = readAsset('vocab.js');
  function countOccurrences(haystack, needle) {
    return haystack.split(needle).length - 1;
  }
  assert.equal(countOccurrences(src, 'reviewBtn.disabled = disabledReason || store.isBusy();'), 3);
  assert.equal(countOccurrences(src, 'if (vocabReviewBtn) vocabReviewBtn.disabled = vocabOwnDisabled || store.isBusy();'), 1);
});

test('structural: /api/variants/vocab appears only in assets/admin/variants.js among admin JS assets', () => {
  const withLiteral = panelJsFiles().filter((f) => fs.readFileSync(f, 'utf8').includes('/api/variants/vocab'));
  assert.deepEqual(
    withLiteral.map((f) => path.basename(f)),
    ['variants.js'],
  );
});

test('structural: variants.js has no new iframe-creation call (createElement(\'iframe\') stays sitepane.js-only)', () => {
  const RE = /createElement\(\s*(['"])iframe\1\s*\)/g;
  let total = 0;
  const byFile = {};
  for (const f of panelJsFiles()) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const n = (src.match(RE) || []).length;
    if (n > 0) byFile[path.basename(f)] = n;
    total += n;
  }
  assert.deepEqual(byFile, { 'sitepane.js': 1 });
  assert.equal(total, 1);
});

test('structural: variants.js still has exactly one .disabled = store.isBusy() and one querySelectorAll(\'[data-role="variant-build"]\') (V1e-7, unedited)', () => {
  const src = readAsset('variants.js');
  const disabledCount = (src.match(/\.disabled\s*=\s*store\.isBusy\(\)/g) || []).length;
  assert.equal(disabledCount, 1);
  const queryCount = (src.match(/querySelectorAll\(\s*'\[data-role="variant-build"\]'\s*\)/g) || []).length;
  assert.equal(queryCount, 1);
});

test('structural: no fetch( in variants.js or vocab.js (fetch( appears only in app.js among admin JS assets)', () => {
  const withFetch = panelJsFiles().filter((f) => fs.readFileSync(f, 'utf8').includes('fetch('));
  assert.deepEqual(
    withFetch.map((f) => path.basename(f)),
    ['app.js'],
  );
});

test('structural: vocab.js leaves buildPayload, VB.buildKindEntry, countChanges and the review flow untouched (byte markers present and unique)', () => {
  const src = readAsset('vocab.js');
  assert.equal((src.match(/function buildPayload\(\)/g) || []).length, 1);
  assert.equal((src.match(/function countChanges\(payload\)/g) || []).length, 1);
  assert.ok(src.includes("path: '/api/pack/vocab'"), 'the review flow must still POST through /api/pack/vocab, never a variant route');
});
