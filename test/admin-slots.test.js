'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./helpers/toml-plain');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const TOML = require('smol-toml');

const { startLocalListener } = require('../src/serve/server');
const { createAdminHandler } = require('../src/admin/router');
const { createAdminContext } = require('../src/admin/context');
const { resolveVaultSite } = require('../src/cli/check');
const { SLOT_NAMES } = require('../src/build/themes');
const { ConfigError } = require('../src/util/errors');

/*
 * Phase 8 slice S5 (FR26; test-first order item 3). Real sockets, exactly like
 * test/admin-pack.test.js and test/admin-upload.test.js. Synthetic cast only (NFR-10/NFR-11);
 * every vault is built fresh in os.tmpdir(), never in test/fixtures. "Parity with build" cases
 * spawn the real bin/scriptorium.js CLI and compare its first stderr line to the panel's message
 * byte-for-byte, so the two validation paths are proven to actually agree, not merely both tested.
 */

const TOKEN = 'admin-slots-test-token';
const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const CAMPAIGN = 'alpha';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-slots-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A convention-pack vault by default. `json` lets a case add excludeDirs etc. */
function writeVault(root, { toml = 'theme = "plain"\n', json } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), toml);
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    json ?? `${JSON.stringify({ siteTitle: 'Alpha', excludeDirs: [], folderMap: {} }, null, 2)}\n`,
  );
  return { vaultPath, packDir };
}

function ctxFor(vaultPath, extra = {}) {
  const ctxInfo = { campaign: CAMPAIGN, vault: vaultPath, ...extra };
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

/** Runs the real CLI build against `vaultPath`; returns its first stderr line (trimmed). */
function buildFirstStderrLine(root, vaultPath, campaign = CAMPAIGN) {
  const outDir = path.join(root, `build-out-${crypto.randomBytes(4).toString('hex')}`);
  const configPath = path.join(root, `build-config-${crypto.randomBytes(4).toString('hex')}.toml`);
  fs.writeFileSync(
    configPath,
    ['config_version = 1', `default_campaign = "${campaign}"`, '', `[campaigns.${campaign}]`, `vault = '${vaultPath}'`, `output = '${outDir}'`, ''].join(
      '\n',
    ),
  );
  const res = spawnSync(process.execPath, [BIN, 'build', campaign, '--no-check', '--config', configPath, '--out', outDir], { encoding: 'utf8' });
  const stderr = (res.stderr || '').trim();
  return stderr.split('\n')[0];
}

// --- validateSlotEdits / editPackTomlSlots: pure, direct ----------------------------------------

const { validateSlotEdits, editPackTomlSlots } = require('../src/admin/handlers/images');

test('validateSlotEdits: shape refusals, exact messages', () => {
  assert.throws(() => validateSlotEdits([]), (e) => e instanceof ConfigError && e.message === 'slots must be a table of slot names');
  assert.throws(() => validateSlotEdits(''), (e) => e.message === 'slots must be a table of slot names');
  assert.throws(() => validateSlotEdits(null), (e) => e.message === 'slots must be a table of slot names');
  assert.throws(
    () => validateSlotEdits({ bogus: 'images/x.webp' }),
    (e) => e.message === 'unknown slot "bogus"; slots are hero, ground, paper, crest-frame, portrait, 404',
  );
  assert.throws(() => validateSlotEdits({ hero: '' }), (e) => e.message === 'slot "hero" must be a non-empty path or null');
  assert.throws(() => validateSlotEdits({ hero: 123 }), (e) => e.message === 'slot "hero" must be a non-empty path or null');
  assert.throws(() => validateSlotEdits({ hero: 'x'.repeat(1025) }), (e) => e.message === 'slot "hero" must be a non-empty path or null');
  assert.throws(
    () => validateSlotEdits(JSON.parse('{"__proto__":"images/x.webp"}')),
    (e) => e.message === 'the key "__proto__" is not allowed',
  );

  assert.deepEqual(validateSlotEdits({ hero: 'images/hero.webp', ground: null }), { hero: 'images/hero.webp', ground: null });
  assert.equal(validateSlotEdits({ hero: 'x'.repeat(1024) }).hero.length, 1024, '1024 characters is accepted (positive control)');
});

test('editPackTomlSlots: sets a slot, keeps other tables; clears down to an exact literal, never an empty [images] table', () => {
  const withOther = 'theme = "plain"\n\n[labels]\nchapter = "Chapter"\n';
  const set = editPackTomlSlots(withOther, { hero: 'images/hero.webp' });
  const parsedSet = TOML.parse(set);
  assert.equal(parsedSet.images.hero, 'images/hero.webp');
  assert.deepEqual(plain(parsedSet.labels), { chapter: 'Chapter' });

  const onlyHero = 'theme = "plain"\n\n[images]\nhero = "images/hero.webp"\n';
  const cleared = editPackTomlSlots(onlyHero, { hero: null });
  assert.equal(cleared, 'theme = "plain"\n', 'clearing the only slot must leave the file with no [images] table at all');

  const unknownSurvives = 'theme = "plain"\n\n[images]\nhero = "images/hero.webp"\nlegacy-slot = "images/x.webp"\n';
  const editedGround = editPackTomlSlots(unknownSurvives, { hero: null });
  const parsedGround = TOML.parse(editedGround);
  assert.equal(parsedGround.images['legacy-slot'], 'images/x.webp', 'an unrecognised on-disk slot key must survive');
  assert.equal(Object.prototype.hasOwnProperty.call(parsedGround.images, 'hero'), false);
});

// --- Set / clear / clearing a broken slot (real HTTP) --------------------------------------------

test('set: slots: { hero: ... } gives 200; TOML.parse(file).images.hero has that value, and other tables survive', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n\n[labels]\nchapter = "Chapter"\n' });
    fs.mkdirSync(path.join(packDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'images', 'hero.webp'), 'hero-bytes');
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/slots', { slots: { hero: 'images/hero.webp' }, baseSha256 });
    assert.equal(res.status, 200);
    const parsed = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.equal(parsed.images.hero, 'images/hero.webp');
    assert.deepEqual(plain(parsed.labels), { chapter: 'Chapter' });
  });
});

