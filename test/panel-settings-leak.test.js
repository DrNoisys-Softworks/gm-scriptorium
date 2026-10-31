'use strict';

/*
 * End to end, on both settings layouts: a hiding change saved through the admin panel's own HTTP
 * routes reaches the site the CLI builds. Each case saves through the routes a GM's browser uses
 * (the vault-config.md routes on the old layout, the same routes naming vault-config.yaml on the
 * moved one), always a dry run first and then a confirm carrying the reviewed hash, then runs
 * `build` and searches every file under the output, the search index included, for a marker that
 * only the hidden thing holds. Every hiding case has its control: the marker is in the output when
 * the thing is not hidden, so a case cannot pass because the marker never reached the site at all.
 *
 * The moved fixture comes from the pin's own move (test/helpers/moved-vault.js); a case that needs a
 * different setting edits the text the move wrote. Expected values are literals.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { moveVaultCopy, assertMovedLayout, replaceChecked } = require('./helpers/moved-vault');
const { scratchRoot, configPathIn, startPanel, post } = require('./helpers/campaigns-panel');
const vaultconfigedit = require('../src/admin/vaultconfigedit');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

const FIELD_MARKER = 'FIELD-MARKER-7Q';
const SECTION_MARKER = 'SECTION-MARKER-7Q';
const HEADER_MARKER = 'HEADER-MARKER-7Q';
const FOLDER_MARKER = 'FOLDER-MARKER-7Q';

// The sample's own hide lists, the same on both layouts (the move carries them over unchanged).
const SAMPLE_FIELDS = ['secrets', 'current_plan', 'plan_progress', 'gm_notes', 'prep_notes', 'reliability'];
const SAMPLE_SECTIONS = ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'];
const SAMPLE_FOLDERS = ['_meta', '_Templates'];

// Setting names per layout, typed out by hand.
const NAMES = {
  legacy: {
    fields: 'publish.exclude_fields',
    sections: 'publish.exclude_sections',
    folders: 'publish.exclude_dirs',
    overrides: 'publish.overrides',
    mode: 'publish.mode',
  },
  new: {
    fields: 'player_site.hide.fields',
    sections: 'player_site.hide.sections',
    folders: 'player_site.hide.folders',
    overrides: 'player_site.hide.field_exceptions',
    mode: 'player_site.hide.mode',
  },
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function addPage(vault, rel, text) {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
}

/**
 * Adds the marker pages to a copy of the sample, lists each in the publish manifest, and maps the
 * Workshop folder in the pack. Runs before the move, so the moved fixture carries the same map.
 */
function addMarkers(vault) {
  addPage(
    vault,
    'Characters/NPCs/Marker Npc.md',
    `---\ntitle: Marker Npc\ntype: npc\noccupation: ${FIELD_MARKER}\n---\n# Marker Npc\n\nA clerk at the fair.\n\n## Keeper Only\n\n${SECTION_MARKER}\n`,
  );
  addPage(vault, 'Characters/PCs/Marker Pc.md', `---\ntitle: Marker Pc\ntype: pc\nplot_hook: ${HEADER_MARKER}\n---\n# Marker Pc\n\nA warden of the vale.\n`);
  addPage(vault, 'Workshop/Notes.md', `---\ntitle: Notes\ntype: location\n---\n# Notes\n\n${FOLDER_MARKER}\n`);
  addPage(vault, 'Secret/Plot.md', '---\ntitle: Plot\ntype: location\n---\n# Plot\n\nOttoline Pardew is behind it all.\n');
  const man = path.join(vault, '_meta', 'publish-manifest.md');
  fs.writeFileSync(
    man,
    replaceChecked(
      fs.readFileSync(man, 'utf8'),
      '## Publishing\n\n',
      '## Publishing\n\n- [x] Characters/NPCs/Marker Npc.md\n- [x] Characters/PCs/Marker Pc.md\n- [x] Workshop/Notes.md\n- [x] Secret/Plot.md\n',
    ),
  );
  const packFile = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
  const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  pack.folderMap = { Workshop: 'workshop', ...pack.folderMap };
  fs.writeFileSync(packFile, JSON.stringify(pack, null, 2) + '\n');
}

