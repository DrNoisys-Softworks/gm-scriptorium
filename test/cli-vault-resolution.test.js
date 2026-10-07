'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vault-resolution-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** resolveCampaign's profile matching reads SCRIPTORIUM_PROFILE directly (resolve.js:57); force it off so these tests exercise the real platform/hostname match logic regardless of what the ambient shell happens to have set. */
function withCleanProfileEnv(fn) {
  const saved = process.env.SCRIPTORIUM_PROFILE;
  delete process.env.SCRIPTORIUM_PROFILE;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.SCRIPTORIUM_PROFILE;
    else process.env.SCRIPTORIUM_PROFILE = saved;
  }
}

function writeSiteConfig(dir, name, mutate) {
  const cfg = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  mutate(cfg);
  const configPath = path.join(dir, name);
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return configPath;
}

function writeScratchConfig(configPath, { vault, siteConfig, output }) {
  const toml = [
    'config_version = 1',
    'default_campaign = "fixture"',
    '',
    '[campaigns.fixture]',
    `vault = '${vault}'`,
    `site_config = '${siteConfig}'`,
    `output = '${output}'`,
  ].join('\n');
  fs.writeFileSync(configPath, toml);
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test('check reads the resolved vault when the site config vaultPath points elsewhere, and reports the mismatch', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      fs.mkdirSync(path.join(dir, 'decoy-vault'));
      const decoySiteConfigPath = writeSiteConfig(dir, 'decoy-site-config.json', (c) => {
        c.vaultPath = 'decoy-vault';
      });

      const configPath = path.join(dir, 'config.toml');
      writeScratchConfig(configPath, { vault: MINI_VAULT, siteConfig: decoySiteConfigPath, output: path.join(dir, 'out') });

      const { runCheckCommand } = requireFresh('../src/cli/check');
      const result = runCheckCommand({ config: configPath }, 'fixture');

      assert.equal(result.envelope.vaultPath, MINI_VAULT);

      const parseErrors = result.envelope.findings.filter((f) => f.id === 'frontmatter/parse-error');
      assert.equal(parseErrors.length, 1);
      assert.equal(parseErrors[0].path, 'Characters/NPCs/broken-frontmatter.md');

      const mismatches = result.envelope.findings.filter((f) => f.id === 'config/site-vault-path-mismatch');
      assert.equal(mismatches.length, 1);
      assert.equal(mismatches[0].severity, 'warn');
      assert.equal(mismatches[0].path, null);
      assert.deepEqual(mismatches[0].data, {
        siteConfigPath: path.resolve(decoySiteConfigPath),
        siteConfigVaultPath: path.join(dir, 'decoy-vault'),
        resolvedVaultPath: MINI_VAULT,
        used: 'resolved',
      });
      assert.ok(result.human.includes(path.resolve(decoySiteConfigPath)));
      assert.ok(result.human.includes(MINI_VAULT));

      const fixtureConfigPath = path.join(dir, 'config-fixture.toml');
      writeScratchConfig(fixtureConfigPath, { vault: MINI_VAULT, siteConfig: SITE_CONFIG_SRC, output: path.join(dir, 'out2') });
      const { runCheckCommand: runCheckCommand2 } = requireFresh('../src/cli/check');
      const fixtureResult = runCheckCommand2({ config: fixtureConfigPath }, 'fixture');

      assert.equal(result.exitCode, fixtureResult.exitCode);
    });
  });
});

test('check with a site config that has no vaultPath reads the resolved vault and reports nothing', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      const noVaultSiteConfigPath = writeSiteConfig(dir, 'no-vault-site-config.json', (c) => {
        delete c.vaultPath;
      });

      const configPath = path.join(dir, 'config.toml');
      writeScratchConfig(configPath, { vault: MINI_VAULT, siteConfig: noVaultSiteConfigPath, output: path.join(dir, 'out') });

      const { runCheckCommand } = requireFresh('../src/cli/check');
      const result = runCheckCommand({ config: configPath }, 'fixture');

      assert.equal(result.envelope.vaultPath, MINI_VAULT);
      assert.equal(result.envelope.findings.filter((f) => f.id === 'config/site-vault-path-mismatch').length, 0);
      assert.equal(result.envelope.findings.filter((f) => f.id === 'frontmatter/parse-error').length, 1);
    });
  });
});

