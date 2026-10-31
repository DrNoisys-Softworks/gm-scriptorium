'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vaultstate = require('../src/vault/vaultstate');
const { locateVault } = require('../src/vault/locate');
const { inspectTarget } = require('../src/vault/vaultcreate');
const { assertNotInsideAnyVault } = require('../src/remote/paths');
const { findVaultChild } = require('../src/setup/probe');
const { checkVault } = require('../src/setup/checks');
const { checkTarget, replaceVaultConfigMd, VaultConfigChangedError } = require('../src/vault/vaultconfigwrite');
const { ConfigError, VaultUnreachableError } = require('../src/util/errors');

/*
 * Issue #171. The gm-apprentice plugin's update can move a vault's settings from
 * _meta/vault-config.md into _meta/vault-config.yaml. Every "is this a vault?" check counts the
 * .yaml too, and a moved or mixed vault is accepted like any other (the refusal this file once
 * pinned was removed on purpose when check and build learned to read the yaml, ADR 0071). Four
 * states, by which of the two files exist:
 *   old (.md only), moved (.yaml only), mixed (both), none (neither).
 *
 * Expected messages are literals on purpose, never read from the code under test. Each test builds
 * its own vault in a scratch folder.
 */

const MD_TEXT = '---\ntype: meta\npublish:\n  theme:\n    tagline: Old words\n---\n\n# settings\n';
const YAML_TEXT = 'type: meta\n';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The realpath, so a comparison with a resolved path holds on a system whose temp folder is a link.
  return fs.realpathSync(root);
}

/** state: 'old' | 'moved' | 'mixed' | 'none' */
function makeVault(root, name, state) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '_meta'), { recursive: true });
  if (state === 'old' || state === 'mixed') fs.writeFileSync(path.join(dir, '_meta', 'vault-config.md'), MD_TEXT);
  if (state === 'moved' || state === 'mixed') fs.writeFileSync(path.join(dir, '_meta', 'vault-config.yaml'), YAML_TEXT);
  return dir;
}

const NONE_MESSAGE = (campaign, vaultPath) =>
  `campaign "${campaign}": ${vaultPath} exists but has no _meta/vault-config.md; it is not a gm-apprentice vault. ` +
  'A vault needs a _meta/vault-config.md settings page. To see a complete one, look at examples/the-long-lease ' +
  'in the GM-Scriptorium download. To start a new campaign, run "gm-scriptorium init --new-vault <folder>", ' +
  'or choose "Start a new campaign here" in browser setup. To learn more, see the gm-apprentice project: ' +
  'https://github.com/AntTheLimey/gm-apprentice';

// === (a) the helper =========================================================================

test('(a) stateOf gives old, moved, mixed and none for the four combinations', () => {
  assert.equal(vaultstate.stateOf(true, false), 'old');
  assert.equal(vaultstate.stateOf(false, true), 'moved');
  assert.equal(vaultstate.stateOf(true, true), 'mixed');
  assert.equal(vaultstate.stateOf(false, false), 'none');
});

test('(a) the helper exports exactly its contract and the two filenames', () => {
  assert.deepEqual(Object.keys(vaultstate).sort(), ['SETTINGS_MD', 'SETTINGS_YAML', 'settingsPaths', 'stateOf', 'vaultState']);
  assert.equal(vaultstate.SETTINGS_MD, 'vault-config.md');
  assert.equal(vaultstate.SETTINGS_YAML, 'vault-config.yaml');
  assert.deepEqual(vaultstate.settingsPaths(path.join('x', 'v')), {
    md: path.join('x', 'v', '_meta', 'vault-config.md'),
    yaml: path.join('x', 'v', '_meta', 'vault-config.yaml'),
  });
});

test('(a) vaultState asks the caller\'s own existence check about each of the two paths', (t) => {
  const root = scratch(t);
  for (const state of ['old', 'moved', 'mixed', 'none']) {
    const dir = makeVault(root, `v-${state}`, state);
    assert.equal(vaultstate.vaultState(dir, fs.existsSync), state, state);
  }
  const asked = [];
  const answer = vaultstate.vaultState('/some/vault', (p) => {
    asked.push(p);
    return p.endsWith('.yaml') ? 1 : 0;
  });
  assert.equal(answer, 'moved', 'truthy and falsy values are coerced');
  assert.deepEqual(asked.map((p) => path.basename(p)).sort(), ['vault-config.md', 'vault-config.yaml']);
});

