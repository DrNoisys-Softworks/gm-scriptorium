'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { moveVaultCopy, replaceChecked } = require('./helpers/moved-vault');
const { scratchRoot, configPathIn, startPanel, get, post } = require('./helpers/campaigns-panel');
const pinned = require('../src/generator/pinned');
const backups = require('../src/config/backups');
const candidatecheck = require('../src/admin/candidatecheck');
const read = require('../src/vault/read');
const vaultsettingswrite = require('../src/vault/vaultsettingswrite');
const { VaultReadError } = require('../src/util/errors');

/*
 * The settings editor on a vault whose settings live in _meta/vault-config.yaml: the text view, the
 * seven fields, restore, the live effects view and the backups list, with the same review, backups
 * and conflict checks the vault-config.md editor has. Every request names the file it was built
 * against, and a request built against the other file is refused as changed. Each moved case starts
 * from a copy of the sample that the pin's own move ran on with the pack folded in; a case that
 * needs a different yaml edits the moved file's text. Expected values are literals.
 */

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

const MOVED_SINCE_LOADED =
  "This vault's settings moved to _meta/vault-config.yaml after the page loaded. Nothing was saved. Reload to edit them there.";
const BACK_SINCE_LOADED =
  "This vault's settings are in _meta/vault-config.md again since the page loaded. Nothing was saved. Reload to edit them there.";
const MOVED_DURING_SAVE =
  "This vault's settings moved to _meta/vault-config.yaml while saving. vault-config.md was left unchanged. Reload to edit them there.";
const YAML_CHANGED = 'vault-config.yaml changed outside the panel. Reload before saving.';
const NOT_LISTED = 'That backup is not in the list. Reload the backups.';
const TOO_LARGE_REASON = 'vault-config.yaml is too large to send back from the browser in one save (the limit is 64 KiB). Edit it by hand.';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A moved copy of the sample with the pack folded in, registered as campaign "lease". */
function movedCampaign(t) {
  const root = scratchRoot(t);
  const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vaultPath)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'),
  );
  return {
    root,
    vaultPath,
    configPath,
    yaml: path.join(vaultPath, '_meta', 'vault-config.yaml'),
    md: path.join(vaultPath, '_meta', 'vault-config.md'),
    backupDir: path.join(path.dirname(configPath), 'backups', 'campaign-lease'),
  };
}

/** An old-layout copy of the sample with its pack, registered as campaign "lease". */
function legacyCampaign(t) {
  const root = scratchRoot(t);
  const vaultPath = path.join(root, 'vault');
  fs.cpSync(SAMPLE, vaultPath, { recursive: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vaultPath)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'),
  );
  return {
    root,
    vaultPath,
    configPath,
    yaml: path.join(vaultPath, '_meta', 'vault-config.yaml'),
    md: path.join(vaultPath, '_meta', 'vault-config.md'),
    backupDir: path.join(path.dirname(configPath), 'backups', 'campaign-lease'),
  };
}

const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

/** The editor text of a file: its lines without their endings, no final newline. */
const editorTextOf = (file) => fs.readFileSync(file, 'utf8').replace(/\n$/, '');

function bakFilesUnder(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.bak')) out.push(p);
    }
  })(dir);
  return out;
}

