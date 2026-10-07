'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');
const preview = require('../src/admin/preview');
const gmlink = require('../src/admin/gmlink');
const { GM_LINK_MARKER } = require('../src/build/gmmarker');

/*
 * Phase 8 slice S6 (docs/agent-runs/admin-s6-engineering-brief-2026-09-28.md, "Test-first order"
 * item 3). FR33: the GM link, through the real build pipeline and the real writer module.
 * Synthetic cast only (NFR-10/NFR-11); test/fixtures/vocab-vault is copied to scratch first,
 * never written to in place. The HTTP harness below mirrors test/admin-views.test.js's own
 * launch()/launchAuthed() (not imported: "no shared test-helper module" per the orchestrator
 * notes for S4/S5/S6).
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

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

async function withVocabVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-'));
  try {
    const vaultPath = path.join(root, 'vocab-vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    return await fn({ vaultPath, configPath }, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeCtx(configPath) {
  const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  const ctx = createAdminContext({ ctxInfo, vaultPath, site, token: 'TOK' });
  // These tests never open a real socket: adminPort is a synthetic-but-valid stand-in for the
  // real bound port a running panel would set (src/cli/serve-admin.js:78), which SD-4's
  // precondition requires.
  ctx.adminPort = 4321;
  return ctx;
}

/** Every relative file path under `dir`, sorted, POSIX separators. */
function listAllFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  })(dir, '');
  out.sort();
  return out;
}

function listHtmlFiles(dir) {
  return listAllFiles(dir).filter((rel) => rel.endsWith('.html'));
}

function countBodyPages(dir) {
  let count = 0;
  for (const rel of listHtmlFiles(dir)) {
    if (fs.readFileSync(path.join(dir, rel), 'utf8').includes('</body>')) count++;
  }
  return count;
}

// --- HTTP harness (mirrors test/admin-views.test.js's own launch()/launchAuthed()) -----------

function launch(t, configPath, extraFlags = {}) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true, ...extraFlags }, 'vocab', {
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
  const previewPort = s.handles[1].port;
  const authResult = await request(adminPort, { path: `/auth?token=${tokenFromLine(s.emitted[0])}` });
  const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];
  const token = cookieHeader.split('=').slice(1).join('=');
  return {
    adminPort,
    previewPort,
    cookie: cookieHeader,
    token,
    get: (p) => request(adminPort, { path: p, headers: { Cookie: cookieHeader } }),
    post: (p, opts = {}) =>
      request(adminPort, {
        method: 'POST',
        path: p,
        headers: { Cookie: cookieHeader, Origin: `http://127.0.0.1:${adminPort}`, 'Content-Length': '0', ...(opts.headers || {}) },
        body: opts.body,
      }),
    shutdown: () => shutdown(s),
  };
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

// === A. Build and inject, through the real HTTP pipeline ===================

test('FR33: POST /api/preview injects exactly one GM link per </body> page, pointing at the admin root, with no token anywhere', async (t) => {
  await withVocabVault(async ({ configPath }, root) => {
    const c = await launchAuthed(t, configPath);
    const buildRes = await c.post('/api/preview');
    assert.equal(json(buildRes).exitCode, 0, JSON.stringify(json(buildRes)));

    const stateBody = json(await c.get('/api/state'));
    assert.equal(stateBody.preview.built, true);
    const previewDir = stateBody.preview.dir;
    // admin-fix-1 item 3: this test's only cleanup was c.shutdown()'s SIGINT->removePreviewRoot,
    // called at the very end -- any assertion failure between here and there left the real
    // /tmp/scriptorium-preview-* root behind (QA found 16; two of them still carried the GM-link
    // marker, matching this test and admin-views.test.js's FR11 preview test, the two places that
    // build through buildPreviewWithGmLink over HTTP with no guaranteed teardown). t.after runs
    // regardless of pass/fail, and is a harmless no-op if c.shutdown() already removed it.
    t.after(() => fs.rmSync(path.dirname(previewDir), { recursive: true, force: true }));

    const htmlFiles = listHtmlFiles(previewDir);
    let bodyPages = 0;
    for (const rel of htmlFiles) {
      const html = fs.readFileSync(path.join(previewDir, rel), 'utf8');
      if (!html.includes('</body>')) continue;
      bodyPages++;
      const matches = html.match(new RegExp(GM_LINK_MARKER, 'g')) || [];
      assert.equal(matches.length, 1, `expected exactly one marker in ${rel}, found ${matches.length}`);
      assert.match(html, new RegExp(`href="http://127\\.0\\.0\\.1:${c.adminPort}/"`), `expected the GM link href in ${rel}`);
    }
    assert.ok(bodyPages > 0, 'expected at least one page with </body> in the fixture');

    // The page count must be compared to a FRESH spawnSync CLI build of the same vault, not to
    // the preview's own page count (CLAUDE.md's "tests that pass today and prove nothing").
    const freshOut = path.join(root, 'fresh-out');
    const freshRes = run(['build', 'vocab', '--config', configPath, '--out', freshOut], { env: scratchEnv(root) });
    assert.equal(freshRes.status, 0, freshRes.stderr);
    assert.equal(bodyPages, countBodyPages(freshOut));

    for (const rel of htmlFiles) {
      assert.ok(!fs.readFileSync(path.join(previewDir, rel), 'utf8').includes(c.token), `token leaked into ${rel}`);
    }

    await c.shutdown();
  });
});

