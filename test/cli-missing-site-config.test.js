'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ConfigError } = require('../src/util/errors');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * Issue #21, defect 3: a campaign registered with no `site_config` used to
 * throw a bare `Error` from src/cli/check.js:23, which bin/scriptorium.js's
 * generic catch-all prints with its full stack and exits 1. `check`,
 * `build`, and `status` all resolve the vault context through the same
 * `resolveVaultContext` (src/cli/check.js), so all three are covered here.
 *
 * ADR 0018 (P2-FR03) changed the message itself: a campaign with no
 * `site_config` may still have a site through the `pack` key or the
 * `<vault>/_meta/scriptorium/` convention, so the ConfigError now names all
 * three sources (E-NONE) rather than only site_config. Deliberate update;
 * the exit code and no-stack-trace assertions are unchanged.
 */

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-missing-site-config-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** No `site_config` key at all: distinct from an empty string, but both are falsy and hit the same guard. */
function writeConfigWithoutSiteConfig(configPath, { output }) {
  const toml = [
    'config_version = 1',
    'default_campaign = "fixture"',
    '',
    '[campaigns.fixture]',
    `vault = '${MINI_VAULT}'`,
    `output = '${output}'`,
  ].join('\n');
  fs.writeFileSync(configPath, toml);
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

/** E-NONE (docs/decisions/0018-campaign-pack.md): stated independently of src/cli/check.js. */
function expectedENone() {
  return (
    `campaign "fixture" has no site config: site_config is not set, pack is not set, and ` +
    `${path.join(MINI_VAULT, '_meta', 'scriptorium', 'vault.config.json')} does not exist.${' Run "gm-scriptorium init" to create one, or set site_config or pack on the campaign.'}`
  );
}

test('loadSiteConfig throws VaultUnreachableError (exit 3, #108), not a bare Error, when siteConfigPath is falsy', () => {
  const { loadSiteConfig } = requireFresh('../src/cli/check');
  assert.throws(
    () => loadSiteConfig(undefined),
    (err) => err.name === 'VaultUnreachableError' && err.message.startsWith('campaign has no site_config configured. Set site_config'),
  );
  assert.throws(
    () => loadSiteConfig(''),
    (err) => err.name === 'VaultUnreachableError' && err.message.startsWith('campaign has no site_config configured. Set site_config'),
  );
});

test('check on a campaign with no site_config raises a VaultUnreachableError (exit 3, #108)', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    writeConfigWithoutSiteConfig(configPath, { output: path.join(dir, 'out') });

    const { runCheckCommand } = requireFresh('../src/cli/check');
    const expected = expectedENone();
    assert.throws(
      () => runCheckCommand({ config: configPath }, 'fixture'),
      (err) => err.name === 'VaultUnreachableError' && err.message === expected,
    );
  });
});

test('build on a campaign with no site_config raises a VaultUnreachableError and writes nothing', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    const outDir = path.join(dir, 'out');
    writeConfigWithoutSiteConfig(configPath, { output: outDir });

    const { runBuildCommand } = requireFresh('../src/cli/build');
    const expected = expectedENone();
    assert.throws(
      () => runBuildCommand({ config: configPath }, 'fixture'),
      (err) => err.name === 'VaultUnreachableError' && err.message === expected,
    );
    assert.equal(fs.existsSync(outDir), false, 'nothing should be written before the vault context even resolves');
  });
});

test('status on a campaign with no site_config reports exit 3 with the message (#108)', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    writeConfigWithoutSiteConfig(configPath, { output: path.join(dir, 'out') });

    const { runStatusCommand } = requireFresh('../src/cli/status');
    const expected = expectedENone();
    const result = runStatusCommand({ config: configPath }, 'fixture');
    assert.equal(result.exitCode, 3);
    assert.ok(result.human.includes(expected), result.human);
  });
});

test('CLI: check on a campaign with no site_config prints one clean line, no stack trace, exit 3 (#108)', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    writeConfigWithoutSiteConfig(configPath, { output: path.join(dir, 'out') });

    let stderr = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [BIN, 'check', 'fixture', '--config', configPath], { stdio: 'pipe' });
    } catch (err) {
      stderr = err.stderr.toString('utf8');
      status = err.status;
    }

    assert.equal(status, EXIT_CODES.VAULT_UNREACHABLE);
    assert.equal(stderr.trim(), expectedENone());
    assert.ok(!stderr.includes('    at '), 'must not print a stack trace for a user config error');
  });
});