test('clear: slots: { hero: null } on a file where [images] holds only hero leaves exactly theme = "plain"\\n', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n\n[images]\nhero = "images/hero.webp"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/slots', { slots: { hero: null }, baseSha256 });
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

test('clearing a broken slot: an on-disk missing-file slot can still be cleared (proves the hook runs on the candidate only)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n\n[images]\nground = "images/missing.webp"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/slots', { slots: { ground: null }, baseSha256 });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

test('M6 positive control: setting a NEW broken slot is refused (the hook runs on the candidate)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/slots', { slots: { ground: 'images/missing.webp' }, baseSha256 });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid');
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

// --- Parity with build ----------------------------------------------------------------------

async function parityCase(t, label, { setup, rawValue, expectMessage }) {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, setup ? setup.json : undefined);
    if (setup && setup.files) setup.files({ vaultPath, packDir, root });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    const baseSha256 = sha256(before);
    const T = tomlPath;
    const D = packDir;

    const res = await post(port, '/api/pack/slots', { slots: { ground: rawValue }, baseSha256 });
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.json)}`);
    assert.deepEqual(fs.readFileSync(tomlPath), before, `${label}: the hash must be unchanged`);

    const expected = expectMessage({ T, D, vaultPath, packDir });
    assert.equal(res.json.message, expected, label);

    // Hand-write the same candidate directly, then prove build refuses with the identical
    // first stderr line -- the parity oracle, independent of the literal computed above.
    fs.writeFileSync(tomlPath, `theme = "plain"\n\n[images]\nground = "${rawValue}"\n`);
    const stderrLine = buildFirstStderrLine(root, vaultPath);
    assert.equal(stderrLine, expected, `${label}: build's first stderr line must equal the panel's message`);
  });
}

test('parity: missing file', async (t) => {
  await parityCase(t, 'missing file', {
    rawValue: 'vault:missing.webp',
    expectMessage: ({ T, vaultPath }) =>
      `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:missing.webp" does not exist: ${path.join(vaultPath, 'missing.webp')}`,
  });
});

test('parity: vault:_meta/x.webp', async (t) => {
  await parityCase(t, 'vault:_meta/x.webp', {
    rawValue: 'vault:_meta/x.webp',
    expectMessage: ({ T, D }) =>
      `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:_meta/x.webp" points into _meta/; put the image in ${D} and write its path relative to that folder instead`,
  });
});

test('parity: vault:../x.webp', async (t) => {
  await parityCase(t, 'vault:../x.webp', {
    rawValue: 'vault:../x.webp',
    expectMessage: ({ T, D }) =>
      `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:../x.webp" contains ".."; write "vault:<path inside the vault>" or a path relative to ${D}`,
  });
});

