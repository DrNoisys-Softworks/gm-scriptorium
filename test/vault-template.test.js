'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const template = require('../src/setup/template');
const { validateStarterTitle } = require('../src/setup/validate');
const { parseFrontmatterText } = require('../src/vault/read');
const { ConfigError, ScriptoriumError } = require('../src/util/errors');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

/*
 * The starter template's loader, verifier and renderer (docs/decisions/0048-new-campaign-vault.md,
 * sections 1 and 3), against the hand-written fixture. Expected texts are written out by hand.
 */

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A scratch copy of the fixture: a test may change it freely. */
function copyFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tpl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const integrity = (rel) => `the new-campaign starter in this executable failed its integrity check: ${rel}; nothing was written`;

function fileOf(files, rel) {
  const f = files.find((x) => x.rel === rel);
  assert.ok(f, `${rel} is in the starter`);
  return f.data.toString('utf8');
}

// --- load and verify ---------------------------------------------------------------------------------

test('the fixture loads, and lists its systems without "none"', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  assert.deepEqual(template.starterSystems(tpl), ['dnd-5e-2024']);
  assert.equal(tpl.manifest.templateVersion, 'fixture-1');
  assert.deepEqual(template.verifyTemplateTree(FIXTURE_DIR).problems, []);
});

test('a second load of the same folder is served from the cache', () => {
  assert.equal(template.loadTemplate({ dir: FIXTURE_DIR }), template.loadTemplate({ dir: FIXTURE_DIR }));
});

test('the build with no starter says so, and a folder with no manifest is the same case', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tpl-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => template.loadTemplate({ dir: empty }), (err) => err instanceof ScriptoriumError && err.message === 'this build has no new-campaign starter');
});

test('a one-byte change to a stored file fails the integrity check, naming the file', (t) => {
  const dir = copyFixture(t);
  const file = path.join(dir, 'common', '_meta', 'entity-types.md');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 2] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.throws(() => template.loadTemplate({ dir }), (err) => err instanceof ScriptoriumError && err.message === integrity('common/_meta/entity-types.md'));
  assert.deepEqual(template.verifyTemplateTree(dir).problems, ['common/_meta/entity-types.md']);
});

test('a listed file that is missing fails the integrity check', (t) => {
  const dir = copyFixture(t);
  fs.rmSync(path.join(dir, 'systems', 'none', '_Templates', 'pc.md'));
  assert.throws(() => template.loadTemplate({ dir }), (err) => err instanceof ScriptoriumError && err.message === integrity('systems/none/_Templates/pc.md'));
});

test('an extra file nobody listed fails the full tree check (and is invisible to the runtime load)', (t) => {
  const dir = copyFixture(t);
  fs.writeFileSync(path.join(dir, 'common', '_meta', 'stray.md'), 'x');
  assert.deepEqual(template.verifyTemplateTree(dir).problems, ['common/_meta/stray.md']);
  assert.doesNotThrow(() => template.loadTemplate({ dir }));
});

test('verifyTemplateTree reports a one-byte change and a missing file together', (t) => {
  const dir = copyFixture(t);
  fs.appendFileSync(path.join(dir, 'common', '_meta', 'index.md'), 'x');
  fs.rmSync(path.join(dir, 'common', '_Templates', 'npc.md'));
  assert.deepEqual(template.verifyTemplateTree(dir).problems, ['common/_Templates/npc.md', 'common/_meta/index.md']);
});

test('a symbolic link inside the template folder fails the full tree check', (t) => {
  const dir = copyFixture(t);
  fs.symlinkSync(path.join(dir, 'manifest.json'), path.join(dir, 'common', 'link.md'));
  assert.deepEqual(template.verifyTemplateTree(dir).problems, ['common/link.md']);
});

test('a token count that disagrees with the file fails, even when the sha is right', (t) => {
  const dir = copyFixture(t);
  const manifest = readManifest(dir);
  manifest.systems.none.files['_Campaign/Timeline.md'].tokens['{{SCRIPTORIUM_CAMPAIGN}}'] = 3;
  writeManifest(dir, manifest);
  assert.throws(() => template.loadTemplate({ dir }), (err) => err instanceof ScriptoriumError && err.message === integrity('common/_Campaign/Timeline.md'));
});

