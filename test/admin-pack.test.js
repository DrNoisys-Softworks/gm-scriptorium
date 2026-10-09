'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./helpers/toml-plain');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const TOML = require('smol-toml');

const { startLocalListener } = require('../src/serve/server');
const { createAdminHandler } = require('../src/admin/router');
const { createAdminContext } = require('../src/admin/context');
const { resolveVaultSite, parsePackConfigText } = require('../src/cli/check');
const { ConfigError } = require('../src/util/errors');
const packwrite = require('../src/vault/packwrite');

/*
 * Phase 8 slice S3 (test-first order items 3 and 4). Real sockets through S1's exports
 * (createAdminHandler, createAdminContext, startLocalListener); /api/state is not needed since
 * this file only exercises POST /api/pack/theme and POST /api/pack/settings directly. Synthetic
 * cast only (NFR-10/NFR-11); every vault is built fresh in os.tmpdir(), never in test/fixtures.
 *
 * "../" and an arbitrary target name are NOT exercised here: the admin API never lets a client
 * name the file it writes (name is fixed server-side to 'pack.toml' or 'vault.config.json'), so
 * those escapes are only reachable at src/vault/packreplace.js's own layer, where
 * test/pack-replace.test.js already covers them through the real chokepoint. What IS reachable
 * through the HTTP path is a vault whose pack.toml is ALREADY a symlink/hard link/directory
 * before the request arrives, which is exercised below.
 */

const TOKEN = 'admin-pack-test-token';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-pack-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A convention-pack vault by default; pass writeToml:false for the FR22 "missing pack.toml" case. */
function writeVault(root, { toml = 'theme = "plain"\n', json, writeToml = true, writeJson = true } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  if (writeToml) fs.writeFileSync(path.join(packDir, 'pack.toml'), toml);
  if (writeJson) fs.writeFileSync(path.join(packDir, 'vault.config.json'), json ?? `${JSON.stringify({ siteTitle: 'Alpha' }, null, 2)}\n`);
  return { vaultPath, packDir };
}

function ctxFor(vaultPath, extra = {}) {
  const ctxInfo = { campaign: 'alpha', vault: vaultPath, ...extra };
  const { site } = resolveVaultSite(ctxInfo);
  return createAdminContext({ ctxInfo, vaultPath, site, token: TOKEN });
}

/** Starts a real admin listener bound to ctx; t.after() force-closes it (Lesson 4). */
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

/** A real POST over a real socket, with a valid Host/Origin/Cookie by default. */
function post(port, urlPath, obj, { auth = true, origin, host } = {}) {
  const bodyBuf = Buffer.from(JSON.stringify(obj));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': String(bodyBuf.length),
    Host: host || `127.0.0.1:${port}`,
    Origin: origin || `http://127.0.0.1:${port}`,
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
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// --- FR17: optimistic concurrency ------------------------------------------

test('FR17: a change to the on-disk file after the sha was taken gives 409 changed, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));
    fs.writeFileSync(tomlPath, 'theme = "external"\n');

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' });
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "external"\n');
  });
});

test('FR17 positive control: the same request with a matching sha succeeds', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

// --- FR18: saves start from raw bytes re-read at save time -----------------

test('FR18a: a title save on a pack with no vaultPath key adds no vaultPath key', async (t) => {
  await withScratchDir(async (root) => {
    const json = `${JSON.stringify({ siteTitle: 'Old' }, null, 2)}\n`;
    const { vaultPath, packDir } = writeVault(root, { json });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New Title', baseSha256 });
    assert.equal(res.status, 200);
    const onDisk = fs.readFileSync(jsonPath, 'utf8');
    assert.equal(onDisk, `${JSON.stringify({ siteTitle: 'New Title' }, null, 2)}\n`);
    assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(onDisk), 'vaultPath'));
  });
});

