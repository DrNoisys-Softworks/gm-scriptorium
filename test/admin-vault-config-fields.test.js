'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fields = require('../src/admin/vaultconfigfields');
const vaultconfigedit = require('../src/admin/vaultconfigedit');

/*
 * V1e-10 (ADR 0033 second addendum, SD-110, SD-111): the guarded field-edit operation (c). Every
 * expected byte string below is written out by hand from the brief's own rules (indent, quoting,
 * insertion point), never produced by calling the renderer under test.
 */

function mk(frontmatter, { eol = '\n', body = 'BODY-LINE\n' } = {}) {
  const fm = frontmatter.split('\n').join(eol);
  return `---${eol}${fm}${eol}---${eol}${body.split('\n').join(eol)}`;
}

function prep(text) {
  const buf = Buffer.from(text, 'utf8');
  const split = vaultconfigedit.splitFileDetailed(buf);
  assert.equal(split.ok, true, 'fixture must split');
  const parsed = vaultconfigedit.parseWithBothDetailed(text);
  assert.equal(parsed.ok, true, 'fixture must parse');
  return { split, data: parsed.scriptorium.data, buf };
}

function apply(text, edits, opts) {
  const { split, data } = prep(text);
  return fields.applyFieldEdits(split, data, edits, opts);
}

function applied(text, edits) {
  const r = apply(text, edits);
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  return r;
}

const BASE = [
  'type: meta',
  'publish:',
  '  mode: player',
  '  exclude_fields: ["secrets", "gm_notes"]',
  '  landing:',
  '    featured_npcs: ["A", "B"]',
  '    max_npcs: 6',
  '  four_oh_four:',
  '    message: "Lost"',
].join('\n');

// === Schema =====================================================================================

test('FIELD_SCHEMA is frozen, in the brief\'s order, with the brief\'s kinds, groups and labels', () => {
  assert.equal(Object.isFrozen(fields.FIELD_SCHEMA), true);
  const flat = fields.FIELD_SCHEMA.map((f) => [f.path, f.kind, f.group, f.label]);
  assert.deepEqual(flat, [
    ['publish.exclude_fields', 'list', 'privacy', 'Hidden fields'],
    ['publish.exclude_sections', 'list', 'privacy', 'Hidden headings'],
    ['publish.exclude_dirs', 'list', 'privacy', 'Hidden folders'],
    ['publish.landing.featured_npcs', 'list', 'safe', 'Featured characters'],
    ['publish.landing.quick_links', 'list', 'safe', 'Quick links'],
    ['publish.landing.max_npcs', 'int', 'safe', 'How many characters to show'],
    ['publish.four_oh_four.message', 'string', 'safe', 'Not-found message'],
  ]);
  assert.equal(fields.FIELD_SCHEMA.length, 7);
});

test('DISPLAY_PATHS is the six read-only paths with their groups and labels', () => {
  assert.equal(Object.isFrozen(fields.DISPLAY_PATHS), true);
  assert.deepEqual(
    fields.DISPLAY_PATHS.map((d) => [d.path, d.group, d.label]),
    [
      ['publish.mode', 'privacy', 'Publish mode'],
      ['publish.theme.palette', 'look', 'Colours'],
      ['publish.theme.fonts', 'look', 'Fonts'],
      ['publish.theme.campaign_image', 'look', 'Cover art'],
      ['publish.theme.genre', 'look', 'Genre preset'],
      ['publish.banners', 'look', 'Section banners'],
    ],
  );
});

// === Set: each kind =============================================================================

test('list set (flow) keeps the key line and renders double-quoted entries', () => {
  const r = applied(mk(BASE), { 'publish.landing.featured_npcs': ['A', 'B', 'C'] });
  assert.equal(
    r.bytes.toString('utf8'),
    mk(BASE.replace('featured_npcs: ["A", "B"]', 'featured_npcs: ["A", "B", "C"]')),
  );
  assert.deepEqual(r.notes, []);
});

