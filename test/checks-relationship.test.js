'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCheckContext } = require('../src/checks/context');
const { runMissingRequired } = require('../src/checks/relationship');

/*
 * Check-level tests for relationship/missing-required (P1-FR03/FR04),
 * now table-driven via src/vault/entitytypes.js instead of the deleted
 * REQUIRED_RELATIONSHIP_TYPE map. Synthetic fixtures only (widget/gadget,
 * anchored_to/...): no campaign proper nouns, no real-vault counts
 * (NFR-08).
 */

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const MINI_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'mini-vault-site-config.json'));

function withScratchVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-relationship-'));
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

function minimalJsonConfig(vaultPath) {
  return {
    siteTitle: 'Test',
    siteUrl: 'https://example.invalid',
    vaultPath,
    outputDir: './out',
    attachmentsDir: '_attachments',
    folderMap: {},
    excludeDirs: [],
    excludeSections: [],
  };
}

function contextFor(vaultPath) {
  return buildCheckContext({
    campaign: 'fixture',
    vaultPath,
    jsonConfig: minimalJsonConfig(vaultPath),
  });
}

// --- absence cases (P1-FR04): exactly one INFO, requires nothing -----------

test('no _meta/entity-types.md at all: exactly one INFO, no per-file findings', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\n---\n\nNo relationships array at all.\n');
    const ctx = contextFor(vaultPath);
    const findings = runMissingRequired(ctx);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'relationship/missing-required');
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].path, null);
    assert.match(findings[0].message, /does not exist/);
  });
});

test('entity-types.md exists but has no "Required relationships" table: exactly one INFO (mini-vault\'s own fixture shape)', () => {
  // test/fixtures/mini-vault/_meta/entity-types.md deliberately has no
  // "## Required relationships" heading at all (just a bullet list) --
  // used here read-only, exercising this exact case without a scratch
  // copy. Its Characters/NPCs/Alice.md and Cal.md each carry a top-level
  // `located_at` field (not a `relationships:` array), which under the
  // OLD hardcoded REQUIRED_RELATIONSHIP_TYPE map would have produced two
  // per-file WARNs; this is the Gate's documented "known consequence".
  const ctx = buildCheckContext({
    campaign: 'fixture',
    vaultPath: MINI_VAULT,
    jsonConfig: { ...MINI_SITE_CONFIG, vaultPath: MINI_VAULT },
  });
  const findings = runMissingRequired(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'relationship/missing-required');
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].path, null);
  assert.match(findings[0].message, /no "Required relationships" table/);
});

test('unparseable entity-types.md frontmatter: exactly one INFO', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/entity-types.md', '---\ntitle: "Unterminated\n---\n\n## Required relationships\n');
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\n---\n\nbody\n');
    const ctx = contextFor(vaultPath);
    const findings = runMissingRequired(ctx);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].message, /frontmatter failed to parse/);
  });
});

// --- table-driven WARNs (P1-FR03) -------------------------------------------

test('a file missing its single required relationship gets one WARN with the unchanged message/data shape', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/entity-types.md',
      '---\ntype: reference\n---\n\n## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | `anchored_to` |\n',
    );
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\n---\n\nNo relationships array.\n');
    const ctx = contextFor(vaultPath);
    const findings = runMissingRequired(ctx);
    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert.equal(finding.id, 'relationship/missing-required');
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.category, 'frontmatter');
    assert.equal(finding.path, 'Widgets/Foo.md');
    assert.equal(finding.message, 'Widgets/Foo.md: type "widget" has no "anchored_to" relationship');
    assert.deepEqual(finding.data, { type: 'widget', required: 'anchored_to' });
  });
});

test('a file with the required relationship in its relationships array produces no finding', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/entity-types.md',
      '---\ntype: reference\n---\n\n## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | `anchored_to` |\n',
    );
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - target: Bar\n    type: anchored_to\n---\n\nbody\n',
    );
    const ctx = contextFor(vaultPath);
    assert.deepEqual(runMissingRequired(ctx), []);
  });
});

test('a top-level field of the same name as the required relationship type does not satisfy it (must be inside relationships[])', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/entity-types.md',
      '---\ntype: reference\n---\n\n## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | `anchored_to` |\n',
    );
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nanchored_to: "[[Bar]]"\n---\n\nbody\n');
    const ctx = contextFor(vaultPath);
    const findings = runMissingRequired(ctx);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.required, 'anchored_to');
  });
});

test('order is file order, then table order: two required relationship types missing on the same file produce two findings in table order', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/entity-types.md',
      '---\ntype: reference\n---\n\n## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | `anchored_to`, `owned_by` |\n',
    );
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\n---\n\nbody\n');
    const ctx = contextFor(vaultPath);
    const findings = runMissingRequired(ctx);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].data.required, 'anchored_to');
    assert.equal(findings[1].data.required, 'owned_by');
  });
});

test('order is file order, then table order: across two files, all of the first file\'s findings precede the second\'s', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/entity-types.md',
      '---\ntype: reference\n---\n\n## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | `anchored_to`, `owned_by` |\n',
    );
    // "A-First" sorts before "B-Second" by relPath, which is what
    // ctx.index.files iterates in (src/vault/read.js's walkVault: sorted).
    writeFile(vaultPath, 'Widgets/A-First.md', '---\ntype: widget\n---\n\nbody\n');
    writeFile(vaultPath, 'Widgets/B-Second.md', '---\ntype: widget\n---\n\nbody\n');
    const ctx = contextFor(vaultPath);
    const findings = runMissingRequired(ctx);
    assert.equal(findings.length, 4);
    assert.deepEqual(
      findings.map((f) => [f.path, f.data.required]),
      [
        ['Widgets/A-First.md', 'anchored_to'],
        ['Widgets/A-First.md', 'owned_by'],
        ['Widgets/B-Second.md', 'anchored_to'],
        ['Widgets/B-Second.md', 'owned_by'],
      ],
    );
  });
});

test('a type not named in the table has no requirement at all', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/entity-types.md',
      '---\ntype: reference\n---\n\n## Required relationships\n\n| Type | Required |\n|---|---|\n| widget | `anchored_to` |\n',
    );
    writeFile(vaultPath, 'Gadgets/Foo.md', '---\ntype: gadget\n---\n\nbody\n');
    const ctx = contextFor(vaultPath);
    assert.deepEqual(runMissingRequired(ctx), []);
  });
});
