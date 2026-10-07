'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { DF } = require(path.join(__dirname, '..', 'assets', 'admin', 'diff.js'));

/*
 * V1b SD-4/interfaces (DF). Pure, loaded via require() the same way test/admin-frame.test.js
 * loads NV/ST/IC. Independent literals throughout (CLAUDE.md: never derive an assertion's
 * expected value from the code under test).
 */

// -- MAX_CELLS -----------------------------------------------------------------------------

test('MAX_CELLS is 4000000 (2000 x 2000, an independent literal)', () => {
  assert.equal(DF.MAX_CELLS, 4000000);
});

// -- splitLines ------------------------------------------------------------------------------

test('splitLines: null gives []', () => {
  assert.deepEqual(DF.splitLines(null), []);
});

test('splitLines: "" gives []', () => {
  assert.deepEqual(DF.splitLines(''), []);
});

test('splitLines: splits on \\n, no trailing newline keeps the last line', () => {
  assert.deepEqual(DF.splitLines('a\nb\nc'), ['a', 'b', 'c']);
});

test('splitLines: a single trailing newline drops exactly one trailing empty string', () => {
  assert.deepEqual(DF.splitLines('a\nb\n'), ['a', 'b']);
});

test('splitLines: CRLF is treated as one line break', () => {
  assert.deepEqual(DF.splitLines('a\r\nb\r\nc'), ['a', 'b', 'c']);
});

test('splitLines: two trailing newlines drop only one, leaving one real blank line', () => {
  assert.deepEqual(DF.splitLines('a\n\n'), ['a', '']);
});

// -- diffLines: shape, ties, empty input, null before -----------------------------------------

test('diffLines: identical text gives only "=" ops, tooLarge false', () => {
  const result = DF.diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(result.tooLarge, false);
  assert.deepEqual(result.ops, [
    { t: '=', o: 1, n: 1, s: 'a' },
    { t: '=', o: 2, n: 2, s: 'b' },
    { t: '=', o: 3, n: 3, s: 'c' },
  ]);
});

test('diffLines: null before (a file that does not exist yet) is treated as empty, every line is an addition', () => {
  const result = DF.diffLines(null, 'a\nb');
  assert.equal(result.tooLarge, false);
  assert.deepEqual(result.ops, [
    { t: '+', n: 1, s: 'a' },
    { t: '+', n: 2, s: 'b' },
  ]);
});

test('diffLines: both empty gives no ops', () => {
  const result = DF.diffLines('', '');
  assert.deepEqual(result, { tooLarge: false, ops: [] });
});

test('diffLines: a pure deletion (b empty) gives only "-" ops', () => {
  const result = DF.diffLines('a\nb', '');
  assert.deepEqual(result.ops, [
    { t: '-', o: 1, s: 'a' },
    { t: '-', o: 2, s: 'b' },
  ]);
});

test('diffLines: on a tie, deletion is emitted before insertion (shell.src.html:1001-1015 rule)', () => {
  // "a","c" vs "b","c": at the tie point (equal LCS length continuing via delete-a or insert-b),
  // deletion must win. Independent literal: the only shared line is "c", at the end.
  const result = DF.diffLines('a\nc', 'b\nc');
  assert.deepEqual(result.ops, [
    { t: '-', o: 1, s: 'a' },
    { t: '+', n: 1, s: 'b' },
    { t: '=', o: 2, n: 2, s: 'c' },
  ]);
});

test('diffLines: tooLarge at 2001x2001, ops empty', () => {
  const a = Array.from({ length: 2001 }, (_, i) => `line-a-${i}`).join('\n');
  const b = Array.from({ length: 2001 }, (_, i) => `line-b-${i}`).join('\n');
  const result = DF.diffLines(a, b);
  assert.deepEqual(result, { tooLarge: true, ops: [] });
});

test('diffLines: positive control -- 2000x2000 (exactly at MAX_CELLS) is NOT tooLarge', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `line-a-${i}`).join('\n');
  const b = Array.from({ length: 2000 }, (_, i) => `line-b-${i}`).join('\n');
  const result = DF.diffLines(a, b);
  assert.equal(result.tooLarge, false);
});

// -- counts ------------------------------------------------------------------------------------

test('counts: an independent tally of "+" and "-" ops', () => {
  const ops = [
    { t: '=', o: 1, n: 1, s: 'x' },
    { t: '-', o: 2, s: 'y' },
    { t: '-', o: 3, s: 'z' },
    { t: '+', n: 2, s: 'w' },
  ];
  assert.deepEqual(DF.counts(ops), { added: 1, removed: 2 });
});

test('counts: no changes gives {added:0, removed:0}', () => {
  assert.deepEqual(DF.counts([{ t: '=', o: 1, n: 1, s: 'x' }]), { added: 0, removed: 0 });
});

test('counts: empty ops gives {added:0, removed:0}', () => {
  assert.deepEqual(DF.counts([]), { added: 0, removed: 0 });
});

// -- hunks -------------------------------------------------------------------------------------

test('hunks: a single change surrounded by unchanged lines within context keeps them, no gap', () => {
  const ops = [
    { t: '=', o: 1, n: 1, s: 'a' },
    { t: '-', o: 2, s: 'b' },
    { t: '+', n: 2, s: 'B' },
    { t: '=', o: 3, n: 3, s: 'c' },
  ];
  const result = DF.hunks(ops, 1);
  assert.deepEqual(result, [
    { t: '=', o: 1, n: 1, s: 'a' },
    { t: '-', o: 2, s: 'b' },
    { t: '+', n: 2, s: 'B' },
    { t: '=', o: 3, n: 3, s: 'c' },
  ]);
});

test('hunks: unchanged runs longer than context collapse to a {gap:N} row', () => {
  const ops = [
    { t: '=', o: 1, n: 1, s: 'a' },
    { t: '=', o: 2, n: 2, s: 'b' },
    { t: '=', o: 3, n: 3, s: 'c' },
    { t: '=', o: 4, n: 4, s: 'd' },
    { t: '=', o: 5, n: 5, s: 'e' },
    { t: '=', o: 6, n: 6, s: 'f' },
    { t: '=', o: 7, n: 7, s: 'g' },
    { t: '-', o: 8, s: 'h' },
    { t: '=', o: 9, n: 8, s: 'i' },
  ];
  const result = DF.hunks(ops, 1);
  // Rows 1..6 are more than 1 line away from the change at index 7 (0-based) -- context 1 keeps
  // only row 7 ("g") before the change and row 9 ("i") after. Rows 1..6 collapse to one gap row.
  assert.deepEqual(result, [
    { gap: 6 },
    { t: '=', o: 7, n: 7, s: 'g' },
    { t: '-', o: 8, s: 'h' },
    { t: '=', o: 9, n: 8, s: 'i' },
  ]);
});

test('hunks: no changes at all gives one gap row for the whole thing', () => {
  const ops = [
    { t: '=', o: 1, n: 1, s: 'a' },
    { t: '=', o: 2, n: 2, s: 'b' },
    { t: '=', o: 3, n: 3, s: 'c' },
  ];
  const result = DF.hunks(ops, 1);
  assert.deepEqual(result, [{ gap: 3 }]);
});

test('hunks: empty ops gives []', () => {
  assert.deepEqual(DF.hunks([], 3), []);
});
