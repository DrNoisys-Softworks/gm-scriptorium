'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');
const { runBuildCommand } = require('../src/cli/build');
const { parsePackToml } = require('../src/build/packtoml');
const { THEMES } = require('../src/build/themes');
const read = require('../src/vault/read');
const variants = require('../src/admin/variants');
const preview = require('../src/admin/preview');
const freshness = require('../src/admin/freshness');
const packfiles = require('../src/admin/packfiles');
const packedit = require('../src/admin/packedit');
const pack = require('../src/admin/handlers/pack');
const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');

/*
 * V1e-7 (ADR 0039, SD-61 to SD-65, amended by Amendment A). Ctx-level tests of the variant
 * build/cap/removal machinery, plus a real-socket theme round against the admin server.
 * Synthetic cast only; test/fixtures/vocab-vault is copied to scratch, never written in place.
 */

const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

async function withVocabVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variants-'));
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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A full manifest of every file under the vault: relative path, size, sha256. */
function vaultManifest(vaultPath) {
  return listTree(vaultPath).map((rel) => {
    const buf = fs.readFileSync(path.join(vaultPath, rel));
    return { rel, size: buf.length, sha256: sha256(buf) };
  });
}

// --- 1. Ids ------------------------------------------------------------------------------------

test('VARIANT_IDS is the typed literal, in registry-then-vocab order; Object.keys(THEMES) never gains an own "vocab" key', () => {
  assert.deepEqual(variants.VARIANT_IDS, ['plain', 'haze', 'gloam', 'vocab']);
  assert.ok(!Object.prototype.hasOwnProperty.call(THEMES, 'vocab'));
});

test('isVariantId refuses non-members, including prototype-pollution-shaped and traversal-shaped strings', () => {
  for (const bad of ['gloamx', 'glo', '', 'constructor', '__proto__', '../gloam', 'Gloam', 42, null, undefined, {}]) {
    assert.equal(variants.isVariantId(bad), false, JSON.stringify(bad));
  }
  for (const good of variants.VARIANT_IDS) {
    assert.equal(variants.isVariantId(good), true, good);
  }
});

// --- isStrictlyInside table ---------------------------------------------------------------------

test('isStrictlyInside: ancestor-direction and string-prefix-sibling table', () => {
  assert.equal(variants.isStrictlyInside('/a/b', '/a/b/c'), true);
  assert.equal(variants.isStrictlyInside('/a/b', '/a/b'), false);
  assert.equal(variants.isStrictlyInside('/a/b', '/a'), false);
  assert.equal(variants.isStrictlyInside('/a/b', '/a/bc/d'), false);
  assert.equal(variants.isStrictlyInside('/a/b', '/a/b/../x'), false);
});

// --- 2. buildVariant: the fonts literal and the pack-relative slot (moved here by Amendment A) --