// === B. NFR02 with the link =================================================

test('AC-05 (NFR02 with the link): a preview tree, minus the exact GM-link snippet, byte-equals a fresh-process CLI build', async () => {
  await withVocabVault(async ({ configPath }, root) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const build1 = preview.buildPreviewWithGmLink(ctx);
      assert.equal(build1.exitCode, 0, build1.human);

      const freshOut = path.join(root, 'fresh-out');
      const freshRes = run(['build', 'vocab', '--config', configPath, '--out', freshOut], { env: scratchEnv(root) });
      assert.equal(freshRes.status, 0, freshRes.stderr);

      const previewFiles = listAllFiles(ctx.previewDir);
      const freshFiles = listAllFiles(freshOut);
      assert.deepEqual(previewFiles, freshFiles, 'the two trees do not have the same file list');

      const snippet = gmlink.gmLinkSnippet(gmlink.gmLinkHref(ctx.adminPort));
      for (const rel of previewFiles) {
        if (rel.endsWith('.html')) {
          const previewText = fs.readFileSync(path.join(ctx.previewDir, rel), 'utf8');
          const stripped = previewText.split(snippet).join('');
          const freshText = fs.readFileSync(path.join(freshOut, rel), 'utf8');
          assert.equal(stripped, freshText, `byte mismatch (after stripping the GM-link snippet) at ${rel}`);
        } else {
          assert.deepEqual(
            fs.readFileSync(path.join(ctx.previewDir, rel)),
            fs.readFileSync(path.join(freshOut, rel)),
            `byte mismatch at ${rel}`,
          );
        }
      }
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// === C. Idempotence ==========================================================

test('idempotence: a second injectGmLinks on the same tree gives pagesLinked:0, and each page still has exactly one link', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const build1 = preview.buildPreviewWithGmLink(ctx);
      assert.equal(build1.exitCode, 0, build1.human);

      const second = gmlink.injectGmLinks(ctx);
      assert.equal(second.pagesLinked, 0);

      for (const rel of listHtmlFiles(ctx.previewDir)) {
        const html = fs.readFileSync(path.join(ctx.previewDir, rel), 'utf8');
        if (!html.includes('</body>')) continue;
        const matches = html.match(new RegExp(GM_LINK_MARKER, 'g')) || [];
        assert.equal(matches.length, 1, `expected exactly one marker in ${rel} after a second injection pass`);
      }
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// === D. A page with no </body> is left alone ================================

test("a hand-added page with no </body> (nobody.html) stays byte-identical across an injection pass", async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const build1 = preview.buildPreviewWithGmLink(ctx);
      assert.equal(build1.exitCode, 0, build1.human);

      const nobodyPath = path.join(ctx.previewDir, 'nobody.html');
      const nobodyContent = '<html><head><title>no body tag here</title></head></html>';
      fs.writeFileSync(nobodyPath, nobodyContent);

      gmlink.injectGmLinks(ctx);

      assert.equal(fs.readFileSync(nobodyPath, 'utf8'), nobodyContent);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// === E. Writer containment, direction-sensitive =============================

test('writer containment: a symlinked directory inside the preview tree pointing at an ancestor (ctx.previewRoot) leaves a sentinel inside it unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-containment-'));
  try {
    const previewRoot = path.join(root, 'proot');
    const previewDir = path.join(previewRoot, 'site');
    fs.mkdirSync(previewDir, { recursive: true });
    const sentinelPath = path.join(previewRoot, 'sentinel.html');
    const sentinelContent = '<html><body>sentinel</body></html>';
    fs.writeFileSync(sentinelPath, sentinelContent);
    // A symlinked directory inside previewDir pointing back up at previewRoot (an ancestor):
    // the ONLY way the walker could reach the sentinel above is by following this symlink.
    fs.symlinkSync(previewRoot, path.join(previewDir, 'loop'), 'dir');

    const ctx = { previewRoot, previewDir, adminPort: 4321 };
    gmlink.injectGmLinks(ctx);

    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinelContent, 'the walker must never follow a symlink back out to an ancestor');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer containment: a symlinked .html file pointing outside the preview tree leaves its target unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-containment-'));
  try {
    const previewRoot = path.join(root, 'proot');
    const previewDir = path.join(previewRoot, 'site');
    fs.mkdirSync(previewDir, { recursive: true });
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'external.html');
    const outsideContent = '<html><body>external</body></html>';
    fs.writeFileSync(outsideFile, outsideContent);
    fs.symlinkSync(outsideFile, path.join(previewDir, 'linked.html'), 'file');

    const ctx = { previewRoot, previewDir, adminPort: 4321 };
    gmlink.injectGmLinks(ctx);

    assert.equal(fs.readFileSync(outsideFile, 'utf8'), outsideContent, 'the walker must never write through a symlink to outside the preview tree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer containment: ctx.previewDir === ctx.previewRoot (ancestor) throws', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-containment-'));
  try {
    const previewRoot = path.join(root, 'proot');
    fs.mkdirSync(previewRoot, { recursive: true });
    const ctx = { previewRoot, previewDir: previewRoot, adminPort: 4321 };
    assert.throws(() => gmlink.injectGmLinks(ctx), /ScriptoriumError|previewDir/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writer containment: ctx.previewDir as a prefix-named sibling of ctx.previewRoot (previewRoot + '-x/site') throws", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-containment-'));
  try {
    const previewRoot = path.join(root, 'proot');
    const previewDir = `${previewRoot}-x${path.sep}site`;
    fs.mkdirSync(previewRoot, { recursive: true });
    fs.mkdirSync(previewDir, { recursive: true });
    const ctx = { previewRoot, previewDir, adminPort: 4321 };
    assert.throws(() => gmlink.injectGmLinks(ctx), /ScriptoriumError|previewDir/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer containment positive control: a real nested folder page gets the link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-containment-'));
  try {
    const previewRoot = path.join(root, 'proot');
    const previewDir = path.join(previewRoot, 'site');
    fs.mkdirSync(path.join(previewDir, 'nested', 'deeper'), { recursive: true });
    const pagePath = path.join(previewDir, 'nested', 'deeper', 'page.html');
    fs.writeFileSync(pagePath, '<html><body>hi</body></html>');

    const ctx = { previewRoot, previewDir, adminPort: 4321 };
    const result = gmlink.injectGmLinks(ctx);

    assert.equal(result.pagesLinked, 1);
    const html = fs.readFileSync(pagePath, 'utf8');
    assert.ok(html.includes(GM_LINK_MARKER));
    assert.ok(html.includes('http://127.0.0.1:4321/'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === F. A refused build injects nothing =====================================

test('FR29: a refused build injects nothing, and the previous preview stays byte-identical', async () => {
  await withVocabVault(async ({ vaultPath, configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    let before;
    try {
      const build1 = preview.buildPreviewWithGmLink(ctx);
      assert.equal(build1.exitCode, 0, build1.human);

      before = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-snapshot-'));
      fs.cpSync(ctx.previewDir, before, { recursive: true });

      fs.writeFileSync(path.join(vaultPath, '_meta', 'stray.md'), '---\n---\n');

      const build2 = preview.buildPreviewWithGmLink(ctx);
      assert.equal(build2.exitCode, 2);

      const beforeFiles = listAllFiles(before);
      const afterFiles = listAllFiles(ctx.previewDir);
      assert.deepEqual(beforeFiles, afterFiles, 'the preview tree must be untouched by a refused build');
      for (const rel of beforeFiles) {
        assert.deepEqual(
          fs.readFileSync(path.join(before, rel)),
          fs.readFileSync(path.join(ctx.previewDir, rel)),
          `byte mismatch at ${rel}`,
        );
      }
    } finally {
      if (before) fs.rmSync(before, { recursive: true, force: true });
      preview.removePreviewRoot(ctx);
    }
  });
});

// === G. The link opens the panel ============================================

test('the link opens the panel: a GET to the href found in an injected page, with the cookie, returns 200 with the panel shell', async (t) => {
  await withVocabVault(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const buildRes = await c.post('/api/preview');
    assert.equal(json(buildRes).exitCode, 0);

    const stateBody = json(await c.get('/api/state'));
    const indexHtml = fs.readFileSync(path.join(stateBody.preview.dir, 'index.html'), 'utf8');
    const hrefMatch = indexHtml.match(/data-scriptorium-gm-link[^>]*>\s*<p><a href="([^"]+)"/);
    assert.ok(hrefMatch, 'expected to find the GM link href in the preview index page');
    assert.equal(hrefMatch[1], `http://127.0.0.1:${c.adminPort}/`);

    const opened = await c.get('/');
    assert.equal(opened.status, 200);
    assert.match(opened.body.toString('utf8'), /data-section="views"/);

    await c.shutdown();
  });
});
