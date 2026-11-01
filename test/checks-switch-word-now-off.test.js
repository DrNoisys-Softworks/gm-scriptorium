'use strict';

/*
 * config/switch-word-now-off: up to GM-Scriptorium 0.5.0 (generator publish-v1.21.0) any text value of
 * publish.exclude_drafts or publish.exclude_callouts counted as on, so `no`, `off` and "false" HID the
 * drafts or callouts. From publish-v1.26.0 they are switch words that mean off, so those pages and
 * callouts now publish. The check warns, in plain words, naming the setting and the value. The cases
 * below are typed as literals; none is read from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');
const { withScratch: withCliScratch, run, SAMPLE } = require('./helpers/b4-cli');

const ID = 'config/switch-word-now-off';

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function withScratch(publishBlock, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-switch-word-'));
  try {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), `---\ntype: meta\npublish:\n${publishBlock}\n---\n\nnotes\n`);
    const site = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
    delete site.vaultPath;
    delete site.outputDir;
    const siteConfigPath = path.join(dir, 'site', 'vault.config.json');
    fs.mkdirSync(path.dirname(siteConfigPath), { recursive: true });
    fs.writeFileSync(siteConfigPath, JSON.stringify(site, null, 2));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      'config_version = 1', 'default_campaign = "fixture"', '', '[campaigns.fixture]',
      `vault = '${vaultDir}'`, `site_config = '${siteConfigPath}'`, `output = '${path.join(dir, 'out')}'`,
    ].join('\n'));
    return fn({ configPath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function findings(publishBlock) {
  return withScratch(publishBlock, ({ configPath }) => {
    const { runCheckCommand } = requireFresh('../src/cli/check');
    return runCheckCommand({ config: configPath }, 'fixture').envelope.findings.filter((f) => f.id === ID);
  });
}

const draftMessage = (word) => `publish.exclude_drafts is ${word}. Up to GM-Scriptorium 0.5.0 this hid draft pages; it now means off, so draft pages are published. Set it to true to hide them, or false to keep publishing them and silence this warning.`;
const calloutMessage = (word) => `publish.exclude_callouts is ${word}. Up to GM-Scriptorium 0.5.0 this hid callouts; it now means off, so callouts are published. Set it to true to hide them, or false to keep publishing them and silence this warning.`;

for (const [yamlValue, shown] of [['no', '"no"'], ['off', '"off"'], ['"false"', '"false"']]) {
  test(`exclude_drafts: ${yamlValue} warns`, () => {
    const found = findings(`  mode: player\n  exclude_drafts: ${yamlValue}`);
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'warn');
    assert.equal(found[0].category, 'config');
    assert.equal(found[0].path, '_meta/vault-config.md');
    assert.equal(found[0].message, draftMessage(shown));
  });
}

test('exclude_callouts: no warns, in the callouts words', () => {
  const found = findings('  mode: player\n  exclude_callouts: "no"');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.equal(found[0].message, calloutMessage('"no"'));
});

test('both settings off-words give two warnings', () => {
  const found = findings('  mode: player\n  exclude_drafts: off\n  exclude_callouts: off');
  assert.deepEqual(found.map((f) => f.message).sort(), [calloutMessage('"off"'), draftMessage('"off"')].sort());
});

for (const [yamlValue] of [['false'], ['true'], ['yes'], ['"true"'], ['[secret]']]) {
  test(`exclude_drafts: ${yamlValue} does not warn`, () => {
    assert.equal(findings(`  mode: player\n  exclude_drafts: ${yamlValue}`).length, 0);
  });
}

test('exclude_callouts: a list of types and an absent setting do not warn', () => {
  assert.equal(findings('  mode: player\n  exclude_callouts: [secret]').length, 0);
  assert.equal(findings('  mode: player').length, 0);
});

// A DRAFT page, ticked under Publishing in the manifest (player mode publishes only what is listed).
function addDraftPage(vault) {
  fs.writeFileSync(
    path.join(vault, 'Characters', 'NPCs', 'Draft Ferryman.md'),
    '---\ntype: npc\ntitle: Draft Ferryman\ncampaign: "The Long Lease"\ncanon_status: DRAFT\nstatus: alive\n---\n\nA ferryman who is not yet canon.\n',
  );
  const manifest = path.join(vault, '_meta', 'publish-manifest.md');
  const text = fs.readFileSync(manifest, 'utf8');
  assert.match(text, /^## Publishing\n\n/m, 'the sample manifest changed shape; fix this test');
  fs.writeFileSync(manifest, text.replace(/^## Publishing\n\n/m, '## Publishing\n\n- [x] Characters/NPCs/Draft Ferryman.md\n'));
}

test('end to end: exclude_drafts: no warns in check (exit 0) and the build does publish the draft page', () => {
  withCliScratch((root) => {
    const vault = path.join(root, 'v');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    const cfgFile = path.join(vault, '_meta', 'vault-config.md');
    const text = fs.readFileSync(cfgFile, 'utf8');
    assert.match(text, /^ {2}mode: player$/m, 'the sample no longer says mode: player; fix this test');
    fs.writeFileSync(cfgFile, text.replace(/^ {2}mode: player$/m, '  mode: player\n  exclude_drafts: no'));
    addDraftPage(vault);
    fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\ndefault_campaign = "t"\n\n[campaigns.t]\nvault = '${vault}'\noutput = '${path.join(root, 'site')}'\n`);

    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    assert.match(checked.all, /config\/switch-word-now-off/);
    assert.match(checked.all, /publish\.exclude_drafts is "no"\. Up to GM-Scriptorium 0\.5\.0 this hid draft pages/);

    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    const pages = fs.readdirSync(path.join(root, 'site'), { recursive: true }).filter((p) => /draft-ferryman\.html$/.test(p));
    assert.equal(pages.length, 1, 'the draft page is published when exclude_drafts is off');
  });
});

test('control: exclude_drafts: true hides the same page, so the end-to-end test above is not vacuous', () => {
  withCliScratch((root) => {
    const vault = path.join(root, 'v');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    const cfgFile = path.join(vault, '_meta', 'vault-config.md');
    fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace(/^ {2}mode: player$/m, '  mode: player\n  exclude_drafts: true'));
    addDraftPage(vault);
    fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\ndefault_campaign = "t"\n\n[campaigns.t]\nvault = '${vault}'\noutput = '${path.join(root, 'site')}'\n`);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    const pages = fs.readdirSync(path.join(root, 'site'), { recursive: true }).filter((p) => /draft-ferryman\.html$/.test(p));
    assert.equal(pages.length, 0);
    assert.doesNotMatch(run(root, ['check']).all, /WARN config\/switch-word-now-off/);
  });
});
