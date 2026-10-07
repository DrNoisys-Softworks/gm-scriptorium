'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * Issue #21, defect 1: a build whose resolved output equals the site
 * config's own `outputDir` must refuse by default (overridable by
 * --force), because that directory is sometimes a frozen baseline another
 * process owns. It must NOT refuse a legitimate, deliberately different
 * output dir — a guard that cries wolf on ordinary setups gets disabled.
 */

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-site-output-collision-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A copy of the fixture site config, with its own outputDir pointed at a scratch-local "./out" (relative to the copy's own directory), so tests never write into the repo's test/fixtures tree. */
function writeSiteConfig(dir) {
  const cfg = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  cfg.vaultPath = MINI_VAULT;
  cfg.outputDir = './out';
  const configPath = path.join(dir, 'site-config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return configPath;
}

function writeScratchConfig(configPath, { siteConfig, output }) {
  const toml = [
    'config_version = 1',
    'default_campaign = "fixture"',
    '',
    '[campaigns.fixture]',
    `vault = '${MINI_VAULT}'`,
    `site_config = '${siteConfig}'`,
    `output = '${output}'`,
  ].join('\n');
  fs.writeFileSync(configPath, toml);
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test('build refuses (exit 2, writes nothing) when the resolved output equals the site config\'s own outputDir', () => {
  withScratchDir((dir) => {
    const siteConfigPath = writeSiteConfig(dir);
    const collisionOut = path.join(dir, 'out'); // matches site-config.json's "./out"
    const configPath = path.join(dir, 'config.toml');
    writeScratchConfig(configPath, { siteConfig: siteConfigPath, output: collisionOut });

    const { runBuildCommand } = requireFresh('../src/cli/build');
    const result = runBuildCommand({ config: configPath }, 'fixture');

    assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.refused, true);
    assert.equal(result.envelope.siteOutputDirCollision, path.resolve(collisionOut));
    assert.match(result.human, /refusing to build.*outputDir/s);
    assert.equal(fs.existsSync(collisionOut), false, 'a refused build must write nothing');
  });
});

test('build --force proceeds into the site config\'s own outputDir and says so', () => {
  withScratchDir((dir) => {
    const siteConfigPath = writeSiteConfig(dir);
    const collisionOut = path.join(dir, 'out');
    const configPath = path.join(dir, 'config.toml');
    writeScratchConfig(configPath, { siteConfig: siteConfigPath, output: collisionOut });

    const { runBuildCommand } = requireFresh('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true }, 'fixture');

    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(result.envelope.ok, true);
    assert.match(result.human, /--force: building into the site config's own outputDir/);
    assert.equal(fs.existsSync(collisionOut), true);
  });
});

test('build does NOT refuse a legitimate output dir that differs from the site config\'s own outputDir', () => {
  withScratchDir((dir) => {
    const siteConfigPath = writeSiteConfig(dir);
    const legitimateOut = path.join(dir, 'somewhere-else'); // does not match site-config.json's "./out"
    const configPath = path.join(dir, 'config.toml');
    writeScratchConfig(configPath, { siteConfig: siteConfigPath, output: legitimateOut });

    const { runBuildCommand } = requireFresh('../src/cli/build');
    // --force here only overrides the fixture's real content findings (frontmatter/link
    // errors baked into mini-vault), not the collision guard — it must never fire at all.
    const result = runBuildCommand({ config: configPath, force: true }, 'fixture');

    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.siteOutputDirCollision, undefined);
    assert.ok(!result.human.includes('collision guard'), 'the guard must not mention itself when it never fired');
    assert.equal(fs.existsSync(legitimateOut), true);
    // the sibling directory the site config's own outputDir names must be untouched
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  });
});

test('build does not refuse when the site config has no outputDir field at all', () => {
  withScratchDir((dir) => {
    const cfg = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
    cfg.vaultPath = MINI_VAULT;
    delete cfg.outputDir;
    const siteConfigPath = path.join(dir, 'site-config-no-outputdir.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify(cfg, null, 2));

    const out = path.join(dir, 'out');
    const configPath = path.join(dir, 'config.toml');
    writeScratchConfig(configPath, { siteConfig: siteConfigPath, output: out });

    const { runBuildCommand } = requireFresh('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true }, 'fixture');

    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(result.envelope.siteOutputDirCollision, undefined);
  });
});

// ADR 0018, D-06: the collision guard is unchanged by resolution source. A
// pack's own outputDir is pack-relative (no special handling), so it can
// still collide with the resolved output and still needs --force.

test('C1 (D-06): a pack-relative outputDir still collides with the same guard, and refuses without --force', () => {
  withScratchDir((dir) => {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
    delete cfg.vaultPath;
    cfg.outputDir = '../../../out';
    const packDir = path.join(vaultDir, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify(cfg, null, 2));

    const outDir = path.join(dir, 'out');
    const configPath = path.join(dir, 'config.toml');
    const toml = [
      'config_version = 1',
      'default_campaign = "fixture"',
      '',
      '[campaigns.fixture]',
      `vault = '${vaultDir}'`,
      `output = '${outDir}'`,
    ].join('\n');
    fs.writeFileSync(configPath, toml);

    const { runBuildCommand } = requireFresh('../src/cli/build');
    const result = runBuildCommand({ config: configPath }, 'fixture');

    assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(result.envelope.refused, true);
    assert.equal(result.envelope.siteOutputDirCollision, path.join(dir, 'out'));
    assert.match(result.human, /refusing to build.*outputDir/s);
    assert.equal(fs.existsSync(outDir), false);
  });
});
