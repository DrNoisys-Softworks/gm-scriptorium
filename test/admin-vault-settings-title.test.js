'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { moveVaultCopy, replaceChecked } = require('./helpers/moved-vault');
const { scratchRoot, configPathIn, startPanel, get, post } = require('./helpers/campaigns-panel');
const pinned = require('../src/generator/pinned');
const machinedir = require('../src/config/machinedir');
const vaultsettingswrite = require('../src/vault/vaultsettingswrite');
const vaultsettingsplan = require('../src/admin/vaultsettingsplan');
const read = require('../src/vault/read');
const { VaultReadError } = require('../src/util/errors');

/*
 * POST /api/vault-config/title: the title and tagline of a vault whose settings live in
 * _meta/vault-config.yaml, saved together in one write; and the older pack-title and
 * vault-config.md tagline routes, which answer "changed" once the settings have moved. Each moved
 * case starts from a copy of the sample that the pin's own move ran on. Expected values are literals.
 */

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const YAML_FILE = 'vault-config.yaml';
const MOVED_SINCE_LOADED =
  "This vault's settings moved to _meta/vault-config.yaml after the page loaded. Nothing was saved. Reload to edit them there.";
const BACK_SINCE_LOADED =
  "This vault's settings are in _meta/vault-config.md again since the page loaded. Nothing was saved. Reload to edit them there.";
const CHANGED = 'vault-config.yaml changed outside the panel. Reload before saving.';
const SAMPLE_TAGLINE = 'Three hundred years ago a queen rented this valley from a dragon. At midsummer the dragon came back for the rent.';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function register(root, vaultPath) {
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vaultPath)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'),
  );
  return configPath;
}

/** A moved copy of the sample, registered as campaign "lease"; `fold` also folds the pack in (the yaml then sets a title). */
function movedCampaign(t, { fold = true } = {}) {
  const root = scratchRoot(t);
  const { vaultPath } = moveVaultCopy(SAMPLE, root, fold ? { inVaultPack: true } : {});
  const configPath = register(root, vaultPath);
  return {
    root,
    vaultPath,
    configPath,
    pack: path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json'),
    yaml: path.join(vaultPath, '_meta', 'vault-config.yaml'),
    md: path.join(vaultPath, '_meta', 'vault-config.md'),
    backupDir: path.join(path.dirname(configPath), 'backups', 'campaign-lease'),
  };
}

function legacyCampaign(t) {
  const root = scratchRoot(t);
  const vaultPath = path.join(root, 'vault');
  fs.cpSync(SAMPLE, vaultPath, { recursive: true });
  const configPath = register(root, vaultPath);
  return { root, vaultPath, configPath, md: path.join(vaultPath, '_meta', 'vault-config.md'), yaml: path.join(vaultPath, '_meta', 'vault-config.yaml') };
}

const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const linesOf = (buf) => buf.toString('utf8').split('\n');

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

const titleBody = (fx, extra) => ({ file: YAML_FILE, baseSha256: sha(fs.readFileSync(fx.yaml)), ...extra });

test('a dry run on a moved vault reports the two settings it would change, and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const res = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name', tagline: 'New words', dryRun: true }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.dryRun, true);
  assert.equal(res.json.file, 'vault-config.yaml');
  assert.deepEqual(res.json.changed, ['player_site.title', 'player_site.theme.tagline']);
  assert.match(res.json.before, /^ {2}title: The Long Lease$/m);
  assert.match(res.json.after, /^ {2}title: A New Name$/m);
  assert.ok(res.json.after.includes('New words'));
  assert.deepEqual(res.json.warnings, []);
  assert.equal(res.json.campaignId, undefined);
  assert.equal(res.json.backupDir, fx.backupDir);
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
  assert.equal(h.ctx.panelSaves || 0, 0);
});

