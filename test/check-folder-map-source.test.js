'use strict';

/*
 * `check` must scan the folder map the build publishes. On an old-layout vault that map can be set
 * in _meta/vault-config.md (publish.folder_map), which wins over the pack's; a folder only that map
 * names was reported as unmapped and left out of the leak scan. Each case runs on both layouts,
 * through the real CLI. Expected values are typed out by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { isMdParseError, isYamlParseError } = require('../src/vault/publishset');
const { moveVaultCopy, assertMovedLayout, replaceChecked } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

function packMapOf(vault) {
  return JSON.parse(fs.readFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), 'utf8')).folderMap;
}

function addSecretNote(vault) {
  fs.mkdirSync(path.join(vault, 'Secret'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'Secret', 'Plot.md'),
    '---\ntitle: Plot\ntype: location\n---\n# Plot\n\nOttoline Pardew is behind it all.\n',
  );
  const man = path.join(vault, '_meta', 'publish-manifest.md');
  fs.writeFileSync(man, replaceChecked(fs.readFileSync(man, 'utf8'), '## Publishing\n\n', '## Publishing\n\n- [x] Secret/Plot.md\n'));
}

// A scratch vault on one layout, with the Secret note; `mapped` says whether the vault's settings map Secret.
function makeVault(root, layout, mapped) {
  let vault;
  if (layout === 'new') {
    vault = moveVaultCopy(SAMPLE, root, { inVaultPack: true }).vaultPath;
    assertMovedLayout(vault);
  } else {
    vault = path.join(root, 'vault');
    fs.cpSync(SAMPLE, vault, { recursive: true });
  }
  addSecretNote(vault);
  if (mapped) {
    if (layout === 'new') {
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      fs.writeFileSync(file, replaceChecked(fs.readFileSync(file, 'utf8'), '  folder_map:\n', '  folder_map:\n    Secret: secret\n'));
    } else {
      const file = path.join(vault, '_meta', 'vault-config.md');
      const map = { ...packMapOf(vault), Secret: 'secret' };
      const block = '  folder_map:\n' + Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`).join('');
      fs.writeFileSync(file, replaceChecked(fs.readFileSync(file, 'utf8'), 'publish:\n', 'publish:\n' + block));
    }
  }
  return vault;
}

function runCheck(root, vault) {
  const cfg = path.join(root, 'config.toml');
  fs.writeFileSync(
    cfg,
    `config_version = 1\ndefault_campaign = "s"\n\n[campaigns.s]\nvault = "${vault}"\noutput = "${path.join(root, 'out')}"\npack = "${path.join(vault, '_meta', 'scriptorium')}"\n`,
  );
  const r = spawnSync(process.execPath, [BIN, 'check', 's', '--json', '--config', cfg], { encoding: 'utf8' });
  return { status: r.status, findings: JSON.parse(r.stdout).findings, stderr: r.stderr };
}

function inScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fmap-src-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const layout of ['legacy', 'new']) {
  test(`${layout}: a folder only the vault's folder map names is scanned for leaks`, () => {
    inScratch((root) => {
      const { status, findings } = runCheck(root, makeVault(root, layout, true));
      assert.equal(status, 2);
      const leak = findings.filter((f) => f.id === 'leak/l4-hidden-name' && f.path === 'Secret/Plot.md');
      assert.equal(leak.length, 1);
      assert.equal(leak[0].data.hiddenName, 'Ottoline Pardew');
      assert.deepEqual(findings.filter((f) => f.id === 'vault/unmapped-directory' && f.path === 'Secret/Plot.md'), []);
    });
  });

  test(`${layout}: control, the same vault without the Secret mapping reports it unmapped`, () => {
    inScratch((root) => {
      const { status, findings } = runCheck(root, makeVault(root, layout, false));
      assert.notEqual(status, 2);
      assert.equal(findings.filter((f) => f.id === 'leak/l4-hidden-name').length, 0);
      assert.equal(findings.filter((f) => f.id === 'vault/unmapped-directory' && f.path === 'Secret/Plot.md').length, 1);
    });
  });
}

test('isMdParseError is true for the markdown file\'s parse error only', () => {
  assert.equal(isMdParseError(new Error('_meta/vault-config.md frontmatter is not valid YAML: x')), true);
  assert.equal(isMdParseError(new Error('_meta/vault-config.yaml is not valid YAML: x')), false);
  assert.equal(isMdParseError(new Error('something else')), false);
  assert.equal(isMdParseError(null), false);
  assert.equal(isYamlParseError(new Error('_meta/vault-config.md frontmatter is not valid YAML: x')), false);
});

test('legacy: a vault-config.md whose frontmatter does not parse still ends in frontmatter/parse-error, with the pack\'s map', () => {
  inScratch((root) => {
    const vault = makeVault(root, 'legacy', false);
    const file = path.join(vault, '_meta', 'vault-config.md');
    fs.writeFileSync(file, replaceChecked(fs.readFileSync(file, 'utf8'), 'publish:\n', 'publish: [unclosed\n'));
    const { status, findings, stderr } = runCheck(root, vault);
    assert.equal(status, 2, stderr);
    assert.ok(findings.some((f) => f.id === 'frontmatter/parse-error' && f.path === '_meta/vault-config.md'));
  });
});
