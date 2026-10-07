'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { runExclusive } = require('../src/admin/context');
const { envelopeWithoutTimestamp } = require('../src/report/json');

/*
 * Phase 8 slice S2 (docs/agent-runs/admin-s2-engineering-brief-2026-09-28.md, "Test-first order"
 * item 2). Real sockets, using S1's exports (launch() below mirrors test/admin-http.test.js's
 * own helper -- it is not imported, per the orchestrator notes: "no shared test-helper module").
 * Synthetic cast only (NFR-10/NFR-11); scratch dirs only, never test/fixtures written to.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
// A build needs at least one folderMap entry to publish anything (a generator requirement, not
// an admin-panel one); every scratch vault below gets one so /api/preview and /api/check's
// build-driving tests can complete a real build rather than fail on an unrelated fixture gap.
const DEFAULT_VAULT_CONFIG_JSON = JSON.stringify({ siteTitle: 'Alpha Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n';

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { timeout: 60000, killSignal: 'SIGKILL', encoding: 'utf8', ...opts });
  assert.equal(res.error, undefined, `spawn error: ${res.error && res.error.message}`);
  return res;
}

/** A minimal, valid convention-pack scratch vault. `opts` overrides let each test shape one axis. */
function writeScratchVault(root, opts = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });

  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    opts.vaultConfigMd !== undefined ? opts.vaultConfigMd : '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config body\n',
  );
  // Default publish mode is "player", which needs a manifest or leak/l1-no-manifest is an
  // ERROR finding (exit 2). Unconditional so every FR28/FR31/FR11-style check-driving test
  // gets exit 0 regardless of a custom vaultConfigMd override above.
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

async function withScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-views-'));
  try {
    return await fn(writeScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withScratchOpts(opts, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-views-'));
  try {
    return await fn(writeScratchVault(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Mirrors test/admin-http.test.js's launch(): real handles, t.after() force-close. */
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

/** Launches, waits for both handles, authenticates, returns { adminPort, previewPort, cookie, state, shutdown }. */
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
      request(adminPort, { method: 'POST', path: p, headers: { Cookie: cookieHeader, Origin: `http://127.0.0.1:${adminPort}`, ...(opts.headers || {}) }, body: opts.body }),
    previewGet: (p, headers = {}) => request(previewPort, { path: p, headers }),
    previewPost: (p, headers = {}) => request(previewPort, { method: 'POST', path: p, headers }),
    shutdown: () => shutdown(s),
  };
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

// --- GET /api/state, the exact shape -------------------------------------

test('GET /api/state: exact shape for a synthetic vault', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.get('/api/state');
    assert.equal(res.status, 200);
    const body = json(res);
    assert.deepEqual(body, {
      campaign: 'alpha',
      siteSource: 'convention',
      writable: true,
      readOnlyReason: null,
      previewPort: c.previewPort,
      packToml: { exists: true, raw: 'theme = "plain"\n', sha256: crypto.createHash('sha256').update('theme = "plain"\n').digest('hex'), error: null, theme: 'plain', images: {}, warnings: [] },
      vaultConfigJson: {
        exists: true,
        raw: DEFAULT_VAULT_CONFIG_JSON,
        sha256: crypto.createHash('sha256').update(DEFAULT_VAULT_CONFIG_JSON).digest('hex'),
        error: null,
        siteTitle: 'Alpha Test',
        landingTagline: null,
      },
      themes: [
        { name: 'plain', scheme: body.themes[0].scheme },
        { name: 'haze', scheme: body.themes[1] && body.themes[1].scheme },
        { name: 'gloam', scheme: body.themes[2] && body.themes[2].scheme },
      ],
      vaultConfigMd: { ok: true, text: JSON.stringify({ type: 'meta', campaign: 'Alpha' }, null, 2) },
      images: [],
      preview: { built: false, dir: null },
    });
    // Registry order and names asserted independently of whatever `scheme` happens to be.
    assert.deepEqual(body.themes.map((t2) => t2.name), ['plain', 'haze', 'gloam']);
    await c.shutdown();
  });
});

// --- FR05: writable / readOnlyReason across the three site sources -------

test('FR05: convention source is writable with no reason (positive control)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state'));
    assert.equal(body.siteSource, 'convention');
    assert.equal(body.writable, true);
    assert.equal(body.readOnlyReason, null);
    await c.shutdown();
  });
});