test('a confirm writes the title and the tagline in one write, and keeps one backup', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const res = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name', tagline: 'New words' }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.file, 'vault-config.yaml');
  const after = fs.readFileSync(fx.yaml);
  assert.equal(res.json.sha256, sha(after));
  assert.deepEqual(res.json.warnings, []);
  const bak = backupsIn(fx.backupDir);
  assert.equal(bak.length, 1);
  assert.match(bak[0], /^vault-config-.*\.yaml\.bak$/);
  assert.deepEqual(fs.readFileSync(path.join(fx.backupDir, bak[0])), before);
  assert.ok(!res.json.backupPath.startsWith(fx.vaultPath), 'the backup is outside the vault');
  // Exactly two lines differ from before.
  const a = linesOf(before);
  const b = linesOf(after);
  assert.equal(a.length, b.length);
  const diff = a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
  assert.deepEqual(diff.map(([, y]) => y.trim().split(':')[0]), ['title', 'tagline']);
  assert.equal(diff[0][1], '  title: A New Name');
  assert.match(diff[1][1], /^ {4}tagline: .*New words/);
  assert.equal(h.ctx.panelSaves, 1);
  const state = (await get(h, '/api/state?include=settings')).json;
  assert.equal(state.vaultSettings.title, 'A New Name');
  assert.equal(state.vaultSettings.tagline, 'New words');
  assert.equal(state.vaultSettings.sha256, sha(after));
});

test('a title on a yaml with no title adds it, and an empty tagline removes the tagline line', async (t) => {
  const fx = movedCampaign(t, { fold: false });
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  assert.ok(!/^ {2}title:/m.test(before.toString('utf8')));
  const one = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'Brand New' }));
  assert.equal(one.status, 200, one.text);
  assert.match(fs.readFileSync(fx.yaml, 'utf8'), /^ {2}title: Brand New$/m);
  const two = await post(h, '/api/vault-config/title', titleBody(fx, { tagline: '' }));
  assert.equal(two.status, 200, two.text);
  const text = fs.readFileSync(fx.yaml, 'utf8');
  assert.ok(!text.includes('tagline:'));
  assert.ok(!text.includes('a queen rented this valley'));
  assert.match(text, /^ {2}title: Brand New$/m);
  assert.equal(backupsIn(fx.backupDir).length, 2);
});

test('a title the yaml already holds, saved again, is unchanged and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const res = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'The Long Lease' }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.unchanged, true);
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

test('a stale baseSha256 answers 409 changed and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  for (const dryRun of [true, false]) {
    const res = await post(h, '/api/vault-config/title', { file: YAML_FILE, baseSha256: 'a'.repeat(64), title: 'A New Name', dryRun });
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.json, { error: 'changed', message: CHANGED });
  }
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

test('bad requests answer 400', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const base = sha(fs.readFileSync(fx.yaml));
  const cases = [
    [{ file: YAML_FILE, baseSha256: base }, 'give a title or a tagline to save'],
    [{ baseSha256: base, title: 'x' }, 'file must be "vault-config.yaml"'],
    [{ file: 'vault-config.md', baseSha256: base, title: 'x' }, 'file must be "vault-config.yaml"'],
    [{ file: YAML_FILE, baseSha256: 'zz', title: 'x' }, 'baseSha256 must be 64 lowercase hex characters'],
    [{ file: YAML_FILE, baseSha256: base, title: 'x', colour: 'red' }, 'unknown field: colour'],
    [{ file: YAML_FILE, baseSha256: base, title: 5 }, null],
    [{ file: YAML_FILE, baseSha256: base, title: '   ' }, null],
    [{ file: YAML_FILE, baseSha256: base, tagline: 5 }, null],
    [{ file: YAML_FILE, baseSha256: base, title: 'x', dryRun: 'yes' }, 'dryRun must be a boolean'],
  ];
  for (const [body, message] of cases) {
    const res = await post(h, '/api/vault-config/title', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    assert.equal(res.json.error, 'invalid');
    if (message !== null) assert.ok(res.json.message.includes(message), `${res.json.message}`);
  }
});

