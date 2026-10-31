'use strict';

/*
 * The facade's planner and reader for _meta/vault-config.yaml (src/generator/pinned.js:
 * planSettingsText, parseSettingsText and the registry helpers). Every expected value is typed out
 * here, never read from the code under test.
 *
 * Tests that pass today and so prove nothing about the facade: the vault-config.md-beside case is a
 * regression guard only, because the facade serves any non-string `md` as absent, so no plausible
 * mutation makes the planner read the markdown file on disk.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../src/generator/pinned');
const { moveVaultCopy } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-plan-'));
  const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
  const yamlPath = path.join(vaultPath, '_meta', 'vault-config.yaml');
  return { root, vaultPath, yamlPath, Y: fs.readFileSync(yamlPath) };
}

function throwsPlan(fn, kind) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof pinned.SettingsPlanError, `expected a SettingsPlanError, got ${e && e.stack}`);
    assert.equal(e.kind, kind, e.message);
    return e;
  }
  assert.fail(`expected a SettingsPlanError of kind ${kind}`);
  return null;
}

test('planSettingsText: two sets change exactly two lines', () => {
  const { vaultPath, Y } = fixture();
  const plan = pinned.planSettingsText(vaultPath, Y, [
    { op: 'set', name: 'player_site.title', value: 'New' },
    { op: 'set', name: 'player_site.theme.tagline', value: 'Tag' },
  ]);
  assert.deepEqual(plan.changed, ['player_site.title', 'player_site.theme.tagline']);
  const before = Y.toString('utf8').split('\n');
  const after = plan.after.toString('utf8').split('\n');
  assert.equal(after.length, before.length);
  const changedLines = after.filter((line, i) => line !== before[i]);
  assert.deepEqual(changedLines, ['  title: New', '    tagline: "Tag"']);
});

test('planSettingsText: plans from the served text, not the disk, and writes nothing', () => {
  const { vaultPath, yamlPath, Y } = fixture();
  const served = Buffer.from(Y.toString('utf8').replace('max_npcs: 8', 'max_npcs: 9  # served'), 'utf8');
  assert.notDeepEqual(served, Y);
  const plan = pinned.planSettingsText(vaultPath, served, [{ op: 'set', name: 'player_site.landing.max_npcs', value: 3 }]);
  assert.ok(plan.after.toString('utf8').includes('max_npcs: 3  # served'));
  assert.ok(fs.readFileSync(yamlPath).equals(Y), 'the planner wrote to the disk file');
});

test('planSettingsText: a vault-config.md beside the yaml is not read (guard; proves nothing today)', () => {
  const { vaultPath, Y } = fixture();
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\nsite_title: Old\n---\n');
  const plan = pinned.planSettingsText(vaultPath, Y, [{ op: 'set', name: 'player_site.title', value: 'Z' }]);
  assert.ok(plan.after.toString('utf8').includes('title: Z'));
});

test('planSettingsText: refuses what is not valid UTF-8', () => {
  const { vaultPath } = fixture();
  const e = throwsPlan(() => pinned.planSettingsText(vaultPath, Buffer.from([0x74, 0x3a, 0x20, 0xff, 0x0a]), [{ op: 'set', name: 'player_site.title', value: 'A' }]), 'not-utf8');
  assert.equal(e.message, "_meta/vault-config.yaml isn't valid UTF-8 text, so the panel won't change it.");
});

test('planSettingsText: unreadable files are kind unreadable', () => {
  const { vaultPath } = fixture();
  const change = [{ op: 'set', name: 'player_site.title', value: 'A' }];
  const broken = throwsPlan(() => pinned.planSettingsText(vaultPath, Buffer.from('player_site:\n  title: [\n'), change), 'unreadable');
  assert.equal(typeof broken.line, 'number');
  throwsPlan(() => pinned.planSettingsText(vaultPath, Buffer.from('- a\n- b\n'), change), 'unreadable');
  throwsPlan(() => pinned.planSettingsText(vaultPath, Buffer.from('version: 2\n'), change), 'unreadable');
});

test('planSettingsText: a value the pin refuses is kind refused, with its reasons', () => {
  const { vaultPath, Y } = fixture();
  const e = throwsPlan(() => pinned.planSettingsText(vaultPath, Y, [{ op: 'set', name: 'player_site.landing.max_npcs', value: 'abc' }]), 'refused');
  assert.match(e.refusals[0], /whole number/);
});

test('parseSettingsText: the file\'s own tree, and not-ok for unreadable text', () => {
  const { vaultPath, Y } = fixture();
  const ok = pinned.parseSettingsText(vaultPath, Y);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.player_site.title, 'The Long Lease');
  const stripped = Buffer.from(Y.toString('utf8').replace('    max_npcs: 8\n', ''), 'utf8');
  const noDefault = pinned.parseSettingsText(vaultPath, stripped);
  assert.equal(noDefault.ok, true);
  assert.equal('max_npcs' in noDefault.data.player_site.landing, false, 'a registry default leaked into the file\'s own tree');
  for (const bad of ['player_site:\n  title: [\n', '- a\n- b\n', 'version: 2\n']) {
    const r = pinned.parseSettingsText(vaultPath, Buffer.from(bad));
    assert.equal(r.ok, false, bad);
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
  }
  assert.equal(pinned.parseSettingsText(vaultPath, Buffer.from([0xff])).ok, false);
  assert.equal(typeof pinned.parseSettingsText(vaultPath, Buffer.from('player_site:\n  title: [\n')).line, 'number');
});

test('settingsNameMap: new names and the old names they were', () => {
  const map = pinned.settingsNameMap();
  const expected = {
    'player_site.hide.fields': 'publish.exclude_fields',
    'player_site.hide.sections': 'publish.exclude_sections',
    'player_site.hide.folders': 'publish.exclude_dirs',
    'player_site.landing.featured_npcs': 'publish.landing.featured_npcs',
    'player_site.landing.quick_links': 'publish.landing.quick_links',
    'player_site.landing.max_npcs': 'publish.landing.max_npcs',
    'player_site.not_found': 'publish.four_oh_four.message',
    'player_site.folder_map': 'publish.folder_map',
    'player_site.hide.field_exceptions': 'publish.overrides.fields',
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(map.oldNameOf[k], v, k);
  assert.ok(map.leaves.includes('player_site.sheets.header_facts'));
  assert.ok(!map.leaves.includes('player_site'), 'a parent is not a leaf');
  assert.ok(Object.isFrozen(map) && Object.isFrozen(map.leaves) && Object.isFrozen(map.oldNameOf));
  assert.equal(pinned.settingsNameMap(), map, 'built once');
});

test('settingFieldInfo: the registry\'s words, and a throw for an unknown name', () => {
  assert.deepEqual(pinned.settingFieldInfo('player_site.hide.folders'), {
    name: 'player_site.hide.folders',
    does: 'Vault folders never published',
    leftOut: '`_meta`, `_Templates`',
  });
  assert.throws(() => pinned.settingFieldInfo('player_site.nonesuch'));
});

test('commandSettingNames: the four command lists', () => {
  assert.deepEqual([...pinned.commandSettingNames()].sort(),
    ['player_site.before_build', 'player_site.after_build', 'gm_site.before_build', 'gm_site.after_build'].sort());
});

test('settingsCommentsInside: a comment in the setting\'s own text only', () => {
  assert.equal(pinned.settingsCommentsInside('player_site:\n  hide:\n    fields:\n      - a   # c\n      - b\n', 'player_site.hide.fields'), true);
  const { Y } = fixture();
  const text = Y.toString('utf8');
  assert.equal(pinned.settingsCommentsInside(text, 'player_site.hide.folders'), false);
  assert.equal(pinned.settingsCommentsInside(text, 'player_site.hide.sections'), false);
  assert.equal(pinned.settingsCommentsInside(text, 'player_site.nothing.here'), false);
  assert.equal(pinned.settingsCommentsInside('player_site:\n  title: "a # b"\n', 'player_site.title'), false);
});
