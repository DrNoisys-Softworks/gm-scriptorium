'use strict';

const path = require('path');
const read = require('./read');

const TREE_CHARS_RE = /^[\s│├└─]+/;

// UPSTREAM-HEADING-ALIASES: accept gm-apprentice vault_scaffold.py section names (owner, 2026-10-08). Remove if upstream and Scriptorium agree on one set.
// First name in each list is ours, the rest are upstream's. Matching stays case-sensitive, as before.
// Upstream's other scaffolded sections (Frontmatter Schemas, Type-Specific Fields) are not read here.
const HIERARCHY_HEADING = ['Hierarchy', 'Entity Type Hierarchy'].join('|');
const FOLDER_MAPPING_HEADING = ['Folder mapping', 'Default Folder Mapping'].join('|');
const REQUIRED_RELATIONSHIPS_HEADING = ['Required relationships', 'Required Relationships'].join('|');
// UPSTREAM-HEADING-ALIASES: first cells that mark a table header row. Ours is "Type"; upstream's are the other two.
const TABLE_HEADER_CELLS = ['type', 'entity type', 'type category'];
function isHeaderCell(cell) {
  return TABLE_HEADER_CELLS.includes(cell.trim().toLowerCase());
}
// UPSTREAM-HEADING-ALIASES: upstream lists types in "### Required Fields (by Entity Type)", a yaml fence of `name: [field, ...]` lines.
const REQUIRED_FIELDS_HEADING_RE = /^###[ \t]+Required Fields \(by Entity Type\)[ \t]*\r?$/;
const REQUIRED_FIELDS_LINE_RE = /^([A-Za-z0-9_-]+):[ \t]*\[[^\]]*\][ \t]*$/;
// UPSTREAM-HEADING-ALIASES: upstream writes "— (none required)" in the relationship cell for a type that requires nothing.
const NONE_REQUIRED_RE = /^[-–—]\s*(?:\(\s*none required\s*\))?$/i;

/*
 * The single read chokepoint for `_meta/entity-types.md` (P1-FR01). Both
 * census.js's recognised-type union and relationship.js's "Required
 * relationships" table come from this one file, so both are parsed here.
 * Every read goes through src/vault/read.js, per the vault read chokepoint
 * rule (test/vault-read.test.js).
 */

/**
 * Parses _meta/entity-types.md's "## Hierarchy" fenced block and
 * "## Folder mapping" table into the recognised `type` union (moved
 * verbatim from src/checks/census.js: the hierarchy block alone is NOT
 * enough, a vault can legitimately use types such as session-plan,
 * session-play-notes, session-transcript, session_wrap, scene,
 * character-story, maps, roster, dashboard, timeline, most of which live
 * only in the folder-mapping table, and a few of which appear in neither
 * and are expected to stay unrecognised). The recognised set is the union
 * of the hierarchy block, the folder-mapping table, and "character-story".
 *
 * census/unrecognised-type's output must not change: this function's
 * behaviour is unchanged from its previous home in census.js.
 */
function parseRecognisedTypes(vaultPath) {
  const recognised = new Set(['character-story']);
  const entityTypesPath = path.join(vaultPath, '_meta', 'entity-types.md');
  if (!read.pathExists(entityTypesPath)) return recognised;

  const result = read.readFrontmatter(entityTypesPath);
  if (!result.ok) return recognised;
  const content = result.content;

  // UPSTREAM-HEADING-ALIASES: types named in upstream's Required Fields yaml fence
  // The section ends at the next heading outside a fence (a "#" comment inside the yaml is not a heading).
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => REQUIRED_FIELDS_HEADING_RE.test(l));
  if (start >= 0) {
    // `meta` is vault infrastructure (_meta pages), never a campaign entity, so a vault with upstream's section always knows it.
    // Only in that case: a legacy vault's recognised set (and its warnings for `meta` pages) must stay as it was.
    recognised.add('meta');
    let inFence = false;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      const fence = l.match(/^```(.*)$/);
      if (fence) {
        if (inFence) break; // the first fence closes: only one block is read
        inFence = true;
        if (!/^ya?ml\s*$/.test(fence[1])) break;
        continue;
      }
      if (!inFence) {
        if (/^#{1,6}[ \t]/.test(l)) break;
        continue;
      }
      const m = l.match(REQUIRED_FIELDS_LINE_RE);
      if (m) recognised.add(m[1]);
    }
  }

  const hierarchyFence = content.match(new RegExp('##\\s*(?:' + HIERARCHY_HEADING + ')[\\s\\S]*?```(?:text)?\\n([\\s\\S]*?)```'));
  if (hierarchyFence) {
    for (const line of hierarchyFence[1].split('\n')) {
      const stripped = line.replace(TREE_CHARS_RE, '').trim();
      if (!stripped) continue;
      if (stripped.includes('(abstract)')) continue;
      const beforeColon = stripped.split(':')[0].trim();
      const name = beforeColon.replace(/\s*\(.*\)\s*$/, '').trim();
      if (name) recognised.add(name);
    }
  }

  const folderMappingSection = content.match(
    new RegExp('##\\s*(?:' + FOLDER_MAPPING_HEADING + ')\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)')
  );
  if (folderMappingSection) {
    for (const line of folderMappingSection[1].split('\n')) {
      const row = line.trim();
      if (!row.startsWith('|')) continue;
      const cells = row
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length === 0) continue;
      const typeCell = cells[0];
      if (/^-+$/.test(typeCell) || isHeaderCell(typeCell)) continue; // header/separator row
      for (const part of typeCell.split(',')) {
        const name = part
          .replace(/`/g, '')
          .replace(/\(.*\)/g, '')
          .trim();
        if (name) recognised.add(name);
      }
    }
  }

  return recognised;
}

