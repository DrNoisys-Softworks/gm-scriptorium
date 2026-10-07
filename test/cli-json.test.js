'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');

function writeScratchConfig(configPath, { output }) {
  const toml = [
    'config_version = 1',
    'default_campaign = "fixture"',
    '',
    '[campaigns.fixture]',
    `vault = '${MINI_VAULT}'`,
    `site_config = '${SITE_CONFIG_SRC}'`,
    `output = '${output}'`,
  ].join('\n');
  fs.writeFileSync(configPath, toml);
}

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cli-json-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('status --json produces a schemaVersion envelope, deterministic aside from generatedAt', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    const outDir = path.join(dir, 'out');
    writeScratchConfig(configPath, { output: outDir });

    delete require.cache[require.resolve('../src/cli/status')];
    const { runStatusCommand } = require('../src/cli/status');

    const a = runStatusCommand({ config: configPath }, 'fixture');
    const b = runStatusCommand({ config: configPath }, 'fixture');

    assert.equal(a.envelope.schemaVersion, 1);
    assert.equal(a.envelope.campaign, 'fixture');
    assert.equal(a.envelope.reachable, true);
    assert.ok('counts' in a.envelope);
    assert.ok('checkVerdict' in a.envelope);

    const { generatedAt: ga, ...restA } = a.envelope;
    const { generatedAt: gb, ...restB } = b.envelope;
    assert.deepEqual(restA, restB);
  });
});

test('status --json with no campaign argument lists every registered campaign', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    writeScratchConfig(configPath, { output: path.join(dir, 'out') });

    delete require.cache[require.resolve('../src/cli/status')];
    const { runStatusCommand } = require('../src/cli/status');
    const result = runStatusCommand({ config: configPath });

    assert.equal(result.envelope.schemaVersion, 1);
    assert.equal(result.envelope.campaigns.length, 1);
    assert.equal(result.envelope.campaigns[0].campaign, 'fixture');
    assert.equal(result.envelope.campaigns[0].reachable, true);
  });
});

test('build --json embeds the full check envelope and refuses with exit 2 on the fixture\'s real errors', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    const outDir = path.join(dir, 'out');
    writeScratchConfig(configPath, { output: outDir });

    delete require.cache[require.resolve('../src/cli/build')];
    const { runBuildCommand } = require('../src/cli/build');
    const result = runBuildCommand({ config: configPath }, 'fixture');

    assert.equal(result.envelope.schemaVersion, 1);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.refused, true);
    assert.ok(result.envelope.check, 'check envelope must be embedded');
    assert.ok(result.envelope.check.counts.error > 0, 'the fixture has real frontmatter/link errors');
    assert.equal(fs.existsSync(outDir), false, 'a refused build must write nothing');
  });
});

test('build --json --force reports ok:true, the overridden findings, and stable fields across two runs', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    const outDir = path.join(dir, 'out');
    writeScratchConfig(configPath, { output: outDir });

    delete require.cache[require.resolve('../src/cli/build')];
    const { runBuildCommand } = require('../src/cli/build');

    const a = runBuildCommand({ config: configPath, force: true }, 'fixture');
    assert.equal(a.envelope.ok, true);
    assert.equal(a.envelope.forced, true);
    assert.ok(a.envelope.overriddenFindings.length > 0);
    assert.equal(typeof a.envelope.pagesWritten, 'number');

    const b = runBuildCommand({ config: configPath, force: true }, 'fixture');
    assert.equal(a.envelope.pagesWritten, b.envelope.pagesWritten, 'rebuilding unchanged content must write the same file count');
  });
});
