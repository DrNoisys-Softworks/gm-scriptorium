'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { NV } = require(path.join(__dirname, '..', 'assets', 'admin', 'nav.js'));
const { PK } = require(path.join(__dirname, '..', 'assets', 'admin', 'pack.js'));

/*
 * The panel's words on a vault whose settings gm-apprentice moved to _meta/vault-config.yaml (ADR 0071):
 * the Title & tagline and vault-config screens' nav text, and the Title & tagline layouts' summary of
 * the other settings, must not send a GM to vault.config.json or vault-config.md for settings the site
 * now reads from the yaml. The old layout's words are pinned here too, unchanged. All literals.
 */

const LEGACY_TITLE = {
  label: 'Title & tagline',
  short: 'Title & tagline',
  eyebrow: 'vault.config.json · vault-config.md',
  lede: 'The name and one-line tagline on your landing page. The name is saved in vault.config.json and the tagline in vault-config.md. The rest of both files is read-only here.',
};
const LEGACY_VC = {
  label: 'vault-config.md',
  short: 'vault-config.md',
  eyebrow: '_meta/vault-config.md',
  lede: "Your vault's own settings note. gm-apprentice and GM-Scriptorium both read it: it sets the publish mode, what stays private, the site's look and the landing page.",
};
const MOVED_TITLE = {
  label: 'Title & tagline',
  short: 'Title & tagline',
  eyebrow: '_meta/vault-config.yaml',
  lede: 'The name and one-line tagline on your landing page. This vault keeps both in _meta/vault-config.yaml, so they show here read-only. Editing them here arrives in the next update.',
};
const MOVED_VC = {
  label: 'vault-config.yaml',
  short: 'vault-config.yaml',
  eyebrow: '_meta/vault-config.yaml',
  lede: "Your vault's own settings file. gm-apprentice and GM-Scriptorium both read it. Editing it here arrives in the next update; change it in that file for now.",
};

const pick = (item) => ({ label: item.label, short: item.short, eyebrow: item.eyebrow, lede: item.lede });

test('nav text on the old layout is unchanged', () => {
  for (const layout of ['legacy', 'none', null, undefined]) {
    assert.deepEqual(pick(NV.itemFor('title', layout)), LEGACY_TITLE, String(layout));
    assert.deepEqual(pick(NV.itemFor('vault-config', layout)), LEGACY_VC, String(layout));
  }
  assert.deepEqual(pick(NV.item('title')), LEGACY_TITLE);
  assert.deepEqual(pick(NV.item('vault-config')), LEGACY_VC);
});

test('nav text on a moved vault names _meta/vault-config.yaml and never the old files', () => {
  assert.deepEqual(pick(NV.itemFor('title', 'new')), MOVED_TITLE);
  assert.deepEqual(pick(NV.itemFor('vault-config', 'new')), MOVED_VC);
  // Every other screen is the same on both layouts, and the moved items keep their id, icon and group.
  for (const id of NV.ids()) {
    if (id === 'title' || id === 'vault-config') continue;
    assert.deepEqual(NV.itemFor(id, 'new'), NV.item(id), id);
  }
  for (const id of ['title', 'vault-config']) {
    const moved = NV.itemFor(id, 'new');
    assert.equal(moved.id, id);
    assert.equal(moved.icon, NV.item(id).icon);
    assert.equal(moved.group, NV.item(id).group);
  }
});

test('the layouts\' summary on a moved vault points at _meta/vault-config.yaml', () => {
  assert.deepEqual(PK.MOVED_SUMMARY, {
    rows: [
      {
        id: 'moved',
        icon: 'file',
        name: 'Site settings',
        text: "The site's address, the folders that become sections, what's kept off the site and the art folder.",
        where: 'Set in _meta/vault-config.yaml. Change them in that file by hand.',
      },
    ],
    toggle: 'Other site settings',
    toggleSmall: 'Read-only here: set in _meta/vault-config.yaml',
    fine: 'These are set in _meta/vault-config.yaml, not in the campaign pack.',
    also: 'Also set for your site',
    alsoSmall: 'read-only, set in _meta/vault-config.yaml',
    pill: 'read-only',
  });
});

test('the layouts\' summary on the old layout is unchanged', () => {
  const raw = JSON.stringify({ siteUrl: 'https://example.org/x', host: 'github-pages', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'], excludeSections: ['GM Notes'], attachmentsDir: '_att' });
  assert.deepEqual(
    PK.summaryRows(raw).map((r) => r.where),
    [
      'Change it in vault.config.json by hand.',
      'Set up by gm-scriptorium init. Change it in vault.config.json by hand.',
      'Change it in vault.config.json by hand. The vault-config.md screen shows the lists that add to it.',
      'Set up by gm-scriptorium init. Change it in vault.config.json by hand.',
    ],
  );
});

test('the Theme screen\'s palette note names the file the palette is read from', () => {
  const mismatch = { paletteScheme: 'light', background: '#fbf6ea', theme: 'noir', themeScheme: 'dark' };
  assert.equal(PK.mismatchText(mismatch, 'legacy'), "Your vault's palette is light (#fbf6ea in vault-config.md) and noir is dark.");
  assert.equal(PK.mismatchText(mismatch, undefined), "Your vault's palette is light (#fbf6ea in vault-config.md) and noir is dark.");
  assert.equal(PK.mismatchText(mismatch, 'new'), "Your vault's palette is light (#fbf6ea in _meta/vault-config.yaml) and noir is dark.");
});
