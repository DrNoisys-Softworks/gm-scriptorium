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

const vaultart = require('../src/admin/vaultart');
const read = require('../src/vault/read');
const packimages = require('../src/admin/packimages');

/*
 * V1e-5 (ADR 0038, SD-50 to SD-52; test-first order item 1). Real sockets for the HTTP-level
 * behaviour (gating, headers, route shape), plus direct, injected-unit calls into vaultart.js
 * for the listing/byte logic itself (the pattern test/admin-slots.test.js and
 * test/admin-vault-config-http.test.js both already use). Fixture names are invented only
 * (harbour-chart, gull-crest, old-map): never a mock sample-campaign name.
 *
 * Every env isolates SCRIPTORIUM_CONFIG/APPDATA/XDG_CONFIG_HOME at a per-file mkdtemp; every
 * launch passes a scratch --config (see scratchEnv/writeScratchVault below).
 */

const IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const CAMPAIGN = 'alpha';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// --- Direct-unit scratch vault (no server) --------------------------------------------------

function mkScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A minimal convention-pack vault on disk, for direct vaultart.js calls. */
function makeVault(root, { vaultConfigJson } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  const json = vaultConfigJson !== undefined ? vaultConfigJson : { siteTitle: 'Alpha', excludeDirs: [], folderMap: {} };
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), `${JSON.stringify(json, null, 2)}\n`);
  return { vaultPath, packDir, siteConfigPath: path.join(packDir, 'vault.config.json') };
}

function ctxFor(vaultPath, siteConfigPath, overrides = {}) {
  return { vaultPath, siteSource: 'convention', siteConfigPath, campaign: CAMPAIGN, ...overrides };
}

function withVaultScratch(fn, opts) {
  const root = mkScratch('scriptorium-vault-art-');
  try {
    return fn(makeVault(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- Server scratch (real sockets) ------------------------------------------------------------

const BIN_ENV_ROOT_MARKER = 'unused';

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, `${BIN_ENV_ROOT_MARKER}-config.toml`);
  env.APPDATA = path.join(root, `${BIN_ENV_ROOT_MARKER}-appdata`);
  env.XDG_CONFIG_HOME = path.join(root, `${BIN_ENV_ROOT_MARKER}-xdg`);
  return env;
}

function writeServerVault(root, opts = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), opts.vaultConfigMd !== undefined ? opts.vaultConfigMd : '---\ntype: meta\n---\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), opts.packToml !== undefined ? opts.packToml : 'theme = "plain"\n');
  const json = opts.vaultConfigJson !== undefined ? opts.vaultConfigJson : { siteTitle: 'Alpha', excludeDirs: [], folderMap: {} };
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), `${JSON.stringify(json, null, 2)}\n`);

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, packDir, configPath };
}