test('int set replaces only the value', () => {
  const r = applied(mk(BASE), { 'publish.landing.max_npcs': 9 });
  assert.equal(r.bytes.toString('utf8'), mk(BASE.replace('max_npcs: 6', 'max_npcs: 9')));
});

test('string set writes a JSON-quoted scalar (quotes and backslashes escaped)', () => {
  const r = applied(mk(BASE), { 'publish.four_oh_four.message': 'Not "here", friend \\ ok' });
  assert.equal(
    r.bytes.toString('utf8'),
    mk(BASE.replace('message: "Lost"', 'message: "Not \\"here\\", friend \\\\ ok"')),
  );
});

test('an empty list is written as [] even where the file used a block list', () => {
  const text = mk('publish:\n  exclude_dirs:\n    - "x"\n    - "y"');
  const r = applied(text, { 'publish.exclude_dirs': [] });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  exclude_dirs: []'));
});

// === Set: block and indentless ==================================================================

test('block list keeps its own item indent', () => {
  const text = mk('publish:\n  exclude_fields:\n      - "a"\n      - b');
  const r = applied(text, { 'publish.exclude_fields': ['a', 'c'] });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  exclude_fields:\n      - "a"\n      - "c"'));
});

test('an indentless block list (items at the key indent) stays indentless', () => {
  const text = mk('publish:\n  exclude_fields:\n  - a\n  - b\n  mode: player');
  const r = applied(text, { 'publish.exclude_fields': ['a', 'z'] });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  exclude_fields:\n  - "a"\n  - "z"\n  mode: player'));
});

// === Insert =====================================================================================

test('an absent leaf under a present parent is inserted at the end of the parent range, at the child indent', () => {
  const r = applied(mk(BASE), { 'publish.landing.quick_links': ['x', 'y'] });
  const expected = BASE.replace('    max_npcs: 6\n', '    max_npcs: 6\n    quick_links: ["x", "y"]\n');
  assert.equal(r.bytes.toString('utf8'), mk(expected));
});

test('an absent leaf goes BEFORE the blank lines that trail its parent range', () => {
  const text = mk('publish:\n  landing:\n    max_npcs: 3\n\n\n  four_oh_four:\n    message: "m"');
  const r = applied(text, { 'publish.landing.featured_npcs': ['Q'] });
  assert.equal(
    r.bytes.toString('utf8'),
    mk('publish:\n  landing:\n    max_npcs: 3\n    featured_npcs: ["Q"]\n\n\n  four_oh_four:\n    message: "m"'),
  );
});

test('an absent landing header is inserted at publish\'s child indent, then the leaf one step in', () => {
  const text = mk('type: meta\npublish:\n  mode: player');
  const r = applied(text, { 'publish.landing.max_npcs': 5 });
  assert.equal(r.bytes.toString('utf8'), mk('type: meta\npublish:\n  mode: player\n  landing:\n    max_npcs: 5'));
});

test('the step follows publish\'s own child indent (4 here), not a fixed 2', () => {
  const text = mk('publish:\n    mode: player');
  const r = applied(text, { 'publish.landing.max_npcs': 5 });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n    mode: player\n    landing:\n        max_npcs: 5'));
});

test('an absent publish block is added at column 0 at the end of the frontmatter', () => {
  const text = mk('type: meta');
  const r = applied(text, { 'publish.four_oh_four.message': 'Gone' });
  assert.equal(r.bytes.toString('utf8'), mk('type: meta\npublish:\n  four_oh_four:\n    message: "Gone"'));
});

test('an absent publish block is added after trailing blank lines are excluded from the end', () => {
  const text = mk('type: meta\n\n');
  const { split } = prep(text);
  assert.deepEqual(split.lines, ['type: meta\n', '\n', '\n']);
  const r = applied(text, { 'publish.landing.max_npcs': 1 });
  assert.equal(r.bytes.toString('utf8'), mk('type: meta\npublish:\n  landing:\n    max_npcs: 1\n\n'));
});

