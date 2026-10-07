'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseRelationshipTypesText, readRelationshipTypes } = require('../src/vault/relationshiptypes');

/*
 * Parser-level tests for src/vault/relationshiptypes.js (SD-1, P1-P9).
 * Synthetic fixtures only (widget/gadget-style invented predicate words):
 * no owner-vault or sample-vault strings (NFR-11). Expected arrays are
 * hand-written, never derived from the parser under test.
 */

function withScratchVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-relationship-types-'));
  try {
    return fn(path.join(dir, 'vault'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(vaultPath, relPath, content) {
  const full = path.join(vaultPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// --- The base fixture (AC-04, AC-06) ---------------------------------------
// One frontmatter block, one Types table (with a `*`-marked symmetric
// entry), a bold Symmetric line, a notes section with a backticked
// non-predicate word, a bold "Tone values" line, and a second table with no
// Types column. Every part of this fixture is invented, not real vault text.

const BASE_FIXTURE = [
  '---',
  'type: meta',
  '---',
  '',
  '# Relationship types',
  '',
  '## Types',
  '',
  '| Category | Types |',
  '|---|---|',
  '| Location | `located_at` |',
  '| Alliance | `allied_with` |',
  '| Kinship | `sibling_of*` |',
  '',
  '**Symmetric (stored once):** knows, allied_with, borders.',
  '',
  '## House notes',
  '',
  'Use `lorem_word` for internal notes; it is not a predicate.',
  '',
  '**Tone values:** friendly, hostile.',
  '',
  '## Other reference',
  '',
  '| Word | Meaning |',
  '|---|---|',
  '| ipsum_word | a placeholder term |',
  '',
].join('\n');

const EXPECTED_TABLE_WORDS = ['located_at', 'allied_with', 'sibling_of'];
const EXPECTED_SYMMETRIC = ['sibling_of', 'knows', 'allied_with', 'borders'];

test('parseRelationshipTypesText: the base fixture gives the exact hand-written tableWords and symmetric arrays (AC-04, AC-06)', () => {
  const result = parseRelationshipTypesText(BASE_FIXTURE);
  assert.equal(result.tableFound, true);
  assert.deepEqual(result.tableWords, EXPECTED_TABLE_WORDS);
  assert.deepEqual(result.symmetric, EXPECTED_SYMMETRIC);
});

test('parseRelationshipTypesText: notes-section backtick, tone line and no-Types table contribute nothing (AC-04)', () => {
  const result = parseRelationshipTypesText(BASE_FIXTURE);
  assert.ok(!result.tableWords.includes('lorem_word'));
  assert.ok(!result.symmetric.includes('lorem_word'));
  assert.ok(!result.tableWords.includes('hostile'));
  assert.ok(!result.tableWords.includes('friendly'));
  assert.ok(!result.tableWords.includes('ipsum_word'));
});

test('parseRelationshipTypesText: a `*`-marked Types entry lands in both tableWords and symmetric, with the `*` stripped (AC-06)', () => {
  const result = parseRelationshipTypesText(BASE_FIXTURE);
  assert.ok(result.tableWords.includes('sibling_of'));
  assert.ok(!result.tableWords.includes('sibling_of*'));
  assert.ok(result.symmetric.includes('sibling_of'));
});

test('parseRelationshipTypesText: CRLF bytes give the same hand-written arrays as LF, including "borders" with no \\r or "." (AC-15)', () => {
  const crlf = BASE_FIXTURE.replace(/\n/g, '\r\n');
  const result = parseRelationshipTypesText(crlf);
  assert.deepEqual(result.tableWords, EXPECTED_TABLE_WORDS);
  assert.deepEqual(result.symmetric, EXPECTED_SYMMETRIC);
  assert.ok(result.symmetric.includes('borders'));
  for (const w of result.symmetric) {
    assert.ok(!w.includes('\r'), `symmetric word "${w}" must not carry a stray \\r`);
    assert.ok(!w.endsWith('.'), `symmetric word "${w}" must not carry a trailing "."`);
  }
});

// --- Two Types tables: union, first-seen order ------------------------------

test('parseRelationshipTypesText: two Types tables contribute their union, in first-seen order, deduplicated', () => {
  const content = [
    '| Types |',
    '|---|',
    '| alpha_word |',
    '| beta_word |',
    '',
    '| Types |',
    '|---|',
    '| beta_word |',
    '| gamma_word |',
  ].join('\n');
  const result = parseRelationshipTypesText(content);
  assert.equal(result.tableFound, true);
  assert.deepEqual(result.tableWords, ['alpha_word', 'beta_word', 'gamma_word']);
});

// --- Header/separator/short-row edge cases ----------------------------------

test('parseRelationshipTypesText: a bold "**Types**" header, an alignment separator, and a row shorter than the Types column all behave (P4, P5)', () => {
  const content = ['| Category | **Types** |', '|---|:---:|', '| Foo | short_word |', '| Bar |'].join('\n');
  const result = parseRelationshipTypesText(content);
  assert.equal(result.tableFound, true);
  assert.deepEqual(result.tableWords, ['short_word']);
});

// --- Reasons via disk (SD-1 P9, FR-04) --------------------------------------

test('readRelationshipTypes: no-file when _meta/relationship-types.md does not exist', () => {
  withScratchVault((vaultPath) => {
    fs.mkdirSync(vaultPath, { recursive: true });
    const result = readRelationshipTypes(vaultPath);
    assert.deepEqual(result, { ok: false, reason: 'no-file' });
  });
});

test('readRelationshipTypes: parse-error on malformed YAML frontmatter', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', '---\ntitle: "Unterminated\n---\n\n| Types |\n|---|\n| foo_word |\n');
    const result = readRelationshipTypes(vaultPath);
    assert.deepEqual(result, { ok: false, reason: 'parse-error' });
  });
});

test('readRelationshipTypes: parse-error on a `---coffee` fence gray-matter cannot parse', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', '---coffee\nx: 1\n---\n\n| Types |\n|---|\n| foo_word |\n');
    const result = readRelationshipTypes(vaultPath);
    assert.deepEqual(result, { ok: false, reason: 'parse-error' });
  });
});