test('a token nobody declared fails, even when the sha is right', (t) => {
  const dir = copyFixture(t);
  const file = path.join(dir, 'common', '_meta', 'NOTICE.txt');
  const bytes = Buffer.from('{{SCRIPTORIUM_OTHER}}\n');
  fs.writeFileSync(file, bytes);
  const manifest = readManifest(dir);
  for (const id of Object.keys(manifest.systems)) manifest.systems[id].files['_meta/NOTICE.txt'].sha256 = sha(bytes);
  writeManifest(dir, manifest);
  assert.throws(() => template.loadTemplate({ dir }), (err) => err instanceof ScriptoriumError && err.message === integrity('common/_meta/NOTICE.txt'));
});

test('a deviation whose "from" text is absent, or appears twice, fails', (t) => {
  const absent = copyFixture(t);
  const m1 = readManifest(absent);
  m1.deviations[0].from = '  site: maybe';
  writeManifest(absent, m1);
  assert.throws(() => template.loadTemplate({ dir: absent }), (err) => err instanceof ScriptoriumError && err.message === integrity('deviations'));

  const twice = copyFixture(t);
  const file = path.join(twice, 'systems', 'none', '_meta', 'vault-config.md');
  const bytes = Buffer.concat([fs.readFileSync(file), Buffer.from('  site: false\n')]);
  fs.writeFileSync(file, bytes);
  const m2 = readManifest(twice);
  m2.systems.none.files['_meta/vault-config.md'].sha256 = sha(bytes);
  writeManifest(twice, m2);
  assert.throws(() => template.loadTemplate({ dir: twice }), (err) => err instanceof ScriptoriumError && err.message === integrity('deviations'));
});

test('a manifest that is not valid, or names an unsafe path, fails', (t) => {
  const bad = copyFixture(t);
  fs.writeFileSync(path.join(bad, 'manifest.json'), '{ not json');
  assert.throws(() => template.loadTemplate({ dir: bad }), (err) => err instanceof ScriptoriumError && err.message === integrity('manifest.json'));

  const unsafe = copyFixture(t);
  const m = readManifest(unsafe);
  m.systems.none.files['../escape.md'] = m.systems.none.files['_meta/index.md'];
  writeManifest(unsafe, m);
  assert.throws(() => template.loadTemplate({ dir: unsafe }), (err) => err instanceof ScriptoriumError && err.message === integrity('../escape.md'));

  const wrongStore = copyFixture(t);
  const m3 = readManifest(wrongStore);
  m3.systems.none.files['_meta/index.md'].store = '../../manifest.json';
  writeManifest(wrongStore, m3);
  assert.throws(() => template.loadTemplate({ dir: wrongStore }), ScriptoriumError);

  const noNone = copyFixture(t);
  const m4 = readManifest(noNone);
  delete m4.systems.none;
  writeManifest(noNone, m4);
  assert.throws(() => template.loadTemplate({ dir: noNone }), (err) => err instanceof ScriptoriumError && err.message === integrity('systems'));
});

// --- rendering ---------------------------------------------------------------------------------------

test('an unknown system is refused with the list of valid ones', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  assert.throws(
    () => template.renderStarter(tpl, { system: 'nonesuch', title: 'T', created: '2026-01-02' }),
    (err) => err instanceof ConfigError && err.message === 'unknown game system "nonesuch"; valid systems: dnd-5e-2024, none',
  );
});

