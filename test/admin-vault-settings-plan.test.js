'use strict';

/*
 * src/admin/vaultsettingsplan.js on a moved copy of the sample. Every expected value is typed out
 * here, never read from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../src/generator/pinned');
const plan = require('../src/admin/vaultsettingsplan');
const { moveVaultCopy, replaceChecked } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

function fixture(edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsplan-'));
  const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
  let text = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.yaml'), 'utf8');
  if (edit) text = edit(text);
  return { vaultPath, text, Y: Buffer.from(text, 'utf8') };
}

function changedLines(beforeText, afterBuf) {
  const b = beforeText.split('\n');
  const a = afterBuf.toString('utf8').split('\n');
  assert.equal(a.length, b.length, 'line count changed');
  return a.filter((l, i) => l !== b[i]);
}

const BLOCK = (t) => replaceChecked(t,
  '    fields: ["secrets", "current_plan", "plan_progress", "gm_notes", "prep_notes", "reliability"]\n',
  '    fields:\n      - secrets   # the big one\n      - current_plan\n      # a note between items\n      - plan_progress\n      - gm_notes\n      - prep_notes\n      - reliability\n');

test('YAML_FIELD_SCHEMA: the seven new names in order, keyed by the old ones', () => {
  assert.deepEqual(plan.YAML_FIELD_SCHEMA.map((f) => f.path), [
    'player_site.hide.fields', 'player_site.hide.sections', 'player_site.hide.folders',
    'player_site.landing.featured_npcs', 'player_site.landing.quick_links', 'player_site.landing.max_npcs',
    'player_site.not_found',
  ]);
  assert.equal(plan.YAML_FIELD_SCHEMA[0].key, 'publish.exclude_fields');
  assert.equal(plan.YAML_FIELD_SCHEMA[6].key, 'publish.four_oh_four.message');
  assert.equal(plan.YAML_FIELD_SCHEMA[5].max, 100);
  assert.ok(Object.isFrozen(plan.YAML_FIELD_SCHEMA));
  assert.equal(plan.YAML_FIELD_BY_PATH.get('player_site.hide.folders').label, 'Hidden folders');
});

test('YAML_DISPLAY_PATHS: mode shows only when set, banners moved, palette and fonts are parents', () => {
  assert.deepEqual(plan.YAML_DISPLAY_PATHS.map((d) => d.path), [
    'player_site.hide.mode', 'player_site.theme.palette', 'player_site.theme.fonts',
    'player_site.theme.campaign_image', 'player_site.theme.genre', 'player_site.lists.banners',
  ]);
  assert.equal(plan.YAML_DISPLAY_PATHS[0].showIfSet, true);
  assert.equal(plan.YAML_DISPLAY_PATHS[1].showIfSet, undefined);
  assert.ok(Object.isFrozen(plan.YAML_DISPLAY_PATHS));
});

test('hidden fields plus one new entry plans one add and changes one line', () => {
  const { vaultPath, text, Y } = fixture();
  const out = plan.planFieldEdits(vaultPath, Y, {
    'player_site.hide.fields': ['secrets', 'current_plan', 'plan_progress', 'gm_notes', 'prep_notes', 'reliability', 'new_secret'],
  });
  assert.deepEqual(out.changed, ['player_site.hide.fields']);
  const lines = changedLines(text, out.bytes);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /new_secret/);
  assert.equal(pinned.parseSettingsText(vaultPath, out.bytes).data.player_site.hide.fields.pop(), 'new_secret');
});

test('block list with comments: a removal keeps the lines outside and both comments', () => {
  const { vaultPath, text, Y } = fixture(BLOCK);
  const out = plan.planFieldEdits(vaultPath, Y, {
    'player_site.hide.fields': ['secrets', 'current_plan', 'plan_progress', 'prep_notes', 'reliability'],
  });
  const before = text.split('\n');
  const after = out.bytes.toString('utf8').split('\n');
  const start = before.indexOf('    fields:');
  const endB = start + 1 + before.slice(start + 1).findIndex((l) => !/^\s{6}/.test(l));
  const tail = before.length - endB;
  assert.deepEqual(after.slice(0, start), before.slice(0, start));
  assert.deepEqual(after.slice(after.length - tail), before.slice(endB));
  const inside = after.slice(start, after.length - tail).join('\n');
  assert.ok(inside.includes('# the big one'));
  assert.ok(inside.includes('# a note between items'));
  assert.ok(!inside.includes('gm_notes'));
});

test('block list with comments: a reorder is refused with the literal message', () => {
  const { vaultPath, Y } = fixture(BLOCK);
  const edits = { 'player_site.hide.fields': ['gm_notes', 'secrets'] };
  assert.throws(() => plan.planFieldEdits(vaultPath, Y, edits), (e) => {
    assert.ok(e instanceof pinned.SettingsPlanError);
    assert.equal(e.kind, 'refused');
    assert.equal(e.message, 'Hidden fields: this list has comments inside it, and a new order would drop them. Use "Edit as text instead".');
    return true;
  });
});

test('a reorder of a flow list with no comments plans a set in the new order', () => {
  const { vaultPath, Y } = fixture();
  const out = plan.planFieldEdits(vaultPath, Y, { 'player_site.landing.featured_npcs': ['Queen Hesper', 'Orpiment'] });
  assert.deepEqual(pinned.parseSettingsText(vaultPath, out.bytes).data.player_site.landing.featured_npcs, ['Queen Hesper', 'Orpiment']);
});

test('scalars: max_npcs and the not-found message plan a set', () => {
  const { vaultPath, Y } = fixture();
  const out = plan.planFieldEdits(vaultPath, Y, { 'player_site.landing.max_npcs': 3, 'player_site.not_found': 'Gone.' });
  const d = pinned.parseSettingsText(vaultPath, out.bytes).data.player_site;
  assert.equal(d.landing.max_npcs, 3);
  assert.equal(d.not_found, 'Gone.');
});

test('listChanges: shapes', () => {
  const T = 'a:\n  b: [x, y]\n';
  assert.deepEqual(plan.listChanges('a.b', undefined, ['x'], T, 'L'), [{ op: 'set', name: 'a.b', value: ['x'] }]);
  assert.deepEqual(plan.listChanges('a.b', ['x', 'y'], ['x', 'z'], T, 'L'), [
    { op: 'remove', name: 'a.b', entries: ['y'] }, { op: 'add', name: 'a.b', entries: ['z'] }]);
  assert.deepEqual(plan.listChanges('a.b', ['x', 'y'], ['y', 'x'], T, 'L'), [{ op: 'set', name: 'a.b', value: ['y', 'x'] }]);
  assert.deepEqual(plan.listChanges('a.b', ['x', 'y'], ['x', 'y'], T, 'L'), []);
});

test('title and tagline change exactly two lines; an empty tagline removes its line', () => {
  const { vaultPath, text, Y } = fixture();
  const both = plan.planTitleTagline(vaultPath, Y, { title: 'New', tagline: 'Tag' });
  assert.deepEqual(changedLines(text, both.bytes), ['  title: New', '    tagline: "Tag"']);
  const gone = plan.planTitleTagline(vaultPath, Y, { tagline: '' });
  assert.ok(!/^\s+tagline:/m.test(gone.bytes.toString('utf8')));
  assert.equal(gone.bytes.toString('utf8').split('\n').length, text.split('\n').length - 1);
});

test('put back adds one entry', () => {
  const { vaultPath, text, Y } = fixture();
  const out = plan.planPutBack(vaultPath, Y, { path: 'player_site.hide.folders', entry: 'Drafts' });
  assert.deepEqual(pinned.parseSettingsText(vaultPath, out.bytes).data.player_site.hide.folders, ['_meta', '_Templates', 'Drafts']);
  assert.equal(changedLines(text, out.bytes).length, 1);
});

test('CRLF stays on every line, and a BOM stays', () => {
  const { vaultPath, text } = fixture();
  const crlf = Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8');
  const out = plan.planFieldEdits(vaultPath, crlf, { 'player_site.landing.max_npcs': 3 });
  const s = out.bytes.toString('utf8');
  assert.equal(s.replace(/\r\n/g, '').includes('\n'), false, 'a bare LF appeared');
  assert.equal(s.replace(/\r\n/g, '').includes('\r'), false);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  const out2 = plan.planFieldEdits(vaultPath, bom, { 'player_site.landing.max_npcs': 3 });
  assert.deepEqual([...out2.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});
