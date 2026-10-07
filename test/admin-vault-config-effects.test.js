'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeEffects, summarizeChange, PRIVACY_LIST_PATHS } = require('../src/admin/vaultconfigeffects');
const vaultconfigfields = require('../src/admin/vaultconfigfields');
const vaultconfigedit = require('../src/admin/vaultconfigedit');

/*
 * V1e-9 (ADR 0033 addendum, SD-96/SD-97). Independent literals throughout (CLAUDE.md: never
 * derive an assertion's expected value from the code under test).
 */

function split(text) {
  const r = vaultconfigedit.splitFile(Buffer.from(text, 'utf8'));
  if (!r.ok) throw new Error('fixture split failed: ' + r.reason);
  return r;
}

function basePublish(overrides) {
  return {
    publishConfig: Object.assign(
      { mode: 'player', exclude_fields: [], exclude_sections: [], exclude_dirs: [], exclude_drafts: false, exclude_callouts: false, overrides: { fields: {} } },
      overrides,
    ),
    configSources: { vault: { exclude_fields: undefined, exclude_sections: undefined, exclude_dirs: undefined } },
  };
}

const NO_FIX = new Set();

// -- computeEffects: one test per table row, with independently-typed literal expectations ------

test('mode: effective mode changes to something other than player -> bad', () => {
  const cur = { publish: { mode: 'player' } };
  const cand = { publish: { mode: 'full' } };
  const effects = computeEffects({
    cur,
    cand,
    curPublish: basePublish({ mode: 'player' }),
    candPublish: basePublish({ mode: 'full' }),
    jsonConfig: null,
    publishSet: null,
    fixable: NO_FIX,
  });
  assert.deepEqual(effects, [
    {
      id: 'mode',
      group: 'privacy',
      level: 'bad',
      path: 'publish.mode',
      title: 'The publish mode changes from "player" to "full"',
      detail: 'player mode is what keeps GM-only pages off the site. Anything else can publish them.',
      fix: null,
    },
  ]);
});

test('mode: effective mode changes TO player -> info', () => {
  const cur = { publish: { mode: 'full' } };
  const cand = { publish: { mode: 'player' } };
  const effects = computeEffects({
    cur,
    cand,
    curPublish: basePublish({ mode: 'full' }),
    candPublish: basePublish({ mode: 'player' }),
    jsonConfig: null,
    publishSet: null,
    fixable: NO_FIX,
  });
  assert.deepEqual(effects, [
    {
      id: 'mode',
      group: 'privacy',
      level: 'info',
      path: 'publish.mode',
      title: 'The publish mode changes from "full" to "player"',
      detail: 'GM-only pages stay off the site.',
      fix: null,
    },
  ]);
});

test('mode-setting: raw mode text differs but the effective mode stays the same', () => {
  const cur = { publish: { mode: 'Player' } };
  const cand = { publish: { mode: 'player' } };
  const curPub = basePublish({ mode: 'player' });
  const candPub = basePublish({ mode: 'player' });
  const effects = computeEffects({ cur, cand, curPublish: curPub, candPublish: candPub, jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    {
      id: 'mode-setting',
      group: 'privacy',
      level: 'info',
      path: 'publish.mode',
      title: 'The publish mode setting changes, but the mode stays "player"',
      detail: '',
      fix: null,
    },
  ]);
});

test('list-removed: a field in the raw vault list is removed, with 2 published pages carrying it, and fix offered', () => {
  const cur = { publish: { exclude_fields: ['secrets'] } };
  const cand = { publish: { exclude_fields: [] } };
  const curPub = { publishConfig: { ...basePublish().publishConfig, exclude_fields: ['secrets'] }, configSources: { vault: { exclude_fields: ['secrets'] } } };
  const candPub = { publishConfig: { ...basePublish().publishConfig, exclude_fields: [] }, configSources: { vault: { exclude_fields: [] } } };
  const publishSet = {
    publishedPages: [
      { relPath: 'People/Beta.md', displayTitle: 'Beta', frontmatter: { secrets: 'x' } },
      { relPath: 'People/Alpha.md', displayTitle: 'Alpha', frontmatter: { secrets: 'y' } },
    ],
  };
  const fixable = new Set(['publish.exclude_fields']);
  const effects = computeEffects({ cur, cand, curPublish: curPub, candPublish: candPub, jsonConfig: null, publishSet, fixable });
  assert.deepEqual(effects, [
    {
      id: 'list-removed',
      group: 'privacy',
      level: 'bad',
      path: 'publish.exclude_fields',
      title: 'The "secrets" field is no longer hidden',
      detail: '2 published page(s) carry a secrets field: Alpha, Beta. It would be published to players.',
      fix: { path: 'publish.exclude_fields', entry: 'secrets' },
    },
  ]);
});

