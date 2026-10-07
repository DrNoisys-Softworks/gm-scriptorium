'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCheckContext } = require('../src/checks/context');
const { runChecks } = require('../src/checks/run');
const { buildEnvelope, envelopeWithoutTimestamp } = require('../src/report/json');
const { CHECKS } = require('../src/checks/registry');

/*
 * Behavioural tests for relationship/unknown-predicate (ADR 0037) and its
 * suppression of graph/generic-relationship-type. Synthetic inline temp
 * vaults only, invented predicate words (widget/gadget-style, never
 * owner-vault or sample-vault strings, NFR-11). Findings always come
 * through runChecks(buildCheckContext(...)), filtered on the exact check
 * id, so at PARENT (before the check id is registered) these assertions
 * are red by assertion, not by a missing import.
 */

function withScratchVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-unknown-predicate-'));
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
    // _meta is excluded from publish-candidate scanning, as in every
    // realistic vault config (test/gm-link-gate.test.js's writeMarkerVault,
    // test/checks-link.test.js): _meta/relationship-types.md is read
    // directly by src/vault/relationshiptypes.js, not scanned here, so this
    // keeps src/vault/publishset.js's own independent walk from also
    // reading it -- which the AC-20 read-count test would otherwise count.
    excludeDirs: ['_meta'],
    excludeSections: [],
  };
}

function contextFor(vaultPath, { graph = false } = {}) {
  return buildCheckContext({
    campaign: 'fixture',
    vaultPath,
    jsonConfig: minimalJsonConfig(vaultPath),
    graph,
  });
}

function unknownPredicateFindings(vaultPath, opts) {
  return runChecks(contextFor(vaultPath, opts)).filter((f) => f.id === 'relationship/unknown-predicate');
}

function genericFindings(vaultPath, opts) {
  return runChecks(contextFor(vaultPath, opts)).filter((f) => f.id === 'graph/generic-relationship-type');
}

// A standard invented word list: `knows` is deliberately included (it is
// also graph.js's GENERIC_TYPES set) so the same list drives both the
// unknown-predicate and generic-relationship-type tests below.
const RELATIONSHIP_TYPES_MD = [
  '---',
  'type: meta',
  '---',
  '',
  '## Types',
  '',
  '| Category | Types |',
  '|---|---|',
  '| Alliance | `allied_with` |',
  '| Location | `located_at` |',
  '| Kinship | `sibling_of*` |',
  '| Acquaintance | `knows` |',
  '',
].join('\n');

// Mirrors the "traps" from test/relationship-types.test.js's base fixture,
// for AC-04's behavioural half: a notes-section backtick, a tone line and a
// no-Types-column table must not make these words known.
const RELATIONSHIP_TYPES_WITH_TRAPS = [
  '---',
  'type: meta',
  '---',
  '',
  '## Types',
  '',
  '| Category | Types |',
  '|---|---|',
  '| Alliance | `allied_with` |',
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

// AC-17: two distinct vocabulary words that normalise to the same key.
const RELATIONSHIP_TYPES_WITH_AMBIGUITY = [
  '---',
  'type: meta',
  '---',
  '',
  '| Types |',
  '|---|',
  '| allied_with |',
  '| foo_bar |',
  '| foo-bar |',
  '',
].join('\n');

const ENTITY_TYPES_WITH_REQUIREMENT = [
  '---',
  'type: meta',
  '---',
  '',
  '## Hierarchy',
  '',
  '```text',
  'widget',
  '```',
  '',
  '## Required relationships',
  '',
  '| Type | Required |',
  '|---|---|',
  '| widget | `located_at` |',
  '',
].join('\n');

// --- AC-01 -------------------------------------------------------------

test('AC-01: "allied" is flagged once; "allied_with" is clean', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - type: allied\n    target: Bar\n  - type: allied_with\n    target: Bar\n---\n\nbody\n',
    );
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.predicate, 'allied');
    assert.equal(findings[0].severity, 'warn');
  });
});

// --- AC-02 -------------------------------------------------------------

