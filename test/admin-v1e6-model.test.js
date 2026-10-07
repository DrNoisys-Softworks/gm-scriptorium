'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { VB } = require(path.join(__dirname, '..', 'assets', 'admin', 'vocab.js'));

/*
 * V1e-6 (SD-34 to SD-38). Pure model tests, loaded via require() (the VB pattern vocab.js already
 * uses for buildKindEntry etc.). Independent literals throughout -- none of the expected values
 * below are derived from the code under test.
 */

// === VB.FRIENDLY_NAMES ===========================================================================

const EXPECTED_FRIENDLY_NAMES = {
  learned_lens: 'Timeline tab: what the party learned',
  learned_legend: 'Timeline key: learned facts',
  story_lens: 'Timeline tab: the story',
  chapter: 'Word for a chapter',
  recap: 'Word for a session recap',
  recap_learned_link: "Link to a recap's learned list",
  same_recap: 'Heading: from the same recap',
  connections_heading: 'Connections heading',
  group_tie: 'Group: direct ties',
  group_named: 'Group: pages that name this one',
  group_pc: 'Group: player characters',
  group_npc: 'Group: other people',
  group_faction: 'Group: factions',
  group_location: 'Group: places',
  group_thing: 'Group: things',
  group_event: 'Group: events',
  group_other: 'Group: everything else',
  learned_heading: 'Heading that lists what the party learned',
  session_token: 'How a session is written',
  segment_units: 'How a day or week is written',
};

test('VB.FRIENDLY_NAMES: exactly the 20-entry literal (17 LABEL_GROUPS keys, plus learned_heading, session_token, segment_units)', () => {
  assert.deepEqual(VB.FRIENDLY_NAMES, EXPECTED_FRIENDLY_NAMES);
  assert.equal(Object.keys(VB.FRIENDLY_NAMES).length, 20);
});

test('VB.FRIENDLY_NAMES: every VB.LABEL_GROUPS key has a friendly name (drift test)', () => {
  const missing = [];
  VB.LABEL_GROUPS.forEach(([, keys]) => {
    keys.forEach((key) => {
      if (!VB.friendlyName(key)) missing.push(key);
    });
  });
  assert.deepEqual(missing, []);
});

// === VB.friendlyName ==============================================================================

test('friendlyName: a known key returns its literal string', () => {
  assert.equal(VB.friendlyName('group_npc'), 'Group: other people');
  assert.equal(VB.friendlyName('learned_heading'), 'Heading that lists what the party learned');
  assert.equal(VB.friendlyName('session_token'), 'How a session is written');
});

test('friendlyName: an unknown key, a string-prefix sibling, and a prototype-chain key all return null (own-property lookup only)', () => {
  assert.equal(VB.friendlyName('group_npcx'), null);
  assert.equal(VB.friendlyName('group_n'), null);
  assert.equal(VB.friendlyName('constructor'), null);
  assert.equal(VB.friendlyName('__proto__'), null);
  assert.equal(VB.friendlyName('toString'), null);
  assert.equal(VB.friendlyName('hasOwnProperty'), null);
});

// === VB.GROUP_NOTES ================================================================================

test('VB.GROUP_NOTES: the 3-entry literal', () => {
  assert.deepEqual(VB.GROUP_NOTES, {
    'Story timeline': 'On the Timeline page',
    Recaps: 'In links to session recaps',
    Connections: 'On every character, place and faction page',
  });
});

// === VB.sampleFor ==================================================================================

