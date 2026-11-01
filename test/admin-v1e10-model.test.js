'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VC } = require(path.join(__dirname, '..', 'assets', 'admin', 'vaultcfg.js'));
const fields = require('../src/admin/vaultconfigfields');

/*
 * V1e-10 (SD-113 to SD-115): the pure VC half of vc2 and vc3, plus structural guards over the
 * browser half's source. Expected values are written out by hand, never derived from VC itself;
 * the one place a value is read from the server module (FIELDS drift) is the drift test's whole point.
 */

function readAsset(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', name), 'utf8');
}

// -- Drift: VC.FIELDS against FIELD_SCHEMA ------------------------------------------------------

test('VC.FIELDS mirrors the server FIELD_SCHEMA exactly: same order, path, kind, group, label and limits', () => {
  assert.equal(VC.FIELDS.length, fields.FIELD_SCHEMA.length);
  VC.FIELDS.forEach((f, i) => {
    const s = fields.FIELD_SCHEMA[i];
    assert.equal(f.path, s.path, `path ${i}`);
    assert.equal(f.kind, s.kind, `kind ${i}`);
    assert.equal(f.group, s.group, `group ${i}`);
    assert.equal(f.label, s.label, `label ${i}`);
    assert.equal(f.min, s.min, `min ${i}`);
    assert.equal(f.max, s.max, `max ${i}`);
  });
});

test('VC.FIELDS is pinned to a literal (a drift test that only compares the two sides would pass if both moved)', () => {
  assert.deepEqual(
    VC.FIELDS.map((f) => f.path),
    [
      'publish.exclude_fields',
      'publish.exclude_sections',
      'publish.exclude_dirs',
      'publish.landing.featured_npcs',
      'publish.landing.quick_links',
      'publish.landing.max_npcs',
      'publish.four_oh_four.message',
    ],
  );
  assert.deepEqual(VC.PRIVACY_PATHS, ['publish.exclude_fields', 'publish.exclude_sections', 'publish.exclude_dirs']);
});

test('the client validators agree with the server validators on the same inputs', () => {
  const cases = [
    ['publish.landing.max_npcs', 0, true],
    ['publish.landing.max_npcs', 100, true],
    ['publish.landing.max_npcs', 101, false],
    ['publish.landing.max_npcs', -1, false],
    ['publish.landing.max_npcs', 2.5, false],
    ['publish.landing.max_npcs', '5', false],
    ['publish.four_oh_four.message', 'ok', true],
    ['publish.four_oh_four.message', '', false],
    ['publish.four_oh_four.message', 'x'.repeat(300), true],
    ['publish.four_oh_four.message', 'x'.repeat(301), false],
    ['publish.four_oh_four.message', 'a\nb', false],
  ];
  for (const [p, v, ok] of cases) {
    const server = fields.validateFieldValue(fields.FIELD_BY_PATH.get(p), v);
    assert.equal(server === null, ok, `server ${p} ${JSON.stringify(v)}`);
    assert.equal(VC.fieldProblem(p, v) === null, ok, `client ${p} ${JSON.stringify(v)}`);
    if (!ok) assert.equal(VC.fieldProblem(p, v), server, 'the same message on both sides');
  }
});

// -- unlockMatches --------------------------------------------------------------------------------

test('unlockMatches: exact equality after trim and lower-casing, never a contains match', () => {
  assert.equal(VC.unlockMatches('lease', 'lease'), true);
  assert.equal(VC.unlockMatches(' LEASE ', 'lease'), true);
  assert.equal(VC.unlockMatches('Lease', 'LEASE'), true);
  assert.equal(VC.unlockMatches('lease2', 'lease'), false);
  assert.equal(VC.unlockMatches('xlease', 'lease'), false);
  assert.equal(VC.unlockMatches('leas', 'lease'), false);
  assert.equal(VC.unlockMatches('constructor', 'lease'), false);
  assert.equal(VC.unlockMatches('', 'lease'), false);
  assert.equal(VC.unlockMatches('lease', ''), false);
  assert.equal(VC.unlockMatches('lease', undefined), false);
  assert.equal(VC.unlockMatches('undefined', undefined), false);
  assert.equal(VC.unlockMatches(undefined, 'lease'), false);
  assert.equal(VC.unlockMatches('le ase', 'lease'), false, 'interior spaces are not trimmed');
});

