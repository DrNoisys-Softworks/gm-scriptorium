'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * ADR 0018 (P2-FR06): the config/pack-shadowed WARN, exercised end to end
 * (check/build/status) on a scratch copy of the fixture vault.
 */

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pack-shadowed-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

/** Both the legacy site dir and the vault's convention pack get the SAME object (vaultPath/outputDir stripped): these tests exercise resolution and the shadow finding, not build content. */
function baseSiteObject() {
  const cfg = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  delete cfg.vaultPath;
  delete cfg.outputDir;
  return cfg;
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function setupVaultAndConfigs(dir, { withPack, withSiteConfig }) {
  const vaultDir = path.join(dir, 'vault');
  fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
  let siteConfigPath = null;
  let packDir = null;
  if (withSiteConfig) {
    siteConfigPath = path.join(dir, 'site', 'vault.config.json');
    writeJson(siteConfigPath, baseSiteObject());
  }
  if (withPack) {
    packDir = path.join(vaultDir, '_meta', 'scriptorium');
    writeJson(path.join(packDir, 'vault.config.json'), baseSiteObject());
  }
  return { vaultDir, siteConfigPath, packDir };
}

function writeScratchConfig(configPath, { vault, siteConfig, output }) {
  const lines = ['config_version = 1', 'default_campaign = "fixture"', '', '[campaigns.fixture]', `vault = '${vault}'`];
  if (siteConfig) lines.push(`site_config = '${siteConfig}'`);
  lines.push(`output = '${output}'`);
  fs.writeFileSync(configPath, lines.join('\n'));
}

test('S1: legacy check() with a pack present gives exactly one config/pack-shadowed WARN', () => {
  withScratchDir((dir) => {
    const { vaultDir, siteConfigPath, packDir } = setupVaultAndConfigs(dir, { withPack: true, withSiteConfig: true });
    const configPath = path.join(dir, 'config.toml');
    writeScratchConfig(configPath, { vault: vaultDir, siteConfig: siteConfigPath, output: path.join(dir, 'out') });

    const { runCheckCommand } = requireFresh('../src/cli/check');
    const result = runCheckCommand({ config: configPath }, 'fixture');

    const shadowed = result.envelope.findings.filter((f) => f.id === 'config/pack-shadowed');
    assert.equal(shadowed.length, 1);
    const f = shadowed[0];
    assert.equal(f.severity, 'warn');
    assert.equal(f.category, 'config');
    assert.equal(f.path, null);
    assert.deepEqual(f.data, { siteConfigPath: path.resolve(siteConfigPath), packDir, packSource: 'convention' });
    assert.ok(f.message.includes(path.resolve(siteConfigPath)) && f.message.includes(packDir));
    assert.ok(result.human.includes(path.resolve(siteConfigPath)) && result.human.includes(packDir));
  });
});

test('S2: pack mode and legacy-without-pack each give zero config/pack-shadowed findings', () => {
  withScratchDir((dir) => {
    const packOnly = setupVaultAndConfigs(dir, { withPack: true, withSiteConfig: false });
    const packConfigPath = path.join(dir, 'pack-config.toml');
    writeScratchConfig(packConfigPath, { vault: packOnly.vaultDir, output: path.join(dir, 'pack-out') });

    const { runCheckCommand } = requireFresh('../src/cli/check');
    const packResult = runCheckCommand({ config: packConfigPath }, 'fixture');
    assert.equal(packResult.envelope.findings.filter((f) => f.id === 'config/pack-shadowed').length, 0);
  });

  withScratchDir((dir) => {
    const legacyOnly = setupVaultAndConfigs(dir, { withPack: false, withSiteConfig: true });
    const legacyConfigPath = path.join(dir, 'legacy-config.toml');
    writeScratchConfig(legacyConfigPath, {
      vault: legacyOnly.vaultDir,
      siteConfig: legacyOnly.siteConfigPath,
      output: path.join(dir, 'legacy-out'),
    });

    const { runCheckCommand } = requireFresh('../src/cli/check');
    const legacyResult = runCheckCommand({ config: legacyConfigPath }, 'fixture');
    assert.equal(legacyResult.envelope.findings.filter((f) => f.id === 'config/pack-shadowed').length, 0);
  });
});

test('S3: build() in legacy-plus-pack mode prints a note: line, and the envelope carries no packShadowed key', () => {
  withScratchDir((dir) => {
    const { vaultDir, siteConfigPath, packDir } = setupVaultAndConfigs(dir, { withPack: true, withSiteConfig: true });
    const configPath = path.join(dir, 'config.toml');
    const outDir = path.join(dir, 'out');
    writeScratchConfig(configPath, { vault: vaultDir, siteConfig: siteConfigPath, output: outDir });

    const { runBuildCommand } = requireFresh('../src/cli/build');
    const result = runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'fixture');

    assert.ok(result.human.includes(path.resolve(siteConfigPath)) && result.human.includes(packDir));
    assert.match(result.human, /note: /);
    assert.equal(Object.prototype.hasOwnProperty.call(result.envelope, 'packShadowed'), false);
  });
});

test('S4: status() prints the note: line in legacy-plus-pack mode, and never names the pack dir in pack mode', () => {
  withScratchDir((dir) => {
    const { vaultDir, siteConfigPath, packDir } = setupVaultAndConfigs(dir, { withPack: true, withSiteConfig: true });
    const configPath = path.join(dir, 'config.toml');
    writeScratchConfig(configPath, { vault: vaultDir, siteConfig: siteConfigPath, output: path.join(dir, 'out') });

    const { runStatusCommand } = requireFresh('../src/cli/status');
    const result = runStatusCommand({ config: configPath }, 'fixture');
    assert.ok(result.human.includes(path.resolve(siteConfigPath)) && result.human.includes(packDir));
    assert.match(result.human, /note: /);
  });

  withScratchDir((dir) => {
    const packOnly = setupVaultAndConfigs(dir, { withPack: true, withSiteConfig: false });
    const packConfigPath = path.join(dir, 'pack-config.toml');
    writeScratchConfig(packConfigPath, { vault: packOnly.vaultDir, output: path.join(dir, 'out') });

    const { runStatusCommand } = requireFresh('../src/cli/status');
    const result = runStatusCommand({ config: packConfigPath }, 'fixture');
    assert.ok(!result.human.includes(packOnly.packDir));
  });
});

test('S5: the registry entry and RUNNERS wiring for config/pack-shadowed', () => {
  const { getCheck } = require('../src/checks/registry');
  const { RUNNERS } = require('../src/checks/run');
  const configdiv = require('../src/checks/configdiv');
  const check = getCheck('config/pack-shadowed');
  assert.equal(check.category, 'config');
  assert.equal(check.defaultSeverity, 'warn');
  assert.equal(check.defaultEnabled, true);
  assert.equal(check.requiresFlag, null);
  assert.equal(RUNNERS['config/pack-shadowed'], configdiv.runPackShadowed);
});
