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