test('FR05: a pack key gives read-only with the exact literal reason', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-views-'));
  try {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
    const packDir = path.join(root, 'external-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ siteTitle: 'Pack Test' }) + '\n');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `pack = '${packDir}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    const t2 = await launchAuthed(t, configPath);
    const body = json(await t2.get('/api/state'));
    assert.equal(body.siteSource, 'pack');
    assert.equal(body.writable, false);
    assert.equal(
      body.readOnlyReason,
      "This campaign's pack key points at a folder of its own, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.",
    );
    await t2.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR05: a site_config gives read-only with the exact literal reason', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-views-'));
  try {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
    const siteConfigPath = path.join(root, 'legacy-site.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ siteTitle: 'Legacy Test' }) + '\n');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        'config_version = 1',
        'default_campaign = "alpha"',
        '',
        '[campaigns.alpha]',
        `vault = '${vaultPath}'`,
        `site_config = '${siteConfigPath}'`,
        `output = '${root}/out'`,
        '',
      ].join('\n'),
    );
    const t2 = await launchAuthed(t, configPath);
    const body = json(await t2.get('/api/state'));
    assert.equal(body.siteSource, 'site_config');
    assert.equal(body.writable, false);
    assert.equal(
      body.readOnlyReason,
      'This campaign builds from a site_config file, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.',
    );
    await t2.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- FR21: broken pack files still launch ---------------------------------

test('FR21: a bad pack.toml (theme = 1) still launches; error is the exact check message', async (t) => {
  await withScratchOpts({ packToml: 'theme = 1\n' }, async ({ configPath, packDir }) => {
    const tomlPath = path.join(packDir, 'pack.toml');
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state'));
    assert.equal(body.packToml.exists, true);
    assert.equal(body.packToml.theme, null);
    assert.equal(body.packToml.error, `campaign "alpha": ${tomlPath}: theme must be a string`);
    await c.shutdown();
  });
});

test('FR21: a bad vault.config.json still launches; error is the exact check message', async (t) => {
  await withScratchOpts({ vaultConfigJson: '{not valid json' }, async ({ configPath, packDir }) => {
    const jsonPath = path.join(packDir, 'vault.config.json');
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state'));
    assert.equal(body.vaultConfigJson.exists, true);
    assert.equal(body.vaultConfigJson.siteTitle, null);
    assert.match(body.vaultConfigJson.error, new RegExp(`^campaign "alpha": ${jsonPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid JSON:`));
    await c.shutdown();
  });
});

// --- FR32: only the frontmatter, never the body ----------------------------

test('FR32: a sentinel in vault-config.md\'s body is absent from the response', async (t) => {
  await withScratchOpts(
    { vaultConfigMd: '---\ntype: meta\ncampaign: Alpha\n---\n\nDO-NOT-LEAK-THIS-BODY-SENTINEL\n' },
    async ({ configPath }) => {
      const c = await launchAuthed(t, configPath);
      const body = json(await c.get('/api/state'));
      assert.equal(body.vaultConfigMd.ok, true);
      assert.ok(!body.vaultConfigMd.text.includes('DO-NOT-LEAK-THIS-BODY-SENTINEL'));
      assert.equal(body.vaultConfigMd.text, JSON.stringify({ type: 'meta', campaign: 'Alpha' }, null, 2));
      await c.shutdown();
    },
  );
});

// --- Images: listing ---------------------------------------------------

test('images: a nested image is listed, a symlink is not, a .txt is not, sorted', async (t) => {
  await withScratch(async ({ configPath, packDir }) => {
    const imagesDir = path.join(packDir, 'images');
    fs.mkdirSync(path.join(imagesDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'sub', 'nested.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(imagesDir, 'top.webp'), Buffer.from([4, 5, 6]));
    fs.writeFileSync(path.join(imagesDir, 'readme.txt'), 'not an image');
    fs.symlinkSync(path.join(imagesDir, 'top.webp'), path.join(imagesDir, 'linked.webp'));

    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state'));
    assert.deepEqual(body.images, ['sub/nested.png', 'top.webp']);
    await c.shutdown();
  });
});

test('images: a missing images/ folder gives []', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const body = json(await c.get('/api/state'));
    assert.deepEqual(body.images, []);
    await c.shutdown();
  });
});

