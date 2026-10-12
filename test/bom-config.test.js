'use strict';

/*
 * Issue #48: Windows Notepad and PowerShell's `Set-Content -Encoding utf8` put a UTF-8 byte-order
 * mark at the start of a file. Every JSON and TOML config file the program reads must accept it,
 * and anything the program writes back must not carry one. One test per file type and read path.
 * Expected values are written out here, not taken from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOM = '﻿';
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

const { stripBom } = require('../src/util/bom');
const { loadSiteConfig, loadPackConfig, parsePackConfigText } = require('../src/cli/check');
const { parseConfig, loadConfigFile } = require('../src/config/load');
const { parsePackToml } = require('../src/build/packtoml');
const { editPackTomlTheme, editVaultConfigJson } = require('../src/admin/packedit');
const { editPackTomlVocab, validateVocabEdits } = require('../src/admin/handlers/vocab');
const { editPackTomlSlots } = require('../src/admin/handlers/images');

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-bom-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const VAULT_CONFIG_JSON = '{\n  "siteTitle": "The Long Night",\n  "vaultPath": "."\n}\n';
const PACK_TOML = 'theme = "haze"\n';

test('stripBom removes exactly one leading BOM and leaves everything else alone', () => {
  assert.equal(stripBom(`${BOM}abc`), 'abc');
  assert.equal(stripBom('abc'), 'abc');
  assert.equal(stripBom(''), '');
  assert.equal(stripBom(`a${BOM}b`), `a${BOM}b`, 'a BOM that is not first is content, not a mark');
  assert.equal(stripBom(`${BOM}${BOM}x`), `${BOM}x`, 'only the first is the byte-order mark');
});

test('vault.config.json (site_config path) with a BOM loads', () => {
  withDir((dir) => {
    const file = path.join(dir, 'vault.config.json');
    fs.writeFileSync(file, Buffer.concat([BOM_BYTES, Buffer.from(VAULT_CONFIG_JSON)]));
    const cfg = loadSiteConfig(file);
    assert.equal(cfg.siteTitle, 'The Long Night');
    assert.equal(cfg.vaultPath, dir);
  });
});

test('vault.config.json (campaign pack, read through the vault chokepoint) with a BOM loads', () => {
  withDir((dir) => {
    const file = path.join(dir, 'vault.config.json');
    fs.writeFileSync(file, Buffer.concat([BOM_BYTES, Buffer.from(VAULT_CONFIG_JSON)]));
    assert.equal(loadPackConfig(file, 'alpha').siteTitle, 'The Long Night');
  });
});

test('vault.config.json text with a BOM parses through the admin panel path too', () => {
  assert.equal(parsePackConfigText(`${BOM}${VAULT_CONFIG_JSON}`, '/p/vault.config.json', 'alpha').siteTitle, 'The Long Night');
});

test('a vault.config.json that is still not JSON is still refused with the same message after a BOM', () => {
  assert.throws(
    () => parsePackConfigText(`${BOM}{not json`, '/p/vault.config.json', 'alpha'),
    /campaign "alpha": \/p\/vault\.config\.json is not valid JSON: /,
  );
});

test('config.toml with a BOM loads (text and file)', () => {
  const text = 'config_version = 1\n';
  assert.deepEqual(parseConfig(`${BOM}${text}`).config, parseConfig(text).config);
  withDir((dir) => {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, Buffer.concat([BOM_BYTES, Buffer.from(text)]));
    assert.deepEqual(loadConfigFile(file).config, parseConfig(text).config);
  });
});

test('config.toml with a BOM and a campaign keeps the campaign (the BOM is not glued onto the first key)', () => {
  const text = 'config_version = 1\n\n[campaigns.alpha]\nname = "Alpha"\n';
  const withBom = parseConfig(`${BOM}${text}`);
  assert.deepEqual(Object.keys(withBom.config.campaigns), ['alpha']);
  assert.equal(withBom.config.config_version, 1);
});

test('pack.toml with a BOM parses', () => {
  const result = parsePackToml(`${BOM}${PACK_TOML}`, { tomlPath: '/p/pack.toml', campaign: 'alpha' });
  assert.equal(result.theme, 'haze');
});

test('a pack.toml that is still not TOML is still refused with the same message after a BOM', () => {
  assert.throws(
    () => parsePackToml(`${BOM}theme = `, { tomlPath: '/p/pack.toml', campaign: 'alpha' }),
    /campaign "alpha": \/p\/pack\.toml is not valid TOML: /,
  );
});

test('the panel editors accept a BOM-prefixed file and write it back without one', () => {
  const theme = editPackTomlTheme(`${BOM}${PACK_TOML}`, 'gloam');
  assert.equal(theme, 'theme = "gloam"\n');

  const json = editVaultConfigJson(`${BOM}${VAULT_CONFIG_JSON}`, { siteTitle: 'New Title' });
  assert.equal(json, '{\n  "siteTitle": "New Title",\n  "vaultPath": "."\n}\n');

  const slots = editPackTomlSlots(`${BOM}${PACK_TOML}`, { hero: 'images/hero.webp' });
  assert.equal(slots.charCodeAt(0) === 0xfeff, false);
  assert.match(slots, /^theme = "haze"\n/);
  assert.match(slots, /hero = "images\/hero\.webp"/);

  const edits = validateVocabEdits({ recaps: { learned_heading: 'What we found' } });
  const vocab = editPackTomlVocab(`${BOM}${PACK_TOML}`, edits);
  assert.equal(vocab.charCodeAt(0) === 0xfeff, false);
  assert.match(vocab, /^theme = "haze"\n/);
  assert.match(vocab, /learned_heading = "What we found"/);
});
