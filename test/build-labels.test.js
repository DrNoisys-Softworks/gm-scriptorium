'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const TOML = require('smol-toml');

const {
  DEFAULT_LABELS,
  DEFAULT_VOCAB,
  parseVocab,
  GLYPH_NAMES,
  PATH_DATA_RE,
  KIND_KEY_RE,
  RESERVED_KIND_KEYS,
  TL_CLIENT_LABEL_KEYS,
  CX_CLIENT_LABEL_KEYS,
} = require('../src/build/labels');
const { ConfigError } = require('../src/util/errors');

/*
 * ADR 0020 ("Labels and vocabulary", docs/agent-runs/agnostic-p4-engineering-brief-2026-09-25.md).
 * labels.js is pure, so these tests parse TOML text with smol-toml themselves and call parseVocab
 * directly, rather than going through a scratch-dir loadPackToml round trip (that combination is
 * test/theme-packtoml.test.js's K-series, unedited except F7's K8/K16). Synthetic names only
 * (NFR-11(c)).
 */

const T = '/vault/_meta/scriptorium/pack.toml';
const C = 'alpha';

function parse(text) {
  return TOML.parse(text);
}

function vocabOf(text) {
  return parseVocab(parse(text), { T, c: C });
}

function assertConfigError(fn, expectedMessage) {
  assert.throws(
    fn,
    (err) => err instanceof ConfigError && err.message === expectedMessage,
    `expected message: ${expectedMessage}\n`,
  );
}

function err(text) {
  return `campaign "${C}": ${T}: ${text}`;
}

// === L1: DEFAULT_LABELS ==========================================================================

test('L1: DEFAULT_LABELS deep-equals a literal copy of table B, and is deep-frozen', () => {
  const expected = {
    learned_lens: 'What the party learned',
    learned_legend: 'Learned',
    story_lens: 'The story',
    chapter: 'Chapter',
    recap: 'Recap',
    recap_learned_link: 'What the Party Learned',
    same_recap: 'Same recap',
    connections_heading: 'Connections',
    group_tie: 'Ties',
    group_named: 'Named by',
    group_pc: 'The party',
    group_npc: 'People',
    group_faction: 'Factions',
    group_location: 'Places',
    group_thing: 'Things',
    group_event: 'Events',
    group_other: 'Other',
  };
  assert.deepEqual(DEFAULT_LABELS, expected);
  assert.equal(Object.keys(DEFAULT_LABELS).length, 17);
  assert.ok(Object.isFrozen(DEFAULT_LABELS));

  assert.ok(Object.isFrozen(DEFAULT_VOCAB));
  assert.ok(Object.isFrozen(DEFAULT_VOCAB.labels));
  assert.ok(Object.isFrozen(DEFAULT_VOCAB.kinds));
  assert.ok(Object.isFrozen(DEFAULT_VOCAB.kinds[0]));
  assert.ok(Object.isFrozen(DEFAULT_VOCAB.weights));
  assert.ok(Object.isFrozen(DEFAULT_VOCAB.columns));

  assert.deepEqual(TL_CLIENT_LABEL_KEYS, ['learned_lens', 'learned_legend', 'story_lens', 'chapter']);
  assert.deepEqual(CX_CLIENT_LABEL_KEYS, [
    'recap',
    'same_recap',
    'group_tie',
    'group_named',
    'group_pc',
    'group_npc',
    'group_faction',
    'group_location',
    'group_thing',
    'group_event',
    'group_other',
  ]);
});

// === L2: one test per error message in A =========================================================

test('L2: table-shape errors: [labels], [timeline], [recaps], [timeline.columns]', () => {
  assertConfigError(() => vocabOf('labels = 1\n'), err('[labels] must be a table'));
  assertConfigError(() => vocabOf('labels = []\n'), err('[labels] must be a table'));
  assertConfigError(() => vocabOf('labels = 2024-01-01\n'), err('[labels] must be a table'));
  assertConfigError(() => vocabOf('timeline = "x"\n'), err('[timeline] must be a table'));
  assertConfigError(() => vocabOf('recaps = []\n'), err('[recaps] must be a table'));
  assertConfigError(() => vocabOf('[timeline]\ncolumns = 5\n'), err('[timeline.columns] must be a table'));
});

