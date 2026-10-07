'use strict';

const path = require('path');
const read = require('./read');

/*
 * The single read chokepoint for `_meta/relationship-types.md` (SD-1). This
 * mirrors src/vault/entitytypes.js: every read goes through
 * src/vault/read.js's module object (read.pathExists, read.readFrontmatter),
 * never through `fs` directly (test/vault-read.test.js's chokepoint rule,
 * and the structural test in test/relationship-types.test.js).
 *
 * "relationship types" and "words" are used throughout rather than
 * "vocabulary": that word already means site labels here (ADR 0020,
 * admin-vocab*).
 */

/**
 * Splits one markdown table row into its cells, keeping internal empty
 * cells. Copied from src/vault/entitytypes.js's splitTableRow (SD-1 P3):
 * that module is not modified or re-exported from here.
 */
function splitTableRow(row) {
  const cells = row.split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** First header cell that equals "types" once backticks and `*` are removed and lower-cased (P4). */
function findTypesColumnIndex(headerCells) {
  return headerCells.findIndex(
    (c) => c.replace(/`/g, '').replace(/\*/g, '').trim().toLowerCase() === 'types',
  );
}

/** Appends `value` to `arr` the first time it is seen, tracked via `seen` (first-seen order, deduplicated). */
function pushUnique(arr, seen, value) {
  if (seen.has(value)) return;
  seen.add(value);
  arr.push(value);
}

const SEPARATOR_RE = /^:?-+:?$/;
const SYMMETRIC_LINE_RE = /^\*\*Symmetric\b[^*]*\*\*(.*)$/;

/**
 * Parses the body of `_meta/relationship-types.md` (the file's content
 * after any frontmatter) into the relationship word list. Pure: no
 * filesystem access. Both returned arrays are in first-seen (top-to-bottom)
 * order and deduplicated (SD-1).
 *
 * Parse rules (P1-P8, binding, see r5-architect-2026-09-30.md SD-1):
 *  - a table row is a line starting with `|`; a table is a maximal run of
 *    consecutive table rows, whose first row is the header;
 *  - the Types column is the first header cell that is "types" once
 *    backticks/`*` are stripped and it is lower-cased; a table with none
 *    contributes nothing;
 *  - body rows split their Types cell on `,`; each part has backticks
 *    stripped and is trimmed, a trailing `*` marks it symmetric and is then
 *    stripped, and an empty part is skipped;
 *  - a line matching `**Symmetric ... **<rest>` contributes `<rest>`,
 *    split on `,`, to the symmetric set (which also counts as vocabulary);
 *  - nothing else contributes: prose, headings, lists, other bold-label
 *    lines (tone, strength), backticked words elsewhere, and tables with no
 *    Types column.
 *
 * @param {string} content
 * @returns {{ tableFound: boolean, tableWords: string[], symmetric: string[] }}
 */
function parseRelationshipTypesText(content) {
  const lines = String(content)
    .split('\n')
    .map((l) => l.trim());

  const tableWords = [];
  const tableWordsSeen = new Set();
  const symmetric = [];
  const symmetricSeen = new Set();
  let tableFound = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }

      const headerCells = splitTableRow(tableLines[0]);
      const typesIdx = findTypesColumnIndex(headerCells);
      if (typesIdx !== -1) {
        tableFound = true;
        for (let r = 1; r < tableLines.length; r++) {
          const cells = splitTableRow(tableLines[r]);
          if (cells.length <= typesIdx) continue;
          if (SEPARATOR_RE.test(cells[typesIdx])) continue;

          for (let part of cells[typesIdx].split(',')) {
            part = part.replace(/`/g, '').trim();
            const starred = /\*+$/.test(part);
            part = part.replace(/\*+$/, '').trim();
            if (!part) continue;
            pushUnique(tableWords, tableWordsSeen, part);
            if (starred) pushUnique(symmetric, symmetricSeen, part);
          }
        }
      }
      continue; // i already advanced past the table run
    }

    const m = line.match(SYMMETRIC_LINE_RE);
    if (m) {
      let rest = m[1];
      rest = rest.replace(/^\s*:?\s*/, '');
      rest = rest.replace(/\.\s*$/, '');
      for (let part of rest.split(',')) {
        part = part.replace(/`/g, '');
        part = part.replace(/\*+$/, '');
        part = part.trim();
        if (!part) continue;
        pushUnique(symmetric, symmetricSeen, part);
      }
    }

    i++;
  }

  return { tableFound, tableWords, symmetric };
}

const NO_VOCAB_REASONS = ['no-file', 'parse-error', 'no-table', 'empty-table'];

/**
 * Reads `_meta/relationship-types.md` and returns its word list (SD-1 P9).
 *
 * @param {string} vaultPath
 * @returns {{ ok: true, words: Set<string>, symmetric: Set<string> } |
 *           { ok: false, reason: 'no-file' | 'parse-error' | 'no-table' | 'empty-table' }}
 * @throws {import('../util/errors').VaultReadError} on a filesystem failure
 */
function readRelationshipTypes(vaultPath) {
  const abs = path.join(vaultPath, '_meta', 'relationship-types.md');
  if (!read.pathExists(abs)) return { ok: false, reason: 'no-file' };

  const result = read.readFrontmatter(abs);
  if (!result.ok) return { ok: false, reason: 'parse-error' };

  const parsed = parseRelationshipTypesText(result.content);
  if (!parsed.tableFound) return { ok: false, reason: 'no-table' };
  if (parsed.tableWords.length === 0) return { ok: false, reason: 'empty-table' };

  return {
    ok: true,
    words: new Set([...parsed.tableWords, ...parsed.symmetric]),
    symmetric: new Set(parsed.symmetric),
  };
}

module.exports = { parseRelationshipTypesText, readRelationshipTypes, NO_VOCAB_REASONS };