test('AC-02: "located_at_home" is flagged (no reverse-prefix membership)', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: located_at_home\n    target: Bar\n---\n\nbody\n');
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.predicate, 'located_at_home');
  });
});

// --- AC-03 -------------------------------------------------------------

test('AC-03: "Allied_With" is flagged, with data.suggestion === "allied_with"', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: Allied_With\n    target: Bar\n---\n\nbody\n');
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.suggestion, 'allied_with');
    assert.equal(
      findings[0].message,
      'Widgets/Foo.md: relationship 1 (to "Bar") uses "Allied_With", which is not in _meta/relationship-types.md. Did you mean "allied_with"?',
    );
  });
});

// --- AC-04 -------------------------------------------------------------

test('AC-04: a notes-section backtick, a tone-line word and a no-Types-table word are each flagged', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_WITH_TRAPS);
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - type: lorem_word\n    target: Bar\n  - type: hostile\n    target: Bar\n  - type: ipsum_word\n    target: Bar\n---\n\nbody\n',
    );
    const findings = unknownPredicateFindings(vaultPath);
    const predicates = findings.map((f) => f.data.predicate).sort();
    assert.deepEqual(predicates, ['hostile', 'ipsum_word', 'lorem_word']);
  });
});

// --- AC-05 -------------------------------------------------------------

test('AC-05: "hacked" (not in the vault\'s own table) is flagged even though it is a plausible upstream word', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: hacked\n    target: Bar\n---\n\nbody\n');
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.predicate, 'hacked');
  });
});

// --- AC-06 -------------------------------------------------------------

test('AC-06: a `sibling_of*` Types entry makes a sibling_of edge clean', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: sibling_of\n    target: Bar\n---\n\nbody\n');
    assert.deepEqual(unknownPredicateFindings(vaultPath), []);
  });
});

// --- AC-07 ---------------------------------------------------------------

const OFF_LIST_EDGE_FILE = '---\ntype: widget\nrelationships:\n  - type: ghost_word\n    target: Bar\n---\n\nbody\n';

test('AC-07: no-file gives exactly one INFO with reason "no-file", and 0 WARNs even with an off-list edge present', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, 'Widgets/Foo.md', OFF_LIST_EDGE_FILE);
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].data.reason, 'no-file');
    assert.equal(findings.filter((f) => f.severity === 'warn').length, 0);
  });
});

test('AC-07: parse-error (malformed YAML) gives exactly one INFO, and 0 WARNs', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', '---\ntitle: "Unterminated\n---\n\n| Types |\n|---|\n| foo_word |\n');
    writeFile(vaultPath, 'Widgets/Foo.md', OFF_LIST_EDGE_FILE);
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].data.reason, 'parse-error');
    assert.equal(findings.filter((f) => f.severity === 'warn').length, 0);
  });
});

test('AC-07: parse-error (---coffee fence) gives exactly one INFO, and 0 WARNs', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', '---coffee\nx: 1\n---\n\n| Types |\n|---|\n| foo_word |\n');
    writeFile(vaultPath, 'Widgets/Foo.md', OFF_LIST_EDGE_FILE);
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].data.reason, 'parse-error');
    assert.equal(findings.filter((f) => f.severity === 'warn').length, 0);
  });
});

test('AC-07: no-table gives exactly one INFO, and 0 WARNs', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', '---\ntype: meta\n---\n\nJust prose, no table here.\n');
    writeFile(vaultPath, 'Widgets/Foo.md', OFF_LIST_EDGE_FILE);
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].data.reason, 'no-table');
    assert.equal(findings.filter((f) => f.severity === 'warn').length, 0);
  });
});

test('AC-07: empty-table gives exactly one INFO, and 0 WARNs (even with a Symmetric line present)', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      '_meta/relationship-types.md',
      '---\ntype: meta\n---\n\n| Types |\n|---|\n\n**Symmetric (stored once):** knows.\n',
    );
    writeFile(vaultPath, 'Widgets/Foo.md', OFF_LIST_EDGE_FILE);
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].data.reason, 'empty-table');
    assert.equal(findings.filter((f) => f.severity === 'warn').length, 0);
  });
});

