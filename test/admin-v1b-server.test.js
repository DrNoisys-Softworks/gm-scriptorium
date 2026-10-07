'use strict';

/*
 * V1b Engineering Brief, FR-19 / SD-1: GET /api/state?include=palette. Real sockets, following
 * test/admin-views.test.js's launch()/launchAuthed() pattern (copied, not required -- house rule).
 *
 * Sections A and B land with C1 (server FR-19, on its own). Section C (parity with a real
 * POST /api/check envelope) needs SL.schemeMismatch from assets/admin/slip.js, which does not
 * exist until C3 (pure modules) -- writing it here in C1 would MODULE_NOT_FOUND the whole file
 * and break `npm test` between commits (CLAUDE.md: "never leave the codebase broken between
 * steps"). Section C is appended in the C3 commit instead. Section D (FR-13 server contract,
 * label/column drift) is appended in C4, per the brief's own note that D lands with the DOM work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');

const DEFAULT_VAULT_CONFIG_JSON = JSON.stringify({ siteTitle: 'Alpha Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n';

// Independent literal (CLAUDE.md: never derive an assertion's expected value from the code under
// test). Measured against the real, currently-passing test/admin-views.test.js:186-219, which
// deep-equals the same 11 properties: this is the ground truth, not the brief's "12" (see the
// Engineer report's "verify the base" note -- the brief's prose miscounts by one).
const DEFAULT_STATE_KEYS = [
  'campaign',
  'siteSource',
  'writable',
  'readOnlyReason',
  'previewPort',
  'packToml',
  'vaultConfigJson',
  'themes',
  'vaultConfigMd',
  'images',
  'preview',
];

function writeScratchVault(root, opts = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });

  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    opts.vaultConfigMd !== undefined ? opts.vaultConfigMd : '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config body\n',
  );
  fs.writeFileSync(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Fine.md\n');

  if (opts.packToml !== null) {
    fs.writeFileSync(path.join(packDir, 'pack.toml'), opts.packToml !== undefined ? opts.packToml : 'theme = "plain"\n');
  }
  if (opts.vaultConfigJson !== null) {
    fs.writeFileSync(
      path.join(packDir, 'vault.config.json'),
      opts.vaultConfigJson !== undefined ? opts.vaultConfigJson : DEFAULT_VAULT_CONFIG_JSON,
    );
  }
  fs.writeFileSync(path.join(vaultPath, 'Notes', 'Fine.md'), '---\ntype: character\n---\n\n# Fine\n');

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, packDir, configPath };
}

async function withScratchOpts(opts, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-v1b-server-'));
  try {
    return await fn(writeScratchVault(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withScratch(fn) {
  return withScratchOpts({}, fn);
}

/** Mirrors test/admin-views.test.js's launch(): real handles, t.after() force-close. */
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

/** Mirrors test/admin-views.test.js's launchAuthed(). */
async function launchAuthed(t, configPath, extraFlags = {}) {
  const s = await waitForHandles(launch(t, configPath, extraFlags));
  const adminPort = s.handles[0].port;
  const previewPort = s.handles[1].port;
  const authResult = await request(adminPort, { path: `/auth?token=${tokenFromLine(s.emitted[0])}` });
  const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];
  return {
    adminPort,
    previewPort,
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

function vaultConfigWithPalette(background) {
  return `---\ntype: meta\npublish:\n  theme:\n    palette:\n      background: '${background}'\n---\n\n# Vault config\n`;
}

function vaultConfigWithGenre(genre) {
  return `---\ntype: meta\npublish:\n  theme:\n    genre: '${genre}'\n---\n\n# Vault config\n`;
}

// === Section A: include shapes ================================================================

test('A1: default keys (no include) equal the 11-key literal, no vocab, no palette', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state'));
    assert.deepEqual(Object.keys(body), DEFAULT_STATE_KEYS);
    await c.shutdown();
  });
});

test('A2: ?include=vocab keys equal the default literal plus vocab', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state?include=vocab'));
    assert.deepEqual(Object.keys(body), [...DEFAULT_STATE_KEYS, 'vocab']);
    await c.shutdown();
  });
});

test('A3: ?include=vocab,palette and ?include=vocab&include=palette both give both keys, palette last', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const bodyComma = json(await c.get('/api/state?include=vocab,palette'));
    assert.deepEqual(Object.keys(bodyComma), [...DEFAULT_STATE_KEYS, 'vocab', 'palette']);
    const bodyRepeated = json(await c.get('/api/state?include=vocab&include=palette'));
    assert.deepEqual(Object.keys(bodyRepeated), [...DEFAULT_STATE_KEYS, 'vocab', 'palette']);
    await c.shutdown();
  });
});