test('(a) a vault-config.yaml that is a folder counts as present', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'v', 'none');
  fs.mkdirSync(path.join(dir, '_meta', 'vault-config.yaml'));
  assert.equal(vaultstate.vaultState(dir, fs.existsSync), 'moved');
});

// === (b) locateVault ========================================================================

test('(b) locateVault returns for a moved vault', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'moved', 'moved');
  assert.deepEqual(locateVault(dir, 'camp'), { vaultPath: dir, campaign: 'camp' });
});

test('(b) locateVault returns for a mixed vault', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'mixed', 'mixed');
  assert.deepEqual(locateVault(dir, 'camp'), { vaultPath: dir, campaign: 'camp' });
});

test('(b) locateVault still returns for an old vault', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'old', 'old');
  assert.deepEqual(locateVault(dir, 'camp'), { vaultPath: dir, campaign: 'camp' });
});

test('(b) passes today, proves nothing: locateVault keeps the exact old message and reason for a vault with neither file', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'none', 'none');
  assert.throws(
    () => locateVault(dir, 'camp'),
    (err) => {
      assert.equal(err.reason, 'not-a-vault');
      assert.equal(err.message, NONE_MESSAGE('camp', dir));
      return true;
    },
  );
});

// === (c) the new-vault ancestor walk ========================================================

test('(c) inspectTarget refuses a folder inside a moved vault', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'moved', 'moved');
  const target = path.join(dir, 'sub');
  assert.throws(
    () => inspectTarget(target, {}),
    (err) => {
      assert.equal(err.kind, 'inside-vault');
      assert.equal(err.ancestor, fs.realpathSync(dir));
      assert.equal(err.message, `refusing to create a vault in ${target}: it is inside the vault at ${fs.realpathSync(dir)}`);
      return true;
    },
  );
});

test('(c) passes today: inspectTarget refuses a folder inside a mixed vault (the .md is there)', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'mixed', 'mixed');
  const target = path.join(dir, 'sub');
  assert.throws(
    () => inspectTarget(target, {}),
    (err) => {
      assert.equal(err.kind, 'inside-vault');
      assert.equal(err.ancestor, fs.realpathSync(dir));
      assert.equal(err.message, `refusing to create a vault in ${target}: it is inside the vault at ${fs.realpathSync(dir)}`);
      return true;
    },
  );
});

// === (d) remote-access files ================================================================

test('(d) assertNotInsideAnyVault refuses a folder inside a moved vault', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'moved', 'moved');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  assert.throws(
    () => assertNotInsideAnyVault(cfg, { campaigns: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(
        err.message,
        `remote access keeps its files beside the config, never inside a vault, but ${cfg} is inside the vault at ${fs.realpathSync(dir)}`,
      );
      return true;
    },
  );
});

test('(d) assertNotInsideAnyVault refuses a folder inside a mixed vault', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'mixed', 'mixed');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  assert.throws(
    () => assertNotInsideAnyVault(cfg, { campaigns: {} }),
    (err) => {
      assert.equal(
        err.message,
        `remote access keeps its files beside the config, never inside a vault, but ${cfg} is inside the vault at ${fs.realpathSync(dir)}`,
      );
      return true;
    },
  );
});

// === (e) the picker's child search ==========================================================

test('(e) findVaultChild returns a child that holds only vault-config.yaml', async (t) => {
  const root = scratch(t);
  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent);
  makeVault(parent, 'a-plain', 'none');
  const moved = makeVault(parent, 'b-moved', 'moved');
  assert.equal(await findVaultChild(parent), moved);
});

test('(e) findVaultChild still returns a child that holds vault-config.md, and null when no child holds either', async (t) => {
  const root = scratch(t);
  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent);
  makeVault(parent, 'a-plain', 'none');
  assert.equal(await findVaultChild(parent), null);
  const old = makeVault(parent, 'b-old', 'old');
  assert.equal(await findVaultChild(parent), old);
});

// === (f) the setup screen's vault check =====================================================

test('(f) checkVault finds a moved folder as a vault, says its settings are in the yaml, and shows no child search', async (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'moved', 'moved');
  makeVault(dir, 'inner', 'old'); // an old-layout child that a child search would offer
  const res = await checkVault(dir, { name: 'camp' });
  assert.equal(res.state, 'ok');
  assert.equal(res.rule, null);
  assert.equal(res.facts.candidate, null);
  assert.equal(res.facts.settingsMoved, true);
  assert.equal(res.facts.found, true);
  assert.equal(res.facts.isVault, true);
});

