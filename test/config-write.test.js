'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./helpers/toml-plain');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serializeConfig, addCampaign, removeCampaign, setDefaultCampaign, assertConfigPathNotInVault } = require('../src/config/write');
const { parseConfig } = require('../src/config/load');
const { runConfigCommand } = require('../src/cli/config');
const { ConfigError, VaultUnreachableError } = require('../src/util/errors');

test('addCampaign registers a campaign and sets it as default if none was set', () => {
  const config = { config_version: 1, campaigns: {} };
  const next = addCampaign(config, 'example', { vault: '/v', output: '/o', siteConfig: '/s' });
  assert.equal(next.campaigns.example.vault, '/v');
  assert.equal(next.default_campaign, 'example');
  assert.deepEqual(config.campaigns, {}); // does not mutate the input
});

test('removeCampaign deregisters and clears default_campaign if it pointed there, never touches other data', () => {
  const config = {
    config_version: 1,
    default_campaign: 'a',
    campaigns: { a: { vault: '/a' }, b: { vault: '/b' } },
  };
  const next = removeCampaign(config, 'a');
  assert.deepEqual(Object.keys(next.campaigns), ['b']);
  assert.equal(next.default_campaign, undefined);
  assert.deepEqual(config.campaigns.a.vault, '/a'); // input untouched
});

test('removeCampaign throws for an unknown campaign rather than silently no-op', () => {
  assert.throws(() => removeCampaign({ campaigns: {} }, 'nope'), VaultUnreachableError);
});

test('setDefaultCampaign throws for an unknown campaign', () => {
  assert.throws(() => setDefaultCampaign({ campaigns: {} }, 'nope'), VaultUnreachableError);
});

test('serializeConfig round-trips through parseConfig with the same effective content', () => {
  const config = {
    config_version: 1,
    default_campaign: 'example',
    campaigns: {
      example: {
        vault: 'D:\\Campaigns\\vault',
        site_config: 'D:\\Campaigns\\site.json',
        output: 'D:\\Campaigns\\out',
        serve_port: 8080,
        paths: { 'win-desktop': { match: { platform: 'win32' } } },
      },
    },
  };
  const text = serializeConfig(config);
  const { config: reparsed, warnings } = parseConfig(text);
  assert.deepEqual(warnings, []);
  assert.equal(reparsed.campaigns.example.vault, 'D:\\Campaigns\\vault');
  assert.equal(reparsed.campaigns.example.serve_port, 8080);
  assert.deepEqual(plain(reparsed.campaigns.example.paths['win-desktop'].match), { platform: 'win32' });
});

test('serializeConfig preserves an unknown top-level key across a round trip', () => {
  const config = { config_version: 1, campaigns: {}, update_channel: 'beta' };
  const text = serializeConfig(config);
  const { config: reparsed } = parseConfig(text);
  assert.equal(reparsed.update_channel, 'beta');
});

test('serializeConfig emits campaign keys in the fixed order (vault, site_config, output, serve_port)', () => {
  const config = {
    config_version: 1,
    campaigns: { x: { serve_port: 1, vault: 'v', output: 'o', site_config: 's' } },
  };
  const text = serializeConfig(config);
  const vaultLine = text.indexOf('vault');
  const siteLine = text.indexOf('site_config');
  const outputLine = text.indexOf('output');
  const portLine = text.indexOf('serve_port');
  assert.ok(vaultLine < siteLine && siteLine < outputLine && outputLine < portLine);
});

test('assertConfigPathNotInVault refuses a config path inside a registered vault', () => {
  const config = { campaigns: { example: { vault: '/srv/user/vault' } } };
  assert.throws(() => assertConfigPathNotInVault('/srv/user/vault/config.toml', config), ConfigError);
  assert.doesNotThrow(() => assertConfigPathNotInVault('/srv/user/elsewhere/config.toml', config));
});

// ADR 0018 (P2-FR01): "pack" serializes between "output" and "serve_port",
// and a config with no "pack" at all is untouched byte for byte.

