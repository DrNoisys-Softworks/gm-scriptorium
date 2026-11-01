'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { moveVaultCopy } = require('./helpers/moved-vault');
const { scratchRoot, configPathIn, startPanel, get, post } = require('./helpers/campaigns-panel');
const freshness = require('../src/admin/freshness');
const { checkTarget } = require('../src/vault/vaultconfigwrite');

/*
 * The panel on a vault whose settings gm-apprentice moved to _meta/vault-config.yaml (ADR 0071):
 * the title, tagline and settings editor are read-only with a line saying where each now lives,
 * and the Title & tagline screen offers the carry (POST /api/settings/carry). Each case starts from
 * a copy of the sample vault that the pin's own move has run on WITHOUT folding the pack in, so the
 * yaml sets no title (the pin defect gm-apprentice#539) and the pack still holds its settings.
 * Expected values are literals; the only thing a test composes is a path it made itself.
 */

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

const TITLE_MOVED =
  "This campaign's title is set in the vault's settings file (_meta/vault-config.yaml). Editing it here arrives in the next update; change it in that file for now.";
const TAGLINE_MOVED =
  "This campaign's tagline is set in the vault's settings file (_meta/vault-config.yaml). Editing it here arrives in the next update; change it in that file for now.";
const SETTINGS_MOVED =
  "This campaign's settings are set in the vault's settings file (_meta/vault-config.yaml). Editing them here arrives in the next update; change them in that file for now.";
const NO_TITLE = "No site title is set in the vault's settings file (_meta/vault-config.yaml).";
const SAMPLE_TAGLINE = 'Three hundred years ago a queen rented this valley from a dragon. At midsummer the dragon came back for the rent.';
const CHANGED =
  "The pack or the vault's settings file changed since these settings were shown. Nothing was written. Look at them again before carrying.";

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * A moved copy of the sample, registered as campaign "lease". `fold: true` runs the move with the pack
 * folded in (the yaml then sets the title and the pack holds nothing to carry).
 */