test('an absent exclude list is inserted in flow form at the end of publish', () => {
  const text = mk('publish:\n  mode: player\n  landing:\n    max_npcs: 2');
  const r = applied(text, { 'publish.exclude_dirs': ['Secret'] });
  // publish's range runs to the end of the frontmatter, so the new key follows landing's last line.
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  mode: player\n  landing:\n    max_npcs: 2\n  exclude_dirs: ["Secret"]'));
});

// === Line endings, trailing blanks, comments ====================================================

test('CRLF: every written byte uses \\r\\n', () => {
  const text = mk(BASE, { eol: '\r\n' });
  const r = applied(text, { 'publish.landing.max_npcs': 7, 'publish.landing.quick_links': ['k'] });
  assert.equal(
    r.bytes.toString('utf8'),
    mk(BASE.replace('max_npcs: 6', 'max_npcs: 7\n    quick_links: ["k"]'), { eol: '\r\n' }),
  );
  assert.doesNotMatch(r.bytes.toString('utf8').replace(/\r\n/g, ''), /[\r\n]/, 'no bare CR or LF anywhere');
});

test('trailing blank lines after a replaced scalar are kept (the tagline regression)', () => {
  const text = mk('publish:\n  four_oh_four:\n    message: "x"\n\n\nother: 1');
  const r = applied(text, { 'publish.four_oh_four.message': 'y' });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  four_oh_four:\n    message: "y"\n\n\nother: 1'));
});

test('trailing blank lines after a replaced block list are kept', () => {
  const text = mk('publish:\n  exclude_fields:\n    - "a"\n\n  mode: player');
  const r = applied(text, { 'publish.exclude_fields': ['a', 'b'] });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  exclude_fields:\n    - "a"\n    - "b"\n\n  mode: player'));
});

test('a comment elsewhere in the file, and the body, are byte-untouched', () => {
  const fm = '# top\ntype: meta # kind\npublish:\n  mode: player # keep\n  landing:\n    max_npcs: 6\n# tail comment';
  const r = applied(mk(fm), { 'publish.landing.max_npcs': 8 });
  assert.equal(r.bytes.toString('utf8'), mk(fm.replace('max_npcs: 6', 'max_npcs: 8')));
});

test('notes: a comment on the edited line is removed, and named by the field label', () => {
  const r = applied(mk('publish:\n  landing:\n    max_npcs: 6 # six'), { 'publish.landing.max_npcs': 7 });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  landing:\n    max_npcs: 7'));
  assert.deepEqual(r.notes, ['A comment on the How many characters to show line is removed.']);
});

test('notes: a list written in single quotes is written back double-quoted, and says so', () => {
  const r = applied(mk("publish:\n  landing:\n    featured_npcs: ['A', 'B']"), { 'publish.landing.featured_npcs': ['A'] });
  assert.equal(r.bytes.toString('utf8'), mk('publish:\n  landing:\n    featured_npcs: ["A"]'));
  assert.deepEqual(r.notes, ['The featured_npcs list is written back with every entry in double quotes.']);
});

// === Sibling and ancestor traps =================================================================

test('a sibling key exclude_fields_old is never touched, whether exclude_fields exists or not', () => {
  const present = mk('publish:\n  exclude_fields_old: ["x"]\n  exclude_fields: ["a"]');
  assert.equal(
    applied(present, { 'publish.exclude_fields': ['b'] }).bytes.toString('utf8'),
    mk('publish:\n  exclude_fields_old: ["x"]\n  exclude_fields: ["b"]'),
  );
  const absent = mk('publish:\n  exclude_fields_old: ["x"]');
  assert.equal(
    applied(absent, { 'publish.exclude_fields': ['b'] }).bytes.toString('utf8'),
    mk('publish:\n  exclude_fields_old: ["x"]\n  exclude_fields: ["b"]'),
  );
});

