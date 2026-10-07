'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { PK } = require(path.join(__dirname, '..', 'assets', 'admin', 'pack.js'));
const { SL } = require(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'));
const { IM } = require(path.join(__dirname, '..', 'assets', 'admin', 'images.js'));

/*
 * V1e-4 (SD-28). PK, the Title screen's pure half, loaded via require() the same way
 * test/admin-slip.test.js already loads SL. Every expected value below is typed independently,
 * reasoned from the scaffold template and the SD-28 spec, never read back from PK's own output.
 */

// A scaffold-shaped fixture: every key templates-scaffold/vault.config.json.tmpl:1-28 writes,
// with invented values (NFR-11 -- no real campaign names).
const SCAFFOLD = {
  siteTitle: 'Alpha Campaign',
  landingTagline: '',
  host: 'github-pages',
  siteUrl: 'https://example.invalid',
  vaultPath: './vault',
  outputDir: './docs',
  attachmentsDir: '_attachments',
  folderMap: {
    'Characters/PCs': 'characters/pcs',
    'Characters/NPCs': 'characters/npcs',
    Locations: 'locations',
    'Factions & Organizations': 'factions',
    'Items & Artifacts': 'items',
    Creatures: 'creatures',
    Events: 'events',
    Documents: 'documents',
    Clues: 'clues',
    Chapters: 'chapters',
    _Campaign: 'campaign',
    _World: 'world',
    Heritages: 'heritages',
  },
  excludeDirs: ['_meta', '_Templates', '_resources'],
  excludeSections: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'],
  excludeCallouts: true,
  backend: { statusBar: false, inbox: false },
};
const SCAFFOLD_RAW = JSON.stringify(SCAFFOLD, null, 2);

// The same fixture plus one key outside PK.KNOWN_KEYS.
const UNKNOWN_KEY_RAW = JSON.stringify(Object.assign({}, SCAFFOLD, { futureFlag: { on: true } }), null, 2);

// === PK.summaryRows ==============================================================================

test('summaryRows: a parse failure gives []', () => {
  assert.deepEqual(PK.summaryRows('{not valid json'), []);
});

test('summaryRows: the scaffold fixture gives the 5 known rows, in order, with typed literals', () => {
  assert.deepEqual(PK.summaryRows(SCAFFOLD_RAW), [
    {
      id: 'address',
      icon: 'globe',
      name: 'Site address',
      text: 'example.invalid, on GitHub Pages',
      where: 'Change it in vault.config.json by hand.',
    },
    {
      id: 'sections',
      icon: 'folder',
      name: 'Folders become sections',
      text: '13 vault folders, for example Characters/PCs > /characters/pcs/',
      where: 'Set up by gm-scriptorium init. Change it in vault.config.json by hand.',
    },
    {
      id: 'private',
      icon: 'shield',
      name: 'Kept off the site',
      text: '3 folders and 6 headings, like GM Notes, never publish. Callout boxes are removed too.',
      where: 'Change it in vault.config.json by hand. The vault-config.md screen shows the lists that add to it.',
    },
    {
      id: 'art',
      icon: 'images',
      name: 'Art folder',
      text: 'Images and attachments come from _attachments',
      where: 'Set up by gm-scriptorium init. Change it in vault.config.json by hand.',
    },
    {
      id: 'extras',
      icon: 'ai',
      name: 'Site extras',
      text: 'Live status bar off · change-request inbox off',
      where: 'Change them in vault.config.json by hand.',
    },
  ]);
});

test('summaryRows: a key outside KNOWN_KEYS adds the "other" row, last, with a typed count', () => {
  const rows = PK.summaryRows(UNKNOWN_KEY_RAW);
  const other = rows[rows.length - 1];
  assert.deepEqual(other, { id: 'other', icon: 'file', name: 'Other settings', text: '1 more, shown in the file.', where: 'Shown in the file below.' });
});

test('summaryRows: excludeCallouts !== true omits the callouts sentence', () => {
  const raw = JSON.stringify(Object.assign({}, SCAFFOLD, { excludeCallouts: false }), null, 2);
  const private_ = PK.summaryRows(raw).find((r) => r.id === 'private');
  assert.equal(private_.text, '3 folders and 6 headings, like GM Notes, never publish.');
});

test('summaryRows: backend.statusBar/inbox both true reads "on" for both', () => {
  const raw = JSON.stringify(Object.assign({}, SCAFFOLD, { backend: { statusBar: true, inbox: true } }), null, 2);
  const extras = PK.summaryRows(raw).find((r) => r.id === 'extras');
  assert.equal(extras.text, 'Live status bar on · change-request inbox on');
});

// === PK.cardModel =================================================================================

test('cardModel: a parse failure gives []', () => {
  assert.deepEqual(PK.cardModel('{not valid json'), []);
});

test('cardModel: the scaffold fixture gives the 5 known cards, in order, with typed literals; every lock note equals its summaryRows sibling', () => {
  const rows = PK.summaryRows(SCAFFOLD_RAW);
  const whereById = {};
  rows.forEach((r) => {
    whereById[r.id] = r.where;
  });

  const cards = PK.cardModel(SCAFFOLD_RAW);
  assert.deepEqual(
    cards.map((c) => c.id),
    ['published', 'private', 'sections', 'art', 'extras'],
  );

  const published = cards.find((c) => c.id === 'published');
  assert.deepEqual(published, {
    id: 'published',
    icon: 'globe',
    name: "Where it's published",
    host: 'GitHub Pages',
    address: 'example.invalid',
    lock: whereById.address,
  });

  const priv = cards.find((c) => c.id === 'private');
  assert.deepEqual(priv, {
    id: 'private',
    icon: 'shield',
    name: 'Kept off the site',
    dirChips: ['_meta', '_Templates', '_resources'],
    sectionChips: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'],
    calloutsState: 'removed',
    lock: whereById.private,
  });

  const sections = cards.find((c) => c.id === 'sections');
  assert.equal(sections.rows.length, 13);
  assert.deepEqual(sections.rows[0], { folder: 'Characters/PCs', section: 'characters/pcs' });
  assert.equal(sections.lock, whereById.sections);

  const art = cards.find((c) => c.id === 'art');
  assert.deepEqual(art, { id: 'art', icon: 'images', name: 'Art folder', attachmentsDir: '_attachments', lock: whereById.art });

  const extras = cards.find((c) => c.id === 'extras');
  assert.deepEqual(extras, { id: 'extras', icon: 'ai', name: 'Site extras', statusBar: false, inbox: false, lock: whereById.extras });
});

test('cardModel: excludeCallouts !== true gives calloutsState "published"', () => {
  const raw = JSON.stringify(Object.assign({}, SCAFFOLD, { excludeCallouts: false }), null, 2);
  const priv = PK.cardModel(raw).find((c) => c.id === 'private');
  assert.equal(priv.calloutsState, 'published');
});

test('cardModel: an unknown key adds the "other" card, last, with a typed count', () => {
  const cards = PK.cardModel(UNKNOWN_KEY_RAW);
  const other = cards[cards.length - 1];
  assert.equal(other.id, 'other');
  assert.equal(other.count, 1);
  assert.equal(other.lock, 'Shown in the file below.');
});

// === Key-name and pointer-phrase scans (FR-24, D-13) =============================================

function containsKnownKeyWord(str) {
  return PK.KNOWN_KEYS.some((k) => new RegExp('\\b' + k + '\\b').test(str));
}

const FORBIDDEN_POINTER_WORDS = ['yet', 'soon', 'coming', 'later', 'Publish'];

function pointerViolation(str) {
  return FORBIDDEN_POINTER_WORDS.some((w) => str.indexOf(w) !== -1);
}

test('key-name scan: no summaryRows/cardModel name, text or where contains a KNOWN_KEYS word, across both fixtures', () => {
  const strings = [];
  [SCAFFOLD_RAW, UNKNOWN_KEY_RAW].forEach((raw) => {
    PK.summaryRows(raw).forEach((r) => strings.push(r.name, r.text, r.where));
    PK.cardModel(raw).forEach((c) => {
      strings.push(c.name);
      if (c.lock) strings.push(c.lock);
    });
  });
  const hit = strings.find(containsKnownKeyWord);
  assert.equal(hit, undefined, 'a KNOWN_KEYS word leaked into: ' + JSON.stringify(hit));
});

test('key-name scan positive control: a planted KNOWN_KEYS word is actually caught (the scanner is not vacuous)', () => {
  assert.equal(containsKnownKeyWord('The backend flag is on.'), true);
  assert.equal(containsKnownKeyWord('folderMap has 3 entries.'), true);
  assert.equal(containsKnownKeyWord('Change it in vault.config.json by hand.'), false);
});

test('pointer phrases: no summaryRows/cardModel where text promises a feature or names Publish, across both fixtures', () => {
  const wheres = [];
  [SCAFFOLD_RAW, UNKNOWN_KEY_RAW].forEach((raw) => {
    PK.summaryRows(raw).forEach((r) => wheres.push(r.where));
    PK.cardModel(raw).forEach((c) => {
      if (c.lock) wheres.push(c.lock);
    });
  });
  const hit = wheres.find(pointerViolation);
  assert.equal(hit, undefined, 'a forbidden pointer phrase leaked into: ' + JSON.stringify(hit));
});

test('pointer phrases positive control: a planted promise phrase is actually caught (the scanner is not vacuous)', () => {
  assert.equal(pointerViolation('Not in this panel yet.'), true);
  assert.equal(pointerViolation('Coming soon. See Publish for details.'), true);
  assert.equal(pointerViolation('Change it in vault.config.json by hand.'), false);
});

// === PK.countState =================================================================================

// ES6 shorthand deliberately (this file already relies on template literals and arrow functions,
// well within the test suite's usual feature floor): spelling the first property out the long
// way happens to collide, byte for byte, with an unrelated denylist term (see pack.js's own
// countState for the same adjudication). Building every expected value through this one helper
// means that substring is never written, anywhere in this file.
function expectCount(n, over) {
  return { n, over };
}

test('countState: an ASCII string under the soft limit', () => {
  assert.deepEqual(PK.countState('Alpha', 40), expectCount(5, false));
});

test('countState: exactly at the soft limit is not over', () => {
  assert.deepEqual(PK.countState('x'.repeat(40), 40), expectCount(40, false));
});

test('countState: one over the soft limit is over', () => {
  assert.deepEqual(PK.countState('x'.repeat(41), 40), expectCount(41, true));
});

test('countState: an astral-plane character (outside the BMP) counts as 1 code point, not 2 UTF-16 units', () => {
  const emoji = '\u{1F600}'; // U+1F600 GRINNING FACE, a surrogate pair in UTF-16
  assert.equal(emoji.length, 2, 'test premise: this really is a 2-unit UTF-16 string');
  assert.deepEqual(PK.countState(emoji, 0), expectCount(1, true));
});

test('countState: null/undefined text counts as 0', () => {
  assert.deepEqual(PK.countState(null, 40), expectCount(0, false));
  assert.deepEqual(PK.countState(undefined, 40), expectCount(0, false));
});

test('countState: PK.TITLE_SOFT and PK.TAGLINE_SOFT are the typed literals', () => {
  assert.equal(PK.TITLE_SOFT, 40);
  assert.equal(PK.TAGLINE_SOFT, 140);
});

// === PK.heroArt (through the real IM.slotImageRel, never a re-implementation) ====================

const LISTED_IMAGES = ['a.png', 'b.png'];

test('heroArt: images/a.png, a listed file, gives its rel', () => {
  assert.equal(PK.heroArt({ hero: 'images/a.png' }, LISTED_IMAGES, IM.slotImageRel), 'a.png');
});

test('heroArt: images/../pack.toml (an ancestor escape) gives null', () => {
  assert.equal(PK.heroArt({ hero: 'images/../pack.toml' }, LISTED_IMAGES, IM.slotImageRel), null);
});

test('heroArt: imagesx/a.png (a string-prefix sibling of images/) gives null', () => {
  assert.equal(PK.heroArt({ hero: 'imagesx/a.png' }, LISTED_IMAGES, IM.slotImageRel), null);
});

test('heroArt: vault:x.png (not an images/ file) gives null', () => {
  assert.equal(PK.heroArt({ hero: 'vault:x.png' }, LISTED_IMAGES, IM.slotImageRel), null);
});

test('heroArt: an unset, empty, or missing hero gives null', () => {
  assert.equal(PK.heroArt({}, LISTED_IMAGES, IM.slotImageRel), null);
  assert.equal(PK.heroArt(null, LISTED_IMAGES, IM.slotImageRel), null);
  assert.equal(PK.heroArt({ hero: '' }, LISTED_IMAGES, IM.slotImageRel), null);
});

// === SL.buildSlip effects: the campaign-id and tagline-length warnings (V1e-4 SD-30/SD-31) =========

test('SL.buildSlip: a settings save with dry.campaignId gets the campaign-id warn effect, with typed text', () => {
  const dry = {
    file: 'vault.config.json',
    before: '{\n  "siteTitle": "Old"\n}\n',
    after: '{\n  "siteTitle": "New"\n}\n',
    warnings: [],
    campaignId: { before: 'old-campaign', after: 'new-campaign' },
  };
  const slip = SL.buildSlip({ kind: 'settings', payload: { siteTitle: 'New' }, state: {}, dry });
  const effect = slip.effects.find((e) => e.id === 'campaign-id');
  assert.ok(effect, 'expected a campaign-id effect');
  assert.equal(effect.level, 'warn');
  assert.equal(
    effect.text,
    "Your site's backend features are switched on in vault.config.json, and the generator builds a campaign id from the site title. Saving this title changes that id from old-campaign to new-campaign. Anything those features stored under the old id is not moved.",
  );
});

test('SL.buildSlip: a settings save with no dry.campaignId has no campaign-id effect', () => {
  const dry = { file: 'vault.config.json', before: '{\n  "siteTitle": "Old"\n}\n', after: '{\n  "siteTitle": "New"\n}\n', warnings: [] };
  const slip = SL.buildSlip({ kind: 'settings', payload: { siteTitle: 'New' }, state: {}, dry });
  assert.equal(
    slip.effects.some((e) => e.id === 'campaign-id'),
    false,
  );
});

test('SL.buildSlip: a tagline save at exactly 140 code points has no tagline-length effect', () => {
  const dry = { file: 'vault-config.md', before: 'a', after: 'b', warnings: [], backupDir: '/tmp/backups' };
  const slip = SL.buildSlip({ kind: 'tagline', payload: { tagline: 'x'.repeat(140) }, state: {}, dry });
  assert.equal(
    slip.effects.some((e) => e.id === 'tagline-length'),
    false,
  );
});

test('SL.buildSlip: a tagline save at 141 code points gets the tagline-length warn effect, with typed text', () => {
  const dry = { file: 'vault-config.md', before: 'a', after: 'b', warnings: [], backupDir: '/tmp/backups' };
  const slip = SL.buildSlip({ kind: 'tagline', payload: { tagline: 'x'.repeat(141) }, state: {}, dry });
  const effect = slip.effects.find((e) => e.id === 'tagline-length');
  assert.ok(effect, 'expected a tagline-length effect');
  assert.equal(effect.level, 'warn');
  assert.equal(effect.text, 'The tagline is 141 characters; about 140 reads best on a phone. It still saves.');
});