function valueAt(data, name) {
  let cur = data;
  for (const seg of name.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const YAML_FILE = 'vault-config.yaml';

async function textDry(h, fx, text, extra = {}) {
  return post(h, '/api/vault-config/text', { file: YAML_FILE, frontmatterText: text, baseSha256: sha(fs.readFileSync(fx.yaml)), dryRun: true, ...extra });
}

async function textSave(h, fx, text, { saveAnyway = false } = {}) {
  const dry = await textDry(h, fx, text);
  assert.equal(dry.status, 200, dry.text);
  const res = await post(h, '/api/vault-config/text', {
    file: YAML_FILE,
    frontmatterText: text,
    baseSha256: sha(fs.readFileSync(fx.yaml)),
    dryRun: false,
    saveAnyway,
    reviewedSha256: dry.json.candidateSha256,
  });
  assert.equal(res.status, 200, res.text);
  return { dry, res };
}

// === GET /api/state?include=vaultconfigeditor ===================================================

test('the editor view on a moved vault names the yaml, can edit it, and holds its whole text', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const view = (await get(h, '/api/state?include=vaultconfigeditor')).json.vaultConfigEditor;
  assert.equal(view.file, 'vault-config.yaml');
  assert.equal(view.canEdit, true);
  assert.equal(view.reason, null);
  assert.equal(view.exists, true);
  assert.equal(view.text, editorTextOf(fx.yaml));
  assert.equal(view.sha256, sha(fs.readFileSync(fx.yaml)));
  assert.equal(view.eol, 'lf');
  assert.deepEqual(view.parse, { ok: true });
  assert.equal(view.backupDir, fx.backupDir);
  assert.equal(view.keep, 20);
});

test('a yaml too large to send back in one save cannot be edited, and an oversized save is refused with 413', async (t) => {
  const fx = movedCampaign(t);
  // Each backslash is one byte in the file and two in a JSON request.
  fs.appendFileSync(fx.yaml, `# ${'\\'.repeat(40000)}\n`);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const view = (await get(h, '/api/state?include=vaultconfigeditor')).json.vaultConfigEditor;
  assert.equal(view.canEdit, false);
  assert.equal(view.reason, TOO_LARGE_REASON);
  const before = fs.readFileSync(fx.yaml);
  const res = await textDry(h, fx, view.text);
  assert.equal(res.status, 413);
  assert.equal(res.text, 'refused: too large');
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
});

// === text saves =================================================================================

test('a text save: the dry run shows one effect, the confirm writes the yaml, and the old bytes are backed up beside the config', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const text = replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n');

  const dry = await textDry(h, fx, text);
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.file, 'vault-config.yaml');
  assert.equal(dry.json.needsAck, false, JSON.stringify(dry.json.reasons));
  assert.deepEqual(
    dry.json.effects.map((e) => e.path),
    ['player_site.landing.max_npcs'],
  );
  assert.equal(dry.json.before, editorTextOf(fx.yaml));
  assert.equal(dry.json.after, text);
  assert.deepEqual(dry.json.notes, []);
  assert.deepEqual(fs.readFileSync(fx.yaml), before, 'a dry run writes nothing');

  const res = await post(h, '/api/vault-config/text', { file: YAML_FILE, frontmatterText: text, baseSha256: sha(before), dryRun: false, reviewedSha256: dry.json.candidateSha256 });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.file, 'vault-config.yaml');
  assert.equal(fs.readFileSync(fx.yaml, 'utf8'), `${text}\n`);
  assert.equal(res.json.sha256, sha(fs.readFileSync(fx.yaml)));

  const names = backupsIn(fx.backupDir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.yaml\.bak$/);
  assert.deepEqual(fs.readFileSync(path.join(fx.backupDir, names[0])), before);
  assert.deepEqual(bakFilesUnder(fx.vaultPath), [], 'no backup inside the vault');
  assert.equal(h.ctx.panelSaves, 1);
});