test('A4: string-prefix and case siblings give no palette key; positive control does', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    for (const query of ['palettes', 'Palette', 'pal', 'palette%20']) {
      const body = json(await c.get(`/api/state?include=${query}`));
      assert.ok(!Object.prototype.hasOwnProperty.call(body, 'palette'), `?include=${query} must not add palette`);
    }
    // Positive control: the scan actually finds something (not vacuously true).
    const good = json(await c.get('/api/state?include=palette'));
    assert.ok(Object.prototype.hasOwnProperty.call(good, 'palette'), '?include=palette must add palette');
    await c.shutdown();
  });
});

// === Section B: palette values =================================================================

test('B1: a light-palette fixture (#f5f0e6) gives {scheme:"light", background:"#f5f0e6", error:null}', async (t) => {
  await withScratchOpts({ vaultConfigMd: vaultConfigWithPalette('#f5f0e6') }, async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state?include=palette'));
    assert.deepEqual(body.palette, { scheme: 'light', background: '#f5f0e6', error: null });
    await c.shutdown();
  });
});

test('B2: the genre "horror" fixture gives {scheme:null, background:null, error:null}', async (t) => {
  await withScratchOpts({ vaultConfigMd: vaultConfigWithGenre('horror') }, async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state?include=palette'));
    assert.deepEqual(body.palette, { scheme: null, background: null, error: null });
    await c.shutdown();
  });
});

test('B3: an injected themescheme.paletteScheme throw gives the error shape with status 200; positive control is the uninjected call', async (t) => {
  await withScratchOpts({ vaultConfigMd: vaultConfigWithPalette('#f5f0e6') }, async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const themescheme = require('../src/checks/themescheme');
    const original = themescheme.paletteScheme;
    themescheme.paletteScheme = () => {
      throw new Error('injected paletteScheme failure');
    };
    t.after(() => {
      themescheme.paletteScheme = original;
    });
    const failed = await c.get('/api/state?include=palette');
    assert.equal(failed.status, 200);
    assert.deepEqual(json(failed).palette, { scheme: null, background: null, error: 'injected paletteScheme failure' });

    themescheme.paletteScheme = original;
    const ok = await c.get('/api/state?include=palette');
    assert.equal(ok.status, 200);
    assert.deepEqual(json(ok).palette, { scheme: 'light', background: '#f5f0e6', error: null });
    await c.shutdown();
  });
});

// === Section C: parity with a real POST /api/check envelope (lands with C3, once slip.js is real) =

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');

/** Copies mini-vault into scratch, with a convention pack (theme = <theme>) and _meta/vault-config.md
 * replaced by `vaultConfigMd` -- mirrors test/theme-scheme.test.js's setupVault(). */
function writeParityVault(root, theme, vaultConfigMd) {
  const vaultPath = path.join(root, 'vault');
  fs.cpSync(MINI_VAULT, vaultPath, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), vaultConfigMd);
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ siteTitle: 'Parity Fixture', siteUrl: 'https://example.invalid', excludeDirs: [], folderMap: {} }, null, 2),
  );
  fs.writeFileSync(path.join(packDir, 'pack.toml'), `theme = "${theme}"\n`);
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, configPath };
}