/**
 * Splits one markdown table row into its cells, keeping internal empty
 * cells (unlike a naive split+filter, which would silently collapse a row
 * with a genuinely empty column into a shorter array and misalign the
 * rest). Only the empty strings produced by the row's own leading/trailing
 * "|" are dropped.
 */
function splitTableRow(row) {
  const cells = row.split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/**
 * Parses the "## Required relationships" table (P1-FR02) into an ordered
 * `Map<type, string[]>`: each recognised type maps to the relationship
 * types it requires, in first-seen (table) order, deduplicated. A type
 * named on more than one row gets the union of its rows.
 *
 * Returns `null` if the section itself is absent, which the caller (P1-FR04)
 * treats the same as a missing file or an unparseable one.
 */
function parseRequiredRelationshipsTable(content) {
  const section = content.match(
    new RegExp('##\\s*(?:' + REQUIRED_RELATIONSHIPS_HEADING + ')\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)')
  );
  if (!section) return null;

  const requiredByType = new Map();
  for (const line of section[1].split('\n')) {
    const row = line.trim();
    if (!row.startsWith('|')) continue;

    const cells = splitTableRow(row);
    if (cells.length === 0) continue;

    const firstCell = cells[0];
    if (/^-+$/.test(firstCell) || isHeaderCell(firstCell)) continue; // header/separator row

    // "Rows with an empty cell are skipped" (P1-FR02), which also covers a
    // malformed row missing its second column entirely.
    if (cells.length < 2 || cells[0] === '' || cells[1] === '') continue;
    if (NONE_REQUIRED_RE.test(cells[1])) continue; // UPSTREAM-HEADING-ALIASES: "none required" placeholder

    const types = cells[0]
      .split(',')
      .map((t) => t.replace(/`/g, '').replace(/\(.*\)/g, '').trim()) // UPSTREAM-HEADING-ALIASES: upstream backticks the type cell
      .filter((t) => t.length > 0);
    const relTypes = cells[1]
      .split(',')
      .map((r) => r.replace(/`/g, '').trim())
      .filter((r) => r.length > 0);
    if (types.length === 0 || relTypes.length === 0) continue;

    for (const type of types) {
      let list = requiredByType.get(type);
      if (!list) {
        list = [];
        requiredByType.set(type, list);
      }
      for (const relType of relTypes) {
        if (!list.includes(relType)) list.push(relType);
      }
    }
  }

  return requiredByType;
}

/**
 * Reads _meta/entity-types.md and returns its "Required relationships"
 * table for relationship.js (P1-FR01/FR03).
 *
 * @param {string} vaultPath
 * @returns {{ ok: true, requiredByType: Map<string, string[]> } |
 *           { ok: false, reason: 'no-file' | 'parse-error' | 'no-table' }}
 */
function parseRequiredRelationships(vaultPath) {
  const entityTypesPath = path.join(vaultPath, '_meta', 'entity-types.md');
  if (!read.pathExists(entityTypesPath)) return { ok: false, reason: 'no-file' };

  const result = read.readFrontmatter(entityTypesPath);
  if (!result.ok) return { ok: false, reason: 'parse-error' };

  const requiredByType = parseRequiredRelationshipsTable(result.content);
  if (!requiredByType) return { ok: false, reason: 'no-table' };

  return { ok: true, requiredByType };
}

module.exports = { parseRecognisedTypes, parseRequiredRelationships };