test('sampleFor: the literal table', () => {
  assert.deepEqual(VB.sampleFor('learned_lens', 'X'), { kind: 'lens on', label: 'shows as', text: 'X' });
  assert.deepEqual(VB.sampleFor('story_lens', 'X'), { kind: 'lens', label: 'shows as', text: 'X' });
  assert.deepEqual(VB.sampleFor('learned_legend', 'X'), { kind: 'legend', label: 'shows as', text: 'X', glyph: 'learned' });
  assert.deepEqual(VB.sampleFor('chapter', 'Chapter'), { kind: 'meta', label: 'shows as', text: 'Chapter 3, A sample title' });
  assert.deepEqual(VB.sampleFor('recap', 'Recap'), { kind: 'link', label: 'shows as', text: 'Recap III, A sample title' });
  assert.deepEqual(VB.sampleFor('recap_learned_link', 'Learned'), {
    kind: 'link',
    label: 'shows as',
    text: 'Recap III, A sample title: Learned',
  });
  assert.deepEqual(VB.sampleFor('same_recap', 'X'), { kind: 'grp', label: 'shows as', text: 'X' });
  assert.deepEqual(VB.sampleFor('connections_heading', 'X'), { kind: 'head', label: 'shows as', text: 'X' });
  assert.deepEqual(VB.sampleFor('learned_heading', 'heading'), { kind: 'head', label: 'matches', text: '## heading' });
  ['group_tie', 'group_named', 'group_pc', 'group_npc', 'group_faction', 'group_location', 'group_thing', 'group_event', 'group_other'].forEach(
    (key) => {
      assert.deepEqual(VB.sampleFor(key, 'X'), { kind: 'grp', label: 'shows as', text: 'X', suffix: '2' });
    },
  );
});

test('sampleFor: a key with a friendly name but no sample (Patterns) returns null, not a fallback chip', () => {
  assert.equal(VB.sampleFor('session_token', 'x'), null);
  assert.equal(VB.sampleFor('segment_units', 'x'), null);
});

test('sampleFor: an unknown key returns null', () => {
  assert.equal(VB.sampleFor('nonsense', 'x'), null);
  assert.equal(VB.sampleFor('constructor', 'x'), null);
});

test('sampleFor: an undefined/null text is treated as empty', () => {
  assert.deepEqual(VB.sampleFor('story_lens', undefined), { kind: 'lens', label: 'shows as', text: '' });
  assert.deepEqual(VB.sampleFor('story_lens', null), { kind: 'lens', label: 'shows as', text: '' });
});

// === VB.HOW / VB.howFor ============================================================================

test('howFor: each of the 4 tabs has an array of [title, body] pairs', () => {
  ['labels', 'kinds', 'matching', 'recaps'].forEach((tabId) => {
    const items = VB.howFor(tabId);
    assert.ok(Array.isArray(items) && items.length > 0, `expected a non-empty array for ${tabId}`);
    items.forEach((pair) => {
      assert.equal(pair.length, 2);
      assert.equal(typeof pair[0], 'string');
      assert.equal(typeof pair[1], 'string');
    });
  });
});

test('howFor: an unknown tab id (including a prototype-chain key) returns null', () => {
  assert.equal(VB.howFor('constructor'), null);
  assert.equal(VB.howFor('overview'), null);
  assert.equal(VB.howFor(''), null);
});

test('howFor: DV-E44\'s two truthfulness fixes replace the mock\'s own claims', () => {
  const kindsOneThing = VB.howFor('kinds').find((pair) => pair[0] === 'One thing to know');
  assert.ok(kindsOneThing, 'expected a "One thing to know" item on the kinds tab');
  assert.equal(kindsOneThing[1], 'Kinds are saved as a set. Change one and the whole set is written into pack.toml, unchanged ones included.');
  assert.ok(!kindsOneThing[1].includes('all five'), 'the mock\'s "all five" claim must not survive');

  const matchingColumns = VB.howFor('matching').find((pair) => pair[0] === 'Columns');
  assert.ok(matchingColumns, 'expected a "Columns" item on the matching tab');
  assert.equal(matchingColumns[1], 'The header names each Timeline column may use. Change these only if your Timeline uses different headers.');
  assert.ok(!matchingColumns[1].includes('already match'), 'the mock\'s "already match" claim must not survive');
});

// === VB.followRoleFor ==============================================================================