// --- AC-08 -------------------------------------------------------------

test('AC-08: a map-form "allied" key is flagged with form:"object"; map-form "allied_with" is clean', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  allied: [Bar]\n  allied_with: [Bar]\n---\n\nbody\n',
    );
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.predicate, 'allied');
    assert.equal(findings[0].data.form, 'object');
  });
});

// --- AC-09 -------------------------------------------------------------

test('AC-09: gm_only edges and edges to a non-existent note are flagged', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - type: ghost_word\n    target: NoSuchNote\n    gm_only: true\n---\n\nbody\n',
    );
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.predicate, 'ghost_word');
    assert.equal(findings[0].data.target, 'NoSuchNote');
  });
});

// --- AC-10 -------------------------------------------------------------

test('AC-10: with --graph and the list loaded, related_to is reported once (unknown-predicate); knows is reported only by generic', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD); // has knows, not related_to
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - type: related_to\n    target: Bar\n  - type: knows\n    target: Bar\n---\n\nbody\n',
    );
    writeFile(vaultPath, 'Widgets/Bar.md', '---\ntype: widget\n---\n\nbody\n');

    const ctx = contextFor(vaultPath, { graph: true });
    const findings = runChecks(ctx);
    const unknownPredicate = findings.filter((f) => f.id === 'relationship/unknown-predicate');
    const generic = findings.filter((f) => f.id === 'graph/generic-relationship-type');

    assert.equal(unknownPredicate.length, 1);
    assert.equal(unknownPredicate[0].data.predicate, 'related_to');

    assert.equal(generic.length, 1);
    assert.equal(generic[0].data.type, 'knows');
  });
});

test('AC-10: with no vocabulary loaded, graph/generic-relationship-type reports both related_to and knows, as today', () => {
  withScratchVault((vaultPath) => {
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - type: related_to\n    target: Bar\n  - type: knows\n    target: Bar\n---\n\nbody\n',
    );
    writeFile(vaultPath, 'Widgets/Bar.md', '---\ntype: widget\n---\n\nbody\n');

    const ctx = contextFor(vaultPath, { graph: true });
    const findings = runChecks(ctx);
    const generic = findings.filter((f) => f.id === 'graph/generic-relationship-type');
    assert.equal(generic.length, 2);

    const unknownPredicate = findings.filter((f) => f.id === 'relationship/unknown-predicate');
    assert.equal(unknownPredicate.length, 1);
    assert.equal(unknownPredicate[0].severity, 'info');
    assert.equal(unknownPredicate[0].data.reason, 'no-file');
  });
});

// --- AC-11 -------------------------------------------------------------

test('AC-11: a non-symmetric in-vocabulary word ("located_at") is clean', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: located_at\n    target: Bar\n---\n\nbody\n');
    assert.deepEqual(unknownPredicateFindings(vaultPath), []);
  });
});

// --- AC-12 (in-process, real pipeline) ----------------------------------

