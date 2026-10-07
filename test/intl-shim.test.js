'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { segmenterDataMissing, graphemeSegments, installSegmenterShim } = require('../src/generator/intl-shim');

function nativeGraphemes(str) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(str), (g) => g.segment);
}

// -- corpus: graphemeSegments() vs native Intl.Segmenter, plain node --

const CORPUS = [
  ['ASCII', 'Hello, World! 123'],
  ['precomposed Latin', 'José María Álvarez'],
  ['decomposed Latin (NFD)', 'José María Álvarez'.normalize('NFD')],
  ['stacked combining marks', `e${'́'}${'̈'}${'̣'}`],
  ['CRLF, LF, CR mixed', 'line1\r\nline2\nline3\rline4'],
  [
    'emoji ZWJ family, embedded in text',
    `Meet ${String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466)} today`,
  ],
  [
    'skin-tone modifiers',
    `${String.fromCodePoint(0x1f44d, 0x1f3fd)} and ${String.fromCodePoint(0x1f44d, 0x1f3ff)} thumbs`,
  ],
  [
    'skin-tone + ZWJ combo (woman health worker)',
    `${String.fromCodePoint(0x1f469, 0x1f3fd, 0x200d, 0x2695, 0xfe0f)} doctor`,
  ],
  ['regional indicator pair (a flag)', `${String.fromCodePoint(0x1f1e6, 0x1f1fa)} flag`],
  [
    'regional indicators, odd run of 5 (greedy left-to-right pairing)',
    String.fromCodePoint(0x1f1e6, 0x1f1fa, 0x1f1ec, 0x1f1e7, 0x1f1eb, 0x1f1f7, 0x1f1e9, 0x1f1ea, 0x1f1ee, 0x1f1f9),
  ],
  ['RI run interrupted by a non-RI char resets the pairing', `${String.fromCodePoint(0x1f1e6, 0x1f1fa)}x${String.fromCodePoint(0x1f1e6, 0x1f1fa)}`],
  ['Hangul jamo L+V+T (decomposed)', String.fromCodePoint(0x1100, 0x1161, 0x11a8)],
  ['Hangul jamo L+V (decomposed)', String.fromCodePoint(0x1100, 0x1161)],
  ['Hangul precomposed LV + trailing jamo T', String.fromCodePoint(0xac00, 0x11a8)],
  ['Hangul precomposed LVT syllable', String.fromCodePoint(0xac01)],
  ['Hangul sentence, mixed with Latin', '김 각성자 Kim'],
];

for (const [name, str] of CORPUS) {
  test(`graphemeSegments corpus: ${name}`, () => {
    assert.deepEqual(graphemeSegments(str), nativeGraphemes(str));
  });
}

test('graphemeSegments returns [] for an empty string', () => {
  assert.deepEqual(graphemeSegments(''), []);
});

// -- installSegmenterShim() behaviour --

test('installSegmenterShim({force:true}) matches native output for an instance constructed BEFORE install', () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const before = Array.from(segmenter.segment('café'), (g) => g.segment);

  const restore = installSegmenterShim({ force: true });
  try {
    const after = Array.from(segmenter.segment('café'), (g) => g.segment);
    assert.deepEqual(after, before);
  } finally {
    restore();
  }
});

test('installSegmenterShim({force:true}) returns {segment, index, input} items usable with Array.from + a map fn', () => {
  const restore = installSegmenterShim({ force: true });
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const items = Array.from(segmenter.segment('ab'));
    assert.deepEqual(items, [
      { segment: 'a', index: 0, input: 'ab' },
      { segment: 'b', index: 1, input: 'ab' },
    ]);
  } finally {
    restore();
  }
});

test('installSegmenterShim({force:true}) throws for a non-grapheme granularity', () => {
  const restore = installSegmenterShim({ force: true });
  try {
    assert.throws(
      () => new Intl.Segmenter(undefined, { granularity: 'word' }).segment('hello world'),
      RangeError,
    );
    assert.throws(
      () => new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment('Hello. World.'),
      RangeError,
    );
  } finally {
    restore();
  }
});

test('restore() puts native segmentation back, including for non-grapheme granularities', () => {
  const wordsBefore = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'word' }).segment('hello world'),
    (g) => g.segment,
  );

  const restore = installSegmenterShim({ force: true });
  restore();

  const wordsAfter = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'word' }).segment('hello world'),
    (g) => g.segment,
  );
  assert.deepEqual(wordsAfter, wordsBefore);

  const graphemesAfter = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment('café'),
    (g) => g.segment,
  );
  assert.deepEqual(graphemesAfter, nativeGraphemes('café'));
});

test('installSegmenterShim() without force does not install on this (full-icu) box', () => {
  const original = Intl.Segmenter.prototype.segment;
  const restore = installSegmenterShim();
  try {
    assert.equal(Intl.Segmenter.prototype.segment, original);
  } finally {
    restore();
  }
});

// -- segmenterDataMissing() gate --

test('segmenterDataMissing() is false when icu_small is not true, regardless of env shape', () => {
  assert.equal(segmenterDataMissing({ config: { variables: { icu_small: false } } }), false);
  assert.equal(segmenterDataMissing({ config: { variables: {} } }), false);
  assert.equal(segmenterDataMissing({}), false);
});

test('segmenterDataMissing() defaults env to process, and is false on this full-icu box', () => {
  assert.equal(segmenterDataMissing(), false);
});

test('segmenterDataMissing() is true only for icu_small:true AND missing de/ja locale data', () => {
  // This box's own ICU is full (de/ja resolve for real), so segmenterDataMissing() can only
  // report true here by exercising the de/ja probe itself, which reads the global
  // Intl.DateTimeFormat the same way pkg's own gate does
  // (node_modules/@yao-pkg/pkg/prelude/bootstrap-shared.js:399-415). Temporarily replacing it
  // is the only way to simulate "no break-iterator data" data-less small-icu on a full-icu
  // dev box; restored in `finally` either way.
  const OriginalDateTimeFormat = Intl.DateTimeFormat;

  function FakeSmallIcuDateTimeFormat(locale, ...rest) {
    // Data-less small-icu resolves every locale to the default ('en'), per the module header.
    return new OriginalDateTimeFormat('en', ...rest);
  }
  FakeSmallIcuDateTimeFormat.prototype = OriginalDateTimeFormat.prototype;

  Intl.DateTimeFormat = FakeSmallIcuDateTimeFormat;
  try {
    // icu_small:true, but de/ja both resolve to 'en' under the fake -> gate true.
    assert.equal(segmenterDataMissing({ config: { variables: { icu_small: true } } }), true);
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }

  // Restored: real ICU, real de/ja resolution -> gate false again even with icu_small:true.
  assert.equal(segmenterDataMissing({ config: { variables: { icu_small: true } } }), false);
});