// -- chipFlags -----------------------------------------------------------------------------------

function fixtureGet(over = {}) {
  return {
    fields: [
      { path: 'publish.exclude_fields', kind: 'list', value: ['secrets', 'secret', 'gm_notes'] },
      { path: 'publish.exclude_sections', kind: 'list', value: ['GM Notes'] },
      { path: 'publish.exclude_dirs', kind: 'list', value: null },
      { path: 'publish.landing.featured_npcs', kind: 'list', value: ['Orpiment'] },
      { path: 'publish.landing.quick_links', kind: 'list', value: null },
      { path: 'publish.landing.max_npcs', kind: 'int', value: 6 },
      { path: 'publish.four_oh_four.message', kind: 'string', value: 'Lost' },
    ],
    usage: { secrets: 2, secret: 0, gm_notes: 0, current_plan: 0 },
    missingDefaults: { exclude_fields: ['current_plan', 'secrets'], exclude_sections: [] },
    ...over,
  };
}

test('chipFlags: a zero-usage exclude_fields entry is bad, with a Did you mean for a plural/singular default', () => {
  const get = fixtureGet({ missingDefaults: { exclude_fields: ['secrets'], exclude_sections: [] } });
  const flags = VC.chipFlags(get, {});
  assert.deepEqual(flags['publish.exclude_fields'], [
    { entry: 'secret', c: 'bad', t: 'No page in your vault has a "secret" field. Did you mean "secrets"?' },
    { entry: 'gm_notes', c: 'bad', t: 'No page in your vault has a "gm_notes" field.' },
  ]);
});

test('chipFlags: usage > 0 and an entry the server did not count are not bad; only new entries are flagged new', () => {
  const get = fixtureGet();
  const flags = VC.chipFlags(get, { 'publish.exclude_fields': ['secrets', 'tactics'], 'publish.landing.featured_npcs': ['Orpiment', 'Hesper'] });
  assert.deepEqual(flags['publish.exclude_fields'], [{ entry: 'tactics', c: 'new', t: 'New' }]);
  assert.deepEqual(flags['publish.landing.featured_npcs'], [{ entry: 'Hesper', c: 'new', t: 'New' }]);
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'publish.exclude_sections'), false);
});

test('chipFlags: a name like constructor or __proto__ in usage is read as own data, never as an inherited property', () => {
  const get = fixtureGet({ usage: {} });
  // `usage` is a plain object: 'constructor' is inherited, not an own key, so it must not read as a count of 0.
  const flags = VC.chipFlags(get, { 'publish.exclude_fields': ['constructor', '__proto__'] });
  assert.deepEqual(
    flags['publish.exclude_fields'].map((f) => [f.entry, f.c]),
    [
      ['constructor', 'new'],
      ['__proto__', 'new'],
    ],
  );
});

// -- fieldRisks / withEdit / counts / rows --------------------------------------------------------

test('fieldRisks counts entries removed from the three privacy lists only', () => {
  const get = fixtureGet();
  assert.equal(VC.fieldRisks(get, {}), 0);
  assert.equal(VC.fieldRisks(get, { 'publish.exclude_fields': ['secrets'] }), 2);
  assert.equal(VC.fieldRisks(get, { 'publish.exclude_fields': ['secrets', 'secret', 'gm_notes', 'new'] }), 0, 'adding is not a risk');
  assert.equal(VC.fieldRisks(get, { 'publish.exclude_sections': [] }), 1);
  assert.equal(VC.fieldRisks(get, { 'publish.landing.featured_npcs': [] }), 0, 'a safe list never counts');
  assert.equal(VC.fieldRisks(get, { 'publish.exclude_fields': [], 'publish.exclude_sections': [] }), 4);
});

