'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const entitytypes = require('../src/vault/entitytypes');
const { buildCheckContext } = require('../src/checks/context');
const { runUnrecognisedType } = require('../src/checks/census');

// UPSTREAM-HEADING-ALIASES: tests for the gm-apprentice vault_scaffold.py
// section names (owner, 2026-10-08). Delete with the aliases.
// Synthetic fixture (widget/gadget); the headings are upstream's literal
// "Entity Type Hierarchy", "Default Folder Mapping", "Required Relationships".

const UPSTREAM = `---
type: meta
purpose: entity-types
---

# Entity Types

## Entity Type Hierarchy

\`\`\`text
thing (abstract)
├── widget
└── gadget
\`\`\`

## Frontmatter Schemas

Nothing the parser reads.

## Required Relationships

| Entity Type | Required Relationship |
|-------------|----------------------|
| \`widget\` | \`mounted_on\` |

## Default Folder Mapping

| Type Category | Vault Folder |
|---------------|-------------|
| gizmo | Gizmos/ |
`;

function withVault(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-upstream-headings-'));
  try {
    fs.mkdirSync(path.join(dir, '_meta'));
    fs.writeFileSync(path.join(dir, '_meta', 'entity-types.md'), content);
    fs.mkdirSync(path.join(dir, 'Stuff'));
    fs.writeFileSync(path.join(dir, 'Stuff', 'a.md'), '---\ntype: widget\n---\nbody\n');
    fs.writeFileSync(path.join(dir, 'Stuff', 'b.md'), '---\ntype: gadget\n---\nbody\n');
    fs.writeFileSync(path.join(dir, 'Stuff', 'c.md'), '---\ntype: gizmo\n---\nbody\n');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('upstream "Entity Type Hierarchy" heading: its fenced block is recognised', () => {
  withVault(UPSTREAM, (dir) => {
    const types = entitytypes.parseRecognisedTypes(dir);
    assert.ok(types.has('widget'));
    assert.ok(types.has('gadget'));
    assert.ok(!types.has('thing'), 'abstract types stay unrecognised');
  });
});

test('upstream "Default Folder Mapping" heading: its table types are recognised', () => {
  withVault(UPSTREAM, (dir) => {
    assert.ok(entitytypes.parseRecognisedTypes(dir).has('gizmo'));
  });
});

test('upstream "Required Relationships" heading: its table is parsed', () => {
  withVault(UPSTREAM, (dir) => {
    const r = entitytypes.parseRequiredRelationships(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.requiredByType.get('widget'), ['mounted_on']);
  });
});

test('check on a vault with upstream headings: no census/unrecognised-type for widget, gadget, gizmo', () => {
  withVault(UPSTREAM, (dir) => {
    const ctx = buildCheckContext({
      campaign: 'fixture',
      vaultPath: dir,
      jsonConfig: { vaultPath: dir },
    });
    const paths = runUnrecognisedType(ctx).map((f) => f.path);
    for (const p of ['Stuff/a.md', 'Stuff/b.md', 'Stuff/c.md']) {
      assert.ok(!paths.includes(p), `${p} should be recognised`);
    }
  });
});

test('existing headings still parse exactly as before', () => {
  const legacy = UPSTREAM
    .replace('## Entity Type Hierarchy', '## Hierarchy')
    .replace('## Default Folder Mapping', '## Folder mapping')
    .replace('## Required Relationships', '## Required relationships');
  withVault(legacy, (dir) => {
    const types = entitytypes.parseRecognisedTypes(dir);
    assert.ok(types.has('widget') && types.has('gadget') && types.has('gizmo'));
    assert.deepEqual(
      entitytypes.parseRequiredRelationships(dir).requiredByType.get('widget'),
      ['mounted_on']
    );
  });
});