function movedCampaign(t, { fold = false, siteConfig = false } = {}) {
  const root = scratchRoot(t);
  const { vaultPath } = moveVaultCopy(SAMPLE, root, fold ? { inVaultPack: true } : {});
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const lines = ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vaultPath)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`];
  if (siteConfig) {
    const file = path.join(root, 'site.json');
    fs.copyFileSync(path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json'), file);
    lines.push(`site_config = ${JSON.stringify(file)}`);
  }
  fs.writeFileSync(configPath, `${lines.join('\n')}\n`);
  return {
    root,
    vaultPath,
    configPath,
    pack: path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json'),
    yaml: path.join(vaultPath, '_meta', 'vault-config.yaml'),
    backupDir: path.join(fs.realpathSync(path.dirname(configPath)), 'backups', 'campaign-lease'),
    // The same folder spelled as the config path spells it (the panel names backups this way).
    backupDirNamed: path.join(path.dirname(configPath), 'backups', 'campaign-lease'),
  };
}

/** An old-layout copy of the sample with its pack, registered as campaign "lease". */
function legacyCampaign(t) {
  const root = scratchRoot(t);
  const vaultPath = path.join(root, 'vault');
  fs.cpSync(SAMPLE, vaultPath, { recursive: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vaultPath)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'));
  return { root, vaultPath, configPath };
}

function snapshot(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = sha(fs.readFileSync(path.join(d, e.name)));
    }
  })(dir, '');
  return out;
}

const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

function plannedLines(pack) {
  return [
    'This vault is already on the new settings file (_meta/vault-config.yaml).',
    '`host` moves to `player_site.host`.',
    `Will take the settings out of ${pack}: siteTitle, host, folderMap, attachmentsDir, excludeDirs, excludeSections, excludeCallouts, landingTagline, backend.statusBar, backend.inbox. ` +
      'Its excludeDirs entries were added to player_site.hide.folders. Its excludeSections entries were added to player_site.hide.sections. The rest of that file is as it was.',
    '`siteTitle` moves to `player_site.title`.',
    '`folderMap` moves to `player_site.folder_map`.',
  ];
}

function appliedLines(pack) {
  return [
    'This vault is already on the new settings file (_meta/vault-config.yaml).',
    `Removed the settings from ${pack}: siteTitle, host, folderMap, attachmentsDir, excludeDirs, excludeSections, excludeCallouts, landingTagline, backend.statusBar, backend.inbox. The rest of that file is as it was.`,
    '`host` moved to `player_site.host`.',
    '`siteTitle` moved to `player_site.title`.',
    '`folderMap` moved to `player_site.folder_map`.',
    `${pack} was rewritten without the settings that moved.`,
  ];
}

// === GET /api/state ===========================================================================

test('state: a moved vault reports settingsLayout "new", no title in its settings file, and the yaml\'s tagline', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await get(h, '/api/state?include=settings');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.settingsLayout, 'new');
  assert.deepEqual(res.json.vaultSettings, { file: '_meta/vault-config.yaml', title: null, titleNote: NO_TITLE, tagline: SAMPLE_TAGLINE, error: null });
  assert.equal(h.ctx.settingsLayout, 'new');
});

test('state: a moved vault whose settings file sets the title shows that title, read-only', async (t) => {
  const fx = movedCampaign(t, { fold: true });
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await get(h, '/api/state?include=settings');
  assert.equal(res.json.settingsLayout, 'new');
  assert.deepEqual(res.json.vaultSettings, { file: '_meta/vault-config.yaml', title: 'The Long Lease', titleNote: TITLE_MOVED, tagline: SAMPLE_TAGLINE, error: null });
});

test('state: an old-layout vault reports settingsLayout "legacy" and no vault settings', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await get(h, '/api/state?include=settings');
  assert.equal(res.json.settingsLayout, 'legacy');
  assert.equal(res.json.vaultSettings, null);
  assert.equal(h.ctx.settingsLayout, 'legacy');
});

test('state: settingsLayout follows a vault moved while the panel runs, and a campaign switch', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  assert.equal(h.ctx.settingsLayout, 'legacy');
  fs.renameSync(path.join(fx.vaultPath, '_meta', 'vault-config.md'), path.join(fx.vaultPath, '_meta', 'vault-config.yaml'));
  const res = await get(h, '/api/state?include=settings');
  assert.equal(res.json.settingsLayout, 'new');
  assert.equal(h.ctx.settingsLayout, 'new');
});

test('switch: the moved campaign arrives with settingsLayout "new" and the old one goes back to "legacy"', async (t) => {
  const root = scratchRoot(t);
  const moved = moveVaultCopy(SAMPLE, root).vaultPath;
  const old = path.join(root, 'old');
  fs.cpSync(SAMPLE, old, { recursive: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = ${JSON.stringify(old)}`, `output = ${JSON.stringify(path.join(root, 'oa'))}`, '', '[campaigns.beta]', `vault = ${JSON.stringify(moved)}`, `output = ${JSON.stringify(path.join(root, 'ob'))}`, ''].join('\n'),
  );
  const h = await startPanel(t, { config: configPath }, 'alpha');
  assert.equal(h.ctx.settingsLayout, 'legacy');
  const sw = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(sw.status, 200, sw.text);
  assert.equal(h.ctx.settingsLayout, 'new');
  const back = await post(h, '/api/campaigns/switch', { name: 'alpha' }, { campaign: 'beta' });
  assert.equal(back.status, 200, back.text);
  assert.equal(h.ctx.settingsLayout, 'legacy');
});

// === edits the panel can no longer make =======================================================

test('a title save on a moved vault answers 409 settings-moved, dry run or not, and the pack is unchanged', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.pack);
  for (const dryRun of [true, false]) {
    const res = await post(h, '/api/pack/settings', { siteTitle: 'A New Name', baseSha256: sha(before), dryRun });
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.json, { error: 'settings-moved', message: TITLE_MOVED });
  }
  assert.deepEqual(fs.readFileSync(fx.pack), before);
  assert.equal(h.ctx.panelSaves || 0, 0);
});

