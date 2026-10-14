'use strict';

/*
 * The documentation criteria, checked. The table in docs/WRITING-DOCS.md lists every page written
 * for GMs; the index in docs/README.md files each one under a section. These tests keep the two
 * in step and check each listed page opens by saying who it is for.
 *
 * Two real-repo tests pass today and prove nothing on their own: the opening-line check and the
 * Steps-cell check. The planted-defect controls below are what show the checks can fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SECTIONS, indexSections, criteriaRows, firstParagraph } = require('./helpers/doc-criteria');

const ROOT = path.join(__dirname, '..');
const OPENING = /\bThis (page|guide) is for\b/;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Disagreements between an index and a criteria table, as readable strings. */
function agreementProblems(indexText, writingText) {
  const problems = [];
  const bySection = indexSections(indexText);
  const rows = criteriaRows(writingText);
  const rowByFile = new Map(rows.map((r) => [r.file, r]));
  const indexed = new Set();
  for (const [section, files] of bySection) {
    for (const f of files) {
      indexed.add(f);
      const row = rowByFile.get(f);
      if (!row) problems.push(`${f} is in the index under ${section} but not in the table`);
      else if (row.section !== section) problems.push(`${f} is under ${section} in the index but ${row.section} in the table`);
    }
  }
  for (const r of rows) if (!indexed.has(r.file)) problems.push(`${r.file} is in the table but not in the index`);
  return problems;
}

test('the index sections and the criteria table agree both ways, with the same section', () => {
  assert.deepEqual(agreementProblems(read('docs/README.md'), read('docs/WRITING-DOCS.md')), []);
});

test('the index has the four sections, in order, before Contributing', () => {
  const headings = read('docs/README.md').split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3));
  assert.deepEqual(headings.slice(0, 5), [...SECTIONS, 'Contributing']);
});

test('every row of the table names a file that exists, with a known section', () => {
  const rows = criteriaRows(read('docs/WRITING-DOCS.md'));
  assert.ok(rows.length >= 9, `expected at least 9 rows, found ${rows.length}`);
  for (const r of rows) {
    assert.ok(fs.existsSync(path.join(ROOT, r.file)), `${r.file} does not exist`);
    assert.ok(SECTIONS.includes(r.section), `${r.file}: unknown section "${r.section}"`);
  }
});

test('every listed page opens its first paragraph by saying who it is for', () => {
  for (const r of criteriaRows(read('docs/WRITING-DOCS.md'))) {
    assert.match(firstParagraph(read(r.file)), OPENING, `${r.file}: first paragraph`);
  }
});

test('every row has a non-empty "Steps run on" cell', () => {
  for (const r of criteriaRows(read('docs/WRITING-DOCS.md'))) {
    assert.notEqual(r.stepsRunOn, '', `${r.file}: empty Steps cell`);
  }
});

test('docs/WRITING-DOCS.md has no em dash, en dash or arrow', () => {
  const text = read('docs/WRITING-DOCS.md');
  assert.ok(!text.includes('—'), 'em dash');
  assert.ok(!text.includes('–'), 'en dash');
  assert.ok(!text.includes('→'), 'arrow');
});

// ---- planted-defect controls, on scratch strings, with literal expectations ----

const SCRATCH_INDEX = [
  '# Index', '', '## Tutorial', '', '- [A](a.md): a.', '', '## How-to guides', '',
  '- [B](b.md#part): b.', '- [Web](https://example.org/x.md): ignored.', '', '## Reference', '',
  '## Explanation', '', '- [C](../C.md): c.', '', '## Contributing', '', '- [D](d.md): not a user page.', '',
].join('\n');
const table = (rows) => ['# W', '', '## The user pages', '', '| Page | Section | Steps run on |', '|---|---|---|', ...rows, ''].join('\n');
const GOOD_ROWS = [
  '| [A](a.md) | Tutorial | Not recorded |',
  '| [B](b.md) | How-to guides | No steps |',
  '| [C](../C.md) | Explanation | No steps |',
];

test('control: the scratch index and a matching table agree; fragments and external links are ignored', () => {
  assert.deepEqual([...indexSections(SCRATCH_INDEX)], [
    ['Tutorial', ['docs/a.md']],
    ['How-to guides', ['docs/b.md']],
    ['Reference', []],
    ['Explanation', ['C.md']],
  ]);
  assert.deepEqual(agreementProblems(SCRATCH_INDEX, table(GOOD_ROWS)), []);
});

test('control: a page in the index but missing from the table is reported', () => {
  assert.deepEqual(agreementProblems(SCRATCH_INDEX, table(GOOD_ROWS.slice(0, 2))), [
    'C.md is in the index under Explanation but not in the table',
  ]);
});

test('control: a page in the table but missing from the index is reported', () => {
  assert.deepEqual(agreementProblems(SCRATCH_INDEX, table([...GOOD_ROWS, '| [E](e.md) | Reference | No steps |'])), [
    'docs/e.md is in the table but not in the index',
  ]);
});

test('control: a table row with the wrong section is reported', () => {
  const rows = [GOOD_ROWS[0], '| [B](b.md) | Reference | No steps |', GOOD_ROWS[2]];
  assert.deepEqual(agreementProblems(SCRATCH_INDEX, table(rows)), [
    'docs/b.md is under How-to guides in the index but Reference in the table',
  ]);
});

test('control: a first paragraph without the phrase fails the opening check; one with it passes', () => {
  assert.doesNotMatch(firstParagraph('# T\n\nThis page helps a GM.\n\nThis page is for a later paragraph.\n'), OPENING);
  assert.match(firstParagraph('# T\n\nA lead-in sentence. This page is for a GM\nwho wants help.\n'), OPENING);
  assert.equal(firstParagraph('# T\n\nOne\ntwo\n\nThree\n'), 'One two');
});

test('control: an empty Steps cell is read as empty', () => {
  const rows = criteriaRows(table(['| [A](a.md) | Tutorial |  |']));
  assert.deepEqual(rows, [{ file: 'docs/a.md', section: 'Tutorial', stepsRunOn: '' }]);
});