test('parity: vault:Secret/x.webp with excludeDirs: [Secret]', async (t) => {
  await parityCase(t, 'excluded dir', {
    setup: {
      json: { json: `${JSON.stringify({ siteTitle: 'Alpha', excludeDirs: ['Secret'], folderMap: {} }, null, 2)}\n` },
      files: ({ vaultPath }) => {
        fs.mkdirSync(path.join(vaultPath, 'Secret'), { recursive: true });
        fs.writeFileSync(path.join(vaultPath, 'Secret', 'x.webp'), 'x');
      },
    },
    rawValue: 'vault:Secret/x.webp',
    expectMessage: ({ T }) =>
      `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:Secret/x.webp" is under excluded directory "Secret"; images from excluded or hidden folders are never published`,
  });
});

test('parity: a .txt file', async (t) => {
  await parityCase(t, '.txt file', {
    setup: { files: ({ vaultPath }) => fs.writeFileSync(path.join(vaultPath, 'notimage.txt'), 'x') },
    rawValue: 'vault:notimage.txt',
    expectMessage: ({ T }) =>
      `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:notimage.txt" is not an allowed image type (jpg, jpeg, png, webp, gif, svg, avif)`,
  });
});

test('parity: an 11 MiB file', async (t) => {
  await parityCase(t, '11 MiB file', {
    setup: { files: ({ vaultPath }) => fs.writeFileSync(path.join(vaultPath, 'big.webp'), Buffer.alloc(11 * 1024 * 1024)) },
    rawValue: 'vault:big.webp',
    expectMessage: ({ T }) =>
      `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:big.webp" is ${11 * 1024 * 1024} bytes, over the 10 MiB (10485760-byte) limit`,
  });
});

test('parity: vault:link.webp, a symlink to a file in the vault\'s parent directory (ancestor side)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const outsideFile = path.join(root, 'outside-ancestor.webp');
    fs.writeFileSync(outsideFile, 'x');
    try {
      fs.symlinkSync(outsideFile, path.join(vaultPath, 'link.webp'));
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    const real = fs.realpathSync(outsideFile);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    const baseSha256 = sha256(before);
    const T = tomlPath;

    const res = await post(port, '/api/pack/slots', { slots: { ground: 'vault:link.webp' }, baseSha256 });
    assert.equal(res.status, 400);
    assert.deepEqual(fs.readFileSync(tomlPath), before);
    const expected = `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:link.webp" resolves outside the vault (${real}); symlinks may not leave ${vaultPath}`;
    assert.equal(res.json.message, expected);

    fs.writeFileSync(tomlPath, 'theme = "plain"\n\n[images]\nground = "vault:link.webp"\n');
    const stderrLine = buildFirstStderrLine(root, vaultPath);
    assert.equal(stderrLine, expected);
  });
});

test('parity: vault:link2.webp, a symlink into a prefix-named sibling directory <vault>-evil/', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const evilDir = path.join(root, 'vault-evil');
    fs.mkdirSync(evilDir, { recursive: true });
    const targetFile = path.join(evilDir, 'link2-target.webp');
    fs.writeFileSync(targetFile, 'x');
    try {
      fs.symlinkSync(targetFile, path.join(vaultPath, 'link2.webp'));
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    const real = fs.realpathSync(targetFile);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    const baseSha256 = sha256(before);
    const T = tomlPath;

    const res = await post(port, '/api/pack/slots', { slots: { ground: 'vault:link2.webp' }, baseSha256 });
    assert.equal(res.status, 400, 'a separator-less prefix check would wrongly accept vault-evil/');
    assert.deepEqual(fs.readFileSync(tomlPath), before);
    const expected = `campaign "${CAMPAIGN}": ${T}: [images] ground = "vault:link2.webp" resolves outside the vault (${real}); symlinks may not leave ${vaultPath}`;
    assert.equal(res.json.message, expected);

    fs.writeFileSync(tomlPath, 'theme = "plain"\n\n[images]\nground = "vault:link2.webp"\n');
    const stderrLine = buildFirstStderrLine(root, vaultPath);
    assert.equal(stderrLine, expected);
  });
});

// --- Shape refusals (real HTTP) -----------------------------------------------------------------

async function shapeRefusalCase(t, label, slots, expectedMessage) {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/slots', { slots, baseSha256 });
    assert.equal(res.status, 400, label);
    assert.deepEqual(res.json, { error: 'invalid', message: expectedMessage }, label);
  });
}