test('list-removed: a field hidden only via the built-in defaults names the "replaces the built-in defaults" variant', () => {
  const cur = { publish: {} };
  const cand = { publish: { exclude_fields: ['decoy'] } };
  const curPub = { publishConfig: { ...basePublish().publishConfig, exclude_fields: ['secrets'] }, configSources: { vault: { exclude_fields: undefined } } };
  const candPub = { publishConfig: { ...basePublish().publishConfig, exclude_fields: ['decoy'] }, configSources: { vault: { exclude_fields: ['decoy'] } } };
  const effects = computeEffects({ cur, cand, curPublish: curPub, candPublish: candPub, jsonConfig: null, publishSet: null, fixable: NO_FIX });
  const removed = effects.find((e) => e.id === 'list-removed');
  assert.ok(removed, 'expected a list-removed finding');
  assert.equal(removed.title, 'The "secrets" field is no longer hidden: your list replaces the built-in defaults');
  assert.equal(removed.detail, 'Anything in it would be published to players.');
});

test('list-unioned: removed from the vault\'s own raw list but still effectively hidden via vault.config.json -> info only', () => {
  const cur = { publish: { exclude_sections: ['Secret Lore'] } };
  const cand = { publish: {} };
  const curPub = { publishConfig: { ...basePublish().publishConfig, exclude_sections: ['Secret Lore'] }, configSources: { vault: { exclude_sections: ['Secret Lore'] } } };
  const candPub = { publishConfig: { ...basePublish().publishConfig, exclude_sections: ['Secret Lore'] }, configSources: { vault: { exclude_sections: undefined } } };
  const effects = computeEffects({ cur, cand, curPublish: curPub, candPublish: candPub, jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    {
      id: 'list-unioned',
      group: 'privacy',
      level: 'info',
      path: 'publish.exclude_sections',
      title: '"Secret Lore" stays hidden',
      detail: 'You removed it here, but vault.config.json still hides it. Both lists count.',
      fix: null,
    },
  ]);
});

test('list-added: a new folder exclusion -> ok, empty detail', () => {
  const cur = { publish: {} };
  const cand = { publish: { exclude_dirs: ['Scratch'] } };
  const curPub = basePublish({ exclude_dirs: [] });
  const candPub = { publishConfig: { ...basePublish().publishConfig, exclude_dirs: ['Scratch'] }, configSources: { vault: { exclude_dirs: ['Scratch'] } } };
  const effects = computeEffects({ cur, cand, curPublish: curPub, candPublish: candPub, jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    {
      id: 'list-added',
      group: 'privacy',
      level: 'ok',
      path: 'publish.exclude_dirs',
      title: 'The "Scratch" folder is now hidden too',
      detail: '',
      fix: null,
    },
  ]);
});