test('buildVariant(gloam) has the gloam font and theme CSS; the disk pack.toml still says plain, and a normal build has neither', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const outcome = variants.buildVariant(ctx, 'gloam', 'theme = "gloam"\n');
      assert.equal(outcome.result.exitCode, 0, outcome.result.human);
      const dir = variants.variantDirFor(ctx, 'gloam');
      assert.ok(fs.existsSync(path.join(dir, 'scriptorium', 'theme', 'fonts', 'IMFeENrm28P.woff2')));
      assert.ok(fs.existsSync(path.join(dir, 'css', 'scriptorium-theme.css')));

      const onDisk = packfiles.readPackFile(ctx, 'pack.toml');
      assert.ok(onDisk.raw.toString('utf8').includes('plain'));

      const normalOut = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variants-normal-'));
      try {
        const normal = runBuildCommand({ config: configPath, out: normalOut }, 'vocab');
        assert.equal(normal.exitCode, 0, normal.human);
        assert.ok(!fs.existsSync(path.join(normalOut, 'scriptorium', 'theme', 'fonts', 'IMFeENrm28P.woff2')));
        assert.ok(!fs.existsSync(path.join(normalOut, 'css', 'scriptorium-theme.css')));
      } finally {
        fs.rmSync(normalOut, { recursive: true, force: true });
      }
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('buildVariant: a pack-relative image slot resolves against the real pack folder, while the disk pack.toml has no [images]', async () => {
  await withVocabVault(async ({ packDir, configPath }) => {
    const ctx = makeCtx(configPath);
    const bannerBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    fs.mkdirSync(path.join(packDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'images', 'banner.png'), bannerBytes);
    preview.ensurePreviewRoot(ctx);
    try {
      const candidate = 'theme = "plain"\n[images]\nhero = "images/banner.png"\n';
      const outcome = variants.buildVariant(ctx, 'plain', candidate);
      assert.equal(outcome.result.exitCode, 0, outcome.result.human);
      const dir = variants.variantDirFor(ctx, 'plain');
      assert.deepEqual(fs.readFileSync(path.join(dir, 'scriptorium', 'slots', 'hero.png')), bannerBytes);

      const onDisk = packfiles.readPackFile(ctx, 'pack.toml');
      assert.ok(!onDisk.raw.toString('utf8').includes('[images]'));
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('buildVariant: candidateReads === 2 (one from the build\'s own resolveVaultContext, one from the pre-check\'s)', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const outcome = variants.buildVariant(ctx, 'haze', 'theme = "haze"\n');
      assert.equal(outcome.result.exitCode, 0, outcome.result.human);
      // If S3 or V1e-9 changes how many times pack.toml is read per build, this literal must be
      // re-measured and this comment updated with why.
      assert.equal(outcome.candidateReads, 2);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('buildVariant: the guard refuses a build that never read the candidate, removes the copy and keeps no record', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const real = read.withCandidateFile;
      read.withCandidateFile = function (absPath, bytes, fn) {
        return real.call(read, absPath + '.not-read', bytes, fn);
      };
      try {
        assert.throws(
          () => variants.buildVariant(ctx, 'plain', 'theme = "plain"\n'),
          /did not read the candidate pack\.toml/,
        );
      } finally {
        read.withCandidateFile = real;
      }
      assert.ok(!fs.existsSync(path.join(ctx.previewRoot, 'variants', 'plain')));
      assert.equal(Boolean(ctx.variants && ctx.variants.has('plain')), false);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('themeVariant (via the handler helper) refuses with a typed message when pack.toml does not exist on disk yet, and touches nothing', async () => {
  const handlers = require('../src/admin/handlers/variants');
  await withVocabVault(async ({ packDir, vaultPath, configPath }) => {
    fs.rmSync(path.join(packDir, 'pack.toml'));
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const manifestBefore = vaultManifest(vaultPath);
      const req = { headers: { 'content-length': '18' }, on() {}, removeListener() {} };
      // Build the body ourselves and call the handler's own body reader with a stub stream.
      const bodyBuf = Buffer.from(JSON.stringify({ theme: 'haze' }));
      const fakeReq = fakeBodyStream(bodyBuf);
      const res = fakeRes();
      await handlers.buildTheme(fakeReq, res, ctx);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'invalid');
      assert.match(res.json.message, /Save a theme first/);
      assert.ok(!fs.existsSync(path.join(ctx.previewRoot, 'variants')));
      assert.deepEqual(vaultManifest(vaultPath), manifestBefore);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// A minimal fake req/res pair for calling handlers.buildTheme directly without a real socket.
function fakeBodyStream(buf) {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    headers: { 'content-length': String(buf.length) },
    resume() {
      // body.js drains-and-discards on an over-cap Content-Length; nothing to drain here.
    },
  });
  setImmediate(() => {
    emitter.emit('data', buf);
    emitter.emit('end');
  });
  return req;
}
function fakeRes() {
  const res = {
    status: null,
    headers: null,
    json: null,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      if (body !== undefined) {
        try {
          res.json = JSON.parse(body.toString());
        } catch {
          res.text = body.toString();
        }
      }
    },
  };
  return res;
}

// --- 3. The theme round over HTTP, the vault untouched, equivalence ----------------------------

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
        // already closed
      }
    }
  });
  return { resultPromise, handles, emitted, signals };
}
function waitForMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}
async function waitForHandles(state) {
  while (state.handles.length < 2) await waitForMacrotask();
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
function postJson(port, cookie, origin, reqPath, obj) {
  const body = JSON.stringify(obj);
  return request(port, {
    method: 'POST',
    path: reqPath,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  });
}

test('the theme round over HTTP: plain/haze/gloam each 200 exitCode 0, the right tree literals, no GM link, and the vault manifest is unchanged', async (t) => {
  await withVocabVault(async ({ vaultPath, configPath }) => {
    const manifestBefore = vaultManifest(vaultPath);
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;
    const origin = `http://127.0.0.1:${adminPort}`;

    const trees = {};
    for (const name of ['plain', 'haze', 'gloam']) {
      const res = await postJson(adminPort, cookie, origin, '/api/variants/theme', { theme: name });
      assert.equal(res.status, 200, res.body.toString());
      const parsed = JSON.parse(res.body.toString());
      assert.equal(parsed.exitCode, 0, parsed.human);
      trees[name] = parsed;
    }

    const stateRes = await request(adminPort, { path: '/api/state?include=variants', headers: { Cookie: cookie } });
    const stateBody = JSON.parse(stateRes.body.toString());
    const configuredOutput = path.join(path.dirname(configPath), 'out');
    assert.ok(!fs.existsSync(configuredOutput), 'the configured output must never be created');

    await shutdown(state);

    // The config.toml's `output` directory's own PARENT listing is unchanged: scratch root holds
    // only vocab-vault and config.toml (never a new sibling directory from a variant build).
    const rootListing = fs.readdirSync(path.dirname(configPath)).sort();
    assert.deepEqual(rootListing, ['config.toml', 'vocab-vault']);

    assert.deepEqual(vaultManifest(vaultPath), manifestBefore);
    assert.ok(stateBody.variants.items.every((it) => !['plain', 'haze', 'gloam'].includes(it.id) || it.built === true));
  });
});

test('no copy ever carries the GM link marker', async (t) => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      variants.buildVariant(ctx, 'plain', 'theme = "plain"\n');
      const dir = variants.variantDirFor(ctx, 'plain');
      const indexHtml = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
      assert.ok(!indexHtml.includes('scriptorium-gm-link'));
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('equivalence: the plain (in-use) copy equals a CLI build; the haze copy equals a CLI build of a second vault really saved to haze', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    // Own parent dir (issue #102): a build stages in a SIBLING of its output, so an output sitting
    // directly in os.tmpdir() shares a staging parent with every other parallel test file.
    const cliOutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variants-cli-'));
    const cliOut = path.join(cliOutRoot, 'out');
    try {
      // The candidate is the save path's own dry-run text (editPackTomlTheme over the real
      // on-disk raw bytes), so it carries the vault's real [labels]/[timeline]/[recaps] tables
      // forward -- a bare `theme = "plain"\n` literal would drop them and legitimately diverge
      // from a real build's output (that literal is only valid for tests that don't compare
      // against a real build byte-for-byte, e.g. the fonts-literal test above).
      const curPlain = packfiles.readPackFile(ctx, 'pack.toml');
      const candidatePlain = packedit.editPackTomlTheme(curPlain.raw.toString('utf8'), 'plain');
      const plainOutcome = variants.buildVariant(ctx, 'plain', candidatePlain);
      assert.equal(plainOutcome.result.exitCode, 0, plainOutcome.result.human);
      const cli = runBuildCommand({ config: configPath, out: cliOut }, 'vocab');
      assert.equal(cli.exitCode, 0, cli.human);
      assertTreesByteIdentical(variants.variantDirFor(ctx, 'plain'), cliOut);
    } finally {
      preview.removePreviewRoot(ctx);
      fs.rmSync(cliOutRoot, { recursive: true, force: true });
    }
  });
  await withVocabVault(async ({ configPath: configPathA }) => {
    const ctxA = makeCtx(configPathA);
    preview.ensurePreviewRoot(ctxA);
    try {
      const curHaze = packfiles.readPackFile(ctxA, 'pack.toml');
      const candidateHaze = packedit.editPackTomlTheme(curHaze.raw.toString('utf8'), 'haze');
      const hazeOutcome = variants.buildVariant(ctxA, 'haze', candidateHaze);
      assert.equal(hazeOutcome.result.exitCode, 0, hazeOutcome.result.human);

      await withVocabVault(async ({ configPath: configPathB }) => {
        const ctxB = makeCtx(configPathB);
        // A REAL save, through the exact same write path POST /api/pack/theme uses (step 5-11 of
        // buildAndWrite), with dryRun:false: this really writes pack.toml to the second scratch
        // vault, never the panel's own HTTP layer (equivalent, not a shortcut: the mechanism
        // under test is the build pipeline, not body-parsing).
        const cur = packfiles.readPackFile(ctxB, 'pack.toml');
        const saved = pack.buildAndWrite(ctxB, {
          name: 'pack.toml',
          baseSha256: cur.sha256,
          dryRun: false,
          buildCandidate: (raw) => packedit.editPackTomlTheme(raw, 'haze'),
          productParse: (text) => parsePackToml(text, { tomlPath: path.join(ctxB.packDir, 'pack.toml'), campaign: ctxB.campaign }),
        });
        assert.equal(saved.status, 200, JSON.stringify(saved));

        // Own parent dir (issue #102): a build stages in a SIBLING of its output, so an output sitting
    // directly in os.tmpdir() shares a staging parent with every other parallel test file.
    const cliOutBRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variants-cli-b-'));
    const cliOutB = path.join(cliOutBRoot, 'out');
        try {
          const cliB = runBuildCommand({ config: configPathB }, 'vocab');
          assert.equal(cliB.exitCode, 0, cliB.human);
        } finally {
          fs.rmSync(cliOutBRoot, { recursive: true, force: true });
        }
        const realOut = path.join(path.dirname(configPathB), 'out');
        assertTreesByteIdentical(variants.variantDirFor(ctxA, 'haze'), realOut);
      });
    } finally {
      preview.removePreviewRoot(ctxA);
    }
  });
});

// --- 4. Refusal, freshness --------------------------------------------------------------------

test('an ERROR vault refuses the copy (exitCode 2); a prior successful build is kept byte-identical, builtAt unchanged', async () => {
  await withVocabVault(async ({ vaultPath, configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const first = variants.buildVariant(ctx, 'plain', 'theme = "plain"\n');
      assert.equal(first.result.exitCode, 0);
      const dir = variants.variantDirFor(ctx, 'plain');
      const before = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variants-snap-'));
      fs.cpSync(dir, before, { recursive: true });
      const builtAtBefore = ctx.variants.get('plain').stamp.builtAt;

      fs.writeFileSync(path.join(vaultPath, '_meta', 'stray.md'), '---\n---\n');
      const second = variants.buildVariant(ctx, 'plain', 'theme = "plain"\n');
      assert.equal(second.result.exitCode, 2);

      assertTreesByteIdentical(dir, before);
      assert.equal(ctx.variants.get('plain').stamp.builtAt, builtAtBefore);
      const shasNow = freshness.readTrackedShas(ctx);
      assert.equal(variants.variantItem(ctx, 'plain', shasNow).built, true);

      fs.rmSync(before, { recursive: true, force: true });
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('freshness: fresh right after a build; a tagline-shaped save gives stale with savedSince [vault-config.md]; an outside pack.toml edit gives stale; previewInfo never moves', async () => {
  await withVocabVault(async ({ vaultPath, packDir, configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      variants.buildVariant(ctx, 'plain', 'theme = "plain"\n');
      let shasNow = freshness.readTrackedShas(ctx);
      let item = variants.variantItem(ctx, 'plain', shasNow);
      assert.equal(item.stale, false);
      assert.equal(ctx.previewStamp, undefined, 'a variant build must never move ctx.previewStamp');
      assert.equal(ctx.panelSaves || 0, 0, 'a variant build must never increment ctx.panelSaves');

      fs.writeFileSync(
        path.join(vaultPath, '_meta', 'vault-config.md'),
        '---\ntype: meta\npublish:\n  mode: full\ntheme:\n  tagline: "a new one"\n---\n',
      );
      shasNow = freshness.readTrackedShas(ctx);
      item = variants.variantItem(ctx, 'plain', shasNow);
      assert.equal(item.stale, true);
      assert.deepEqual(item.savedSince, ['vault-config.md']);

      variants.buildVariant(ctx, 'haze', 'theme = "haze"\n');
      fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "haze"\n# edited outside the panel\n');
      shasNow = freshness.readTrackedShas(ctx);
      item = variants.variantItem(ctx, 'haze', shasNow);
      assert.equal(item.stale, true);

      assert.equal(ctx.previewStamp, undefined);
      assert.equal(ctx.panelSaves || 0, 0);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- 5. Access and busy ------------------------------------------------------------------------

test('access: busy gives 409, read-only gives 403, bad/unknown-key themes give typed 400s, an oversized body gives 413', async (t) => {
  await withVocabVault(async ({ configPath }) => {
    const handlers = require('../src/admin/handlers/variants');
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      ctx.busy = 'write';
      let res = fakeRes();
      await handlers.buildTheme(fakeBodyStream(Buffer.from(JSON.stringify({ theme: 'plain' }))), res, ctx);
      assert.equal(res.status, 409);
      assert.equal(res.json.error, 'busy');
      ctx.busy = null;

      ctx.writable = false;
      res = fakeRes();
      await handlers.buildTheme(fakeBodyStream(Buffer.from(JSON.stringify({ theme: 'plain' }))), res, ctx);
      assert.equal(res.status, 403);
      assert.equal(res.json.error, 'read-only');
      ctx.writable = true;

      for (const bad of [{ theme: 'nope' }, { theme: '__proto__' }, { theme: 'plain', x: 1 }]) {
        res = fakeRes();
        await handlers.buildTheme(fakeBodyStream(Buffer.from(JSON.stringify(bad))), res, ctx);
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.equal(typeof res.json.message, 'string');
      }

      const bigBody = Buffer.alloc(70000, 'x');
      res = fakeRes();
      await handlers.buildTheme(fakeBodyStream(bigBody), res, ctx);
      assert.equal(res.status, 413);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- 6. Caps (fake sizes) ------------------------------------------------------------------------

test('caps: oldest-first eviction when over the total cap; the just-built copy evicted alone when it alone is over cap; eviction removal survives an EBUSY', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    const realTreeBytes = variants.treeBytes;
    const realCap = variants.VARIANT_TOTAL_CAP_BYTES;
    try {
      variants.treeBytes = (dir) => {
        if (dir.endsWith(path.join('plain', 'site'))) return 40;
        if (dir.endsWith(path.join('haze', 'site'))) return 40;
        if (dir.endsWith(path.join('gloam', 'site'))) return 40;
        return 0;
      };
      variants.VARIANT_TOTAL_CAP_BYTES = 100;

      const p1 = variants.buildVariant(ctx, 'plain', 'theme = "plain"\n');
      assert.equal(p1.tooLarge, false);
      const p2 = variants.buildVariant(ctx, 'haze', 'theme = "haze"\n');
      assert.equal(p2.tooLarge, false);
      const p3 = variants.buildVariant(ctx, 'gloam', 'theme = "gloam"\n');
      assert.equal(p3.tooLarge, false);
      assert.deepEqual(p3.evicted, ['plain']);
      assert.ok(!fs.existsSync(path.join(ctx.previewRoot, 'variants', 'plain')));
      assert.ok(fs.existsSync(path.join(ctx.previewRoot, 'variants', 'haze')));
      assert.ok(fs.existsSync(path.join(ctx.previewRoot, 'variants', 'gloam')));

      variants.treeBytes = (dir) => (dir.endsWith(path.join('gloam', 'site')) ? 150 : 40);
      const p4 = variants.buildVariant(ctx, 'gloam', 'theme = "gloam"\n');
      assert.equal(p4.tooLarge, true);
      assert.ok(!fs.existsSync(path.join(ctx.previewRoot, 'variants', 'gloam')));
      assert.ok(fs.existsSync(path.join(ctx.previewRoot, 'variants', 'haze')));

      // An EBUSY during eviction's rmSync is swallowed; the response still carries `evicted`.
      // State here: only `haze` has a record (plain was evicted above; gloam was just removed
      // by the too-large branch). Force haze+gloam over cap so eviction targets haze, the only
      // other existing record.
      variants.treeBytes = (dir) => (dir.endsWith(path.join('haze', 'site')) || dir.endsWith(path.join('gloam', 'site')) ? 60 : 0);
      // Targeted: only the eviction removal of variants/haze itself throws EBUSY. A blanket
      // fs.rmSync override would also break the build's own internal cleanup (sweepStaleSiblings
      // etc.), which is not what this test is about.
      const hazeTarget = path.join(ctx.previewRoot, 'variants', 'haze');
      const realRmSync = fs.rmSync;
      fs.rmSync = function (p, opts) {
        if (p === hazeTarget) {
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return realRmSync.call(fs, p, opts);
      };
      try {
        const p5 = variants.buildVariant(ctx, 'gloam', 'theme = "gloam"\n');
        assert.equal(p5.result.exitCode, 0, p5.result.human);
        assert.deepEqual(p5.evicted, ['haze']);
      } finally {
        fs.rmSync = realRmSync;
      }
    } finally {
      variants.treeBytes = realTreeBytes;
      variants.VARIANT_TOTAL_CAP_BYTES = realCap;
      preview.removePreviewRoot(ctx);
    }
  });
});

test('caps: the just-built id is never evicted, even on a tied builtAtMs (A13: a guard against incidental recency alone)', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    const realTreeBytes = variants.treeBytes;
    const realCap = variants.VARIANT_TOTAL_CAP_BYTES;
    try {
      // Craft a tie directly, bypassing real timing: every record shares one builtAtMs, with
      // the just-built id ('plain') FIRST in VARIANT_IDS order -- exactly the shape "ties go to
      // the earlier position" would otherwise pick, if the just-built exclusion didn't exist.
      ctx.variants = new Map([
        ['plain', { stamp: { builtAt: 'x', shas: {}, saves: 0 }, pages: [], builtAtMs: 1000 }],
        ['haze', { stamp: { builtAt: 'x', shas: {}, saves: 0 }, pages: [], builtAtMs: 1000 }],
      ]);
      fs.mkdirSync(path.join(ctx.previewRoot, 'variants', 'plain', 'site'), { recursive: true });
      fs.mkdirSync(path.join(ctx.previewRoot, 'variants', 'haze', 'site'), { recursive: true });
      variants.treeBytes = () => 60;
      variants.VARIANT_TOTAL_CAP_BYTES = 100;

      const outcome = variants.enforceDiskCap(ctx, 'plain');
      assert.deepEqual(outcome.evicted, ['haze']);
      assert.ok(fs.existsSync(path.join(ctx.previewRoot, 'variants', 'plain')), 'the just-built id must survive its own eviction pass');
    } finally {
      variants.treeBytes = realTreeBytes;
      variants.VARIANT_TOTAL_CAP_BYTES = realCap;
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- 7. Removal containment and cleanup --------------------------------------------------------

test('removal containment: a symlinked variants/<id> is refused; the canary survives; the main preview tree survives', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variants-canary-'));
    try {
      fs.writeFileSync(path.join(canaryDir, 'canary.txt'), 'canary');
      variants.buildVariant(ctx, 'haze', 'theme = "haze"\n');
      const hazeDir = path.join(ctx.previewRoot, 'variants', 'haze');
      fs.rmSync(hazeDir, { recursive: true, force: true });
      fs.symlinkSync(canaryDir, hazeDir, 'dir');

      // The main preview tree, a sibling under the same previewRoot, must survive untouched.
      const mainDir = ctx.previewDir;
      fs.mkdirSync(mainDir, { recursive: true });
      fs.writeFileSync(path.join(mainDir, 'sentinel.html'), 'sentinel');

      variants.removeVariant(ctx, 'haze');

      assert.ok(fs.existsSync(path.join(canaryDir, 'canary.txt')), 'the canary must survive');
      assert.ok(fs.existsSync(path.join(mainDir, 'sentinel.html')), 'the main preview tree must survive');
      assert.equal(ctx.variants.has('haze'), false, 'the record is always cleared even when removal is skipped');

      // A second, NORMAL (non-symlinked) removal: the main preview tree must survive THIS path
      // too (A4: removeVariant must remove only variants/<id>, never variants/'s own parent).
      variants.buildVariant(ctx, 'plain', 'theme = "plain"\n');
      variants.removeVariant(ctx, 'plain');
      assert.ok(fs.existsSync(path.join(mainDir, 'sentinel.html')), 'the main preview tree must survive a normal removal too');
      assert.ok(fs.existsSync(path.join(ctx.previewRoot, 'variants', 'haze')), 'the still-symlinked haze entry (untouched by this slice) must survive too');
    } finally {
      preview.removePreviewRoot(ctx);
      fs.rmSync(canaryDir, { recursive: true, force: true });
    }
  });
});

test('cleanup: removePreviewRoot removes the whole root, including variants/', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    variants.buildVariant(ctx, 'plain', 'theme = "plain"\n');
    const root = ctx.previewRoot;
    assert.ok(fs.existsSync(path.join(root, 'variants', 'plain')));
    preview.removePreviewRoot(ctx);
    assert.ok(!fs.existsSync(root));
  });
});

// --- 8. Structural: no child_process/worker_threads/cluster under src/admin --------------------

test('structural: no file under src/admin/ requires child_process, worker_threads or cluster (positive control proves the scan works)', () => {
  const ROOT = path.join(__dirname, '..');
  const ADMIN_DIR = path.join(ROOT, 'src', 'admin');
  const FORBIDDEN_RE = /require\(\s*(['"])(node:)?(child_process|worker_threads|cluster)\1\s*\)/;

  function listJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listJsFiles(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const offenders = [];
  for (const f of listJsFiles(ADMIN_DIR)) {
    if (FORBIDDEN_RE.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(ROOT, f));
  }
  assert.deepEqual(offenders, []);

  // Positive control: the regex itself actually catches a planted fixture.
  assert.match('const cp = require("child_process");', FORBIDDEN_RE);
  assert.match("const wt = require('node:worker_threads');", FORBIDDEN_RE);
});
