'use strict';

/*
 * What `check` says about a pack's leftover settings on a vault whose settings moved to
 * _meta/vault-config.yaml (ADR 0071). Each test runs at module level on a copy of the sample vault
 * that the pin's own move has already run on: contextFromSite builds the context, runChecks runs
 * the enabled checks. The command itself is driven in test/vault-settings-moved-cli.test.js; here
 * "check exits 2" is asserted as a finding of severity error.
 *
 * Expected values are typed by hand from the sample vault's yaml after the move and from the pin's
 * rules, never read from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { contextFromSite } = require('../src/cli/check');
const { buildCheckContext } = require('../src/checks/context');
const { runChecks } = require('../src/checks/run');
const carry = require('../src/checks/carry');
const { isHeldByVault } = carry;
const { runExcludeSectionsDivergence, runExcludeDirsDivergence, runExcludeFieldsDivergence, runSettingsFault } = require('../src/checks/configdiv');
const pinned = require('../src/generator/pinned');
const { moveVaultCopy, replaceYamlFolderMap } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const CARRY_IDS = ['config/pack-hiding-not-carried', 'config/pack-setting-not-carried', 'config/pack-setting-differs', 'config/folder-map-not-carried', 'config/folder-map-missing'];
// The context is built with the campaign name 'x'.
const CARRY_HINT = 'Run "gm-scriptorium carry x" to move it into the vault\'s settings.';

function writePack(root, pack) {
  const dir = path.join(root, 'pack');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vault.config.json');
  fs.writeFileSync(file, JSON.stringify(pack, null, 2));
  return file;
}

function contextOf(vault, root, pack) {
  const siteConfigPath = writePack(root, pack);
  const site = { siteSource: 'site_config', siteConfigPath, siteDir: path.dirname(siteConfigPath), packShadowed: null };
  const info = contextFromSite({ campaign: 'x', vault, site_config: siteConfigPath }, vault, site);
  return buildCheckContext({
    campaign: 'x',
    vaultPath: info.vaultPath,
    jsonConfig: info.jsonConfig,
    rawSiteConfig: info.rawSiteConfig,
    settingsLayout: info.settingsLayout,
  });
}

// A GM's moved vault has a folder map in its yaml, and a yaml without one is its own error (N1). So a
// case whose pack holds no folder map gives the yaml one (the pin's own writer, test-only); a case
// about the pack's folder map leaves the yaml without, unless its own `before` sets one.
const YAML_FOLDER_MAP = { Sessions: 'sessions', 'Characters/NPCs': 'characters/npcs' };

function findingsFor(pack, { before, yamlMap = !('folderMap' in pack) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    if (yamlMap) require('gm-apprentice-publish/lib/settings/write').applyChanges(vaultPath, [{ op: 'set', name: 'player_site.folder_map', value: YAML_FOLDER_MAP }]);
    if (before) before(vaultPath);
    const ctx = contextOf(vaultPath, root, pack);
    return { ctx, findings: runChecks(ctx) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const carryOf = (findings) => findings.filter((f) => CARRY_IDS.includes(f.id));

test('a hide entry the pack holds and the yaml lacks is one error finding, and no settings-fault repeats it', () => {
  const { findings } = findingsFor({
    searchEnabled: true,
    excludeSections: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile', 'Pack Only Secret'],
  });
  const found = findings.filter((f) => f.id === 'config/pack-hiding-not-carried');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].category, 'config');
  assert.deepEqual(found[0].data, { packKey: 'excludeSections', setting: 'player_site.hide.sections', entries: ['Pack Only Secret'] });
  assert.ok(found[0].message.includes('Pack Only Secret'));
  assert.ok(found[0].message.endsWith(CARRY_HINT), found[0].message);
  assert.equal(findings.filter((f) => f.id === 'config/settings-fault').length, 0);
});

test('the same hide list in another order, and a list the yaml already covers, give no finding', () => {
  const { findings } = findingsFor({
    searchEnabled: true,
    excludeSections: ['Handoff to Reconcile', 'GM Notes', 'Reconciliation Context', 'DM Notes', 'Source References', 'Player Notes'],
  });
  assert.deepEqual(carryOf(findings), []);
  assert.equal(findings.filter((f) => f.id === 'config/settings-fault').length, 0);
});

test('a pack folder the yaml lacks is an error, and one the yaml has under another spelling is held', () => {
  const lacking = findingsFor({ searchEnabled: true, excludeDirs: ['_meta', 'Pack Folder/'] }).findings;
  const found = lacking.filter((f) => f.id === 'config/pack-hiding-not-carried');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.deepEqual(found[0].data.entries, ['Pack Folder/']);
  assert.equal(found[0].data.setting, 'player_site.hide.folders');

  const spelt = findingsFor({ searchEnabled: true, excludeDirs: ['./_meta/', '_Templates'] }).findings;
  assert.deepEqual(carryOf(spelt), []);
});

test('a pack title unlike the yaml title is one warning that says the vault value is used', () => {
  const { findings } = findingsFor(
    { searchEnabled: true, siteTitle: 'Pack Title' },
    { before: (vault) => {
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('player_site:\n', 'player_site:\n  title: "The Long Lease"\n'));
    } },
  );
  const found = carryOf(findings);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'config/pack-setting-differs');
  assert.equal(found[0].severity, 'warn');
  assert.deepEqual(found[0].data, { packKey: 'siteTitle', setting: 'player_site.title' });
  assert.ok(found[0].message.includes('The Long Lease'), found[0].message);
  assert.ok(found[0].message.includes('Pack Title'), found[0].message);
  assert.ok(found[0].message.endsWith(CARRY_HINT), found[0].message);
});

test('a pack folder map when the yaml has none is one folder-map error, and not also a not-carried warning', () => {
  const { findings } = findingsFor({ searchEnabled: true, folderMap: { Places: 'places' } });
  const found = carryOf(findings);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'config/folder-map-not-carried');
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].category, 'config');
  assert.deepEqual(found[0].data, { packKey: 'folderMap', setting: 'player_site.folder_map' });
  assert.equal(
    found[0].message,
    'The folder map is still only in the pack (its vault.config.json), so the build would publish none of the mapped folders. Run "gm-scriptorium carry x" to move it into _meta/vault-config.yaml.',
  );
});

test('the folder-map error names the pack file when the context knows it, and names the carry for the pack in the vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    const inVault = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    const ctx = { ...contextOf(vaultPath, root, { searchEnabled: true, folderMap: { Places: 'places' } }), packConfigPath: inVault };
    const found = runChecks(ctx).filter((f) => f.id === 'config/folder-map-not-carried');
    assert.equal(found.length, 1);
    assert.equal(
      found[0].message,
      `The folder map is still only in the pack (${inVault}), so the build would publish none of the mapped folders. Run "gm-scriptorium carry x" to move it into _meta/vault-config.yaml.`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a site config that is not the pack in the vault: every carry finding says to move the setting by hand, and calls it the site config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    // Test-only: the pin's own writer gives the yaml a title for the pack's to differ from.
    require('gm-apprentice-publish/lib/settings/write').applyChanges(vaultPath, [{ op: 'set', name: 'player_site.title', value: 'Vault Title' }]);
    const outside = '/some/site/vault.config.json';
    const ctx = {
      ...contextOf(vaultPath, root, {
        footer: 'Pack footer',
        siteTitle: 'Other Title',
        folderMap: { Places: 'places' },
        excludeSections: ['GM Notes', 'Pack Only Secret'],
      }),
      packConfigPath: outside,
    };
    const byId = Object.fromEntries(carryOf(runChecks(ctx)).map((f) => [`${f.id} ${f.data.packKey}`, f.message]));
    const HAND = 'Move it into _meta/vault-config.yaml by hand: the carry only rewrites the pack in the vault.';
    assert.deepEqual(byId, {
      'config/folder-map-not-carried folderMap':
        `The folder map is still only in the site config (${outside}), so the build would publish none of the mapped folders. ${HAND}`,
      'config/pack-hiding-not-carried excludeSections':
        `excludeSections in the site config hides more than the vault's settings do (player_site.hide.sections), and the build no longer reads the site config, so "Pack Only Secret" would be published. ${HAND}`,
      'config/pack-setting-not-carried footer':
        `footer in the site config is "Pack footer", but the vault's settings do not set player_site.footer, so the site config's value is not used. ${HAND}`,
      'config/pack-setting-differs siteTitle':
        `siteTitle in the site config is "Other Title", but the vault's settings set player_site.title to "Vault Title"; the vault's value is used. ${HAND}`,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pack folder map when the yaml holds a folder map, even a different one, is not a folder-map error', () => {
  const { findings } = findingsFor({ searchEnabled: true, folderMap: { Places: 'places' } }, {
    before: (vault) => {
      // Test-only: the pin's own writer sets what the vault already holds.
      require('gm-apprentice-publish/lib/settings/write').applyChanges(vault, [{ op: 'set', name: 'player_site.folder_map', value: { Sites: 'sites' } }]);
    },
  });
  assert.deepEqual(findings.filter((f) => f.id === 'config/folder-map-not-carried'), []);
  assert.deepEqual(carryOf(findings).map((f) => f.id), ['config/pack-setting-differs']);
});

test('landingTagline in the pack is never reported, because the pin no longer reads it', () => {
  const { findings } = findingsFor({ searchEnabled: true, landingTagline: 'A tagline nobody reads' });
  assert.deepEqual(carryOf(findings), []);
});

test('excludeCallouts less strict than the vault\'s is held, and a stricter one is an error', () => {
  const held = findingsFor({ searchEnabled: true, excludeCallouts: false }).findings;
  assert.deepEqual(carryOf(held), []);
  const lax = findingsFor({ searchEnabled: true, excludeCallouts: ['spoiler'] }, {
    before: (vault) => {
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    mode: player\n', '    mode: player\n    callouts: true\n'));
    },
  }).findings;
  assert.deepEqual(carryOf(lax), []);
  const strict = findingsFor({ searchEnabled: true, excludeCallouts: true }, {
    before: (vault) => {
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    mode: player\n', '    mode: player\n    callouts: false\n'));
    },
  }).findings;
  const found = strict.filter((f) => f.id === 'config/pack-hiding-not-carried');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].data.packKey, 'excludeCallouts');
});

test('a legacy-layout vault gets none of the three ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const pack = { searchEnabled: true, excludeDirs: ['_meta', 'Pack Folder'], folderMap: { Locations: 'locations' }, excludeSections: ['Pack Only Secret'], siteTitle: 'Pack Title' };
    const siteConfigPath = writePack(root, pack);
    const site = { siteSource: 'site_config', siteConfigPath, siteDir: path.dirname(siteConfigPath), packShadowed: null };
    const info = contextFromSite({ campaign: 'x', vault: SAMPLE, site_config: siteConfigPath }, SAMPLE, site);
    assert.equal(info.settingsLayout, 'legacy');
    const ctx = buildCheckContext({ campaign: 'x', vaultPath: SAMPLE, jsonConfig: info.jsonConfig, rawSiteConfig: info.rawSiteConfig, settingsLayout: info.settingsLayout });
    assert.deepEqual(carryOf(runChecks(ctx)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a yaml the pin cannot parse is one settings-fault error naming the file, and the carry checks add nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    const file = path.join(vaultPath, '_meta', 'vault-config.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('folders: ["_meta", "_Templates"]', 'folders: ["_meta", "_Templates"'));
    const pack = { searchEnabled: true, excludeSections: ['Pack Only Secret'] };
    // The context is built (the CLI reports the file as a finding), it does not throw.
    const ctx = contextOf(vaultPath, root, pack);
    const findings = runChecks(ctx);
    const faults = findings.filter((f) => f.id === 'config/settings-fault');
    assert.equal(faults.length, 1);
    assert.equal(faults[0].severity, 'error');
    assert.equal(faults[0].path, '_meta/vault-config.yaml');
    assert.match(faults[0].message, /^_meta\/vault-config\.yaml is not valid YAML: .* The build will not run until this is fixed\.$/);
    assert.deepEqual(carryOf(findings), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an error that is not the yaml\'s parse failure is not turned into a finding: it propagates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  const realResolve = pinned.resolveSiteConfig;
  const realRead = pinned.readPublishSettings;
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    const pack = { searchEnabled: true };
    pinned.resolveSiteConfig = () => {
      throw new Error('the disk went away');
    };
    assert.throws(() => contextOf(vaultPath, root, pack), /the disk went away/);
    pinned.resolveSiteConfig = realResolve;
    const ctx = contextOf(vaultPath, root, pack);
    // Throws only for the real read (a yaml present), so the retry without settings cannot hide it.
    pinned.readPublishSettings = (vault, site, files) => {
      if (files.yaml === null) return realRead(vault, site, files);
      throw new Error('the disk went away again');
    };
    assert.throws(() => buildCheckContext({ campaign: 'x', vaultPath, jsonConfig: ctx.jsonConfig, rawSiteConfig: ctx.rawSiteConfig, settingsLayout: 'new' }), /the disk went away again/);
  } finally {
    pinned.resolveSiteConfig = realResolve;
    pinned.readPublishSettings = realRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('callouts: the pin keeps the vault\'s value unless the pack is stricter, in the pin\'s own argument order', () => {
  assert.equal(isHeldByVault('excludeCallouts', ['b'], ['a', 'b']), true);
  assert.equal(isHeldByVault('excludeCallouts', ['Spoiler'], ['spoiler']), true);
  assert.equal(isHeldByVault('excludeCallouts', 'yes', true), true);
  assert.equal(isHeldByVault('excludeCallouts', ['a'], false), false);
  assert.equal(isHeldByVault('excludeCallouts', ['a', 'c'], ['a']), false);
  assert.equal(isHeldByVault('excludeCallouts', true, ['a']), false);
});

test('sections are held as the build matches headings: case does not matter, a different name does', () => {
  assert.equal(isHeldByVault('excludeSections', ['gm notes'], ['GM Notes']), true);
  assert.equal(isHeldByVault('excludeSections', ['GM Notes', 'Secrets'], ['GM Notes']), false);
  assert.equal(isHeldByVault('excludeSections', ['GM Notes'], ['GM Notes']), true);
  // The build reads a hide-list name through its first reading only: this one is "Display", not "Real Name".
  assert.equal(isHeldByVault('excludeSections', ['[[Real Name|Display]]'], ['Real Name']), false);
  assert.equal(isHeldByVault('excludeSections', ['[[Real Name|Display]]'], ['Display']), true);
  assert.equal(isHeldByVault('excludeSections', ['Real Name'], ['[[Real Name|Display]]']), false);
  // A zero-width space inside a name is taken out, so it reads as the plain name.
  assert.equal(isHeldByVault('excludeSections', ['GM\u200bNotes'], ['GMNotes']), true);
});

test('the carry findings are worked out once per context, not once per id', (t) => {
  const fresh = findingsFor({ searchEnabled: true, excludeSections: ['Pack Only Secret'] }).ctx;
  const ctx = { ...fresh }; // a new object, so nothing is cached for it yet
  const spy = t.mock.method(pinned, 'settingFaults');
  carry.runPackHidingNotCarried(ctx);
  carry.runPackSettingNotCarried(ctx);
  carry.runPackSettingDiffers(ctx);
  assert.equal(spy.mock.callCount(), 1);
});

test('isHeldByVault: arrays by entry, callouts by stricterness, objects by key, the rest by equality', () => {
  assert.equal(isHeldByVault('excludeSections', ['a'], ['b', 'a']), true);
  assert.equal(isHeldByVault('excludeSections', ['a', 'c'], ['b', 'a']), false);
  assert.equal(isHeldByVault('excludeDirs', ['./Notes/'], ['Notes']), true);
  assert.equal(isHeldByVault('excludeCallouts', false, true), true);
  assert.equal(isHeldByVault('excludeCallouts', true, false), false);
  assert.equal(isHeldByVault('folderMap', { a: 'x' }, { a: 'x', b: 'y' }), true);
  assert.equal(isHeldByVault('folderMap', { a: 'x' }, { a: 'z' }), false);
  assert.equal(isHeldByVault('siteTitle', 'T', 'T'), true);
  assert.equal(isHeldByVault('siteTitle', 'T', 'U'), false);
});

function ctxWithShortYamlLists() {
  return findingsFor(
    { searchEnabled: true, excludeSections: ['Pack Only Secret'], excludeFields: ['pack_only_field'], excludeDirs: ['Pack Folder'] },
    { before: (vault) => {
      // A yaml that names fewer sections and fields than the defaults: its lists replace the defaults.
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      const text = fs.readFileSync(file, 'utf8')
        .replace(/ {4}sections: \[.*\]\n/, '    sections: ["GM Notes"]\n')
        .replace(/ {4}fields: \[.*\]\n/, '    fields: ["secrets"]\n');
      fs.writeFileSync(file, text);
    } },
  ).ctx;
}

test('the exclude-dirs divergence compares the pack with the vault: silent on a moved vault, speaks on the same context read as legacy', () => {
  const ctx = ctxWithShortYamlLists();
  assert.equal(ctx.settingsLayout, 'new');
  // The pack holds a folder the yaml lacks.
  const moved = { ...ctx, jsonConfig: { ...ctx.jsonConfig, excludeDirs: ['Pack Folder'] } };
  const legacy = { ...moved, settingsLayout: 'legacy' };
  assert.deepEqual(runExcludeDirsDivergence(moved), []);
  assert.ok(runExcludeDirsDivergence(legacy).length > 0);
});

test('a yaml hide list that drops a default is reported on a moved vault, naming the yaml', () => {
  const ctx = ctxWithShortYamlLists();
  assert.equal(ctx.settingsLayout, 'new');
  const sections = runExcludeSectionsDivergence(ctx).filter((f) => f.data.section === 'DM Notes');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].severity, 'warn');
  assert.equal(
    sections[0].message,
    '"## DM Notes" is one of the default excluded sections, but _meta/vault-config.yaml supplies its own exclude_sections list, which replaces the defaults instead of extending them, so it is no longer excluded',
  );
  const fields = runExcludeFieldsDivergence(ctx).filter((f) => f.data.field === 'gm_notes');
  assert.equal(fields.length, 1);
  assert.equal(
    fields[0].message,
    'default excluded field "gm_notes" is no longer filtered; the _meta/vault-config.yaml exclude_fields list replaced the default list instead of extending it',
  );
});

test('settings-fault leaves out only the site-file hide faults the carry check owns', () => {
  const { ctx } = findingsFor({ searchEnabled: true, excludeSections: ['Pack Only Secret'] });
  assert.ok(ctx.publishSet.stops.some((s) => s.kind === 'old-name' && s.source === 'site'), 'the pin does stop on it');
  assert.deepEqual(runSettingsFault(ctx), []);
  const other = { ...ctx, publishSet: { ...ctx.publishSet, stops: [{ kind: 'not-allowed', name: 'publish.mode', setting: 'player_site.hide.mode', level: 'stop', message: 'x' }] } };
  assert.equal(runSettingsFault(other).length, 1);
});

test('settingEntry gives the registry entry, whose old site name for the tagline is marked not read', () => {
  const entry = pinned.settingEntry('player_site.theme.tagline');
  const was = entry.was.find((w) => w.in === 'site' && w.name === 'landingTagline');
  assert.equal(was.read, false);
});

/** Writes a value the pin cannot read into the moved yaml, under player_site. */
const unreadableYaml = (line) => (vault) => {
  const file = path.join(vault, '_meta', 'vault-config.yaml');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('player_site:\n'));
  fs.writeFileSync(file, text.replace('player_site:\n', `player_site:\n${line}\n`));
};