test('readRelationshipTypes: no-table when the file has no table with a Types column at all', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', '---\ntype: meta\n---\n\nJust prose, no table here.\n');
    const result = readRelationshipTypes(vaultPath);
    assert.deepEqual(result, { ok: false, reason: 'no-table' });
  });
});

test('readRelationshipTypes: empty-table when the Types table has a header and separator only, even with a Symmetric line present (FR-04)', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/relationship-types.md',
      '---\ntype: meta\n---\n\n| Types |\n|---|\n\n**Symmetric (stored once):** knows.\n',
    );
    const result = readRelationshipTypes(vaultPath);
    assert.deepEqual(result, { ok: false, reason: 'empty-table' });
  });
});

test('readRelationshipTypes: ok result carries the word list and symmetric set, deduplicated', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', BASE_FIXTURE);
    const result = readRelationshipTypes(vaultPath);
    assert.equal(result.ok, true);
    assert.ok(result.words instanceof Set);
    assert.ok(result.symmetric instanceof Set);
    assert.deepEqual([...result.words], ['located_at', 'allied_with', 'sibling_of', 'knows', 'borders']);
    assert.deepEqual([...result.symmetric], EXPECTED_SYMMETRIC);
  });
});

// --- NFR-02: structural, no `fs` require ------------------------------------

test('structural: src/vault/relationshiptypes.js never requires fs directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'vault', 'relationshiptypes.js'), 'utf8');
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/require\(\s*['"]fs['"]\s*\)/.test(stripped), 'must not require("fs")');
  assert.ok(!/require\(\s*['"]node:fs['"]\s*\)/.test(stripped), 'must not require("node:fs")');
});