test('withEdit drops the path when the value is edited back to the loaded value', () => {
  const get = fixtureGet();
  const a = VC.withEdit(get, {}, 'publish.landing.max_npcs', 9);
  assert.deepEqual(a, { 'publish.landing.max_npcs': 9 });
  const b = VC.withEdit(get, a, 'publish.landing.max_npcs', 6);
  assert.deepEqual(b, {});
  const c = VC.withEdit(get, {}, 'publish.exclude_dirs', []);
  assert.deepEqual(c, {}, 'an absent list and an empty list are the same (nothing pending)');
  const d = VC.withEdit(get, a, 'publish.landing.featured_npcs', ['Orpiment']);
  assert.deepEqual(d, { 'publish.landing.max_npcs': 9 });
  assert.deepEqual(a, { 'publish.landing.max_npcs': 9 }, 'the input object is never mutated');
});

test('fieldChangeCount counts changed settings, not changed entries', () => {
  const get = fixtureGet();
  assert.equal(VC.fieldChangeCount(get, {}), 0);
  assert.equal(VC.fieldChangeCount(get, { 'publish.exclude_fields': ['a'], 'publish.landing.max_npcs': 7 }), 2);
  assert.equal(VC.fieldChangeCount(get, { 'publish.landing.max_npcs': 6 }), 0, 'an edit equal to the loaded value is not a change');
});

test('fieldRows: Setting/Now/After rows in FIELDS order, as text', () => {
  const get = fixtureGet();
  const rows = VC.fieldRows(get, {
    'publish.four_oh_four.message': 'Gone',
    'publish.exclude_fields': ['secrets'],
    'publish.landing.quick_links': ['x', 'y'],
    'publish.landing.max_npcs': 9,
  });
  assert.deepEqual(rows, [
    { where: 'Hidden fields', key: 'publish.exclude_fields', now: 'secrets, secret, gm_notes', after: 'secrets' },
    { where: 'Quick links', key: 'publish.landing.quick_links', now: 'Nothing listed', after: 'x, y' },
    { where: 'How many characters to show', key: 'publish.landing.max_npcs', now: '6', after: '9' },
    { where: 'Not-found message', key: 'publish.four_oh_four.message', now: 'Lost', after: 'Gone' },
  ]);
  assert.deepEqual(VC.fieldRows(get, {}), []);
});

test('viewKind: text for vc1 and vc2, fields for vc3 (anything else is text)', () => {
  assert.equal(VC.viewKind('vc1'), 'text');
  assert.equal(VC.viewKind('vc2'), 'text');
  assert.equal(VC.viewKind('vc3'), 'fields');
  assert.equal(VC.viewKind('constructor'), 'text');
  assert.equal(VC.viewKind(undefined), 'text');
});

test('entryProblem: empty, padded, long, control, duplicate and full lists are refused', () => {
  const list = ['a', 'b'];
  assert.equal(VC.entryProblem('publish.exclude_dirs', list, 'c'), null);
  assert.match(VC.entryProblem('publish.exclude_dirs', list, ''), /^Hidden folders: /);
  assert.match(VC.entryProblem('publish.exclude_dirs', list, ' c'), /^Hidden folders: /);
  assert.match(VC.entryProblem('publish.exclude_dirs', list, 'x'.repeat(201)), /^Hidden folders: /);
  assert.equal(VC.entryProblem('publish.exclude_dirs', list, 'x'.repeat(200)), null);
  assert.match(VC.entryProblem('publish.exclude_dirs', list, 'a\tb'), /^Hidden folders: /);
  assert.equal(VC.entryProblem('publish.exclude_dirs', list, 'a'), '"a" is already listed.');
  assert.match(VC.entryProblem('publish.exclude_dirs', Array.from({ length: 100 }, (_, i) => 'e' + i), 'new'), /^Hidden folders: /);
});

test('displayText: null, strings, arrays and objects as plain text', () => {
  assert.equal(VC.displayText(null), 'Not set');
  assert.equal(VC.displayText(''), 'Not set');
  assert.equal(VC.displayText('horror'), 'horror');
  assert.equal(VC.displayText({ primary: '#112233', accent: '#445566' }), 'primary: #112233, accent: #445566');
  assert.equal(VC.displayText(['a', 'b']), 'a, b');
  assert.equal(VC.displayText({}), 'Not set');
});

