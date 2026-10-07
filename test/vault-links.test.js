'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractWikiLinks, stripBrackets } = require('../src/vault/links');

/*
 * #77: `check` reported wikilinks inside inline code spans / fenced code
 * blocks as link/unresolved ERRORs, even though the pinned generator's own
 * resolveWikiLinks() never renders those as clickable links (confirmed by
 * direct probe against node_modules/gm-apprentice-publish/lib/processor.js
 * before writing this fix — see the module doc block in src/vault/links.js).
 *
 * Every "ignoreCode" test below states its expected target list literally,
 * not by reading src/vault/links.js's own regex back — the point of the
 * assertion is independent of the code under test.
 */

test('extractWikiLinks: default behaviour (no opts) still finds a link inside a code span — baseline for leak/l3, which must NOT change', () => {
  const links = extractWikiLinks('See `[[Hidden]]` for detail.');
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Hidden');
});

test('extractWikiLinks: default behaviour still finds a link inside a fenced block — baseline for leak/l3', () => {
  const links = extractWikiLinks('```\n[[Hidden]]\n```');
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Hidden');
  assert.equal(links[0].line, 2);
});

// --- ignoreCode: true --------------------------------------------------

test('extractWikiLinks ignoreCode: a wikilink inside a single-backtick inline code span is skipped', () => {
  const links = extractWikiLinks('Pin syntax: `marker: default, down%, across%, [[Note]], label`', {
    ignoreCode: true,
  });
  assert.deepEqual(links, []);
});

test('extractWikiLinks ignoreCode: a wikilink inside a double-backtick span is skipped', () => {
  const links = extractWikiLinks('Syntax: ``[[Note]]`` example.', { ignoreCode: true });
  assert.deepEqual(links, []);
});

test('extractWikiLinks ignoreCode: a double-backtick span whose content contains a single backtick still closes on the double run, and the wikilink inside is skipped', () => {
  // CommonMark backtick-string matching: an inner single backtick is literal
  // content inside a ``-delimited span, not a close.
  const links = extractWikiLinks('``code with a ` backtick and [[Note]]``', { ignoreCode: true });
  assert.deepEqual(links, []);
});

test('extractWikiLinks ignoreCode: a wikilink inside a ``` fenced block is skipped', () => {
  const links = extractWikiLinks('Intro text.\n```\n[[Note]]\n```\nOutro text.', { ignoreCode: true });
  assert.deepEqual(links, []);
});

test('extractWikiLinks ignoreCode: a wikilink inside a ~~~ fenced block is skipped', () => {
  const links = extractWikiLinks('Intro text.\n~~~\n[[Note]]\n~~~\nOutro text.', { ignoreCode: true });
  assert.deepEqual(links, []);
});

test('extractWikiLinks ignoreCode: a ~~~ fence closes on its own character — a real wikilink after it is still checked', () => {
  // If the closer only ever recognised backticks (regardless of the
  // opener's actual fence character), a ~~~ fence would never close and
  // would swallow everything after it, including this real link.
  const links = extractWikiLinks('~~~\n[[InCode]]\n~~~\nReal [[After]].', { ignoreCode: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'After');
});

test('extractWikiLinks ignoreCode: an unresolved-looking wikilink after an unterminated single backtick is still extracted (fail closed)', () => {
  const links = extractWikiLinks('Text with an unterminated ` and [[Note]] after it.', { ignoreCode: true });
  assert.equal(links.length, 1, 'an unterminated backtick must not swallow the real wikilink into "code"');
  assert.equal(links[0].target, 'Note');
});

test('extractWikiLinks ignoreCode: a real wikilink on the same line as a code span is still extracted; only the code-span occurrence is dropped', () => {
  const links = extractWikiLinks('Code `x = 1` and real [[Note]] link, plus `[[InCode]]` example.', {
    ignoreCode: true,
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Note');
});

test('extractWikiLinks ignoreCode: a fenced block does not swallow a real wikilink before it or after it', () => {
  const links = extractWikiLinks('Real [[Before]].\n```\n[[InCode]]\n```\nReal [[After]].', { ignoreCode: true });
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.target).sort(), ['After', 'Before']);
});

test('extractWikiLinks ignoreCode: an unclosed fence runs to end of file, masking a wikilink after the opener', () => {
  const links = extractWikiLinks('Real [[Before]].\n```\n[[InCode]]', { ignoreCode: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Before');
});

test('extractWikiLinks ignoreCode: an embed wikilink inside a code span is also skipped', () => {
  const links = extractWikiLinks('Embed syntax: `![[Note.png]]`', { ignoreCode: true });
  assert.deepEqual(links, []);
});

test('extractWikiLinks ignoreCode: line numbers for surviving links are unaffected by masking', () => {
  const links = extractWikiLinks('one\n```\n[[Dropped]]\n```\nfive [[Kept]]', { ignoreCode: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Kept');
  assert.equal(links[0].line, 5);
});

test('stripBrackets: unaffected by the ignoreCode change (regression guard)', () => {
  assert.equal(stripBrackets('[[Target]]'), 'Target');
});

// --- onlyCode: the exact complement of ignoreCode (#77 follow-up, link/in-code) ---

test('extractWikiLinks onlyCode: a wikilink inside a single-backtick span IS extracted (the complement of ignoreCode)', () => {
  const links = extractWikiLinks('Pin syntax: `marker: default, down%, across%, [[Note]], label`', { onlyCode: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Note');
});

test('extractWikiLinks onlyCode: a wikilink inside a ``` fenced block IS extracted, with the correct line number', () => {
  const links = extractWikiLinks('Intro.\n```\n[[Note]]\n```\nOutro.', { onlyCode: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Note');
  assert.equal(links[0].line, 3);
});

test('extractWikiLinks onlyCode: a wikilink inside a ~~~ fenced block IS extracted', () => {
  const links = extractWikiLinks('~~~\n[[Note]]\n~~~', { onlyCode: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'Note');
});

test('extractWikiLinks onlyCode: a real (prose) wikilink is NOT extracted', () => {
  const links = extractWikiLinks('Real [[Note]] link.', { onlyCode: true });
  assert.deepEqual(links, []);
});

test('extractWikiLinks onlyCode: a real link on the same line as a code span — only the in-code one is extracted', () => {
  const links = extractWikiLinks('Code `x = 1` and real [[Note]] link, plus `[[InCode]]` example.', { onlyCode: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'InCode');
});

test('extractWikiLinks onlyCode: an unterminated backtick extracts nothing (fail closed, same as ignoreCode)', () => {
  const links = extractWikiLinks('Text with an unterminated ` and [[Note]] after it.', { onlyCode: true });
  assert.deepEqual(links, []);
});

test('extractWikiLinks: ignoreCode and onlyCode partition a mixed document exactly (no overlap, no gap)', () => {
  const src = 'Real [[Before]].\n```\n[[InFence]]\n```\nCode `[[InSpan]]` and real [[After]].';
  const ignored = extractWikiLinks(src, { ignoreCode: true });
  const onlyCode = extractWikiLinks(src, { onlyCode: true });
  const rawAll = extractWikiLinks(src);
  assert.deepEqual(ignored.map((l) => l.target).sort(), ['After', 'Before']);
  assert.deepEqual(onlyCode.map((l) => l.target).sort(), ['InFence', 'InSpan']);
  assert.equal(ignored.length + onlyCode.length, rawAll.length);
});
