'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const backups = require('../src/config/backups');
const machinedir = require('../src/config/machinedir');

/*
 * V1e-1 (ADR 0033, SD-6, AC-01 to AC-06a). Real sockets, following test/admin-v1b-server.test.js's
 * launch()/launchAuthed() pattern (copied, not required -- house rule). Isolation: every scratch
 * env var is set to a per-file mkdtemp before any test runs; every launch also passes an explicit
 * --config under the test's own scratch root.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vch-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vch-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vch-sc-')), 'config.toml');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeScratchVault(root, opts = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });

  const mdText =
    opts.vaultConfigMd !== undefined
      ? opts.vaultConfigMd
      : '---\ntype: meta\npublish:\n  theme:\n    tagline: Old words\n---\n\n# vault config body\n';
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), mdText);

  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ siteTitle: 'Alpha Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n',
  );

  const configDir = opts.configDir || path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const campaignKey = opts.campaignKey || 'alpha';
  fs.writeFileSync(
    configPath,
    ['config_version = 1', `default_campaign = "${campaignKey}"`, '', `[campaigns.${campaignKey}]`, `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join(
      '\n',
    ),
  );
  return { vaultPath, packDir, configPath, configDir };
}

async function withScratchOpts(opts, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vch-'));
  try {
    return await fn(writeScratchVault(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withScratch(fn) {
  return withScratchOpts({}, fn);
}

function launch(t, configPath, extraFlags = {}) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true, ...extraFlags }, 'alpha', {
    emit: (l) => emitted.push(l),
    startLocalListener: wrappedListener,
    signals,
  });
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

function waitForMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForHandles(state) {
  while (state.handles.length < 2) {
    await waitForMacrotask();
  }
  return state;
}

async function shutdown(state) {
  state.signals.emit('SIGINT');
  await state.resultPromise;
}

function tokenFromLine(line) {
  return line.match(/token=([A-Za-z0-9_-]{43})$/)[1];
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

async function launchAuthed(t, configPath, extraFlags = {}) {
  const s = await waitForHandles(launch(t, configPath, extraFlags));
  const adminPort = s.handles[0].port;
  const authResult = await request(adminPort, { path: `/auth?token=${tokenFromLine(s.emitted[0])}` });
  const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];
  return {
    adminPort,
    cookie: cookieHeader,
    get: (p) => request(adminPort, { path: p, headers: { Cookie: cookieHeader } }),
    post: (p, opts = {}) =>
      request(adminPort, {
        method: 'POST',
        path: p,
        headers: {
          Cookie: cookieHeader,
          Origin: `http://127.0.0.1:${adminPort}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers || {}),
        },
        body: opts.body,
      }),
    shutdown: () => shutdown(s),
  };
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

// === Include shapes ==========================================================================

test('?include=vaultconfig gives the exact 8-key shape with the current tagline and no body', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state?include=vaultconfig'));
    assert.deepEqual(Object.keys(body.vaultConfigFile), ['exists', 'sha256', 'frontmatterText', 'tagline', 'editable', 'reason', 'backupDir']);
    assert.equal(body.vaultConfigFile.exists, true);
    assert.equal(body.vaultConfigFile.tagline, 'Old words');
    assert.equal(body.vaultConfigFile.editable, true);
    assert.equal(body.vaultConfigFile.reason, null);
    assert.match(body.vaultConfigFile.sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(body.vaultConfigFile.frontmatterText, /vault config body/, 'the body must never appear in frontmatterText');
    await c.shutdown();
  });
});

test('include-name siblings vaultconfigx, Vaultconfig, vaultconfi, "vaultconfig " give no vaultConfigFile key', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    for (const query of ['vaultconfigx', 'Vaultconfig', 'vaultconfi', 'vaultconfig%20']) {
      const body = json(await c.get(`/api/state?include=${query}`));
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'vaultConfigFile'), false, query);
    }
    await c.shutdown();
  });
});

test('the default /api/state (no include) is byte-identical whether or not ?include=vaultconfig is ever requested elsewhere', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const before = await c.get('/api/state');
    await c.get('/api/state?include=vaultconfig');
    const after = await c.get('/api/state');
    assert.deepEqual(before.body, after.body);
    assert.equal(Object.prototype.hasOwnProperty.call(json(before), 'vaultConfigFile'), false);
    await c.shutdown();
  });
});

// === Dry run then confirm ====================================================================

test('dry run then confirm sets the tagline, backs it up, and the include shows the new value', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));
    const baseSha256 = state.vaultConfigFile.sha256;

    const dry = json(await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'New words', baseSha256, dryRun: true }) }));
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.file, 'vault-config.md');
    assert.match(dry.before, /Old words/);
    assert.match(dry.after, /New words/);
    assert.ok(dry.backupDir);

    const mdPath = path.join(vaultPath, '_meta', 'vault-config.md');
    assert.match(fs.readFileSync(mdPath, 'utf8'), /Old words/, 'a dry run must never write');

    const confirm = json(await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'New words', baseSha256, dryRun: false }) }));
    assert.equal(confirm.ok, true);
    assert.equal(confirm.file, 'vault-config.md');
    assert.match(confirm.sha256, /^[0-9a-f]{64}$/);
    assert.ok(confirm.backupPath);
    assert.equal(fs.existsSync(confirm.backupPath), true);
    assert.deepEqual(fs.readFileSync(confirm.backupPath, 'utf8'), '---\ntype: meta\npublish:\n  theme:\n    tagline: Old words\n---\n\n# vault config body\n');

    assert.match(fs.readFileSync(mdPath, 'utf8'), /New words/);
    assert.doesNotMatch(fs.readFileSync(mdPath, 'utf8'), /Old words/);

    const after = json(await c.get('/api/state?include=vaultconfig'));
    assert.equal(after.vaultConfigFile.tagline, 'New words');

    await c.shutdown();
  });
});

test('clearing the tagline (empty string) removes it, and a dry run reflects that before any write', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));
    const confirm = json(
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: '', baseSha256: state.vaultConfigFile.sha256, dryRun: false }) }),
    );
    assert.equal(confirm.ok, true);
    const after = json(await c.get('/api/state?include=vaultconfig'));
    assert.equal(after.vaultConfigFile.tagline, null);
    await c.shutdown();
  });
});

test('a save whose candidate equals the current bytes (no-op set) returns unchanged:true, with no backup file created', async (t) => {
  // The fixture's tagline must already be in the EXACT bytes applyTagline itself would produce
  // (a JSON-quoted scalar) for a same-value set to be byte-identical, not merely semantically
  // equal (an unquoted "Old words" -> quoted "\"Old words\"" round trip is a real byte change).
  await withScratchOpts({ vaultConfigMd: '---\ntype: meta\npublish:\n  theme:\n    tagline: "Old words"\n---\n\n# vault config body\n' }, async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));
    const backupDir = state.vaultConfigFile.backupDir;
    const result = json(
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'Old words', baseSha256: state.vaultConfigFile.sha256, dryRun: false }) }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0, 'no backup file for a no-op save');
    await c.shutdown();
  });
});

// === 409 changed ==============================================================================

test('a stale baseSha256 gives 409 changed, and the file is unchanged', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    const mdPath = path.join(vaultPath, '_meta', 'vault-config.md');
    const before = fs.readFileSync(mdPath, 'utf8');
    const res = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'New', baseSha256: 'a'.repeat(64), dryRun: false }) });
    assert.equal(res.status, 409);
    assert.deepEqual(json(res), { error: 'changed', message: 'vault-config.md changed outside the panel. Reload before saving.' });
    assert.equal(fs.readFileSync(mdPath, 'utf8'), before);
    await c.shutdown();
  });
});

// === 403 read-only =============================================================================

test('a read-only (pack-key) campaign gets 403 read-only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vch-ro-'));
  try {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    const packRoot = path.join(root, 'pack');
    fs.mkdirSync(packRoot, { recursive: true });
    fs.writeFileSync(path.join(packRoot, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(path.join(packRoot, 'vault.config.json'), '{"siteTitle":"RO"}\n');
    const configDir = path.join(root, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, `pack = '${packRoot}'`, ''].join(
        '\n',
      ),
    );
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'x', baseSha256: 'a'.repeat(64), dryRun: true }) });
    assert.equal(res.status, 403);
    assert.equal(json(res).error, 'read-only');
    await c.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === 503 unavailable ===========================================================================

test('503 unavailable when the machine dir (config folder) is inside the vault', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vch-inside-'));
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  theme:\n    tagline: Old\n---\n');
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), '{"siteTitle":"Inside"}\n');
    const configPath = path.join(vaultPath, 'config.toml'); // deliberately inside the vault
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'x', baseSha256: 'a'.repeat(64), dryRun: true }) });
    assert.equal(res.status, 503);
    assert.equal(json(res).error, 'unavailable');

    const state = json(await c.get('/api/state?include=vaultconfig'));
    assert.equal(state.vaultConfigFile.editable, false);
    assert.match(state.vaultConfigFile.reason, /inside the vault/);
    await c.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === 400 body errors ============================================================================

test('400 body errors: malformed JSON, non-object, unknown field, tagline not a string, tagline: 42, bad sha, non-boolean dryRun', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));
    const goodSha = state.vaultConfigFile.sha256;

    const malformed = await c.post('/api/vault-config/tagline', { body: '{not json' });
    assert.equal(malformed.status, 400);

    const arrayBody = await c.post('/api/vault-config/tagline', { body: JSON.stringify([1, 2]) });
    assert.equal(arrayBody.status, 400);

    const unknown = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'x', baseSha256: goodSha, extra: 1 }) });
    assert.equal(unknown.status, 400);

    const notString = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 42, baseSha256: goodSha }) });
    assert.equal(notString.status, 400);
    assert.match(json(notString).message, /must be a string/);

    const badSha = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'x', baseSha256: 'nothex' }) });
    assert.equal(badSha.status, 400);

    const nullSha = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'x', baseSha256: null }) });
    assert.equal(nullSha.status, 400, 'baseSha256 never allows null on this route');

    const badDryRun = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'x', baseSha256: goodSha, dryRun: 'yes' }) });
    assert.equal(badDryRun.status, 400);

    await c.shutdown();
  });
});

// === Route siblings (404) =====================================================================

test('/api/vault-config/taglinex and /api/vault-config return 404', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const a = await c.post('/api/vault-config/taglinex', { body: JSON.stringify({}) });
    assert.equal(a.status, 404);
    const b = await c.post('/api/vault-config', { body: JSON.stringify({}) });
    assert.equal(b.status, 404);
    await c.shutdown();
  });
});

// === Injected failures ==========================================================================

test('an injected backups.backupThenPrune throw gives 503, and the vault is unchanged', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));
    const mdPath = path.join(vaultPath, '_meta', 'vault-config.md');
    const before = fs.readFileSync(mdPath, 'utf8');

    const original = backups.backupThenPrune;
    backups.backupThenPrune = () => {
      throw new backups.BackupError('injected backup failure');
    };
    try {
      const res = await c.post('/api/vault-config/tagline', {
        body: JSON.stringify({ tagline: 'New', baseSha256: state.vaultConfigFile.sha256, dryRun: false }),
      });
      assert.equal(res.status, 503);
      assert.equal(json(res).error, 'io');
    } finally {
      backups.backupThenPrune = original;
    }
    assert.equal(fs.readFileSync(mdPath, 'utf8'), before);
    await c.shutdown();
  });
});

test('an injected vaultconfigedit.applyTagline returning a bad candidate gives 422, the file is unchanged, and no backup file is created', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));
    const mdPath = path.join(vaultPath, '_meta', 'vault-config.md');
    const before = fs.readFileSync(mdPath, 'utf8');
    const backupDir = state.vaultConfigFile.backupDir;

    // eslint-disable-next-line global-require
    const vaultconfigedit = require('../src/admin/vaultconfigedit');
    const original = vaultconfigedit.applyTagline;
    vaultconfigedit.applyTagline = () => Buffer.from('not even frontmatter');
    try {
      const res = await c.post('/api/vault-config/tagline', {
        body: JSON.stringify({ tagline: 'New', baseSha256: state.vaultConfigFile.sha256, dryRun: false }),
      });
      assert.equal(res.status, 422);
    } finally {
      vaultconfigedit.applyTagline = original;
    }
    assert.equal(fs.readFileSync(mdPath, 'utf8'), before);
    assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0);
    await c.shutdown();
  });
});

// === E12: the handler must compare semanticGuard(cur, cand), never semanticGuard(cand, cand) ===

test('E12: a candidate that sets the tagline correctly but silently drops an unrelated sibling key (mode: full) is refused (422), proving the handler feeds semanticGuard the CURRENT parsed data, not the candidate twice', async (t) => {
  // textualGuard already refuses this same corruption on its own (an unrelated added/removed
  // line can never match its publish:/theme:/tagline: pattern), so it is patched to always
  // succeed here -- this isolates semanticGuard as the ONLY guard standing between the handler
  // and a 200, which is exactly what a `semanticGuard(cand, cand, value)` mutation at the call
  // site (src/admin/handlers/vaultconfig.js) would otherwise sail through undetected.
  await withScratchOpts(
    { vaultConfigMd: '---\ntype: meta\npublish:\n  mode: full\n  theme:\n    tagline: Old\n---\n\n# vault config body\n' },
    async ({ configPath, vaultPath }) => {
      const c = await launchAuthed(t, configPath);
      const state = json(await c.get('/api/state?include=vaultconfig'));
      const mdPath = path.join(vaultPath, '_meta', 'vault-config.md');
      const before = fs.readFileSync(mdPath, 'utf8');
      const backupDir = state.vaultConfigFile.backupDir;

      // eslint-disable-next-line global-require
      const vaultconfigedit = require('../src/admin/vaultconfigedit');
      const originalApply = vaultconfigedit.applyTagline;
      const originalTextual = vaultconfigedit.textualGuard;
      vaultconfigedit.applyTagline = () =>
        Buffer.from('---\ntype: meta\npublish:\n  theme:\n    tagline: "New"\n---\n\n# vault config body\n');
      vaultconfigedit.textualGuard = () => true;
      try {
        const res = await c.post('/api/vault-config/tagline', {
          body: JSON.stringify({ tagline: 'New', baseSha256: state.vaultConfigFile.sha256, dryRun: false }),
        });
        assert.equal(res.status, 422, `expected the dropped "mode: full" key to be refused; got ${res.status}: ${res.body}`);
        assert.equal(json(res).error, 'unsupported');
      } finally {
        vaultconfigedit.applyTagline = originalApply;
        vaultconfigedit.textualGuard = originalTextual;
      }
      assert.equal(fs.readFileSync(mdPath, 'utf8'), before, 'the file must be unchanged');
      assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0, 'no backup for a refused save');
      await c.shutdown();
    },
  );
});

// === Body-marker leak scan ======================================================================

test('a body-marker literal never appears in any response (include, dry run, confirm, or an error)', async (t) => {
  const marker = 'BodyLeakMarkerZulu';
  await withScratchOpts({ vaultConfigMd: `---\ntype: meta\npublish:\n  theme:\n    tagline: Old\n---\n\n# ${marker}\n` }, async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const bodies = [];
    bodies.push(await c.get('/api/state?include=vaultconfig'));
    const state = json(bodies[0]);
    const dry = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'New', baseSha256: state.vaultConfigFile.sha256, dryRun: true }) });
    bodies.push(dry);
    const confirm = await c.post('/api/vault-config/tagline', {
      body: JSON.stringify({ tagline: 'New', baseSha256: state.vaultConfigFile.sha256, dryRun: false }),
    });
    bodies.push(confirm);
    const errRes = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'x', baseSha256: 'a'.repeat(64) }) });
    bodies.push(errRes);

    for (const res of bodies) {
      assert.equal(res.body.toString('utf8').includes(marker), false);
    }
    await c.shutdown();
  });
});

// === AC-05: one base sha per file, sequential saves ============================================

test('AC-05 server: with the SECOND write (vault-config.md) injected to fail, the first file (vault.config.json) stays saved', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state'));

    const settingsSave = json(
      await c.post('/api/pack/settings', { body: JSON.stringify({ siteTitle: 'New Title', baseSha256: state.vaultConfigJson.sha256, dryRun: false }) }),
    );
    assert.equal(settingsSave.ok, true);

    const vc = json(await c.get('/api/state?include=vaultconfig'));
    const original = backups.backupThenPrune;
    backups.backupThenPrune = () => {
      throw new backups.BackupError('injected');
    };
    let taglineSave;
    try {
      taglineSave = await c.post('/api/vault-config/tagline', {
        body: JSON.stringify({ tagline: 'New tagline', baseSha256: vc.vaultConfigFile.sha256, dryRun: false }),
      });
    } finally {
      backups.backupThenPrune = original;
    }
    assert.equal(taglineSave.status, 503);

    const jsonPath = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    assert.match(fs.readFileSync(jsonPath, 'utf8'), /New Title/, 'the first save must stay saved even though the second failed');

    await c.shutdown();
  });
});

test('AC-05: a tagline save followed by another tagline save (using the first response\'s sha256) gives 200 then 200', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));

    const first = json(
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'One', baseSha256: state.vaultConfigFile.sha256, dryRun: false }) }),
    );
    assert.equal(first.ok, true);

    const second = json(
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'Two', baseSha256: first.sha256, dryRun: false }) }),
    );
    assert.equal(second.ok, true);

    await c.shutdown();
  });
});

// === /api/pack/settings refuses landingTagline (SD-6 tail) =====================================

test('/api/pack/settings with landingTagline gives 400 unknown field', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state'));
    const res = await c.post('/api/pack/settings', {
      body: JSON.stringify({ landingTagline: 'x', baseSha256: state.vaultConfigJson.sha256 }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(json(res), { error: 'invalid', message: 'unknown field: landingTagline' });
    await c.shutdown();
  });
});

// === Console silence ============================================================================

test('console and process.stderr.write stay silent across a battery of vault-config requests', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state?include=vaultconfig'));

    const calls = [];
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalStderrWrite = process.stderr.write;
    console.log = (...a) => calls.push(['log', a]);
    console.info = (...a) => calls.push(['info', a]);
    console.warn = (...a) => calls.push(['warn', a]);
    console.error = (...a) => calls.push(['error', a]);
    process.stderr.write = (...a) => {
      calls.push(['stderr', a]);
      return true;
    };
    try {
      await c.get('/api/state?include=vaultconfig');
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'X', baseSha256: state.vaultConfigFile.sha256, dryRun: true }) });
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'X', baseSha256: 'a'.repeat(64), dryRun: false }) });
      await c.post('/api/vault-config/taglinex', { body: '{}' });
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
      process.stderr.write = originalStderrWrite;
    }
    assert.deepEqual(calls, []);
    await c.shutdown();
  });
});