/** A scratch campaign "s" on one layout, with the marker pages, registered in its own config. */
function makeCampaign(t, layout) {
  const root = scratchRoot(t);
  const src = path.join(root, 'src');
  fs.cpSync(SAMPLE, src, { recursive: true });
  addMarkers(src);
  let vault;
  if (layout === 'new') {
    const moveRoot = path.join(root, 'moved');
    fs.mkdirSync(moveRoot);
    vault = moveVaultCopy(src, moveRoot, { inVaultPack: true }).vaultPath;
    assertMovedLayout(vault);
    // The move carried the pack's map, Workshop included, into the yaml.
    assert.match(fs.readFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'utf8'), /^ {4}Workshop: workshop$/m);
  } else {
    vault = src;
    assert.doesNotMatch(fs.readFileSync(path.join(vault, '_meta', 'vault-config.md'), 'utf8'), /folder_map/);
  }
  const out = path.join(root, 'out');
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "s"', '', '[campaigns.s]', `vault = ${JSON.stringify(vault)}`, `output = ${JSON.stringify(out)}`, ''].join('\n'));
  const file = layout === 'new' ? 'vault-config.yaml' : 'vault-config.md';
  return { layout, root, vault, out, configPath, file, settings: path.join(vault, '_meta', file), names: NAMES[layout] };
}

/** What the text route takes for the file as it is on disk: the yaml's whole text, or the md's frontmatter. */
function editorText(fx) {
  const bytes = fs.readFileSync(fx.settings);
  if (fx.layout === 'new') return bytes.toString('utf8').replace(/\n$/, '');
  return vaultconfigedit.splitFile(bytes).frontmatterText;
}

/** The request's `file` key: the yaml routes name it; the md routes are used as an old tab sends them. */
const fileKey = (fx) => (fx.layout === 'new' ? { file: 'vault-config.yaml' } : {});

/**
 * A dry run, then (unless `confirm` is false) a confirm carrying the dry run's reviewedSha256.
 * When the dry run asks for the tick and `saveAnyway` is set, a confirm without it is tried first
 * and must answer 422 needs-ack with the file unchanged.
 */
async function save(h, fx, route, body, { saveAnyway = false } = {}) {
  const before = fs.readFileSync(fx.settings);
  const base = { ...fileKey(fx), ...body, baseSha256: sha(before) };
  const dry = await post(h, route, { ...base, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.needsAck, saveAnyway, JSON.stringify(dry.json.reasons));
  const confirm = { ...base, dryRun: false, reviewedSha256: dry.json.candidateSha256 };
  if (saveAnyway) {
    const refused = await post(h, route, confirm);
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.json.error, 'needs-ack');
    assert.deepEqual(fs.readFileSync(fx.settings), before, 'nothing is written without the tick');
  }
  const res = await post(h, route, { ...confirm, saveAnyway });
  assert.equal(res.status, 200, res.text);
  assert.notDeepEqual(fs.readFileSync(fx.settings), before, 'the save wrote the settings file');
  return { dry, res };
}

const saveFields = (h, fx, set, opts) => save(h, fx, '/api/vault-config/fields', { set }, opts);
const saveText = (h, fx, text, opts) => save(h, fx, '/api/vault-config/text', { frontmatterText: text }, opts);

function runCli(fx, command, extra = []) {
  return spawnSync(process.execPath, [BIN, command, 's', '--config', fx.configPath, ...extra], { encoding: 'utf8' });
}

function build(fx) {
  const r = runCli(fx, 'build');
  assert.equal(r.status, 0, `build exited ${r.status}\n${r.stdout}\n${r.stderr}`);
}

function filesUnder(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  })(dir);
  return out;
}

/** Output files (relative, sorted) whose bytes hold `marker`. */
function filesHolding(fx, marker) {
  const files = filesUnder(fx.out);
  assert.ok(files.length > 20, `the build wrote a site (${files.length} files)`);
  return files
    .filter((f) => fs.readFileSync(f).includes(marker))
    .map((f) => path.relative(fx.out, f).split(path.sep).join('/'))
    .sort();
}

function effectsWith(dry, id) {
  return dry.json.effects.filter((e) => e.id === id);
}

// The three hide lists: hide the thing, build, no marker; take it off again (which needs the tick),
// build, and the marker is back (the control).
const HIDE_CASES = [
  { key: 'fields', entry: 'occupation', list: SAMPLE_FIELDS, marker: FIELD_MARKER, page: 'characters/npcs/marker-npc' },
  { key: 'sections', entry: 'Keeper Only', list: SAMPLE_SECTIONS, marker: SECTION_MARKER, page: 'characters/npcs/marker-npc' },
  { key: 'folders', entry: 'Workshop', list: SAMPLE_FOLDERS, marker: FOLDER_MARKER, page: 'workshop/' },
];