test('text that is not readable settings answers 400 invalid, never 500, and nothing is written', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const cases = [
    ['player_site: [', /^Line \d+: _meta\/vault-config\.yaml is not valid YAML/],
    ['- a\n- b', /^_meta\/vault-config\.yaml must hold settings written as name: value$/],
    ['version: 2', /^this vault's settings were written by a newer gm-apprentice; update the plugin$/],
  ];
  for (const [text, message] of cases) {
    for (const dryRun of [true, false]) {
      const res = await post(h, '/api/vault-config/text', {
        file: YAML_FILE,
        frontmatterText: text,
        baseSha256: sha(before),
        dryRun,
        saveAnyway: true,
        reviewedSha256: 'a'.repeat(64),
      });
      assert.equal(res.status, 400, `${JSON.stringify(text)}: ${res.text}`);
      assert.equal(res.json.error, 'invalid');
      assert.match(res.json.message, message);
    }
  }
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

test('a text save that changes a build command is refused with 422, even with Save anyway', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const cur = editorTextOf(fx.yaml);
  const cases = [
    [
      replaceChecked(cur, 'player_site:\n', 'player_site:\n  before_build: ["echo hi"]\n'),
      'The panel never changes player_site.before_build. They run commands on your computer when gm-apprentice publishes. Change them in _meta/vault-config.yaml yourself.',
    ],
    [
      `${cur}\ngm_site:\n  after_build: ["echo hi"]`,
      'The panel never changes gm_site.after_build. They run commands on your computer when gm-apprentice publishes. Change them in _meta/vault-config.yaml yourself.',
    ],
  ];
  for (const [text, message] of cases) {
    for (const extra of [{ dryRun: true }, { dryRun: false, saveAnyway: true, reviewedSha256: 'a'.repeat(64) }]) {
      const res = await post(h, '/api/vault-config/text', { file: YAML_FILE, frontmatterText: text, baseSha256: sha(before), ...extra });
      assert.equal(res.status, 422, res.text);
      assert.deepEqual(res.json, { error: 'unsupported', message });
    }
  }
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

// === field saves ================================================================================

test('each of the seven fields saves through a dry run and a confirm; the three privacy removals need Save anyway', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const cases = [
    ['player_site.hide.fields', ['secrets', 'current_plan', 'plan_progress', 'prep_notes', 'reliability'], true],
    ['player_site.hide.sections', ['DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'], true],
    ['player_site.hide.folders', ['_meta'], true],
    ['player_site.landing.featured_npcs', ['Orpiment', 'Queen Hesper', 'Brannoc'], false],
    ['player_site.landing.quick_links', ['The Long Lease', 'The Lease of Quillet'], false],
    ['player_site.landing.max_npcs', 5, false],
    ['player_site.not_found', 'Gone.', false],
  ];
  for (const [name, value, privacy] of cases) {
    const base = sha(fs.readFileSync(fx.yaml));
    const set = { [name]: value };
    const dry = await post(h, '/api/vault-config/fields', { file: YAML_FILE, set, baseSha256: base, dryRun: true });
    assert.equal(dry.status, 200, `${name}: ${dry.text}`);
    assert.equal(dry.json.needsAck, privacy, `${name}: ${JSON.stringify(dry.json.reasons)}`);
    const confirm = { file: YAML_FILE, set, baseSha256: base, dryRun: false, reviewedSha256: dry.json.candidateSha256 };
    if (privacy) {
      assert.ok(dry.json.reasons.includes('privacy'), name);
      const refused = await post(h, '/api/vault-config/fields', confirm);
      assert.equal(refused.status, 422, `${name}: ${refused.text}`);
      assert.equal(refused.json.error, 'needs-ack');
      assert.ok(refused.json.reasons.includes('privacy'), name);
      assert.equal(sha(fs.readFileSync(fx.yaml)), base, `${name}: nothing written without the tick`);
    }
    const res = await post(h, '/api/vault-config/fields', { ...confirm, saveAnyway: privacy });
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    const parsed = pinned.parseSettingsText(fx.vaultPath, fs.readFileSync(fx.yaml));
    assert.equal(parsed.ok, true);
    assert.deepEqual(valueAt(parsed.data, name), value, name);
  }
  assert.equal(backupsIn(fx.backupDir).length, 7);
});

test('a fields save naming an old setting name, or a bad value, answers 400 before anything runs', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const base = sha(fs.readFileSync(fx.yaml));
  const cases = [
    [{ 'publish.landing.max_npcs': 3 }, 'unknown setting: publish.landing.max_npcs'],
    [{ 'player_site.landing.max_npcs': 101 }, 'How many characters to show: must be a whole number from 0 to 100.'],
  ];
  for (const [set, message] of cases) {
    const res = await post(h, '/api/vault-config/fields', { file: YAML_FILE, set, baseSha256: base, dryRun: true });
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(res.json, { error: 'invalid', message });
  }
});

test('a new order for a list with comments inside answers 422 unsupported, and the file is unchanged', async (t) => {
  const fx = movedCampaign(t);
  fs.writeFileSync(
    fx.yaml,
    replaceChecked(
      fs.readFileSync(fx.yaml, 'utf8'),
      '    featured_npcs: ["Orpiment", "Queen Hesper"]\n',
      '    featured_npcs:\n      - Orpiment\n      # the queen after the dragon\n      - Queen Hesper\n',
    ),
  );
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const res = await post(h, '/api/vault-config/fields', {
    file: YAML_FILE,
    set: { 'player_site.landing.featured_npcs': ['Queen Hesper', 'Orpiment'] },
    baseSha256: sha(before),
    dryRun: true,
  });
  assert.equal(res.status, 422, res.text);
  assert.deepEqual(res.json, {
    error: 'unsupported',
    message: 'Featured characters: this list has comments inside it, and a new order would drop them. Use "Edit as text instead".',
  });
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
});

test('a fields save on a yaml made unreadable after the page loaded answers 400 invalid', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  fs.writeFileSync(fx.yaml, 'player_site: [\n');
  const before = fs.readFileSync(fx.yaml);
  const res = await post(h, '/api/vault-config/fields', { file: YAML_FILE, set: { 'player_site.landing.max_npcs': 3 }, baseSha256: sha(before), dryRun: true });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error, 'invalid');
  assert.match(res.json.message, /^Line \d+: _meta\/vault-config\.yaml is not valid YAML/);
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
});

