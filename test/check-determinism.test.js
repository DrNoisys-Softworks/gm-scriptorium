'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildCheckContext } = require('../src/checks/context');
const { runChecks } = require('../src/checks/run');
const { buildEnvelope, envelopeWithoutTimestamp } = require('../src/report/json');
const { CHECKS } = require('../src/checks/registry');
const { RUNNERS } = require('../src/checks/run');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'mini-vault-site-config.json'));

function jsonConfigForFixture() {
  return { ...SITE_CONFIG, vaultPath: MINI_VAULT };
}

test('every registered check has a runner, and every runner has a registered check', () => {
  const ids = CHECKS.map((c) => c.id).sort();
  const runnerIds = Object.keys(RUNNERS).sort();
  assert.deepEqual(ids, runnerIds);
});

test('runChecks against the fixture vault does not throw and returns valid Finding objects', () => {
  const ctx = buildCheckContext({
    campaign: 'fixture',
    vaultPath: MINI_VAULT,
    jsonConfig: jsonConfigForFixture(),
    graph: true,
  });
  const findings = runChecks(ctx);
  assert.ok(Array.isArray(findings));
  for (const f of findings) {
    assert.equal(typeof f.id, 'string');
    assert.ok(['error', 'warn', 'info'].includes(f.severity));
  }
});

test('two check runs against an unchanged vault produce a byte-identical findings array', () => {
  const run = () => {
    const ctx = buildCheckContext({
      campaign: 'fixture',
      vaultPath: MINI_VAULT,
      jsonConfig: jsonConfigForFixture(),
      graph: true,
    });
    const findings = runChecks(ctx);
    return buildEnvelope({
      tool: { name: 'scriptorium', version: '0.0.0' },
      campaign: 'fixture',
      vaultPath: MINI_VAULT,
      outputPath: null,
      findings,
    });
  };

  const a = run();
  const b = run();
  assert.equal(JSON.stringify(envelopeWithoutTimestamp(a)), JSON.stringify(envelopeWithoutTimestamp(b)));
});

test('the fixture vault produces the expected frontmatter/missing-type and parse-error findings', () => {
  const ctx = buildCheckContext({
    campaign: 'fixture',
    vaultPath: MINI_VAULT,
    jsonConfig: jsonConfigForFixture(),
  });
  const findings = runChecks(ctx);
  const byId = (id) => findings.filter((f) => f.id === id);

  assert.equal(byId('frontmatter/parse-error').length, 1);
  assert.equal(byId('frontmatter/parse-error')[0].path, 'Characters/NPCs/broken-frontmatter.md');

  assert.equal(byId('frontmatter/missing-type').length, 1);
  assert.equal(byId('frontmatter/missing-type')[0].path, 'Characters/NPCs/no-type.md');
});

test('criterion 8: a [[link]] to nothing produces exactly one ERROR naming the file', () => {
  // Committed as a fixture (not exercised only against the real vault),
  // per the reviewer's finding: a real vault gets curated over time and
  // could lose the incidental dead-link coverage the real-vault baseline
  // happened to provide. This fixture is a regression guard that survives
  // that curation.
  const ctx = buildCheckContext({
    campaign: 'fixture',
    vaultPath: MINI_VAULT,
    jsonConfig: jsonConfigForFixture(),
  });
  const findings = runChecks(ctx).filter(
    (f) => f.id === 'link/unresolved' && f.path === 'Characters/NPCs/dead-link.md',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /Nobody Who Exists/);
});

test('criterion 9: two fixture files resolving the same [[name]] produce an ambiguity ERROR', () => {
  // Committed as a fixture for the same reason as the dead-link case
  // above: acceptance criterion 9 explicitly asks for a fixture pair, not
  // reliance on whatever the real vault happens to contain today.
  const ctx = buildCheckContext({
    campaign: 'fixture',
    vaultPath: MINI_VAULT,
    jsonConfig: jsonConfigForFixture(),
  });
  const findings = runChecks(ctx).filter((f) => f.id === 'link/ambiguous-target');
  const match = findings.find((f) => f.data && f.data.name === 'duplicate name');
  assert.ok(match, 'expected an ambiguous-target finding for "Duplicate Name"');
  assert.equal(match.severity, 'error');
  const paths = new Set(match.data.sources.map((s) => s.relPath));
  assert.ok(paths.has('Characters/NPCs/Ambiguous-Alpha.md'));
  assert.ok(paths.has('Locations/Ambiguous-Beta.md'));
});

test('check never writes to the fixture vault (git status stays clean)', () => {
  const { execSync } = require('child_process');
  const ctx = buildCheckContext({
    campaign: 'fixture',
    vaultPath: MINI_VAULT,
    jsonConfig: jsonConfigForFixture(),
    graph: true,
  });
  runChecks(ctx);
  // The fixture lives inside this git repo; a real check run against a
  // vault that IS its own git repo would show `git status` staying clean.
  // Here we approximate that guarantee structurally instead (see
  // test/vault-read.test.js's forbidden-write-call scan), since the
  // fixture is committed content inside Scriptorium's own repo, not a
  // standalone vault repo, and running `git status` against it would
  // report on the whole Scriptorium working tree, not just the fixture.
  const output = execSync('git status --porcelain -- test/fixtures/mini-vault', {
    cwd: path.join(__dirname, '..'),
  }).toString();
  assert.equal(output.trim(), '');
});