test('AC-12: runCheckCommand on a scratch vault whose only non-INFO findings are these WARNs gives exitCode 0, counts.error 0, and at least one WARN', () => {
  const { runCheckCommand } = require('../src/cli/check');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-unknown-predicate-ac12-'));
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config body\n');
    // AC-12's fixture must be otherwise error-free: recognise both the
    // content type and the _meta/*.md files' own "meta" type, so
    // census/unrecognised-type stays silent, leaving only the new WARN.
    fs.writeFileSync(
      path.join(vaultPath, '_meta', 'entity-types.md'),
      '---\ntype: meta\n---\n\n## Hierarchy\n\n```text\nmeta\nwidget\n```\n',
    );
    fs.writeFileSync(path.join(vaultPath, '_meta', 'relationship-types.md'), RELATIONSHIP_TYPES_MD);
    // The relationship target must stay published, or leak/l3-unpublished-link would add a second WARN.
    fs.writeFileSync(
      path.join(vaultPath, '_meta', 'publish-manifest.md'),
      '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Foo.md\n- [x] Notes/Bar.md\n',
    );
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(
      path.join(packDir, 'vault.config.json'),
      JSON.stringify({ siteTitle: 'AC12 Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Notes', 'Foo.md'),
      '---\ntype: widget\nrelationships:\n  - type: allied\n    target: Bar\n---\n\n# Foo\n',
    );
    fs.writeFileSync(path.join(vaultPath, 'Notes', 'Bar.md'), '---\ntype: widget\n---\n\n# Bar\n');

    const configPath = path.join(root, 'config.toml');
    const output = path.join(root, 'out');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${output}'`, ''].join(
        '\n',
      ),
    );

    const result = runCheckCommand({ config: configPath }, 'alpha');
    assert.equal(result.exitCode, 0, `findings: ${JSON.stringify(result.envelope.findings)}`);
    assert.equal(result.envelope.counts.error, 0);
    const warns = result.envelope.findings.filter((f) => f.severity === 'warn');
    assert.equal(warns.length, 1, `expected only the unknown-predicate WARN, got: ${JSON.stringify(warns)}`);
    assert.equal(warns[0].id, 'relationship/unknown-predicate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-13 -------------------------------------------------------------

test('AC-13: a Located_At edge on a type requiring located_at gives exactly 1 unknown-predicate and 1 missing-required, each counted by exact id', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, '_meta/entity-types.md', ENTITY_TYPES_WITH_REQUIREMENT);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: Located_At\n    target: Bar\n---\n\nbody\n');
    // Bar is deliberately NOT type widget, so it does not also trip
    // relationship/missing-required and inflate the count this test checks.
    writeFile(vaultPath, 'Widgets/Bar.md', '---\ntype: gadget\n---\n\nbody\n');

    const findings = runChecks(contextFor(vaultPath));
    const unknownPredicate = findings.filter((f) => f.id === 'relationship/unknown-predicate');
    const missingRequired = findings.filter((f) => f.id === 'relationship/missing-required');
    assert.equal(unknownPredicate.length, 1);
    assert.equal(missingRequired.length, 1);
  });
});

// --- AC-14 (option A) ---------------------------------------------------

test('AC-14: "owned_by" is flagged with suggestion: null, the generic hint, and no from/to keys in data', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: owned_by\n    target: Bar\n---\n\nbody\n');
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.suggestion, null);
    assert.deepEqual(Object.keys(findings[0].data).sort(), ['form', 'index', 'predicate', 'suggestion', 'target']);
    assert.equal(
      findings[0].message,
      'Widgets/Foo.md: relationship 1 (to "Bar") uses "owned_by", which is not in _meta/relationship-types.md. ' +
        'Use the closest word from that list; if this word describes the link from the other side, put the listed word on the other note instead, so the relationship is stored once, from one end.',
    );
  });
});

// --- AC-15 (behavioural half; parser-level covered in relationship-types.test.js) ---

test('AC-15: a CRLF relationship-types.md gives the same findings as LF', () => {
  withScratchVault((vaultPath) => {
    const crlf = RELATIONSHIP_TYPES_MD.replace(/\n/g, '\r\n');
    writeFile(vaultPath, '_meta/relationship-types.md', crlf);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: allied_with\n    target: Bar\n---\n\nbody\n');
    assert.deepEqual(unknownPredicateFindings(vaultPath), []);
  });
});

// --- AC-17 -------------------------------------------------------------

test('AC-17: "allied with", "allied-with" and " allied_with " each suggest "allied_with"', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_WITH_AMBIGUITY);
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n' +
        '  - type: "allied with"\n    target: Bar\n' +
        '  - type: "allied-with"\n    target: Bar\n' +
        '  - type: " allied_with "\n    target: Bar\n' +
        '---\n\nbody\n',
    );
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 3);
    for (const f of findings) {
      assert.equal(f.data.suggestion, 'allied_with', `predicate "${f.data.predicate}" should suggest allied_with`);
    }
  });
});