async function withScratch(fn, opts) {
  const root = mkScratch('scriptorium-vault-art-http-');
  try {
    return await fn(writeServerVault(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function launch(t, configPath, extraFlags = {}) {
  const handles = [];
  const wrappedListener = async (handler, lopts) => {
    const handle = await startLocalListener(handler, lopts);
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
    post: (p, body) =>
      request(adminPort, {
        method: 'POST',
        path: p,
        headers: { Cookie: cookieHeader, Origin: `http://127.0.0.1:${adminPort}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    shutdown: () => shutdown(s),
  };
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

// =============================================================================================
// The listing literal (SD-51)
// =============================================================================================

test('listVaultArt: the full fixture tree gives the typed entries list, in order, with usable/excludedBy', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(path.join(att, 'charts'), { recursive: true });
    fs.mkdirSync(path.join(att, 'crests'), { recursive: true });
    fs.mkdirSync(path.join(att, '.trash'), { recursive: true });
    fs.mkdirSync(path.join(att, 'gm-only'), { recursive: true });
    fs.writeFileSync(path.join(att, 'charts', 'harbour-chart.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(att, 'crests', 'gull-crest.svg'), '<svg></svg>');
    fs.writeFileSync(path.join(att, 'notes.txt'), 'not an image');
    fs.writeFileSync(path.join(att, '.trash', 'old-map.png'), Buffer.from([4, 5, 6]));
    fs.writeFileSync(path.join(att, '.dot.png'), Buffer.from([7, 8, 9]));
    fs.writeFileSync(path.join(att, 'gm-only', 'secret-map.png'), Buffer.from([10, 11, 12]));
    fs.symlinkSync(path.join(att, 'charts', 'harbour-chart.png'), path.join(att, 'link.png'));
    fs.symlinkSync(path.join(att, 'charts'), path.join(att, 'linkdir'));

    const ctx = ctxFor(vaultPath, siteConfigPath);
    // Overwrite vault.config.json with the excludeDirs needed for this fixture.
    fs.writeFileSync(
      siteConfigPath,
      `${JSON.stringify({ siteTitle: 'Alpha', excludeDirs: ['_attachments/gm-only'], folderMap: {} }, null, 2)}\n`,
    );

    const result = vaultart.listVaultArt(ctx);
    assert.equal(result.status, 'listed');
    assert.equal(result.folder, '_attachments');
    assert.equal(result.reason, null);
    assert.equal(result.truncated, false);
    assert.equal(result.limit, 2000);
    assert.deepEqual(result.entries, [
      { rel: '_attachments/.dot.png', name: '.dot.png', usable: false, excludedBy: '.dot.png' },
      { rel: '_attachments/charts/harbour-chart.png', name: 'harbour-chart.png', usable: true, excludedBy: null },
      { rel: '_attachments/crests/gull-crest.svg', name: 'gull-crest.svg', usable: true, excludedBy: null },
      { rel: '_attachments/gm-only/secret-map.png', name: 'secret-map.png', usable: false, excludedBy: '_attachments/gm-only' },
    ]);
    // .trash/old-map.png, link.png and linkdir/* are ABSENT entirely -- never walked, never listed.
    assert.ok(!result.entries.some((e) => e.name === 'old-map.png'));
    assert.ok(!result.entries.some((e) => e.name === 'link.png'));
    assert.ok(ctx.vaultArt.rels.has('_attachments/charts/harbour-chart.png'));
    assert.ok(!ctx.vaultArt.rels.has('_attachments/.trash/old-map.png'));
  }, { vaultConfigJson: { siteTitle: 'Alpha', excludeDirs: [], folderMap: {} } });
});

// =============================================================================================
// attachmentsDir variants (SD-51 step 2, root rule)
// =============================================================================================

test('attachmentsDir: absent defaults to _attachments', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'listed');
    assert.equal(result.folder, '_attachments');
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test("attachmentsDir: '' defaults to _attachments", () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'listed');
    assert.equal(result.folder, '_attachments');
  }, { vaultConfigJson: { siteTitle: 'Alpha', attachmentsDir: '', folderMap: {} } });
});

test('attachmentsDir: a nested path is honoured', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.mkdirSync(path.join(vaultPath, 'art', 'attach'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'art', 'attach', 'harbour-chart.png'), Buffer.from([1]));
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'listed');
    assert.equal(result.folder, 'art/attach');
    assert.deepEqual(result.entries.map((e) => e.rel), ['art/attach/harbour-chart.png']);
  }, { vaultConfigJson: { siteTitle: 'Alpha', attachmentsDir: 'art/attach', folderMap: {} } });
});

test('attachmentsDir: a non-string value gives unavailable R_NOT_TEXT, folder:null', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.folder, null);
    assert.ok(result.reason.includes("isn't text"));
    assert.deepEqual(result.entries, []);
    assert.equal(result.truncated, false);
  }, { vaultConfigJson: { siteTitle: 'Alpha', attachmentsDir: 5, folderMap: {} } });
});

test("attachmentsDir: '..' (the vault's own parent) is refused (R_OUTSIDE)", () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason.includes("isn't inside the vault"));
  }, { vaultConfigJson: { siteTitle: 'Alpha', attachmentsDir: '..', folderMap: {} } });
});

test("attachmentsDir: '.' (the vault itself) is refused (R_OUTSIDE)", () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason.includes("isn't inside the vault"));
  }, { vaultConfigJson: { siteTitle: 'Alpha', attachmentsDir: '.', folderMap: {} } });
});

test('attachmentsDir symlink: pointing at the vault root (ancestor) is refused', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.symlinkSync(vaultPath, path.join(vaultPath, '_attachments'));
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason.includes("isn't inside the vault"));
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test("attachmentsDir symlink: pointing at the vault's parent is refused", () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.symlinkSync(path.dirname(vaultPath), path.join(vaultPath, '_attachments'));
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason.includes("isn't inside the vault"));
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test('attachmentsDir symlink: a string-prefix sibling (<vault>-evil) is refused', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const evil = `${vaultPath}-evil`;
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'secret.png'), Buffer.from([1]));
    fs.symlinkSync(evil, path.join(vaultPath, '_attachments'));
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason.includes("isn't inside the vault"));
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test('attachmentsDir symlink: a link to an in-vault folder is allowed, listed under the requested name', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.mkdirSync(path.join(vaultPath, 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'pictures', 'harbour-chart.png'), Buffer.from([1]));
    fs.symlinkSync(path.join(vaultPath, 'pictures'), path.join(vaultPath, '_attachments'));
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'listed');
    assert.deepEqual(result.entries, [{ rel: '_attachments/harbour-chart.png', name: 'harbour-chart.png', usable: true, excludedBy: null }]);
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test('attachmentsDir symlink: a link to an excluded in-vault folder flags every entry through the real-path rule', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.mkdirSync(path.join(vaultPath, 'gm-only', 'art'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'gm-only', 'art', 'secret-map.png'), Buffer.from([1]));
    fs.symlinkSync(path.join(vaultPath, 'gm-only', 'art'), path.join(vaultPath, '_attachments'));
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'listed');
    assert.deepEqual(result.entries, [
      { rel: '_attachments/secret-map.png', name: 'secret-map.png', usable: false, excludedBy: 'gm-only' },
    ]);
  }, { vaultConfigJson: { siteTitle: 'Alpha', excludeDirs: ['gm-only'], folderMap: {} } });
});

// =============================================================================================
// Missing folder / not-a-folder (SD-51 steps 3, 5)
// =============================================================================================

test('missing folder: the missing literal, folder named, entries empty, truncated false', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.deepEqual(result, { status: 'missing', folder: '_attachments', reason: null, truncated: false, limit: 2000, entries: [] });
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test('root is a file, not a folder: R_NOT_FOLDER', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.writeFileSync(path.join(vaultPath, '_attachments'), 'not a folder');
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason.includes("isn't a folder"));
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

// =============================================================================================
// Caps (SD-51 step 7)
// =============================================================================================

test('cap: 2001 tiny files give 2000 entries and truncated:true; exactly 2000 give truncated:false', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    for (let i = 0; i < 2001; i++) {
      fs.writeFileSync(path.join(att, `img-${String(i).padStart(4, '0')}.png`), Buffer.from([i % 255]));
    }
    const over = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(over.entries.length, 2000);
    assert.equal(over.truncated, true);

    fs.rmSync(path.join(att, 'img-2000.png'));
    const exact = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(exact.entries.length, 2000);
    assert.equal(exact.truncated, false);
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test('visit cap: 20001 non-image entries give truncated:true, 0 entries (patched read.listDir)', (t) => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    const manyNonImages = Array.from({ length: 20001 }, (_, i) => ({
      name: `doc-${i}.txt`,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    }));
    const orig = read.listDir;
    t.after(() => {
      read.listDir = orig;
    });
    read.listDir = () => manyNonImages;

    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.equal(result.truncated, true);
    assert.deepEqual(result.entries, []);
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

// =============================================================================================
// Per-folder containment (SD-51 step 7, VA7/VA8)
// =============================================================================================

test('per-folder containment: a patched read.realPath that resolves "charts" outside the root is never descended', (t) => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(path.join(att, 'charts'), { recursive: true });
    fs.writeFileSync(path.join(att, 'charts', 'harbour-chart.png'), Buffer.from([1]));

    const orig = read.realPath;
    t.after(() => {
      read.realPath = orig;
    });

    const evilOutside = `${att}-evil/charts`;
    read.realPath = function (p) {
      if (p === path.join(att, 'charts')) return evilOutside;
      return orig(p);
    };
    const patched = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.deepEqual(patched.entries, [], 'charts/ must not be descended when its real path resolves outside the root');

    // Positive control: unpatched, it IS descended.
    read.realPath = orig;
    const unpatched = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.deepEqual(unpatched.entries, [{ rel: '_attachments/charts/harbour-chart.png', name: 'harbour-chart.png', usable: true, excludedBy: null }]);
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

test('per-folder containment: a patched read.realPath that resolves "charts" to the vault root is never descended', (t) => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(path.join(att, 'charts'), { recursive: true });
    fs.writeFileSync(path.join(att, 'charts', 'harbour-chart.png'), Buffer.from([1]));

    const orig = read.realPath;
    t.after(() => {
      read.realPath = orig;
    });
    const realVaultPath = orig(vaultPath);
    read.realPath = function (p) {
      if (p === path.join(att, 'charts')) return realVaultPath; // the vault root itself: an ancestor, not "inside"
      return orig(p);
    };
    const result = vaultart.listVaultArt(ctxFor(vaultPath, siteConfigPath));
    assert.deepEqual(result.entries, []);
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

// =============================================================================================
// Bytes (SD-52)
// =============================================================================================

test('readVaultArt: a listed PNG is byte-equal, exact IMAGE_CSP via the HTTP route', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    fs.writeFileSync(path.join(att, 'harbour-chart.png'), bytes);

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    const listing = json(await c.get('/api/vault-art'));
    assert.deepEqual(listing.entries.map((e) => e.rel), ['_attachments/harbour-chart.png']);

    const res = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, bytes);
    assert.equal(res.headers['content-security-policy'], IMAGE_CSP);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-type'], 'image/png');
    await c.shutdown();
  });
});

test('readVaultArt: an SVG containing <script> is served with the exact IMAGE_CSP, nosniff, image/svg+xml', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    fs.writeFileSync(path.join(att, 'gull-crest.svg'), svg);

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    await c.get('/api/vault-art');
    const res = await c.get('/api/vault-art/file?name=_attachments/gull-crest.svg');
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), svg);
    assert.equal(res.headers['content-security-policy'], IMAGE_CSP);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    await c.shutdown();
  });
});

test('a missing name gives 400 with the exact literal', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    const res = await c.get('/api/vault-art/file');
    assert.equal(res.status, 400);
    assert.deepEqual(json(res), { error: 'missing name' });
    await c.shutdown();
  });
});

// =============================================================================================
// Sentinels (all give 404; no sentinel byte ever leaks) -- SD-52
// =============================================================================================

const SENTINEL_NAMES = [
  '../x',
  '..%2f_meta%2fvault-config.md',
  '%2e%2e/x',
  '_attachments/../_meta/vault-config.md',
  '/etc/passwd',
  'C:\\x',
  '\\\\srv\\x',
  '_attachments',
  '_attachments/',
  '_attachments/charts',
  '_attachments/.trash/old-map.png',
  '_attachments/link.png',
  '_attachments/notes.txt',
  '_attachments/charts/harbour-chart.png:hidden',
];

for (const nameParam of SENTINEL_NAMES) {
  test(`sentinel: name=${nameParam} gets 404`, async (t) => {
    await withScratch(async ({ vaultPath }) => {
      const att = path.join(vaultPath, '_attachments');
      fs.mkdirSync(path.join(att, 'charts'), { recursive: true });
      fs.mkdirSync(path.join(att, '.trash'), { recursive: true });
      fs.writeFileSync(path.join(att, 'charts', 'harbour-chart.png'), Buffer.from([9, 9, 9]));
      fs.writeFileSync(path.join(att, '.trash', 'old-map.png'), 'TRASH-SENTINEL');
      fs.writeFileSync(path.join(att, 'notes.txt'), 'NOTES-SENTINEL');
      fs.symlinkSync(path.join(att, 'charts', 'harbour-chart.png'), path.join(att, 'link.png'));
      fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), 'VAULT-CONFIG-MD-SENTINEL');
      fs.writeFileSync(path.join(path.dirname(vaultPath), 'x'), 'BESIDE-VAULT-SENTINEL');

      const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
      await c.get('/api/vault-art');
      const res = await c.get(`/api/vault-art/file?name=${nameParam}`);
      assert.equal(res.status, 404, `expected 404 for name=${nameParam}, got ${res.status}`);
      const text = res.body.toString('latin1');
      assert.ok(!text.includes('TRASH-SENTINEL'));
      assert.ok(!text.includes('NOTES-SENTINEL'));
      assert.ok(!text.includes('BESIDE-VAULT-SENTINEL'));
      await c.shutdown();
    });
  });
}

// =============================================================================================
// Swap after listing (each gives 404) -- SD-52 steps 3, 4
// =============================================================================================

test('swap after listing: a listed file replaced by a symlink to an outside, string-prefix-sibling folder gives 404', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    fs.writeFileSync(path.join(att, 'harbour-chart.png'), Buffer.from([1]));
    const evil = `${att}-evil`;
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'x.png'), 'OUTSIDE-SENTINEL');

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    await c.get('/api/vault-art');
    fs.rmSync(path.join(att, 'harbour-chart.png'));
    fs.symlinkSync(path.join(evil, 'x.png'), path.join(att, 'harbour-chart.png'));

    const res = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(res.status, 404);
    assert.ok(!res.body.toString('latin1').includes('OUTSIDE-SENTINEL'));
    await c.shutdown();
  });
});

test('swap after listing: a listed file replaced by a symlink to a top-level vault file gives 404', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    fs.writeFileSync(path.join(att, 'harbour-chart.png'), Buffer.from([1]));
    fs.writeFileSync(path.join(vaultPath, 'top.png'), 'TOP-SENTINEL');

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    await c.get('/api/vault-art');
    fs.rmSync(path.join(att, 'harbour-chart.png'));
    fs.symlinkSync(path.join(vaultPath, 'top.png'), path.join(att, 'harbour-chart.png'));

    const res = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(res.status, 404);
    assert.ok(!res.body.toString('latin1').includes('TOP-SENTINEL'));
    await c.shutdown();
  });
});

test('swap after listing: a listed file replaced by a symlink to a non-image page gives 404', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    fs.writeFileSync(path.join(att, 'harbour-chart.png'), Buffer.from([1]));
    fs.writeFileSync(path.join(att, 'page.html'), '<html>PAGE-SENTINEL</html>');

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    await c.get('/api/vault-art');
    fs.rmSync(path.join(att, 'harbour-chart.png'));
    fs.symlinkSync(path.join(att, 'page.html'), path.join(att, 'harbour-chart.png'));

    const res = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(res.status, 404);
    assert.ok(!res.body.toString('latin1').includes('PAGE-SENTINEL'));
    await c.shutdown();
  });
});

test('swap after listing: the root itself replaced by a symlink to the vault gives 404 for its members', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    fs.writeFileSync(path.join(att, 'harbour-chart.png'), Buffer.from([1]));

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    await c.get('/api/vault-art');
    fs.rmSync(att, { recursive: true, force: true });
    fs.symlinkSync(vaultPath, att);

    const res = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(res.status, 404);
    await c.shutdown();
  });
});

// =============================================================================================
// Freshness of membership (SD-52 step 2, VA18)
// =============================================================================================

test('freshness: a file created after the listing gives 404; a fresh GET /api/vault-art then gives 200 for it', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));

    await c.get('/api/vault-art');
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'harbour-chart.png'), Buffer.from([1]));

    const tooEarly = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(tooEarly.status, 404);

    const relisted = json(await c.get('/api/vault-art'));
    assert.deepEqual(relisted.entries.map((e) => e.rel), ['_attachments/harbour-chart.png']);

    const now = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(now.status, 200);
    await c.shutdown();
  });
});

test('freshness: with no listing yet, the first byte request for a listable file gives 200 (self-listing)', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'harbour-chart.png'), Buffer.from([1]));
    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));

    const res = await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
    assert.equal(res.status, 200);
    await c.shutdown();
  });
});

// =============================================================================================
// Size (SD-52 step 6, VA11)
// =============================================================================================

test('size: an 11 MiB listed PNG gives 404; exactly 10 MiB gives 200', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    const att = path.join(vaultPath, '_attachments');
    fs.mkdirSync(att, { recursive: true });
    const tenMiB = Buffer.alloc(10 * 1024 * 1024, 7);
    const overMiB = Buffer.alloc(10 * 1024 * 1024 + 1, 7);
    fs.writeFileSync(path.join(att, 'exact.png'), tenMiB);
    fs.writeFileSync(path.join(att, 'over.png'), overMiB);

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    await c.get('/api/vault-art');

    const over = await c.get('/api/vault-art/file?name=_attachments/over.png');
    assert.equal(over.status, 404);

    const exact = await c.get('/api/vault-art/file?name=_attachments/exact.png');
    assert.equal(exact.status, 200);
    await c.shutdown();
  });
});

// =============================================================================================
// Routes (SD-50)
// =============================================================================================

test('routes: unknown siblings all 404', async (t) => {
  await withScratch(async ({ vaultPath }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    for (const p of ['/api/vault-artx', '/api/vault-art/', '/api/vault-art/filex', '/api/vault-art/file/x']) {
      const res = await c.get(p);
      assert.equal(res.status, 404, p);
    }
    const postRes = await request(c.adminPort, { method: 'POST', path: '/api/vault-art', headers: { Cookie: c.cookie, Origin: `http://127.0.0.1:${c.adminPort}` } });
    assert.equal(postRes.status, 404);
    await c.shutdown();
  });
});

test('routes: no cookie is refused: token on both routes; a wrong Host is refused: host', async (t) => {
  await withScratch(async ({ vaultPath, configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;

    for (const p of ['/api/vault-art', '/api/vault-art/file']) {
      const res = await request(adminPort, { path: p });
      assert.equal(res.status, 403, p);
      assert.equal(res.body.toString(), 'refused: token', p);

      const wrongHost = await request(adminPort, { path: p, headers: { Host: 'evil.example' } });
      assert.equal(wrongHost.status, 403, p);
      assert.equal(wrongHost.body.toString(), 'refused: host', p);
    }
    await shutdown(state);
  });
});

// =============================================================================================
// Read-only campaign still lists
// =============================================================================================

test('read-only (pack-key) campaign still lists', () => {
  withVaultScratch(({ vaultPath, siteConfigPath }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'harbour-chart.png'), Buffer.from([1]));
    const ctx = ctxFor(vaultPath, siteConfigPath, { siteSource: 'pack' });
    const result = vaultart.listVaultArt(ctx);
    assert.equal(result.status, 'listed');
    assert.deepEqual(result.entries.map((e) => e.rel), ['_attachments/harbour-chart.png']);
  }, { vaultConfigJson: { siteTitle: 'Alpha', folderMap: {} } });
});

// =============================================================================================
// Console silence over both routes
// =============================================================================================

test('console silence: both routes produce no console output', async (t) => {
  await withScratch(async ({ vaultPath }, root) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'harbour-chart.png'), Buffer.from([1]));
    const c = await launchAuthed(t, path.join(root, 'config.toml'));
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    const calls = [];
    console.log = (...a) => calls.push(a);
    console.error = (...a) => calls.push(a);
    console.warn = (...a) => calls.push(a);
    try {
      await c.get('/api/vault-art');
      await c.get('/api/vault-art/file?name=_attachments/harbour-chart.png');
      await c.get('/api/vault-art/file?name=_attachments/nope.png');
    } finally {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    }
    assert.deepEqual(calls, []);
    await c.shutdown();
  });
});

// =============================================================================================
// Save side (AC-V5-05): an excluded entry is still refused at the dry run
// =============================================================================================

test('save side: a slots dry run naming an excluded vault file gives 400 invalid with the planThemeAssets message', async (t) => {
  await withScratch(async ({ vaultPath, packDir }) => {
    fs.mkdirSync(path.join(vaultPath, '_attachments', 'gm-only'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'gm-only', 'secret-map.png'), Buffer.from([1]));

    const c = await launchAuthed(t, path.join(path.dirname(vaultPath), 'config.toml'));
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await c.post('/api/pack/slots', {
      slots: { ground: 'vault:_attachments/gm-only/secret-map.png' },
      baseSha256,
      dryRun: true,
    });
    assert.equal(res.status, 400);
    const body = json(res);
    assert.equal(body.error, 'invalid');
    assert.ok(body.message.includes('excluded directory'), body.message);
  }, { vaultConfigJson: { siteTitle: 'Alpha', excludeDirs: ['_attachments/gm-only'], folderMap: {} } });
});

// =============================================================================================
// Byte-route containment constants exposed for the mutation table / fidelity gate
// =============================================================================================

test('module exports the expected shape', () => {
  assert.equal(vaultart.VAULT_ART_LIMIT, 2000);
  assert.equal(vaultart.VAULT_ART_VISIT_LIMIT, 20000);
  assert.equal(vaultart.DEFAULT_ATTACHMENTS_DIR, '_attachments');
  assert.equal(typeof vaultart.listVaultArt, 'function');
  assert.equal(typeof vaultart.readVaultArt, 'function');
  assert.equal(typeof packimages.IMAGE_CONTENT_TYPES['.png'], 'string');
});
