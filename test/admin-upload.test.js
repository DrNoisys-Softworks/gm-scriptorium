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
const { validateUploadName } = require('../src/admin/uploadname');
const { ConfigError } = require('../src/util/errors');
const packwrite = require('../src/vault/packwrite');
const packfiles = require('../src/admin/packfiles');

/*
 * Phase 8 slice S5 (FR27; test-first order item 2). Real sockets through S1's exports, exactly
 * like test/admin-pack.test.js. Synthetic cast only (NFR-10/NFR-11); every vault is built fresh
 * in os.tmpdir(), never in test/fixtures. Uploads are a raw octet-stream body (SD-1), never
 * multipart.
 */

const TOKEN = 'admin-upload-test-token';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Same technique as test/pack-write.test.js:20-28's withPlatform (copied verbatim there), adapted
 * to await an async body: that fixture never needed to hold the forced platform across a real
 * socket round trip.
 * Restoring only after `fn`'s returned promise settles keeps process.platform forced for the
 * whole request/response cycle (this test process is single-threaded and each test runs
 * sequentially, so no other test's assertions ever run while the platform is forced).
 */
async function withPlatformAsync(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

async function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-upload-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A convention-pack vault by default. */
function writeVault(root, { toml = 'theme = "plain"\n' } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), toml);
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha' }, null, 2)}\n`);
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

/** A real raw-body POST over a real socket (SD-1: octet-stream, never multipart). */
function uploadRaw(
  port,
  name,
  bytes,
  { contentType = 'application/octet-stream', auth = true, origin, host, chunked = false, cookie } = {},
) {
  return new Promise((resolve, reject) => {
    const headers = {
      Host: host || `127.0.0.1:${port}`,
      Origin: origin || `http://127.0.0.1:${port}`,
    };
    if (contentType !== undefined) headers['Content-Type'] = contentType;
    if (!chunked) headers['Content-Length'] = String(bytes.length);
    if (auth) headers.Cookie = cookie || `scriptorium_admin_${port}=${TOKEN}`;
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: `/api/images/upload?name=${encodeURIComponent(name)}`, headers },
      (res) => {
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
      },
    );
    req.on('error', reject);
    req.write(bytes);
    req.end();
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: { Host: `127.0.0.1:${port}`, Cookie: `scriptorium_admin_${port}=${TOKEN}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try {
            json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
          } catch {
            // leave json null
          }
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function imagesDir(packDir) {
  return path.join(packDir, 'images');
}

/** Sorted top-level listing of images/, or [] when it does not exist. */
function listImages(packDir) {
  const dir = imagesDir(packDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

/** name -> sha256 for every regular file directly under images/ (flat only; uploads never nest). */
function hashImages(packDir) {
  const dir = imagesDir(packDir);
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out[name] = sha256(fs.readFileSync(full));
  }
  return out;
}

const A_PNG = Buffer.from('a-png-bytes');

// --- validateUploadName: the rule table, direct and independent of the HTTP layer -------------

test('validateUploadName: every rule, in order, with its exact message', () => {
  assert.throws(() => validateUploadName(undefined), (e) => e instanceof ConfigError && e.message === 'upload name is required');
  assert.throws(() => validateUploadName(''), (e) => e.message === 'upload name is required');
  assert.throws(() => validateUploadName(123), (e) => e.message === 'upload name is required');

  const long129 = `${'a'.repeat(125)}.png`; // 129 chars total
  assert.equal(long129.length, 129);
  assert.throws(() => validateUploadName(long129), (e) => e.message === 'upload name is longer than 128 characters');
  const exact128 = `${'a'.repeat(124)}.png`;
  assert.equal(exact128.length, 128);
  assert.equal(validateUploadName(exact128), exact128, '128 characters is accepted (positive control)');

  for (const bad of ['cr/est.png', 'cr\\est.png', 'cr<est.png', 'cr"est.png', 'cr|est.png', 'cr?est.png', 'cr*est.png', 'cr\u0001est.png', 'crest.png:hidden']) {
    assert.throws(
      () => validateUploadName(bad),
      (e) => e.message === `upload name "${bad}" contains a character that is not allowed in a file name`,
      bad,
    );
  }

  assert.throws(() => validateUploadName('.crest.png'), (e) => e.message === 'upload name must not start with a dot');
  assert.throws(() => validateUploadName('a..png'), (e) => e.message === 'upload name must not contain ".."');
  assert.throws(() => validateUploadName('crest.png.'), (e) => e.message === 'upload name must not end with a dot or a space');
  assert.throws(() => validateUploadName('crest.png '), (e) => e.message === 'upload name must not end with a dot or a space');

  for (const reserved of ['CON.png', 'nul.webp', 'com1.svg', 'AUX', 'aux.png', 'PRN.gif', 'lpt1.png']) {
    assert.throws(
      () => validateUploadName(reserved),
      (e) => e.message === `upload name "${reserved}" is a reserved Windows device name`,
      reserved,
    );
  }
  for (const ok of ['CONE.png', 'null.webp', 'com10.svg', 'lpt10.gif', 'console.png', 'icon.png']) {
    assert.equal(validateUploadName(ok), ok, `${ok} must be accepted (positive control)`);
  }

  assert.throws(() => validateUploadName('crest.md'), (e) => e.message === '.md files are never written into the campaign pack');
  assert.throws(() => validateUploadName('CREST.MD'), (e) => e.message === '.md files are never written into the campaign pack');

  assert.throws(
    () => validateUploadName('crest.exe'),
    (e) => e.message === 'upload name must end in .jpg, .jpeg, .png, .webp, .gif, .svg or .avif',
  );
});

// --- Real-pipeline name refusals, each paired with a positive control --------------------------

function refusalCase(label, name, expectedMessage) {
  test(`upload name refusal: ${label}`, async (t) => {
    await withScratchDir(async (root) => {
      const { vaultPath, packDir } = writeVault(root);
      const ctx = ctxFor(vaultPath);
      const port = await launch(t, ctx);
      const before = listImages(packDir);
      const beforeHashes = hashImages(packDir);

      const res = await uploadRaw(port, name, A_PNG);
      assert.equal(res.status, 400, label);
      assert.deepEqual(res.json, { error: 'invalid', message: expectedMessage }, label);
      assert.deepEqual(listImages(packDir), before, `${label}: the listing must be unchanged`);
      assert.deepEqual(hashImages(packDir), beforeHashes, `${label}: every file hash must be unchanged`);
    });
  });
}

function acceptedCase(label, name) {
  test(`upload name positive control: ${label}`, async (t) => {
    await withScratchDir(async (root) => {
      const { vaultPath, packDir } = writeVault(root);
      const ctx = ctxFor(vaultPath);
      const port = await launch(t, ctx);

      const res = await uploadRaw(port, name, A_PNG);
      assert.equal(res.status, 200, label);
      assert.equal(res.json.name, name);
      assert.equal(res.json.rel, `images/${name}`);
      assert.deepEqual(fs.readFileSync(path.join(imagesDir(packDir), name)), A_PNG);
    });
  });
}

// Reserved device names.
refusalCase('CON.png', 'CON.png', 'upload name "CON.png" is a reserved Windows device name');
acceptedCase('CONE.png (not a reserved name)', 'CONE.png');
refusalCase('nul.webp', 'nul.webp', 'upload name "nul.webp" is a reserved Windows device name');
acceptedCase('null.webp (not a reserved name)', 'null.webp');
refusalCase('com1.svg', 'com1.svg', 'upload name "com1.svg" is a reserved Windows device name');
acceptedCase('com10.svg: com[1-9] must be followed by "." or end, "0" breaks the match', 'com10.svg');
acceptedCase('console.png (not a reserved name)', 'console.png');
acceptedCase('icon.png (not a reserved name)', 'icon.png');

// Stream suffixes and trailing characters.
refusalCase('crest.png:hidden (ADS suffix)', 'crest.png:hidden', 'upload name "crest.png:hidden" contains a character that is not allowed in a file name');
refusalCase('crest.png. (trailing dot)', 'crest.png.', 'upload name must not end with a dot or a space');
refusalCase('crest.png  (trailing space)', 'crest.png ', 'upload name must not end with a dot or a space');
acceptedCase('crest.png (positive control for the trio above)', 'crest.png');

// Leading dot and "..".
refusalCase('.crest.png (leading dot)', '.crest.png', 'upload name must not start with a dot');
refusalCase('a..png (contains "..")', 'a..png', 'upload name must not contain ".."');
acceptedCase('a.b.png (positive control for a..png)', 'a.b.png');

// Separators and Windows-illegal characters.
for (const bad of ['cr/est.png', 'cr\\est.png', 'cr<est.png', 'cr"est.png', 'cr|est.png', 'cr?est.png', 'cr*est.png', 'cr\u0001est.png']) {
  refusalCase(`illegal character: ${JSON.stringify(bad)}`, bad, `upload name "${bad}" contains a character that is not allowed in a file name`);
}

// Extensions.
refusalCase('crest.md', 'crest.md', '.md files are never written into the campaign pack');
refusalCase('CREST.MD', 'CREST.MD', '.md files are never written into the campaign pack');
refusalCase('crest.exe', 'crest.exe', 'upload name must end in .jpg, .jpeg, .png, .webp, .gif, .svg or .avif');

// Length.
{
  const long129 = `${'b'.repeat(125)}.png`;
  const exact128 = `${'b'.repeat(124)}.png`;
  refusalCase('129-character name', long129, 'upload name is longer than 128 characters');
  acceptedCase('128-character name (positive control)', exact128);
}

// --- Size and body ------------------------------------------------------------------------------

test('size: exactly 10485760 bytes is accepted', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const bytes = Buffer.alloc(10485760, 7);

    const res = await uploadRaw(port, 'ok.png', bytes);
    assert.equal(res.status, 200);
    assert.equal(res.json.size, 10485760);
    assert.deepEqual(fs.readFileSync(path.join(imagesDir(packDir), 'ok.png')), bytes);
  });
});

test('size: 10485761 bytes with a Content-Length header gets 413, images/ untouched', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const bytes = Buffer.alloc(10485761, 7);

    const res = await uploadRaw(port, 'big.png', bytes);
    assert.equal(res.status, 413);
    assert.equal(res.raw.toString(), 'refused: too large');
    assert.equal(res.headers.connection, 'close');
    assert.deepEqual(listImages(packDir), []);
  });
});

test('size: 10485761 bytes sent chunked (no Content-Length) still gets 413 -- measured on received bytes, not a declared length', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const bytes = Buffer.alloc(10485761, 7);

    const res = await uploadRaw(port, 'big-chunked.png', bytes, { chunked: true });
    assert.equal(res.status, 413);
    assert.deepEqual(listImages(packDir), []);
  });
});

test('body: an empty body gets 400, images/ untouched', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'empty.png', Buffer.alloc(0));
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid', message: 'the upload is empty' });
    assert.deepEqual(listImages(packDir), []);
  });
});

test('body: the wrong Content-Type (text/plain) gets 400, and the check runs before the body is read (positive control: application/octet-stream succeeds)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const bad = await uploadRaw(port, 'wrongtype.png', A_PNG, { contentType: 'text/plain' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'invalid', message: 'uploads must be sent as application/octet-stream' });
    assert.deepEqual(listImages(packDir), []);

    const good = await uploadRaw(port, 'righttype.png', A_PNG);
    assert.equal(good.status, 200);
  });
});

// --- Collisions ------------------------------------------------------------------------------

test('collision: a second upload of the same name gets 409, and the original bytes are unchanged', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const first = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(first.status, 200);

    const second = await uploadRaw(port, 'crest.png', Buffer.from('different-bytes'));
    assert.equal(second.status, 409);
    assert.deepEqual(second.json, { error: 'exists', message: 'images/crest.png already exists; uploads never replace a file' });
    assert.deepEqual(fs.readFileSync(path.join(imagesDir(packDir), 'crest.png')), A_PNG);
  });
});

test('collision: Crest.PNG after crest.png gets 409 on win32 (folded)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    await withPlatformAsync('win32', async () => {
      const first = await uploadRaw(port, 'crest.png', A_PNG);
      assert.equal(first.status, 200);
      const second = await uploadRaw(port, 'Crest.PNG', Buffer.from('other'));
      assert.equal(second.status, 409, 'win32 folds case, so Crest.PNG collides with crest.png');
    });
  });
});

// withPlatformAsync changes what process.platform reports, not how the disk behaves. On a volume
// that folds case itself (the macOS default, and Windows), crest.png and Crest.PNG are one file
// whatever the platform string says, so the "no fold" control below can only run where the scratch
// directory's own filesystem is case-sensitive.
function scratchFsFoldsCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-casefold-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '');
    return fs.existsSync(path.join(dir, 'PROBE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const FOLDING_FS_SKIP = scratchFsFoldsCase() && 'the scratch filesystem folds case, so two names differing only in case cannot coexist here';

test('collision: Crest.PNG after crest.png is accepted on linux (positive control, no fold)', { skip: FOLDING_FS_SKIP }, async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    await withPlatformAsync('linux', async () => {
      const first = await uploadRaw(port, 'crest.png', A_PNG);
      assert.equal(first.status, 200);
      const second = await uploadRaw(port, 'Crest.PNG', Buffer.from('other'));
      assert.equal(second.status, 200, 'linux does not fold case');
      assert.deepEqual(listImages(packDir), ['Crest.PNG', 'crest.png']);
    });
  });
});

test('collision: string-prefix sibling positive control -- with crest.png.old.webp present, crest.png is accepted', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    fs.mkdirSync(imagesDir(packDir), { recursive: true });
    fs.writeFileSync(path.join(imagesDir(packDir), 'crest.png.old.webp'), 'existing');
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 200, 'crest.png must not collide with crest.png.old.webp');
    assert.deepEqual(fs.readFileSync(path.join(imagesDir(packDir), 'crest.png')), A_PNG);
  });
});

// --- SD-4 folder rules (real symlinks) ----------------------------------------------------------

function trySymlink(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
      return false;
    }
    throw err;
  }
}

test('SD-4: images linked to the vault root (an ancestor) gets 400, vault root listing unchanged', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    if (!trySymlink(t, vaultPath, imagesDir(packDir))) return;
    const before = fs.readdirSync(vaultPath).sort();
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid', message: 'images/ in the campaign pack must be a real folder, not a link' });
    assert.deepEqual(fs.readdirSync(vaultPath).sort(), before);
  });
});

test('SD-4: images linked to _meta (an ancestor) gets 400, _meta listing unchanged', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const metaDir = path.join(vaultPath, '_meta');
    if (!trySymlink(t, metaDir, imagesDir(packDir))) return;
    const before = fs.readdirSync(metaDir).sort();
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid', message: 'images/ in the campaign pack must be a real folder, not a link' });
    assert.deepEqual(fs.readdirSync(metaDir).sort(), before);
  });
});

test('SD-4: images linked outside the vault gets 400, target listing unchanged', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'x');
    if (!trySymlink(t, outside, imagesDir(packDir))) return;
    const before = fs.readdirSync(outside).sort();
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid', message: 'images/ in the campaign pack must be a real folder, not a link' });
    assert.deepEqual(fs.readdirSync(outside).sort(), before);
  });
});

test('SD-4: images linked to a prefix-named sibling (images-real) inside the pack gets 400, sibling listing unchanged', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const sibling = path.join(packDir, 'images-real');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'sentinel.webp'), 'x');
    if (!trySymlink(t, sibling, imagesDir(packDir))) return;
    const before = fs.readdirSync(sibling).sort();
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 400, 'a startsWith-based check would wrongly accept "images-real"');
    assert.deepEqual(res.json, { error: 'invalid', message: 'images/ in the campaign pack must be a real folder, not a link' });
    assert.deepEqual(fs.readdirSync(sibling).sort(), before);
  });
});

test('SD-4 positive control: a real images/ folder is accepted', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    fs.mkdirSync(imagesDir(packDir));
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 200);
  });
});

test('SD-4 positive control: no images/ folder at all is accepted, and the folder is created', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    assert.equal(fs.existsSync(imagesDir(packDir)), false);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 200);
    assert.equal(fs.statSync(imagesDir(packDir)).isDirectory(), true);
  });
});

// --- EEXIST backstop ------------------------------------------------------------------------

test('EEXIST backstop: a ConfigError after the target already exists on disk maps to 409, and the patch is proven called', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const target = path.join(imagesDir(packDir), 'race.png');

    let calls = 0;
    const original = packwrite.createPackEntries;
    packwrite.createPackEntries = (...args) => {
      calls += 1;
      fs.mkdirSync(imagesDir(packDir), { recursive: true });
      fs.writeFileSync(target, 'raced-in-bytes');
      throw new ConfigError(`refusing to overwrite ${target}: it already exists`);
    };
    let res;
    try {
      res = await uploadRaw(port, 'race.png', A_PNG);
    } finally {
      packwrite.createPackEntries = original;
    }
    assert.equal(calls, 1, 'the patch must have been called');
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'exists', message: 'images/race.png already exists; uploads never replace a file' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'raced-in-bytes', "the race winner's bytes must survive");
  });
});

test('EEXIST backstop: the same ConfigError with no file on disk maps to 400, and the patch is proven called', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    let calls = 0;
    const original = packwrite.createPackEntries;
    packwrite.createPackEntries = () => {
      calls += 1;
      throw new ConfigError('refusing to write the campaign pack: some other containment refusal');
    };
    let res;
    try {
      res = await uploadRaw(port, 'other.png', A_PNG);
    } finally {
      packwrite.createPackEntries = original;
    }
    assert.equal(calls, 1, 'the patch must have been called');
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid');
    assert.equal(fs.existsSync(path.join(imagesDir(packDir), 'other.png')), false);
  });
});

// --- admin-fix-1 item 4: two uncovered error branches (NFR09) --------------

test('createPackEntries generic I/O backstop: a non-ConfigError from the write chokepoint maps to 503 "io", and the patch is proven called', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    let calls = 0;
    const original = packwrite.createPackEntries;
    packwrite.createPackEntries = () => {
      calls += 1;
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    };
    let res;
    try {
      res = await uploadRaw(port, 'crest.png', A_PNG);
    } finally {
      packwrite.createPackEntries = original;
    }
    assert.equal(calls, 1, 'the patch must have been called');
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: 'io', message: 'ENOSPC: no space left on device' });
    assert.equal(fs.existsSync(path.join(imagesDir(packDir), 'crest.png')), false);
  });
});

test('re-throw of a non-UploadRefusal error: an unexpected failure after the write chokepoint propagates to a clean 500, not an upload-shaped response', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    // packfiles.sha256Hex runs AFTER performUpload's own try/catch (it computes the response
    // body's sha256 once the write has already succeeded), so a failure here is not one of the
    // handler's own decided refusals -- it must propagate, not be reshaped into an UploadRefusal.
    const original = packfiles.sha256Hex;
    let calls = 0;
    packfiles.sha256Hex = () => {
      calls += 1;
      throw new Error('boom: unexpected bug');
    };
    let res;
    try {
      res = await uploadRaw(port, 'crest.png', A_PNG);
    } finally {
      packfiles.sha256Hex = original;
    }
    assert.equal(calls, 1, 'the patch must have been called');
    assert.equal(res.status, 500);
    assert.equal(res.raw.toString('utf8'), 'internal error');
    // The file itself was already written by createPackEntries before the patched call threw, so
    // this failure is specifically "the response never got built", not "nothing was written" --
    // recorded here rather than asserted as a refusal, since re-throw is a programming-error path.
    assert.equal(fs.existsSync(path.join(imagesDir(packDir), 'crest.png')), true);
  });
});

// --- FR05, FR31 and gate pairs ------------------------------------------------------------------

test('FR05: a site_config campaign is read-only, 403 with the exact reason (positive control: convention is writable)', async (t) => {
  await withScratchDir(async (root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    const siteConfigPath = path.join(root, 'site.json');
    fs.writeFileSync(siteConfigPath, `${JSON.stringify({ siteTitle: 'X' }, null, 2)}\n`);
    const ctx = ctxFor(vaultPath, { site_config: siteConfigPath });
    const port = await launch(t, ctx);

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, {
      error: 'read-only',
      message:
        'This campaign builds from a site_config file, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.',
    });
  });
});

test('FR31: an upload while ctx.busy is already set gets 409 busy, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    ctx.busy = 'build';

    const res = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'busy', busy: 'build' });
    assert.deepEqual(listImages(packDir), []);
  });
});

test('gate pair: a foreign Origin against the admin Origin', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const foreign = await uploadRaw(port, 'crest.png', A_PNG, { origin: 'http://evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.raw.toString(), 'refused: origin');
    assert.deepEqual(listImages(packDir), []);

    const same = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(same.status, 200);
  });
});

test('gate pair: no cookie against the cookie', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const noCookie = await uploadRaw(port, 'crest.png', A_PNG, { auth: false });
    assert.equal(noCookie.status, 403);
    assert.equal(noCookie.raw.toString(), 'refused: token');
    assert.deepEqual(listImages(packDir), []);

    const withCookie = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(withCookie.status, 200);
  });
});

// --- End to end -----------------------------------------------------------------------------

test('end to end: an accepted upload is listed in /api/state.images, and /api/image?name= returns the exact bytes', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const upload = await uploadRaw(port, 'crest.png', A_PNG);
    assert.equal(upload.status, 200);
    assert.equal(upload.json.sha256, sha256(A_PNG));

    const state = await getJson(port, '/api/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.json.images, ['crest.png']);

    const image = await getJson(port, '/api/image?name=crest.png');
    assert.equal(image.status, 200);
    assert.deepEqual(image.raw, A_PNG);
  });
});