test('a yaml folder map the pin cannot read, with a pack folder map: one folder-map-missing error that says to fix the yaml, not to carry', () => {
  const { findings, ctx } = findingsFor({ folderMap: { Places: 'places' } }, { before: unreadableYaml('  folder_map: "not a map"') });
  assert.deepEqual(carryOf(findings).map((f) => f.id), ['config/folder-map-missing']);
  const found = findings.find((f) => f.id === 'config/folder-map-missing');
  assert.equal(found.severity, 'error');
  assert.equal(
    found.message,
    'player_site.folder_map in _meta/vault-config.yaml is "not a map", which cannot be read, so the build would publish none of the mapped folders. ' +
      'The folder map in the pack is not read either. Fix player_site.folder_map in _meta/vault-config.yaml; the carry leaves it as it is.',
  );
  assert.ok(ctx);
});

test('a yaml title the pin cannot read, with a pack title: a warning that names the yaml value and keeps it', () => {
  const { findings } = findingsFor({ siteTitle: 'Pack Title' }, { before: unreadableYaml('  title: ["a", "b"]') });
  const found = carryOf(findings).filter((f) => f.data.packKey === 'siteTitle');
  assert.deepEqual(found.map((f) => [f.id, f.severity]), [['config/pack-setting-differs', 'warn']]);
  assert.equal(
    found[0].message,
    'siteTitle in the pack is "Pack Title", but the vault\'s settings set player_site.title to ["a","b"], which cannot be read. ' +
      'The carry leaves it as it is: fix player_site.title in _meta/vault-config.yaml.',
  );
});

