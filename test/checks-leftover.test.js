'use strict';

/*
 * config/leftover-settings-file: a vault whose settings are in _meta/vault-config.yaml and that
 * still holds _meta/vault-config.md. gm-apprentice's update leaves that file behind and does not
 * read it. The fact comes from the pin's own "dropped" fault, so a mixed vault gives one warning,
 * and a moved vault and a legacy one give none. Expected text is typed by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { contextFromSite } = require('../src/cli/check');
const { buildCheckContext } = require('../src/checks/context');
const { runChecks } = require('../src/checks/run');
const { CHECKS } = require('../src/checks/registry');
const { moveVaultCopy } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const ID = 'config/leftover-settings-file';

function leftoverFindings(arrange) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-leftover-'));
  try {
    let vault;
    if (arrange === 'legacy') {
      vault = path.join(root, 'vault');
      fs.cpSync(SAMPLE, vault, { recursive: true });
    } else {
      vault = moveVaultCopy(SAMPLE, root).vaultPath;
      if (arrange === 'mixed') fs.copyFileSync(path.join(SAMPLE, '_meta', 'vault-config.md'), path.join(vault, '_meta', 'vault-config.md'));
    }
    const pack = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
    const site = { siteSource: 'convention', siteConfigPath: pack, siteDir: path.dirname(pack), packShadowed: null };
    const info = contextFromSite({ campaign: 'x', vault }, vault, site);
    const ctx = buildCheckContext({
      campaign: 'x',
      vaultPath: info.vaultPath,
      jsonConfig: info.jsonConfig,
      rawSiteConfig: info.rawSiteConfig,
      settingsLayout: info.settingsLayout,
    });
    return runChecks(ctx).filter((f) => f.id === ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a mixed vault gets one warning naming the left over file and where the settings are', () => {
  const found = leftoverFindings('mixed');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.equal(found[0].category, 'config');
  assert.equal(found[0].path, '_meta/vault-config.md');
  assert.equal(
    found[0].message,
    "_meta/vault-config.md is left over from before gm-apprentice's update and is not read. This vault's settings are in _meta/vault-config.yaml.",
  );
});

test('a moved vault gets no warning', () => {
  assert.deepEqual(leftoverFindings('moved'), []);
});

test('a legacy vault gets no warning', () => {
  assert.deepEqual(leftoverFindings('legacy'), []);
});

test('the check is registered, on by default, as a warning', () => {
  const entry = CHECKS.find((c) => c.id === ID);
  assert.equal(entry.defaultSeverity, 'warn');
  assert.equal(entry.defaultEnabled, true);
  assert.equal(entry.category, 'config');
});
