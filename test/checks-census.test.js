'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildCheckContext } = require('../src/checks/context');
const { runTypeCensus, runUnrecognisedType } = require('../src/checks/census');

/*
 * Check-level tests for census/type and census/unrecognised-type, unchanged
 * by the P1 move of parseRecognisedTypes into src/vault/entitytypes.js
 * (test/vault-entitytypes.test.js covers the parser itself and its
 * re-export identity). This file proves the runners still integrate
 * correctly against a real ctx.
 */

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const MINI_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'mini-vault-site-config.json'));

function contextFor() {
  return buildCheckContext({
    campaign: 'fixture',
    vaultPath: MINI_VAULT,
    jsonConfig: { ...MINI_SITE_CONFIG, vaultPath: MINI_VAULT },
  });
}

test('census/type: counts typed files by type across the fixture vault (independently counted from its committed files)', () => {
  // _meta is NOT in censusWalk's skip set, so _meta/entity-types.md
  // (type: reference) and _meta/vault-config.md (type: meta) are counted
  // too, alongside npc x4 (Alice, Cal, Ambiguous-Alpha, dead-link),
  // location x3 (Ambiguous-Beta, Old-Mill, Town-Square) and session x1
  // (session-01). broken-frontmatter.md (parse error) and no-type.md (no
  // type field) are excluded, as is _Templates/npc-template.md (skipped
  // directory). 4 + 3 + 1 + 1 + 1 = 10 typed files across 5 types.
  const findings = runTypeCensus(contextFor());
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.equal(finding.id, 'census/type');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.message, '10 typed file(s) across 5 type(s)');
  assert.deepEqual(finding.data.byType, {
    location: 3,
    meta: 1,
    npc: 4,
    reference: 1,
    session: 1,
  });
});

test('census/unrecognised-type: every typed file fires, because the fixture\'s entity-types.md has no Hierarchy or Folder mapping section (only "character-story" is ever recognised)', () => {
  const findings = runUnrecognisedType(contextFor());
  const paths = findings.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'Characters/NPCs/Alice.md',
    'Characters/NPCs/Ambiguous-Alpha.md',
    'Characters/NPCs/Cal.md',
    'Characters/NPCs/dead-link.md',
    'Locations/Ambiguous-Beta.md',
    'Locations/Old-Mill.md',
    'Locations/Town-Square.md',
    'Recaps/session-01.md',
    '_meta/entity-types.md',
    '_meta/vault-config.md',
  ]);
  for (const f of findings) {
    assert.equal(f.severity, 'warn');
    assert.equal(f.id, 'census/unrecognised-type');
  }
});
