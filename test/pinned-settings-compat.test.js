'use strict';

/*
 * At publish-v1.26.0 the pin no longer exports three things Scriptorium used: PUBLISH_DEFAULTS,
 * resolveGenrePreset, and normalizeExcludeDir from lib/config.js. The facade
 * (src/generator/pinned.js) now rebuilds or re-requires them from the pin's settings registry. The
 * expected values below are typed out by hand from what publish-v1.21.0 exported (its
 * lib/config.js PUBLISH_DEFAULTS and lib/theme.js resolveGenrePreset, run against the 1.21.0
 * release tarball), never read from the code under test. Two keys differ on purpose: the pin added
 * landing.max_events (default 4) and retired four_oh_four.style.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const pinned = require('../src/generator/pinned');

const EXPECTED_DEFAULTS = {
  mode: 'player',
  exclude_drafts: false,
  exclude_callouts: false,
  exclude_sections: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'],
  exclude_fields: ['secrets', 'current_plan', 'plan_progress', 'gm_notes', 'prep_notes', 'reliability'],
  exclude_dirs: ['_meta', '_Templates'],
  search: true,
  attachments_dir: '_attachments',
  folder_map: {},
  landing: {
    recency_window: 3,
    max_npcs: 6,
    max_locations: 4,
    max_events: 4,
    featured_npcs: [],
    featured_locations: [],
    quick_links: [],
  },
  theme: {
    genre: null,
    palette: { primary: '#1a2f3a', accent: '#3d8a7a', background: '#e8f0f3', text: '#1a1a1a' },
    fonts: { heading: 'system-ui', body: 'system-ui', source: 'google', files: [] },
    campaign_image: null,
    default_mode: 'system',
  },
  four_oh_four: { message: 'This page is not available.' },
  images: { optimize: false, format: 'webp', max_width: 1600, quality: 82 },
  overrides: { fields: {} },
  section_titles: {},
};

test('PUBLISH_DEFAULTS equals publish-v1.21.0\'s, plus landing.max_events and without four_oh_four.style', () => {
  assert.deepEqual(pinned.PUBLISH_DEFAULTS, EXPECTED_DEFAULTS);
});

test('PUBLISH_DEFAULTS is frozen all the way down, so no caller can change another caller\'s defaults', () => {
  assert.ok(Object.isFrozen(pinned.PUBLISH_DEFAULTS));
  assert.ok(Object.isFrozen(pinned.PUBLISH_DEFAULTS.exclude_sections));
  assert.ok(Object.isFrozen(pinned.PUBLISH_DEFAULTS.theme.palette));
});

test('resolveGenrePreset gives what publish-v1.21.0 gave for each input', () => {
  const cases = [
    ['Horror', 'horror'],
    ['  noir ', 'noir'],
    ['fantasy', 'fantasy'],
    ['sci-fi', 'scifi'],
    ['scifi', 'scifi'],
    ['cyberpunk', null],
    ['military', 'military'],
    ['western', null],
    ['', null],
    [null, null],
    [undefined, null],
    ['nonesuch', null],
    ['HORROR', 'horror'],
    ['gothic', 'horror'],
    ['space', 'scifi'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(pinned.resolveGenrePreset(input), expected, `resolveGenrePreset(${JSON.stringify(input)})`);
  }
});

test('normalizeExcludeDir drops an absolute folder outside the vault without throwing, when told to be quiet', () => {
  const vault = path.resolve('/vaults/campaign');
  assert.equal(pinned.normalizeExcludeDir(path.resolve('/elsewhere/Secrets'), vault, false), null);
  assert.equal(pinned.normalizeExcludeDir('Secrets/', vault, false), 'Secrets');
  assert.equal(pinned.normalizeExcludeDir('./GM\\Stuff', vault, false), 'GM/Stuff');
  assert.equal(pinned.normalizeExcludeDir(path.join(vault, 'Private'), vault, false), 'Private');
});

// ---- ADR 0071: the settings reader and the carry, through the facade ----

const fs = require('fs');
const os = require('os');
const { moveVaultCopy } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const PACK = JSON.parse(fs.readFileSync(path.join(SAMPLE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-compat-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// `withPack` also folds the sample's pack into the yaml, as the carry does, so the title is in it.
function movedSample(t, withPack = false) {
  const s = scratch();
  t.after(s.done);
  const { vaultPath } = moveVaultCopy(SAMPLE, s.dir, withPack ? { siteConfig: PACK } : {});
  const yaml = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.yaml'), 'utf8');
  return { s, vaultPath, yaml };
}

test('settingsLayoutOf says new for a moved copy and legacy for the sample', (t) => {
  const { vaultPath } = movedSample(t);
  assert.equal(pinned.settingsLayoutOf(vaultPath), 'new');
  assert.equal(pinned.settingsLayoutOf(SAMPLE), 'legacy');
});

test('resolveSiteConfig takes the title from the vault yaml, not the pack', (t) => {
  const { vaultPath, yaml } = movedSample(t, true);
  const { config } = pinned.resolveSiteConfig(vaultPath, { ...PACK, siteTitle: 'Pack Title' }, { md: null, yaml });
  assert.equal(config.siteTitle, 'The Long Lease');
});

test('settingFaults on a moved copy stops on a pack hiding list the vault does not hold', (t) => {
  const { vaultPath, yaml } = movedSample(t);
  const faults = pinned.settingFaults(vaultPath, { ...PACK, excludeSections: ['Pack Only Secret'] }, { md: null, yaml });
  const hit = faults.find((f) => f.level === 'stop' && f.kind === 'old-name' && f.name === 'excludeSections');
  assert.ok(hit, JSON.stringify(faults));
});

test('stripMovedSettings takes the pin\'s moved keys out and leaves the rest', () => {
  const out = pinned.stripMovedSettings({ siteTitle: 'x', excludeDirs: [], vaultPath: '/v' });
  assert.deepEqual(out.config, { vaultPath: '/v' });
  assert.ok(out.removed.includes('siteTitle'));
  assert.ok(out.removed.includes('excludeDirs'));
});

test('stripMovedSettings takes out the site-folder keys and the nested backend names, and does not change its input', () => {
  const input = { siteUrl: 'u', host: 'h', backend: { statusBar: false, inbox: true }, fourOhFour: { message: 'm', style: 's' }, landingTagline: 't', other: 1 };
  const out = pinned.stripMovedSettings(input);
  assert.deepEqual(out.config, { other: 1 });
  for (const k of ['siteUrl', 'host', 'backend.statusBar', 'backend.inbox', 'fourOhFour.message', 'fourOhFour.style', 'landingTagline']) {
    assert.ok(out.removed.includes(k), `${k} in ${out.removed}`);
  }
  assert.deepEqual(input, { siteUrl: 'u', host: 'h', backend: { statusBar: false, inbox: true }, fourOhFour: { message: 'm', style: 's' }, landingTagline: 't', other: 1 });
});

test('stricterCallouts is exported and picks the stricter value', () => {
  assert.equal(pinned.stricterCallouts(true, ['note']), true);
  assert.equal(pinned.stricterCallouts(['note'], true), true);
  assert.deepEqual(pinned.stricterCallouts(['note'], ['warning']), ['note', 'warning']);
  assert.deepEqual(pinned.stricterCallouts(false, ['warning']), ['warning']);
  assert.equal(pinned.stricterCallouts(false, false), false);
});

test('readPublishSettings serves the yaml text it is given and treats null as absent', (t) => {
  const { vaultPath, yaml } = movedSample(t, true);
  const served = pinned.readPublishSettings(vaultPath, {}, { md: null, yaml });
  assert.equal(served.config.site_title, 'The Long Lease');
  const absent = pinned.readPublishSettings(SAMPLE, {}, { md: null, yaml: null });
  assert.equal(absent.config.layout, 'none');
});

test('stripMovedSettings empties the sample pack, as the pin plan does', () => {
  // The pin's planMove takes every key of the sample pack out (checked by hand against
  // its "Will remove the settings from ..." line): all of them, landingTagline included.
  assert.deepEqual(pinned.stripMovedSettings(PACK).config, {});
});