test('AC-17: when two list words share a normalised key, the suggestion is null', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_WITH_AMBIGUITY); // has both foo_bar and foo-bar
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: "foo bar"\n    target: Bar\n---\n\nbody\n');
    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.suggestion, null);
  });
});

// --- AC-18 -------------------------------------------------------------

test('AC-18: type: 5 is flagged as "5"; missing/null/empty type, a non-object entry, an untyped file and an unparseable file each produce nothing', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      [
        '---',
        'type: widget',
        'relationships:',
        '  - type: 5',
        '    target: Bar',
        '  - type: null',
        '    target: Bar',
        '  - target: Bar',
        '  - type: ""',
        '    target: Bar',
        '  - "just-a-string-entry"',
        '  - ["nested", "array-entry"]',
        '---',
        '',
        'body',
        '',
      ].join('\n'),
    );
    writeFile(vaultPath, 'Widgets/NoType.md', '---\ntitle: no type here\nrelationships:\n  - type: ghost_word\n    target: Bar\n---\n\nbody\n');
    writeFile(vaultPath, 'Widgets/Broken.md', '---\ntitle: "Unterminated\n---\n\nbody\n');

    const findings = unknownPredicateFindings(vaultPath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, 'Widgets/Foo.md');
    assert.equal(findings[0].data.predicate, '5');
    assert.equal(findings[0].data.index, 0);
  });
});

// --- AC-19: exact strings, data shape, "dropped" wording, determinism ---

test('AC-19: data deep-equals the five-key shape for a WARN and the one-key shape for an INFO', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: allied\n    target: Bar\n---\n\nbody\n');
    const warns = unknownPredicateFindings(vaultPath);
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0].data, { predicate: 'allied', target: 'Bar', index: 0, form: 'array', suggestion: null });
  });

  withScratchVault((vaultPath) => {
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\n---\n\nbody\n');
    const infos = unknownPredicateFindings(vaultPath);
    assert.equal(infos.length, 1);
    assert.deepEqual(infos[0].data, { reason: 'no-file' });
  });
});

test('AC-19: the exact INFO message for each of the four reasons', () => {
  const cases = [
    { reason: 'no-file', setup: () => {} },
    {
      reason: 'parse-error',
      setup: (vaultPath) => writeFile(vaultPath, '_meta/relationship-types.md', '---\ntitle: "Unterminated\n---\n\n| Types |\n|---|\n'),
    },
    {
      reason: 'no-table',
      setup: (vaultPath) => writeFile(vaultPath, '_meta/relationship-types.md', '---\ntype: meta\n---\n\nno table here\n'),
    },
    {
      reason: 'empty-table',
      setup: (vaultPath) => writeFile(vaultPath, '_meta/relationship-types.md', '---\ntype: meta\n---\n\n| Types |\n|---|\n'),
    },
  ];
  const expectedMessage = {
    'no-file': '_meta/relationship-types.md does not exist; relationship words were not checked',
    'parse-error': "_meta/relationship-types.md's frontmatter failed to parse; relationship words were not checked",
    'no-table': '_meta/relationship-types.md has no table with a "Types" column; relationship words were not checked',
    'empty-table': '_meta/relationship-types.md\'s "Types" column lists no words; relationship words were not checked',
  };
  for (const c of cases) {
    withScratchVault((vaultPath) => {
      c.setup(vaultPath);
      writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\n---\n\nbody\n');
      const findings = unknownPredicateFindings(vaultPath);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].message, expectedMessage[c.reason]);
    });
  }
});