// === GET /api/vault-config/fields ===============================================================

test('the fields view names the seven settings by their new names, with what each does', async (t) => {
  const fx = movedCampaign(t);
  fs.writeFileSync(fx.yaml, replaceChecked(fs.readFileSync(fx.yaml, 'utf8'), '    mode: player\n', ''));
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await get(h, '/api/vault-config/fields');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.sha256, sha(fs.readFileSync(fx.yaml)));
  assert.deepEqual(
    res.json.fields.map((f) => [f.path, f.key]),
    [
      ['player_site.hide.fields', 'publish.exclude_fields'],
      ['player_site.hide.sections', 'publish.exclude_sections'],
      ['player_site.hide.folders', 'publish.exclude_dirs'],
      ['player_site.landing.featured_npcs', 'publish.landing.featured_npcs'],
      ['player_site.landing.quick_links', 'publish.landing.quick_links'],
      ['player_site.landing.max_npcs', 'publish.landing.max_npcs'],
      ['player_site.not_found', 'publish.four_oh_four.message'],
    ],
  );
  const folders = res.json.fields.find((f) => f.path === 'player_site.hide.folders');
  assert.deepEqual(folders, {
    path: 'player_site.hide.folders',
    key: 'publish.exclude_dirs',
    kind: 'list',
    group: 'privacy',
    label: 'Hidden folders',
    value: ['_meta', '_Templates'],
    shape: 'list',
    form: null,
    does: 'Vault folders never published',
    leftOut: '`_meta`, `_Templates`',
  });
  const maxNpcs = res.json.fields.find((f) => f.path === 'player_site.landing.max_npcs');
  assert.equal(maxNpcs.value, 8);
  assert.equal(maxNpcs.shape, 'scalar');
  assert.deepEqual(
    res.json.display.map((d) => d.path),
    ['player_site.theme.palette', 'player_site.theme.fonts', 'player_site.theme.campaign_image', 'player_site.theme.genre', 'player_site.lists.banners'],
  );
  const image = res.json.display.find((d) => d.path === 'player_site.theme.campaign_image');
  assert.deepEqual(image, { path: 'player_site.theme.campaign_image', key: 'publish.theme.campaign_image', group: 'look', label: 'Cover art', value: '_attachments/campaign/long-lease-banner.svg' });
  assert.deepEqual(res.json.unknown, ['version', 'vault', 'player_site.title', 'player_site.host', 'player_site.folder_map', 'player_site.features']);
  assert.deepEqual(res.json.missingDefaults, { exclude_fields: [], exclude_sections: [] });
  assert.equal(typeof res.json.usage.secrets, 'number');
});

test('the fields view shows the publish mode only when the yaml sets it', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await get(h, '/api/vault-config/fields');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.display[0], { path: 'player_site.hide.mode', key: 'publish.mode', group: 'privacy', label: 'Publish mode', value: 'player' });
});

// === POST /api/vault-config/effects =============================================================

