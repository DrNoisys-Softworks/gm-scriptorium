'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VB } = require(path.join(__dirname, '..', 'assets', 'admin', 'vocab.js'));
const { IM, SLOT_NAMES } = require(path.join(__dirname, '..', 'assets', 'admin', 'images.js'));

/*
 * V1b SD-10/SD-12 (D-10 option (c)). Pure, loaded via require(). Independent literals
 * throughout (CLAUDE.md: never derive an assertion's expected value from the code under test).
 */

// === VB helpers =================================================================================

test('VB.LABEL_GROUPS flattens to 17 names in 3 groups', () => {
  const flat = VB.LABEL_GROUPS.flatMap((g) => g[1]);
  assert.equal(flat.length, 17);
  assert.deepEqual(VB.LABEL_GROUPS.map((g) => g[0]), ['Story timeline', 'Recaps', 'Connections']);
});

test('VB.COLUMN_KEYS is the 11-key literal', () => {
  assert.deepEqual(VB.COLUMN_KEYS, ['title', 'kind', 'weight', 'place', 'in_game', 'when', 'real_world', 'what', 'session', 'learned', 'after']);
});

test('VB.fieldDelta: unchanged -> undefined, cleared -> null, otherwise the string', () => {
  assert.equal(VB.fieldDelta('same', 'same'), undefined);
  assert.equal(VB.fieldDelta('', 'was'), null);
  assert.equal(VB.fieldDelta('now', 'was'), 'now');
});

test('VB.commaListDelta: unchanged -> undefined, cleared -> null, otherwise a trimmed non-empty array', () => {
  assert.equal(VB.commaListDelta('a, b', 'a, b'), undefined);
  assert.equal(VB.commaListDelta('  ', 'a'), null);
  assert.deepEqual(VB.commaListDelta(' a , b ,, c ', 'x'), ['a', 'b', 'c']);
});

test('VB.weightsDelta: untouched -> undefined, all cleared -> null, otherwise the array', () => {
  assert.equal(VB.weightsDelta(['1', '2', '3'], ['1', '2', '3']), undefined);
  assert.equal(VB.weightsDelta(['', '', ''], ['1', '2', '3']), null);
  assert.deepEqual(VB.weightsDelta(['1', '9', '3'], ['1', '2', '3']), ['1', '9', '3']);
});

test('VB.fieldState: touched -> "unsaved"; untouched with an on-disk value -> "yours"; untouched, no on-disk value -> "default"', () => {
  assert.equal(VB.fieldState('now', 'was', true), 'unsaved');
  assert.equal(VB.fieldState('was', 'was', true), 'yours');
  assert.equal(VB.fieldState('was', 'was', false), 'default');
});

test('VB.tabCounts: labels/matching/recaps are fixed; kinds is the on-disk count when present', () => {
  const vocab = { exists: true, tables: { timeline: { kinds: [{ key: 'a' }, { key: 'b' }] } }, error: null, defaults: { timeline: { kinds: [1, 2, 3] } } };
  assert.deepEqual(VB.tabCounts(vocab), { labels: 17, kinds: 2, matching: 16, recaps: 1 });
});

test('VB.tabCounts: kinds falls back to the default count when there are no on-disk kinds', () => {
  const vocab = { exists: false, tables: null, error: null, defaults: { timeline: { kinds: [1, 2, 3] } } };
  assert.deepEqual(VB.tabCounts(vocab), { labels: 17, kinds: 3, matching: 16, recaps: 1 });
});

test('VB.countChanges: counts labels/recaps own-keys plus one each for weights/session_token/segment_units/kinds, plus one per changed column', () => {
  assert.equal(VB.countChanges({ labels: { chapter: 'x', recap: 'y' } }), 2);
  assert.equal(VB.countChanges({ recaps: { learned_heading: 'z' } }), 1);
  assert.equal(
    VB.countChanges({ timeline: { weights: ['1', '2', '3'], session_token: 'x', segment_units: 'y', columns: { title: ['a'], kind: ['b'] }, kinds: null } }),
    6,
  );
  assert.equal(VB.countChanges({}), 0);
});