test('L2: label-string type/empty errors ("<where> must be a non-empty string")', () => {
  assertConfigError(() => vocabOf('[labels]\nrecap = 5\n'), err('[labels] recap must be a non-empty string'));
  assertConfigError(() => vocabOf('[labels]\nrecap = ""\n'), err('[labels] recap must be a non-empty string'));
  assertConfigError(() => vocabOf('[labels]\nrecap = "   "\n'), err('[labels] recap must be a non-empty string'));
  assertConfigError(
    () => vocabOf('[recaps]\nlearned_heading = 5\n'),
    err('[recaps] learned_heading must be a non-empty string'),
  );
});

test('L2: label-string length error ("<where> is longer than 200 characters")', () => {
  const long = 'x'.repeat(201);
  assertConfigError(() => vocabOf(`[labels]\nrecap = "${long}"\n`), err('[labels] recap is longer than 200 characters'));
});

test('L2: label-string control-character error', () => {
  assertConfigError(
    () => vocabOf('[labels]\nrecap = "a\\u0007b"\n'),
    err('[labels] recap contains a control character or an unpaired surrogate'),
  );
});

test('L2: [timeline] kinds shape errors', () => {
  assertConfigError(() => vocabOf('[timeline]\nkinds = "x"\n'), err('[timeline] kinds must be an array of tables'));
  assertConfigError(() => vocabOf('[timeline]\nkinds = []\n'), err('[timeline] kinds must list between 1 and 32 kinds'));
  const tooMany = Array.from({ length: 33 }, (_, i) => `[[timeline.kinds]]\nkey = "k${i}"\n`).join('\n');
  assertConfigError(() => vocabOf(tooMany), err('[timeline] kinds must list between 1 and 32 kinds'));
  assertConfigError(() => vocabOf('[timeline]\nkinds = [1]\n'), err('[timeline] kinds #1 must be a table'));
});

test('L2: kind key slug/reserved/collision errors', () => {
  const slugMsg = err('[timeline] kinds #1 key must be a lower-case slug: a letter, then letters, digits or "-", at most 32 characters');
  assertConfigError(() => vocabOf('[[timeline.kinds]]\nkey = "A"\n'), slugMsg);
  assertConfigError(() => vocabOf('[[timeline.kinds]]\n'), slugMsg);
  assertConfigError(() => vocabOf('[[timeline.kinds]]\nkey = 5\n'), slugMsg);

  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "learned"\n'),
    err('[timeline] kinds #1 key "learned" is reserved'),
  );
  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "none"\n'),
    err('[timeline] kinds #1 key "none" is reserved'),
  );

  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "fight"\n[[timeline.kinds]]\nkey = "fight"\n'),
    err('[timeline] kinds #2 "fight" is already a key or alias of another kind'),
  );
  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "fight"\n[[timeline.kinds]]\nkey = "x"\naliases = ["fight"]\n'),
    err('[timeline] kinds #2 "fight" is already a key or alias of another kind'),
  );
});

test('L2: kind aliases/before/glyph shape errors', () => {
  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "x"\naliases = "y"\n'),
    err('[timeline] kinds #1 aliases must be an array of at most 16 non-empty strings'),
  );
  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "x"\naliases = [""]\n'),
    err('[timeline] kinds #1 aliases must be an array of at most 16 non-empty strings'),
  );
  const seventeen = Array.from({ length: 17 }, (_, i) => `"a${i}"`).join(', ');
  assertConfigError(
    () => vocabOf(`[[timeline.kinds]]\nkey = "x"\naliases = [${seventeen}]\n`),
    err('[timeline] kinds #1 aliases must be an array of at most 16 non-empty strings'),
  );

  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "x"\nbefore = "yes"\n'),
    err('[timeline] kinds #1 before must be true or false'),
  );

  const glyphMsg = err(
    '[timeline] kinds #1 glyph must be one of backstory, discovery, fight, journey, learned, meeting, or SVG path data ' +
      '(M or m first; digits, spaces, commas, points, signs, e and path letters only; at most 1024 characters)',
  );
  assertConfigError(() => vocabOf('[[timeline.kinds]]\nkey = "x"\nglyph = "nope"\n'), glyphMsg);
  assertConfigError(() => vocabOf('[[timeline.kinds]]\nkey = "x"\nglyph = 5\n'), glyphMsg);
});

test('L2: [timeline] weights errors', () => {
  const msg = err('[timeline] weights must be an array of exactly 3 strings');
  assertConfigError(() => vocabOf('[timeline]\nweights = ["a", "b"]\n'), msg);
  assertConfigError(() => vocabOf('[timeline]\nweights = "a"\n'), msg);
  assertConfigError(() => vocabOf('[timeline]\nweights = [1, 2, 3]\n'), msg);
  assertConfigError(
    () => vocabOf('[timeline]\nweights = ["", "b", "c"]\n'),
    err('[timeline] weights #1 must be a non-empty string'),
  );
});

