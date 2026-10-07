'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateName,
  validateTheme,
  validateTitle,
  defaultOutputFor,
  defaultTitleFor,
  composePackToml,
  composeVaultConfigJson,
} = require('../src/cli/init');
const { parsePackToml } = require('../src/build/packtoml');
const { readVaultConfigTemplate } = require('../src/generator/pinned');
const { ConfigError, ScriptoriumError } = require('../src/util/errors');
const PIN = require('../vendor/gm-apprentice-publish/PIN.json');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-init-scaffold-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// L-VCJ: the expected vault.config.json for the title "Fixture Chronicle", hand-typed from the template.
const L_VCJ = `{
  "siteTitle": "Fixture Chronicle",
  "landingTagline": "",
  "host": "github-pages",
  "attachmentsDir": "_attachments",
  "folderMap": {
    "Characters/PCs": "characters/pcs",
    "Characters/NPCs": "characters/npcs",
    "Locations": "locations",
    "Factions & Organizations": "factions",
    "Items & Artifacts": "items",
    "Creatures": "creatures",
    "Events": "events",
    "Documents": "documents",
    "Clues": "clues",
    "Chapters": "chapters",
    "_Campaign": "campaign",
    "_World": "world",
    "Heritages": "heritages"
  },
  "excludeDirs": [
    "_meta",
    "_Templates",
    "_resources"
  ],
  "excludeSections": [
    "GM Notes",
    "DM Notes",
    "Player Notes",
    "Source References",
    "Reconciliation Context",
    "Handoff to Reconcile"
  ],
  "excludeCallouts": true,
  "backend": {
    "statusBar": false,
    "inbox": false
  }
}
`;

test('S1: composePackToml round-trips through parsePackToml', () => {
  const toml = composePackToml('plain');
  assert.equal(toml, 'theme = "plain"\n');
  const parsed = parsePackToml(toml, { tomlPath: '/fixture/pack.toml' });
  assert.equal(parsed.theme, 'plain');
  assert.deepEqual(parsed.images, []);
  assert.deepEqual(parsed.warnings, []);
});

test('S2: composeVaultConfigJson matches the hand-typed L-VCJ literal', () => {
  const out = composeVaultConfigJson(readVaultConfigTemplate(), 'Fixture Chronicle');
  assert.equal(out, L_VCJ);
});

test('S3: an unusual title round-trips identically through JSON.parse', () => {
  const title = 'Fix "Q" \\ Chronicle é {{X}}';
  const out = composeVaultConfigJson(readVaultConfigTemplate(), title);
  const parsed = JSON.parse(out);
  assert.equal(parsed.siteTitle, title);
});

test('S4: no siteUrl/vaultPath/outputDir; every other key deep-equals the template', () => {
  const templateText = readVaultConfigTemplate();
  const template = JSON.parse(templateText);
  const out = JSON.parse(composeVaultConfigJson(templateText, 'Fixture Chronicle'));
  assert.equal('siteUrl' in out, false);
  assert.equal('vaultPath' in out, false);
  assert.equal('outputDir' in out, false);
  for (const key of Object.keys(template)) {
    if (['siteUrl', 'vaultPath', 'outputDir', 'siteTitle'].includes(key)) continue;
    assert.deepEqual(out[key], template[key], `key ${key} should be unchanged`);
  }
});

test('S5: a leftover {{HOST}} placeholder gives I-TEMPLATE naming it', () => {
  const injected = JSON.stringify({ siteTitle: '{{SITE_TITLE}}', host: '{{HOST}}' });
  assert.throws(
    () => composeVaultConfigJson(injected, 'Fixture Chronicle'),
    (err) =>
      err instanceof ScriptoriumError &&
      err.message === 'the generator\'s vault.config.json template still contains the placeholder {{HOST}}',
  );
});

test('S6: the sha256 of readVaultConfigTemplate() equals PIN.json (proves nothing about the packaged exe; see C35)', () => {
  const sha = crypto.createHash('sha256').update(readVaultConfigTemplate(), 'utf8').digest('hex');
  assert.equal(sha, PIN.files['templates-scaffold/vault.config.json.tmpl']);
});

test('S7: validateName', () => {
  for (const good of ['a', 'alpha', 'a-1', 'a'.repeat(63)]) {
    assert.equal(validateName(good), good);
  }
  for (const bad of ['', '-a', 'A', 'a_b', 'a b', 'a'.repeat(64), 'é']) {
    assert.throws(
      () => validateName(bad),
      (err) =>
        err instanceof ConfigError &&
        err.message ===
          `invalid campaign name "${bad}": use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit`,
    );
  }
});

test('S8: validateTheme', () => {
  const registry = { plain: {} };
  assert.equal(validateTheme('plain', registry), 'plain');
  for (const bad of ['Plain', 'toString', 'nonexistent']) {
    assert.throws(
      () => validateTheme(bad, registry),
      (err) => err instanceof ConfigError && err.message === `unknown theme "${bad}"; valid themes: plain`,
    );
  }
});

test('S9: validateTitle', () => {
  assert.equal(validateTitle('  x  '), 'x');
  for (const bad of ['', '  ', 'a\nb', 'a\u0007']) {
    assert.throws(
      () => validateTitle(bad),
      (err) => err instanceof ConfigError && err.message === 'site title must be one non-empty line',
    );
  }
});

test('S10: defaultOutputFor and defaultTitleFor', () => {
  assert.equal(defaultOutputFor('/vaults/alpha', 'alpha'), path.join('/vaults', 'alpha-site'));

  withScratchDir((root) => {
    const vaultAbs = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultAbs, '_meta'), { recursive: true });

    fs.writeFileSync(
      path.join(vaultAbs, '_meta', 'vault-config.md'),
      '---\ntype: meta\ncampaign: Fixture Chronicle\n---\n\n# Vault config\n',
    );
    assert.equal(defaultTitleFor(vaultAbs, 'alpha'), 'Fixture Chronicle');

    fs.writeFileSync(path.join(vaultAbs, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# Vault config\n');
    assert.equal(defaultTitleFor(vaultAbs, 'alpha'), 'alpha');

    fs.writeFileSync(
      path.join(vaultAbs, '_meta', 'vault-config.md'),
      '---\ntype: meta\ncampaign: 5\n---\n\n# Vault config\n',
    );
    assert.equal(defaultTitleFor(vaultAbs, 'alpha'), 'alpha');

    fs.writeFileSync(
      path.join(vaultAbs, '_meta', 'vault-config.md'),
      '---\ntype: meta\ncampaign: "  "\n---\n\n# Vault config\n',
    );
    assert.equal(defaultTitleFor(vaultAbs, 'alpha'), 'alpha');

    fs.writeFileSync(path.join(vaultAbs, '_meta', 'vault-config.md'), '---\ntype: meta\n[[[not yaml\n---\n');
    assert.equal(defaultTitleFor(vaultAbs, 'alpha'), 'alpha');
  });
});
