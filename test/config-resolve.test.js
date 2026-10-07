'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCampaign, resolveCampaignName, listCampaigns } = require('../src/config/resolve');
const { ConfigError, VaultUnreachableError } = require('../src/util/errors');

const CONFIG = {
  config_version: 1,
  default_campaign: 'example',
  campaigns: {
    example: {
      vault: 'D:\\Campaigns\\example\\vault',
      site_config: 'D:\\Campaigns\\example\\site\\vault.config.json',
      output: 'D:\\Campaigns\\example\\out',
      serve_port: 8080,
      paths: {
        'win-desktop': { match: { platform: 'win32' } },
        'linux-hub': {
          match: { platform: 'linux', hostname: 'hub' },
          vault: '/srv/campaigns/example/vault',
        },
        'linux-generic': { match: { platform: 'linux' }, vault: '/srv/generic/vault' },
      },
    },
  },
};

test('base resolution with no matching profile falls through to the campaign block', () => {
  const resolved = resolveCampaign(CONFIG, 'example', { platform: 'darwin', hostname: 'macbook' });
  assert.equal(resolved.vault, 'D:\\Campaigns\\example\\vault');
  assert.equal(resolved.profile, null);
});

test('platform-only match wins when no more specific profile matches', () => {
  const resolved = resolveCampaign(CONFIG, 'example', { platform: 'win32', hostname: 'anything' });
  assert.equal(resolved.profile, 'win-desktop');
  assert.equal(resolved.vault, 'D:\\Campaigns\\example\\vault'); // win-desktop overrides no keys, falls through
});

test('platform+hostname beats platform alone (specificity)', () => {
  const resolved = resolveCampaign(CONFIG, 'example', { platform: 'linux', hostname: 'hub' });
  assert.equal(resolved.profile, 'linux-hub');
  assert.equal(resolved.vault, '/srv/campaigns/example/vault');
});

test('platform-only matches when hostname does not match the more specific profile', () => {
  const resolved = resolveCampaign(CONFIG, 'example', { platform: 'linux', hostname: 'some-other-box' });
  assert.equal(resolved.profile, 'linux-generic');
  assert.equal(resolved.vault, '/srv/generic/vault');
});

test('SCRIPTORIUM_PROFILE forces a profile and skips matching', () => {
  const resolved = resolveCampaign(CONFIG, 'example', { platform: 'win32', envProfile: 'linux-hub' });
  assert.equal(resolved.profile, 'linux-hub');
  assert.equal(resolved.vault, '/srv/campaigns/example/vault');
});

test('an unknown SCRIPTORIUM_PROFILE is a VaultUnreachableError (exit 3, issue #108)', () => {
  assert.throws(() => resolveCampaign(CONFIG, 'example', { envProfile: 'nonexistent' }), VaultUnreachableError);
});

test('CLI overrides win over everything', () => {
  const resolved = resolveCampaign(CONFIG, 'example', {
    platform: 'linux',
    hostname: 'hub',
    cliOverrides: { vault: '/tmp/diagnostic-vault' },
  });
  assert.equal(resolved.vault, '/tmp/diagnostic-vault');
});

test('two equally specific profiles is a hard error naming both', () => {
  const config = {
    campaigns: {
      x: {
        vault: 'base',
        paths: {
          a: { match: { hostname: 'box' } },
          b: { match: { hostname: 'BOX' } }, // case-insensitive hostname match, same specificity, both match
        },
      },
    },
  };
  assert.throws(() => resolveCampaign(config, 'x', { platform: 'linux', hostname: 'box' }), VaultUnreachableError);
});

test('resolving an unknown campaign is a VaultUnreachableError (exit 3, issue #108) naming the known ones', () => {
  assert.throws(() => resolveCampaign(CONFIG, 'nonexistent'), VaultUnreachableError);
});

test('resolveCampaignName: explicit name wins, then default, then error on ambiguity', () => {
  assert.equal(resolveCampaignName(CONFIG, 'example'), 'example');
  assert.equal(resolveCampaignName(CONFIG), 'example'); // default_campaign
  const twoNoDefault = { campaigns: { a: {}, b: {} } };
  assert.throws(() => resolveCampaignName(twoNoDefault), VaultUnreachableError);
  const oneNoDefault = { campaigns: { a: {} } };
  assert.equal(resolveCampaignName(oneNoDefault), 'a');
  assert.throws(() => resolveCampaignName({ campaigns: {} }), VaultUnreachableError);
});

test('listCampaigns returns registered campaign names', () => {
  assert.deepEqual(listCampaigns(CONFIG), ['example']);
  assert.deepEqual(listCampaigns({}), []);
});

// ADR 0018 (P2-FR01): "pack" resolves like the other per-campaign path
// keys: a base value, overridable per matched profile, synthetic names only.

const PACK_CONFIG = {
  config_version: 1,
  campaigns: {
    alpha: {
      vault: '/tmp/scriptorium-test-alpha-vault',
      pack: '/tmp/scriptorium-test-alpha-pack-base',
      paths: {
        fixture: {
          match: { platform: 'linux' },
          pack: '/tmp/scriptorium-test-alpha-pack-fixture',
        },
      },
    },
  },
};

test('R1: resolveCampaign returns the base "pack" when no profile matches', () => {
  const resolved = resolveCampaign(PACK_CONFIG, 'alpha', { platform: 'darwin', hostname: 'nowhere' });
  assert.equal(resolved.pack, '/tmp/scriptorium-test-alpha-pack-base');
});

test('R2: a matched profile can override "pack"', () => {
  const resolved = resolveCampaign(PACK_CONFIG, 'alpha', { platform: 'linux', hostname: 'anything' });
  assert.equal(resolved.profile, 'fixture');
  assert.equal(resolved.pack, '/tmp/scriptorium-test-alpha-pack-fixture');
});

test('R3: SCRIPTORIUM_PROFILE forces the profile\'s "pack" override', () => {
  const resolved = resolveCampaign(PACK_CONFIG, 'alpha', { platform: 'darwin', envProfile: 'fixture' });
  assert.equal(resolved.profile, 'fixture');
  assert.equal(resolved.pack, '/tmp/scriptorium-test-alpha-pack-fixture');
});