test('L2: session_token/segment_units type, length and syntax errors', () => {
  assertConfigError(() => vocabOf('[timeline]\nsession_token = ""\n'), err('[timeline] session_token must be a non-empty string'));
  assertConfigError(() => vocabOf('[timeline]\nsegment_units = 5\n'), err('[timeline] segment_units must be a non-empty string'));

  const long = 'a'.repeat(513);
  assertConfigError(
    () => vocabOf(`[timeline]\nsession_token = "${long}"\n`),
    err('[timeline] session_token is longer than 512 characters'),
  );

  assert.throws(
    () => vocabOf(String.raw`[timeline]` + '\n' + String.raw`session_token = '\bEp(\d+'` + '\n'),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.ok(e.message.startsWith(err('[timeline] session_token is not a valid regular expression: ')));
      assert.ok(!e.message.includes('\n'));
      return true;
    },
  );
});

test('L2: session_token/segment_units capture-group-count errors', () => {
  assertConfigError(
    () => vocabOf(String.raw`[timeline]` + '\n' + String.raw`session_token = '\bS\d+\b'` + '\n'),
    err('[timeline] session_token must have at least 1 capture group'),
  );
  assertConfigError(
    () => vocabOf(String.raw`[timeline]` + '\n' + String.raw`segment_units = '\b(week)\s+\d+'` + '\n'),
    err('[timeline] segment_units must have at least 2 capture groups'),
  );
});

test('L2: [timeline.columns] shape and collision errors', () => {
  assertConfigError(
    () => vocabOf('[timeline.columns]\ntitle = []\n'),
    err('[timeline.columns] title must be an array of 1 to 16 non-empty strings of at most 64 characters'),
  );
  assertConfigError(
    () => vocabOf(`[timeline.columns]\ntitle = ["${'x'.repeat(65)}"]\n`),
    err('[timeline.columns] title must be an array of 1 to 16 non-empty strings of at most 64 characters'),
  );
  assertConfigError(
    () => vocabOf('[timeline.columns]\ntitle = [""]\n'),
    err('[timeline.columns] title must be an array of 1 to 16 non-empty strings of at most 64 characters'),
  );

  assertConfigError(
    () => vocabOf('[timeline.columns]\ntitle = ["heading"]\nkind = ["heading"]\n'),
    err('[timeline.columns] "heading" names both title and kind'),
  );
  assertConfigError(
    () => vocabOf('[timeline.columns]\nsession = ["ep"]\nlearned = ["ep"]\n'),
    err('[timeline.columns] "ep" names both session and learned'),
  );
  // Case/whitespace-insensitive collision.
  assertConfigError(
    () => vocabOf('[timeline.columns]\ntitle = ["Heading"]\nkind = ["  heading  "]\n'),
    err('[timeline.columns] "  heading  " names both title and kind'),
  );
});

test('L2: [labels]/[timeline]/[recaps]/[timeline.columns] must-be-a-table also refuses instanceof-Date and array', () => {
  assertConfigError(() => vocabOf('[timeline]\nkinds = [2024-01-01]\n'), err('[timeline] kinds #1 must be a table'));
});

// === L3: warnings, human-only ====================================================================

test('L3: unrecognised keys warn (labels/timeline/timeline.columns/recaps/kinds), never error', () => {
  const r1 = vocabOf('[labels]\nnot_a_label = "x"\n');
  assert.deepEqual(r1.warnings, [`${T}: [labels] unrecognised key "not_a_label" (ignored)`]);
  assert.equal(r1.vocab.labels.recap, 'Recap');

  const r2 = vocabOf('[timeline]\nnot_a_key = 1\n');
  assert.deepEqual(r2.warnings, [`${T}: [timeline] unrecognised key "not_a_key" (ignored)`]);

  const r3 = vocabOf('[timeline.columns]\nnot_a_col = ["x"]\n');
  assert.deepEqual(r3.warnings, [`${T}: [timeline.columns] unrecognised key "not_a_col" (ignored)`]);

  const r4 = vocabOf('[recaps]\nnot_a_recap_key = 1\n');
  assert.deepEqual(r4.warnings, [`${T}: [recaps] unrecognised key "not_a_recap_key" (ignored)`]);

  const r5 = vocabOf('[[timeline.kinds]]\nkey = "x"\nnot_a_kind_key = 1\n');
  assert.deepEqual(r5.warnings, [`${T}: [[timeline.kinds]] #1 unrecognised key "not_a_kind_key" (ignored)`]);
});