// === IM: SLOT_GUIDE literal (D-10 option (c)) ===================================================

const EXPECTED_SLOT_GUIDE = [
  { slot: 'hero', w: 2400, h: 1350, ratio: '16:9', behaviour: 'Cover; keep the subject in the middle band.' },
  { slot: 'ground', w: 2560, h: 1440, ratio: '16:9', behaviour: 'Fixed page background, cover.' },
  { slot: 'paper', w: 1024, h: 1024, ratio: '1:1', behaviour: 'Seamless tile.', tile: true },
  { slot: 'crest-frame', w: 512, h: 512, ratio: '1:1', behaviour: 'Transparent PNG or WebP.', alpha: true },
  { slot: 'portrait', w: 900, h: 1200, ratio: '3:4', behaviour: 'Cover.' },
  { slot: '404', w: 1600, h: 900, ratio: '16:9', behaviour: 'Cover.' },
];

test('IM.SLOT_GUIDE deep-equals the independent six-row literal, in SLOT_NAMES order, no source key', () => {
  assert.deepEqual(IM.SLOT_GUIDE, EXPECTED_SLOT_GUIDE);
  assert.deepEqual(IM.SLOT_GUIDE.map((g) => g.slot), SLOT_NAMES);
  IM.SLOT_GUIDE.forEach((g) => assert.ok(!('source' in g), `${g.slot} must not carry a source key`));
});

test('IM.SLOT_GUIDE ratios check out by the test\'s own arithmetic', () => {
  assert.equal(2400 / 1350, 16 / 9);
  assert.equal(2560 / 1440, 16 / 9);
  assert.equal(1024 / 1024, 1 / 1);
  assert.equal(512 / 512, 1 / 1);
  assert.equal(900 / 1200, 3 / 4);
  assert.equal(1600 / 900, 16 / 9);
});

test('IM.WARN is {minScale: 0.75, aspect: 1.25}', () => {
  assert.deepEqual(IM.WARN, { minScale: 0.75, aspect: 1.25 });
});

test('IM shared strings match the approved wording exactly', () => {
  assert.equal(IM.GUIDE_LABEL, 'Recommended convention');
  assert.equal(IM.GUIDE_NOTE, 'This is the size to prepare art at, whether a built-in theme or your own overrides.css draws the slot.');
  assert.equal(
    IM.HERO_CROP_NOTE,
    'If your overrides.css uses it as the landing banner, plain shows about a 3.2:1 band of it and haze about 1.7:1 on a wide screen.',
  );
});

// === IM.slotImageRel ============================================================================

test('slotImageRel: images/a.png, listed, gives a.png', () => {
  assert.equal(IM.slotImageRel('images/a.png', ['a.png']), 'a.png');
});

test('slotImageRel: images/sub/b.webp, listed, gives sub/b.webp', () => {
  assert.equal(IM.slotImageRel('images/sub/b.webp', ['sub/b.webp']), 'sub/b.webp');
});

test('slotImageRel: imagesx/a.png (string-prefix sibling) gives null', () => {
  assert.equal(IM.slotImageRel('imagesx/a.png', ['a.png']), null);
});

test('slotImageRel: imagesx/a.png gives null even when the naive post-prefix slice would coincidentally land on a real listed name', () => {
  // A prefix check relaxed to startsWith('images') (M11) would let 'imagesx/a.png' through,
  // then slice at 'images/'.length (7) lands one character early -- "/a.png" -- which this
  // deliberately crafted images list contains. The exact-prefix check must refuse the whole
  // value before slicing is ever considered, so this must stay null regardless.
  assert.equal(IM.slotImageRel('imagesx/a.png', ['/a.png']), null);
});

test('slotImageRel: ancestor-direction shapes (images/../pack.toml, images/.., images/, images) all give null', () => {
  const images = ['a.png'];
  assert.equal(IM.slotImageRel('images/../pack.toml', images), null);
  assert.equal(IM.slotImageRel('images/..', images), null);
  assert.equal(IM.slotImageRel('images/', images), null);
  assert.equal(IM.slotImageRel('images', images), null);
});

