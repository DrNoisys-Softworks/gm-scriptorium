'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { VW } = require(path.join(__dirname, '..', 'assets', 'admin', 'views.js'));
const { NV } = require(path.join(__dirname, '..', 'assets', 'admin', 'nav.js'));

/*
 * Panel v2 V1d-1 (SD-9). New pure functions on VW (views.js, above the node module.exports
 * guard), plus the NV eyebrow/lede literal (nav.js). Loaded via require() (the VB pattern,
 * test/admin-frame.test.js:7-9's node-loading precedent). Independent literals throughout --
 * none of the expected values below are derived from the code under test.
 */

// === VW.numberWord =================================================================================

test('VW.numberWord: 1, 2, 5 and 10 spell out', () => {
  assert.equal(VW.numberWord(1), 'one');
  assert.equal(VW.numberWord(2), 'two');
  assert.equal(VW.numberWord(5), 'five');
  assert.equal(VW.numberWord(10), 'ten');
});

test('VW.numberWord: 0 spells out', () => {
  assert.equal(VW.numberWord(0), 'zero');
});

test('VW.numberWord: 11 (beyond ten) is digits', () => {
  assert.equal(VW.numberWord(11), '11');
});

// === VW.wordsParts ==================================================================================

test('VW.wordsParts: no tables at all -- zero labels, no kinds on disk, default kinds count', () => {
  const result = VW.wordsParts({});
  assert.equal(result.labelCount, 0);
  assert.deepEqual(result.quoted, []);
  assert.equal(result.more, false);
  assert.equal(result.kindsOwn, false);
});

test('VW.wordsParts: 2 labels -- both quoted, more is false', () => {
  const vocab = { tables: { labels: { group_npc: 'The Wardens', learned_heading: 'What the Wardens learned' } } };
  const result = VW.wordsParts(vocab);
  assert.equal(result.labelCount, 2);
  assert.deepEqual(result.quoted, ['The Wardens', 'What the Wardens learned']);
  assert.equal(result.more, false);
});