test('L3: a warning never changes the resolved vocab value (the theme-build B6 pattern, at the parseVocab level)', () => {
  const clean = vocabOf('[labels]\nrecap = "X"\n');
  const warn = vocabOf('[labels]\nrecap = "X"\nnot_a_label = 1\n');
  assert.deepEqual(clean.vocab.labels, warn.vocab.labels);
  assert.notDeepEqual(clean.warnings, warn.warnings);
});

// === L4: kind key slug accept/reject =============================================================

test('L4: slug accept/reject', () => {
  const accept = ['a', 'a-1', 'a'.repeat(32), 'learned-ish', 'constructor'];
  for (const key of accept) {
    if (RESERVED_KIND_KEYS.has(key)) continue;
    assert.ok(KIND_KEY_RE.test(key), `expected ${key} to match KIND_KEY_RE`);
    const { vocab } = vocabOf(`[[timeline.kinds]]\nkey = "${key}"\n`);
    assert.equal(vocab.kinds[0].key, key);
  }
  const reject = ['A', '1a', 'a_b', 'a'.repeat(33)];
  for (const key of reject) {
    assert.ok(!KIND_KEY_RE.test(key), `expected ${key} to NOT match KIND_KEY_RE`);
  }
  // Reserved (regex-legal, refused for a different reason).
  for (const key of ['learned', 'none']) {
    assert.ok(KIND_KEY_RE.test(key));
    assertConfigError(() => vocabOf(`[[timeline.kinds]]\nkey = "${key}"\n`), err(`[timeline] kinds #1 key "${key}" is reserved`));
  }
});

// === L5: glyph accept/reject ======================================================================

test('L5: glyph accept/reject', () => {
  for (const name of GLYPH_NAMES) {
    const { vocab } = vocabOf(`[[timeline.kinds]]\nkey = "x"\nglyph = "${name}"\n`);
    assert.equal(vocab.kinds[0].glyph, name);
  }
  for (const path of ['M0 0L1 1Z', 'm1e-3 2']) {
    assert.ok(PATH_DATA_RE.test(path), path);
    const { vocab } = vocabOf(`[[timeline.kinds]]\nkey = "x"\nglyph = "${path}"\n`);
    assert.equal(vocab.kinds[0].glyph, path);
  }
  for (const bad of ['<path d="M0 0"/>', 'M0 0"', 'Z0', '', 'M' + '0'.repeat(1025)]) {
    assert.ok(!PATH_DATA_RE.test(bad), bad);
  }
  assertConfigError(
    () => vocabOf('[[timeline.kinds]]\nkey = "x"\nglyph = "Z0"\n'),
    err(
      '[timeline] kinds #1 glyph must be one of backstory, discovery, fight, journey, learned, meeting, or SVG path data ' +
        '(M or m first; digits, spaces, commas, points, signs, e and path letters only; at most 1024 characters)',
    ),
  );
});

// === L6: regexes ===================================================================================

test('L6: an unclosed group is refused', () => {
  assert.throws(
    () => vocabOf(String.raw`[timeline]` + '\n' + String.raw`session_token = '\bEp(\d+'` + '\n'),
    (e) => e instanceof ConfigError && e.message.startsWith(err('[timeline] session_token is not a valid regular expression: ')),
  );
});

test('L6: too few capture groups', () => {
  assertConfigError(
    () => vocabOf(String.raw`[timeline]` + '\n' + String.raw`session_token = '\bS\d+\b'` + '\n'),
    err('[timeline] session_token must have at least 1 capture group'),
  );
  assertConfigError(
    () => vocabOf(String.raw`[timeline]` + '\n' + String.raw`segment_units = '\b(week)\s+\d+'` + '\n'),
    err('[timeline] segment_units must have at least 2 capture groups'),
  );
});

test('L6: SD-7: a custom session_token/segment_units is always compiled with the fixed flags (never user-supplied g or y)', () => {
  const { vocab } = vocabOf(String.raw`[timeline]` + '\nsession_token = \'\\bEp(\\d+)\\b\'\nsegment_units = \'\\b(night|league)\\s+(\\d+)\\b\'\n');
  assert.equal(vocab.sessionToken.flags, '', 'session_token must compile with the fixed \'\' flags, never \'g\'');
  assert.equal(vocab.segmentUnits.flags, 'i', 'segment_units must compile with the fixed \'i\' flags, never \'gi\'');
});