test('rendering fills the declared sites, applies the one deviation, and lists folders parent first', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  const out = template.renderStarter(tpl, { system: 'dnd-5e-2024', title: 'The Brass Lantern', created: '2026-10-08' });
  assert.deepEqual(out.dirs.slice(0, 3), ['Characters', 'Characters/NPCs', 'Characters/PCs']);
  assert.equal(out.dirs.includes('_attachments/characters'), true);
  assert.equal(
    fileOf(out.files, '_meta/vault-config.md'),
    '---\ntype: meta\ngm_apprentice_version: "9.9.9"\npublish:\n  site: true\n  system: "dnd-5e-2024"\n---\n\n# The Brass Lantern: vault settings\n\nThis vault records the game system dnd-5e-2024.\n',
  );
  assert.equal(
    fileOf(out.files, '_Campaign/Timeline.md'),
    '---\ntype: timeline\ntitle: Timeline\ncampaign: "The Brass Lantern"\ncreatedSession: "0"\ntags: [timeline]\n---\n\n# The Brass Lantern: Timeline\n\nAdd one row for each event that changes the story.\n',
  );
  assert.equal(fileOf(out.files, '_meta/index.md'), '---\ntype: meta\npurpose: vault-index\ngenerated: 2026-10-08\n---\n\n# Vault index\n\nGenerated 2026-10-08. Nothing else is indexed in a new vault.\n');
  assert.match(fileOf(out.files, '_Campaign/Welcome.md'), /^---\ntype: campaign_overview\ntitle: "The Brass Lantern"\n/);
  assert.equal(fileOf(out.files, '_meta/publish-manifest.md').includes('- [x] _Campaign/Welcome.md\n'), true);
  assert.equal(out.files.every((f) => Buffer.isBuffer(f.data)), true);
  assert.equal(out.files.every((f) => !f.data.toString('utf8').includes('{{SCRIPTORIUM_')), true);
  // the other system differs only where the manifest says
  const none = template.renderStarter(tpl, { system: 'none', title: 'The Brass Lantern', created: '2026-10-08' });
  assert.equal(fileOf(none.files, '_Templates/pc.md').includes('class'), false);
  assert.equal(fileOf(out.files, '_Templates/pc.md').includes('class: ""'), true);
  assert.equal(fileOf(none.files, '_meta/vault-config.md').includes('system:'), false);
});

test('the same inputs always give the same bytes, and nothing depends on a clock', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  const a = template.renderStarter(tpl, { system: 'none', title: 'Same', created: '2001-02-03' });
  const b = template.renderStarter(tpl, { system: 'none', title: 'Same', created: '2001-02-03' });
  assert.deepEqual(a.files.map((f) => [f.rel, sha(f.data)]), b.files.map((f) => [f.rel, sha(f.data)]));
});

test('substitution is a single pass: a title that looks like a site, or a replacement pattern, comes through as typed', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  for (const title of ['{{SCRIPTORIUM_CREATED}}', '{{SCRIPTORIUM_CAMPAIGN}}', 'cost $& and $1 and $$', "it's"]) {
    const out = template.renderStarter(tpl, { system: 'none', title, created: '2026-10-08' });
    assert.equal(fileOf(out.files, '_Campaign/Timeline.md').includes(`campaign: "${title}"\n`), true, title);
    assert.equal(fileOf(out.files, '_Campaign/Timeline.md').includes(`# ${title}: Timeline\n`), true, title);
    assert.equal(fileOf(out.files, '_meta/index.md').includes('generated: 2026-10-08\n'), true, title);
  }
});

test('the created date must be a plain YYYY-MM-DD', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  for (const bad of ['2026-1-2', '20261002', '2026-10-08T00:00:00Z', '', undefined]) {
    assert.throws(() => template.renderStarter(tpl, { system: 'none', title: 'T', created: bad }), ScriptoriumError, String(bad));
  }
});

// --- the title: normalisation, then what the fixture's sites can hold ---------------------------------

test('title normalisation: the table', () => {
  const ok = [
    ['  The  Brass   Lantern ', 'The Brass Lantern'],
    ['A\u00a0B', 'A B'],
    ['A\u2003\u2003B', 'A B'],
    ['\u3000A\u3000', 'A'],
    ['tab\there', null],
    ['Caf\u00e9  \u00dcber', 'Caf\u00e9 \u00dcber'],
    ['plain', 'plain'],
  ];
  for (const [raw, expected] of ok) {
    if (expected === null) assert.throws(() => validateStarterTitle(raw), ConfigError, JSON.stringify(raw));
    else assert.equal(validateStarterTitle(raw), expected, JSON.stringify(raw));
  }
});

test('title normalisation: characters Python and JavaScript disagree on are refused, not guessed', () => {
  for (const raw of ['A\u0085B', 'A\u009fB', '\ufeffA', 'A\ufeff', 'A\u0080B']) {
    assert.throws(() => validateStarterTitle(raw), ConfigError, JSON.stringify(raw));
  }
});