// --- FR14 on GET /api/image ------------------------------------------------

test('FR14: a real listed image is served (positive control)', async (t) => {
  await withScratch(async ({ configPath, packDir }) => {
    const imagesDir = path.join(packDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'crest.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const c = await launchAuthed(t, configPath);
    const res = await c.get('/api/image?name=crest.png');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(res.headers['content-type'], 'image/png');
    await c.shutdown();
  });
});

test('FR14: missing name is 400 with the exact JSON body', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.get('/api/image');
    assert.equal(res.status, 400);
    assert.deepEqual(json(res), { error: 'missing name' });
    await c.shutdown();
  });
});

const fr14SentinelCases = ['../vault.config.json', '..%2fvault.config.json', '%2e%2e/pack.toml', 'images/../../x', '/etc/passwd', 'C:\\x', '\\\\srv\\x', 'crest.svg:hidden'];
for (const nameParam of fr14SentinelCases) {
  test(`FR14: ?name=${nameParam} gets 404`, async (t) => {
    await withScratch(async ({ configPath, vaultPath, packDir }) => {
      // Sentinels in the vault root, in _meta/, in the pack's css/, and beside the vault.
      fs.writeFileSync(path.join(vaultPath, 'x'), 'VAULT-ROOT-SENTINEL');
      fs.writeFileSync(path.join(vaultPath, '_meta', 'x'), 'META-SENTINEL');
      fs.mkdirSync(path.join(packDir, 'css'), { recursive: true });
      fs.writeFileSync(path.join(packDir, 'css', 'x'), 'CSS-SENTINEL');
      fs.writeFileSync(path.join(path.dirname(vaultPath), 'x'), 'BESIDE-VAULT-SENTINEL');
      fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ siteTitle: 'x' }));
      fs.mkdirSync(path.join(packDir, 'images'), { recursive: true });
      fs.writeFileSync(path.join(packDir, 'images', 'crest.svg'), '<svg></svg>');

      const c = await launchAuthed(t, configPath);
      const res = await c.get(`/api/image?name=${nameParam}`);
      assert.equal(res.status, 404, `expected 404 for name=${nameParam}, got ${res.status}`);
      const text = res.body.toString('latin1');
      assert.ok(!text.includes('VAULT-ROOT-SENTINEL'));
      assert.ok(!text.includes('META-SENTINEL'));
      assert.ok(!text.includes('CSS-SENTINEL'));
      assert.ok(!text.includes('BESIDE-VAULT-SENTINEL'));
      await c.shutdown();
    });
  });
}

test('FR14: a symlinked image file inside images/, pointing at an already-listed file, is not itself listed and is refused by name (own mutation: catches skipping the listing-membership check)', async (t) => {
  await withScratch(async ({ configPath, packDir }) => {
    const imagesDir = path.join(packDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'real.png'), Buffer.from([1, 2, 3]));
    fs.symlinkSync(path.join(imagesDir, 'real.png'), path.join(imagesDir, 'linked.png'));

    const c = await launchAuthed(t, configPath);
    const stateBody = json(await c.get('/api/state'));
    assert.deepEqual(stateBody.images, ['real.png']);

    const res = await c.get('/api/image?name=linked.png');
    assert.equal(res.status, 404, 'a symlinked image, even with a valid extension and a realpath inside images/, must be refused because it is not a listed entry');
    // Positive control: the real, listed file it points at is still served fine.
    const good = await c.get('/api/image?name=real.png');
    assert.equal(good.status, 200);
    await c.shutdown();
  });
});