test('drafts: true to false -> bad; false to true -> ok', () => {
  const curPub = basePublish({ exclude_drafts: true });
  const candPub = basePublish({ exclude_drafts: false });
  const bad = computeEffects({ cur: {}, cand: {}, curPublish: curPub, candPublish: candPub, jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(bad, [
    {
      id: 'drafts',
      group: 'privacy',
      level: 'bad',
      path: 'publish.exclude_drafts',
      title: 'Draft pages can now be published',
      detail: 'exclude_drafts is off, so pages marked as drafts are no longer left out.',
      fix: null,
    },
  ]);
  const ok = computeEffects({
    cur: {},
    cand: {},
    curPublish: basePublish({ exclude_drafts: false }),
    candPublish: basePublish({ exclude_drafts: true }),
    jsonConfig: null,
    publishSet: null,
    fixable: NO_FIX,
  });
  assert.deepEqual(ok, [
    {
      id: 'drafts',
      group: 'privacy',
      level: 'ok',
      path: 'publish.exclude_drafts',
      title: 'Draft pages are now left out',
      detail: 'exclude_drafts is on, so pages marked as drafts are left out.',
      fix: null,
    },
  ]);
});

test('callouts: narrowing (losing a type) -> bad; widening (gaining) -> ok', () => {
  const narrow = computeEffects({
    cur: {},
    cand: {},
    curPublish: basePublish({ exclude_callouts: ['warning', 'gm'] }),
    candPublish: basePublish({ exclude_callouts: ['warning'] }),
    jsonConfig: null,
    publishSet: null,
    fixable: NO_FIX,
  });
  assert.deepEqual(narrow, [
    {
      id: 'callouts',
      group: 'privacy',
      level: 'bad',
      path: 'publish.exclude_callouts',
      title: 'Fewer callouts are stripped',
      detail: 'Only these are stripped now: warning.',
      fix: null,
    },
  ]);
  const widen = computeEffects({
    cur: {},
    cand: {},
    curPublish: basePublish({ exclude_callouts: ['warning'] }),
    candPublish: basePublish({ exclude_callouts: true }),
    jsonConfig: null,
    publishSet: null,
    fixable: NO_FIX,
  });
  assert.deepEqual(widen, [
    {
      id: 'callouts',
      group: 'privacy',
      level: 'ok',
      path: 'publish.exclude_callouts',
      title: 'More callouts are stripped',
      detail: 'Only these are stripped now: all callouts.',
      fix: null,
    },
  ]);
});

test('overrides: a raw publish.overrides change is always bad', () => {
  const cur = { publish: { overrides: { fields: {} } } };
  const cand = { publish: { overrides: { fields: { secrets: { include: ['People/A.md'] } } } } };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    {
      id: 'overrides',
      group: 'privacy',
      level: 'bad',
      path: 'publish.overrides',
      title: 'The per-page field overrides change',
      detail: 'publish.overrides can show a hidden field on one page. Check the line-by-line change.',
      fix: null,
    },
  ]);
});

test('look-palette: a colour change is reported per differing subkey, joined by "; "', () => {
  const cur = { publish: { theme: { palette: { primary: '#111111', accent: '#222222' } } } };
  const cand = { publish: { theme: { palette: { primary: '#333333', accent: '#222222' } } } };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    {
      id: 'look-palette',
      group: 'look',
      level: 'look',
      path: 'publish.theme.palette',
      title: 'The colours change',
      detail: 'primary: #111111 becomes #333333',
      fix: null,
    },
  ]);
});

test('look-genre: a scalar look change has no subkey label', () => {
  const cur = { publish: { theme: { genre: 'noir' } } };
  const cand = { publish: { theme: { genre: 'gothic' } } };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    { id: 'look-genre', group: 'look', level: 'look', path: 'publish.theme.genre', title: 'The genre preset changes', detail: 'noir becomes gothic', fix: null },
  ]);
});

test('featured-added / featured-removed', () => {
  const cur = { publish: { landing: { featured_npcs: ['Orpiment'] } } };
  const cand = { publish: { landing: { featured_npcs: ['Ivo'] } } };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    {
      id: 'featured-added',
      group: 'safe',
      level: 'ok',
      path: 'publish.landing.featured_npcs',
      title: 'Ivo joins the featured characters',
      detail: "Shown first in the landing page's characters row.",
      fix: null,
    },
    {
      id: 'featured-removed',
      group: 'safe',
      level: 'ok',
      path: 'publish.landing.featured_npcs',
      title: 'Orpiment is no longer featured',
      detail: 'They can still appear on the landing page by recency.',
      fix: null,
    },
  ]);
});

test('landing-<key>: another landing subkey', () => {
  const cur = { publish: { landing: { max_npcs: 3 } } };
  const cand = { publish: { landing: { max_npcs: 5 } } };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    { id: 'landing-max_npcs', group: 'safe', level: 'ok', path: 'publish.landing.max_npcs', title: "The landing page's max_npcs setting changes", detail: '3 becomes 5', fix: null },
  ]);
});

test('not-found: the message key has its own literal copy; another key uses the generic template', () => {
  const cur = { publish: { four_oh_four: { message: 'Old', extra: 'A' } } };
  const cand = { publish: { four_oh_four: { message: 'New', extra: 'B' } } };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    { id: 'not-found', group: 'safe', level: 'ok', path: 'publish.four_oh_four.extra', title: "The not-found page's extra setting changes", detail: 'A becomes B', fix: null },
    { id: 'not-found', group: 'safe', level: 'ok', path: 'publish.four_oh_four.message', title: 'The not-found message changes', detail: 'Players see it when a link goes nowhere.', fix: null },
  ]);
});

