'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');

/*
 * V1e-1 (ADR 0033, FR-07 to FR-10, AC-04). The real-build tagline regression: a real vault, real
 * saves through the real HTTP routes, then a real build via the real generator -- not a unit
 * test of any one module. Red at PARENT (the shipped defect): PARENT has no
 * POST /api/vault-config/tagline route at all (404), so this test cannot pass there.
 *
 * Isolation: a scratch copy of test/fixtures/vocab-vault, launched with an explicit --config
 * under this test's own scratch root; nothing here ever touches the real vault or config folder.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tagreg-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tagreg-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tagreg-sc-')), 'config.toml');

const MARKER_ALPHA = 'TaglineMarkerAlphaQ';
const MARKER_BRAVO = 'TaglineMarkerBravoQ';
const MARKER_CHARLIE = 'TaglineMarkerCharlieQ';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function withScratchVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tagreg-'));
  try {
    const fixtureSrc = path.join(__dirname, 'fixtures', 'vocab-vault');
    const vaultPath = path.join(root, 'vault');
    copyDir(fixtureSrc, vaultPath);

    const jsonPath = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    const parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    parsedJson.landingTagline = MARKER_ALPHA;
    fs.writeFileSync(jsonPath, `${JSON.stringify(parsedJson, null, 2)}\n`);

    const mdPath = path.join(vaultPath, '_meta', 'vault-config.md');
    const mdBefore = fs.readFileSync(mdPath, 'utf8');
    const mdAfter = mdBefore.replace('publish:\n  mode: full\n', `publish:\n  mode: full\n  theme:\n    tagline: ${MARKER_BRAVO}\n`);
    assert.notEqual(mdAfter, mdBefore, 'the fixture vault-config.md must still contain "publish:\\n  mode: full\\n"');
    fs.writeFileSync(mdPath, mdAfter);

    const outDir = path.join(root, 'out');
    const configDir = path.join(root, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${outDir}'`, ''].join('\n'),
    );

    return await fn({ root, vaultPath, configPath, outDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  const resultPromise = runServeCommand({ config: configPath, admin: true }, 'alpha', {
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
    shutdown: () => shutdown(s),
  };
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function countAcrossTree(dir, marker) {
  let count = 0;
  for (const file of walkFiles(dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // a binary file (e.g. a copied image) can't contain a text marker anyway
    }
    count += text.split(marker).length - 1;
  }
  return count;
}

// === AC-04: the real regression ==================================================================

test('AC-04: saving the tagline through the real chokepoint, then a real build, shows the new marker once and the old markers nowhere', async (t) => {
  await withScratchVault(async ({ configPath, outDir }) => {
    const c = await launchAuthed(t, configPath);

    const state = json(await c.get('/api/state?include=vaultconfig'));
    assert.equal(state.vaultConfigFile.tagline, MARKER_BRAVO, 'sanity: the fixture starts with Bravo as the real tagline');
    assert.equal(state.vaultConfigJson.landingTagline, MARKER_ALPHA, 'sanity: the fixture still carries the dead Alpha key');

    const dry = json(
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: MARKER_CHARLIE, baseSha256: state.vaultConfigFile.sha256, dryRun: true }) }),
    );
    assert.equal(dry.ok, true);

    const confirm = json(
      await c.post('/api/vault-config/tagline', { body: JSON.stringify({ tagline: MARKER_CHARLIE, baseSha256: state.vaultConfigFile.sha256, dryRun: false }) }),
    );
    assert.equal(confirm.ok, true);

    const afterInclude = json(await c.get('/api/state?include=vaultconfig'));
    assert.equal(afterInclude.vaultConfigFile.tagline, MARKER_CHARLIE);

    const previewRes = json(await c.post('/api/preview'));
    assert.equal(previewRes.exitCode, 0, JSON.stringify(previewRes));

    const defaultState = json(await c.get('/api/state'));
    const previewDir = defaultState.preview.dir;
    t.after(() => fs.rmSync(path.dirname(previewDir), { recursive: true, force: true }));

    const indexHtml = fs.readFileSync(path.join(previewDir, 'index.html'), 'utf8');
    const heroMatches = indexHtml.match(/<p class="hero-tagline">([^<]*)<\/p>/g) || [];
    assert.deepEqual(heroMatches, [`<p class="hero-tagline">${MARKER_CHARLIE}</p>`]);

    assert.equal(countAcrossTree(previewDir, MARKER_CHARLIE), 1);
    assert.equal(countAcrossTree(previewDir, MARKER_ALPHA), 0);
    assert.equal(countAcrossTree(previewDir, MARKER_BRAVO), 0);

    await c.shutdown();
  });
});

test('AC-04 tail: /api/pack/settings with landingTagline gives 400, and the Overview include shows the saved tagline', async (t) => {
  await withScratchVault(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const state = json(await c.get('/api/state'));
    const res = await c.post('/api/pack/settings', { body: JSON.stringify({ landingTagline: 'x', baseSha256: state.vaultConfigJson.sha256 }) });
    assert.equal(res.status, 400);
    assert.deepEqual(json(res), { error: 'invalid', message: 'unknown field: landingTagline' });

    const withInclude = json(await c.get('/api/state?include=vaultconfig'));
    assert.equal(withInclude.vaultConfigFile.tagline, MARKER_BRAVO);
    await c.shutdown();
  });
});
