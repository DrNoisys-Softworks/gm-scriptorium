'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite, runCheckForContextWithContext } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');
const preview = require('../src/admin/preview');
const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { moveVaultCopy } = require('./helpers/moved-vault');
const { makeCampaigns, startPanel, post } = require('./helpers/campaigns-panel');

/*
 * Issue #171, the panel. A vault can be moved while the panel is running, so each of these opens
 * the panel (or builds a context) on an OLD vault first, then plants or renames the settings file.
 *   (i) the preview and the check exit 0 on a vault the pin's move has run on;
 *   (j) the tagline save refuses in the mixed state, writing no backup and no temp file
 *       (editing a moved vault comes in a later task);
 *   (k) switching to a campaign whose vault is moved succeeds.
 * Expected messages are literals. The socket helpers are copied from
 * test/admin-vault-config-http.test.js (house rule: no requiring across test files).
 */

// === (i) preview and check after a plant, in process ========================================

function listTree(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  })(dir, '');
  out.sort();
  return out;
}

function assertTreesByteIdentical(dirA, dirB) {
  const a = listTree(dirA);
  assert.deepEqual(a, listTree(dirB), 'the two trees do not have the same file list');
  for (const rel of a) {
    assert.deepEqual(fs.readFileSync(path.join(dirA, rel)), fs.readFileSync(path.join(dirB, rel)), `byte mismatch at ${rel}`);
  }
}

test('(i) on a vault the move has run on, the preview build and the check exit 0, and the preview holds the yaml\'s title', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-panel-'));
  let ctx = null;
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vocab-vault', '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
    pack.siteTitle = 'Moved Panel Title';
    // The pin's own move, folding the site file in: the title and folder map now live in the yaml.
    const moved = moveVaultCopy(path.join(__dirname, 'fixtures', 'vocab-vault'), root, { siteConfig: pack });
    const vaultPath = moved.vaultPath;
    fs.rmSync(path.join(vaultPath, '_meta', 'scriptorium'), { recursive: true, force: true });
    assert.equal(fs.existsSync(path.join(vaultPath, '_meta', 'vault-config.yaml')), true);
    assert.equal(fs.existsSync(path.join(vaultPath, '_meta', 'vault-config.md')), false);
    const siteFile = path.join(root, 'site-left.json');
    fs.writeFileSync(siteFile, JSON.stringify(moved.siteConfig, null, 2));
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `site_config = '${siteFile}'`, `output = '${root}/out'`, ''].join('\n'));
    const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
    const { vaultPath: resolved, site } = resolveVaultSite(ctxInfo);
    ctx = createAdminContext({ ctxInfo, vaultPath: resolved, site, token: 'TOK' });
    preview.ensurePreviewRoot(ctx);

    const built = preview.runPreviewBuild(ctx);
    assert.equal(built.exitCode, 0, built.human);
    assert.match(fs.readFileSync(path.join(ctx.previewDir, 'index.html'), 'utf8'), /<title>[^<]*Moved Panel Title/);

    const checked = runCheckForContextWithContext(ctx.ctxInfo, {}, {});
    assert.equal(checked.exitCode, 0, checked.human);
  } finally {
    if (ctx) preview.removePreviewRoot(ctx);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === (j) the tagline save in the mixed state, real sockets ==================================

const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-sc-')), 'config.toml');

const MD_TEXT = '---\ntype: meta\npublish:\n  theme:\n    tagline: Old words\n---\n\n# vault config body\n';

function writeScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), MD_TEXT);
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ siteTitle: 'Alpha Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n');
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'));
  return { vaultPath, configPath, configDir };
}

function launch(t, configPath) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true }, 'alpha', { emit: (l) => emitted.push(l), startLocalListener: wrappedListener, signals });
  t.after(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // already closed by the test's own shutdown()
      }
    }
  });
  return { resultPromise, handles, emitted, signals };
}

function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function launchAuthed(t, configPath) {
  const s = launch(t, configPath);
  while (s.handles.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const adminPort = s.handles[0].port;
  // The launch line ends with the one-time sign-in value after an equals sign.
  const key = s.emitted[0].split('=').pop();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  const authResult = await request(adminPort, { path: `/auth?token=${key}` });
  const cookie = authResult.headers['set-cookie'][0].split(';')[0];
  return {
    get: (p) => request(adminPort, { path: p, headers: { Cookie: cookie } }),
    post: (p, body) =>
      request(adminPort, {
        method: 'POST',
        path: p,
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${adminPort}`, 'Content-Type': 'application/json' },
        body,
      }),
    shutdown: async () => {
      s.signals.emit('SIGINT');
      await s.resultPromise;
    },
  };
}

test('(j) a tagline save in the mixed state answers 422 unsupported, with the file unchanged, no backup and no temp file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-moved-http-'));
  try {
    const { vaultPath, configPath } = writeScratchVault(root);
    const c = await launchAuthed(t, configPath);
    const state = JSON.parse((await c.get('/api/state?include=vaultconfig')).body.toString('utf8'));
    assert.equal(state.vaultConfigFile.editable, true, 'the old vault is editable before the move');
    const baseSha256 = state.vaultConfigFile.sha256;
    const backupDir = state.vaultConfigFile.backupDir;

    fs.copyFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), path.join(vaultPath, '_meta', 'vault-config.yaml'));

    const res = await c.post('/api/vault-config/tagline', JSON.stringify({ tagline: 'New words', baseSha256, dryRun: false }));
    assert.equal(res.status, 422);
    assert.deepEqual(JSON.parse(res.body.toString('utf8')), {
      error: 'unsupported',
      message:
        "This campaign's tagline is set in the vault's settings file (_meta/vault-config.yaml). Editing it here arrives in the next update; change it in that file for now.",
    });
    assert.equal(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), 'utf8'), MD_TEXT);
    assert.ok(!fs.existsSync(backupDir) || fs.readdirSync(backupDir).length === 0, 'no backup was written');
    assert.deepEqual(fs.readdirSync(path.join(vaultPath, '_meta')).filter((n) => n.startsWith('.scriptorium-tmp-vault-config-')), []);
    await c.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === (k) the campaign switch ================================================================

test('(k) switching to a campaign whose vault moved answers 200 and puts the panel on that campaign', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  fs.renameSync(path.join(fx.vaults.beta, '_meta', 'vault-config.md'), path.join(fx.vaults.beta, '_meta', 'vault-config.yaml'));
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const res = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(h.ctx.campaign, 'beta');
});