test('FR18b: a relative vaultPath and outputDir stay byte-unchanged across a settings save', async (t) => {
  await withScratchDir(async (root) => {
    const json = `${JSON.stringify({ siteTitle: 'Old', vaultPath: '../..', outputDir: './out' }, null, 2)}\n`;
    const { vaultPath, packDir } = writeVault(root, { json });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New Title', baseSha256 });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(parsed.vaultPath, '../..');
    assert.equal(parsed.outputDir, './out');
  });
});

test('FR18c: a theme save on theme = "plain"\\n gives exactly theme = "haze"\\n, no tables added', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

// --- FR19: validate before writing -----------------------------------------

test('FR19: an on-disk absolute image path gives 422 with the exact parsePackToml message, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const toml = 'theme = "plain"\n\n[images]\nground = "/abs.webp"\n';
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(res.status, 422);
    const expected = `campaign "alpha": ${tomlPath}: [images] ground = "/abs.webp" is an absolute path; write "vault:<path inside the vault>" or a path relative to ${packDir}`;
    assert.deepEqual(res.json, { error: 'invalid-on-disk', message: expected });
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), toml);
  });
});

// --- FR20: preservation -----------------------------------------------------

test('FR20: an unrecognised TOML key and table survive a theme save (compared via TOML.parse)', async (t) => {
  await withScratchDir(async (root) => {
    const toml = 'theme = "plain"\nfuture_key = 1\n\n[future_table]\nx = "y"\n';
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(res.status, 200);
    const parsed = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.equal(parsed.theme, 'haze');
    assert.equal(parsed.future_key, 1);
    assert.deepEqual(plain(parsed.future_table), { x: 'y' });
  });
});

test('FR20: an unrecognised JSON key survives a settings save', async (t) => {
  await withScratchDir(async (root) => {
    // Hand-written, deliberately not what JSON.stringify(..., null, 2) would ever produce
    // (futureKey first, irregular indentation and spacing around colons/braces), so the
    // byte-preservation claim below does not rest on the test's own fixture having been built
    // with the product's own serialiser.
    const json = '{\n  "futureKey":   { "a" : 1 },\n"siteTitle": "Old"\n}\n';
    const { vaultPath, packDir } = writeVault(root, { json });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New', baseSha256 });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(parsed.futureKey, { a: 1 });
  });
});

// --- FR21: an invalid on-disk file cannot be edited -------------------------

test('FR21: invalid on-disk JSON gives 422, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { json: '{not valid json' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const before = fs.readFileSync(jsonPath);

    const res = await post(port, '/api/pack/settings', { siteTitle: 'New', baseSha256: sha256(before) });
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'invalid-on-disk');
    assert.deepEqual(fs.readFileSync(jsonPath), before);
  });
});

// --- FR22: creating a missing pack.toml -------------------------------------

test('FR22: creating a missing pack.toml with baseSha256 null gives exactly theme = "haze"\\n; a second create gives 409', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { writeToml: false });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    assert.equal(fs.existsSync(tomlPath), false);

    const res1 = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: null });
    assert.equal(res1.status, 200);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');

    const res2 = await post(port, '/api/pack/theme', { theme: 'plain', baseSha256: null });
    assert.equal(res2.status, 409);
    assert.equal(res2.json.error, 'changed');
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n', 'the first create must not be clobbered');
  });
});

// FR22's real race window (M16): pack.toml appears between readPackFile's existence check and
// createPackEntries's own `wx` write, inside the SAME request. A sequential second HTTP request
// (the test above) never reaches this branch at all -- it is refused earlier, by the ordinary
// baseSha256-null-on-an-existing-file check -- so createPackEntries is patched here (through the
// module object; see the doc comment on its require in src/admin/handlers/pack.js) to simulate
// the race deterministically.
test('FR22 race: pack.toml appearing between the read and the write maps to 409 changed when it now exists', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { writeToml: false });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');

    const original = packwrite.createPackEntries;
    packwrite.createPackEntries = () => {
      // Simulate another writer's wx create having already landed.
      fs.writeFileSync(tomlPath, 'theme = "plain"\n');
      throw new ConfigError(`refusing to overwrite ${tomlPath}: it already exists`);
    };
    let res;
    try {
      res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: null });
    } finally {
      packwrite.createPackEntries = original;
    }

    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' });
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n', "the race winner's bytes must survive");
  });
});