test('the route on an old-layout campaign answers 409 with the back-again text', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = snapshot(fx.vaultPath);
  const res = await post(h, '/api/vault-config/title', { file: YAML_FILE, baseSha256: 'a'.repeat(64), title: 'A New Name', dryRun: false });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: BACK_SINCE_LOADED });
  assert.deepEqual(snapshot(fx.vaultPath), before);
});

test('a read-only campaign answers 403', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  h.ctx.writable = false;
  h.ctx.readOnlyReason = 'this panel is read-only';
  const res = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name' }));
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error, 'read-only');
});

test('with live stats on, a dry run that changes the title reports the campaign id change', async (t) => {
  const fx = movedCampaign(t);
  fs.writeFileSync(fx.yaml, replaceChecked(fs.readFileSync(fx.yaml, 'utf8'), 'live_stats: false', 'live_stats: true'));
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name', dryRun: true }));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.campaignId, { before: 'the-long-lease', after: 'a-new-name' });
  // A tagline-only change does not move the id.
  const tag = await post(h, '/api/vault-config/title', titleBody(fx, { tagline: 'New words', dryRun: true }));
  assert.equal(tag.status, 200, tag.text);
  assert.equal(tag.json.campaignId, undefined);
});

test('the pack title route on a moved vault answers 409 changed, dry run or not, and the pack is unchanged', async (t) => {
  const fx = movedCampaign(t, { fold: false });
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.pack);
  for (const dryRun of [true, false]) {
    const res = await post(h, '/api/pack/settings', { siteTitle: 'A New Name', baseSha256: sha(before), dryRun });
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.json, { error: 'changed', message: MOVED_SINCE_LOADED });
  }
  assert.deepEqual(fs.readFileSync(fx.pack), before);
});

test('the pack title route after a move made while the panel runs answers 409 changed, and the pack is unchanged', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const pack = path.join(fx.vaultPath, '_meta', 'scriptorium', 'vault.config.json');
  const before = fs.readFileSync(pack);
  fs.renameSync(fx.md, fx.yaml);
  const res = await post(h, '/api/pack/settings', { siteTitle: 'A New Name', baseSha256: sha(before), dryRun: false });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: MOVED_SINCE_LOADED });
  assert.deepEqual(fs.readFileSync(pack), before);
});

test('the md tagline route without a file, on a moved vault, answers 409 changed', async (t) => {
  const fx = movedCampaign(t, { fold: false });
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = snapshot(fx.vaultPath);
  const res = await post(h, '/api/vault-config/tagline', { tagline: 'New words', baseSha256: 'a'.repeat(64), dryRun: false });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: MOVED_SINCE_LOADED });
  assert.deepEqual(snapshot(fx.vaultPath), before);
});

test('the md tagline route accepts a file key, and rejects a wrong one', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const base = sha(fs.readFileSync(fx.md));
  const ok = await post(h, '/api/vault-config/tagline', { file: 'vault-config.md', tagline: 'New words', baseSha256: base, dryRun: true });
  assert.equal(ok.status, 200, ok.text);
  const bad = await post(h, '/api/vault-config/tagline', { file: 'other.md', tagline: 'New words', baseSha256: base, dryRun: true });
  assert.equal(bad.status, 400, bad.text);
});

test('a move that lands while a title save waits for the lock answers 409 changed, not 422', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const body = titleBody(fx, { title: 'A New Name', dryRun: true });
  const real = pinned.settingsLayoutOf;
  let looks = 0;
  // The first look (before the lock) sees the yaml; the settings move back to vault-config.md right after it.
  pinned.settingsLayoutOf = (vaultPath) => {
    const layout = real(vaultPath);
    looks += 1;
    if (looks === 1) fs.renameSync(fx.yaml, fx.md);
    return layout;
  };
  let res;
  try {
    res = await post(h, '/api/vault-config/title', body);
  } finally {
    pinned.settingsLayoutOf = real;
  }
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: BACK_SINCE_LOADED });
  assert.equal(looks, 2);
});