test('the live effects view reads the yaml text, and Put it back adds an entry by its new name', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const base = sha(fs.readFileSync(fx.yaml));
  const text = replaceChecked(editorTextOf(fx.yaml), '"plan_progress", "gm_notes", ', '"plan_progress", ');
  const res = await post(h, '/api/vault-config/effects', { file: YAML_FILE, frontmatterText: text, baseSha256: base });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.parse, { ok: true });
  assert.equal(res.json.needsAck, true);
  assert.ok(res.json.effects.some((e) => e.path === 'player_site.hide.fields' && e.level === 'bad'), JSON.stringify(res.json.effects));

  const back = await post(h, '/api/vault-config/effects', { file: YAML_FILE, frontmatterText: text, baseSha256: base, putBack: { path: 'player_site.hide.fields', entry: 'gm_notes' } });
  assert.equal(back.status, 200, back.text);
  const restored = pinned.parseSettingsText(fx.vaultPath, Buffer.from(`${back.json.frontmatterText}\n`));
  assert.ok(restored.data.player_site.hide.fields.includes('gm_notes'));
  assert.equal(back.json.needsAck, false);

  const bad = await post(h, '/api/vault-config/effects', { file: YAML_FILE, frontmatterText: text, baseSha256: base, putBack: { path: 'publish.exclude_fields', entry: 'gm_notes' } });
  assert.equal(bad.status, 400, bad.text);

  const broken = await post(h, '/api/vault-config/effects', { file: YAML_FILE, frontmatterText: 'player_site: [', baseSha256: base });
  assert.equal(broken.status, 200, broken.text);
  assert.equal(broken.json.parse.ok, false);
});

// === restore and the backups list ===============================================================

test('restore: after two saves the yaml backups list two items, and restoring the older one is reviewed and written', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const original = fs.readFileSync(fx.yaml);
  await textSave(h, fx, replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n'));
  await textSave(h, fx, replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 3\n', '    max_npcs: 4\n'));
  // A vault-config.md copy in the same folder belongs to the other list.
  fs.writeFileSync(path.join(fx.backupDir, 'vault-config-20260101T000000000Z-abcdef.md.bak'), '---\ntype: meta\n---\n');

  const list = await get(h, '/api/vault-config/backups');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.available, true);
  assert.equal(list.json.items.length, 2);
  assert.ok(list.json.items.every((i) => i.id.endsWith('.yaml.bak') && i.restorable));
  assert.deepEqual(
    list.json.items.map((i) => i.before),
    ['before a change to landing page words', 'before a change to landing page words'],
  );
  const older = list.json.items[1];
  assert.deepEqual(fs.readFileSync(path.join(fx.backupDir, older.id)), original);

  const base = sha(fs.readFileSync(fx.yaml));
  const dry = await post(h, '/api/vault-config/restore', { file: YAML_FILE, backupId: older.id, baseSha256: base, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.op, 'restore');
  assert.equal(dry.json.backup.id, older.id);
  assert.deepEqual(dry.json.effects.map((e) => e.path), ['player_site.landing.max_npcs']);
  const res = await post(h, '/api/vault-config/restore', { file: YAML_FILE, backupId: older.id, baseSha256: base, dryRun: false, reviewedSha256: dry.json.candidateSha256 });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(fs.readFileSync(fx.yaml), original);
});

test('restore on the yaml refuses a vault-config.md copy, even one listed in the same folder', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  await textSave(h, fx, replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n'));
  const mdId = 'vault-config-20260101T000000000Z-abcdef.md.bak';
  fs.writeFileSync(path.join(fx.backupDir, mdId), 'version: 1\n');
  // vault-config.md's own list holds it, so the id is a real, listed backup.
  const machineDir = path.dirname(path.dirname(fx.backupDir));
  assert.deepEqual(
    backups.listBackups({ machineDir, campaign: 'lease', vaultPath: fx.vaultPath }).items.map((i) => i.id),
    [mdId],
  );
  const before = fs.readFileSync(fx.yaml);
  const res = await post(h, '/api/vault-config/restore', { file: YAML_FILE, backupId: mdId, baseSha256: sha(before), dryRun: true });
  assert.equal(res.status, 400, res.text);
  assert.deepEqual(res.json, { error: 'invalid', message: NOT_LISTED });
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
});

// === a request built against the other file ======================================================

test('a save with no file on a moved vault answers 409 changed: the page was built against vault-config.md', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  for (const [route, extra] of [
    ['/api/vault-config/text', { frontmatterText: editorTextOf(fx.yaml) }],
    ['/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 3 } }],
    ['/api/vault-config/restore', { backupId: 'x' }],
  ]) {
    const res = await post(h, route, { ...extra, baseSha256: sha(before), dryRun: true });
    assert.equal(res.status, 409, `${route}: ${res.text}`);
    assert.deepEqual(res.json, { error: 'changed', message: MOVED_SINCE_LOADED }, route);
  }
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
});

test('a file key naming neither settings file answers 400', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await post(h, '/api/vault-config/text', { file: '../vault-config.yaml', frontmatterText: 'x: 1', baseSha256: 'a'.repeat(64), dryRun: true });
  assert.equal(res.status, 400, res.text);
  assert.deepEqual(res.json, { error: 'invalid', message: 'file must be "vault-config.md" or "vault-config.yaml"' });
});