/** A carried moved copy of the sample (the pack folded in, then left as `pack`), its context, and its findings. */
function carriedFindings(pack, { yamlMap, configPath } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
    if (yamlMap !== undefined) replaceYamlFolderMap(vaultPath, yamlMap);
    const packFile = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    fs.writeFileSync(packFile, JSON.stringify(pack, null, 2));
    const site = { siteSource: 'pack', siteConfigPath: packFile, siteDir: path.dirname(packFile), packShadowed: null };
    const info = contextFromSite({ campaign: 'x', vault: vaultPath }, vaultPath, site);
    const ctx = buildCheckContext({
      campaign: 'x',
      vaultPath: info.vaultPath,
      jsonConfig: info.jsonConfig,
      rawSiteConfig: info.rawSiteConfig,
      settingsLayout: info.settingsLayout,
      packConfigPath: packFile,
      configPath: configPath ? configPath(root) : null,
    });
    return { root, findings: runChecks(ctx) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('N1: a carried vault whose yaml folder map cannot be read is a folder-map-missing error, with an empty pack', () => {
  const { findings } = carriedFindings({}, { yamlMap: '  folder_map: "Sessions"' });
  const found = findings.filter((f) => f.id === 'config/folder-map-missing');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(
    found[0].message,
    'player_site.folder_map in _meta/vault-config.yaml is "Sessions", which cannot be read, so the build would publish none of the vault\'s folders. Fix player_site.folder_map in _meta/vault-config.yaml.',
  );
});

test('N1: a carried vault whose yaml has no folder map is a folder-map-missing error, with an empty pack', () => {
  const { findings } = carriedFindings({}, { yamlMap: null });
  const found = findings.filter((f) => f.id === 'config/folder-map-missing');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(
    found[0].message,
    '_meta/vault-config.yaml sets no player_site.folder_map, so the build would publish none of the vault\'s folders. Set player_site.folder_map in _meta/vault-config.yaml.',
  );
});

/** The missing-map finding for a carried vault whose yaml lost its map, with these files in its backups folder. */
function missingWithBackups(files) {
  let dir;
  const { findings } = carriedFindings({}, {
    yamlMap: null,
    configPath: (root) => {
      const cfg = path.join(root, 'cfg', 'config.toml');
      dir = path.join(root, 'cfg', 'backups', 'campaign-x');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cfg, 'config_version = 1\n');
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
      return cfg;
    },
  });
  const found = findings.filter((f) => f.id === 'config/folder-map-missing');
  assert.equal(found.length, 1);
  return { message: found[0].message, dir };
}

const MISSING_LEAD = "_meta/vault-config.yaml sets no player_site.folder_map, so the build would publish none of the vault's folders. Set player_site.folder_map in _meta/vault-config.yaml";
const YAML_NO_MAP = 'version: 1\n\nplayer_site:\n  title: "Old"\n';
const YAML_WITH_MAP = 'version: 1\n\nplayer_site:\n  folder_map:\n    Sessions: sessions\n';

test('R1: a yaml backup that holds a folder map is named, the newest of those that do', () => {
  const { message, dir } = missingWithBackups({
    'vault-config-20261029T100000000Z-aaaaaa.yaml.bak': YAML_WITH_MAP,
    'vault-config-20261030T100000000Z-bbbbbb.yaml.bak': YAML_WITH_MAP,
    'vault-config-20261031T100000000Z-cccccc.yaml.bak': YAML_NO_MAP,
    'vault.config-20261030T100000000Z-dddddd.json.bak': '{"folderMap": {"Sessions": "sessions"}}',
  });
  assert.equal(message, `${MISSING_LEAD}, or restore it from the copy of that file kept at ${path.join(dir, 'vault-config-20261030T100000000Z-bbbbbb.yaml.bak')}.`);
});

test('R1: with no yaml backup holding a folder map, the pack backup that holds folderMap is named', () => {
  const { message, dir } = missingWithBackups({
    'vault-config-20261030T100000000Z-aaaaaa.yaml.bak': YAML_NO_MAP,
    'vault.config-20261030T100000000Z-bbbbbb.json.bak': '{"siteTitle": "Old", "folderMap": {"Sessions": "sessions"}}',
    'vault.config-20261031T100000000Z-cccccc.json.bak': '{}',
  });
  assert.equal(message, `${MISSING_LEAD}. The pack's folderMap as it was before the carry is kept at ${path.join(dir, 'vault.config-20261030T100000000Z-bbbbbb.json.bak')}.`);
});

test('R1: backups that hold no folder map give no restore hint', () => {
  const { message } = missingWithBackups({
    'vault-config-20261030T100000000Z-aaaaaa.yaml.bak': YAML_NO_MAP,
    'vault.config-20261030T100000000Z-bbbbbb.json.bak': '{"siteTitle": "Old"}',
  });
  assert.equal(message, `${MISSING_LEAD}.`);
});

test('N1: a carried vault with a readable yaml folder map has no folder-map-missing error (control)', () => {
  const { findings } = carriedFindings({});
  assert.deepEqual(findings.filter((f) => f.id === 'config/folder-map-missing'), []);
});

test('item 4: a pack siteUrl the yaml does not set is one not-carried warning that says the pack is still read for now', () => {
  const { findings } = carriedFindings({ siteUrl: 'https://example.org/longlease/' });
  const found = carryOf(findings);
  assert.deepEqual(found.map((f) => [f.id, f.severity, f.data.packKey]), [['config/pack-setting-not-carried', 'warn', 'siteUrl']]);
  assert.equal(
    found[0].message,
    'siteUrl in the pack is "https://example.org/longlease/". The generator still reads it from the pack for now, but it belongs in player_site.url in _meta/vault-config.yaml. Run "gm-scriptorium carry x" to move it there.',
  );
});

test('item 4: a pack site-folder key equal to its built-in value, or outputDir, gives no warning', () => {
  const { findings } = carriedFindings({ preserveDirs: [], outputDir: 'site-out' });
  assert.deepEqual(carryOf(findings), []);
});

/** A carried vault whose yaml sets player_site.url (the pin's own writer, test-only), with this pack. */
function withYamlUrl(pack, url, edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
    require('gm-apprentice-publish/lib/settings/write').applyChanges(vaultPath, [{ op: 'set', name: 'player_site.url', value: url }]);
    if (edit) {
      const yamlFile = path.join(vaultPath, '_meta', 'vault-config.yaml');
      fs.writeFileSync(yamlFile, edit(fs.readFileSync(yamlFile, 'utf8')));
    }
    const packFile = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    fs.writeFileSync(packFile, JSON.stringify(pack, null, 2));
    const site = { siteSource: 'pack', siteConfigPath: packFile, siteDir: path.dirname(packFile), packShadowed: null };
    const info = contextFromSite({ campaign: 'x', vault: vaultPath }, vaultPath, site);
    const ctx = buildCheckContext({
      campaign: 'x', vaultPath: info.vaultPath, jsonConfig: info.jsonConfig, rawSiteConfig: info.rawSiteConfig,
      settingsLayout: info.settingsLayout, packConfigPath: packFile,
    });
    return runChecks(ctx);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('R2: a pack siteUrl unlike the yaml\'s player_site.url is one differs warning: the vault\'s value is used', () => {
  const found = carryOf(withYamlUrl({ siteUrl: 'https://example.org/pack/' }, 'https://example.org/yaml/'));
  assert.deepEqual(found.map((f) => [f.id, f.severity, f.data.packKey]), [['config/pack-setting-differs', 'warn', 'siteUrl']]);
  assert.equal(
    found[0].message,
    'siteUrl in the pack is "https://example.org/pack/", but the vault\'s settings set player_site.url to "https://example.org/yaml/"; the vault\'s value is used. Run "gm-scriptorium carry x" to move it into the vault\'s settings.',
  );
});

test('R2: a pack siteUrl equal to the yaml\'s player_site.url gives no warning', () => {
  assert.deepEqual(carryOf(withYamlUrl({ siteUrl: 'https://example.org/same/' }, 'https://example.org/same/')), []);
});

test('a pack host unlike a yaml player_site.host the generator cannot read names the yaml value and says to fix it there, not to carry', () => {
  const found = carryOf(withYamlUrl({ host: 'cloudflare-pages' }, 'https://example.org/yaml/', (text) => text.replace(/^  host: github-pages$/m, '  host: netlify')));
  assert.deepEqual(found.map((f) => [f.id, f.severity, f.data.packKey]), [['config/pack-setting-differs', 'warn', 'host']]);
  assert.equal(
    found[0].message,
    'host in the pack is "cloudflare-pages", but the vault\'s settings set player_site.host to "netlify", which cannot be read. The carry leaves it as it is: fix player_site.host in _meta/vault-config.yaml.',
  );
});