test('FR22 race: a wx failure that is NOT a same-name collision maps to 400, not a 500 (positive control: the case above maps to 409)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { writeToml: false });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');

    const original = packwrite.createPackEntries;
    packwrite.createPackEntries = () => {
      // The file still does not exist: some other refusal (not a collision) is what threw.
      throw new ConfigError('refusing to write the campaign pack: some other containment refusal');
    };
    let res;
    try {
      res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: null });
    } finally {
      packwrite.createPackEntries = original;
    }

    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid');
    assert.equal(fs.existsSync(tomlPath), false);
  });
});

// --- Body shape: unknown keys, own mutation beyond the brief's table --------

test('an unknown key in the theme body gives 400, and nothing is written (positive control: the same body without it succeeds)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const bad = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256, extra: 'nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'invalid', message: 'unknown field: extra' });
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');

    const good = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(good.status, 200);
  });
});

test('a settings save with no siteTitle gives 400 with the exact message (V1e-1: landingTagline is no longer an allowed field)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const baseSha256 = sha256(fs.readFileSync(jsonPath));

    const res = await post(port, '/api/pack/settings', { baseSha256 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid', message: 'at least one of siteTitle must be present' });
  });
});

// --- FR23 / FR24: field validation -------------------------------------------

test('FR23: an unknown theme gives 400 with validateTheme\'s exact message', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');

    const res = await post(port, '/api/pack/theme', { theme: 'nonexistent', baseSha256: sha256(fs.readFileSync(tomlPath)) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid', message: 'unknown theme "nonexistent"; valid themes: gloam, haze, plain' });
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

test('FR24: a blank title gives 400 with the exact message; landingTagline is refused as an unknown field (V1e-1, D-20) and the file is unchanged', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const jsonPath = path.join(packDir, 'vault.config.json');
    const before = fs.readFileSync(jsonPath, 'utf8');

    const bad = await post(port, '/api/pack/settings', { siteTitle: '   ', baseSha256: sha256(fs.readFileSync(jsonPath)) });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'invalid', message: 'site title must be one non-empty line' });

    const rejected = await post(port, '/api/pack/settings', { landingTagline: '', baseSha256: sha256(fs.readFileSync(jsonPath)) });
    assert.equal(rejected.status, 400);
    assert.deepEqual(rejected.json, { error: 'invalid', message: 'unknown field: landingTagline' });
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), before);
  });
});

// --- D06: dry run -------------------------------------------------------------

test('D06: dryRun leaves the hash unchanged, and commentsLost is true for a commented on-disk pack.toml', async (t) => {
  await withScratchDir(async (root) => {
    const toml = '# note\ntheme = "plain"\n';
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    const baseSha256 = sha256(before);

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.dryRun, true);
    assert.equal(res.json.file, 'pack.toml');
    assert.equal(res.json.before, before.toString('utf8'));
    assert.equal(res.json.commentsLost, true);
    assert.deepEqual(fs.readFileSync(tomlPath), before, 'a dry run must not write');
    assert.equal(sha256(fs.readFileSync(tomlPath)), baseSha256);
  });
});

test('D06: commentsLost is false for an on-disk pack.toml with no comment (positive control)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.commentsLost, false);
  });
});

// --- FR05: writable only for a convention pack -------------------------------

test('FR05: a site_config campaign is read-only, 403 with the exact reason', async (t) => {
  await withScratchDir(async (root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    const siteConfigPath = path.join(root, 'site.json');
    fs.writeFileSync(siteConfigPath, `${JSON.stringify({ siteTitle: 'X' }, null, 2)}\n`);

    const ctx = ctxFor(vaultPath, { site_config: siteConfigPath });
    const port = await launch(t, ctx);
    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: null });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, {
      error: 'read-only',
      message:
        'This campaign builds from a site_config file, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.',
    });
  });
});