test('a save naming the yaml on an old-layout vault answers 409 changed, and vault-config.md is unchanged', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.md);
  const res = await post(h, '/api/vault-config/text', { file: YAML_FILE, frontmatterText: 'x: 1', baseSha256: sha(before), dryRun: true });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: BACK_SINCE_LOADED });
  assert.deepEqual(fs.readFileSync(fx.md), before);
});

test('a yaml dry run, then the vault moved back before the confirm: 409, and vault-config.md is byte-identical', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const base = sha(fs.readFileSync(fx.yaml));
  const text = replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n');
  const dry = await textDry(h, fx, text);
  assert.equal(dry.status, 200, dry.text);
  fs.renameSync(fx.yaml, fx.md);
  const mdBefore = fs.readFileSync(fx.md);
  const res = await post(h, '/api/vault-config/text', { file: YAML_FILE, frontmatterText: text, baseSha256: base, dryRun: false, reviewedSha256: dry.json.candidateSha256 });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: BACK_SINCE_LOADED });
  assert.deepEqual(fs.readFileSync(fx.md), mdBefore);
  assert.equal(fs.existsSync(fx.yaml), false);
});

test('a move that lands while a vault-config.md save waits for the lock answers 409 changed, not 422', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const view = (await get(h, '/api/state?include=vaultconfigeditor')).json.vaultConfigEditor;
  const text = replaceChecked(view.text, 'max_npcs: 8', 'max_npcs: 3');
  const real = pinned.settingsLayoutOf;
  let looks = 0;
  // The first look (before the lock) sees vault-config.md; gm-apprentice moves the settings right after it.
  pinned.settingsLayoutOf = (vaultPath) => {
    const layout = real(vaultPath);
    looks += 1;
    if (looks === 1) fs.renameSync(fx.md, fx.yaml);
    return layout;
  };
  let res;
  try {
    res = await post(h, '/api/vault-config/text', { file: 'vault-config.md', frontmatterText: text, baseSha256: view.sha256, dryRun: true });
  } finally {
    pinned.settingsLayoutOf = real;
  }
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: MOVED_SINCE_LOADED });
  assert.equal(looks, 2);
});

test('the vault-config.md writer\'s last look: a yaml that appears during the backup answers 409, and vault-config.md is unchanged', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const view = (await get(h, '/api/state?include=vaultconfigeditor')).json.vaultConfigEditor;
  const text = replaceChecked(view.text, 'max_npcs: 8', 'max_npcs: 3');
  const base = view.sha256;
  const dry = await post(h, '/api/vault-config/text', { frontmatterText: text, baseSha256: base, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  const mdBefore = fs.readFileSync(fx.md);
  const real = backups.backupThenPrune;
  backups.backupThenPrune = (opts) => {
    fs.writeFileSync(fx.yaml, 'version: 1\n');
    return real(opts);
  };
  let res;
  try {
    res = await post(h, '/api/vault-config/text', { file: 'vault-config.md', frontmatterText: text, baseSha256: base, dryRun: false, saveAnyway: true, reviewedSha256: dry.json.candidateSha256 });
  } finally {
    backups.backupThenPrune = real;
  }
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: MOVED_DURING_SAVE });
  assert.deepEqual(fs.readFileSync(fx.md), mdBefore);
});