test('the tagline and the settings editor on a moved vault are refused with the same sentence, naming the tagline or the settings', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const state = (await get(h, '/api/state?include=vaultconfig,vaultconfigeditor')).json;
  assert.equal(state.vaultConfigFile.editable, false);
  assert.equal(state.vaultConfigFile.reason, TAGLINE_MOVED);
  assert.equal(state.vaultConfigEditor.canEdit, false);
  assert.equal(state.vaultConfigEditor.reason, SETTINGS_MOVED);
  const before = snapshot(fx.vaultPath);

  const tagline = await post(h, '/api/vault-config/tagline', { tagline: 'New words', baseSha256: 'a'.repeat(64), dryRun: false });
  assert.equal(tagline.status, 422, tagline.text);
  assert.deepEqual(tagline.json, { error: 'unsupported', message: TAGLINE_MOVED });
  for (const [route, extra] of [['/api/vault-config/text', { frontmatterText: 'x: 1' }], ['/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 3 } }], ['/api/vault-config/restore', { backupId: 'x' }]]) {
    const res = await post(h, route, { ...extra, baseSha256: 'a'.repeat(64), dryRun: true });
    assert.equal(res.status, 422, `${route}: ${res.text}`);
    assert.deepEqual(res.json, { error: 'unsupported', message: SETTINGS_MOVED }, route);
  }

  assert.deepEqual(snapshot(fx.vaultPath), before);
  assert.equal(fs.existsSync(path.join(fx.vaultPath, '_meta', 'vault-config.md')), false, 'no vault-config.md was written');
});

test('checkTarget names the tagline when asked, and the settings otherwise', (t) => {
  const fx = movedCampaign(t);
  assert.throws(() => checkTarget(fx.vaultPath, { campaign: 'lease', what: 'tagline' }), { message: TAGLINE_MOVED });
  assert.throws(() => checkTarget(fx.vaultPath, { campaign: 'lease' }), { message: SETTINGS_MOVED });
});

// === POST /api/settings/carry =================================================================

test('carry dry run: 200 with state "ready" and the plan\'s lines, and nothing is written anywhere', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = snapshot(fx.vaultPath);
  const res = await post(h, '/api/settings/carry', { dryRun: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.dryRun, true);
  assert.equal(res.json.state, 'ready');
  assert.deepEqual(res.json.lines, plannedLines(fx.pack));
  assert.match(res.json.baseSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshot(fx.vaultPath), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
  assert.equal(h.ctx.panelSaves || 0, 0);
});

test('carry: the yaml takes the title, the pack is stripped, both are backed up outside the vault, and the panel shows it without a restart', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const packBefore = fs.readFileSync(fx.pack);
  const yamlBefore = fs.readFileSync(fx.yaml);
  const dry = await post(h, '/api/settings/carry', { dryRun: true });

  const res = await post(h, '/api/settings/carry', { dryRun: false, baseSha256: dry.json.baseSha256 });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.lines, appliedLines(fx.pack));
  assert.deepEqual(Object.keys(res.json.backups).sort(), ['pack', 'yaml']);
  for (const file of Object.values(res.json.backups)) {
    assert.equal(fs.realpathSync(path.dirname(file)), fx.backupDir);
    assert.ok(!file.startsWith(fx.vaultPath), 'backups live outside the vault');
  }
  assert.deepEqual(fs.readFileSync(res.json.backups.pack), packBefore);
  assert.deepEqual(fs.readFileSync(res.json.backups.yaml), yamlBefore);
  assert.equal(fs.readFileSync(fx.pack, 'utf8'), '{}\n');
  assert.match(fs.readFileSync(fx.yaml, 'utf8'), /The Long Lease/);
  assert.equal(h.ctx.panelSaves, 1, 'the carry counts as a save, so a built preview shows as out of date');

  const state = (await get(h, '/api/state?include=settings')).json;
  assert.equal(state.settingsLayout, 'new');
  assert.deepEqual(state.vaultSettings, { file: '_meta/vault-config.yaml', title: 'The Long Lease', titleNote: TITLE_MOVED, tagline: SAMPLE_TAGLINE, error: null });
  assert.equal(state.vaultConfigJson.raw, '{}\n');
  assert.equal(state.vaultConfigJson.siteTitle, null);

  const again = await post(h, '/api/settings/carry', { dryRun: true });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.state, 'nothing');
  assert.deepEqual(again.json.lines, []);
});

