'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const entitytypes = require('../src/vault/entitytypes');
const census = require('../src/checks/census');

/*
 * Unit tests for src/vault/entitytypes.js (P1-FR01/FR02/FR04). All
 * fixtures are synthetic (widget/gadget/gizmo, anchored_to/based_at/...):
 * no campaign proper nouns, no real-vault counts (NFR-08).
 */

function withScratchVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-entitytypes-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeEntityTypes(vaultPath, content) {
  const metaDir = path.join(vaultPath, '_meta');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'entity-types.md'), content);
}

const REQUIRED_TABLE_PREAMBLE = '---\ntype: reference\n---\n\n# Entity types\n\n';

// --- parseRequiredRelationships: absence cases -----------------------------

test('parseRequiredRelationships: no _meta/entity-types.md at all gives reason "no-file"', () => {
  withScratchVault((dir) => {
    const result = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual(result, { ok: false, reason: 'no-file' });
  });
});

test('parseRequiredRelationships: unparseable frontmatter gives reason "parse-error"', () => {
  withScratchVault((dir) => {
    writeEntityTypes(dir, '---\ntitle: "Unterminated quote\n---\n\n## Required relationships\n');
    const result = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual(result, { ok: false, reason: 'parse-error' });
  });
});

test('parseRequiredRelationships: a file with no "Required relationships" heading gives reason "no-table"', () => {
  withScratchVault((dir) => {
    writeEntityTypes(dir, `${REQUIRED_TABLE_PREAMBLE}Just some prose, no table here.\n`);
    const result = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual(result, { ok: false, reason: 'no-table' });
  });
});

// --- parseRequiredRelationships: table parsing (P1-FR02) -------------------

test('parseRequiredRelationships: a simple one-type one-relationship row', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | \`anchored_to\` |\n`,
    );
    const result = entitytypes.parseRequiredRelationships(dir);
    assert.equal(result.ok, true);
    assert.deepEqual([...result.requiredByType.entries()], [['widget', ['anchored_to']]]);
  });
});

test('parseRequiredRelationships: multiple types in one row all share the requirement', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| widget, gadget, gizmo | \`anchored_to\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual(requiredByType.get('widget'), ['anchored_to']);
    assert.deepEqual(requiredByType.get('gadget'), ['anchored_to']);
    assert.deepEqual(requiredByType.get('gizmo'), ['anchored_to']);
  });
});

test('parseRequiredRelationships: multiple relationship types in one cell are each required independently', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| collective | \`based_at\`, \`allied_with\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual(requiredByType.get('collective'), ['based_at', 'allied_with']);
  });
});

test('parseRequiredRelationships: a type named on more than one row gets the union, deduplicated, in first-seen order', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | \`anchored_to\` |\n| widget | \`anchored_to\`, \`owned_by\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual(requiredByType.get('widget'), ['anchored_to', 'owned_by']);
  });
});

test('parseRequiredRelationships: a malformed row (missing the second column) is skipped, not thrown', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| widget |\n| gadget | \`anchored_to\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.equal(requiredByType.has('widget'), false);
    assert.deepEqual(requiredByType.get('gadget'), ['anchored_to']);
  });
});

test('parseRequiredRelationships: a row with an empty "Required" cell is skipped', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | |\n| gadget | \`anchored_to\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.equal(requiredByType.has('widget'), false);
    assert.deepEqual(requiredByType.get('gadget'), ['anchored_to']);
  });
});

test('parseRequiredRelationships: a row with an empty "Type" cell is skipped', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n|  | \`anchored_to\` |\n| gadget | \`based_at\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual([...requiredByType.keys()], ['gadget']);
  });
});

test('parseRequiredRelationships: parentheticals are stripped from the type cell', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| widget (a kind of gadget) | \`anchored_to\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual(requiredByType.get('widget'), ['anchored_to']);
    assert.equal(requiredByType.has('widget (a kind of gadget)'), false);
  });
});

test('parseRequiredRelationships: the header and separator rows never become entries', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | \`anchored_to\` |\n`,
    );
    const { requiredByType } = entitytypes.parseRequiredRelationships(dir);
    assert.deepEqual([...requiredByType.keys()], ['widget']);
  });
});

// --- parseRecognisedTypes: light coverage + parity with census.js ----------

test('parseRecognisedTypes: no file gives just the character-story default', () => {
  withScratchVault((dir) => {
    const recognised = entitytypes.parseRecognisedTypes(dir);
    assert.deepEqual([...recognised], ['character-story']);
  });
});

test('parseRecognisedTypes: hierarchy block entries are added, "(abstract)" lines and glyphs stripped', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Hierarchy\n\n\`\`\`text\nthing (abstract)\n├── widget\n└── gadget\n\`\`\`\n`,
    );
    const recognised = entitytypes.parseRecognisedTypes(dir);
    // Independently stated expected set: the hierarchy fence contributes
    // "widget" and "gadget" ("thing (abstract)" is dropped), plus the
    // always-present "character-story" default. "thing" itself is never
    // added because the whole line is skipped as abstract.
    assert.deepEqual([...recognised].sort(), ['character-story', 'gadget', 'widget']);
  });
});

test('parseRecognisedTypes: folder-mapping table entries are unioned in, comma-separated cells split', () => {
  withScratchVault((dir) => {
    writeEntityTypes(
      dir,
      `${REQUIRED_TABLE_PREAMBLE}## Folder mapping\n\n| Type | Folder |\n|---|---|\n| widget, gadget | \`Widgets/\` |\n`,
    );
    const recognised = entitytypes.parseRecognisedTypes(dir);
    assert.deepEqual([...recognised].sort(), ['character-story', 'gadget', 'widget']);
  });
});

test('census.js re-exports the exact same parseRecognisedTypes function (no behavioural drift from the move)', () => {
  assert.equal(census.parseRecognisedTypes, entitytypes.parseRecognisedTypes);
});