test('a site config vaultPath naming the same directory is not a mismatch', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      const sameVaultSiteConfigPath = writeSiteConfig(dir, 'same-vault-site-config.json', (c) => {
        c.vaultPath = MINI_VAULT + path.sep;
      });

      const configPath = path.join(dir, 'config.toml');
      writeScratchConfig(configPath, { vault: MINI_VAULT, siteConfig: sameVaultSiteConfigPath, output: path.join(dir, 'out') });

      const { runCheckCommand } = requireFresh('../src/cli/check');
      const result = runCheckCommand({ config: configPath }, 'fixture');

      assert.equal(result.envelope.vaultPath, MINI_VAULT);
      assert.equal(result.envelope.findings.filter((f) => f.id === 'config/site-vault-path-mismatch').length, 0);
    });
  });
});

test('the matched profile beats the campaign block, and --vault beats the profile', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      const decoySiteConfigPath = writeSiteConfig(dir, 'decoy-site-config.json', (c) => {
        c.vaultPath = 'decoy-vault';
      });
      fs.mkdirSync(path.join(dir, 'decoy-vault'));

      // Case (a): base vault is a nonexistent scratch path, the matched profile's vault is MINI_VAULT.
      const configPathA = path.join(dir, 'config-a.toml');
      const tomlA = [
        'config_version = 1',
        'default_campaign = "fixture"',
        '',
        '[campaigns.fixture]',
        `vault = '${path.join(dir, 'nonexistent-base')}'`,
        `site_config = '${decoySiteConfigPath}'`,
        `output = '${path.join(dir, 'out-a')}'`,
        '',
        '[campaigns.fixture.paths.here]',
        `match = { platform = "${process.platform}" }`,
        `vault = '${MINI_VAULT}'`,
      ].join('\n');
      fs.writeFileSync(configPathA, tomlA);

      const { runCheckCommand: runA } = requireFresh('../src/cli/check');
      const resultA = runA({ config: configPathA }, 'fixture');
      assert.equal(resultA.envelope.vaultPath, MINI_VAULT);

      // Case (b): the profile's vault is also nonexistent; --vault (a relative path) wins and comes out absolute.
      const configPathB = path.join(dir, 'config-b.toml');
      const tomlB = [
        'config_version = 1',
        'default_campaign = "fixture"',
        '',
        '[campaigns.fixture]',
        `vault = '${path.join(dir, 'nonexistent-base')}'`,
        `site_config = '${decoySiteConfigPath}'`,
        `output = '${path.join(dir, 'out-b')}'`,
        '',
        '[campaigns.fixture.paths.here]',
        `match = { platform = "${process.platform}" }`,
        `vault = '${path.join(dir, 'nonexistent-profile')}'`,
      ].join('\n');
      fs.writeFileSync(configPathB, tomlB);

      const relVault = path.relative(process.cwd(), MINI_VAULT);
      const { runCheckCommand: runB } = requireFresh('../src/cli/check');
      const resultB = runB({ config: configPathB, vault: relVault }, 'fixture');
      assert.equal(resultB.envelope.vaultPath, MINI_VAULT);
      assert.ok(path.isAbsolute(resultB.envelope.vaultPath));
    });
  });
});