test('carry with a stale baseSha256 answers 409 changed and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const dry = await post(h, '/api/settings/carry', { dryRun: true });
  // The GM edits the pack by hand after the lines were shown.
  const pack = JSON.parse(fs.readFileSync(fx.pack, 'utf8'));
  pack.footer = 'hand edit';
  fs.writeFileSync(fx.pack, JSON.stringify(pack, null, 2));
  const before = snapshot(fx.vaultPath);
  const res = await post(h, '/api/settings/carry', { dryRun: false, baseSha256: dry.json.baseSha256 });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: CHANGED });
  assert.deepEqual(snapshot(fx.vaultPath), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

test('carry with nothing to carry answers 409 nothing, and its dry run says so with 200', async (t) => {
  const fx = movedCampaign(t, { fold: true });
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const dry = await post(h, '/api/settings/carry', { dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.state, 'nothing');
  const before = snapshot(fx.vaultPath);
  const res = await post(h, '/api/settings/carry', { dryRun: false, baseSha256: dry.json.baseSha256 });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'nothing', message: 'There is nothing to carry: the pack holds nothing the carry can move.' });
  assert.deepEqual(snapshot(fx.vaultPath), before);
});

test('carry on an old-layout vault is blocked: 409 with the plan\'s reason, dry run or not', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  for (const body of [{ dryRun: true }, { dryRun: false, baseSha256: 'a'.repeat(64) }]) {
    const res = await post(h, '/api/settings/carry', body);
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.json, { error: 'blocked', message: 'this vault keeps its settings in _meta/vault-config.md; there is nothing to carry' });
  }
});

test('carry on a read-only campaign answers 403, dry run or not', async (t) => {
  const fx = movedCampaign(t, { siteConfig: true });
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  assert.equal(h.ctx.writable, false);
  const before = snapshot(fx.vaultPath);
  for (const body of [{ dryRun: true }, { dryRun: false, baseSha256: 'a'.repeat(64) }]) {
    const res = await post(h, '/api/settings/carry', body);
    assert.equal(res.status, 403, res.text);
    assert.deepEqual(res.json, {
      error: 'read-only',
      message: 'This campaign builds from a site_config file, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.',
    });
  }
  assert.deepEqual(snapshot(fx.vaultPath), before);
});

test('carry refuses a malformed request with 400 before anything runs', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const cases = [
    [{}, 'dryRun must be a boolean'],
    [{ dryRun: 'yes' }, 'dryRun must be a boolean'],
    [{ dryRun: false }, 'baseSha256 must be 64 lowercase hex characters'],
    [{ dryRun: true, extra: 1 }, 'unknown field: extra'],
  ];
  for (const [body, message] of cases) {
    const res = await post(h, '/api/settings/carry', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.json, { error: 'invalid', message });
  }
});

test('carry while another write runs answers 409 busy', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  h.ctx.busy = 'write';
  try {
    const res = await post(h, '/api/settings/carry', { dryRun: true });
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.json, { error: 'busy', busy: 'write' });
  } finally {
    h.ctx.busy = null;
  }
});

// === freshness ===============================================================================

test('freshness tracks _meta/vault-config.yaml beside the three files the panel edits', async (t) => {
  assert.deepEqual([...freshness.TRACKED_FILES], ['pack.toml', 'vault.config.json', 'vault-config.md', 'vault-config.yaml']);
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const shas = freshness.readTrackedShas(h.ctx);
  assert.equal(shas['vault-config.yaml'], sha(fs.readFileSync(fx.yaml)));
  assert.equal(shas['vault-config.md'], null);
  const stamp = freshness.takeStamp(h.ctx, 0);
  fs.appendFileSync(fx.yaml, '\n');
  assert.deepEqual(freshness.compareStamp(stamp, freshness.readTrackedShas(h.ctx), 0).savedSince, ['vault-config.yaml']);
});

// === fix round 1 ================================================================================