async function withParityVault(theme, vaultConfigMd, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-v1b-parity-'));
  try {
    return await fn(writeParityVault(root, theme, vaultConfigMd));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PARITY_CASES = [
  { label: 'haze with a light palette', theme: 'haze', vaultConfigMd: vaultConfigWithPalette('#f5f0e6'), expected: true },
  { label: 'haze with a dark palette', theme: 'haze', vaultConfigMd: vaultConfigWithPalette('#1a1a1a'), expected: false },
  { label: 'plain with a light palette', theme: 'plain', vaultConfigMd: vaultConfigWithPalette('#f5f0e6'), expected: false },
  { label: 'haze with the genre "horror"', theme: 'haze', vaultConfigMd: vaultConfigWithGenre('horror'), expected: false },
  // ADR 0032, Structural decision 2 (GM4/GM11/GM13 control): gloam owns the palette, so even a
  // mismatched light palette must give no finding, on both the client and the server.
  { label: 'gloam with a light palette', theme: 'gloam', vaultConfigMd: vaultConfigWithPalette('#f5f0e6'), expected: false },
];

PARITY_CASES.forEach(({ label, theme, vaultConfigMd, expected }) => {
  test(`C: SL.schemeMismatch parity with a real POST /api/check envelope -- ${label} (expect ${expected})`, async (t) => {
    await withParityVault(theme, vaultConfigMd, async ({ configPath }) => {
      const { SL } = require(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'));
      const c = await launchAuthed(t, configPath);

      const stateBody = json(await c.get('/api/state?include=palette'));
      const clientMismatch = SL.schemeMismatch(stateBody.packToml.theme, stateBody.themes, stateBody.palette);

      const checkBody = json(await c.post('/api/check'));
      const serverHasFinding = checkBody.envelope.findings.some((f) => f.id === 'config/theme-scheme-mismatch');

      assert.equal(clientMismatch !== null, expected, `client mismatch: ${JSON.stringify(clientMismatch)}`);
      assert.equal(serverHasFinding, expected, `server findings: ${JSON.stringify(checkBody.envelope.findings.map((f) => f.id))}`);
      assert.equal(clientMismatch !== null, serverHasFinding, 'client and server must agree');

      await c.shutdown();
    });
  });
});

// === Section D: FR-13 server contract, and the label/column drift (lands with C4) =============

test('D1: FR-13 -- a theme dry run+confirm, then a vocab dry run+confirm with the theme confirm\'s sha256, both 200', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state'));
    const themeBaseSha = state.packToml.sha256;

    const themeDry = json(await c.post('/api/pack/theme', { body: JSON.stringify({ theme: 'haze', baseSha256: themeBaseSha, dryRun: true }) }));
    assert.equal(themeDry.ok, true);

    const themeConfirm = json(await c.post('/api/pack/theme', { body: JSON.stringify({ theme: 'haze', baseSha256: themeBaseSha }) }));
    assert.equal(themeConfirm.ok, true);
    assert.match(themeConfirm.sha256, /^[0-9a-f]{64}$/);

    const vocabPayload = { labels: { chapter: 'Chapter' } };
    const vocabDry = json(
      await c.post('/api/pack/vocab', { body: JSON.stringify(Object.assign({}, vocabPayload, { baseSha256: themeConfirm.sha256, dryRun: true })) }),
    );
    assert.equal(vocabDry.ok, true);

    const vocabConfirm = json(
      await c.post('/api/pack/vocab', { body: JSON.stringify(Object.assign({}, vocabPayload, { baseSha256: themeConfirm.sha256 })) }),
    );
    assert.equal(vocabConfirm.ok, true);

    await c.shutdown();
  });
});

test('D2: FR-13 negative -- the pre-theme sha gives 409 with the exact changed message', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state'));
    const staleSha = state.packToml.sha256;

    const themeConfirm = json(await c.post('/api/pack/theme', { body: JSON.stringify({ theme: 'haze', baseSha256: staleSha }) }));
    assert.equal(themeConfirm.ok, true);

    const staleVocab = await c.post('/api/pack/vocab', { body: JSON.stringify({ labels: { chapter: 'Chapter' }, baseSha256: staleSha }) });
    assert.equal(staleVocab.status, 409);
    assert.deepEqual(json(staleVocab), { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' });

    await c.shutdown();
  });
});

test('D3: VB.LABEL_GROUPS flattened, sorted, equals Object.keys(vocab.defaults.labels), sorted (17)', async (t) => {
  const { VB } = require(path.join(__dirname, '..', 'assets', 'admin', 'vocab.js'));
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state?include=vocab'));
    const flat = VB.LABEL_GROUPS.flatMap((g) => g[1]).sort();
    const fromServer = Object.keys(body.vocab.defaults.labels).sort();
    assert.deepEqual(flat, fromServer);
    assert.equal(flat.length, 17);
    await c.shutdown();
  });
});

test('D4: VB.COLUMN_KEYS sorted equals Object.keys(vocab.defaults.timeline.columns) sorted', async (t) => {
  const { VB } = require(path.join(__dirname, '..', 'assets', 'admin', 'vocab.js'));
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state?include=vocab'));
    const fromServer = Object.keys(body.vocab.defaults.timeline.columns).sort();
    assert.deepEqual(VB.COLUMN_KEYS.slice().sort(), fromServer);
    await c.shutdown();
  });
});