test('W1: a config with no "pack" (site_config, output, serve_port, an unknown key, a profile) serializes to a hand-typed literal', () => {
  const config = {
    config_version: 1,
    campaigns: {
      alpha: {
        vault: 'v',
        site_config: 's',
        output: 'o',
        serve_port: 1234,
        notes: 'scratch',
        paths: { z: { match: { platform: 'linux' } } },
      },
    },
  };
  const text = serializeConfig(config);
  const expected = [
    '# Scriptorium config.',
    '#',
    '# Hand-editable TOML. Rewritten by "config add" / "config remove" /',
    '# "config set-default" using a canonical emitter: fixed key order, this',
    '# header regenerated each time. Comments you add elsewhere in this file',
    '# will NOT survive the next rewrite; unrecognised keys will.',
    '#',
    '# [campaigns.<name>.paths.<profile>] tables are per-machine overrides.',
    '# See docs/decisions for the resolution rules (platform/hostname match,',
    '# specificity, --vault/--out overrides, SCRIPTORIUM_PROFILE).',
    '',
    'config_version = 1',
    '',
    '[campaigns.alpha]',
    'vault = "v"',
    'site_config = "s"',
    'output = "o"',
    'serve_port = 1234',
    'notes = "scratch"',
    '',
    '[campaigns.alpha.paths.z.match]',
    'platform = "linux"',
    '',
    '',
  ].join('\n');
  assert.equal(text, expected);
});

test('W2: with "pack", key order is vault < site_config < output < pack < serve_port, and it round-trips with warnings []', () => {
  const config = {
    config_version: 1,
    campaigns: {
      alpha: {
        serve_port: 1,
        vault: 'v',
        output: 'o',
        site_config: 's',
        pack: 'p',
      },
    },
  };
  const text = serializeConfig(config);
  const vaultIdx = text.indexOf('vault');
  const siteIdx = text.indexOf('site_config');
  const outputIdx = text.indexOf('output');
  const packIdx = text.indexOf('pack');
  const portIdx = text.indexOf('serve_port');
  assert.ok(
    vaultIdx < siteIdx && siteIdx < outputIdx && outputIdx < packIdx && packIdx < portIdx,
    `expected vault < site_config < output < pack < serve_port, got indices ${JSON.stringify({ vaultIdx, siteIdx, outputIdx, packIdx, portIdx })}`,
  );
  const { config: reparsed, warnings } = parseConfig(text);
  assert.deepEqual(warnings, []);
  assert.equal(reparsed.campaigns.alpha.pack, 'p');
});

// ADR 0021, Structural decision 7 ("undefined means keep"): addCampaign
// previously assigned site_config/output even when the caller passed
// undefined, and orderCampaign then dropped the now-undefined key. This is
// the fix, plus its effect on `config add` re-adding an already-registered
// campaign (A2 of the orchestrator addendum).

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-config-write-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('R1: addCampaign without siteConfig or output keeps site_config, output, pack, serve_port, paths and an unknown key', () => {
  const config = {
    config_version: 1,
    campaigns: {
      alpha: {
        vault: '/old-vault',
        site_config: '/s',
        output: '/o',
        pack: '/p',
        serve_port: 8123,
        notes: 'keep me',
        paths: { z: { match: { platform: 'linux' } } },
      },
    },
  };
  const next = addCampaign(config, 'alpha', { vault: '/new-vault', output: undefined, siteConfig: undefined });
  assert.deepEqual(next.campaigns.alpha, {
    vault: '/new-vault',
    site_config: '/s',
    output: '/o',
    pack: '/p',
    serve_port: 8123,
    notes: 'keep me',
    paths: { z: { match: { platform: 'linux' } } },
  });
});

test('R2: a given siteConfig is still set', () => {
  const config = { config_version: 1, campaigns: { alpha: { vault: '/v', site_config: '/old-s' } } };
  const next = addCampaign(config, 'alpha', { vault: '/v', output: undefined, siteConfig: '/new-s' });
  assert.equal(next.campaigns.alpha.site_config, '/new-s');
});

test('R3: an already-set default_campaign is kept', () => {
  const config = {
    config_version: 1,
    default_campaign: 'beta',
    campaigns: { alpha: { vault: '/v' }, beta: { vault: '/v2' } },
  };
  const next = addCampaign(config, 'alpha', { vault: '/v', output: undefined, siteConfig: undefined });
  assert.equal(next.default_campaign, 'beta');
});

test('R4: runConfigCommand("add") on an existing campaign keeps its output and site_config', () => {
  withScratchDir((dir) => {
    const configPath = path.join(dir, 'config.toml');
    const toml = [
      'config_version = 1',
      '',
      '[campaigns.alpha]',
      "vault = '/old-vault'",
      "site_config = '/s'",
      "output = '/o'",
      '',
    ].join('\n');
    fs.writeFileSync(configPath, toml);

    const result = runConfigCommand({ config: configPath, vault: '/new-vault' }, 'add', ['alpha']);
    assert.equal(result.exitCode, 0);

    const { config: reparsed } = parseConfig(fs.readFileSync(configPath, 'utf8'));
    assert.equal(reparsed.campaigns.alpha.vault, '/new-vault');
    assert.equal(reparsed.campaigns.alpha.output, '/o');
    assert.equal(reparsed.campaigns.alpha.site_config, '/s');
  });
});