test('shape: an unknown slot', async (t) => {
  await shapeRefusalCase(t, 'unknown slot', { bogus: 'images/x.webp' }, 'unknown slot "bogus"; slots are hero, ground, paper, crest-frame, portrait, 404');
});
test('shape: slots is an array', async (t) => {
  await shapeRefusalCase(t, 'array', [], 'slots must be a table of slot names');
});
test('shape: slots is an empty string', async (t) => {
  await shapeRefusalCase(t, 'empty string', '', 'slots must be a table of slot names');
});
test('shape: __proto__ key', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const bodyBuf = Buffer.from(JSON.stringify({ slots: JSON.parse('{"__proto__":"images/x.webp"}'), baseSha256 }));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': String(bodyBuf.length),
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      Cookie: `scriptorium_admin_${port}=${TOKEN}`,
    };
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/pack/slots', headers }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.write(bodyBuf);
      req.end();
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid', message: 'the key "__proto__" is not allowed' });
  });
});

// --- Injection -------------------------------------------------------------------------------

test('injection: a value shaped like a TOML table close is refused, or saved as a single string, never creating a real [labels] table', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));
    const payload = 'images/x.webp" ]\n[labels]\nchapter = "y';

    const res = await post(port, '/api/pack/slots', { slots: { hero: payload }, baseSha256 });
    if (res.status === 200) {
      const parsed = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
      assert.equal(parsed.labels, undefined, 'the injected text must never create a real [labels] table');
    } else {
      assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    }
  });
});

// --- Inherited, re-proven --------------------------------------------------------------------

test('FR05: a site_config campaign is read-only, 403 with the exact reason', async (t) => {
  await withScratchDir(async (root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    const siteConfigPath = path.join(root, 'site.json');
    fs.writeFileSync(siteConfigPath, `${JSON.stringify({ siteTitle: 'X' }, null, 2)}\n`);
    const ctx = ctxFor(vaultPath, { site_config: siteConfigPath });
    const port = await launch(t, ctx);

    const res = await post(port, '/api/pack/slots', { slots: { hero: 'images/hero.webp' }, baseSha256: sha256(Buffer.alloc(0)) });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, {
      error: 'read-only',
      message:
        'This campaign builds from a site_config file, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.',
    });
  });
});

test('FR17: a change to the on-disk file after the sha was taken gives 409 changed, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));
    fs.writeFileSync(tomlPath, 'theme = "external"\n');

    const res = await post(port, '/api/pack/slots', { slots: { hero: 'images/hero.webp' }, baseSha256 });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' });
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "external"\n');
  });
});

test('FR21 analogue: invalid on-disk TOML gives 422, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'not [ valid toml' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);

    const res = await post(port, '/api/pack/slots', { slots: { hero: 'images/hero.webp' }, baseSha256: sha256(before) });
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'invalid-on-disk');
    assert.deepEqual(fs.readFileSync(tomlPath), before);
  });
});

test('FR31: a slot save while ctx.busy is already set gets 409 busy, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    ctx.busy = 'build';

    const res = await post(port, '/api/pack/slots', { slots: { hero: 'images/hero.webp' }, baseSha256: sha256(before) });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'busy', busy: 'build' });
    assert.deepEqual(fs.readFileSync(tomlPath), before);
  });
});

test('D06: dryRun leaves the hash unchanged and shows before/after', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    fs.mkdirSync(path.join(packDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'images', 'hero.webp'), 'hero-bytes');
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    const baseSha256 = sha256(before);

    const res = await post(port, '/api/pack/slots', { slots: { hero: 'images/hero.webp' }, baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.dryRun, true);
    assert.equal(res.json.before, before.toString('utf8'));
    assert.match(res.json.after, /hero = "images\/hero\.webp"/);
    assert.deepEqual(fs.readFileSync(tomlPath), before, 'a dry run must not write');
    assert.equal(sha256(fs.readFileSync(tomlPath)), baseSha256);
  });
});

test('missing pack.toml gives 409', async (t) => {
  await withScratchDir(async (root) => {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha' }, null, 2)}\n`);
    assert.equal(fs.existsSync(path.join(packDir, 'pack.toml')), false);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);

    const fakeSha = sha256(Buffer.from('anything'));
    const res = await post(port, '/api/pack/slots', { slots: { hero: 'images/hero.webp' }, baseSha256: fakeSha });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' });
  });
});

// --- Drift --------------------------------------------------------------------------------------

test('drift: the SLOT_NAMES literal in assets/admin/images.js deep-equals src/build/themes.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'images.js'), 'utf8');
  const match = src.match(/var SLOT_NAMES = (\[[^\]]*\]);/);
  assert.ok(match, 'expected a literal "var SLOT_NAMES = [...]" in assets/admin/images.js');
  // eslint-disable-next-line no-eval
  const extracted = JSON.parse(match[1].replace(/'/g, '"'));
  assert.deepEqual(extracted, SLOT_NAMES);
});
