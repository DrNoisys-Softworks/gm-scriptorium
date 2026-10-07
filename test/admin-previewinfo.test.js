'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const preview = require('../src/admin/preview');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * V1e-3 (SD-17, SD-19, D-10, AC-V3-02). Real sockets, following the house launch()/launchAuthed()
 * pattern. Isolation: every scratch env var is set to a per-file mkdtemp before any test runs.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-previewinfo-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-previewinfo-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-previewinfo-sc-')), 'config.toml');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

function writeScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
  // Overwrite with a tagline-editable vault-config.md, keeping the fixture's own publish.mode:
  // full (its absence makes leak/l1-no-manifest refuse every build, per the real check). The
  // tagline is written already JSON-quoted, the exact byte shape applyTagline itself produces,
  // so a same-value set is a genuine byte-identical no-op, not merely a semantic one (an
  // unquoted -> quoted round trip is a real byte change).
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\npublish:\n  mode: full\n  theme:\n    tagline: "Old words"\n---\n\nBody text, never sent to the browser.\n',
  );
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, configPath };
}

async function withScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-previewinfo-http-'));
  try {
    return await fn(writeScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function launch(t, configPath, extraFlags = {}) {
  const { runServeCommand } = require('../src/cli/serve');
  const { startLocalListener } = require('../src/serve/server');
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

async function launchAuthed(t, configPath) {
  const s = await waitForHandles(launch(t, configPath));
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
    upload: (name, bytes) =>
      request(adminPort, {
        method: 'POST',
        path: `/api/images/upload?name=${encodeURIComponent(name)}`,
        headers: {
          Cookie: cookieHeader,
          Origin: `http://127.0.0.1:${adminPort}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
        },
        body: bytes,
      }),
    shutdown: () => shutdown(s),
  };
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

async function buildPreview(c) {
  const res = await c.post('/api/preview');
  assert.equal(res.status, 200, 'buildPreview helper: expected the build to succeed');
  return json(res);
}

async function previewInfo(c) {
  const body = json(await c.get('/api/state?include=previewinfo'));
  return body.previewInfo;
}

async function taglineSha(c) {
  const body = json(await c.get('/api/state?include=vaultconfig'));
  return body.vaultConfigFile.sha256;
}

// =================================================================================================
// Include sibling set + default shape
// =================================================================================================

test('include-name siblings previewinfox, Previewinfo, previewinf, "previewinfo " give no previewInfo key; the default shape is byte-identical', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);

    const bare = json(await c.get('/api/state'));
    assert.equal(Object.prototype.hasOwnProperty.call(bare, 'previewInfo'), false);

    for (const name of ['previewinfox', 'Previewinfo', 'previewinf', 'previewinfo%20']) {
      const res = json(await c.get(`/api/state?include=${name}`));
      assert.equal(Object.prototype.hasOwnProperty.call(res, 'previewInfo'), false, name);
    }

    await c.shutdown();
  });
});

test('not built yet gives the exact typed literal', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const info = await previewInfo(c);
    assert.deepEqual(info, { built: false, builtAt: null, stale: null, savedSince: [], panelSavesSince: 0, pages: [] });
    await c.shutdown();
  });
});

test('a build gives fresh: built true, stale false, savedSince [], panelSavesSince 0, with real pages', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);
    const info = await previewInfo(c);
    assert.equal(info.built, true);
    assert.equal(info.stale, false);
    assert.deepEqual(info.savedSince, []);
    assert.equal(info.panelSavesSince, 0);
    assert.equal(typeof info.builtAt, 'string');
    assert.ok(info.pages.length > 0);
    await c.shutdown();
  });
});

// =================================================================================================
// Save-triggered staleness
// =================================================================================================

test('a tagline DRY RUN alone stays fresh (never writes, never notes a save)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);
    const baseSha256 = await taglineSha(c);

    const dry = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'New words', baseSha256, dryRun: true }) });
    assert.equal(dry.status, 200);

    const info = await previewInfo(c);
    assert.equal(info.stale, false);
    assert.deepEqual(info.savedSince, []);
    assert.equal(info.panelSavesSince, 0);
    await c.shutdown();
  });
});

test('a tagline CONFIRM gives stale, with savedSince exactly ["vault-config.md"]', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);
    const baseSha256 = await taglineSha(c);

    const confirm = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'New words', baseSha256, dryRun: false }) });
    assert.equal(confirm.status, 200);
    assert.equal(json(confirm).ok, true);

    const info = await previewInfo(c);
    assert.equal(info.stale, true);
    assert.deepEqual(info.savedSince, ['vault-config.md']);
    assert.equal(info.panelSavesSince, 1);
    await c.shutdown();
  });
});

test('R4: an "unchanged:true" tagline confirm (candidate byte-equals current) stays fresh', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);
    const baseSha256 = await taglineSha(c);

    // Same value as what is already on disk ("Old words") -- the handler's own equals() check
    // gives {ok:true, unchanged:true}.
    const confirm = await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'Old words', baseSha256, dryRun: false }) });
    assert.equal(confirm.status, 200);
    assert.equal(json(confirm).unchanged, true);

    const info = await previewInfo(c);
    assert.equal(info.stale, false);
    assert.deepEqual(info.savedSince, []);
    assert.equal(info.panelSavesSince, 0);
    await c.shutdown();
  });
});

test('R1: an edit made OUTSIDE the panel to pack.toml gives stale; an outside edit to a vault PAGE does not (the stated residual)', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);

    // Outside pack.toml edit: freshness must catch this (a tracked file).
    const packTomlPath = path.join(vaultPath, '_meta', 'scriptorium', 'pack.toml');
    fs.appendFileSync(packTomlPath, '\n# an edit made outside the panel\n');
    const afterPackEdit = await previewInfo(c);
    assert.equal(afterPackEdit.stale, true);
    assert.deepEqual(afterPackEdit.savedSince, ['pack.toml']);

    await buildPreview(c); // rebuild to clear staleness before the next probe
    const freshAgain = await previewInfo(c);
    assert.equal(freshAgain.stale, false);

    // Outside edit to an ordinary vault PAGE (not one of the 3 tracked files): the residual --
    // freshness never hashes vault pages, so this must NOT be reported as stale.
    const episodePath = path.join(vaultPath, 'Episodes', 'Episode-01.md');
    fs.appendFileSync(episodePath, '\nAn edit made outside the panel, to an ordinary vault page.\n');
    const afterPageEdit = await previewInfo(c);
    assert.equal(afterPageEdit.stale, false, 'an outside edit to a vault page is the stated residual: never detected');
    assert.deepEqual(afterPageEdit.savedSince, []);

    await c.shutdown();
  });
});

test('an image upload gives stale by the counter alone: savedSince [], panelSavesSince 1', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);

    const up = await c.upload('probe.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    assert.equal(up.status, 200);

    const info = await previewInfo(c);
    assert.equal(info.stale, true);
    assert.deepEqual(info.savedSince, []);
    assert.equal(info.panelSavesSince, 1);
    await c.shutdown();
  });
});

// =================================================================================================
// R6 / R5: refused build keeps the old stamp; a mid-build outside edit is caught
// =================================================================================================

test('R6: a refused build (exit CHECK_FAILED) keeps the previous stamp -- freshness must not move', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);
    const before = await previewInfo(c);
    assert.equal(before.stale, false);

    const original = preview.buildPreviewWithGmLink;
    preview.buildPreviewWithGmLink = () => ({ exitCode: EXIT_CODES.CHECK_FAILED, human: 'refused', envelope: {} });
    try {
      const refused = await c.post('/api/preview');
      assert.equal(refused.status, 200);
      assert.equal(json(refused).exitCode, EXIT_CODES.CHECK_FAILED);
    } finally {
      preview.buildPreviewWithGmLink = original;
    }

    const after = await previewInfo(c);
    assert.deepEqual(after, before, 'a refused build must leave builtAt/stale/savedSince/panelSavesSince exactly as they were');
    await c.shutdown();
  });
});

test('R5: the stamp is taken BEFORE the build runs -- an outside edit made mid-build is caught as stale', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c); // establish a fresh baseline

    const original = preview.buildPreviewWithGmLink;
    preview.buildPreviewWithGmLink = (ctx) => {
      // Simulate an edit landing WHILE the build is in flight (after the stamp is taken, before
      // the real build reads the tree) -- a stamp taken AFTER the build would miss this.
      fs.appendFileSync(path.join(vaultPath, '_meta', 'scriptorium', 'pack.toml'), '\n# mid-build outside edit\n');
      return original(ctx);
    };
    try {
      const res = await c.post('/api/preview');
      assert.equal(res.status, 200);
      assert.equal(json(res).exitCode, EXIT_CODES.OK);
    } finally {
      preview.buildPreviewWithGmLink = original;
    }

    const info = await previewInfo(c);
    assert.equal(info.stale, true, 'the mid-build edit must be visible as stale');
    assert.deepEqual(info.savedSince, ['pack.toml']);
    await c.shutdown();
  });
});

test('a rebuild after a stale save gives fresh again', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildPreview(c);
    const baseSha256 = await taglineSha(c);
    await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: 'New words', baseSha256, dryRun: false }) });
    assert.equal((await previewInfo(c)).stale, true);

    await buildPreview(c);
    const info = await previewInfo(c);
    assert.equal(info.stale, false);
    assert.deepEqual(info.savedSince, []);
    assert.equal(info.panelSavesSince, 0, 'compareStamp is relative to the NEW stamp\'s own saves count');
    await c.shutdown();
  });
});