// -- Structural: busy contract, session binding, no markup sinks --------------------------------

test('vaultcfg.js: the vc3 Review button re-evaluates its busy state at exactly 3 sites (initial, .then, .catch), in its own literal', () => {
  const src = readAsset('vaultcfg.js');
  const count = (src.match(/fieldsReviewBtn\.disabled = fieldsReviewOwnDisabled \|\| store\.isBusy\(\);/g) || []).length;
  assert.equal(count, 3);
  assert.ok(src.includes('fieldsReviewBtnRefs.forEach'), 'the busy branch of the subscription re-evaluates the vc3 review button too');
});

test('vaultcfg.js: field requests bind to the sha captured at unlock (session.base), never to the loaded fields or the live store value', () => {
  const src = readAsset('vaultcfg.js');
  assert.equal((src.match(/baseSha256: session\.base/g) || []).length, 3, 'the V1e-9 literal count is unchanged: the fields review reuses openReview');
  assert.doesNotMatch(src, /baseSha256: fieldsGet/);
  assert.doesNotMatch(src, /baseSha256: editorField/);
});

test('vaultcfg.js: the fields-review request body is built from session.edits and sent through openReview', () => {
  const src = readAsset('vaultcfg.js');
  assert.match(src, /openReview\('fields', \{ set: session\.edits \}\)/);
  assert.match(src, /api\('\/api\/vault-config\/fields'/);
});

test('vaultcfg.js: no markup-injection sink anywhere in the new code (textContent/createElement only)', () => {
  const src = readAsset('vaultcfg.js');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
});

test('vaultcfg.js: the vc3 drawer is a native dialog with role=alertdialog (not a div overlay)', () => {
  const src = readAsset('vaultcfg.js');
  assert.match(src, /el\('dialog'\)[\s\S]{0,200}vc3-drawer a1-drawer/);
  assert.match(src, /setAttribute\('role', 'alertdialog'\)/);
  assert.match(src, /showModal\(\)/);
});

test('vaultcfg.js: the vc2 unlock gate is VC.unlockMatches at both the button and the Enter key', () => {
  const src = readAsset('vaultcfg.js');
  const uses = (src.match(/VC\.unlockMatches\(/g) || []).length;
  assert.ok(uses >= 2, `expected the gate to be applied at the input handler and at the unlock action, found ${uses}`);
});

test('vaultcfg.js: the VC2_RAIL pane spec is the brief\'s literal', () => {
  const src = readAsset('vaultcfg.js');
  assert.match(src, /label: 'What this changes'/);
  assert.match(src, /className: 'vc2-rail'/);
  assert.match(src, /presentation: \{ wide: 'dock', laptop: null, phone: null \}/);
  assert.match(src, /hiddenPref: 'rail\.hidden'/);
});

test('vaultcfg.js: the layout-switch note is the literal copy, and a layout switch never discards (no stopEditing in the view-change branch)', () => {
  const src = readAsset('vaultcfg.js');
  assert.ok(src.includes("' layout. Switch back to review or discard them.'"));
  assert.ok(src.includes("'Your unsaved edits are in the '"));
  const sub = /store\.subscribe\(function \(next, prev\) \{[\s\S]*?\n    \}\);\n  \}/.exec(src);
  assert.ok(sub, 'found the store subscription');
  const viewBranch = /viewOf\(next\)[\s\S]{0,200}render\(\);/.exec(sub[0]);
  assert.ok(viewBranch, 'found the view-change branch');
  assert.doesNotMatch(viewBranch[0], /stopEditing|session = null/);
});

test('admin.css: the vc2 live effects panel overrides the slip-tuned effect colours for the dark panel chrome', () => {
  const css = readAsset('admin.css');
  assert.match(css, /\.vc2-eff \.vc-eff li p,\s*\n\.vc2-rail \.vc-eff li p \{[^}]*color: var\(--text-muted\);/);
  assert.match(css, /\.vc2-eff \.vc-eff li\.bad \.ico,\s*\n\.vc2-eff \.vc-eff li\.bad b,\s*\n\.vc2-rail \.vc-eff li\.bad \.ico,\s*\n\.vc2-rail \.vc-eff li\.bad b \{[^}]*color: var\(--error\);/);
});

test('vaultcfg.js: the read-only code block is a focusable labelled region (axe scrollable-region-focusable at 390 px, found live in G7)', () => {
  const src = readAsset('vaultcfg.js');
  assert.match(src, /code\.className = 'vc-code';[\s\S]{0,300}code\.setAttribute\('role', 'region'\);[\s\S]{0,100}code\.tabIndex = 0;/);
});

test('admin.css: a non-bad effect in the review slip gets the faint slip wash, not the dark-chrome black one (axe color-contrast, found live in G7)', () => {
  const css = readAsset('admin.css');
  assert.match(css, /\.a1-slip \.vc-eff li:not\(\.bad\) \{[^}]*background: var\(--slip-gap-bg\);/);
});

// -- A vault whose settings live in _meta/vault-config.yaml ------------------------------------

const vaultsettingsplan = require('../src/admin/vaultsettingsplan');
const { ST } = require(path.join(__dirname, '..', 'assets', 'admin', 'store.js'));
const { SL } = require(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'));

const YAML_NAMES = [
  'player_site.hide.fields',
  'player_site.hide.sections',
  'player_site.hide.folders',
  'player_site.landing.featured_npcs',
  'player_site.landing.quick_links',
  'player_site.landing.max_npcs',
  'player_site.not_found',
];

test('VC.FIELDS names each field as vault-config.yaml does, pinned to a literal', () => {
  assert.deepEqual(
    VC.FIELDS.map((f) => f.yamlPath),
    YAML_NAMES,
  );
});

test('VC.FIELDS yamlPath mirrors the server YAML_FIELD_SCHEMA, in order, and keys back to the same old name', () => {
  assert.deepEqual(
    VC.FIELDS.map((f) => f.yamlPath),
    vaultsettingsplan.YAML_FIELD_SCHEMA.map((f) => f.path),
  );
  assert.deepEqual(
    VC.FIELDS.map((f) => f.path),
    vaultsettingsplan.YAML_FIELD_SCHEMA.map((f) => f.key),
  );
});

function yamlGet() {
  return {
    fields: [
      { path: 'player_site.hide.fields', key: 'publish.exclude_fields', kind: 'list', value: ['secrets'] },
      { path: 'player_site.hide.sections', key: 'publish.exclude_sections', kind: 'list', value: null },
      { path: 'player_site.hide.folders', key: 'publish.exclude_dirs', kind: 'list', value: ['_meta', '_Templates'] },
      { path: 'player_site.landing.featured_npcs', key: 'publish.landing.featured_npcs', kind: 'list', value: null },
      { path: 'player_site.landing.quick_links', key: 'publish.landing.quick_links', kind: 'list', value: null },
      { path: 'player_site.landing.max_npcs', key: 'publish.landing.max_npcs', kind: 'int', value: 8 },
      { path: 'player_site.not_found', key: 'publish.four_oh_four.message', kind: 'string', value: 'Cut' },
    ],
    usage: {},
    missingDefaults: { exclude_fields: [], exclude_sections: [] },
  };
}

test('currentValue reads a vault-config.yaml row by its old name (key), the name rows and drafts are keyed by', () => {
  const get = yamlGet();
  assert.deepEqual(VC.currentValue(get, {}, 'publish.exclude_dirs'), ['_meta', '_Templates']);
  assert.equal(VC.currentValue(get, {}, 'publish.landing.max_npcs'), 8);
  assert.deepEqual(VC.currentValue(get, {}, 'publish.exclude_sections'), []);
  assert.equal(VC.fieldChangeCount(get, { 'publish.exclude_dirs': ['_meta', '_Templates', 'Secret'] }), 1);
  assert.equal(VC.fieldChangeCount(get, { 'publish.landing.max_npcs': 8 }), 0);
});

test('fieldRows names the vault-config.yaml setting when asked for the yaml', () => {
  const get = yamlGet();
  const edits = { 'publish.exclude_dirs': ['_meta', '_Templates', 'Secret'], 'publish.landing.max_npcs': 9 };
  assert.deepEqual(VC.fieldRows(get, edits, true), [
    { where: 'Hidden folders', key: 'player_site.hide.folders', now: '_meta, _Templates', after: '_meta, _Templates, Secret' },
    { where: 'How many characters to show', key: 'player_site.landing.max_npcs', now: '8', after: '9' },
  ]);
});

test('codeSpans: backtick spans become code pieces, the rest stays text, an unclosed backtick is text', () => {
  assert.deepEqual(VC.codeSpans('`_meta`, `_Templates`'), [
    { code: true, s: '_meta' },
    { code: false, s: ', ' },
    { code: true, s: '_Templates' },
  ]);
  assert.deepEqual(VC.codeSpans('How many; `0` shows none'), [
    { code: false, s: 'How many; ' },
    { code: true, s: '0' },
    { code: false, s: ' shows none' },
  ]);
  assert.deepEqual(VC.codeSpans('Vault folders never published'), [{ code: false, s: 'Vault folders never published' }]);
  assert.deepEqual(VC.codeSpans('a `b'), [{ code: false, s: 'a `b' }]);
  assert.deepEqual(VC.codeSpans('<b>x</b>'), [{ code: false, s: '<b>x</b>' }]);
});

test('fileMap on vault-config.yaml: lines count from 1, the player_site groups are named, and there is no Notes entry', () => {
  const text = [
    'version: 1',
    'vault:',
    '  campaign: X',
    'player_site:',
    '  title: T',
    '  hide:',
    '    folders: ["_meta"]',
    '  theme:',
    '    tagline: "x"',
    '  landing:',
    '    max_npcs: 8',
    '  not_found: "Gone"',
    '  lists:',
    '    banners: {}',
    '  host: github-pages',
  ].join('\n');
  assert.deepEqual(VC.fileMap(text, true), [
    { label: 'Campaign', hint: 'what it is, the system, the year', line: 2 },
    { label: 'title', hint: 'other player-site settings', line: 5 },
    { label: 'Publishing and privacy', hint: 'player mode and the hidden lists', line: 6 },
    { label: 'Look', hint: 'tagline, colours, fonts, cover art', line: 8 },
    { label: 'Landing page', hint: 'featured characters, quick links, blurbs', line: 10 },
    { label: 'Not-found page', hint: 'the 404 message', line: 12 },
    { label: 'Banners', hint: 'the section banners', line: 13 },
  ]);
});

test('ST.fileShas carries vault-config.yaml from the settings view on a moved vault, and nothing for it otherwise', () => {
  const sha = 'd'.repeat(64);
  const base = { packToml: { exists: true, sha256: 'a'.repeat(64) }, vaultConfigJson: { exists: true, sha256: 'b'.repeat(64) } };
  assert.equal(ST.fileShas({ ...base, settingsLayout: 'new', vaultSettings: { sha256: sha } })['vault-config.yaml'], sha);
  assert.equal(ST.fileShas({ ...base, settingsLayout: 'new', vaultSettings: { sha256: null } })['vault-config.yaml'], null);
  assert.deepEqual(Object.keys(ST.fileShas({ ...base, settingsLayout: 'legacy', vaultSettings: null })), ['pack.toml', 'vault.config.json']);
});

test('ST.applySaveResult accepts vault-config.yaml by exact equality only', () => {
  const sha = 'e'.repeat(64);
  assert.equal(ST.applySaveResult({}, { ok: true, file: 'vault-config.yaml', sha256: sha })['vault-config.yaml'], sha);
  for (const bad of ['_meta/vault-config.yaml', 'vault-config.yml', 'vault-config.yamlx']) {
    assert.deepEqual(ST.applySaveResult({}, { ok: true, file: bad, sha256: sha }), {}, bad);
  }
});

test('SL.buildSlip for the title and tagline of a moved vault: one file, both rows, the backup line', () => {
  const slip = SL.buildSlip({
    kind: 'vault-settings',
    payload: { title: 'The Short Lease', tagline: 'A new line.' },
    state: { vaultSettings: { title: 'The Long Lease', tagline: 'Old line.' } },
    dry: { file: 'vault-config.yaml', before: 'a\n', after: 'b\n', backupDir: '/b/campaign-lease', warnings: [] },
  });
  assert.equal(slip.title, 'Save title and tagline');
  assert.equal(slip.filePath, '_meta/vault-config.yaml');
  assert.equal(slip.saveLabel, 'Back up and save vault-config.yaml');
  assert.deepEqual(
    slip.rows.map((r) => [r.where, r.key, r.now, r.after]),
    [
      ['vault-config.yaml', 'player_site.title', 'The Long Lease', 'The Short Lease'],
      ['vault-config.yaml', 'player_site.theme.tagline', 'Old line.', 'A new line.'],
    ],
  );
  assert.deepEqual(slip.effects.map((e) => e.text), ['vault-config.yaml is backed up first, to /b/campaign-lease.']);

  const titleOnly = SL.buildSlip({
    kind: 'vault-settings',
    payload: { title: 'X' },
    state: { vaultSettings: { title: null, tagline: 'Old line.' } },
    dry: { file: 'vault-config.yaml', before: 'a\n', after: 'b\n', backupDir: '/b', warnings: [], campaignId: { before: 'the-long-lease', after: 'x' } },
  });
  assert.deepEqual(titleOnly.rows.map((r) => [r.key, r.now, r.after]), [['player_site.title', '', 'X']]);
  assert.deepEqual(titleOnly.effects.map((e) => e.id), ['backup', 'campaign-id']);
  assert.match(titleOnly.effects[1].text, /_meta\/vault-config\.yaml/);
});

const { PK } = require(path.join(__dirname, '..', 'assets', 'admin', 'pack.js'));

test('sectionsHint: the old layout keeps its combine line; a moved vault says only its own list is read', () => {
  assert.equal(VC.sectionsHint(false), "These combine with vault.config.json's list: a heading named in either stays hidden.");
  assert.equal(VC.sectionsHint(true), "On this vault the site reads only this list. vault.config.json's list is no longer used.");
});

test('gutterMark: vault-config.yaml numbers its first line 1; vault-config.md numbers its first content line 2; the bad line is marked by that number', () => {
  assert.deepEqual(VC.gutterMark(0, true, null), { n: 1, bad: false });
  assert.deepEqual(VC.gutterMark(2, true, 3), { n: 3, bad: true });
  assert.deepEqual(VC.gutterMark(3, true, 3), { n: 4, bad: false });
  assert.deepEqual(VC.gutterMark(0, false, null), { n: 2, bad: false });
  assert.deepEqual(VC.gutterMark(1, false, 3), { n: 3, bad: true });
  assert.deepEqual(VC.gutterMark(2, false, 3), { n: 4, bad: false });
});

test('movedTitleHint: the hint keys on the same editability as the inputs', () => {
  const vs = { editable: true, titleNote: "Saved in the vault's settings file, _meta/vault-config.yaml.", reason: null };
  assert.deepEqual(PK.movedTitleHint(vs, { writable: true, readOnlyReason: null }), {
    editable: true,
    text: "Saved in the vault's settings file, _meta/vault-config.yaml.",
  });
  assert.deepEqual(PK.movedTitleHint(vs, { writable: false, readOnlyReason: 'This campaign is read-only.' }), {
    editable: false,
    text: 'This campaign is read-only.',
  });
  assert.deepEqual(
    PK.movedTitleHint({ editable: false, titleNote: 'note', reason: 'No machine folder.' }, { writable: true, readOnlyReason: null }),
    { editable: false, text: 'No machine folder.' },
  );
  assert.deepEqual(PK.movedTitleHint({ editable: false, titleNote: 'note', reason: null }, { writable: true, readOnlyReason: null }), {
    editable: false,
    text: 'note',
  });
});