test('L6: the default regexes, source/flags and behaviour, stated independently', () => {
  assert.equal(DEFAULT_VOCAB.sessionToken.source, '\\bS(\\d+)\\b');
  assert.equal(DEFAULT_VOCAB.sessionToken.flags, '');
  assert.equal(DEFAULT_VOCAB.segmentUnits.source, '\\b(week|day)\\s+(\\d+)\\b');
  assert.equal(DEFAULT_VOCAB.segmentUnits.flags, 'i');

  const st = DEFAULT_VOCAB.sessionToken;
  assert.deepEqual('S1'.match(st).slice(0, 2), ['S1', '1']);
  assert.deepEqual('(S12)'.match(st).slice(0, 2), ['S12', '12']);
  assert.equal('XS1'.match(st), null);
  assert.equal('s1'.match(st), null); // case-sensitive: no 'i' flag

  const su = DEFAULT_VOCAB.segmentUnits;
  assert.deepEqual('Road, week 2'.match(su).slice(0, 3), ['week 2', 'week', '2']);
  assert.deepEqual('DAY 3'.match(su).slice(0, 3), ['DAY 3', 'DAY', '3']);
  assert.equal('weekday 3'.match(su), null); // \b prevents a mid-word match
});

// === L7: control characters, unpaired surrogate, length boundary =================================

test('L7: a TOML "a\\u0007b" control character is refused', () => {
  assertConfigError(
    () => vocabOf('[labels]\nrecap = "a\\u0007b"\n'),
    err('[labels] recap contains a control character or an unpaired surrogate'),
  );
});

test('L7: an unpaired surrogate is refused (exercised directly: smol-toml itself refuses the escape that would produce one)', () => {
  const lone = 'a' + String.fromCharCode(0xd800) + 'b';
  assert.equal(lone.isWellFormed(), false);
  assertConfigError(
    () => parseVocab({ labels: { recap: lone } }, { T, c: C }),
    err('[labels] recap contains a control character or an unpaired surrogate'),
  );
});

test('L7: 200 characters is accepted, 201 is refused', () => {
  const ok200 = 'x'.repeat(200);
  const { vocab } = vocabOf(`[labels]\nrecap = "${ok200}"\n`);
  assert.equal(vocab.labels.recap, ok200);

  const bad201 = 'x'.repeat(201);
  assertConfigError(() => vocabOf(`[labels]\nrecap = "${bad201}"\n`), err('[labels] recap is longer than 200 characters'));
});

// === L8: deltas ====================================================================================

// D-block: the maximal restatement of every default (Engineering Brief, "D-block").
const D_BLOCK = `
[labels]
learned_lens = "What the party learned"
learned_legend = "Learned"
story_lens = "The story"
chapter = "Chapter"
recap = "Recap"
recap_learned_link = "What the Party Learned"
same_recap = "Same recap"
connections_heading = "Connections"
group_tie = "Ties"
group_named = "Named by"
group_pc = "The party"
group_npc = "People"
group_faction = "Factions"
group_location = "Places"
group_thing = "Things"
group_event = "Events"
group_other = "Other"

[timeline]
weights = ["aside", "scene", "turning point"]
session_token = '\\bS(\\d+)\\b'
segment_units = '\\b(week|day)\\s+(\\d+)\\b'

[[timeline.kinds]]
key = "fight"
label = "fight"
glyph = "fight"
aliases = []
before = false

[[timeline.kinds]]
key = "meeting"
label = "meeting"
glyph = "meeting"
aliases = []
before = false

[[timeline.kinds]]
key = "discovery"
label = "discovery"
glyph = "discovery"
aliases = []
before = false

[[timeline.kinds]]
key = "journey"
label = "journey"
glyph = "journey"
aliases = []
before = false

[[timeline.kinds]]
key = "backstory"
label = "backstory"
glyph = "backstory"
aliases = []
before = true

[timeline.columns]
title = ["title"]
kind = ["kind"]
weight = ["weight"]
place = ["place"]
in_game = ["in-game"]
when = ["when"]
real_world = ["real-world"]
what = ["what"]
session = ["session"]
learned = ["learned"]
after = ["after"]

[recaps]
learned_heading = "what the party learned"
`;