test('a move that lands while a md tagline save waits for the lock answers 409 changed with the moved text', async (t) => {
  const fx = legacyCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const base = sha(fs.readFileSync(fx.md));
  const real = pinned.settingsLayoutOf;
  let looks = 0;
  pinned.settingsLayoutOf = (vaultPath) => {
    const layout = real(vaultPath);
    looks += 1;
    if (looks === 1) fs.renameSync(fx.md, fx.yaml);
    return layout;
  };
  let res;
  try {
    res = await post(h, '/api/vault-config/tagline', { file: 'vault-config.md', tagline: SAMPLE_TAGLINE + ' More.', baseSha256: base, dryRun: false });
  } finally {
    pinned.settingsLayoutOf = real;
  }
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: MOVED_SINCE_LOADED });
  assert.equal(looks, 2);
  assert.deepEqual(backupsIn(path.join(path.dirname(fx.configPath), 'backups', 'campaign-lease')), []);
});

/** Replaces `mod[name]` for the length of `fn`, then puts it back. */
async function withInjected(mod, name, impl, fn) {
  const real = mod[name];
  mod[name] = impl(real);
  try {
    return await fn();
  } finally {
    mod[name] = real;
  }
}

test('a machine folder that cannot be found answers 503 unavailable and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const res = await withInjected(
    machinedir,
    'resolveMachineDir',
    () => () => ({ ok: false, reason: 'injected: no machine folder' }),
    () => post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name' })),
  );
  assert.equal(res.status, 503, res.text);
  assert.deepEqual(res.json, { error: 'unavailable', message: 'injected: no machine folder' });
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

test('a target check that finds the yaml changed answers 409 changed and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const res = await withInjected(
    vaultsettingswrite,
    'checkTarget',
    () => () => {
      throw new vaultsettingswrite.VaultSettingsChangedError('injected: the yaml changed');
    },
    () => post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name' })),
  );
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: 'injected: the yaml changed' });
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

test('a plan the pin refuses answers 422 unsupported with its message and writes nothing', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  const res = await withInjected(
    vaultsettingsplan,
    'planTitleTagline',
    () => () => {
      throw new pinned.SettingsPlanError('refused', 'injected: the pin will not make this edit');
    },
    () => post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name' })),
  );
  assert.equal(res.status, 422, res.text);
  assert.deepEqual(res.json, { error: 'unsupported', message: 'injected: the pin will not make this edit' });
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
  assert.deepEqual(backupsIn(fx.backupDir), []);
});

// The route reads the yaml right after checking where it is. A file gone in between answers 409
// changed and any other read failure 503 io, never a 500.
test('a yaml that vanishes between the target check and the read answers 409 changed', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await withInjected(
    vaultsettingswrite,
    'checkTarget',
    (real) => (...args) => {
      const out = real(...args);
      fs.rmSync(fx.yaml);
      return out;
    },
    () => post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name' })),
  );
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'changed', message: CHANGED });
  assert.equal(fs.existsSync(fx.yaml), false, 'never recreated');
});

test('a yaml read that fails for another reason answers 503 io', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const before = fs.readFileSync(fx.yaml);
  let armed = false;
  const res = await withInjected(
    vaultsettingswrite,
    'checkTarget',
    (real) => (...args) => {
      const out = real(...args);
      armed = true;
      return out;
    },
    () =>
      withInjected(
        read,
        'readBytes',
        (real) => (p) => {
          if (armed && p === fx.yaml) {
            armed = false;
            const cause = new Error('i/o error');
            cause.code = 'EIO';
            throw new VaultReadError(p, cause);
          }
          return real(p);
        },
        () => post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name' })),
      ),
  );
  assert.equal(res.status, 503, res.text);
  assert.deepEqual(res.json, { error: 'io', message: `could not read vault path: ${fx.yaml} (EIO)` });
  assert.deepEqual(fs.readFileSync(fx.yaml), before);
});
