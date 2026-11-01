'use strict';

/*
 * `check` and `build` must read a moved vault's settings (_meta/vault-config.yaml) everywhere they
 * read a vault's settings. Each test runs at module level on a copy of the sample vault that the
 * pin's own move has already run on (test/helpers/moved-vault.js), by calling the functions
 * directly: locateVault still refuses a moved vault until the CLI is opened up, so the
 * `check` and `build` commands are not driven here.
 *
 * Every expected value is typed out by hand from the sample vault's settings (its yaml after the
 * move) and from the pin's rules, never read from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPublishConfig } = require('../src/vault/publishset');
const { generatorImageCopies } = require('../src/vault/imagecopies');
const { defaultTitleFor } = require('../src/setup/scaffold');
const { paletteScheme, runThemeSchemeMismatch } = require('../src/checks/themescheme');
const { runSettingsFault } = require('../src/checks/configdiv');
const { contextFromSite } = require('../src/cli/check');
const { stageConfig } = require('../src/build/stage');
const { VaultUnreachableError } = require('../src/util/errors');
const { moveVaultCopy } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

function withMoved(fn, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-read-'));
  try {
    return fn(moveVaultCopy(SAMPLE, root, opts).vaultPath, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function editYaml(vault, from, to) {
  const file = path.join(vault, '_meta', 'vault-config.yaml');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `the moved yaml holds ${from}`);
  fs.writeFileSync(file, text.replace(from, to));
}

function fullSite(root) {
  const dir = path.join(root, 'legacy-site');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vault.config.json');
  fs.writeFileSync(file, JSON.stringify({ searchEnabled: true, excludeDirs: ['_meta'], folderMap: { Locations: 'locations' } }));
  return file;
}

function writeSite(root, extra) {
  const dir = path.join(root, 'site');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vault.config.json');
  fs.writeFileSync(file, JSON.stringify({ searchEnabled: true, ...extra }, null, 2));
  return file;
}

test('loadPublishConfig on a moved vault returns the yaml\'s hiding list, after a GM-only edit of the yaml', () => {
  withMoved((vault) => {
    editYaml(vault, 'sections: ["GM Notes",', 'sections: ["Yaml Only", "GM Notes",');
    assert.deepEqual(loadPublishConfig(vault, {}).publishConfig.exclude_sections, [
      'Yaml Only', 'GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile',
    ]);
  });
});

test('configSources.vault on a moved vault holds the yaml\'s own list, and nothing for a list the yaml leaves unset', () => {
  withMoved((vault) => {
    const { configSources } = loadPublishConfig(vault, {});
    assert.deepEqual(configSources.vault.exclude_fields, ['secrets', 'current_plan', 'plan_progress', 'gm_notes', 'prep_notes', 'reliability']);
    assert.deepEqual(configSources.vault.exclude_dirs, ['_meta', '_Templates']);
    assert.equal(configSources.json.excludeSections, undefined);
  });
});

test('a pack with no folderMap and no excludeDirs is accepted on a moved vault, and still exits 3 on a legacy one', () => {
  withMoved((vault, root) => {
    const siteConfigPath = writeSite(root, {});
    const ctxInfo = { campaign: 'x', vault, site_config: siteConfigPath };
    const site = { siteSource: 'site_config', siteConfigPath, siteDir: path.dirname(siteConfigPath), packShadowed: null };
    const ctx = contextFromSite(ctxInfo, vault, site);
    assert.equal(ctx.settingsLayout, 'new');
    assert.deepEqual(ctx.rawSiteConfig, { searchEnabled: true });
    assert.equal('rawSiteConfig' in ctx.jsonConfig || 'settingsLayout' in ctx.jsonConfig, false, 'jsonConfig holds only site-file content');
    assert.equal(ctx.jsonConfig.vaultPath, vault);
    assert.deepEqual(ctx.jsonConfig.excludeSections.slice(0, 2), ['GM Notes', 'DM Notes']);

    const legacy = contextFromSite({ campaign: 'x', vault: SAMPLE, site_config: fullSite(root) }, SAMPLE, { ...site, siteConfigPath: fullSite(root) });
    assert.equal(legacy.settingsLayout, 'legacy');
    assert.deepEqual(Object.keys(legacy.jsonConfig).sort(), ['excludeDirs', 'folderMap', 'searchEnabled', 'vaultPath']);

    assert.throws(
      () => contextFromSite({ campaign: 'x', vault: SAMPLE, site_config: siteConfigPath }, SAMPLE, site),
      (err) => err instanceof VaultUnreachableError && /is missing required key/.test(err.message),
    );
  });
});

test('the staged vault.config.json on a moved vault carries none of the keys the move took', () => {
  withMoved((vault, root) => {
    const raw = {
      customNote: 'keep',
      siteTitle: 'Old',
      folderMap: { Locations: 'locations' },
      excludeDirs: ['_meta'],
      excludeSections: ['GM Notes'],
      excludeCallouts: true,
      landingTagline: 'old',
      attachmentsDir: '_attachments',
    };
    const staging = path.join(root, 'staging');
    const out = path.join(root, 'out');
    const file = stageConfig(raw, vault, staging, out).configPath;
    const staged = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of ['siteTitle', 'folderMap', 'excludeDirs', 'excludeSections', 'excludeCallouts', 'landingTagline', 'attachmentsDir']) {
      assert.equal(Object.prototype.hasOwnProperty.call(staged, key), false, `${key} must not reach the generator`);
    }
    assert.equal(staged.customNote, 'keep');
    assert.equal(staged.vaultPath, vault);
    // ADR 0071: no outputDir either. The build is told where to write by the generator's own option
    // (stageConfig's outputDirOverride), so the generator never warns about a site-file outputDir.
    assert.equal(Object.prototype.hasOwnProperty.call(staged, 'outputDir'), false, 'outputDir must not reach the generator');
  });
});

test('stageConfig on a moved vault hands back the output folder as an override; on a legacy vault, none', () => {
  withMoved((vault, root) => {
    const out = path.join(root, 'out');
    const staged = stageConfig({ customNote: 'keep' }, vault, path.join(root, 'staging'), out);
    assert.equal(staged.outputDirOverride, out);
    assert.equal(JSON.parse(fs.readFileSync(staged.configPath, 'utf8')).customNote, 'keep');
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-read-'));
  try {
    const legacy = stageConfig({ siteTitle: 'Old' }, SAMPLE, path.join(root, 's'), path.join(root, 'o'));
    assert.equal(legacy.outputDirOverride, null);
    assert.equal(JSON.parse(fs.readFileSync(legacy.configPath, 'utf8')).outputDir, path.join(root, 'o'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a moved vault\'s staged config keeps the pack\'s site-folder keys the generator still reads, except outputDir (through contextFromSite)', () => {
  withMoved((vault, root) => {
    // The pack as a GM might leave it after the move: the site-folder keys, which the generator still
    // reads from the site file while the yaml sets none (player_site.url and its siblings).
    const pack = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
    fs.writeFileSync(pack, JSON.stringify({
      siteUrl: 'https://example.org/longlease/',
      cloudflarePagesProject: 'longlease',
      preserveDirs: ['keep-me'],
      outputDir: 'docs',
    }, null, 2));
    const yaml = fs.readFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'utf8');
    assert.doesNotMatch(yaml, /^\s*(url|cloudflare_project|keep|output):/m, 'the yaml sets none of these four');
    const site = { siteSource: 'pack', siteConfigPath: pack, siteDir: path.dirname(pack), packShadowed: null };
    const info = contextFromSite({ campaign: 'x', vault }, vault, site);
    const out = path.join(root, 'out');
    const staged = stageConfig(info.jsonConfig, vault, path.join(root, 'staging'), out);
    assert.deepEqual(JSON.parse(fs.readFileSync(staged.configPath, 'utf8')), {
      siteUrl: 'https://example.org/longlease/',
      cloudflarePagesProject: 'longlease',
      preserveDirs: ['keep-me'],
      // No host: the yaml's player_site.host is "github-pages", the built-in value, so the generator reads
      // the same without it, and a staged one would only make it warn that host "moves to" the vault.
      vaultPath: vault,
    });
    assert.equal(staged.outputDirOverride, out);
  }, { inVaultPack: true });
});

test('the staged config of a legacy vault is unchanged: every key verbatim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-read-'));
  try {
    const file = stageConfig({ siteTitle: 'Old', folderMap: { a: 'b' } }, SAMPLE, path.join(root, 's'), path.join(root, 'o')).configPath;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { siteTitle: 'Old', folderMap: { a: 'b' }, vaultPath: SAMPLE, outputDir: path.join(root, 'o') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('defaultTitleFor on a moved vault: the yaml\'s player_site.title, else its campaign, else the name', () => {
  withMoved((vault) => {
    assert.equal(defaultTitleFor(vault, 'x'), 'The Long Lease');
    editYaml(vault, 'player_site:\n', 'player_site:\n  title: "Yaml Title"\n');
    assert.equal(defaultTitleFor(vault, 'x'), 'Yaml Title');
  });
});

test('the theme scheme is read from the yaml: a palette background set there flips the scheme', () => {
  withMoved((vault) => {
    assert.deepEqual(paletteScheme(vault), { scheme: 'light', background: '#fbf6ea' });
    editYaml(vault, 'background: "#fbf6ea"', 'background: "#101010"');
    assert.deepEqual(paletteScheme(vault), { scheme: 'dark', background: '#101010' });
  });
});

test('config/theme-scheme-mismatch on a moved vault names _meta/vault-config.yaml', () => {
  withMoved((vault) => {
    // haze is a dark theme; the sample's palette background is light.
    const found = runThemeSchemeMismatch({ vaultPath: vault, campaign: 'x', packToml: { present: true, theme: 'haze' } });
    assert.equal(found.length, 1);
    assert.equal(found[0].path, '_meta/vault-config.yaml');
    assert.equal(found[0].data.background, '#fbf6ea');
    assert.match(found[0].message, /set publish\.theme\.palette\.background in _meta\/vault-config\.yaml/);
  });
});

test('image copies on a moved vault read banners from the yaml', () => {
  withMoved((vault) => {
    fs.writeFileSync(path.join(vault, '_attachments', 'items', 'yaml-only.png'), Buffer.from([137, 80, 78, 71]));
    editYaml(vault, '    banners:\n', '    banners:\n      items: "_attachments/items/yaml-only.png"\n');
    const copies = generatorImageCopies(vault, {});
    assert.ok(copies.has('images/banners/items/yaml-only.png'), 'the yaml-only banner is copied');
    assert.equal(copies.get('images/banners/items/yaml-only.png').sourceRel, '_attachments/items/yaml-only.png');
    assert.equal(copies.get('images/campaign/long-lease-banner.svg'), undefined);
    assert.equal(copies.get('images/long-lease-banner.svg').kind, 'cover');
  });
});

test('config/settings-fault on a moved vault names _meta/vault-config.yaml as its path', () => {
  withMoved((vault) => {
    editYaml(vault, '    mode: player\n', '    mode: player\n    sectoins: ["GM Notes"]\n');
    const { stops } = loadPublishConfig(vault, {});
    assert.equal(stops.length, 1);
        const found = runSettingsFault({ campaign: 'x', publishSet: { stops }, jsonConfig: {}, settingsLayout: 'new', rawSiteConfig: {} });
    assert.equal(found.length, 1);
    assert.equal(found[0].path, '_meta/vault-config.yaml');
    const legacy = runSettingsFault({ campaign: 'x', publishSet: { stops }, jsonConfig: {} });
    assert.equal(legacy[0].path, '_meta/vault-config.md');
  });
});

test('a leftover hiding key in the pack of a moved vault is a stop, not a silent miss', () => {
  withMoved((vault) => {
    const raw = { excludeSections: ['Foo'] };
    const { stops } = loadPublishConfig(vault, {}, raw);
    assert.match(stops[0].message, /^excludeSections in the site folder's vault\.config\.json is no longer read/);
  });
});

test('with no raw pack given, loadPublishConfig on a moved vault reads the yaml and finds no stop', () => {
  withMoved((vault) => {
    const loaded = loadPublishConfig(vault, {});
    assert.deepEqual(loaded.stops, []);
    assert.deepEqual(loaded.publishConfig.exclude_dirs.slice(0, 2), ['_meta', '_Templates']);
  });
});

// What the pin renders (its loadPublishConfig theme through generateThemeCSS --bg), typed by hand.
test('a moved vault with no palette: no genre reads the pin\'s light default, an unknown genre its dark one, a known genre none', () => {
  const noPalette = (genre) => (vault) => {
    const file = path.join(vault, '_meta', 'vault-config.yaml');
    let text = fs.readFileSync(file, 'utf8').replace(/    palette:\n(      .*\n){4}/, '');
    if (genre) text = text.replace('  theme:\n', `  theme:\n    genre: "${genre}"\n`);
    fs.writeFileSync(file, text);
    return paletteScheme(vault);
  };
  assert.deepEqual(withMoved(noPalette(null)), { scheme: 'light', background: '#e8f0f3' });
  assert.deepEqual(withMoved(noPalette('nonesuch')), { scheme: 'dark', background: '#1a1f25' });
  assert.deepEqual(withMoved(noPalette('horror')), { scheme: null, background: null });
});