test('tagline', () => {
  const cur = { publish: { theme: { tagline: 'Old' } } };
  const cand = { publish: { theme: { tagline: 'New' } } };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    { id: 'tagline', group: 'safe', level: 'ok', path: 'publish.theme.tagline', title: 'The landing tagline changes', detail: 'This is the tagline the landing page actually shows.', fix: null },
  ]);
});

test('other: a path the panel does not read, up to 10 shown with an overflow note', () => {
  const cur = { system: 'Old System', year: 2020 };
  const cand = { system: 'New System', year: 2021 };
  const effects = computeEffects({ cur, cand, curPublish: basePublish(), candPublish: basePublish(), jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.deepEqual(effects, [
    { id: 'other', group: 'other', level: 'info', path: null, title: 'Other settings change', detail: "system, year. The panel doesn't read these; the line-by-line change shows them.", fix: null },
  ]);
});

test('current-unreadable: cur === null gives the info finding first, with the rest computed as if cur were {}', () => {
  const cand = { publish: { mode: 'full' } };
  const curPub = basePublish({ mode: 'player' });
  const candPub = basePublish({ mode: 'full' });
  const effects = computeEffects({ cur: null, cand, curPublish: curPub, candPublish: candPub, jsonConfig: null, publishSet: null, fixable: NO_FIX });
  assert.ok(effects.length > 0, 'expected at least the current-unreadable finding');
  assert.equal(effects[0].id, 'current-unreadable');
  assert.deepEqual(effects[0], {
    id: 'current-unreadable',
    group: 'other',
    level: 'info',
    path: null,
    title: "The file as it is now doesn't read",
    detail: 'So every setting in your edited copy is listed as a change.',
    fix: null,
  });
  assert.ok(effects.some((e) => e.id === 'mode'));
});

// -- summarizeChange literals --------------------------------------------------------------------

test('summarizeChange: one group, two groups, three groups, and the "before a save" fallbacks', () => {
  assert.equal(summarizeChange({ publish: { mode: 'player' } }, { publish: { mode: 'full' } }), 'before a change to publishing and privacy');
  assert.equal(
    summarizeChange({ publish: { mode: 'player', theme: { genre: 'noir' } } }, { publish: { mode: 'full', theme: { genre: 'gothic' } } }),
    'before a change to publishing and privacy and the look',
  );
  assert.equal(
    summarizeChange(
      { publish: { mode: 'player', theme: { genre: 'noir' }, landing: { max_npcs: 3 } }, system: 'A' },
      { publish: { mode: 'full', theme: { genre: 'gothic' }, landing: { max_npcs: 5 } }, system: 'B' },
    ),
    'before a change to publishing and privacy, the look, landing page words and other settings',
  );
  assert.equal(summarizeChange(null, { publish: { mode: 'full' } }), 'before a save');
  assert.equal(summarizeChange({ publish: { mode: 'full' } }, { publish: { mode: 'full' } }), 'before a save');
});

// -- vaultconfigfields: locatePath refusals --------------------------------------------------------

test('locatePath refusals: flow mapping, block scalar, anchor, merge key, multi-line flow list, comments between entries, a list of settings, non-string items', () => {
  const cases = [
    {
      name: 'flow mapping ancestor',
      text: '---\ntype: meta\npublish: {mode: full}\n---\n\nbody\n',
      data: { type: 'meta', publish: { mode: 'full' } },
      form: 'a flow mapping',
    },
    {
      name: 'block scalar ancestor',
      text: '---\ntype: meta\npublish: |\n  mode: full\n---\n\nbody\n',
      data: { type: 'meta', publish: 'mode: full\n' },
      form: 'a block scalar',
    },
    {
      name: 'anchor ancestor',
      text: '---\ntype: meta\npublish: &anchor\n  mode: full\n---\n\nbody\n',
      data: { type: 'meta', publish: { mode: 'full' } },
      form: 'an anchor, alias or tag',
    },
    {
      name: 'merge key',
      text: '---\ntype: meta\ndefaults: &d\n  mode: full\npublish:\n  <<: *d\n  exclude_fields: ["x"]\n---\n\nbody\n',
      data: { type: 'meta', defaults: { mode: 'full' }, publish: { mode: 'full', exclude_fields: ['x'] } },
      form: 'a merge key',
    },
    {
      name: 'multi-line flow list',
      text: '---\ntype: meta\npublish:\n  exclude_fields: [\n    "x"\n  ]\n---\n\nbody\n',
      data: { type: 'meta', publish: { exclude_fields: ['x'] } },
      form: 'a list written across several lines',
    },
    {
      name: 'comments between the entries',
      text: '---\ntype: meta\npublish:\n  exclude_fields:\n    - "secrets"\n    # a comment\n    - "plans"\n---\n\nbody\n',
      data: { type: 'meta', publish: { exclude_fields: ['secrets', 'plans'] } },
      form: 'comments between the entries',
    },
    {
      name: 'a list of settings',
      text: '---\ntype: meta\npublish:\n  exclude_fields:\n    - name: secrets\n---\n\nbody\n',
      data: { type: 'meta', publish: { exclude_fields: [{ name: 'secrets' }] } },
      form: 'a list of settings',
    },
    {
      name: 'non-string items (flow)',
      text: '---\ntype: meta\npublish:\n  exclude_fields: [1, 2]\n---\n\nbody\n',
      data: { type: 'meta', publish: { exclude_fields: [1, 2] } },
      form: 'a list holding something other than text',
    },
  ];
  for (const c of cases) {
    const result = vaultconfigfields.locatePath(split(c.text), c.data, ['publish', 'exclude_fields']);
    assert.equal(result.ok, false, c.name);
    assert.equal(result.form, c.form, c.name);
  }
});

test('locatePath: absent gives shape absent; present flow and block are located correctly', () => {
  const absent = vaultconfigfields.locatePath(
    split('---\ntype: meta\npublish:\n  mode: full\n---\n\nbody\n'),
    { type: 'meta', publish: { mode: 'full' } },
    ['publish', 'exclude_fields'],
  );
  assert.deepEqual(absent, { ok: true, shape: 'absent' });

  const flowSplit = split('---\ntype: meta\npublish:\n  exclude_fields: ["secrets", "plans"]\n---\n\nbody\n');
  const flow = vaultconfigfields.locatePath(flowSplit, { type: 'meta', publish: { exclude_fields: ['secrets', 'plans'] } }, ['publish', 'exclude_fields']);
  assert.equal(flow.ok, true);
  assert.equal(flow.shape, 'flow');

  const blockSplit = split('---\ntype: meta\npublish:\n  exclude_fields:\n    - "secrets"\n    - "plans"\n---\n\nbody\n');
  const block = vaultconfigfields.locatePath(blockSplit, { type: 'meta', publish: { exclude_fields: ['secrets', 'plans'] } }, ['publish', 'exclude_fields']);
  assert.equal(block.ok, true);
  assert.equal(block.shape, 'block');
  assert.equal(block.itemIndent, 4);
});

// -- setList: flow and block, CRLF bytes typed, notes --------------------------------------------

test('setList on a flow list rewrites it in place, bytes typed exactly', () => {
  const text = '---\r\ntype: meta\r\npublish:\r\n  exclude_fields: ["secrets"]\r\n---\r\n\r\nbody\r\n';
  const data = { type: 'meta', publish: { exclude_fields: ['secrets'] } };
  const s = split(text);
  const result = vaultconfigfields.setList(s, data, ['publish', 'exclude_fields'], ['secrets', 'tactics']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.bytes, Buffer.from('---\r\ntype: meta\r\npublish:\r\n  exclude_fields: ["secrets", "tactics"]\r\n---\r\n\r\nbody\r\n', 'utf8'));
  assert.deepEqual(result.notes, []);
});

test('setList on a block list rewrites each item line, keeping the existing item indent', () => {
  const text = '---\ntype: meta\npublish:\n  exclude_fields:\n    - "secrets"\n---\n\nbody\n';
  const data = { type: 'meta', publish: { exclude_fields: ['secrets'] } };
  const s = split(text);
  const result = vaultconfigfields.setList(s, data, ['publish', 'exclude_fields'], ['secrets', 'tactics']);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.bytes,
    Buffer.from('---\ntype: meta\npublish:\n  exclude_fields:\n    - "secrets"\n    - "tactics"\n---\n\nbody\n', 'utf8'),
  );
});

test('setList notes a removed comment on the key line', () => {
  const text = '---\ntype: meta\npublish:\n  exclude_fields: ["secrets"] # keep this hidden\n---\n\nbody\n';
  const data = { type: 'meta', publish: { exclude_fields: ['secrets'] } };
  const s = split(text);
  const result = vaultconfigfields.setList(s, data, ['publish', 'exclude_fields'], ['secrets']);
  assert.equal(result.ok, true);
  assert.ok(result.notes.includes('A comment on the exclude_fields line is removed.'));
});

test('setList refuses a setting that is not a list here (absent or scalar)', () => {
  const text = '---\ntype: meta\npublish:\n  mode: full\n---\n\nbody\n';
  const data = { type: 'meta', publish: { mode: 'full' } };
  const s = split(text);
  const result = vaultconfigfields.setList(s, data, ['publish', 'mode'], ['x']);
  assert.deepEqual(result, { ok: false, form: "a setting that isn't a list here" });
});

// -- listTextualGuard and pathsGuard: fed hand-built bad candidates, never the editor's own output --

test('listTextualGuard goes red on a hand-built candidate that also changes an unrelated line', () => {
  const curSplit = split('---\ntype: meta\npublish:\n  exclude_fields: ["secrets"]\n---\n\nbody\n');
  const badSplit = split('---\ntype: ALTERED\npublish:\n  exclude_fields: ["secrets", "tactics"]\n---\n\nbody\n');
  assert.equal(vaultconfigfields.listTextualGuard(curSplit, badSplit, 'exclude_fields'), false);
});

test('listTextualGuard goes red when an added line is not one of the allowed list-line shapes', () => {
  const curSplit = split('---\ntype: meta\npublish:\n  exclude_fields: ["secrets"]\n---\n\nbody\n');
  const badSplit = split('---\ntype: meta\npublish:\n  exclude_fields: ["secrets"]\n  evil: true\n---\n\nbody\n');
  assert.equal(vaultconfigfields.listTextualGuard(curSplit, badSplit, 'exclude_fields'), false);
});

test('listTextualGuard accepts a real setList output', () => {
  const curSplit = split('---\ntype: meta\npublish:\n  exclude_fields: ["secrets"]\n---\n\nbody\n');
  const data = { type: 'meta', publish: { exclude_fields: ['secrets'] } };
  const result = vaultconfigfields.setList(curSplit, data, ['publish', 'exclude_fields'], ['secrets', 'tactics']);
  const nextSplit = vaultconfigedit.splitFile(result.bytes);
  assert.equal(vaultconfigfields.listTextualGuard(curSplit, nextSplit, 'exclude_fields'), true);
});

test('pathsGuard goes red on a hand-built candidate whose parse touched an untouched key', () => {
  const curData = { type: 'meta', publish: { exclude_fields: ['secrets'], mode: 'player' } };
  const candData = { type: 'meta', publish: { exclude_fields: ['secrets', 'tactics'], mode: 'full' } };
  assert.equal(vaultconfigfields.pathsGuard(curData, candData, [{ segments: ['publish', 'exclude_fields'], value: ['secrets', 'tactics'] }]), false);
});

test('pathsGuard accepts a candidate that only touches the edited path', () => {
  const curData = { type: 'meta', publish: { exclude_fields: ['secrets'], mode: 'player' } };
  const candData = { type: 'meta', publish: { exclude_fields: ['secrets', 'tactics'], mode: 'player' } };
  assert.equal(vaultconfigfields.pathsGuard(curData, candData, [{ segments: ['publish', 'exclude_fields'], value: ['secrets', 'tactics'] }]), true);
});

test('pathsGuard goes red when the edited path does not deep-equal the requested value', () => {
  const curData = { type: 'meta', publish: { exclude_fields: ['secrets'] } };
  const candData = { type: 'meta', publish: { exclude_fields: ['secrets', 'tactics'] } };
  assert.equal(vaultconfigfields.pathsGuard(curData, candData, [{ segments: ['publish', 'exclude_fields'], value: ['secrets', 'wrong'] }]), false);
});

// -- getPath: own properties only --------------------------------------------------------------

test('getPath follows own properties only, and returns undefined for an absent or prototype path', () => {
  assert.equal(vaultconfigfields.getPath({ publish: { mode: 'full' } }, ['publish', 'mode']), 'full');
  assert.equal(vaultconfigfields.getPath({ publish: { mode: 'full' } }, ['publish', 'missing']), undefined);
  assert.equal(vaultconfigfields.getPath({}, ['constructor']), undefined);
});