test('a title save after the vault is moved while the panel runs answers 409 settings-moved, and the pack is unchanged', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  assert.equal(h.ctx.settingsLayout, 'legacy');
  const pack = path.join(fx.vaultPath, '_meta', 'scriptorium', 'vault.config.json');
  const before = fs.readFileSync(pack);
  // gm-apprentice moves the vault; the page has not reloaded its state.
  fs.renameSync(path.join(fx.vaultPath, '_meta', 'vault-config.md'), path.join(fx.vaultPath, '_meta', 'vault-config.yaml'));
  const res = await post(h, '/api/pack/settings', { siteTitle: 'A New Name', baseSha256: sha(before), dryRun: false });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'settings-moved', message: TITLE_MOVED });
  assert.deepEqual(fs.readFileSync(pack), before);
});

test('carry with no usable folder for backups answers 503 and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const dry = await post(h, '/api/settings/carry', { dryRun: true });
  const before = snapshot(fx.vaultPath);
  const realInfo = h.ctx.ctxInfo;
  h.ctx.ctxInfo = { ...realInfo, configPath: path.join(fx.root, 'no-such-folder', 'config.toml') };
  try {
    const res = await post(h, '/api/settings/carry', { dryRun: false, baseSha256: dry.json.baseSha256 });
    assert.equal(res.status, 503, res.text);
    assert.deepEqual(res.json, {
      error: 'io',
      message: "GM-Scriptorium's own folder can't hold backups, so the carry can't keep a copy of both files first. Nothing was written.",
    });
  } finally {
    h.ctx.ctxInfo = realInfo;
  }
  assert.deepEqual(snapshot(fx.vaultPath), before);
});

test('carry whose pack cannot be rewritten answers 503: the yaml holds everything, the pack is as it was', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const packBefore = fs.readFileSync(fx.pack);
  const dry = await post(h, '/api/settings/carry', { dryRun: true });
  const packreplace = require('../src/vault/packreplace');
  const real = packreplace.replacePackFile;
  packreplace.replacePackFile = () => {
    throw Object.assign(new Error('injected'), { code: 'EIO' });
  };
  let res;
  try {
    res = await post(h, '/api/settings/carry', { dryRun: false, baseSha256: dry.json.baseSha256 });
  } finally {
    packreplace.replacePackFile = real;
  }
  assert.equal(res.status, 503, res.text);
  const packBackup = backupsIn(fx.backupDir).filter((n) => n.startsWith('vault.config-'));
  assert.equal(packBackup.length, 1);
  assert.deepEqual(res.json, {
    error: 'io',
    message:
      `The vault's settings already hold every value that was carried, but ${fx.pack} could not be rewritten (EIO). ` +
      "It can stay as it is: the vault's settings are the ones used, and nothing else needs doing. " +
      `The pack as it was is kept at ${path.join(fx.backupDirNamed, packBackup[0])}.`,
  });
  assert.deepEqual(fs.readFileSync(fx.pack), packBefore);
  assert.match(fs.readFileSync(fx.yaml, 'utf8'), /The Long Lease/);
});

test('carry whose title cannot be set in the yaml answers 503, says to carry again from the panel, and keeps the title in the pack', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const dry = await post(h, '/api/settings/carry', { dryRun: true });
  const pinned = require('../src/generator/pinned');
  const real = pinned.applySettingsChanges;
  pinned.applySettingsChanges = () => {
    throw Object.assign(new Error('injected'), { code: 'EIO' });
  };
  let res;
  try {
    res = await post(h, '/api/settings/carry', { dryRun: false, baseSha256: dry.json.baseSha256 });
  } finally {
    pinned.applySettingsChanges = real;
  }
  assert.equal(res.status, 503, res.text);
  const names = backupsIn(fx.backupDir);
  const yamlBak = path.join(fx.backupDirNamed, names.find((n) => n.startsWith('vault-config-')));
  const packBak = path.join(fx.backupDirNamed, names.find((n) => n.startsWith('vault.config-')));
  assert.deepEqual(res.json, {
    error: 'io',
    message:
      `siteTitle and folderMap are still in ${fx.pack}: the vault's settings file could not be written (EIO). ` +
      'The rest of the carry is done. Press "Carry these settings" again once the file can be written. ' +
      `The files as they were are kept at ${yamlBak} and ${packBak}.`,
  });
  const pack = JSON.parse(fs.readFileSync(fx.pack, 'utf8'));
  assert.equal(pack.siteTitle, 'The Long Lease');
});