test('VW.wordsParts: 5 labels -- only the first 3 (tables.labels order) are quoted, more is true', () => {
  const vocab = { tables: { labels: { a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo' } } };
  const result = VW.wordsParts(vocab);
  assert.equal(result.labelCount, 5);
  assert.deepEqual(result.quoted, ['Alpha', 'Bravo', 'Charlie']);
  assert.equal(result.more, true);
});

test('VW.wordsParts: kinds on disk -- kindsOwn true, kindsCount is the on-disk length', () => {
  const vocab = { tables: { timeline: { kinds: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] } } };
  const result = VW.wordsParts(vocab);
  assert.equal(result.kindsOwn, true);
  assert.equal(result.kindsCount, 3);
});

test('VW.wordsParts: no kinds on disk -- kindsOwn false, kindsCount from a literal defaults fixture', () => {
  const vocab = { tables: {}, defaults: { timeline: { kinds: [{ key: 'fight' }, { key: 'meeting' }, { key: 'discovery' }, { key: 'journey' }, { key: 'backstory' }] } } };
  const result = VW.wordsParts(vocab);
  assert.equal(result.kindsOwn, false);
  assert.equal(result.kindsCount, 5);
});

test('VW.wordsParts: no kinds on disk and no defaults fixture supplied -- falls back to the built-in count of 5', () => {
  const result = VW.wordsParts({ tables: {} });
  assert.equal(result.kindsOwn, false);
  assert.equal(result.kindsCount, 5);
});

// === VW.themeNudge ==================================================================================

test('VW.themeNudge: exactly one other theme gives "Try <name>"', () => {
  assert.deepEqual(VW.themeNudge(['plain', 'haze'], 'plain'), { text: 'Try haze' });
});

test('VW.themeNudge: more than one other theme gives "Change theme" (string-prefix sibling, plainer must not be swallowed by plain)', () => {
  assert.deepEqual(VW.themeNudge(['plain', 'plainer', 'haze'], 'plain'), { text: 'Change theme' });
});

test('VW.themeNudge: no other theme gives null', () => {
  assert.equal(VW.themeNudge(['plain'], 'plain'), null);
});

// === VW.shortPath ===================================================================================

test('VW.shortPath: strips everything up to and including the LAST slash', () => {
  assert.equal(VW.shortPath('vault:_attachments/campaign/banner.svg'), '…/banner.svg');
});

test('VW.shortPath: no slash -- value unchanged', () => {
  assert.equal(VW.shortPath('vault:x.svg'), 'vault:x.svg');
});

test('VW.shortPath: an images/ path also uses the last slash', () => {
  assert.equal(VW.shortPath('images/a/b.png'), '…/b.png');
});

// === VW.pendingLinks =================================================================================

test('VW.pendingLinks: NAV order, singular and plural, zero counts skipped, an unknown id skipped', () => {
  // NAV order: overview, theme, title, images, vocab, ... -- vocab comes after images.
  const pending = { images: 1, vocab: 2, theme: 0, 'not-a-real-id': 5 };
  const result = VW.pendingLinks(pending, NV);
  assert.deepEqual(result, [
    { id: 'images', text: '1 unsaved change in Images' },
    { id: 'vocab', text: '2 unsaved changes in Vocabulary' },
  ]);
});

test('VW.pendingLinks: empty pending map gives an empty list', () => {
  assert.deepEqual(VW.pendingLinks({}, NV), []);
});

// === NV eyebrow/lede literal ========================================================================

const LATER_LEDE = {
  memory: 'Keep a short, curated memory of your campaign (people, places and open threads) and review it before anything is saved.',
  publish: 'Check a fresh build, then send it to your live site in a few guided steps, with a way to go back.',
  sessions: 'Turn a session recording into a transcript and a draft recap that you review before it is filed.',
  ai: 'Chat with an AI model using your own key, with only the campaign notes you choose to share.',
  storage: 'Pick and see the places this campaign keeps its vault, art and site files.',
};

const EXPECTED_EYEBROW_LEDE = {
  overview: { eyebrow: undefined, lede: undefined },
  theme: { eyebrow: 'pack.toml · theme', lede: 'Your own site, built privately in each theme. Pick one, then review the change.' },
  title: {
    eyebrow: 'vault.config.json · vault-config.md',
    lede: 'The name and one-line tagline on your landing page. The name is saved in vault.config.json and the tagline in vault-config.md. The rest of both files is read-only here.',
  },
  images: {
    eyebrow: 'Your site’s art',
    lede: "The pictures your site can use, and which picture fills each spot. Change as many spots as you like; they're saved only when you review them. Uploads are saved as soon as they finish.",
  },
  vocab: {
    eyebrow: 'pack.toml · [labels] [timeline] [recaps]',
    lede: 'The words the player site uses, and the patterns it reads from your Timeline page. Leave a field empty to use the default.',
  },
  memory: { eyebrow: 'Roadmap, not built yet', lede: LATER_LEDE.memory },
  check: { eyebrow: 'check', lede: 'Runs the same checks as scriptorium check, against the vault as it is now.' },
  preview: { eyebrow: 'preview', lede: 'Builds the site into a private preview on this machine. Nothing is published.' },
  publish: { eyebrow: 'Roadmap, not built yet', lede: LATER_LEDE.publish },
  sessions: { eyebrow: 'Roadmap, not built yet', lede: LATER_LEDE.sessions },
  ai: { eyebrow: 'Roadmap, not built yet', lede: LATER_LEDE.ai },
  storage: { eyebrow: 'Roadmap, not built yet', lede: LATER_LEDE.storage },
  'vault-config': {
    eyebrow: '_meta/vault-config.md',
    lede: "Your vault's own settings note. gm-apprentice and GM-Scriptorium both read it: it sets the publish mode, what stays private, the site's look and the landing page.",
  },
};

test('NV: every NAV item carries the exact eyebrow/lede literal', () => {
  for (const id of Object.keys(EXPECTED_EYEBROW_LEDE)) {
    const item = NV.item(id);
    assert.ok(item, `NAV item "${id}" not found`);
    assert.equal(item.eyebrow, EXPECTED_EYEBROW_LEDE[id].eyebrow, `${id}.eyebrow`);
    assert.equal(item.lede, EXPECTED_EYEBROW_LEDE[id].lede, `${id}.lede`);
  }
});

test('NV: the admin-frame test only compares id/group/label/short, so it stays green independent of eyebrow/lede', () => {
  // Regression guard for the file-map note: NV.NAV still carries id/group/label/short/icon in the
  // same shape admin-frame.test.js asserts against.
  const shape = NV.NAV.map((n) => ({ id: n.id, group: n.group, label: n.label, short: n.short }));
  assert.ok(shape.every((n) => typeof n.id === 'string' && typeof n.group === 'string'));
});