// === the review cache names its file ===========================================================

test('a vault-config.md dry run, then a move: a confirm with the same reviewedSha256 answers 409', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const view = (await get(h, '/api/state?include=vaultconfigeditor')).json.vaultConfigEditor;
  const text = replaceChecked(view.text, 'max_npcs: 8', 'max_npcs: 3');
  const dry = await post(h, '/api/vault-config/text', { frontmatterText: text, baseSha256: view.sha256, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  // gm-apprentice moves the vault: its settings are now in the yaml the move writes.
  const other = moveVaultCopy(SAMPLE, scratchRoot(t), { inVaultPack: true }).vaultPath;
  fs.copyFileSync(path.join(other, '_meta', 'vault-config.yaml'), fx.yaml);
  fs.rmSync(fx.md);
  const yamlBefore = fs.readFileSync(fx.yaml);
  const res = await post(h, '/api/vault-config/text', {
    file: YAML_FILE,
    frontmatterText: replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n'),
    baseSha256: sha(yamlBefore),
    dryRun: false,
    saveAnyway: true,
    reviewedSha256: dry.json.candidateSha256,
  });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, 'changed');
  assert.deepEqual(fs.readFileSync(fx.yaml), yamlBefore);
});

test('a confirm never reuses a review cached for vault-config.md, even one keyed to the same bytes', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const base = sha(fs.readFileSync(fx.yaml));
  const text = replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n');
  const dry = await textDry(h, fx, text);
  assert.equal(dry.status, 200, dry.text);
  // The cached review as a vault-config.md review keyed to these same bytes would leave it.
  assert.equal(h.ctx.vaultConfigReview.file, 'vault-config.yaml');
  h.ctx.vaultConfigReview.file = 'vault-config.md';

  const real = candidatecheck.runReview;
  const calls = [];
  candidatecheck.runReview = (ctx, opts) => {
    calls.push(opts.withCheck);
    return real(ctx, opts);
  };
  let res;
  try {
    res = await post(h, '/api/vault-config/text', { file: YAML_FILE, frontmatterText: text, baseSha256: base, dryRun: false, reviewedSha256: dry.json.candidateSha256 });
  } finally {
    candidatecheck.runReview = real;
  }
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(calls, [true], 'the confirm ran its own check');
});

// The review reads the yaml right after checking where it is. A file that vanishes between the two
// is a change made outside the panel (409), and any other read failure is an I/O answer (503),
// never a 500. Both are injected through the module objects the handler calls.
test('a yaml that vanishes between the target check and the review read answers 409 changed', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const text = replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n');
  const realCheck = vaultsettingswrite.checkTarget;
  let removed = 0;
  vaultsettingswrite.checkTarget = (...args) => {
    const out = realCheck(...args);
    fs.rmSync(fx.yaml);
    removed += 1;
    return out;
  };
  let res;
  try {
    res = await textDry(h, fx, text);
  } finally {
    vaultsettingswrite.checkTarget = realCheck;
  }
  assert.equal(removed, 1);
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: YAML_CHANGED });
  assert.equal(fs.existsSync(fx.yaml), false, 'never recreated');
});

test('a review read that fails for another reason answers 503 io', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const text = replaceChecked(editorTextOf(fx.yaml), '    max_npcs: 8\n', '    max_npcs: 3\n');
  const realCheck = vaultsettingswrite.checkTarget;
  const realRead = read.readBytes;
  let armed = false;
  vaultsettingswrite.checkTarget = (...args) => {
    const out = realCheck(...args);
    armed = true;
    return out;
  };
  read.readBytes = (p) => {
    if (armed && p === fx.yaml) {
      armed = false;
      const cause = new Error('i/o error');
      cause.code = 'EIO';
      throw new VaultReadError(p, cause);
    }
    return realRead(p);
  };
  let res;
  try {
    res = await textDry(h, fx, text);
  } finally {
    vaultsettingswrite.checkTarget = realCheck;
    read.readBytes = realRead;
  }
  assert.equal(res.status, 503, res.text);
  assert.deepEqual(res.json, { error: 'io', message: `could not read vault path: ${fx.yaml} (EIO)` });
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
});
