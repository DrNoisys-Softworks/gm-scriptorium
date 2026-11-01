'use strict';

/*
 * The live "what this changes" pane compares which pages the site would publish while the GM types,
 * but only when the edit changes something that decides which pages publish (the folder map, a hide
 * list, drafts, callouts, field exceptions or the publish mode). Any other edit keeps the cheap path
 * and never scans the vault. Both layouts, through the real effects route. Expected values are typed
 * out by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { moveVaultCopy, assertMovedLayout, replaceChecked } = require('./helpers/moved-vault');
const { scratchRoot, configPathIn, startPanel, post } = require('./helpers/campaigns-panel');
const publishset = require('../src/vault/publishset');
const read = require('../src/vault/read');
const vaultconfigedit = require('../src/admin/vaultconfigedit');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function addSecretNote(vault) {
  fs.mkdirSync(path.join(vault, 'Secret'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Secret', 'Plot.md'), '---\ntitle: Plot\ntype: location\n---\n# Plot\n\nOttoline Pardew is behind it all.\n');
  const man = path.join(vault, '_meta', 'publish-manifest.md');
  fs.writeFileSync(man, replaceChecked(fs.readFileSync(man, 'utf8'), '## Publishing\n\n', '## Publishing\n\n- [x] Secret/Plot.md\n'));
}

/** A scratch campaign "lease" on one layout, with Secret/Plot.md present but not mapped. */
function campaign(t, layout) {
  const root = scratchRoot(t);
  let vault;
  if (layout === 'new') {
    vault = moveVaultCopy(SAMPLE, root, { inVaultPack: true }).vaultPath;
    assertMovedLayout(vault);
  } else {
    vault = path.join(root, 'vault');
    fs.cpSync(SAMPLE, vault, { recursive: true });
  }
  addSecretNote(vault);
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vault)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'));
  const file = layout === 'new' ? 'vault-config.yaml' : 'vault-config.md';
  return { vault, configPath, file, settings: path.join(vault, '_meta', file) };
}

/** The effects request body for the settings file's text with one replacement made. */
function effectsBody(fx, find, replace) {
  const current = fs.readFileSync(fx.settings);
  const edited = replaceChecked(current.toString('utf8'), find, replace);
  const frontmatterText = fx.file === 'vault-config.yaml' ? edited.replace(/\n$/, '') : vaultconfigedit.splitFile(Buffer.from(edited)).frontmatterText;
  return { file: fx.file, frontmatterText, baseSha256: sha(current) };
}

/** The text that maps Secret to /secret/ in this layout's own settings file. */
function mapSecret(fx) {
  if (fx.file === 'vault-config.yaml') return ['  folder_map:\n', '  folder_map:\n    Secret: secret\n'];
  // The markdown file's map replaces the pack's (no per-key merge), so it carries the whole map.
  const packMap = JSON.parse(fs.readFileSync(path.join(fx.vault, '_meta', 'scriptorium', 'vault.config.json'), 'utf8')).folderMap;
  const map = { ...packMap, Secret: 'secret' };
  return ['publish:\n', 'publish:\n  folder_map:\n' + Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`).join('')];
}

function countScans(t) {
  const original = publishset.computePublishedSet;
  const counter = { calls: 0 };
  publishset.computePublishedSet = (...args) => {
    counter.calls += 1;
    return original(...args);
  };
  t.after(() => {
    publishset.computePublishedSet = original;
  });
  return counter;
}

const publishLines = (effects) => effects.filter((e) => e.id === 'published-more' || e.id === 'folder-map-added').map((e) => [e.id, e.level, e.title, e.detail]);

for (const layout of ['legacy', 'new']) {
  test(`${layout}: the live pane names the newly mapped folder and the page it would publish`, async (t) => {
    const fx = campaign(t, layout);
    const h = await startPanel(t, { config: fx.configPath }, 'lease');
    const [find, replace] = mapSecret(fx);
    const res = await post(h, '/api/vault-config/effects', effectsBody(fx, find, replace));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.parse, { ok: true });
    assert.deepEqual(publishLines(res.json.effects), [
      ['published-more', 'bad', '1 page would be published that is not today', 'Secret/Plot.md'],
      ['folder-map-added', 'info', 'Publishes the folder Secret as /secret/', ''],
    ]);
    assert.equal(res.json.needsAck, true);
  });

  test(`${layout}: an edit that cannot change which pages publish never scans the vault in the live pane`, async (t) => {
    const fx = campaign(t, layout);
    const h = await startPanel(t, { config: fx.configPath }, 'lease');
    const scans = countScans(t);
    const res = await post(h, '/api/vault-config/effects', effectsBody(fx, '    max_npcs: 8\n', '    max_npcs: 7\n'));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.parse, { ok: true });
    assert.equal(scans.calls, 0);
    assert.deepEqual(publishLines(res.json.effects), []);
    assert.equal(res.json.needsAck, false);
  });
}

// A hide-list edit leaves the folder map alone, so only the effective publish settings can trigger the
// comparison here. The edit publishes no new page, so the pane gains no publish line either.
for (const layout of ['legacy', 'new']) {
  test(`${layout}: a hide-list edit runs the page comparison in the live pane`, async (t) => {
    const fx = campaign(t, layout);
    const h = await startPanel(t, { config: fx.configPath }, 'lease');
    const scans = countScans(t);
    const res = await post(h, '/api/vault-config/effects', effectsBody(fx, '"prep_notes", "reliability"]', '"prep_notes"]'));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.parse, { ok: true });
    assert.equal(scans.calls, 2);
    assert.deepEqual(publishLines(res.json.effects), []);
  });
}

// The live pane only informs; the review at save time is the one that fails closed. A comparison
// that throws there leaves the pane with no publish lines and no error. The hits check inside the
// comparison throws its own error class, and that is injected here too.
for (const layout of ['legacy', 'new']) {
  test(`${layout}: a page comparison that fails leaves the live pane without publish lines, and without an error`, async (t) => {
    const fx = campaign(t, layout);
    const h = await startPanel(t, { config: fx.configPath }, 'lease');
    const original = read.withCandidateFile;
    let calls = 0;
    read.withCandidateFile = (absPath, bytes, fn) => {
      calls += 1;
      // The third overlay is the comparison's candidate side (after the publish settings and the folder map).
      if (calls === 3) return { value: fn(), hits: 0 };
      return original(absPath, bytes, fn);
    };
    t.after(() => {
      read.withCandidateFile = original;
    });
    const [find, replace] = mapSecret(fx);
    const res = await post(h, '/api/vault-config/effects', effectsBody(fx, find, replace));
    assert.equal(calls, 3);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.parse, { ok: true });
    assert.deepEqual(publishLines(res.json.effects), []);
  });
}