for (const layout of ['legacy', 'new']) {
  for (const c of HIDE_CASES) {
    test(`${layout}: hiding "${c.entry}" through the ${c.key} field keeps ${c.marker} out of every output file, and taking it off puts it back`, async (t) => {
      const fx = makeCampaign(t, layout);
      const name = fx.names[c.key];
      const h = await startPanel(t, { config: fx.configPath }, 's');

      await saveFields(h, fx, { [name]: [...c.list, c.entry] });
      build(fx);
      assert.deepEqual(filesHolding(fx, c.marker), []);

      const { dry } = await saveFields(h, fx, { [name]: c.list }, { saveAnyway: true });
      assert.ok(dry.json.reasons.includes('privacy'), JSON.stringify(dry.json.reasons));
      const removed = effectsWith(dry, 'list-removed');
      assert.deepEqual(
        removed.map((e) => [e.level, e.path]),
        [['bad', name]],
      );
      build(fx);
      const holding = filesHolding(fx, c.marker);
      assert.ok(
        holding.some((f) => f.startsWith(c.page)),
        `control: ${c.marker} is on its page once ${c.entry} is not hidden (found in ${JSON.stringify(holding)})`,
      );
    });
  }

  test(`${layout}: mapping the Secret folder as text needs the tick, names the folder and the leak, and check and build then stop on it`, async (t) => {
    const fx = makeCampaign(t, layout);
    // Control: before the save, Secret is not mapped, so check reports no leak there.
    const before = runCli(fx, 'check', ['--json']);
    assert.notEqual(before.status, 2, before.stdout);
    assert.deepEqual(
      JSON.parse(before.stdout).findings.filter((f) => f.id === 'leak/l4-hidden-name').map((f) => f.path),
      [],
    );

    let text = editorText(fx);
    if (layout === 'new') {
      text = replaceChecked(text, '  folder_map:\n', '  folder_map:\n    Secret: secret\n');
    } else {
      // The md's map replaces the pack's (no per-key merge), so it carries the pack's whole map.
      const pack = JSON.parse(fs.readFileSync(path.join(fx.vault, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
      const map = { ...pack.folderMap, Secret: 'secret' };
      assert.equal(map.Workshop, 'workshop');
      const block = '  folder_map:\n' + Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`).join('');
      text = replaceChecked(text, 'publish:\n', 'publish:\n' + block);
    }
    const h = await startPanel(t, { config: fx.configPath }, 's');
    const { dry } = await saveText(h, fx, text, { saveAnyway: true });
    assert.ok(dry.json.reasons.includes('privacy'), JSON.stringify(dry.json.reasons));
    assert.ok(
      dry.json.effects.some((e) => e.title === 'Publishes the folder Secret as /secret/'),
      JSON.stringify(dry.json.effects.map((e) => e.title)),
    );
    assert.equal(dry.json.check.newFindings.filter((f) => f.id === 'leak/l4-hidden-name' && f.path === 'Secret/Plot.md').length, 1);

    const check = runCli(fx, 'check', ['--json']);
    assert.equal(check.status, 2, check.stderr);
    assert.equal(JSON.parse(check.stdout).findings.filter((f) => f.id === 'leak/l4-hidden-name' && f.path === 'Secret/Plot.md').length, 1);

    const b = runCli(fx, 'build');
    assert.equal(b.status, 2, `${b.stdout}\n${b.stderr}`);
    assert.equal(fs.existsSync(path.join(fx.out, 'secret')), false);

    // Control: the mapping does reach the build. Forced past the check, the staged build holds
    // secret/plot.html, and the output-leak scan is what refuses it, so still nothing is written.
    const forced = runCli(fx, 'build', ['--force-check']);
    assert.equal(forced.status, 2, `${forced.stdout}\n${forced.stderr}`);
    const said = `${forced.stdout}\n${forced.stderr}`;
    assert.match(said, /ERROR leak\/l4-output-name secret\/plot\.html /);
    assert.match(said, /refusing to swap\. Nothing was written\./);
    assert.equal(fs.existsSync(path.join(fx.out, 'secret')), false);
  });

  test(`${layout}: a field exception that shows a hidden field on one page needs the tick`, async (t) => {
    const fx = makeCampaign(t, layout);
    const h = await startPanel(t, { config: fx.configPath }, 's');
    await saveFields(h, fx, { [fx.names.fields]: [...SAMPLE_FIELDS, 'occupation'] });

    const text =
      layout === 'new'
        ? replaceChecked(
            editorText(fx),
            '    callouts: false\n',
            '    callouts: false\n    field_exceptions:\n      "Characters/NPCs/Marker Npc.md":\n        include: [occupation]\n',
          )
        : replaceChecked(
            editorText(fx),
            'publish:\n',
            'publish:\n  overrides:\n    fields:\n      "Characters/NPCs/Marker Npc.md":\n        include: [occupation]\n',
          );
    const before = fs.readFileSync(fx.settings);
    const body = { ...fileKey(fx), frontmatterText: text, baseSha256: sha(before) };
    const dry = await post(h, '/api/vault-config/text', { ...body, dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.needsAck, true);
    assert.ok(dry.json.reasons.includes('privacy'), JSON.stringify(dry.json.reasons));
    assert.deepEqual(
      effectsWith(dry, 'overrides').map((e) => [e.level, e.path]),
      [['bad', fx.names.overrides]],
    );
    const refused = await post(h, '/api/vault-config/text', { ...body, dryRun: false, reviewedSha256: dry.json.candidateSha256 });
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.json.error, 'needs-ack');
    assert.deepEqual(fs.readFileSync(fx.settings), before);

    // Control: with the tick the exception is saved, and the build shows the field on that page.
    const ok = await post(h, '/api/vault-config/text', { ...body, dryRun: false, saveAnyway: true, reviewedSha256: dry.json.candidateSha256 });
    assert.equal(ok.status, 200, ok.text);
    build(fx);
    assert.ok(filesHolding(fx, FIELD_MARKER).some((f) => f.startsWith('characters/npcs/marker-npc')));
  });

  test(`${layout}: publish mode full, saved as text, needs the tick`, async (t) => {
    const fx = makeCampaign(t, layout);
    const h = await startPanel(t, { config: fx.configPath }, 's');
    const from = layout === 'new' ? '    mode: player\n' : '  mode: player\n';
    const text = replaceChecked(editorText(fx), from, from.replace('player', 'full'));
    const before = fs.readFileSync(fx.settings);
    const body = { ...fileKey(fx), frontmatterText: text, baseSha256: sha(before) };
    const dry = await post(h, '/api/vault-config/text', { ...body, dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.needsAck, true);
    assert.ok(dry.json.reasons.includes('privacy'), JSON.stringify(dry.json.reasons));
    assert.deepEqual(
      effectsWith(dry, 'mode').map((e) => [e.level, e.path]),
      [['bad', fx.names.mode]],
    );
    const refused = await post(h, '/api/vault-config/text', { ...body, dryRun: false, reviewedSha256: dry.json.candidateSha256 });
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.json.error, 'needs-ack');
    assert.deepEqual(fs.readFileSync(fx.settings), before);
  });
}

test('new: the header facts show a field on a PC page, and hiding that field takes it off again', async (t) => {
  const fx = makeCampaign(t, 'new');
  const h = await startPanel(t, { config: fx.configPath }, 's');

  // With the default header facts the PC's header does not name plot_hook, so the marker is not on
  // the site: what puts it there below is the header facts setting.
  build(fx);
  assert.deepEqual(filesHolding(fx, HEADER_MARKER), []);

  // Control: plot_hook not hidden and named in the header facts, so the PC's header shows it.
  const text = replaceChecked(editorText(fx), '  landing:\n', '  sheets:\n    header_facts: [plot_hook]\n  landing:\n');
  await saveText(h, fx, text);
  build(fx);
  const shown = filesHolding(fx, HEADER_MARKER);
  assert.ok(shown.length > 0, 'control: the header facts put the marker on the site');

  await saveFields(h, fx, { 'player_site.hide.fields': [...SAMPLE_FIELDS, 'plot_hook'] });
  build(fx);
  assert.deepEqual(filesHolding(fx, HEADER_MARKER), []);
});

test('new: the panel never saves a build command, and the yaml is unchanged', async (t) => {
  const fx = makeCampaign(t, 'new');
  const h = await startPanel(t, { config: fx.configPath }, 's');
  const before = fs.readFileSync(fx.settings);
  const cur = editorText(fx);
  const cases = [
    ['player_site.before_build', replaceChecked(cur, 'player_site:\n', 'player_site:\n  before_build: ["echo hi"]\n')],
    ['player_site.after_build', replaceChecked(cur, 'player_site:\n', 'player_site:\n  after_build: ["echo hi"]\n')],
    ['gm_site.before_build', `${cur}\ngm_site:\n  before_build: ["echo hi"]`],
    ['gm_site.after_build', `${cur}\ngm_site:\n  after_build: ["echo hi"]`],
  ];
  for (const [name, text] of cases) {
    for (const extra of [{ dryRun: true }, { dryRun: false, saveAnyway: true, reviewedSha256: 'a'.repeat(64) }]) {
      const res = await post(h, '/api/vault-config/text', { file: 'vault-config.yaml', frontmatterText: text, baseSha256: sha(before), ...extra });
      assert.equal(res.status, 422, `${name}: ${res.text}`);
      assert.deepEqual(res.json, {
        error: 'unsupported',
        message: `The panel never changes ${name}. They run commands on your computer when gm-apprentice publishes. Change them in _meta/vault-config.yaml yourself.`,
      });
    }
  }
  assert.deepEqual(fs.readFileSync(fx.settings), before);
});