test('a top-level landing: block is not publish.landing, so the leaf is inserted fresh under publish', () => {
  const text = mk('landing:\n  max_npcs: 3\npublish:\n  mode: player');
  const r = applied(text, { 'publish.landing.max_npcs': 4 });
  assert.equal(
    r.bytes.toString('utf8'),
    mk('landing:\n  max_npcs: 3\npublish:\n  mode: player\n  landing:\n    max_npcs: 4'),
  );
});

// === Multi-path =================================================================================

test('several paths in one call apply in FIELD_SCHEMA order and give typed final bytes', () => {
  const edits = {
    'publish.four_oh_four.message': 'Gone',
    'publish.landing.max_npcs': 2,
    'publish.exclude_dirs': ['Secret'],
    'publish.landing.featured_npcs': ['Z'],
  };
  const r = applied(mk(BASE), edits);
  const expected = [
    'type: meta',
    'publish:',
    '  mode: player',
    '  exclude_fields: ["secrets", "gm_notes"]',
    '  landing:',
    '    featured_npcs: ["Z"]',
    '    max_npcs: 2',
    '  four_oh_four:',
    '    message: "Gone"',
    '  exclude_dirs: ["Secret"]',
  ].join('\n');
  assert.equal(r.bytes.toString('utf8'), mk(expected));
});

test('a path whose requested value equals its current value is skipped; all skipped returns the same bytes', () => {
  const text = mk("publish:\n  landing:\n    max_npcs: 6 # six\n    featured_npcs: ['A']");
  const r = applied(text, { 'publish.landing.max_npcs': 6, 'publish.landing.featured_npcs': ['A'] });
  assert.equal(r.bytes.toString('utf8'), text);
  assert.deepEqual(r.notes, []);
});

// === Refusals ===================================================================================

function refusalOf(text, edits) {
  const r = apply(text, edits);
  assert.equal(r.ok, false, 'expected a refusal');
  return r;
}

test('refusal: a flow mapping parent', () => {
  const r = refusalOf(mk('publish:\n  landing: {max_npcs: 3}'), { 'publish.landing.max_npcs': 4 });
  assert.deepEqual(r, { ok: false, path: 'publish.landing.max_npcs', form: 'a flow mapping' });
});

test('refusal: a merge key beside the target', () => {
  const text = mk('base: &b\n  x: 1\npublish:\n  <<: *b\n  landing:\n    max_npcs: 3');
  const r = refusalOf(text, { 'publish.landing.max_npcs': 4 });
  assert.equal(r.path, 'publish.landing.max_npcs');
  assert.equal(r.form, 'a merge key');
});

test('refusal: a list written across several lines', () => {
  const text = mk('publish:\n  landing:\n    featured_npcs: ["A",\n      "B"]');
  const r = refusalOf(text, { 'publish.landing.featured_npcs': ['C'] });
  assert.deepEqual(r, { ok: false, path: 'publish.landing.featured_npcs', form: 'a list written across several lines' });
});

test('refusal: a block list with comments between the entries', () => {
  const text = mk('publish:\n  exclude_fields:\n    - a\n    # why\n    - b');
  const r = refusalOf(text, { 'publish.exclude_fields': ['c'] });
  assert.deepEqual(r, { ok: false, path: 'publish.exclude_fields', form: 'comments between the entries' });
});

test('refusal: a block scalar message', () => {
  const text = mk('publish:\n  four_oh_four:\n    message: |\n      hello');
  const r = refusalOf(text, { 'publish.four_oh_four.message': 'x' });
  assert.deepEqual(r, { ok: false, path: 'publish.four_oh_four.message', form: 'a block scalar' });
});

test('refusal: an anchored value', () => {
  const text = mk('publish:\n  landing:\n    max_npcs: &n 3');
  const r = refusalOf(text, { 'publish.landing.max_npcs': 4 });
  assert.deepEqual(r, { ok: false, path: 'publish.landing.max_npcs', form: 'an anchor, alias or tag' });
});