test('a title with a control character or nothing in it is refused with the existing message', () => {
  for (const raw of ['', '   ', 'A\nB', 'A\u0000B', 'A\u007fB', undefined, 7]) {
    assert.throws(() => validateStarterTitle(raw), (err) => err instanceof ConfigError && err.message === 'site title must be one non-empty line', JSON.stringify(raw));
  }
});

test('a title holding a {WORD} in braces is refused: the upstream scaffold would expand it', () => {
  for (const raw of ['Call {NAME}', '{TREE}', 'x {A_B} y', '{{NAME}}']) {
    assert.throws(() => validateStarterTitle(raw), (err) => err instanceof ConfigError && err.message === 'site title must not hold a word in braces such as {NAME}', raw);
  }
  assert.equal(validateStarterTitle('{lower} {1} { } {}'), '{lower} {1} { } {}');
});

function renderWith(title) {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  return template.renderStarter(tpl, { system: 'dnd-5e-2024', title: validateStarterTitle(title), created: '2026-10-08' });
}

const ROUND_TRIPS = [
  ['a colon', 'Tomb: Part 1'],
  ['three dashes', '---'],
  ['a dash line inside text', 'A --- B'],
  ['a hash', '#1 Tavern'],
  ['a hash in the middle', 'Act #2'],
  ['non-ASCII text', 'Caf\u00e9 \u00dc\u00ef \u4e16\u754c \u{1F409}'],
  ['an apostrophe', "Queen's Gambit"],
  ['a lone number', '2026'],
  ['a boolean word', 'true'],
  ['a null word', 'null'],
  ['an ampersand and percent', 'Gold & 100%'],
  ['a pipe and a bracket', '[a] | b'],
  ['a leading asterisk', '*bold*'],
  ['a leading at sign', '@home'],
  ['a single brace', 'a { b } c'],
  ['a dollar sign', 'costs $5'],
];

for (const [label, title] of ROUND_TRIPS) {
  test(`a title with ${label} reads back exactly as typed, in the quoted value and the heading`, () => {
    const out = renderWith(title);
    const timeline = fileOf(out.files, '_Campaign/Timeline.md');
    const parsed = parseFrontmatterText(timeline);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.campaign, title);
    assert.equal(parsed.content.includes(`# ${title}: Timeline`), true);
    const welcome = parseFrontmatterText(fileOf(out.files, '_Campaign/Welcome.md'));
    assert.equal(welcome.data.title, title);
  });
}

const REFUSED = [
  ['a double quote', 'Say "hi"'],
  ['a lone double quote', '"'],
  ['a backslash', 'back\\slash'],
  ['a drive path', 'D:\\games\\table'],
  ['a trailing backslash', 'ends with\\'],
];

for (const [label, title] of REFUSED) {
  test(`a title with ${label} is refused before anything is written, never escaped`, () => {
    assert.throws(
      () => renderWith(title),
      (err) => err instanceof ConfigError && err.message === "site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes",
    );
  });
}

test('the read-back check also covers every system at once', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  assert.doesNotThrow(() => template.assertTitleReadsBack(tpl, 'Tomb: Part 1'));
  assert.throws(() => template.assertTitleReadsBack(tpl, 'Say "hi"'), ConfigError);
});

// --- dates -------------------------------------------------------------------------------------------

test('localDate uses the local calendar day, not UTC: checked in a time zone 14 hours ahead', () => {
  const code = `
    const { localDate } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'setup', 'template.js'))});
    const d = new Date(2026, 9, 9, 0, 30);
    process.stdout.write(JSON.stringify({ local: localDate(d), utc: d.toISOString().slice(0, 10) }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'Pacific/Kiritimati' }, encoding: 'utf8' }));
  assert.equal(out.utc, '2026-10-08', 'the control: UTC is a day behind in this zone');
  assert.equal(out.local, '2026-10-09');
});

test('localDate pads single digits', () => {
  assert.equal(template.localDate(new Date(2026, 0, 2, 12)), '2026-01-02');
});