test('status and build envelopes carry the resolved vault and the mismatch', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      fs.mkdirSync(path.join(dir, 'decoy-vault'));
      const decoySiteConfigPath = writeSiteConfig(dir, 'decoy-site-config.json', (c) => {
        c.vaultPath = 'decoy-vault';
      });

      const configPath = path.join(dir, 'config.toml');
      // Deliberately NOT the decoy site config's own default outputDir ("./out",
      // resolving to dir/out): that would accidentally trip
      // src/build/plan.js's siteConfigOutputDirCollision guard (issue #21,
      // defect 1) before this test's own mismatch assertions ever run.
      const outDir = path.join(dir, 'out-mismatch');
      writeScratchConfig(configPath, {
        vault: path.join(dir, 'nonexistent-toml-vault'),
        siteConfig: decoySiteConfigPath,
        output: outDir,
      });

      const expectedMismatch = {
        siteConfigPath: path.resolve(decoySiteConfigPath),
        siteConfigVaultPath: path.join(dir, 'decoy-vault'),
        resolvedVaultPath: MINI_VAULT,
        used: 'resolved',
      };

      const { runStatusCommand } = requireFresh('../src/cli/status');
      const statusResult = runStatusCommand({ config: configPath, vault: MINI_VAULT }, 'fixture');

      assert.equal(statusResult.envelope.vaultPath, MINI_VAULT);
      assert.deepEqual(statusResult.envelope.vaultMismatch, expectedMismatch);
      assert.match(statusResult.human, /note:/);
      assert.ok(statusResult.human.includes(path.resolve(decoySiteConfigPath)));
      assert.ok(statusResult.human.includes(MINI_VAULT));

      const { runBuildCommand } = requireFresh('../src/cli/build');
      const buildResult = runBuildCommand({ config: configPath, vault: MINI_VAULT }, 'fixture');

      assert.equal(buildResult.envelope.vaultPath, MINI_VAULT);
      assert.deepEqual(buildResult.envelope.vaultMismatch, expectedMismatch);
      assert.ok(buildResult.envelope.check.findings.some((f) => f.id === 'config/site-vault-path-mismatch'));
      assert.equal(fs.existsSync(outDir), false, 'a refused build must write nothing');

      const fixtureConfigPath = path.join(dir, 'config-fixture.toml');
      writeScratchConfig(fixtureConfigPath, { vault: MINI_VAULT, siteConfig: SITE_CONFIG_SRC, output: path.join(dir, 'out2') });

      const { runStatusCommand: runStatus2 } = requireFresh('../src/cli/status');
      const statusFixture = runStatus2({ config: fixtureConfigPath }, 'fixture');
      assert.equal(statusFixture.envelope.vaultMismatch, null);

      const { runBuildCommand: runBuild2 } = requireFresh('../src/cli/build');
      const buildFixture = runBuild2({ config: fixtureConfigPath }, 'fixture');
      assert.equal(buildFixture.envelope.vaultMismatch, null);
    });
  });
});

test('build --force with a mismatched site config builds the resolved vault', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      fs.mkdirSync(path.join(dir, 'decoy-vault'));
      const decoySiteConfigPath = writeSiteConfig(dir, 'decoy-site-config.json', (c) => {
        c.vaultPath = 'decoy-vault';
      });

      const fixtureConfigPath = path.join(dir, 'config-fixture.toml');
      const outFixture = path.join(dir, 'out-fixture');
      writeScratchConfig(fixtureConfigPath, { vault: MINI_VAULT, siteConfig: SITE_CONFIG_SRC, output: outFixture });

      const decoyConfigPath = path.join(dir, 'config-decoy.toml');
      const outDecoy = path.join(dir, 'out-decoy');
      writeScratchConfig(decoyConfigPath, { vault: MINI_VAULT, siteConfig: decoySiteConfigPath, output: outDecoy });

      const { runBuildCommand: runFixtureBuild } = requireFresh('../src/cli/build');
      const fixtureResult = runFixtureBuild({ config: fixtureConfigPath, force: true }, 'fixture');
      assert.equal(fixtureResult.envelope.ok, true);

      const { runBuildCommand: runDecoyBuild } = requireFresh('../src/cli/build');
      const decoyResult = runDecoyBuild({ config: decoyConfigPath, force: true }, 'fixture');
      assert.equal(decoyResult.envelope.ok, true);

      assert.equal(fixtureResult.envelope.pagesWritten, decoyResult.envelope.pagesWritten);
    });
  });
});

test('writeStagedConfig writes the passed vault, not the site config vaultPath', () => {
  withScratchDir((dir) => {
    const { writeStagedConfig } = require('../src/build/stage');
    const stagingRoot = path.join(dir, 'staging');
    const stagingOut = path.join(stagingRoot, 'out');

    const configPath = writeStagedConfig({ vaultPath: '/wrong', siteTitle: 'x' }, MINI_VAULT, stagingRoot, stagingOut);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    assert.equal(written.vaultPath, MINI_VAULT);
    assert.equal(written.siteTitle, 'x');
  });
});