// --- FR15: image bytes carry the exact sandbox CSP -------------------------

test('FR15: an SVG containing <script> is served with the exact IMAGE_CSP, nosniff, image/svg+xml', async (t) => {
  await withScratch(async ({ configPath, packDir }) => {
    const imagesDir = path.join(packDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    fs.writeFileSync(path.join(imagesDir, 'evil.svg'), svg);
    const c = await launchAuthed(t, configPath);
    const res = await c.get('/api/image?name=evil.svg');
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), svg);
    assert.equal(res.headers['content-security-policy'], IMAGE_CSP);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    await c.shutdown();
  });
});

// --- FR28: the panel check deep-equals `check --json` -----------------------

test('FR28: /api/check envelope deep-equals `check --json`, minus generatedAt', async (t) => {
  await withScratch(async ({ configPath, vaultPath }, root) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/check');
    assert.equal(res.status, 200);
    const panelBody = json(res);
    assert.equal(panelBody.exitCode, 0);

    const cliResult = run(['check', 'alpha', '--config', configPath, '--json'], { env: scratchEnv(root) });
    const cliEnvelope = JSON.parse(cliResult.stdout);

    assert.deepEqual(envelopeWithoutTimestamp(panelBody.envelope), envelopeWithoutTimestamp(cliEnvelope));
    await c.shutdown();
  });
});

// --- FR03 binding: the launch-bound vault, not a rewritten one --------------

test('FR03: rewriting config.toml after launch does not change /api/check\'s envelope.vaultPath', async (t) => {
  await withScratch(async ({ configPath, vaultPath }, root) => {
    const c = await launchAuthed(t, configPath);
    const otherVault = path.join(root, 'other-vault');
    fs.mkdirSync(path.join(otherVault, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(otherVault, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${otherVault}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    const res = await c.post('/api/check');
    const body = json(res);
    assert.equal(body.envelope.vaultPath, vaultPath);
    assert.notEqual(body.envelope.vaultPath, otherVault);
    await c.shutdown();
  });
});

// --- FR31: busy gives 409 for both check and preview ------------------------

const { createAdminContext } = require('../src/admin/context');
const { createAdminHandler } = require('../src/admin/router');
const { createToken } = require('../src/admin/session');
const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const preview = require('../src/admin/preview');

/**
 * Per the brief's own FR31 test spec: a context built directly with createAdminContext, served
 * through createAdminHandler, with ctx.busy set BEFORE any request -- deterministic, unlike
 * racing two real requests against a build fast enough to finish inside one synchronous turn.
 */
async function startCtxServer(t, configPath, { busy = null } = {}) {
  const ctxInfo = resolveCampaignContext({ config: configPath }, 'alpha');
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  const token = createToken();
  const ctx = createAdminContext({ ctxInfo, vaultPath, site, token });
  ctx.busy = busy;

  const handler = createAdminHandler(ctx);
  const server = http.createServer(handler);
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  ctx.adminPort = port;
  t.after(() => new Promise((res) => server.close(() => res())));
  // FR31's /api/preview case runs ensurePreviewRoot before the busy check (SD-7), so even a
  // refused build creates a preview root; clean it up so it does not leak past this test.
  t.after(() => preview.removePreviewRoot(ctx));

  const cookie = `scriptorium_admin_${port}=${token}`;
  return {
    ctx,
    port,
    post: (p) => request(port, { method: 'POST', path: p, headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, 'Content-Length': '0' } }),
  };
}

test('FR31: a busy panel gives 409 {error:"busy",busy} for /api/check and /api/preview', async (t) => {
  await withScratch(async ({ configPath }) => {
    const s = await startCtxServer(t, configPath, { busy: 'build' });
    const checkRes = await s.post('/api/check');
    assert.equal(checkRes.status, 409);
    assert.deepEqual(json(checkRes), { error: 'busy', busy: 'build' });

    const previewRes = await s.post('/api/preview');
    assert.equal(previewRes.status, 409);
    assert.deepEqual(json(previewRes), { error: 'busy', busy: 'build' });
  });
});

test('FR31: positive control — the same setup, not busy, is never refused', async (t) => {
  await withScratch(async ({ configPath }) => {
    const s = await startCtxServer(t, configPath, { busy: null });
    const res = await s.post('/api/check');
    assert.equal(res.status, 200);
  });
});

// --- FR11: preview origin is separate ---------------------------------------

test('FR11: after a build, preview files are served byte-equal', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const c = await launchAuthed(t, configPath);
    const buildRes = await c.post('/api/preview');
    assert.equal(json(buildRes).exitCode, 0);
    const stateBody = json(await c.get('/api/state'));
    assert.equal(stateBody.preview.built, true);
    // admin-fix-1 item 3: this test's only cleanup was c.shutdown()'s SIGINT->removePreviewRoot,
    // called at the very end -- any assertion failure before that left a real
    // /tmp/scriptorium-preview-* root behind. t.after runs regardless of pass/fail, and is a
    // harmless no-op if c.shutdown() already removed it (see the matching fix in gm-link.test.js).
    t.after(() => fs.rmSync(path.dirname(stateBody.preview.dir), { recursive: true, force: true }));
    const indexBytes = fs.readFileSync(path.join(stateBody.preview.dir, 'index.html'));
    const served = await c.previewGet('/', { Cookie: c.cookie });
    assert.equal(served.status, 200);
    assert.deepEqual(served.body, indexBytes);
    await c.shutdown();
  });
});