test('(f) checkVault finds a mixed folder as a vault whose settings are in the yaml', async (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'mixed', 'mixed');
  const res = await checkVault(dir, { name: 'camp' });
  assert.equal(res.state, 'ok');
  assert.equal(res.facts.isVault, true);
  assert.equal(res.facts.settingsMoved, true);
});

test('(f) checkVault leaves settingsMoved out of every other result', async (t) => {
  const root = scratch(t);
  const plain = makeVault(root, 'plain', 'none');
  const res = await checkVault(plain, { name: 'camp' });
  assert.equal('settingsMoved' in res.facts, false);
  const old = makeVault(root, 'old', 'old');
  assert.equal('settingsMoved' in (await checkVault(old, { name: 'camp' })).facts, false);
});

// === (g) the vault-config.md write chokepoint ===============================================

test('(g) checkTarget refuses a mixed vault with a ConfigError, not a "changed" error', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'mixed', 'mixed');
  assert.throws(
    () => checkTarget(dir, { campaign: 'camp' }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(!(err instanceof VaultConfigChangedError));
      assert.equal(
        err.message,
        "This campaign's settings are set in the vault's settings file (_meta/vault-config.yaml). Editing them here arrives in the next update; change them in that file for now.",
      );
      assert.equal(err.path, path.join(dir, '_meta', 'vault-config.yaml'));
      return true;
    },
  );
});

test('(g) checkTarget refuses a moved vault with the same ConfigError, not "changed outside the panel"', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'moved', 'moved');
  assert.throws(
    () => checkTarget(dir, { campaign: 'camp' }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(!(err instanceof VaultConfigChangedError));
      assert.equal(
        err.message,
        "This campaign's settings are set in the vault's settings file (_meta/vault-config.yaml). Editing them here arrives in the next update; change them in that file for now.",
      );
      return true;
    },
  );
});

test('(g) checkTarget still accepts an old vault', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'old', 'old');
  const res = checkTarget(dir, { campaign: 'camp' });
  assert.equal(res.target, path.join(dir, '_meta', 'vault-config.md'));
});

test('(g) a yaml that cannot be read for a reason other than "absent" refuses closed', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'old', 'old');
  const real = fs.lstatSync;
  fs.lstatSync = (p, ...rest) => {
    if (String(p).endsWith('vault-config.yaml')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return real.call(fs, p, ...rest);
  };
  try {
    assert.throws(
      () => checkTarget(dir, { campaign: 'camp' }),
      (err) => {
        assert.ok(!(err instanceof ConfigError));
        assert.equal(err.message, `could not read ${path.join(dir, '_meta', 'vault-config.yaml')}: EACCES. vault-config.md was left unchanged.`);
        return true;
      },
    );
  } finally {
    fs.lstatSync = real;
  }
});

// === (h) replaceVaultConfigMd on a mixed vault ===============================================

test('(h) replaceVaultConfigMd on a mixed vault refuses before any backup, temp file or change', (t) => {
  const root = scratch(t);
  const dir = makeVault(root, 'mixed', 'mixed');
  const metaDir = path.join(dir, '_meta');
  const listingBefore = fs.readdirSync(metaDir).sort();
  const mdBefore = fs.readFileSync(path.join(metaDir, 'vault-config.md'));
  let backupCalls = 0;
  assert.throws(
    () =>
      replaceVaultConfigMd(dir, Buffer.from('---\ntype: meta\n---\nnew\n'), {
        expectedSha256: require('crypto').createHash('sha256').update(mdBefore).digest('hex'),
        backup: () => {
          backupCalls += 1;
          return { path: 'never' };
        },
        campaign: 'camp',
      }),
    (err) => err instanceof ConfigError && err.message === "This campaign's settings are set in the vault's settings file (_meta/vault-config.yaml). Editing them here arrives in the next update; change them in that file for now.",
  );
  assert.equal(backupCalls, 0);
  assert.deepEqual(fs.readdirSync(metaDir).sort(), listingBefore);
  assert.deepEqual(fs.readFileSync(path.join(metaDir, 'vault-config.md')), mdBefore);
  assert.equal(fs.readFileSync(path.join(metaDir, 'vault-config.yaml'), 'utf8'), YAML_TEXT);
});