// M-block: five [[timeline.kinds]] entries with key only, plus before = true on backstory.
const M_BLOCK = `
[[timeline.kinds]]
key = "fight"

[[timeline.kinds]]
key = "meeting"

[[timeline.kinds]]
key = "discovery"

[[timeline.kinds]]
key = "journey"

[[timeline.kinds]]
key = "backstory"
before = true
`;

// X-block: the non-default fixture pack (Engineering Brief, "X-block"; also used by
// test/build-vocab-e2e.test.js's E2 and test/fixtures/vocab-vault).
const X_BLOCK = `
theme = "plain"

[labels]
learned_lens = "What the crew found out"
story_lens = "The tale"
chapter = "Episode"
recap = "Episode"
recap_learned_link = "Lessons Gathered"
same_recap = "Same episode"
group_npc = "Folk"
connections_heading = "Ties and threads"

[timeline]
weights = ["footnote", "scene", "watershed"]
session_token = '\\bEp(\\d+)\\b'
segment_units = '\\b(night|league)\\s+(\\d+)\\b'

[[timeline.kinds]]
key = "clash"
glyph = "fight"
aliases = ["battle"]

[[timeline.kinds]]
key = "parley"
glyph = "meeting"

[[timeline.kinds]]
key = "omen"
glyph = "M10 2 L18 18 L2 18 Z"

[[timeline.kinds]]
key = "origin"
glyph = "backstory"
before = true

[timeline.columns]
title = ["heading"]
kind = ["sort"]
place = ["where"]
in_game = ["in-world"]
real_world = ["table"]
session = ["episode"]
learned = ["lesson"]

[recaps]
learned_heading = "Lessons Gathered"
`;

test('L8(a): no tables at all resolves to the shared DEFAULT_VOCAB object, by reference', () => {
  const { vocab, warnings } = vocabOf('theme = "plain"\n');
  assert.equal(vocab, DEFAULT_VOCAB);
  assert.deepEqual(warnings, []);
  assert.equal(vocab.tlVoc, null);
  assert.equal(vocab.cxVoc, null);
});

test('L8(b): the maximal restatement of every default (D-block) resolves tlVoc/cxVoc to null', () => {
  const { vocab } = vocabOf(D_BLOCK);
  assert.notEqual(vocab, DEFAULT_VOCAB);
  assert.equal(vocab.tlVoc, null);
  assert.equal(vocab.cxVoc, null);
});

test('L8(c): the minimal restatement (M-block: key-only kinds, before on backstory) resolves tlVoc/cxVoc to null', () => {
  const { vocab } = vocabOf(M_BLOCK);
  assert.equal(vocab.tlVoc, null);
  assert.equal(vocab.cxVoc, null);
  assert.deepEqual(
    vocab.kinds.map((k) => k.key),
    ['fight', 'meeting', 'discovery', 'journey', 'backstory'],
  );
  assert.equal(vocab.beforeKinds.has('backstory'), true);
});

test('L8: the X-block delta matches the literals also used by build-vocab-e2e.test.js\'s E2', () => {
  const { vocab } = vocabOf(X_BLOCK);
  assert.deepEqual(vocab.tlVoc, {
    labels: { learned_lens: 'What the crew found out', story_lens: 'The tale', chapter: 'Episode' },
    kinds: [
      { key: 'clash', label: 'clash', glyph: 'fight', before: false },
      { key: 'parley', label: 'parley', glyph: 'meeting', before: false },
      { key: 'omen', label: 'omen', glyph: 'M10 2 L18 18 L2 18 Z', before: false },
      { key: 'origin', label: 'origin', glyph: 'backstory', before: true },
    ],
    weights: ['footnote', 'scene', 'watershed'],
  });
  assert.deepEqual(vocab.cxVoc, {
    labels: { recap: 'Episode', same_recap: 'Same episode', group_npc: 'Folk' },
  });
});

// === L9: labels/timeline/recaps must be a table (top-level type mismatch) ========================

test('L9: labels = 1, timeline = "x", recaps = [] each give "must be a table"', () => {
  assertConfigError(() => vocabOf('labels = 1\n'), err('[labels] must be a table'));
  assertConfigError(() => vocabOf('timeline = "x"\n'), err('[timeline] must be a table'));
  assertConfigError(() => vocabOf('recaps = []\n'), err('[recaps] must be a table'));
});

// === L10: no Intl in labels.js =====================================================================

test('L10: labels.js never calls the Intl API', () => {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'build', 'labels.js'), 'utf8');
  assert.doesNotMatch(src, /\bIntl\s*\./);
});