test('slotImageRel: vault:images/a.png, ./images/a.png and IMAGES/a.png all give null', () => {
  const images = ['a.png'];
  assert.equal(IM.slotImageRel('vault:images/a.png', images), null);
  assert.equal(IM.slotImageRel('./images/a.png', images), null);
  assert.equal(IM.slotImageRel('IMAGES/a.png', images), null);
});

test('slotImageRel: images/c.png, not listed, gives null; positive control: images/c.png IS listed gives c.png', () => {
  assert.equal(IM.slotImageRel('images/c.png', ['a.png']), null);
  assert.equal(IM.slotImageRel('images/c.png', ['a.png', 'c.png']), 'c.png');
});

// === IM.guideFor =================================================================================

test('guideFor: exact-equality lookup by slot name', () => {
  assert.deepEqual(IM.guideFor('hero'), EXPECTED_SLOT_GUIDE[0]);
  assert.deepEqual(IM.guideFor('crest-frame'), EXPECTED_SLOT_GUIDE[3]);
});

test('guideFor: an unknown slot gives null (no string-prefix sibling match either)', () => {
  assert.equal(IM.guideFor('heroic'), null);
  assert.equal(IM.guideFor('nope'), null);
});

// === IM.sizeAdvice ================================================================================

test('sizeAdvice: the exact recommended size gives only the info line', () => {
  const advice = IM.sizeAdvice(IM.guideFor('hero'), { w: 2400, h: 1350 }, 'hero.png');
  assert.deepEqual(advice, [{ level: 'info', text: 'Measured 2400 × 1350 px; recommended convention 2400 × 1350 px (16:9).' }]);
});

test('sizeAdvice: size floor (hero) -- 1800x1013 no size warn, 1799x1013 warns', () => {
  const guide = IM.guideFor('hero');
  const ok = IM.sizeAdvice(guide, { w: 1800, h: 1013 }, 'hero.png');
  assert.ok(!ok.some((a) => a.text.indexOf('Smaller than') === 0));
  const warns = IM.sizeAdvice(guide, { w: 1799, h: 1013 }, 'hero.png');
  assert.ok(warns.some((a) => a.level === 'warn' && a.text.indexOf('Smaller than the recommended size') === 0));
});

test('sizeAdvice: shape 16:9 -- 2:1 ok, 4:3 warns, 21:9 warns', () => {
  const guide = IM.guideFor('hero'); // 2400x1350, 16:9
  const shapeWarn = (dims) => IM.sizeAdvice(guide, dims, 'x.png').some((a) => a.level === 'warn' && a.text.indexOf('Its shape') === 0);
  assert.equal(shapeWarn({ w: 2400, h: 1200 }), false); // 2:1
  assert.equal(shapeWarn({ w: 2400, h: 1800 }), true); // 4:3
  assert.equal(shapeWarn({ w: 2400, h: 1029 }), true); // ~21:9 relative to width 2400 (2400/1029 ~= 2.333)
});

test('sizeAdvice: shape portrait (3:4) -- 2:3 ok, 1:1 warns, 1200x900 warns (width/height swap)', () => {
  const guide = IM.guideFor('portrait'); // 900x1200, 3:4
  const shapeWarn = (dims) => IM.sizeAdvice(guide, dims, 'x.png').some((a) => a.level === 'warn' && a.text.indexOf('Its shape') === 0);
  assert.equal(shapeWarn({ w: 900, h: 1350 }), false); // 2:3
  assert.equal(shapeWarn({ w: 1200, h: 1200 }), true); // 1:1
  assert.equal(shapeWarn({ w: 1200, h: 900 }), true); // the swap case (M18)
});

test('sizeAdvice: shape square -- 5:4 ok (inclusive boundary), 4:3 warns', () => {
  const guide = IM.guideFor('paper'); // 1024x1024, 1:1
  const shapeWarn = (dims) => IM.sizeAdvice(guide, dims, 'x.png').some((a) => a.level === 'warn' && a.text.indexOf('Its shape') === 0);
  assert.equal(shapeWarn({ w: 1250, h: 1000 }), false); // 5:4 exactly
  assert.equal(shapeWarn({ w: 1200, h: 900 }), true); // 4:3
});

