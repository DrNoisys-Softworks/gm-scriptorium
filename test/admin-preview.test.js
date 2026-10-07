'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const { runCheckForContext } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');
const preview = require('../src/admin/preview');
const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');

/*
 * Phase 8 slice S2 (docs/agent-runs/admin-s2-engineering-brief-2026-09-28.md, "Test-first order"
 * item 3). NFR02's fresh-process comparison is the only place this file spawns a subprocess; the
 * 3 preview builds it compares against run in this SAME process, which is the whole point of the
 * test. Synthetic cast only (NFR-10/NFR-11); test/fixtures/vocab-vault is copied to scratch
 * first, never written to in place.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-preview-'));
  try {
    const vaultPath = path.join(root, 'vocab-vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    return await fn({ vaultPath, packDir, configPath }, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeCtx(configPath) {
  const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  return createAdminContext({ ctxInfo, vaultPath, site, token: 'TOK' });
}

/** Every relative file path under `dir`, sorted, POSIX separators. */
function listTree(dir) {
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

function assertTreesByteIdentical(dirA, dirB) {
  const a = listTree(dirA);
  const b = listTree(dirB);
  assert.deepEqual(a, b, 'the two trees do not have the same file list');
  for (const rel of a) {
    assert.deepEqual(fs.readFileSync(path.join(dirA, rel)), fs.readFileSync(path.join(dirB, rel)), `byte mismatch at ${rel}`);
  }
}

// --- NFR02: preview fidelity ------------------------------------------------

test('NFR02: the 3rd in-process preview build equals a fresh-process build, with a theme change and a label change between builds', async () => {
  await withVocabVault(async ({ packDir, configPath }, root) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const build1 = preview.runPreviewBuild(ctx);
      assert.equal(build1.exitCode, 0, build1.human);

      const tomlPath = path.join(packDir, 'pack.toml');
      let tomlText = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(tomlText.includes('theme = "plain"'));
      fs.writeFileSync(tomlPath, tomlText.replace('theme = "plain"', 'theme = "haze"'));

      const build2 = preview.runPreviewBuild(ctx);
      assert.equal(build2.exitCode, 0, build2.human);

      tomlText = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(tomlText.includes('connections_heading = "Ties and threads"'));
      fs.writeFileSync(tomlPath, tomlText.replace('connections_heading = "Ties and threads"', 'connections_heading = "Bonds"'));

      const build3 = preview.runPreviewBuild(ctx);
      assert.equal(build3.exitCode, 0, build3.human);

      const freshOut = path.join(root, 'fresh-out');
      const freshResult = run(['build', 'vocab', '--config', configPath, '--out', freshOut], { env: scratchEnv(root) });
      assert.equal(freshResult.status, 0, freshResult.stderr);

      assertTreesByteIdentical(ctx.previewDir, freshOut);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- FR29: a refused preview build leaves the previous preview intact -----

test('FR29: a vault with an ERROR finding refuses the preview build; the previous preview stays byte-identical', async () => {
  await withVocabVault(async ({ vaultPath, configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    let before;
    try {
      const build1 = preview.runPreviewBuild(ctx);
      assert.equal(build1.exitCode, 0, build1.human);

      before = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-preview-snapshot-'));
      fs.cpSync(ctx.previewDir, before, { recursive: true });

      fs.writeFileSync(path.join(vaultPath, '_meta', 'stray.md'), '---\n---\n');

      const build2 = preview.runPreviewBuild(ctx);
      assert.equal(build2.exitCode, 2);
      assert.ok(
        build2.envelope.check.findings.some((f) => f.id === 'frontmatter/missing-type' && f.path === '_meta/stray.md'),
        `expected a frontmatter/missing-type finding for _meta/stray.md; got: ${JSON.stringify(build2.envelope.check.findings.map((f) => f.id))}`,
      );
      assertTreesByteIdentical(ctx.previewDir, before);
    } finally {
      if (before) fs.rmSync(before, { recursive: true, force: true });
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- Location ---------------------------------------------------------------

test('location: the preview dir is under os.tmpdir(), not inside the vault, and its parent differs from the configured output\'s parent', async () => {
  await withVocabVault(async ({ vaultPath, configPath }, root) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const realTmp = fs.realpathSync(os.tmpdir());
      assert.ok(path.resolve(ctx.previewDir).startsWith(realTmp + path.sep) || path.resolve(ctx.previewDir).startsWith(os.tmpdir() + path.sep));
      assert.ok(!path.resolve(ctx.previewDir).startsWith(path.resolve(vaultPath) + path.sep));

      const configuredOutput = path.resolve(root, 'out');
      // "Never a sibling of the configured output" means the ROOT itself (ctx.previewRoot, the
      // mkdtemp'd dir, whose own dirname is normally os.tmpdir()) must not share a parent with
      // the configured output -- not merely that previewDir's own dirname (= previewRoot)
      // differs textually from configuredOutput's dirname, which is true even when previewRoot
      // has been nested one level inside dirname(configuredOutput) (M3's mutation).
      assert.notEqual(path.dirname(ctx.previewRoot), path.dirname(configuredOutput));
      assert.notEqual(path.dirname(path.resolve(ctx.previewDir)), path.dirname(configuredOutput));
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('location: SD-3 fails closed when the preview root would equal the configured output\'s parent', async () => {
  await withVocabVault(async ({ configPath }, root) => {
    // mkdtempSync's random suffix means the real code path can never actually land the new
    // root on a pre-existing directory; monkeypatching fs.mkdtempSync (precedent:
    // test/build-output-gate.test.js's fs.rmSync injection) is the only way to exercise the
    // fail-closed branch deterministically -- proving the check is live, not just that a normal
    // preview root happens to avoid it (mutation M3's inverse).
    const configuredOutputParent = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-preview-collide-'));
    const collidingConfigPath = path.join(root, 'colliding-config.toml');
    const ctxInfoRaw = resolveCampaignContext({ config: configPath }, 'vocab');
    fs.writeFileSync(
      collidingConfigPath,
      [
        'config_version = 1',
        'default_campaign = "vocab"',
        '',
        '[campaigns.vocab]',
        `vault = '${ctxInfoRaw.vault}'`,
        `output = '${path.join(configuredOutputParent, 'site')}'`,
        '',
      ].join('\n'),
    );
    const ctx = makeCtx(collidingConfigPath);

    const originalMkdtempSync = fs.mkdtempSync;
    fs.mkdtempSync = () => configuredOutputParent;
    try {
      assert.throws(() => preview.ensurePreviewRoot(ctx), /refusing to use/);
    } finally {
      fs.mkdtempSync = originalMkdtempSync;
      fs.rmSync(configuredOutputParent, { recursive: true, force: true });
    }
  });
});

// --- Shutdown ----------------------------------------------------------------

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

function tokenFromLine(line) {
  return line.match(/token=([A-Za-z0-9_-]{43})$/)[1];
}

function httpPost(port, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGet(port, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Returns { s, previewRoot }. previewRoot is read back from /api/state's own preview.dir field
 * rather than scanning os.tmpdir() for the "scriptorium-preview-" prefix: node --test runs test
 * FILES concurrently by default, and test/admin-views.test.js's own FR11 test also drives a real
 * /api/preview build in the SAME shared os.tmpdir(), so a directory-listing diff race-conditions
 * against a completely unrelated file's test.
 */
async function launchAndBuildOnePreview(t, configPath) {
  const s = await waitForHandles(launch(t, configPath));
  const adminPort = s.handles[0].port;
  const token = tokenFromLine(s.emitted[0]);
  const cookie = `scriptorium_admin_${adminPort}=${token}`;
  const buildRes = await httpPost(adminPort, '/api/preview', { Cookie: cookie, Origin: `http://127.0.0.1:${adminPort}`, 'Content-Length': '0' });
  assert.equal(buildRes.status, 200);
  const stateRes = await httpGet(adminPort, '/api/state', { Cookie: cookie });
  const state = JSON.parse(stateRes.body.toString('utf8'));
  assert.equal(state.preview.built, true);
  const previewRoot = path.dirname(state.preview.dir);
  return { s, previewRoot };
}

test('shutdown, normal case: the preview root is gone afterwards', async (t) => {
  await withVocabVault(async ({ configPath }) => {
    const { s, previewRoot } = await launchAndBuildOnePreview(t, configPath);
    assert.ok(fs.existsSync(previewRoot), 'expected the preview root to exist right after a build');

    s.signals.emit('SIGINT');
    const result = await s.resultPromise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.human, 'stopped.');

    assert.ok(!fs.existsSync(previewRoot), `expected ${previewRoot} to be removed after SIGINT`);
  });
});

test('shutdown with EBUSY: SIGINT still resolves {exitCode:0, human:"stopped."}, and the patch was called', async (t) => {
  await withVocabVault(async ({ configPath }) => {
    const { s, previewRoot } = await launchAndBuildOnePreview(t, configPath);

    const originalRmSync = fs.rmSync;
    let patchCalled = false;
    fs.rmSync = (target, opts) => {
      if (String(target) === previewRoot) {
        patchCalled = true;
        const err = new Error(`EBUSY: resource busy or locked, rmdir '${target}'`);
        err.code = 'EBUSY';
        throw err;
      }
      return originalRmSync(target, opts);
    };

    let result;
    try {
      s.signals.emit('SIGINT');
      result = await s.resultPromise;
    } finally {
      fs.rmSync = originalRmSync;
    }

    assert.equal(result.exitCode, 0);
    assert.equal(result.human, 'stopped.');
    assert.equal(patchCalled, true, 'expected the EBUSY-throwing fs.rmSync patch to actually be reached');

    // The whole point of this test is that removal genuinely failed (EBUSY, swallowed, exit
    // code unchanged) -- so, unlike the normal-case test, the dir is still here. Clean it up by
    // hand now that the patch is restored, rather than leaving it for the OS to reap.
    assert.ok(fs.existsSync(previewRoot), 'expected the preview root to still exist: removal was made to fail');
    fs.rmSync(previewRoot, { recursive: true, force: true });
  });
});

// --- NFR08: console silence during a check and a preview build --------------

test('NFR08: zero console/stderr writes across one check and one preview build', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);

    const calls = [];
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      stderrWrite: process.stderr.write,
    };
    console.log = (...a) => calls.push(['log', a]);
    console.info = (...a) => calls.push(['info', a]);
    console.warn = (...a) => calls.push(['warn', a]);
    console.error = (...a) => calls.push(['error', a]);
    process.stderr.write = (...a) => {
      calls.push(['stderr.write', a]);
      return true;
    };

    try {
      const checkResult = runCheckForContext(ctx.ctxInfo, {}, {});
      assert.equal(checkResult.exitCode, 0, checkResult.human);
      const buildResult = preview.runPreviewBuild(ctx);
      assert.equal(buildResult.exitCode, 0, buildResult.human);
    } finally {
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
      process.stderr.write = originals.stderrWrite;
      preview.removePreviewRoot(ctx);
    }

    assert.deepEqual(calls, []);
  });
});