test('FR11: a POST whose Origin is the preview origin is refused (re-assert once)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await request(c.adminPort, {
      method: 'POST',
      path: '/api/noop',
      headers: { Cookie: c.cookie, Origin: `http://127.0.0.1:${c.previewPort}`, 'Content-Length': '0' },
    });
    assert.equal(res.status, 403);
    // Positive control: the real admin origin still works.
    const good = await c.post('/api/noop', { body: '' });
    assert.equal(good.status, 200);
    await c.shutdown();
  });
});

test('FR11: GET /api/state on the preview port gets 404', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.previewGet('/api/state', { Cookie: c.cookie });
    assert.equal(res.status, 404);
    await c.shutdown();
  });
});

// --- FR12 transport: vault-derived strings reach the UI's JSON verbatim ----

test('FR12: an XSS payload in siteTitle, a frontmatter value, an image name and a finding path all come back verbatim', async (t) => {
  const XSS = '<img src=x onerror=alert(1)>';
  await withScratchOpts(
    {
      vaultConfigJson: JSON.stringify({ siteTitle: XSS, excludeDirs: [], folderMap: {} }) + '\n',
      vaultConfigMd: `---\ntype: meta\nnote: "${XSS.replace(/"/g, '\\"')}"\n---\n\nbody\n`,
    },
    async ({ configPath, vaultPath, packDir }) => {
      const imagesDir = path.join(packDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(path.join(imagesDir, `${XSS}.png`), Buffer.from([1, 2, 3]));
      fs.writeFileSync(path.join(vaultPath, `${XSS}.md`), '---\n---\n');

      const c = await launchAuthed(t, configPath);
      const stateBody = json(await c.get('/api/state'));
      assert.equal(stateBody.vaultConfigJson.siteTitle, XSS);
      assert.equal(stateBody.vaultConfigMd.text, JSON.stringify({ type: 'meta', note: XSS }, null, 2));
      assert.ok(stateBody.images.includes(`${XSS}.png`));

      const checkBody = json(await c.post('/api/check'));
      const finding = checkBody.envelope.findings.find((f) => f.id === 'frontmatter/missing-type' && f.path === `${XSS}.md`);
      assert.ok(finding, 'expected a frontmatter/missing-type finding for the XSS-named file');
      assert.ok(finding.message.includes(XSS));
      await c.shutdown();
    },
  );
});