test('followRoleFor: the labels tab routes same_recap, connections_heading and every group_* key to character, everything else to timeline', () => {
  assert.equal(VB.followRoleFor('labels', 'same_recap'), 'character');
  assert.equal(VB.followRoleFor('labels', 'connections_heading'), 'character');
  VB.GROUP_LABEL_KEYS.forEach((key) => {
    assert.equal(VB.followRoleFor('labels', key), 'character');
  });
  ['learned_lens', 'learned_legend', 'story_lens', 'chapter', 'recap', 'recap_learned_link'].forEach((key) => {
    assert.equal(VB.followRoleFor('labels', key), 'timeline');
  });
});

test('followRoleFor: kinds and matching always give timeline; recaps always gives recap; an unknown tab gives timeline', () => {
  assert.equal(VB.followRoleFor('kinds', 'anything'), 'timeline');
  assert.equal(VB.followRoleFor('matching', 'anything'), 'timeline');
  assert.equal(VB.followRoleFor('recaps', 'learned_heading'), 'recap');
  assert.equal(VB.followRoleFor('recaps', undefined), 'recap');
  assert.equal(VB.followRoleFor('bogus-tab', 'anything'), 'timeline');
});

test('followRoleFor: a hint for a key on the wrong tab still routes by the tab, not the key (labels-tab rules never leak into other tabs)', () => {
  // 'group_pc' would route to 'character' on the labels tab, but the matching tab's rule is
  // constant regardless of the key argument.
  assert.equal(VB.followRoleFor('matching', 'group_pc'), 'timeline');
});

// === copy scan (NFR-11: no mock sample-campaign text; house style: no em dash, no codes) =========

test('copy scan: no em dash, no " -- ", no FR/SD/AC/NFR/DV code, and none of the mock\'s own sample-campaign strings, in any FRIENDLY_NAMES/GROUP_NOTES/HOW copy string', () => {
  const strings = []
    .concat(Object.values(VB.FRIENDLY_NAMES))
    .concat(Object.values(VB.GROUP_NOTES))
    .concat(
      ['labels', 'kinds', 'matching', 'recaps'].reduce((acc, tabId) => {
        VB.HOW[tabId].forEach((pair) => acc.push(pair[0], pair[1]));
        return acc;
      }, []),
    );

  // Planted positive controls, proving the scan itself actually looks (CLAUDE.md's own rule:
  // never trust a scan that has never been seen to fail).
  const withEmDash = strings.concat(['a sentence with an em dash — right there']);
  const withDoubleHyphen = strings.concat(['a sentence with a -- prose dash']);
  const withCode = strings.concat(['see SD-34 for detail']);
  const withMockString = strings.concat(['What the Wardens learned']);

  const EM_DASH = /—/;
  const DOUBLE_HYPHEN_DASH = / -- /;
  const CODE_RE = /\b(?:FR|SD|AC|NFR|DV|OQ|OD|SC)-[A-Za-z0-9]+\b/;
  // r3-src/vocab.js:26,36,95-97: the private sample campaign's own strings, typed independently.
  const MOCK_STRINGS = ['What the Wardens learned', 'The Wardens', 'Under the Sallow Hills', 'Sallow Hills'];

  function scan(list) {
    return list.some((s) => EM_DASH.test(s)) || list.some((s) => DOUBLE_HYPHEN_DASH.test(s)) || list.some((s) => CODE_RE.test(s)) ||
      list.some((s) => MOCK_STRINGS.some((m) => s.includes(m)));
  }

  assert.equal(scan(withEmDash), true, 'positive control: em dash was not caught');
  assert.equal(scan(withDoubleHyphen), true, 'positive control: " -- " was not caught');
  assert.equal(scan(withCode), true, 'positive control: a code was not caught');
  assert.equal(scan(withMockString), true, 'positive control: a mock sample-campaign string was not caught');

  assert.equal(strings.some((s) => EM_DASH.test(s)), false);
  assert.equal(strings.some((s) => DOUBLE_HYPHEN_DASH.test(s)), false);
  assert.equal(strings.some((s) => CODE_RE.test(s)), false);
  assert.equal(
    strings.some((s) => MOCK_STRINGS.some((m) => s.includes(m))),
    false,
  );
});
