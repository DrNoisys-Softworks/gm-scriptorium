'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { alignStrippedToSource, deriveRenderedText } = require('../src/checks/leak/textmodel');

function basePublishConfig(overrides = {}) {
  return {
    mode: 'player',
    exclude_drafts: false,
    exclude_callouts: false,
    exclude_sections: [],
    exclude_fields: [],
    exclude_dirs: [],
    overrides: { fields: {} },
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    rel: 'Characters/NPCs/X.md',
    relPath: 'Characters/NPCs/X.md',
    frontmatter: { type: 'npc' },
    markdown: '',
    storyMarkdown: undefined,
    ...overrides,
  };
}

/*
 * Track D3, Structural decision 5's alignment pass, tested directly:
 * `alignStrippedToSource(sourceMarkdown, strippedText)` returns one
 * 1-based source line number (or null) per line of strippedText.
 */

test('alignStrippedToSource: an unchanged line maps to its own 1-based line number', () => {
  const source = 'one\ntwo\nthree';
  const stripped = 'one\ntwo\nthree';
  assert.deepEqual(alignStrippedToSource(source, stripped), [1, 2, 3]);
});

test('alignStrippedToSource: a blank stripped line maps to null and never advances the cursor', () => {
  const source = 'kept\nreal line';
  const stripped = 'kept\n\nreal line'; // an extra blank the strip chain inserted
  assert.deepEqual(alignStrippedToSource(source, stripped), [1, null, 2]);
});

test('alignStrippedToSource: CRLF source lines still align against LF stripped text', () => {
  const source = 'visible one\r\nvisible two\r\n';
  const stripped = 'visible one\nvisible two';
  assert.deepEqual(alignStrippedToSource(source, stripped), [1, 2]);
});

test('alignStrippedToSource: a whole block collapsed to one blank line consumes no source cursor progress it did not earn', () => {
  // Mirrors stripGmOnly/stripSpoiler/stripDataview: the removed block's
  // lines vanish from strippedText and the survivor is one blank line;
  // the real lines before and after must still align correctly.
  const source = ['before', '<!-- gm-only -->', 'secret', '<!-- /gm-only -->', 'after'].join('\n');
  const stripped = ['before', '', 'after'].join('\n');
  assert.deepEqual(alignStrippedToSource(source, stripped), [1, null, 5]);
});

test('alignStrippedToSource: an inline comment removed from the START of a line still aligns (prefix removal keeps a contiguous suffix)', () => {
  const source = '<!-- note --> Gus Marzone walks past the stalls.';
  const stripped = 'Gus Marzone walks past the stalls.';
  assert.deepEqual(alignStrippedToSource(source, stripped), [1]);
});

test('alignStrippedToSource: an inline comment removed from the END of a line still aligns (suffix removal keeps a contiguous prefix)', () => {
  const source = 'Gus Marzone walks past the stalls.<!-- note -->';
  const stripped = 'Gus Marzone walks past the stalls.';
  assert.deepEqual(alignStrippedToSource(source, stripped), [1]);
});

test('alignStrippedToSource: a stub reduction that keeps only some sections still finds the surviving lines\' real line numbers', () => {
  const source = ['## Public Bio', 'Kept line one.', 'Kept line two.', '', '## GM Notes', 'Dropped line.'].join('\n');
  // keepOnlySections would leave only the Public Bio heading + its body.
  const stripped = ['## Public Bio', 'Kept line one.', 'Kept line two.'].join('\n');
  assert.deepEqual(alignStrippedToSource(source, stripped), [1, 2, 3]);
});

test('alignStrippedToSource: a line with no match anywhere maps to null and restores the cursor for later lines', () => {
  const source = ['first', 'unrelated content', 'third'].join('\n');
  // "second" never appears in source at all (a genuine anomaly); "third" does.
  const stripped = ['first', 'second', 'third'].join('\n');
  assert.deepEqual(alignStrippedToSource(source, stripped), [1, null, 3]);
});

test('alignStrippedToSource: empty strippedText returns an empty array', () => {
  assert.deepEqual(alignStrippedToSource('anything', ''), [null]); // '' splits to [''], one blank line
});

// --- integration: alignment against deriveRenderedText's own output on a real strip chain ---

test('deriveRenderedText + alignStrippedToSource: a dataview block ahead of the hit line does not desync the hit\'s own line number', () => {
  const md = ['```dataview', 'TABLE x FROM "y"', '```', '', 'Real visible line with Secret Name in it.'].join('\n');
  const rendered = deriveRenderedText(page({ markdown: md }), basePublishConfig());
  const lines = alignStrippedToSource(md, rendered.bodyText);
  const hitLineIdx = rendered.bodyText.split('\n').findIndex((l) => l.includes('Secret Name'));
  assert.ok(hitLineIdx >= 0);
  assert.equal(lines[hitLineIdx], 5, 'must point at the real file line, not the dataview block');
});