test('FR05: a pack-key campaign is read-only, 403 with the exact reason', async (t) => {
  await withScratchDir(async (root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    const packKeyDir = path.join(root, 'external-pack');
    fs.mkdirSync(packKeyDir, { recursive: true });
    fs.writeFileSync(path.join(packKeyDir, 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Y' }, null, 2)}\n`);

    const ctx = ctxFor(vaultPath, { pack: packKeyDir });
    const port = await launch(t, ctx);
    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: null });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, {
      error: 'read-only',
      message:
        "This campaign's pack key points at a folder of its own, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.",
    });
  });
});

test('FR05 positive control: a convention campaign is writable', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    assert.equal(ctx.writable, true);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: sha256(fs.readFileSync(tomlPath)) });
    assert.equal(res.status, 200);
  });
});

// --- FR31: the write mutex -----------------------------------------------------

test('FR31: a save while ctx.busy is already set gets 409 busy, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    ctx.busy = 'build';

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256: sha256(before) });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'busy', busy: 'build' });
    assert.deepEqual(fs.readFileSync(tomlPath), before);
  });
});

// --- Real-pipeline refusals (Lesson 2): symlink, hard link, EBUSY -------------
//
// "../" and an arbitrary target name are unit-tested at src/vault/packreplace.js's own layer
// (test/pack-replace.test.js): the admin API never lets a client name the file it writes.

test('real pipeline: a symlinked pack.toml already on disk is refused through the actual HTTP save path (503 io), unchanged', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const outsideFile = path.join(root, 'outside.toml');
    fs.writeFileSync(outsideFile, 'theme = "plain"\n');
    fs.unlinkSync(tomlPath);
    fs.symlinkSync(outsideFile, tomlPath);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const baseSha256 = sha256(fs.readFileSync(outsideFile));
    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'io');
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'theme = "plain"\n');
  });
});

test('real pipeline: a hard link to pack.toml keeps the old bytes after a real HTTP theme save (positive control for the symlink refusal above)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const linkPath = path.join(root, 'linked.toml');
    fs.linkSync(tomlPath, linkPath);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'theme = "plain"\n', "the other hard link's bytes must be unchanged");
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

test('real pipeline: an injected EBUSY on rename is retried and the real HTTP save still succeeds', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const originalRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      }
      return originalRename(from, to);
    };
    let res;
    try {
      res = await post(port, '/api/pack/theme', { theme: 'haze', baseSha256 });
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(res.status, 200);
    assert.ok(calls >= 2, 'the rename must have been retried at least once');
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

// --- parsePackConfigText, direct (test-first order item 4) --------------------

test('parsePackConfigText: invalid JSON gives the exact "not valid JSON" message', () => {
  assert.throws(
    () => parsePackConfigText('{not json', '/p/vault.config.json', 'alpha'),
    (err) => err instanceof ConfigError && /^campaign "alpha": \/p\/vault\.config\.json is not valid JSON: /.test(err.message),
  );
});

test('parsePackConfigText: a JSON array gives the exact "must contain a JSON object" message', () => {
  assert.throws(
    () => parsePackConfigText('[]', '/p/vault.config.json', 'alpha'),
    (err) => err instanceof ConfigError && err.message === 'campaign "alpha": /p/vault.config.json must contain a JSON object',
  );
});

test('parsePackConfigText: JSON null gives the exact "must contain a JSON object" message', () => {
  assert.throws(
    () => parsePackConfigText('null', '/p/vault.config.json', 'alpha'),
    (err) => err instanceof ConfigError && err.message === 'campaign "alpha": /p/vault.config.json must contain a JSON object',
  );
});

test('parsePackConfigText positive control: a plain object parses with no throw', () => {
  const result = parsePackConfigText('{"siteTitle":"X"}', '/p/vault.config.json', 'alpha');
  assert.equal(result.siteTitle, 'X');
});
