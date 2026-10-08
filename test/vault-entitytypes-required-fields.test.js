'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const entitytypes = require('../src/vault/entitytypes');
const { buildCheckContext } = require('../src/checks/context');
const { runUnrecognisedType } = require('../src/checks/census');

// UPSTREAM-HEADING-ALIASES: tests for the gm-apprentice "Required Fields (by Entity Type)" section
// and the always-recognised `meta` type (owner, 2026-10-08). Delete with the aliases.
// The section below is copied from upstream skills/shared/entity-schema.md at a0215b1 (shortened
// to the lines the tests name). Expected values are written by hand from that file.

const SCAFFOLD = `---
type: meta
---

# Entity Types

## Entity Type Hierarchy

\`\`\`text
thing (abstract)
└── widget
\`\`\`

## Frontmatter Schemas

### Required Fields (by Entity Type)

Most entity types require \`type\` and \`canon_status\`.

\`\`\`yaml
npc: [type, canon_status]
adventure-brief: [type, canon_status, scope]
chapter: [type]
meta: [type]
timeline: [type]
pc_roster: [type]
world_flags: [type]
\`\`\`

The roster page is \`pc_roster\`.

### Relationships Block

\`\`\`yaml
not_a_type: [type]
\`\`\`

## Default Folder Mapping

| Type Category | Vault Folder |
|---------------|-------------|
| gizmo | Gizmos/ |
`;

const LEGACY = `# Entity Types

## Hierarchy

\`\`\`text
thing (abstract)
└── widget
\`\`\`

## Folder mapping

| Type | Folder |
|------|--------|
| gizmo | Gizmos/ |
`;

function writeVault(dir, entityTypes, types) {
  fs.mkdirSync(path.join(dir, '_meta'));
  fs.writeFileSync(path.join(dir, '_meta', 'entity-types.md'), entityTypes);
  fs.mkdirSync(path.join(dir, 'Stuff'));
  types.forEach((t, i) => {
    fs.writeFileSync(path.join(dir, 'Stuff', `p${i}.md`), `---\ntype: ${t}\n---\nbody\n`);
  });
}

function withVault(entityTypes, types, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-required-fields-'));
  try {
    writeVault(dir, entityTypes, types);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function flagged(dir) {
  const ctx = buildCheckContext({ vaultPath: dir, campaign: 'T' });
  return runUnrecognisedType(ctx).map((f) => f.data.type).sort();
}

test('Required Fields block: every listed type is recognised', () => {
  withVault(SCAFFOLD, [], (dir) => {
    const types = entitytypes.parseRecognisedTypes(dir);
    for (const t of ['npc', 'adventure-brief', 'chapter', 'meta', 'timeline', 'pc_roster', 'world_flags']) {
      assert.ok(types.has(t), t);
    }
  });
});

test('Required Fields: a yaml block under another heading is not read', () => {
  withVault(SCAFFOLD, [], (dir) => {
    assert.ok(!entitytypes.parseRecognisedTypes(dir).has('not_a_type'));
  });
});

test('check on a scaffold-shaped vault: no unrecognised-type for meta, timeline, pc_roster', () => {
  withVault(SCAFFOLD, ['meta', 'meta', 'timeline', 'pc_roster', 'widget'], (dir) => {
    assert.deepEqual(flagged(dir), []);
  });
});

test('a genuinely unknown type is still flagged on a scaffold-shaped vault', () => {
  withVault(SCAFFOLD, ['meta', 'timeline', 'zorblax'], (dir) => {
    assert.deepEqual(flagged(dir), ['zorblax']);
  });
});

test('meta is recognised when the section exists, even if it does not list meta', () => {
  const doc = SCAFFOLD.replace('meta: [type]\n', '');
  assert.ok(!doc.includes('meta: ['), 'fixture really omits meta from the block');
  withVault(doc, ['meta', 'widget'], (dir) => {
    assert.deepEqual(flagged(dir), []);
  });
});

test('legacy vault (no Required Fields section): a meta page is still flagged, as before', () => {
  withVault(LEGACY, ['meta', 'widget'], (dir) => {
    assert.deepEqual(flagged(dir), ['meta']);
  });
});

test('no entity-types file: only character-story is recognised, as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-required-fields-'));
  try {
    fs.mkdirSync(path.join(dir, 'Stuff'));
    assert.deepEqual([...entitytypes.parseRecognisedTypes(dir)], ['character-story']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy vault: timeline and pc_roster stay unrecognised, as before', () => {
  withVault(LEGACY, ['widget', 'gizmo', 'timeline', 'pc_roster'], (dir) => {
    assert.deepEqual(flagged(dir), ['pc_roster', 'timeline']);
  });
});

test('Required Fields: prose, malformed lines and non-list values are not types', () => {
  const doc = `## Required Fields

\`\`\`yaml
# comment: [type]
good_one: [type]
bad one: [type]
scalar: type
nested:
  inner: [type]
\`\`\`
`;
  withVault(doc, [], (dir) => {
    const types = entitytypes.parseRecognisedTypes(dir);
    assert.ok(!types.has('good_one'), 'a bare "## Required Fields" is not upstream heading depth');
  });
  const doc2 = doc.replace('## Required Fields', '### Required Fields (by Entity Type)');
  withVault(doc2, [], (dir) => {
    const types = entitytypes.parseRecognisedTypes(dir);
    assert.ok(types.has('good_one'));
    for (const bad of ['bad one', 'scalar', 'nested', 'inner', '# comment']) assert.ok(!types.has(bad), bad);
  });
});