test('AC-19: no message or registry description implies the edge is dropped, hidden or removed', () => {
  const DROP_RE = /\b(drop|dropped|disappears?|falls? out|removed?)\b/i;

  const check = CHECKS.find((c) => c.id === 'relationship/unknown-predicate');
  assert.ok(check, 'relationship/unknown-predicate must be registered');
  assert.ok(!DROP_RE.test(check.description), check.description);

  const genericCheck = CHECKS.find((c) => c.id === 'graph/generic-relationship-type');
  assert.ok(!DROP_RE.test(genericCheck.description), genericCheck.description);

  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - type: allied\n    target: Bar\n  - type: owned_by\n    target: Bar\n---\n\nbody\n',
    );
    for (const f of unknownPredicateFindings(vaultPath)) {
      assert.ok(!DROP_RE.test(f.message), f.message);
    }
  });

  withScratchVault((vaultPath) => {
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\n---\n\nbody\n');
    for (const f of unknownPredicateFindings(vaultPath)) {
      assert.ok(!DROP_RE.test(f.message), f.message);
    }
  });
});

test('AC-19: check --json (without its timestamp) is byte-identical across two runs', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    writeFile(vaultPath, 'Widgets/Foo.md', '---\ntype: widget\nrelationships:\n  - type: allied\n    target: Bar\n---\n\nbody\n');

    function envelopeFor() {
      const findings = runChecks(contextFor(vaultPath));
      return buildEnvelope({
        tool: { name: 'scriptorium', version: '0.0.0-test' },
        campaign: 'fixture',
        vaultPath,
        outputPath: null,
        findings,
        now: () => '2026-01-01T00:00:00.000Z',
      });
    }

    const a = envelopeWithoutTimestamp(envelopeFor());
    const b = envelopeWithoutTimestamp(envelopeFor());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

// --- AC-20 (NFR-03) ------------------------------------------------------

/*
 * src/vault/publishset.js's scanAllCandidatePages (called unconditionally by
 * buildCheckContext, for leak/l2 and config/exclude-dirs-divergence) reads
 * EVERY markdown file's frontmatter through read.js's module object with
 * excludeDirs forced to [] (publishset.js:317-320, "Defense-in-depth
 * against a stale build" -- pre-existing, out of R5's file map, not
 * something this change may touch). That includes
 * _meta/relationship-types.md itself, once, regardless of this feature.
 * So a bare call-count spy on read.readFrontmatter for that path sees 2
 * calls, not 1: one from that pre-existing scan, one from
 * src/vault/relationshiptypes.js. What SD-2 actually requires -- the
 * vocabulary reader itself is called exactly once per check context, only
 * from buildCheckContext, never again by either runner -- is what this
 * test attributes by call-site instead of by bare count.
 */
test('AC-20: src/vault/relationshiptypes.js reads relationship-types.md exactly once per check context under --graph (NFR-03)', () => {
  withScratchVault((vaultPath) => {
    writeFile(vaultPath, '_meta/relationship-types.md', RELATIONSHIP_TYPES_MD);
    // A generic-type edge (`knows`) is required here, not just an
    // off-list one: graph.js's suppression line (M19's target) only runs
    // once GENERIC_TYPES.has(edge.type) is already true, so an edge that
    // never reaches that runner's body could not catch a mutation there.
    writeFile(
      vaultPath,
      'Widgets/Foo.md',
      '---\ntype: widget\nrelationships:\n  - type: allied\n    target: Bar\n  - type: knows\n    target: Bar\n---\n\nbody\n',
    );
    writeFile(vaultPath, 'Widgets/Bar.md', '---\ntype: widget\n---\n\nbody\n');

    const readMod = require('../src/vault/read');
    const original = readMod.readFrontmatter;
    const callers = [];
    readMod.readFrontmatter = function (absPath, ...rest) {
      if (path.basename(absPath) === 'relationship-types.md') {
        const stack = new Error().stack || '';
        callers.push(/[\\/]vault[\\/]relationshiptypes\.js/.test(stack) ? 'relationshiptypes' : 'other');
      }
      return original.call(this, absPath, ...rest);
    };
    try {
      const ctx = buildCheckContext({ campaign: 'fixture', vaultPath, jsonConfig: minimalJsonConfig(vaultPath), graph: true });
      runChecks(ctx);
    } finally {
      readMod.readFrontmatter = original;
    }
    assert.equal(callers.filter((c) => c === 'relationshiptypes').length, 1, `calls: ${JSON.stringify(callers)}`);
  });
});