test('refusal: a quoted message that continues on the next line', () => {
  const text = mk('publish:\n  four_oh_four:\n    message: "one\n      two"');
  const r = refusalOf(text, { 'publish.four_oh_four.message': 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.path, 'publish.four_oh_four.message');
  assert.equal(r.form, 'a value written across several lines');
});

test('refusal: a list field that is a plain scalar today, and an int field that is a list today', () => {
  const a = refusalOf(mk('publish:\n  exclude_dirs: nothing'), { 'publish.exclude_dirs': ['x'] });
  assert.deepEqual(a, { ok: false, path: 'publish.exclude_dirs', form: "a setting that isn't a list here" });
  const b = refusalOf(mk('publish:\n  landing:\n    max_npcs: [1]'), { 'publish.landing.max_npcs': 2 });
  assert.equal(b.ok, false);
  assert.equal(b.path, 'publish.landing.max_npcs');
});

test('refusal: a tab in the frontmatter indent', () => {
  const text = '---\npublish:\n\tmode: x\n---\n';
  const buf = Buffer.from(text);
  const split = vaultconfigedit.splitFileDetailed(buf);
  // js-yaml refuses tab indent, so hand the locator the data of a clean twin.
  const data = vaultconfigedit.parseWithBothDetailed('---\npublish:\n  mode: x\n---\n').scriptorium.data;
  const r = fields.applyFieldEdits(split, data, { 'publish.landing.max_npcs': 1 });
  assert.equal(r.ok, false);
  assert.equal(r.form, 'an unusual layout');
});

// === Guards =====================================================================================

function splitOf(text) {
  return vaultconfigedit.splitFileDetailed(Buffer.from(text, 'utf8'));
}

test('fieldTextualGuard (list): refuses a deleted comment, an unrelated added line, and a head/tail change', () => {
  const prev = splitOf(mk('publish:\n  # note\n  exclude_dirs: ["a"]'));
  const okNext = splitOf(mk('publish:\n  # note\n  exclude_dirs: ["a", "b"]'));
  assert.equal(fields.fieldTextualGuard(prev, okNext, 'exclude_dirs', 'list'), true);

  const commentGone = splitOf(mk('publish:\n  exclude_dirs: ["a", "b"]'));
  assert.equal(fields.fieldTextualGuard(prev, commentGone, 'exclude_dirs', 'list'), false);

  const extraKey = splitOf(mk('publish:\n  # note\n  exclude_dirs: ["a"]\n  mode: full'));
  assert.equal(fields.fieldTextualGuard(prev, extraKey, 'exclude_dirs', 'list'), false);

  const tailChanged = splitOf(mk('publish:\n  # note\n  exclude_dirs: ["a", "b"]', { body: 'OTHER\n' }));
  assert.equal(fields.fieldTextualGuard(prev, tailChanged, 'exclude_dirs', 'list'), false);

  const headChanged = splitOf('---\r\n' + 'publish:\r\n  # note\r\n  exclude_dirs: ["a", "b"]\r\n---\r\nBODY-LINE\r\n');
  assert.equal(fields.fieldTextualGuard(prev, headChanged, 'exclude_dirs', 'list'), false);
});

test('fieldTextualGuard (int): only `<leaf>: <digits>` may be added', () => {
  const prev = splitOf(mk('publish:\n  landing:\n    max_npcs: 6'));
  const good = splitOf(mk('publish:\n  landing:\n    max_npcs: 10'));
  assert.equal(fields.fieldTextualGuard(prev, good, 'max_npcs', 'int'), true);
  const alpha = splitOf(mk('publish:\n  landing:\n    max_npcs: ten'));
  assert.equal(fields.fieldTextualGuard(prev, alpha, 'max_npcs', 'int'), false);
  const injected = splitOf(mk('publish:\n  landing:\n    max_npcs: 10\n    mode: full'));
  assert.equal(fields.fieldTextualGuard(prev, injected, 'max_npcs', 'int'), false);
  const trailing = splitOf(mk('publish:\n  landing:\n    max_npcs: 10 # hi'));
  assert.equal(fields.fieldTextualGuard(prev, trailing, 'max_npcs', 'int'), false);
});

test('fieldTextualGuard (string): only a JSON-quoted scalar may be added', () => {
  const prev = splitOf(mk('publish:\n  four_oh_four:\n    message: "a"'));
  const good = splitOf(mk('publish:\n  four_oh_four:\n    message: "b \\"c\\""'));
  assert.equal(fields.fieldTextualGuard(prev, good, 'message', 'string'), true);
  const bare = splitOf(mk('publish:\n  four_oh_four:\n    message: b'));
  assert.equal(fields.fieldTextualGuard(prev, bare, 'message', 'string'), false);
  const unescaped = splitOf(mk('publish:\n  four_oh_four:\n    message: "b" c"'));
  assert.equal(fields.fieldTextualGuard(prev, unescaped, 'message', 'string'), false);
});

test('fieldTextualGuard: the three header lines (publish, landing, four_oh_four) are allowed additions, nothing else is', () => {
  const prev = splitOf(mk('type: meta'));
  const withHeaders = splitOf(mk('type: meta\npublish:\n  landing:\n    max_npcs: 1'));
  assert.equal(fields.fieldTextualGuard(prev, withHeaders, 'max_npcs', 'int'), true);
  const otherHeader = splitOf(mk('type: meta\npublish:\n  theme:\n    max_npcs: 1'));
  assert.equal(fields.fieldTextualGuard(prev, otherHeader, 'max_npcs', 'int'), false);
});

test('pathsGuard on a field edit: passes the exact edit, refuses a second changed path and a wrong value', () => {
  const cur = { type: 'meta', publish: { mode: 'player', landing: { max_npcs: 6 } } };
  const edits = [{ segments: ['publish', 'landing', 'max_npcs'], value: 9 }];
  assert.equal(fields.pathsGuard(cur, { type: 'meta', publish: { mode: 'player', landing: { max_npcs: 9 } } }, edits), true);
  assert.equal(fields.pathsGuard(cur, { type: 'meta', publish: { mode: 'full', landing: { max_npcs: 9 } } }, edits), false);
  assert.equal(fields.pathsGuard(cur, { type: 'meta', publish: { mode: 'player', landing: { max_npcs: 8 } } }, edits), false);
  assert.equal(fields.pathsGuard(cur, cur, edits), false, 'a candidate that did not change the value at all is refused');
});

test('applyFieldEdits runs the per-step textual guard: a tampered step that drops a comment is refused', () => {
  const text = mk('publish:\n  # keep me\n  landing:\n    max_npcs: 6');
  const r = apply(text, { 'publish.landing.max_npcs': 7 }, {
    _afterRender(lines) {
      return lines.filter((l) => !l.includes('# keep me'));
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.path, 'publish.landing.max_npcs');
});

test('applyFieldEdits runs pathsGuard after the steps: a tampered step that also changes publish.mode is refused', () => {
  const text = mk('publish:\n  mode: player\n  landing:\n    max_npcs: 6');
  const r = apply(text, { 'publish.landing.max_npcs': 7 }, {
    _afterRender(lines) {
      // Keeps every textual rule satisfied (the replaced line is still `max_npcs: 7`) but ALSO
      // flips the mode on its own line, a change the per-step guard cannot see as "added" only if
      // the guard were skipped. The semantic guard is what must catch it.
      return lines.map((l) => l.replace('mode: player', 'mode: full'));
    },
    _skipTextualGuard: true,
  });
  assert.equal(r.ok, false);
});

// === Value validation ===========================================================================

test('validateFieldValue: lists', () => {
  const entry = fields.FIELD_SCHEMA[0];
  assert.equal(fields.validateFieldValue(entry, ['a', 'b']), null);
  assert.match(fields.validateFieldValue(entry, 'a'), /^Hidden fields: /);
  assert.match(fields.validateFieldValue(entry, ['a', 'a']), /^Hidden fields: .*twice/);
  assert.match(fields.validateFieldValue(entry, [' a']), /^Hidden fields: /);
  assert.match(fields.validateFieldValue(entry, ['a ']), /^Hidden fields: /);
  assert.match(fields.validateFieldValue(entry, ['']), /^Hidden fields: /);
  assert.match(fields.validateFieldValue(entry, ['x'.repeat(201)]), /^Hidden fields: /);
  assert.equal(fields.validateFieldValue(entry, ['x'.repeat(200)]), null);
  assert.match(fields.validateFieldValue(entry, ['a\nb']), /^Hidden fields: /);
  assert.match(fields.validateFieldValue(entry, ['a\u007fb']), /^Hidden fields: /);
  assert.match(fields.validateFieldValue(entry, ['a\u0000b']), /^Hidden fields: /);
  assert.match(fields.validateFieldValue(entry, [3]), /^Hidden fields: /);
  const hundred = Array.from({ length: 100 }, (_, i) => `e${i}`);
  assert.equal(fields.validateFieldValue(entry, hundred), null);
  assert.match(fields.validateFieldValue(entry, hundred.concat('one-more')), /^Hidden fields: /);
});

test('validateFieldValue: the length limits count code points, not UTF-16 units', () => {
  const entry = fields.FIELD_SCHEMA[0];
  const twoHundredAstral = '\u{1F409}'.repeat(200); // 200 code points, 400 UTF-16 units
  assert.equal(fields.validateFieldValue(entry, [twoHundredAstral]), null);
  assert.match(fields.validateFieldValue(entry, [twoHundredAstral + 'x']), /^Hidden fields: /);
});

test('validateFieldValue: ints', () => {
  const entry = fields.FIELD_SCHEMA[5];
  assert.equal(fields.validateFieldValue(entry, 0), null);
  assert.equal(fields.validateFieldValue(entry, 100), null);
  for (const bad of [-1, 101, 1.5, '5', null, NaN, Infinity, [], {}]) {
    assert.match(fields.validateFieldValue(entry, bad), /^How many characters to show: /, String(bad));
  }
});

test('validateFieldValue: strings', () => {
  const entry = fields.FIELD_SCHEMA[6];
  assert.equal(fields.validateFieldValue(entry, 'a'), null);
  assert.equal(fields.validateFieldValue(entry, 'x'.repeat(300)), null);
  assert.match(fields.validateFieldValue(entry, ''), /^Not-found message: /);
  assert.match(fields.validateFieldValue(entry, 'x'.repeat(301)), /^Not-found message: /);
  assert.match(fields.validateFieldValue(entry, 'a\tb'), /^Not-found message: /);
  assert.match(fields.validateFieldValue(entry, 7), /^Not-found message: /);
});

test('fieldTextualGuard (list): a diff narrowed to whole entry lines passes only for entry lines', () => {
  const prev = splitOf(mk('publish:\n  exclude_fields:\n    - "a"\n    - b'));
  const entriesOnly = splitOf(mk('publish:\n  exclude_fields:\n    - "a"\n    - "c"'));
  assert.equal(fields.fieldTextualGuard(prev, entriesOnly, 'exclude_fields', 'list'), true);
  // The same narrowing for a scalar leaf is never allowed: the key line must be among the removed.
  const prevScalar = splitOf(mk('publish:\n  landing:\n    max_npcs: 6\n    other: 1'));
  const nextScalar = splitOf(mk('publish:\n  landing:\n    max_npcs: 6\n    max_npcs: 9'));
  assert.equal(fields.fieldTextualGuard(prevScalar, nextScalar, 'max_npcs', 'int'), false);
});
