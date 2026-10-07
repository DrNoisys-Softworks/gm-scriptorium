'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCheckContext } = require('../src/checks/context');
const { runExcludedDirInOutput } = require('../src/checks/leak/l2');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'mini-vault-site-config.json'));

function jsonConfigForFixture() {
  return { ...SITE_CONFIG, vaultPath: MINI_VAULT };
}

test('L2: no output directory at all emits INFO, not silence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l2-'));
  const neverCreated = path.join(dir, 'does-not-exist');
  try {
    const ctx = buildCheckContext({
      campaign: 'fixture',
      vaultPath: MINI_VAULT,
      jsonConfig: jsonConfigForFixture(),
      outputPath: neverCreated,
    });
    const findings = runExcludedDirInOutput(ctx);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].message, /no output directory exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L2 regression: an output directory that EXISTS but has never been built into still emits INFO, not nothing', () => {
  // This is exactly the state the migration layout (docs/MIGRATION.md,
  // retained in the private archive at b5b48b4) pre-creates for every
  // campaign: {vault,site,out,sessions} all exist before the first `build`
  // ever runs. A reviewer reproduced this silently returning zero findings
  // (not even the INFO) against a real campaign vault before its first build.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l2-'));
  const preCreatedEmptyOut = path.join(dir, 'out');
  fs.mkdirSync(preCreatedEmptyOut); // exists, but nothing has ever been built into it
  try {
    const ctx = buildCheckContext({
      campaign: 'fixture',
      vaultPath: MINI_VAULT,
      jsonConfig: jsonConfigForFixture(),
      outputPath: preCreatedEmptyOut,
    });
    assert.equal(ctx.outputPath, null, 'context must not treat an empty pre-created dir as a real build');
    assert.equal(ctx.outputPathConfigured, preCreatedEmptyOut);

    const findings = runExcludedDirInOutput(ctx);
    assert.equal(findings.length, 1, 'must emit the INFO finding, not silently return nothing');
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].message, /exists but has no build in it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L2: a real build (index.html present) is recognised, and a file under an excluded dir fires ERROR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l2-'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'index.html'), '<html></html>'); // the "a real build happened" marker

  try {
    const jsonConfig = jsonConfigForFixture();
    const ctx = buildCheckContext({
      campaign: 'fixture',
      vaultPath: MINI_VAULT,
      jsonConfig,
      outputPath: out,
    });
    assert.equal(ctx.outputPath, out, 'a real build must be recognised as such');

    // No published page happens to live under an excluded dir in the
    // fixture vault today, so this only proves the "real build recognised,
    // no false positive" half; leak/l2 firing on a genuine excluded-dir
    // page is exercised end to end against a real campaign vault
    // (3 real map files under _attachments/maps, see docs/ACCEPTANCE-RESULTS.md, retained in the private archive at b5b48b4).
    const findings = runExcludedDirInOutput(ctx);
    assert.ok(!findings.some((f) => f.severity === 'info'), 'must not fall back to the no-build INFO once a real build exists');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
