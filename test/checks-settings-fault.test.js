'use strict';

/*
 * config/settings-fault: from publish-v1.26.0 the pinned build refuses to run when a hiding
 * setting cannot be read (lib/config.js assertNoStops), because its safe fallback might not be what
 * the GM meant. `check` reports each such fault as an ERROR, with the pin's own words, so the GM
 * hears it from `check` and a `build` stops at its check step rather than inside the generator.
 * Expected texts are typed by hand from lib/settings/faults.js's formatFault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function withScratch(publishBlock, siteExtra, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-hiding-fault-'));
  try {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), `---\ntype: meta\npublish:\n${publishBlock}\n---\n\nnotes\n`);
    const site = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
    delete site.vaultPath;
    delete site.outputDir;
    const siteConfigPath = path.join(dir, 'site', 'vault.config.json');
    fs.mkdirSync(path.dirname(siteConfigPath), { recursive: true });
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...site, ...siteExtra }, null, 2));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      'config_version = 1', 'default_campaign = "fixture"', '', '[campaigns.fixture]',
      `vault = '${vaultDir}'`, `site_config = '${siteConfigPath}'`, `output = '${path.join(dir, 'out')}'`,
    ].join('\n'));
    return fn({ configPath, outDir: path.join(dir, 'out') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const faultsOf = (result) => result.envelope.findings.filter((f) => f.id === 'config/settings-fault');

test('a misspelt hiding setting is an ERROR naming the setting it meant, and check fails', () => {
  withScratch('  mode: player\n  exclude_sectoins:\n    - GM Notes', {}, ({ configPath }) => {
    const { runCheckCommand } = requireFresh('../src/cli/check');
    const result = runCheckCommand({ config: configPath }, 'fixture');
    const found = faultsOf(result);
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'error');
    assert.equal(found[0].category, 'config');
    assert.equal(found[0].path, '_meta/vault-config.md');
    assert.equal(
      found[0].message,
      'publish.exclude_sectoins is not a setting. Did you mean publish.exclude_sections? The build will not run until this is fixed.',
    );
    assert.equal(result.exitCode, 2);
  });
});

test('`exclude_drafts: maybe` and `mode: gm` are each an ERROR', () => {
  withScratch('  mode: gm\n  exclude_drafts: maybe', {}, ({ configPath }) => {
    const { runCheckCommand } = requireFresh('../src/cli/check');
    const messages = faultsOf(runCheckCommand({ config: configPath }, 'fixture')).map((f) => f.message).sort();
    assert.deepEqual(messages, [
      'publish.exclude_drafts is "maybe"; it takes on or off (yes, no, true and false work too). The build will not run until this is fixed.',
      'publish.mode is "gm"; it takes player or full. The build will not run until this is fixed.',
    ]);
  });
});

test('a fault in the site file\'s hiding list points at no vault file', () => {
  withScratch('  mode: player', { excludeSections: 'GM Notes' }, ({ configPath }) => {
    const { runCheckCommand } = requireFresh('../src/cli/check');
    const found = faultsOf(runCheckCommand({ config: configPath }, 'fixture'));
    assert.equal(found.length, 1);
    assert.equal(found[0].path, null);
    assert.match(found[0].message, /^excludeSections in the site folder's vault\.config\.json is "GM Notes"; it takes a list of headings\./);
  });
});

test('`exclude_callouts: no` is no fault, and nothing is reported for a clean vault', () => {
  withScratch('  mode: player\n  exclude_callouts: "no"\n  exclude_sections:\n    - GM Notes', {}, ({ configPath }) => {
    const { runCheckCommand } = requireFresh('../src/cli/check');
    assert.equal(faultsOf(runCheckCommand({ config: configPath }, 'fixture')).length, 0);
  });
});

test('a build stops at its check step with the same reason, and writes nothing', () => {
  withScratch('  mode: player\n  exclude_sectoins:\n    - GM Notes', {}, ({ configPath, outDir }) => {
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const result = runBuildCommand({ config: configPath }, 'fixture');
    assert.equal(result.exitCode, 2);
    assert.match(result.human, /publish\.exclude_sectoins is not a setting\. Did you mean publish\.exclude_sections\?/);
    assert.equal(fs.existsSync(outDir), false);
  });
});

test('a malformed folders-to-keep list is an ERROR too (the build refuses, though it hides nothing)', () => {
  withScratch('  mode: player', { preserveDirs: ['maps/old'] }, ({ configPath }) => {
    const { runCheckCommand } = requireFresh('../src/cli/check');
    const result = runCheckCommand({ config: configPath }, 'fixture');
    const found = faultsOf(result);
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'error');
    assert.equal(result.exitCode, 2);
  });
});
