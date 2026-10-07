'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { startLocalListener } = require('../src/serve/server');
const { createAdminHandler } = require('../src/admin/router');
const { createAdminContext } = require('../src/admin/context');
const { resolveVaultSite } = require('../src/cli/check');
const pinned = require('../src/generator/pinned');

/*
 * V1e-4 (SD-30, D-6, FR-23). Real sockets through the same harness admin-pack.test.js uses
 * (createAdminHandler, createAdminContext, startLocalListener). Every fixture is a synthetic,
 * scratch-built vault.config.json (NFR-10/NFR-11) -- never test/fixtures, never the real vault.
 *
 * Expected campaign-id literals are typed here, computed independently by hand (once, via
 * `node -e`, against the pin's own facade -- never derived from the code under test): "Old
 * Campaign" -> "old-campaign", "New Campaign" -> "new-campaign", and the accented/apostrophe
 * case "Zoe with an umlaut's Cafe Crawl" -> "zoes-cafe-crawl" (confirmed independently that a
 * naive `toLowerCase().replace(/\s+/g,'-')` gives a different, wrong answer: "zoë's-café-crawl"
 * -- the facade's own accent-stripping and apostrophe-dropping is exactly what T4 (facade bypass)
 * would defeat).
 */

const TOKEN = 'admin-title-campaign-id-test-token';
const ACCENTED_TITLE = "Zoë's Café Crawl"; // "Zoë's Café Crawl"
const ACCENTED_SLUG = 'zoes-cafe-crawl';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-title-campaign-id-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeVault(root, { json, toml = 'theme = "plain"\n' } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), toml);
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), json);
  return { vaultPath, packDir };
}

function ctxFor(vaultPath, extra = {}) {
  const ctxInfo = { campaign: 'alpha', vault: vaultPath, ...extra };
  const { site } = resolveVaultSite(ctxInfo);
  return createAdminContext({ ctxInfo, vaultPath, site, token: TOKEN });
}

async function launch(t, ctx) {
  const handle = await startLocalListener(createAdminHandler(ctx), { port: 0 });
  ctx.adminPort = handle.port;
  t.after(async () => {
    try {
      await handle.close();
    } catch {
      // already closed
    }
  });
  return handle.port;
}

function post(port, urlPath, obj, { auth = true } = {}) {
  const bodyBuf = Buffer.from(JSON.stringify(obj));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': String(bodyBuf.length),
    Host: `127.0.0.1:${port}`,
    Origin: `http://127.0.0.1:${port}`,
  };
  if (auth) headers.Cookie = `scriptorium_admin_${port}=${TOKEN}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        } catch {
          // leave json null; a test asserting on it will fail loudly
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function jsonFor(siteTitle, backend) {
  return `${JSON.stringify(backend ? { siteTitle, backend } : { siteTitle }, null, 2)}\n`;
}

test('independently-computed slugify literals (never derived from the code under test)', () => {
  // Sanity-checks the literals every other test in this file types, and proves the facade's own
  // normalisation differs from a naive client-side reimplementation (T4's whole point).
  assert.equal(pinned.slugify('Old Campaign'), 'old-campaign');
  assert.equal(pinned.slugify('New Campaign'), 'new-campaign');
  assert.equal(pinned.slugify(ACCENTED_TITLE), ACCENTED_SLUG);
  const naive = (s) => s.toLowerCase().replace(/\s+/g, '-');
  assert.notEqual(naive(ACCENTED_TITLE), ACCENTED_SLUG);
});

test('flag off (no backend table) gives no campaignId key on a settings dry run', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign') });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New Campaign', baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(res.json, 'campaignId'), false);
  });
});

test('backend.statusBar true gives the campaignId key with typed literals', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign', { statusBar: true, inbox: false }) });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New Campaign', baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.campaignId, { before: 'old-campaign', after: 'new-campaign' });
  });
});

test('backend.inbox true gives the campaignId key with typed literals (statusBar can be absent)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign', { inbox: true }) });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New Campaign', baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.campaignId, { before: 'old-campaign', after: 'new-campaign' });
  });
});

test('an accented, apostrophe-bearing title round-trips through the real facade, not a naive reimplementation', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign', { statusBar: true }) });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: ACCENTED_TITLE, baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.campaignId, { before: 'old-campaign', after: ACCENTED_SLUG });
  });
});

test('backend.statusBar as the string "true" (not boolean) gives no campaignId key', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign', { statusBar: 'true' }) });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New Campaign', baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(res.json, 'campaignId'), false);
  });
});

test('flag on but a case-only title change (same slug) gives no campaignId key', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign', { statusBar: true }) });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'OLD CAMPAIGN', baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(pinned.slugify('OLD CAMPAIGN'), pinned.slugify('Old Campaign'), 'test premise: the two titles really do share a slug');
    assert.equal(Object.prototype.hasOwnProperty.call(res.json, 'campaignId'), false);
  });
});

test('the confirm (non-dry) body is byte-identical to the pre-existing shape: no campaignId key, ever', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign', { statusBar: true }) });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New Campaign', baseSha256 });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['file', 'ok', 'sha256', 'warnings'].sort());
  });
});

test('theme, vocab and slots dry-run bodies on the same fixture carry no campaignId key (the hook is scoped to settings only)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: jsonFor('Old Campaign', { statusBar: true }) });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const tomlSha = sha256(fs.readFileSync(tomlPath));

    const theme = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: tomlSha, dryRun: true });
    assert.equal(theme.status, 200);
    assert.deepEqual(Object.keys(theme.json).sort(), ['after', 'before', 'commentsLost', 'dryRun', 'file', 'ok', 'warnings'].sort());

    const vocab = await post(port, '/api/pack/vocab', { recaps: { learned_heading: 'What we learned' }, baseSha256: tomlSha, dryRun: true });
    assert.equal(vocab.status, 200);
    assert.deepEqual(Object.keys(vocab.json).sort(), ['after', 'before', 'commentsLost', 'dryRun', 'file', 'ok', 'warnings'].sort());

    const slots = await post(port, '/api/pack/slots', { slots: { hero: null }, baseSha256: tomlSha, dryRun: true });
    assert.equal(slots.status, 200);
    assert.deepEqual(Object.keys(slots.json).sort(), ['after', 'before', 'commentsLost', 'dryRun', 'file', 'ok', 'warnings'].sort());
  });
});