test('sizeAdvice: tile text -- paper uses the tile wording for its too-small warning', () => {
  const guide = IM.guideFor('paper');
  const advice = IM.sizeAdvice(guide, { w: 700, h: 700 }, 'x.png');
  assert.ok(advice.some((a) => a.level === 'warn' && a.text === 'Smaller than the recommended tile; the pattern repeats more often.'));
});

test('sizeAdvice: transparency -- crest-frame with a jpg/JPEG warns, png/webp/png.webp does not', () => {
  const guide = IM.guideFor('crest-frame');
  const dims = { w: 512, h: 512 };
  const warns = (name) => IM.sizeAdvice(guide, dims, name).some((a) => a.text.indexOf('JPEG has no transparency') === 0);
  assert.equal(warns('crest.jpg'), true);
  assert.equal(warns('crest.JPEG'), true);
  assert.equal(warns('crest.png'), false);
  assert.equal(warns('crest.webp'), false);
  assert.equal(warns('crest.png.webp'), false);
});

test('sizeAdvice: transparency -- the extension is the suffix, not a substring (crest.jpg.png / crest.png.jpg)', () => {
  const guide = IM.guideFor('crest-frame');
  const dims = { w: 512, h: 512 };
  const warns = (name) => IM.sizeAdvice(guide, dims, name).some((a) => a.text.indexOf('JPEG has no transparency') === 0);
  assert.equal(warns('crest.jpg.png'), false);
  assert.equal(warns('crest.png.jpg'), true);
});

test('sizeAdvice: transparency -- hero (no alpha) with .jpg never warns', () => {
  const guide = IM.guideFor('hero');
  const advice = IM.sizeAdvice(guide, { w: 2400, h: 1350 }, 'hero.jpg');
  assert.ok(!advice.some((a) => a.text.indexOf('JPEG has no transparency') === 0));
});

test('sizeAdvice: no dims (SVG, vault:, a failed measurement) gives exactly the one info line, never throws', () => {
  assert.deepEqual(IM.sizeAdvice(IM.guideFor('hero'), null, 'x.svg'), [{ level: 'info', text: 'Size not checked.' }]);
  assert.deepEqual(IM.sizeAdvice(IM.guideFor('hero'), undefined, 'vault:x'), [{ level: 'info', text: 'Size not checked.' }]);
});

// === Docs consistency ============================================================================

test('docs/image-slots.md carries every slot\'s W x H, ratio and behaviour, the shared strings, and both thresholds', () => {
  const docsPath = path.join(__dirname, '..', 'docs', 'image-slots.md');
  const docs = fs.readFileSync(docsPath, 'utf8');
  EXPECTED_SLOT_GUIDE.forEach((g) => {
    assert.ok(docs.includes(String(g.w)), `${g.slot}: width ${g.w} missing from docs/image-slots.md`);
    assert.ok(docs.includes(String(g.h)), `${g.slot}: height ${g.h} missing from docs/image-slots.md`);
    assert.ok(docs.includes(g.ratio), `${g.slot}: ratio ${g.ratio} missing from docs/image-slots.md`);
    assert.ok(docs.includes(g.behaviour), `${g.slot}: behaviour "${g.behaviour}" missing from docs/image-slots.md`);
  });
  assert.ok(docs.includes(IM.GUIDE_LABEL));
  assert.ok(docs.includes(IM.GUIDE_NOTE));
  assert.ok(docs.includes(IM.HERO_CROP_NOTE));
  assert.ok(docs.includes('0.75') || docs.includes('three-quarters'));
  assert.ok(docs.includes('25%'));
});

// === No new tokens ===============================================================================
// V1b introduces no new tokens.css entries: the a1 Backstage sheet already carries --slip-*,
// --specimen-*, --pending/--ok/--error and --wash-note/--line-note, which cover every V1b visual
// need (slip effects, the theme specimen, the nav pending dot, slot-advice info/warn rows).
// test/admin-style.test.js's existing from-scratch WCAG check already covers the full token
// sheet, so there is nothing new to add a contrast test for here.
